import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-reminder-test-${process.pid}-${Date.now()}.db`);
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const {
  addCohost,
  archiveMeetup,
  cancelMeetup,
  createMeetup,
  getMeetup,
  setParticipantState,
  updateMeetup,
  validateMeetingTime,
} = await import("../src/core/meetup.ts");
const {
  DEFAULT_REMINDER_OFFSETS,
  ReminderVersionConflictError,
  formatOffset,
  getReminderOffsets,
  getReminderSettings,
  getSchedule,
  listDueSchedules,
  listReminderHistory,
  listSchedules,
  offsetFromParts,
  pruneReminderHistory,
  recalculateSchedules,
  saveReminderSettings,
  validateReminderOffsets,
} = await import("../src/core/reminders.ts");
const { tickReminders } = await import("../src/core/reminderEngine.ts");
const { findButton, findSelectMenu, getSubcommands } = await import("../src/core/registry.ts");
await import("../src/features/reminder.ts");

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

interface Sent {
  content?: string;
  allowedMentions?: { users: string[] };
  embeds?: { data: { title?: string; description?: string; fields?: { name: string; value: string }[] } }[];
}

interface FakeOptions {
  guild?: boolean;
  send?: (payload: Sent) => Promise<void> | void;
  dmFail?: (userId: string) => boolean;
}

function fakeDiscord(options: FakeOptions = {}) {
  const sent: Sent[] = [];
  const dms: { userId: string; payload: Sent }[] = [];
  const channel = {
    type: ChannelType.GuildText,
    send: async (payload: Sent) => {
      if (options.send) await options.send(payload);
      else sent.push(payload);
    },
  };
  const guild = {
    id: "g1",
    channels: { fetch: async (id: string) => (id === "chan-1" ? channel : null) },
  };
  const cache = new Map<string, unknown>();
  if (options.guild !== false) cache.set("g1", guild);
  const client = {
    guilds: { cache },
    users: {
      fetch: async (userId: string) => ({
        send: async (payload: Sent) => {
          if (options.dmFail?.(userId)) throw new Error("DM送信失敗");
          dms.push({ userId, payload });
        },
      }),
    },
  };
  return { client: client as never, sent, dms };
}

function makeMeetup(options: {
  startAt?: number;
  meetingAt?: number | null;
  meetingPlace?: string | null;
  reminderEnabled?: boolean;
  approved?: string[];
  cohosts?: string[];
  channelId?: string | null;
} = {}) {
  const now = Date.now();
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "テストMeetUp",
    description: "",
    capacity: 5,
    startAt: options.startAt ?? now + 10 * DAY,
    meetingAt: options.meetingAt ?? null,
    meetingPlace: options.meetingPlace ?? null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
    reminderEnabled: options.reminderEnabled ?? true,
  });
  if (options.channelId !== null) updateMeetup(meetup.id, { channelId: options.channelId ?? "chan-1" });
  for (const userId of options.cohosts ?? []) addCohost(meetup.id, userId);
  for (const userId of options.approved ?? []) {
    setParticipantState(meetup.id, userId, "APPROVED", { approvedBy: "host" });
  }
  return getMeetup(meetup.id)!;
}

function forceDue(meetupId: number, offsetSeconds: number, scheduledAt: number, baseAt: number) {
  db.query(
    `INSERT INTO reminder_schedules
       (meetup_id, base_at, offset_seconds, scheduled_at, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)
     ON CONFLICT(meetup_id, base_at, offset_seconds) DO UPDATE SET
       scheduled_at = excluded.scheduled_at, status = 'PENDING', attempts = 0,
       next_retry_at = NULL, claimed_at = NULL, last_error = NULL, skip_reason = NULL,
       updated_at = excluded.updated_at`,
  ).run(meetupId, baseAt, offsetSeconds, scheduledAt, Date.now(), Date.now());
}

function scheduleFor(meetupId: number, offsetSeconds: number) {
  return listSchedules(meetupId).find((schedule) => schedule.offsetSeconds === offsetSeconds);
}

function embedTitle(payload: Sent): string {
  return payload.embeds?.[0]?.data.title ?? "";
}

// --- settings ---

test("defaults: ON with 1d / 3h / 30m schedules", () => {
  const meetup = makeMeetup();
  const settings = getReminderSettings(meetup.id);
  expect(settings.enabled).toBe(true);
  expect(settings.version).toBe(1);
  expect(getReminderOffsets(meetup.id)).toEqual([...DEFAULT_REMINDER_OFFSETS]);
  const schedules = listSchedules(meetup.id);
  expect(schedules.length).toBe(3);
  for (const offset of DEFAULT_REMINDER_OFFSETS) {
    expect(schedules.find((schedule) => schedule.offsetSeconds === offset)?.status).toBe("PENDING");
  }
});

test("preset/custom offsets, dedupe, max 5, minimum 1 while ON", () => {
  expect(offsetFromParts(1, 3, 0)).toBe(86_400 + 3 * 60 * 60);
  expect(offsetFromParts(0, 0, 45)).toBe(45 * 60);
  expect(() => offsetFromParts(0, 0, 0)).toThrow("1分");
  expect(() => offsetFromParts(-1, 0, 0)).toThrow();
  expect(validateReminderOffsets(true, [3600, 3600, 60])).toEqual([3600, 60]);
  expect(() => validateReminderOffsets(true, [])).toThrow("1件以上");
  expect(() => validateReminderOffsets(true, [DAY, DAY / 2, 3600, 1800, 600, 60])).toThrow("最大5件");
  expect(validateReminderOffsets(false, [])).toEqual([]);
  expect(formatOffset(86_400 + 3 * 60 * 60)).toBe("1日3時間前");
  expect(formatOffset(2 * 60 * 60 + 15 * 60)).toBe("2時間15分前");
});

test("past schedules are not registered at creation (even inside 15 minutes)", () => {
  const meetup = makeMeetup({ startAt: Date.now() + 10 * MINUTE });
  expect(listSchedules(meetup.id)).toHaveLength(0);
});

test("meeting time validation rejects past or later-than-start values", () => {
  const start = Date.now() + DAY;
  expect(() => validateMeetingTime(start, Date.now() - 1)).toThrow("未来");
  expect(() => validateMeetingTime(start, start + 1)).toThrow("開催日時より後");
  expect(() => validateMeetingTime(start, start)).not.toThrow();
  expect(() => validateMeetingTime(start, null)).not.toThrow();
});

test("meeting time is the reminder base; without it the start time is used", () => {
  const meeting = makeMeetup({ meetingAt: Date.now() + 3 * DAY });
  expect(scheduleFor(meeting.id, 24 * 60 * 60)?.baseAt).toBe(meeting.meetingAt!);
  const startOnly = makeMeetup();
  expect(scheduleFor(startOnly.id, 24 * 60 * 60)?.baseAt).toBe(startOnly.startAt!);
});

test("OFF can keep zero offsets without default times coming back; ON requires one", () => {
  const meetup = makeMeetup();
  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, false, []);
  expect(getReminderOffsets(meetup.id)).toEqual([]);
  expect(listSchedules(meetup.id)).toEqual([]);
  expect(() => saveReminderSettings(meetup.id, getReminderSettings(meetup.id).version, true, [])).toThrow(
    "1件以上",
  );
});

test("OFF keeps settings and does not send; turning ON after the slot passed does not send", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, false, getReminderOffsets(meetup.id));
  expect(getReminderSettings(meetup.id).enabled).toBe(false);
  expect(getReminderOffsets(meetup.id)).toEqual([...DEFAULT_REMINDER_OFFSETS]);

  forceDue(meetup.id, 3 * 60 * 60, Date.now() - MINUTE, meetup.startAt!);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());
  expect(fake.sent).toHaveLength(0);

  const off = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, off.version, true, getReminderOffsets(meetup.id));
  await tickReminders(fake.client, Date.now() + MINUTE);
  expect(fake.sent).toHaveLength(0);
  expect(getReminderSettings(meetup.id).enabled).toBe(true);
});

// --- sending ---

test("notifies host, cohosts and approved once each (deduped)", async () => {
  const meetingAt = Date.now() + 30 * MINUTE;
  const meetup = makeMeetup({
    startAt: Date.now() + DAY,
    meetingAt,
    meetingPlace: "渋谷駅ハチ公前",
    approved: ["host", "c1", "u1"],
    cohosts: ["c1"],
  });
  forceDue(meetup.id, 30 * 60, Date.now(), meetingAt);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());

  expect(fake.sent).toHaveLength(1);
  const payload = fake.sent[0]!;
  expect(payload.content!.match(/<@host>/g)).toHaveLength(1);
  expect(payload.content!.match(/<@c1>/g)).toHaveLength(1);
  expect(payload.content!.match(/<@u1>/g)).toHaveLength(1);
  expect(payload.allowedMentions?.users).toEqual(["host", "c1", "u1"]);
  const embed = payload.embeds?.[0]?.data;
  expect(embed?.title).toContain("リマインド");
  expect(embed?.description).toContain("集合まで**30分**");
  expect(embed?.fields?.some((field) => field.name === "集合場所" && field.value === "渋谷駅ハチ公前")).toBe(true);
  expect(embed?.fields?.some((field) => field.name === "開催日時")).toBe(true);
  expect(embed?.fields?.some((field) => field.name === "集合時間")).toBe(true);
});

test("host-only notifications are skipped and recorded", async () => {
  const meetup = makeMeetup();
  forceDue(meetup.id, 3 * 60 * 60, Date.now() - MINUTE, meetup.startAt!);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());

  expect(fake.sent).toHaveLength(0);
  const schedule = scheduleFor(meetup.id, 3 * 60 * 60)!;
  expect(schedule.status).toBe("SKIPPED");
  expect(schedule.skipReason).toContain("主催者のみ");
  expect(listReminderHistory(meetup.id, 10, 0).rows.some((row) => row.status === "SKIPPED")).toBe(true);
});

test("sends within 15 minutes using the actual remaining time, skips older slots", async () => {
  const baseAt = Date.now() + 30 * MINUTE;
  const meetup = makeMeetup({ startAt: Date.now() + DAY, meetingAt: null, approved: ["u1"] });
  updateMeetup(meetup.id, { startAt: baseAt, meetingAt: null });
  recalculateSchedules(meetup.id, { resetAll: true });
  forceDue(meetup.id, 30 * 60, Date.now() - 10 * MINUTE, baseAt);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());
  expect(fake.sent).toHaveLength(1);
  expect(fake.sent[0]!.embeds?.[0]?.data.description).toContain("開催まで**30分**");
  expect(scheduleFor(meetup.id, 30 * 60)?.status).toBe("SENT");

  const expired = makeMeetup({ approved: ["u1"] });
  forceDue(expired.id, 3 * 60 * 60, Date.now() - 16 * MINUTE, expired.startAt!);
  await tickReminders(fake.client, Date.now());
  expect(scheduleFor(expired.id, 3 * 60 * 60)?.status).toBe("SKIPPED");
  expect(fake.sent).toHaveLength(1);
});

test("multiple due slots send only the newest and skip the rest", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  forceDue(meetup.id, 3 * 60 * 60, Date.now() - 2 * MINUTE, meetup.startAt!);
  forceDue(meetup.id, 30 * 60, Date.now() - MINUTE, meetup.startAt!);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());

  expect(fake.sent).toHaveLength(1);
  expect(scheduleFor(meetup.id, 30 * 60)?.status).toBe("SENT");
  expect(scheduleFor(meetup.id, 3 * 60 * 60)?.status).toBe("SKIPPED");
  expect(scheduleFor(meetup.id, 3 * 60 * 60)?.skipReason).toContain("新しい通知");
});

test("retries after 1, 2, 4 and 8 minutes then fails and DMs the managers", async () => {
  const meetup = makeMeetup({ approved: ["u1"], cohosts: ["c1"] });
  forceDue(meetup.id, 3 * 60 * 60, Date.now(), meetup.startAt!);
  const fake = fakeDiscord({
    send: async () => {
      throw new Error("Discord API 500");
    },
  });

  let now = Date.now();
  await tickReminders(fake.client, now);
  let schedule = getSchedule(scheduleFor(meetup.id, 3 * 60 * 60)!.id)!;
  expect(schedule.status).toBe("PENDING");
  expect(schedule.attempts).toBe(1);
  expect(schedule.nextRetryAt).toBe(now + MINUTE);

  for (const delay of [MINUTE, 2 * MINUTE, 4 * MINUTE]) {
    now += delay;
    await tickReminders(fake.client, now);
    schedule = getSchedule(schedule.id)!;
    expect(schedule.attempts).toBeGreaterThanOrEqual(2);
  }
  expect(schedule.attempts).toBe(4);
  expect(schedule.nextRetryAt).toBeLessThanOrEqual(schedule.scheduledAt + 15 * MINUTE);

  now = Date.now() + 14 * MINUTE;
  await tickReminders(fake.client, now);
  schedule = getSchedule(schedule.id)!;
  expect(schedule.status).toBe("FAILED");
  expect(fake.dms.length).toBeGreaterThanOrEqual(2);
  const failure = db
    .query("SELECT * FROM reminder_failures WHERE schedule_id = ?")
    .get(schedule.id) as { dm_status: string; channel_status: string } | null;
  expect(failure).not.toBeNull();
  expect(failure?.dm_status).toBe("SENT");
});

test("expired SENDING rows are retried after restart; expired ones fail", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  forceDue(meetup.id, 30 * 60, Date.now() - MINUTE, meetup.startAt!);
  const schedule = scheduleFor(meetup.id, 30 * 60)!;
  db.query(
    "UPDATE reminder_schedules SET status = 'SENDING', claimed_at = ? WHERE id = ?",
  ).run(Date.now() - 2 * MINUTE, schedule.id);

  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());
  expect(fake.sent).toHaveLength(1);
  expect(getSchedule(schedule.id)?.status).toBe("SENT");

  const stale = makeMeetup({ approved: ["u1"] });
  forceDue(stale.id, 30 * 60, Date.now() - 20 * MINUTE, stale.startAt!);
  const staleSchedule = scheduleFor(stale.id, 30 * 60)!;
  db.query(
    "UPDATE reminder_schedules SET status = 'SENDING', claimed_at = ? WHERE id = ?",
  ).run(Date.now() - 20 * MINUTE, staleSchedule.id);
  const fake2 = fakeDiscord();
  await tickReminders(fake2.client, Date.now());
  expect(getSchedule(staleSchedule.id)?.status).toBe("SKIPPED");
});

test("DM failure sends one channel warning; warning is retried within 24 hours", async () => {
  let channelAvailable = true;
  let warningSent = 0;
  const fake = fakeDiscord({
    dmFail: () => true,
    send: async (payload) => {
      if (!channelAvailable) throw new Error("チャンネルなし");
      if (embedTitle(payload).includes("⏰")) throw new Error("送信失敗");
      warningSent += 1;
    },
  });
  const meetup = makeMeetup({ approved: ["u1"] });
  const scheduledAt = Date.now() - 14 * MINUTE;
  forceDue(meetup.id, 30 * 60, scheduledAt, meetup.startAt!);

  channelAvailable = false;
  await tickReminders(fake.client, Date.now());
  await tickReminders(fake.client, Date.now() + 2 * MINUTE);
  const schedule = scheduleFor(meetup.id, 30 * 60)!;
  expect(getSchedule(schedule.id)?.status).toBe("FAILED");
  const failure = db
    .query("SELECT * FROM reminder_failures WHERE schedule_id = ?")
    .get(schedule.id) as { channel_status: string; warning_deadline: number; id: number };
  expect(failure.channel_status).toBe("PENDING");

  channelAvailable = true;
  await tickReminders(fake.client, Date.now() + 60 * MINUTE);
  const updated = db.query("SELECT channel_status FROM reminder_failures WHERE id = ?").get(failure.id) as {
    channel_status: string;
  };
  expect(updated.channel_status).toBe("SENT");
  expect(warningSent).toBe(1);
});

test("channel warnings expire after 24 hours", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  forceDue(meetup.id, 30 * 60, Date.now() - 14 * MINUTE, meetup.startAt!);
  const fake = fakeDiscord({
    dmFail: () => true,
    send: async (payload) => {
      if (embedTitle(payload).includes("⏰")) throw new Error("送信失敗");
      throw new Error("警告も送れない");
    },
  });
  await tickReminders(fake.client, Date.now());
  await tickReminders(fake.client, Date.now() + 2 * MINUTE);
  const schedule = scheduleFor(meetup.id, 30 * 60)!;
  const failure = db
    .query("SELECT * FROM reminder_failures WHERE schedule_id = ?")
    .get(schedule.id) as { id: number };
  await tickReminders(fake.client, Date.now() + 25 * 60 * MINUTE);
  const updated = db.query("SELECT channel_status FROM reminder_failures WHERE id = ?").get(failure.id) as {
    channel_status: string;
  };
  expect(updated.channel_status).toBe("EXPIRED");
});

test("settings-only changes keep SENT rows and do not resend the same base/time", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  forceDue(meetup.id, 30 * 60, Date.now() - MINUTE, meetup.startAt!);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());
  expect(scheduleFor(meetup.id, 30 * 60)?.status).toBe("SENT");
  const sentCount = fake.sent.length;

  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, true, getReminderOffsets(meetup.id));
  expect(scheduleFor(meetup.id, 30 * 60)?.status).toBe("SENT");
  await tickReminders(fake.client, Date.now());
  expect(fake.sent.length).toBe(sentCount);
});

test("date changes recalculate schedules but keep history and do not resend", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  forceDue(meetup.id, 3 * 60 * 60, Date.now() - MINUTE, meetup.startAt!);
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());
  expect(scheduleFor(meetup.id, 3 * 60 * 60)?.status).toBe("SENT");
  const historyBefore = listReminderHistory(meetup.id, 10, 0).total;
  expect(historyBefore).toBe(1);

  updateMeetup(meetup.id, { startAt: Date.now() + 20 * DAY });
  recalculateSchedules(meetup.id, { resetAll: true });
  expect(listSchedules(meetup.id).length).toBe(3);
  expect(listReminderHistory(meetup.id, 10, 0).total).toBe(historyBefore);
  await tickReminders(fake.client, Date.now());
  expect(fake.sent).toHaveLength(1);
});

test("archiving/cancelling stops schedules and warnings while keeping history", async () => {
  const meetup = makeMeetup({ approved: ["u1"] });
  forceDue(meetup.id, 3 * 60 * 60, Date.now() - MINUTE, meetup.startAt!);
  cancelMeetup(meetup);
  expect(scheduleFor(meetup.id, 3 * 60 * 60)?.status).toBe("SKIPPED");
  const fake = fakeDiscord();
  await tickReminders(fake.client, Date.now());
  expect(fake.sent).toHaveLength(0);

  const archived = makeMeetup({ approved: ["u1"] });
  forceDue(archived.id, 30 * 60, Date.now() - MINUTE, archived.startAt!);
  archiveMeetup(archived);
  expect(scheduleFor(archived.id, 30 * 60)?.status).toBe("SKIPPED");
  expect(listReminderHistory(archived.id, 10, 0).total).toBeGreaterThan(0);
});

test("history is pruned after 90 days", () => {
  const meetup = makeMeetup();
  const schedule = scheduleFor(meetup.id, 3 * 60 * 60)!;
  db.query(
    "INSERT INTO reminder_history (meetup_id, schedule_id, base_at, offset_seconds, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'SENT', ?)",
  ).run(meetup.id, schedule.id, schedule.baseAt, schedule.offsetSeconds, schedule.scheduledAt, Date.now() - 91 * DAY);
  pruneReminderHistory(Date.now());
  expect(listReminderHistory(meetup.id, 10, 0).total).toBe(0);
});

// --- settings screen ---

function commandInteraction(meetupId: number, userId: string) {
  const calls: { type: string; payload: unknown }[] = [];
  const interaction = {
    guild: { id: "g1" },
    channel: null,
    channelId: "other",
    user: { id: userId },
    deferred: false,
    replied: false,
    options: { getInteger: () => meetupId },
    reply: async (payload: unknown) => calls.push({ type: "reply", payload }),
    editReply: async (payload: unknown) => calls.push({ type: "editReply", payload }),
    followUp: async (payload: unknown) => calls.push({ type: "followUp", payload }),
    deferReply: async () => {
      interaction.deferred = true;
    },
  };
  return { interaction, calls };
}

function openPanel(meetupId: number, userId = "host") {
  const { interaction, calls } = commandInteraction(meetupId, userId);
  const entry = getSubcommands().find((item) => item.name === "reminder")!;
  return entry.execute(interaction as never).then(() => calls);
}

function panelPayload(calls: { payload: unknown }[]) {
  return calls[0]?.payload as {
    embeds?: { data: { title?: string; description?: string } }[];
    components?: { toJSON: () => { components?: { custom_id?: string }[] } }[];
  };
}

function sessionIdFrom(calls: { payload: unknown }[]): string {
  const row = panelPayload(calls).components?.[0]?.toJSON();
  const customId = row?.components?.[0]?.custom_id ?? "";
  return customId.split(":")[2] ?? "";
}

function buttonInteraction(customId: string, userId = "host") {
  const updates: unknown[] = [];
  const replies: unknown[] = [];
  const interaction = {
    customId,
    guild: { id: "g1" },
    user: { id: userId },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    update: async (payload: unknown) => updates.push(payload),
    reply: async (payload: unknown) => replies.push(payload),
    followUp: async (payload: unknown) => replies.push(payload),
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => updates.push(payload),
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    showModal: async (modal: unknown) => {
      updates.push(modal);
    },
  };
  return { interaction, updates, replies };
}

function selectInteraction(customId: string, value: string, userId = "host") {
  const updates: unknown[] = [];
  const interaction = {
    customId,
    values: [value],
    guild: { id: "g1" },
    user: { id: userId },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    update: async (payload: unknown) => updates.push(payload),
    reply: async (payload: unknown) => updates.push(payload),
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => updates.push(payload),
  };
  return { interaction, updates };
}

function modalInteraction(customId: string, values: Record<string, string>, userId = "host") {
  const updates: unknown[] = [];
  const interaction = {
    customId,
    guild: { id: "g1" },
    user: { id: userId },
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: (key: string) => values[key] ?? "" },
    update: async (payload: unknown) => updates.push(payload),
    reply: async (payload: unknown) => updates.push(payload),
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => updates.push(payload),
  };
  return { interaction, updates };
}

test("settings screen is ephemeral and only managers can open it", async () => {
  const meetup = makeMeetup();
  const denied = await openPanel(meetup.id, "stranger");
  expect(JSON.stringify(denied)).toContain("主催者または共同主催者");

  const calls = await openPanel(meetup.id);
  const payload = panelPayload(calls) as { embeds?: { data: { title?: string } }[] };
  expect(payload.embeds?.[0]?.data.title).toContain("リマインダー設定");
  expect(calls[0]?.type).toBe("editReply");
});

test("save rejects a stale version; cancel discards the draft", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const sessionId = sessionIdFrom(calls);
  expect(sessionId).not.toBe("");

  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, true, getReminderOffsets(meetup.id));

  const save = findButton(`reminder:save:${sessionId}`)!;
  const stale = buttonInteraction(`reminder:save:${sessionId}`);
  await save.handler(stale.interaction as never, save.args);
  expect(JSON.stringify(stale.updates)).toContain("他の管理者");
  expect(() => {
    throw new ReminderVersionConflictError();
  }).toThrow("他の管理者");

  const cancel = findButton(`reminder:cancel:${sessionId}`)!;
  const cancelled = buttonInteraction(`reminder:cancel:${sessionId}`);
  await cancel.handler(cancelled.interaction as never, cancel.args);
  expect(JSON.stringify(cancelled.updates)).toContain("破棄");
});

test("history view opens from the settings panel", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const sessionId = sessionIdFrom(calls);
  const history = findButton(`reminder:history:${sessionId}:0`)!;
  const interaction = buttonInteraction(`reminder:history:${sessionId}:0`);
  await history.handler(interaction.interaction as never, history.args);
  expect(JSON.stringify(interaction.updates)).toContain("リマインダー履歴");
  expect(listDueSchedules(Date.now()).length).toBeGreaterThanOrEqual(0);
});

test("zero offsets can be saved while OFF, and ON is blocked until a time is added", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const sessionId = sessionIdFrom(calls);

  const toggle = findButton(`reminder:toggle:${sessionId}`)!;
  const off = buttonInteraction(`reminder:toggle:${sessionId}`);
  await toggle.handler(off.interaction as never, toggle.args);
  expect(JSON.stringify(off.updates)).toContain("OFF");

  const remove = findSelectMenu(`reminder:remove:${sessionId}`)!;
  let lastUpdate: { updates: unknown[] } | null = null;
  for (const offset of [...DEFAULT_REMINDER_OFFSETS]) {
    const interaction = selectInteraction(`reminder:remove:${sessionId}`, String(offset));
    await remove.handler(interaction.interaction as never, remove.args);
    lastUpdate = interaction;
  }
  expect(JSON.stringify(lastUpdate?.updates)).toContain("設定なし");

  const on = buttonInteraction(`reminder:toggle:${sessionId}`);
  await toggle.handler(on.interaction as never, toggle.args);
  expect(JSON.stringify(on.updates)).toContain("ONにできません");

  const save = findButton(`reminder:save:${sessionId}`)!;
  const saved = buttonInteraction(`reminder:save:${sessionId}`);
  await save.handler(saved.interaction as never, save.args);
  expect(JSON.stringify(saved.updates)).toContain("保存しました");
  expect(getReminderSettings(meetup.id).enabled).toBe(false);
  expect(getReminderOffsets(meetup.id)).toEqual([]);
});

test("another user cannot operate the settings panel", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const sessionId = sessionIdFrom(calls);
  const toggle = findButton(`reminder:toggle:${sessionId}`)!;
  const interaction = buttonInteraction(`reminder:toggle:${sessionId}`, "other");
  await toggle.handler(interaction.interaction as never, toggle.args);
  expect(JSON.stringify(interaction.replies)).toContain("開いた本人だけ");
});

test("free input modal adds a custom offset and rejects zero", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const sessionId = sessionIdFrom(calls);

  const custom = findButton(`reminder:custom:${sessionId}`)!;
  const open = buttonInteraction(`reminder:custom:${sessionId}`);
  await custom.handler(open.interaction as never, custom.args);
  expect(open.updates.length).toBeGreaterThan(0);

  const modalHandler = await import("../src/core/registry.ts").then((registry) =>
    registry.findModal(`reminder:modal:${sessionId}`),
  );
  expect(modalHandler).toBeDefined();

  const invalid = modalInteraction(`reminder:modal:${sessionId}`, { days: "0", hours: "0", minutes: "0" });
  await modalHandler!.handler(invalid.interaction as never, modalHandler!.args);
  expect(JSON.stringify(invalid.updates)).toContain("1分");

  const valid = modalInteraction(`reminder:modal:${sessionId}`, { days: "0", hours: "0", minutes: "45" });
  await modalHandler!.handler(valid.interaction as never, modalHandler!.args);
  expect(JSON.stringify(valid.updates)).toContain("45分前");
});

test("an undecided date keeps reminder settings but creates no schedules", () => {
  const meetup = createMeetup({
    guildId: "g-undecided",
    hostId: "host",
    name: "日時未定リマインダー",
    description: "",
    capacity: 0,
    startAt: null,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  expect(listSchedules(meetup.id)).toEqual([]);
  expect(getReminderOffsets(meetup.id)).toEqual([...DEFAULT_REMINDER_OFFSETS]);

  const startAt = Date.now() + 10 * DAY;
  updateMeetup(meetup.id, { startAt });
  recalculateSchedules(meetup.id, { resetAll: true });
  expect(listSchedules(meetup.id).length).toBe(3);
});
