import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-people-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { getSubcommands, findButton, findSelectMenu } = await import("../src/core/registry.ts");
const {
  addCohost,
  createMeetup,
  getMeetup,
  getParticipant,
  listCohosts,
  setParticipantState,
  updateMeetup,
} = await import("../src/core/meetup.ts");
const { cohostAddDenial, hostTargetDenial, kickDenial } = await import("../src/features/people.ts");

function createTestMeetup(guildId: string, name: string) {
  return createMeetup({
    guildId,
    hostId: "host",
    name,
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
}

function findSubcommand(name: string) {
  return getSubcommands().find((entry) => entry.name === name);
}

test("kick, cohost and host register with only the optional meetup id", () => {
  for (const name of ["kick", "cohost", "host"]) {
    const entry = findSubcommand(name);
    expect(entry).toBeDefined();
    const options = entry!.builder.toJSON().options ?? [];
    expect(options.map((option) => option.name)).toEqual(["meetup"]);
    expect(options[0]?.required).toBeFalsy();
  }
});

test("people components route in the people namespace", () => {
  expect(findButton("people:kick-open:42")?.args).toEqual(["kick", "42"]);
  expect(findButton("people:cohost-open:42")?.args).toEqual(["cohost", "42"]);
  expect(findButton("people:host-open:42")?.args).toEqual(["host", "42"]);
  expect(findButton("people:kick-confirm:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("people:host-cancel:abc123")?.args).toEqual(["host", "abc123"]);

  expect(findSelectMenu("people:kick-meetup:abc123")?.args).toEqual(["kick", "abc123"]);
  expect(findSelectMenu("people:kick-target:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("people:cohost-add:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("people:cohost-remove:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("people:host-target:abc123")?.args).toEqual(["abc123"]);

  expect(findButton("people:kick-open:abc")).toBeUndefined();
  expect(findSelectMenu("people:kick-target")).toBeUndefined();
});

test("kick rejects host, cohost and non-approved targets", () => {
  const meetup = createTestMeetup("g-kick-rules", "キック規則");
  expect(kickDenial(meetup, "host")).toContain("主催者");

  addCohost(meetup.id, "cohost");
  expect(kickDenial(meetup, "cohost")).toContain("共同主催者");

  setParticipantState(meetup.id, "applied", "APPLIED");
  expect(kickDenial(meetup, "applied")).toContain("参加確定");

  setParticipantState(meetup.id, "approved", "APPROVED");
  expect(kickDenial(meetup, "approved")).toBeNull();
});

test("cohost and host target rules reject host side, bots and non-members", () => {
  const meetup = createTestMeetup("g-role-rules", "役割規則");
  expect(hostTargetDenial(meetup, { id: "host" }, true)).toContain("現在の主催者");
  expect(hostTargetDenial(meetup, { id: "bot", bot: true }, true)).toContain("Bot");
  expect(hostTargetDenial(meetup, { id: "outside" }, false)).toContain("サーバーに参加");
  expect(hostTargetDenial(meetup, { id: "u2" }, true)).toBeNull();

  addCohost(meetup.id, "cohost");
  expect(cohostAddDenial(meetup, "host", { id: "host" }, true)).toContain("主催者");
  expect(cohostAddDenial(meetup, "host", { id: "cohost" }, true)).toContain("すでに共同主催者");
  expect(cohostAddDenial(meetup, "host", { id: "bot", bot: true }, true)).toContain("Bot");
  expect(cohostAddDenial(meetup, "host", { id: "u2" }, false)).toContain("サーバーに参加");
  expect(cohostAddDenial(meetup, "host", { id: "u2" }, true)).toBeNull();
});

test("kick UI confirms, marks KICKED, revokes access and notifies", async () => {
  const meetup = createTestMeetup("g-kick-flow", "UIキック");
  updateMeetup(meetup.id, { channelId: "chan-kick" });
  setParticipantState(meetup.id, "u-kicked", "APPROVED");

  const channelMessages: unknown[] = [];
  const userMessages: unknown[] = [];
  const deletedOverwrites: string[] = [];
  const channel = {
    id: "chan-kick",
    type: ChannelType.GuildText,
    send: async (payload: unknown) => {
      channelMessages.push(payload);
    },
    permissionOverwrites: {
      cache: new Map(),
      edit: async () => undefined,
      delete: async (id: string) => {
        deletedOverwrites.push(id);
      },
    },
  };
  const usersFetch = async (id: string) => ({
    id,
    send: async (payload: unknown) => {
      userMessages.push(payload);
    },
  });
  const guild = {
    id: "g-kick-flow",
    client: { user: { id: "bot" }, users: { fetch: usersFetch } },
    roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" }, fetch: async () => ({}) },
    channels: { fetch: async (id: string) => (id === "chan-kick" ? channel : null) },
  };

  const replies: { payload?: Record<string, unknown> }[] = [];
  const entryInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    deferred: false,
    replied: false,
    reply: async (payload: Record<string, unknown>) => {
      replies.push({ payload });
    },
    editReply: async () => undefined,
    followUp: async () => undefined,
  };
  const open = findButton(`people:kick-open:${meetup.id}`)!;
  await open.handler(entryInteraction as never, open.args);
  const selectId = JSON.stringify(replies[0]?.payload).match(
    /people:kick-target:[0-9a-z]+/,
  )?.[0];
  expect(selectId).toBeDefined();

  const updates: { payload?: Record<string, unknown> }[] = [];
  const selectInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: selectId,
    users: { first: () => ({ id: "u-kicked", bot: false }) },
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const select = findSelectMenu(selectId!)!;
  await select.handler(selectInteraction as never, select.args);
  const confirmId = JSON.stringify(updates[0]?.payload).match(
    /people:kick-confirm:[0-9a-z]+/,
  )?.[0];
  expect(confirmId).toBeDefined();

  const confirmInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: confirmId,
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const confirm = findButton(confirmId!)!;
  await confirm.handler(confirmInteraction as never, confirm.args);

  expect(getParticipant(meetup.id, "u-kicked")?.state).toBe("KICKED");
  expect(deletedOverwrites).toContain("u-kicked");
  expect(JSON.stringify(channelMessages)).toContain("退出させられました");
  expect(JSON.stringify(userMessages)).toContain("退出となりました");
  expect(JSON.stringify(updates.at(-1)?.payload)).toContain("退出させました");
});

test("cohost removal revokes the role and refreshes the panel", async () => {
  const meetup = createTestMeetup("g-cohost-remove", "共同主催者削除");
  updateMeetup(meetup.id, { channelId: "chan-cohost" });
  addCohost(meetup.id, "u-cohost");

  const channelMessages: unknown[] = [];
  const channel = {
    id: "chan-cohost",
    type: ChannelType.GuildText,
    send: async (payload: unknown) => {
      channelMessages.push(payload);
    },
    permissionOverwrites: {
      cache: new Map(),
      edit: async () => undefined,
      delete: async () => undefined,
    },
  };
  const guild = {
    id: "g-cohost-remove",
    client: { user: { id: "bot" } },
    roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" }, cache: new Map(), fetch: async () => ({}) },
    channels: { fetch: async (id: string) => (id === "chan-cohost" ? channel : null) },
  };

  const replies: { payload?: Record<string, unknown> }[] = [];
  const entryInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    deferred: false,
    replied: false,
    reply: async (payload: Record<string, unknown>) => {
      replies.push({ payload });
    },
    editReply: async () => undefined,
    followUp: async () => undefined,
  };
  const open = findButton(`people:cohost-open:${meetup.id}`)!;
  await open.handler(entryInteraction as never, open.args);
  const removeId = JSON.stringify(replies[0]?.payload).match(
    /people:cohost-remove:[0-9a-z]+/,
  )?.[0];
  expect(removeId).toBeDefined();

  const updates: { payload?: Record<string, unknown> }[] = [];
  const removeInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: removeId,
    values: ["u-cohost"],
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const remove = findSelectMenu(removeId!)!;
  await remove.handler(removeInteraction as never, remove.args);

  expect(listCohosts(meetup.id)).toEqual([]);
  expect(JSON.stringify(channelMessages)).toContain("共同主催者を削除しました");
  expect(JSON.stringify(updates.at(-1)?.payload)).toContain("削除しました");
  expect(getMeetup(meetup.id)?.hostId).toBe("host");
});

test("host transfer changes the host and syncs channel access", async () => {
  const meetup = createTestMeetup("g-host-flow", "主催者変更");
  updateMeetup(meetup.id, { channelId: "chan-host" });

  const channelMessages: unknown[] = [];
  const userMessages: unknown[] = [];
  const channel = {
    id: "chan-host",
    type: ChannelType.GuildText,
    send: async (payload: unknown) => {
      channelMessages.push(payload);
    },
    permissionOverwrites: {
      cache: new Map(),
      edit: async () => undefined,
      delete: async () => undefined,
    },
  };
  const guild = {
    id: "g-host-flow",
    client: {
      user: { id: "bot" },
      users: {
        fetch: async (id: string) => ({
          id,
          send: async (payload: unknown) => {
            userMessages.push(payload);
          },
        }),
      },
    },
    roles: { everyone: { id: "everyone" } },
    members: {
      me: { id: "bot" },
      cache: new Map(),
      fetch: async (id: string) => ({ id, user: { id, bot: false } }),
    },
    channels: { fetch: async (id: string) => (id === "chan-host" ? channel : null) },
  };

  const replies: { payload?: Record<string, unknown> }[] = [];
  const entryInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    deferred: false,
    replied: false,
    reply: async (payload: Record<string, unknown>) => {
      replies.push({ payload });
    },
    editReply: async () => undefined,
    followUp: async () => undefined,
  };
  const open = findButton(`people:host-open:${meetup.id}`)!;
  await open.handler(entryInteraction as never, open.args);
  const selectId = JSON.stringify(replies[0]?.payload).match(
    /people:host-target:[0-9a-z]+/,
  )?.[0];
  expect(selectId).toBeDefined();

  const updates: { payload?: Record<string, unknown> }[] = [];
  const selectInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: selectId,
    users: { first: () => ({ id: "u-new-host", bot: false }) },
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const select = findSelectMenu(selectId!)!;
  await select.handler(selectInteraction as never, select.args);
  const confirmId = JSON.stringify(updates[0]?.payload).match(
    /people:host-confirm:[0-9a-z]+/,
  )?.[0];
  expect(confirmId).toBeDefined();

  const confirmInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: confirmId,
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const confirm = findButton(confirmId!)!;
  await confirm.handler(confirmInteraction as never, confirm.args);

  expect(getMeetup(meetup.id)?.hostId).toBe("u-new-host");
  expect(JSON.stringify(channelMessages)).toContain("主催者を <@u-new-host> に変更しました");
  expect(JSON.stringify(userMessages)).toContain("主催者になりました");
  expect(JSON.stringify(updates.at(-1)?.payload)).toContain("主催者を <@u-new-host> に変更しました");
});
