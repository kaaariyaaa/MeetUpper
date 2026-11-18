import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-init-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

await import("../src/features/init.ts");
const { findButton, getSubcommands } = await import("../src/core/registry.ts");

interface Call {
  type: string;
  payload?: { components?: unknown[] } & Record<string, unknown>;
}

function fakeInteraction(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const interaction: Record<string, unknown> = {
    user: { id: "admin" },
    guild: { id: "g1" },
    guildId: "g1",
    deferred: false,
    replied: false,
    memberPermissions: { has: () => true },
    reply: async (payload: Call["payload"]) => {
      calls.push({ type: "reply", payload });
      interaction.replied = true;
    },
    editReply: async (payload: Call["payload"]) => {
      calls.push({ type: "editReply", payload });
    },
    followUp: async (payload: Call["payload"]) => {
      calls.push({ type: "followUp", payload });
    },
    update: async (payload: Call["payload"]) => {
      calls.push({ type: "update", payload });
      interaction.replied = true;
    },
    deferUpdate: async () => {
      calls.push({ type: "deferUpdate" });
      interaction.deferred = true;
    },
  };
  Object.assign(interaction, overrides);
  return { interaction, calls };
}

function customIds(payload: Call["payload"]): string[] {
  const rows = (payload?.components ?? []) as { toJSON?: () => { components: { custom_id: string }[] } }[];
  return rows.flatMap((row) => (row.toJSON ? row.toJSON().components.map((part) => part.custom_id) : []));
}

function initCommand() {
  const entry = getSubcommands().find((item) => item.name === "init");
  if (!entry) throw new Error("init subcommand is not registered");
  return entry;
}

function existingLayoutGuild() {
  const category = {
    id: "category",
    name: "MeetUp",
    type: ChannelType.GuildCategory,
    parentId: null,
    position: 0,
    permissionOverwrites: { edit: async () => undefined, cache: new Map() },
  };
  const forum = {
    id: "forum",
    name: "meetup募集",
    type: ChannelType.GuildForum,
    parentId: "category",
    position: 0,
    permissionOverwrites: { cache: new Map() },
    setPosition: async () => undefined,
  };
  const invite = {
    id: "invite",
    name: "招待",
    type: ChannelType.GuildText,
    parentId: "category",
    position: 1,
    permissionOverwrites: { cache: new Map() },
    setPosition: async () => undefined,
  };
  const channels = [category, forum, invite];
  const cache = {
    find: (predicate: (channel: unknown) => boolean) => channels.find(predicate),
    some: (predicate: (channel: unknown) => boolean) => channels.some(predicate),
    values: () => channels.values(),
    size: channels.length,
  };
  return {
    id: "g1",
    channels: { cache, fetch: async () => undefined },
    members: { me: null },
    roles: { everyone: { id: "everyone" } },
  };
}

test("init is registered and rejects non-administrators", async () => {
  const { interaction, calls } = fakeInteraction({
    memberPermissions: { has: () => false },
  });
  await initCommand().execute(interaction as never);

  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0]?.payload)).toContain("サーバー管理者のみ");
});

test("init shows a confirmation panel instead of executing immediately", async () => {
  const { interaction, calls } = fakeInteraction();
  await initCommand().execute(interaction as never);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.type).toBe("reply");
  expect(customIds(calls[0]?.payload).some((id) => id.startsWith("ops:init-confirm:"))).toBe(true);
  expect(JSON.stringify(calls[0]?.payload)).toContain("実行するには下のボタン");
});

test("init confirmation re-checks administrator permission", async () => {
  const panel = fakeInteraction();
  await initCommand().execute(panel.interaction as never);
  const confirmId = customIds(panel.calls[0]?.payload).find((id) => id.startsWith("ops:init-confirm:"))!;
  const routed = findButton(confirmId)!;

  const click = fakeInteraction({ memberPermissions: { has: () => false } });
  await routed.handler(click.interaction as never, routed.args);

  expect(click.calls).toHaveLength(1);
  expect(JSON.stringify(click.calls[0]?.payload)).toContain("サーバー管理者のみ");
});

test("init confirmation runs ensureLayout and reports a reused layout", async () => {
  const panel = fakeInteraction();
  await initCommand().execute(panel.interaction as never);
  const confirmId = customIds(panel.calls[0]?.payload).find((id) => id.startsWith("ops:init-confirm:"))!;
  const routed = findButton(confirmId)!;

  const click = fakeInteraction({ guild: existingLayoutGuild() });
  await routed.handler(click.interaction as never, routed.args);

  expect(click.calls[0]?.type).toBe("deferUpdate");
  const payload = JSON.stringify(click.calls[1]?.payload);
  expect(payload).toContain("既存のMeetUpレイアウトを再利用");
  expect(payload).toContain("募集フォーラム");
  expect(payload).toContain("<#forum>");
  expect(payload).toContain("<#invite>");
});
