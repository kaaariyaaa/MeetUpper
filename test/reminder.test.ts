import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, type Client } from "discord.js";

process.env.DB_PATH = join(tmpdir(), `meetupper-reminder-test-${process.pid}-${Date.now()}.db`);
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { createMeetup, dueReminders, getMeetup, setMeetupState, setParticipantState, updateMeetup } =
  await import("../src/core/meetup.ts");
const { db } = await import("../src/db.ts");
const { getSubcommands } = await import("../src/core/registry.ts");
const { tick } = await import("../src/features/reminder.ts");

interface Sent {
  content: string;
  allowedMentions?: { users: string[] };
}

type GuildChannels = Record<string, string>;

function fakeClient(sent: Sent[], guildChannels: GuildChannels = { g1: "chan-1" }): Client {
  const cache = new Map<string, unknown>();
  for (const [guildId, channelId] of Object.entries(guildChannels)) {
    const channel = {
      type: ChannelType.GuildText,
      send: async (payload: Sent) => {
        sent.push(payload);
      },
    };
    cache.set(guildId, {
      id: guildId,
      channels: { fetch: async (id: string) => (id === channelId ? channel : null) },
    });
  }
  return { guilds: { cache } } as unknown as Client;
}

function makeMeetup(options: {
  guildId?: string;
  startAt?: number;
  approved?: string[];
  withChannel?: boolean;
}) {
  const meetup = createMeetup({
    guildId: options.guildId ?? "g1",
    hostId: "host",
    name: "テストオフ会",
    description: "",
    capacity: 5,
    startAt: options.startAt ?? Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: Date.now() + 23 * 60 * 60 * 1000,
    meetingPlace: "渋谷駅ハチ公前",
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  if (options.withChannel !== false) updateMeetup(meetup.id, { channelId: "chan-1" });
  for (const userId of options.approved ?? []) {
    setParticipantState(meetup.id, userId, "APPROVED", { approvedBy: "host" });
  }
  return getMeetup(meetup.id)!;
}

function insertDueReminder(meetupId: number, kind: string): void {
  db.query(
    `INSERT INTO reminders (meetup_id, kind, remind_at) VALUES (?, ?, ?)
     ON CONFLICT(meetup_id, kind) DO UPDATE SET remind_at = excluded.remind_at, sent_at = NULL`,
  ).run(meetupId, kind, Date.now() - 1000);
}

function isSent(meetupId: number, kind: string): boolean {
  const row = db
    .query("SELECT sent_at FROM reminders WHERE meetup_id = ? AND kind = ?")
    .get(meetupId, kind) as { sent_at: number | null } | null;
  return row !== null && row.sent_at !== null;
}

async function invokeRemind(
  meetupId: number,
  options: { userId?: string; guildId?: string; guildChannels?: GuildChannels } = {},
) {
  const sent: Sent[] = [];
  const replies: string[] = [];
  const entry = getSubcommands().find((item) => item.name === "remind");
  if (!entry) throw new Error("remind subcommand is not registered");
  const interaction = {
    guild: { id: options.guildId ?? "g1" },
    client: fakeClient(sent, options.guildChannels),
    user: { id: options.userId ?? "host" },
    options: { getInteger: () => meetupId },
    deferred: false,
    replied: false,
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload: { content: string }) => {
      replies.push(payload.content);
    },
    reply: async (payload: { content: string }) => {
      replies.push(payload.content);
    },
    followUp: async (payload: { content: string }) => {
      replies.push(payload.content);
    },
  };
  await entry.execute(interaction as never);
  return { sent, replies };
}

test("remind subcommand is registered with a required meetup option", () => {
  const entry = getSubcommands().find((item) => item.name === "remind");
  expect(entry).toBeDefined();
  const json = entry!.builder.toJSON() as { options?: { name: string; required?: boolean }[] };
  expect(json.options?.[0]).toMatchObject({ name: "meetup", required: true });
});

test("tick announces due reminders to approved participants only, once", async () => {
  const meetup = makeMeetup({ approved: ["u1", "u2"] });
  setParticipantState(meetup.id, "u3", "APPLIED");
  insertDueReminder(meetup.id, "3h");

  const sent: Sent[] = [];
  await tick(fakeClient(sent));

  expect(sent.length).toBe(1);
  const payload = sent[0]!;
  expect(payload.content).toContain("⏰ 3時間後に開催です: テストオフ会");
  expect(payload.content).toContain("開始: <t:");
  expect(payload.content).toContain("集合時間: <t:");
  expect(payload.content).toContain("集合場所: 渋谷駅ハチ公前");
  expect(payload.content).toContain("<@u1>");
  expect(payload.content).toContain("<@u2>");
  expect(payload.content).not.toContain("<@u3>");
  expect(payload.allowedMentions?.users).toEqual(["u1", "u2"]);
  expect(isSent(meetup.id, "3h")).toBe(true);

  await tick(fakeClient(sent));
  expect(sent.length).toBe(1);
});

test("tick marks stale reminders without sending after the start time", async () => {
  const meetup = makeMeetup({ startAt: Date.now() - 1000, approved: ["u1"] });
  insertDueReminder(meetup.id, "30m");

  const sent: Sent[] = [];
  await tick(fakeClient(sent));

  expect(sent.length).toBe(0);
  expect(isSent(meetup.id, "30m")).toBe(true);
});

test("tick drops reminders for archived meetups without sending", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  setMeetupState(meetup.id, "ARCHIVED");
  insertDueReminder(meetup.id, "1d");

  const sent: Sent[] = [];
  await tick(fakeClient(sent));

  expect(sent.length).toBe(0);
  expect(isSent(meetup.id, "1d")).toBe(true);
});

test("tick marks reminders with no approved participants without sending", async () => {
  const meetup = makeMeetup({ approved: [] });
  insertDueReminder(meetup.id, "3h");

  const sent: Sent[] = [];
  await tick(fakeClient(sent));

  expect(sent.length).toBe(0);
  expect(isSent(meetup.id, "3h")).toBe(true);
});

test("tick leaves reminders unsent when the guild is not cached yet", async () => {
  const meetup = makeMeetup({ guildId: "g-missing", approved: ["u1"] });
  insertDueReminder(meetup.id, "30m");

  const sent: Sent[] = [];
  await tick(fakeClient(sent));

  expect(sent.length).toBe(0);
  expect(isSent(meetup.id, "30m")).toBe(false);
  expect(dueReminders(Date.now()).some((reminder) => reminder.meetupId === meetup.id)).toBe(true);
});

test("manual remind sends the announcement without touching reminder rows", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  insertDueReminder(meetup.id, "3h");

  const { sent, replies } = await invokeRemind(meetup.id, { userId: "host" });

  expect(sent.length).toBe(1);
  expect(sent[0]!.content).toContain("⏰ リマインド: テストオフ会");
  expect(sent[0]!.content).toContain("集合場所: 渋谷駅ハチ公前");
  expect(sent[0]!.allowedMentions?.users).toEqual(["u1"]);
  expect(replies).toEqual(["リマインドを送信しました"]);
  expect(isSent(meetup.id, "3h")).toBe(false);
});

test("manual remind rejects users who cannot manage the meetup", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });

  const { sent, replies } = await invokeRemind(meetup.id, { userId: "stranger" });

  expect(sent.length).toBe(0);
  expect(replies.length).toBe(1);
  expect(replies[0] ?? "").toContain("権限がありません");
});

test("manual remind rejects non-ACTIVE meetups", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  setMeetupState(meetup.id, "CANCELLED");

  const { sent, replies } = await invokeRemind(meetup.id, { userId: "host" });

  expect(sent.length).toBe(0);
  expect(replies.length).toBe(1);
  expect(replies[0] ?? "").toContain("ACTIVE");
});
