import { expect, test } from "bun:test";
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-layout-test-${process.pid}-${Date.now()}.db`);

const { channelSlug, ensureLayout, isLayoutInitialized, setupRequiredMessage } = await import(
  "../src/core/discord.ts"
);

const VIEW = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
const NONE = new PermissionsBitField([]);
const ALL_LAYOUT = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
]);
const me = { id: "bot", permissions: ALL_LAYOUT };

interface FakeChannelData {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
}

interface Edit {
  channelId: string;
  overwriteId: string;
  options: Record<string, unknown>;
}

function makeChannel(
  data: FakeChannelData,
  viewable: boolean,
  sink?: { edits: Edit[]; cleared: string[]; renamed: { id: string; name: string }[] },
) {
  return {
    ...data,
    position: 0,
    permissionOverwrites: {
      cache: new Collection<string, unknown>(),
      edit: async (target: string | { id: string }, options: Record<string, unknown>) => {
        sink?.edits.push({
          channelId: data.id,
          overwriteId: typeof target === "string" ? target : target.id,
          options,
        });
      },
      delete: async () => undefined,
      set: async () => {
        sink?.cleared.push(data.id);
      },
    },
    permissionsFor: () => (viewable ? VIEW : NONE),
    setPosition: async () => undefined,
    setName: async (name: string) => {
      sink?.renamed.push({ id: data.id, name });
      data.name = name;
    },
  };
}

function makeGuild(botPermissions: PermissionsBitField = ALL_LAYOUT) {
  const edits: Edit[] = [];
  const cleared: string[] = [];
  const renamed: { id: string; name: string }[] = [];
  const sink = { edits, cleared, renamed };
  const cache = new Collection<string, ReturnType<typeof makeChannel>>();
  const created: { type: ChannelType; name: string; parent?: string; permissionOverwrites?: unknown[] }[] = [];
  let id = 0;
  const guild = {
    id: "g1",
    client: { user: { id: "bot" } },
    roles: { everyone: { id: "everyone" } },
    members: { me: { ...me, permissions: botPermissions } },
    channels: {
      cache,
      fetch: async () => cache,
      create: async (data: { name: string; type: ChannelType; parent?: string; permissionOverwrites?: unknown[] }) => {
        created.push(data);
        const channel = makeChannel(
          { id: `c${(id += 1)}`, name: data.name, type: data.type, parentId: data.parent ?? null },
          true,
          sink,
        );
        cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  return { guild: guild as never, created, cache, edits, cleared, renamed, makeChannel: (data: FakeChannelData, viewable: boolean) => makeChannel(data, viewable, sink) };
}

test("init refuses to create channels in a category the bot cannot view", async () => {
  const { guild, created, cache, makeChannel: channel } = makeGuild();
  cache.set(
    "cat",
    channel({ id: "cat", name: "MeetUp", type: ChannelType.GuildCategory, parentId: null }, false),
  );

  await expect(ensureLayout(guild)).rejects.toThrow("チャンネルを見る");
  expect(created).toHaveLength(0);
  expect(setupRequiredMessage(guild)).toContain("チャンネルを見る");
});

test("init puts the layout rules on the category and creates inheriting channels", async () => {
  const { guild, created, edits } = makeGuild();

  await ensureLayout(guild);

  expect(created.map((channel) => channel.type)).toEqual([
    ChannelType.GuildCategory,
    ChannelType.GuildForum,
    ChannelType.GuildText,
  ]);
  // Rules are applied to the category (c1) only, never to the two channels below it.
  expect(new Set(edits.map((edit) => edit.channelId))).toEqual(new Set(["c1"]));
  expect(edits.map((edit) => edit.overwriteId)).toEqual(["everyone", "bot"]);
  expect(edits[0]!.options).toMatchObject({ ViewChannel: true, SendMessages: false });
  expect(created[1]!.permissionOverwrites).toBeUndefined();
  expect(created[2]!.permissionOverwrites).toBeUndefined();
  expect(await isLayoutInitialized(guild)).toBe(true);
  expect(setupRequiredMessage(guild)).toContain("/meetupper init");
});

test("existing layout channels drop per-channel overwrites and inherit the category", async () => {
  const { guild, cache, cleared, makeChannel: channel } = makeGuild();
  cache.set(
    "cat",
    channel({ id: "cat", name: "MeetUp", type: ChannelType.GuildCategory, parentId: null }, true),
  );
  const forum = channel(
    { id: "forum", name: "meetup募集", type: ChannelType.GuildForum, parentId: "cat" },
    true,
  );
  const invite = channel({ id: "invite", name: "招待", type: ChannelType.GuildText, parentId: "cat" }, true);
  for (const layoutChannel of [forum, invite]) {
    layoutChannel.permissionOverwrites.cache.set("everyone", {});
  }
  cache.set("forum", forum);
  cache.set("invite", invite);

  await ensureLayout(guild);

  expect(cleared).toEqual(["forum", "invite"]);
});

test("init names the permission the bot is missing instead of failing silently", async () => {
  const { guild, edits, created } = makeGuild(
    new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
  );

  await expect(ensureLayout(guild)).rejects.toThrow("CreatePublicThreads");
  expect(created).toHaveLength(0);
  expect(edits).toHaveLength(0);
});

test("meetup channel names are the meetup name only", () => {
  const name = (value: string) => channelSlug({ name: value } as never);
  expect(name(" 東京 meetup ")).toBe("東京-meetup");
  expect(name("test!")).toBe("test");
  expect(name("")).toBe("offkai");
  expect(name("x")).toBe("offkai");
});

test("init renames the old-name forum instead of creating a duplicate", async () => {
  const { guild, cache, created, renamed, makeChannel: channel } = makeGuild();
  cache.set(
    "cat",
    channel({ id: "cat", name: "MeetUp", type: ChannelType.GuildCategory, parentId: null }, true),
  );
  cache.set(
    "forum",
    channel({ id: "forum", name: "オフ会募集", type: ChannelType.GuildForum, parentId: "cat" }, true),
  );
  cache.set(
    "invite",
    channel({ id: "invite", name: "招待", type: ChannelType.GuildText, parentId: "cat" }, true),
  );

  await ensureLayout(guild);

  expect(created).toHaveLength(0);
  expect(renamed).toEqual([{ id: "forum", name: "meetup募集" }]);
});
