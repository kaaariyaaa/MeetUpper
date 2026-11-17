import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-manage-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { findButton, getSubcommands } = await import("../src/core/registry.ts");
const { addCohost, cancelMeetup, createMeetup, getMeetup, getParticipant, setParticipantState, updateMeetup } =
  await import("../src/core/meetup.ts");
const { meetupFromChannel } = await import("../src/core/discord.ts");
await import("../src/features/manage.ts");

test("manage registers its subcommands", () => {
  const names = getSubcommands().map((entry) => entry.name);
  for (const name of ["info", "leave", "kick", "members", "cohost", "host", "archive", "cancel"]) {
    expect(names).toContain(name);
  }
});

test("manage buttons route their meetup id", () => {
  expect(findButton("manage:confirm-archive:12")?.args).toEqual(["12"]);
  expect(findButton("manage:confirm-cancel:34")?.args).toEqual(["34"]);
  expect(findButton("manage:abort")?.args).toEqual([]);
  expect(findButton("manage:confirm-archive:abc")).toBeUndefined();
});

function makeMeetup(channelId: string) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "テスト",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId });
}

function fakeInteraction(channelId: string | null, meetupId: number | null, userId = "host") {
  const calls: unknown[] = [];
  const interaction = {
    guild: { id: "g1" },
    channel: null,
    channelId,
    user: { id: userId },
    deferred: false,
    replied: false,
    options: { getInteger: () => meetupId },
    reply: async (payload: unknown) => calls.push(payload),
    editReply: async (payload: unknown) => calls.push(payload),
    followUp: async (payload: unknown) => calls.push(payload),
    deferReply: async () => {
      interaction.deferred = true;
    },
  };
  return { interaction, calls };
}

test("cancel resolves the meetup from its dedicated channel when the id is omitted", async () => {
  makeMeetup("meetup-231-test");
  const cancel = getSubcommands().find((entry) => entry.name === "cancel")!;

  const { interaction, calls } = fakeInteraction("meetup-231-test", null);
  await cancel.execute(interaction as never);

  expect(JSON.stringify(calls)).toContain("manage:confirm-cancel");
});

test("cancel asks for an id outside the meetup channel", async () => {
  makeMeetup("meetup-232-test");
  const cancel = getSubcommands().find((entry) => entry.name === "cancel")!;

  const { interaction, calls } = fakeInteraction("other-channel", null);
  await cancel.execute(interaction as never);

  expect(JSON.stringify(calls)).toContain("専用チャンネル");
});

test("meetupFromChannel resolves the dedicated channel and the recruitment thread", () => {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "解決テスト",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId: "chan-resolve", forumThreadId: "thread-resolve" });

  expect(meetupFromChannel({ id: "chan-resolve" })?.id).toBe(meetup.id);
  expect(
    meetupFromChannel({ id: "thread-resolve", isThread: () => true, parentId: "forum" })?.id,
  ).toBe(meetup.id);
  expect(
    meetupFromChannel({ id: "other-thread", isThread: () => true, parentId: "chan-resolve" })?.id,
  ).toBe(meetup.id);
  expect(meetupFromChannel({ id: "unknown" })).toBeNull();
  expect(meetupFromChannel(null)).toBeNull();
});

test("kick removes an approved participant, revokes access and announces it", async () => {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "キックテスト",
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
  updateMeetup(meetup.id, { channelId: "chan-kick" });
  setParticipantState(meetup.id, "u-kick", "APPROVED");

  const sent: unknown[] = [];
  const deleted: string[] = [];
  const channel = {
    id: "chan-kick",
    type: ChannelType.GuildText,
    send: async (payload: unknown) => {
      sent.push(payload);
    },
    permissionOverwrites: {
      cache: new Map(),
      edit: async () => undefined,
      delete: async (id: string) => {
        deleted.push(id);
      },
    },
  };
  const guild = {
    id: "g1",
    channels: { fetch: async (id: string) => (id === "chan-kick" ? channel : null) },
  };
  const interaction = {
    guild,
    user: { id: "host" },
    client: {},
    deferred: false,
    replied: false,
    options: {
      getInteger: () => meetup.id,
      getUser: () => ({ id: "u-kick" }),
    },
    reply: async () => undefined,
    editReply: async () => undefined,
    followUp: async () => undefined,
    deferReply: async () => {
      interaction.deferred = true;
    },
  };

  const kick = getSubcommands().find((entry) => entry.name === "kick")!;
  await kick.execute(interaction as never);

  expect(getParticipant(meetup.id, "u-kick")?.state).toBe("KICKED");
  expect(deleted).toContain("u-kick");
  expect(JSON.stringify(sent)).toContain("退出させられました");
});

test("cancelled meetups can still be archived", async () => {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "中止済みアーカイブ",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  cancelMeetup(meetup);

  const updated: unknown[] = [];
  const interaction = {
    guild: { id: "g1", channels: { fetch: async () => null } },
    user: { id: "host" },
    client: {},
    update: async (payload: unknown) => {
      updated.push(payload);
    },
  };

  await findButton(`manage:confirm-archive:${meetup.id}`)!.handler(
    interaction as never,
    [`${meetup.id}`],
  );

  expect(getMeetup(meetup.id)?.state).toBe("ARCHIVED");
  expect(JSON.stringify(updated)).toContain("アーカイブしました");
});

test("cohosts can cancel a meetup, others cannot", async () => {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "共同主催者の中止",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "DIRECT",
    requiredVotes: 1,
    eventEnabled: false,
  });
  addCohost(meetup.id, "co");

  const cancel = getSubcommands().find((entry) => entry.name === "cancel")!;
  const cohost = fakeInteraction(null, meetup.id, "co");
  await cancel.execute(cohost.interaction as never);
  expect(JSON.stringify(cohost.calls)).toContain("manage:confirm-cancel");

  const stranger = fakeInteraction(null, meetup.id, "stranger");
  await cancel.execute(stranger.interaction as never);
  expect(JSON.stringify(stranger.calls)).toContain("権限がありません");
});
