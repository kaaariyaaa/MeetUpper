import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-reminder-engine-test-${process.pid}-${Date.now()}.db`);
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const { addCohost, cancelMeetup, createMeetup, getMeetup, setParticipantState, updateMeetup } = await import(
  "../src/core/meetup.ts"
);
const {
  REMINDER_RETRY_DELAYS_MS,
  getFailureBySchedule,
  getReminderOffsets,
  getReminderSettings,
  getSchedule,
  listSchedules,
  saveReminderSettings,
} = await import("../src/core/reminders.ts");
const { tickReminders } = await import("../src/core/reminderEngine.ts");

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const THREE_HOURS = 3 * 60 * 60;
const THIRTY_MINUTES = 30 * 60;

interface Sent {
  content?: string;
  allowedMentions?: { users: string[] };
  embeds?: { data: { title?: string; description?: string; fields?: { name: string; value: string }[] } }[];
}

interface FakeOptions {
  send?: (payload: Sent) => Promise<void> | void;
  dmFail?: (userId: string) => boolean;
  onDm?: (userId: string) => void;
}

/** Records every channel attempt, successful sends and DMs separately. */
function fakeDiscord(options: FakeOptions = {}) {
  const attempts: Sent[] = [];
  const sent: Sent[] = [];
  const dms: { userId: string; payload: Sent }[] = [];
  const channel = {
    type: ChannelType.GuildText,
    send: async (payload: Sent) => {
      attempts.push(payload);
      if (options.send) await options.send(payload);
      sent.push(payload);
    },
  };
  const guild = {
    id: "g1",
    channels: { fetch: async (id: string) => (id === "chan-1" ? channel : null) },
  };
  const client = {
    guilds: { cache: new Map<string, unknown>([["g1", guild]]) },
    users: {
      fetch: async (userId: string) => ({
        send: async (payload: Sent) => {
          options.onDm?.(userId);
          if (options.dmFail?.(userId)) throw new Error("DM送信失敗");
          dms.push({ userId, payload });
        },
      }),
    },
  };
  return { client: client as never, attempts, sent, dms };
}

function makeMeetup(options: {
  name: string;
  startAt?: number;
  approved?: string[];
  cohosts?: string[];
} = { name: "エンジンテスト" }) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: options.name,
    description: "",
    capacity: 5,
    startAt: options.startAt ?? Date.now() + 10 * DAY,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
    reminderEnabled: true,
  });
  updateMeetup(meetup.id, { channelId: "chan-1" });
  for (const userId of options.cohosts ?? []) addCohost(meetup.id, userId);
  for (const userId of options.approved ?? []) {
    setParticipantState(meetup.id, userId, "APPROVED", { approvedBy: "host" });
  }
  return getMeetup(meetup.id)!;
}

function forceSchedule(
  meetupId: number,
  offsetSeconds: number,
  scheduledAt: number,
  baseAt: number,
  patch: {
    status?: string;
    attempts?: number;
    nextRetryAt?: number | null;
    claimedAt?: number | null;
    lastError?: string | null;
    updatedAt?: number;
  } = {},
) {
  const updatedAt = patch.updatedAt ?? Date.now();
  db.query(
    `INSERT INTO reminder_schedules
       (meetup_id, base_at, offset_seconds, scheduled_at, status, attempts, next_retry_at,
        claimed_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meetup_id, base_at, offset_seconds) DO UPDATE SET
       scheduled_at = excluded.scheduled_at, status = excluded.status, attempts = excluded.attempts,
       next_retry_at = excluded.next_retry_at, claimed_at = excluded.claimed_at,
       last_error = excluded.last_error, skip_reason = NULL, updated_at = excluded.updated_at`,
  ).run(
    meetupId,
    baseAt,
    offsetSeconds,
    scheduledAt,
    patch.status ?? "PENDING",
    patch.attempts ?? 0,
    patch.nextRetryAt ?? null,
    patch.claimedAt ?? null,
    patch.lastError ?? null,
    updatedAt,
    updatedAt,
  );
}

function scheduleFor(meetupId: number, offsetSeconds: number) {
  return listSchedules(meetupId).find((schedule) => schedule.offsetSeconds === offsetSeconds);
}

function embedText(payload: Sent): string {
  const data = payload.embeds?.[0]?.data;
  return `${data?.title ?? ""} ${data?.description ?? ""}`;
}

function attemptsFor(attempts: Sent[], name: string): Sent[] {
  return attempts.filter((payload) => embedText(payload).includes(name));
}

test("retries 1, 2, 4 and 8 minutes after each failure within the 15-minute window", async () => {
  const t0 = Date.now();
  const name = "retry-timing";
  const meetup = makeMeetup({ name, approved: ["u1"], cohosts: ["c1"] });
  forceSchedule(meetup.id, THREE_HOURS, t0, meetup.startAt);
  const id = scheduleFor(meetup.id, THREE_HOURS)!.id;

  const fake = fakeDiscord({
    send: () => {
      throw new Error("Discord API 500");
    },
  });

  const steps: { at: number; attempts: number; nextRetryAt: number }[] = [
    { at: t0, attempts: 1, nextRetryAt: t0 + 1 * MINUTE },
    { at: t0 + 1 * MINUTE, attempts: 2, nextRetryAt: t0 + 3 * MINUTE },
    { at: t0 + 3 * MINUTE, attempts: 3, nextRetryAt: t0 + 7 * MINUTE },
    // The 8-minute delay after the failure at +7 would land exactly on the +15 hard stop,
    // so it is capped one scheduler tick earlier.
    { at: t0 + 7 * MINUTE, attempts: 4, nextRetryAt: t0 + 14 * MINUTE },
  ];
  for (const step of steps) {
    await tickReminders(fake.client, step.at);
    const schedule = getSchedule(id)!;
    expect(schedule.status).toBe("PENDING");
    expect(schedule.attempts).toBe(step.attempts);
    expect(schedule.nextRetryAt).toBe(step.nextRetryAt);
  }
  expect(REMINDER_RETRY_DELAYS_MS.length).toBe(4);
  expect([...REMINDER_RETRY_DELAYS_MS].map((delay) => delay / MINUTE)).toEqual([1, 2, 4, 8]);
  expect(steps[3]!.nextRetryAt).toBeLessThanOrEqual(t0 + 15 * MINUTE);

  await tickReminders(fake.client, t0 + 14 * MINUTE);
  const finished = getSchedule(id)!;
  expect(finished.status).toBe("FAILED");
  // attempts counts the four scheduled retries; the final failed send is the fifth attempt.
  expect(finished.attempts).toBe(4);
  expect(finished.nextRetryAt).toBeNull();
  // Five send attempts: the original send plus four retries.
  expect(attemptsFor(fake.attempts, name)).toHaveLength(5);
  expect(fake.dms.map((dm) => dm.userId).sort()).toEqual(["c1", "host"]);
  const failure = getFailureBySchedule(id)!;
  expect(failure.dmStatus).toBe("SENT");
  expect(failure.channelStatus).toBe("SKIPPED");
});

test("stale SENDING rows are retried after a restart while inside the window", async () => {
  const t0 = Date.now();
  const name = "stale-retry";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  forceSchedule(meetup.id, THIRTY_MINUTES, t0 - 1 * MINUTE, meetup.startAt, {
    status: "SENDING",
    claimedAt: t0 - 2 * MINUTE,
  });
  const id = scheduleFor(meetup.id, THIRTY_MINUTES)!.id;

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0);

  expect(getSchedule(id)?.status).toBe("SENT");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(1);
  expect(fake.dms).toHaveLength(0);
});

test("expired stale SENDING rows are skipped without a failure DM", async () => {
  const t0 = Date.now();
  const name = "stale-expired";
  const meetup = makeMeetup({ name, approved: ["u1"], cohosts: ["c1"] });
  forceSchedule(meetup.id, THIRTY_MINUTES, t0 - 20 * MINUTE, meetup.startAt, {
    status: "SENDING",
    claimedAt: t0 - 20 * MINUTE,
    attempts: 2,
  });
  const id = scheduleFor(meetup.id, THIRTY_MINUTES)!.id;

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0);

  const schedule = getSchedule(id)!;
  expect(schedule.status).toBe("SKIPPED");
  expect(schedule.skipReason).toContain("送信結果不明");
  expect(getFailureBySchedule(id)).toBeNull();
  expect(fake.dms).toHaveLength(0);
  expect(attemptsFor(fake.attempts, name)).toHaveLength(0);
});

test("multiple due slots send only the newest; only that one is retried", async () => {
  const t0 = Date.now();
  const name = "multiple-due";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  forceSchedule(meetup.id, THREE_HOURS, t0 - 2 * MINUTE, meetup.startAt);
  forceSchedule(meetup.id, THIRTY_MINUTES, t0 - 1 * MINUTE, meetup.startAt);
  const olderId = scheduleFor(meetup.id, THREE_HOURS)!.id;
  const newestId = scheduleFor(meetup.id, THIRTY_MINUTES)!.id;

  let failing = true;
  const fake = fakeDiscord({
    send: async () => {
      if (failing) throw new Error("Discord API 500");
    },
  });

  await tickReminders(fake.client, t0);
  expect(attemptsFor(fake.attempts, name)).toHaveLength(1);
  expect(getSchedule(olderId)?.status).toBe("SKIPPED");
  expect(getSchedule(olderId)?.skipReason).toContain("新しい通知");
  expect(getSchedule(newestId)?.status).toBe("PENDING");
  expect(getSchedule(newestId)?.attempts).toBe(1);

  failing = false;
  await tickReminders(fake.client, t0 + 1 * MINUTE);
  expect(getSchedule(newestId)?.status).toBe("SENT");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(2);
});

test("a settings-only save keeps retry state so the retry still runs", async () => {
  const t0 = Date.now();
  const name = "settings-retry";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  forceSchedule(meetup.id, THREE_HOURS, t0, meetup.startAt);
  const id = scheduleFor(meetup.id, THREE_HOURS)!.id;

  let failing = true;
  const fake = fakeDiscord({
    send: async () => {
      if (failing) throw new Error("Discord API 500");
    },
  });
  await tickReminders(fake.client, t0);
  expect(getSchedule(id)?.attempts).toBe(1);
  const retryAt = getSchedule(id)!.nextRetryAt;

  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, true, getReminderOffsets(meetup.id), t0 + 30_000);
  const kept = getSchedule(id)!;
  expect(kept.status).toBe("PENDING");
  expect(kept.attempts).toBe(1);
  expect(kept.nextRetryAt).toBe(retryAt);

  failing = false;
  await tickReminders(fake.client, t0 + 1 * MINUTE);
  expect(getSchedule(id)?.status).toBe("SENT");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(2);
});

test("a settings-only save does not drop an in-window pending notification", async () => {
  const t0 = Date.now();
  const name = "settings-window";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  forceSchedule(meetup.id, THIRTY_MINUTES, t0 - 1 * MINUTE, meetup.startAt);
  const id = scheduleFor(meetup.id, THIRTY_MINUTES)!.id;

  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, true, getReminderOffsets(meetup.id), t0 + 30_000);
  expect(getSchedule(id)?.status).toBe("PENDING");

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0 + 1 * MINUTE);
  expect(getSchedule(id)?.status).toBe("SENT");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(1);
});

test("a settings-only save drops pending rows for removed notification times", async () => {
  const t0 = Date.now();
  const name = "settings-removed";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  forceSchedule(meetup.id, THIRTY_MINUTES, t0 - 1 * MINUTE, meetup.startAt);
  const removedId = scheduleFor(meetup.id, THIRTY_MINUTES)!.id;

  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, true, [THREE_HOURS], t0 + 30_000);
  expect(scheduleFor(meetup.id, THIRTY_MINUTES)).toBeUndefined();

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0 + 1 * MINUTE);
  expect(getSchedule(removedId)).toBeNull();
  expect(attemptsFor(fake.attempts, name)).toHaveLength(0);
});

test("turning OFF drops pending rows so an in-window slot is not sent on re-enable", async () => {
  const t0 = Date.now();
  const name = "off-window";
  const meetup = makeMeetup({ name, startAt: t0 + 2 * 60 * MINUTE });
  forceSchedule(meetup.id, THREE_HOURS, t0 - 1 * MINUTE, meetup.startAt);

  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, false, getReminderOffsets(meetup.id), t0);
  expect(scheduleFor(meetup.id, THREE_HOURS)).toBeUndefined();

  const on = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, on.version, true, getReminderOffsets(meetup.id), t0 + 30_000);
  expect(scheduleFor(meetup.id, THREE_HOURS)).toBeUndefined();

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0 + 1 * MINUTE);
  expect(attemptsFor(fake.attempts, name)).toHaveLength(0);
});

test("a FAILED schedule without a failure record is repaired once on the next tick", async () => {
  const t0 = Date.now();
  const name = "recovery";
  const meetup = makeMeetup({ name, approved: ["u1"], cohosts: ["c1"] });
  forceSchedule(meetup.id, THREE_HOURS, t0 - 2 * MINUTE, meetup.startAt, {
    status: "FAILED",
    attempts: 1,
    lastError: "Discord API 500",
    updatedAt: t0 - 2 * MINUTE,
  });
  const id = scheduleFor(meetup.id, THREE_HOURS)!.id;
  db.query("DELETE FROM reminder_failures WHERE schedule_id = ?").run(id);

  const observed: { dm_status: string; channel_status: string }[] = [];
  const fake = fakeDiscord({
    onDm: () => {
      if (observed.length > 0) return;
      observed.push(
        db
          .query("SELECT dm_status, channel_status FROM reminder_failures WHERE schedule_id = ?")
          .get(id) as { dm_status: string; channel_status: string },
      );
    },
  });

  await tickReminders(fake.client, t0);
  // The failure row exists before the DMs are attempted.
  expect(observed[0]).toEqual({ dm_status: "PENDING", channel_status: "PENDING" });
  expect(fake.dms.map((dm) => dm.userId).sort()).toEqual(["c1", "host"]);

  const failure = getFailureBySchedule(id)!;
  expect(failure.scheduledAt).toBe(t0 - 2 * MINUTE);
  expect(failure.failedAt).toBe(t0 - 2 * MINUTE);
  expect(failure.dmStatus).toBe("SENT");
  expect(failure.channelStatus).toBe("SKIPPED");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(0);

  await tickReminders(fake.client, t0 + 5 * MINUTE);
  expect(fake.dms).toHaveLength(2);
  const count = db.query("SELECT COUNT(*) AS count FROM reminder_failures WHERE schedule_id = ?").get(id) as {
    count: number;
  };
  expect(count.count).toBe(1);
});

test("cancel stops a failure DM whose failure record was never written", async () => {
  const t0 = Date.now();
  const meetup = makeMeetup({ name: "cancel-recovery", approved: ["u1"] });
  forceSchedule(meetup.id, THREE_HOURS, t0 - 2 * MINUTE, meetup.startAt, {
    status: "FAILED",
    attempts: 1,
    updatedAt: t0 - 2 * MINUTE,
  });
  const id = scheduleFor(meetup.id, THREE_HOURS)!.id;
  db.query("DELETE FROM reminder_failures WHERE schedule_id = ?").run(id);
  cancelMeetup(meetup);

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0);
  expect(fake.dms).toHaveLength(0);
  expect(getFailureBySchedule(id)).toBeNull();
});

function insertFailure(
  meetupId: number,
  scheduleId: number,
  values: {
    failedAt: number;
    dmStatus?: string;
    channelStatus?: string;
    dmFailed?: number;
    updatedAt: number;
    warningDeadline?: number;
  },
) {
  const row = db
    .query(
      `INSERT INTO reminder_failures
         (meetup_id, schedule_id, scheduled_at, failed_at, dm_sent, dm_failed, dm_status,
          channel_status, error, channel_error, warning_deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'Discord API 500', NULL, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      meetupId,
      scheduleId,
      values.failedAt,
      values.failedAt,
      values.dmFailed ?? 0,
      values.dmStatus ?? "PENDING",
      values.channelStatus ?? "PENDING",
      values.warningDeadline ?? values.failedAt + DAY,
      values.updatedAt,
      values.updatedAt,
    ) as { id: number };
  return row.id;
}

test("cancel stops a pending channel warning", async () => {
  const t0 = Date.now();
  const name = "cancel-warning";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  const schedule = scheduleFor(meetup.id, THREE_HOURS)!;
  const failureId = insertFailure(meetup.id, schedule.id, {
    failedAt: t0 - 5 * MINUTE,
    dmStatus: "FAILED",
    channelStatus: "PENDING",
    dmFailed: 1,
    updatedAt: t0 - 2 * MINUTE,
  });

  cancelMeetup(meetup);
  const fake = fakeDiscord();
  await tickReminders(fake.client, t0);

  const failure = db.query("SELECT channel_status FROM reminder_failures WHERE id = ?").get(failureId) as {
    channel_status: string;
  };
  expect(failure.channel_status).toBe("SKIPPED");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(0);
});

test("a pending warning with no known DM failure is not posted to the channel", async () => {
  const t0 = Date.now();
  const name = "dm-unknown";
  const meetup = makeMeetup({ name, approved: ["u1"] });
  const schedule = scheduleFor(meetup.id, THREE_HOURS)!;
  const failureId = insertFailure(meetup.id, schedule.id, {
    failedAt: t0 - 5 * MINUTE,
    dmStatus: "PENDING",
    channelStatus: "PENDING",
    dmFailed: 0,
    updatedAt: t0 - 2 * MINUTE,
  });

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0);

  const failure = db.query("SELECT channel_status, dm_status FROM reminder_failures WHERE id = ?").get(failureId) as {
    channel_status: string;
    dm_status: string;
  };
  expect(failure.channel_status).toBe("SKIPPED");
  expect(failure.dm_status).toBe("PENDING");
  expect(attemptsFor(fake.attempts, name)).toHaveLength(0);
});

test("an expired retry is a failure and DMs managers; a never-attempted row is only skipped", async () => {
  const t0 = Date.now();
  const retried = makeMeetup({ name: "expired-retry", approved: ["u1"], cohosts: ["c1"] });
  forceSchedule(retried.id, THREE_HOURS, t0 - 20 * MINUTE, retried.startAt, {
    attempts: 2,
    lastError: "Discord API 500",
    nextRetryAt: t0 - 19 * MINUTE,
    updatedAt: t0 - 19 * MINUTE,
  });
  const retriedId = scheduleFor(retried.id, THREE_HOURS)!.id;

  const never = makeMeetup({ name: "expired-never", approved: ["u1"] });
  forceSchedule(never.id, THREE_HOURS, t0 - 20 * MINUTE, never.startAt);
  const neverId = scheduleFor(never.id, THREE_HOURS)!.id;

  const fake = fakeDiscord();
  await tickReminders(fake.client, t0);

  const failed = getSchedule(retriedId)!;
  expect(failed.status).toBe("FAILED");
  expect(failed.skipReason).toBeNull();
  expect(fake.dms.map((dm) => dm.userId).sort()).toEqual(["c1", "host"]);
  const failure = getFailureBySchedule(retriedId)!;
  expect(failure.dmStatus).toBe("SENT");

  const skipped = getSchedule(neverId)!;
  expect(skipped.status).toBe("SKIPPED");
  expect(skipped.skipReason).toContain("15分");
  expect(getFailureBySchedule(neverId)).toBeNull();
  expect(attemptsFor(fake.attempts, "expired-never")).toHaveLength(0);
});
