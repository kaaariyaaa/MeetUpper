import {
  db,
  toReminderSettings,
  toReminderSchedule,
  toReminderHistory,
  toReminderFailure,
} from "../db.ts";
import type {
  ReminderFailure,
  ReminderHistory,
  ReminderSchedule,
  ReminderSettings,
  ReminderStatus,
} from "./types.ts";

export const DEFAULT_REMINDER_OFFSETS = [24 * 60 * 60, 3 * 60 * 60, 30 * 60] as const;
export const MAX_REMINDER_OFFSETS = 5;
export const MIN_REMINDER_OFFSET = 60;
export const REMINDER_WINDOW_MS = 15 * 60 * 1000;
export const REMINDER_RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 480_000] as const;
export const REMINDER_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
export const FAILURE_WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PRESET_REMINDER_OFFSETS = [
  { seconds: 7 * 24 * 60 * 60, label: "7日前" },
  { seconds: 3 * 24 * 60 * 60, label: "3日前" },
  { seconds: 24 * 60 * 60, label: "1日前" },
  { seconds: 12 * 60 * 60, label: "12時間前" },
  { seconds: 6 * 60 * 60, label: "6時間前" },
  { seconds: 3 * 60 * 60, label: "3時間前" },
  { seconds: 60 * 60, label: "1時間前" },
  { seconds: 30 * 60, label: "30分前" },
  { seconds: 10 * 60, label: "10分前" },
] as const;

export class ReminderVersionConflictError extends Error {
  constructor() {
    super("他の管理者が先に設定を保存しました。最新の設定を読み直してください。");
  }
}

export function reminderBaseAt(meetup: { meetingAt: number | null; startAt: number }): number {
  return meetup.meetingAt ?? meetup.startAt;
}

export function formatOffset(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const parts = [days ? `${days}日` : "", hours ? `${hours}時間` : "", minutes ? `${minutes}分` : ""]
    .filter(Boolean)
    .join("");
  return `${parts || "1分"}前`;
}

export function offsetFromParts(days: number, hours: number, minutes: number): number {
  for (const value of [days, hours, minutes]) {
    if (!Number.isInteger(value) || value < 0) throw new Error("日・時間・分は0以上の整数で指定してください。");
  }
  const seconds = days * 86_400 + hours * 3_600 + minutes * 60;
  if (seconds < MIN_REMINDER_OFFSET) throw new Error("通知時刻は最短で1分前です。");
  return seconds;
}

export function dedupeOffsets(offsets: number[]): number[] {
  return [...new Set(offsets)].sort((a, b) => b - a);
}

export function validateReminderOffsets(enabled: boolean, offsets: number[]): number[] {
  const unique = dedupeOffsets(offsets);
  if (unique.some((offset) => offset < MIN_REMINDER_OFFSET)) {
    throw new Error("通知時刻は最短で1分前です。");
  }
  if (unique.length > MAX_REMINDER_OFFSETS) {
    throw new Error(`通知時刻は最大${MAX_REMINDER_OFFSETS}件までです。`);
  }
  if (enabled && unique.length === 0) {
    throw new Error("自動通知がONの場合は通知時刻を1件以上設定してください。");
  }
  return unique;
}

function ensureSettingsRow(meetupId: number, now = Date.now()): void {
  const inserted = db.query(
    "INSERT OR IGNORE INTO reminder_settings (meetup_id, enabled, version, updated_at) VALUES (?, 1, 1, ?)",
  ).run(meetupId, now);
  if (Number(inserted.changes) === 0) return;
  // Only a brand-new setting gets defaults; a saved OFF setting may intentionally have 0 offsets.
  for (const offset of DEFAULT_REMINDER_OFFSETS) {
    db.query("INSERT OR IGNORE INTO reminder_offsets (meetup_id, offset_seconds) VALUES (?, ?)").run(
      meetupId,
      offset,
    );
  }
}

export function getReminderSettings(meetupId: number): ReminderSettings {
  const row = db.query("SELECT * FROM reminder_settings WHERE meetup_id = ?").get(meetupId) as
    | Parameters<typeof toReminderSettings>[0]
    | null;
  if (row) return toReminderSettings(row);
  ensureSettingsRow(meetupId);
  const created = db.query("SELECT * FROM reminder_settings WHERE meetup_id = ?").get(meetupId) as Parameters<
    typeof toReminderSettings
  >[0];
  return toReminderSettings(created);
}

export function getReminderOffsets(meetupId: number): number[] {
  const rows = db
    .query("SELECT offset_seconds FROM reminder_offsets WHERE meetup_id = ? ORDER BY offset_seconds DESC")
    .all(meetupId) as { offset_seconds: number }[];
  return rows.map((row) => row.offset_seconds);
}

export function initReminderSettings(
  meetupId: number,
  enabled: boolean,
  offsets: number[] = [...DEFAULT_REMINDER_OFFSETS],
  now = Date.now(),
): ReminderSettings {
  const validOffsets = validateReminderOffsets(enabled, offsets);
  db.transaction(() => {
    db.query(
      "INSERT INTO reminder_settings (meetup_id, enabled, version, updated_at) VALUES (?, ?, 1, ?)",
    ).run(meetupId, enabled ? 1 : 0, now);
    for (const offset of validOffsets) {
      db.query("INSERT OR IGNORE INTO reminder_offsets (meetup_id, offset_seconds) VALUES (?, ?)").run(
        meetupId,
        offset,
      );
    }
    recalculateSchedules(meetupId, { resetAll: true, now });
  })();
  return getReminderSettings(meetupId);
}

export interface RecalculateOptions {
  /** Deletes every current schedule (including SENT) and rebuilds from the new base time. */
  resetAll: boolean;
  now?: number;
}

/** Rebuilds the current notification schedule without touching history. */
export function recalculateSchedules(meetupId: number, options: RecalculateOptions): void {
  const now = options.now ?? Date.now();
  const meetup = db
    .query("SELECT start_at, meeting_at FROM meetups WHERE id = ?")
    .get(meetupId) as { start_at: number; meeting_at: number | null } | null;
  if (!meetup) return;
  const baseAt = meetup.meeting_at ?? meetup.start_at;
  const offsets = getReminderOffsets(meetupId);
  const enabled = getReminderSettings(meetupId).enabled;

  db.transaction(() => {
    if (options.resetAll) {
      db.query("DELETE FROM reminder_schedules WHERE meetup_id = ?").run(meetupId);
    } else {
      // Settings-only edits keep sent rows for the same base time; unsent rows are rebuilt.
      db.query(
        "DELETE FROM reminder_schedules WHERE meetup_id = ? AND status NOT IN ('SENT', 'SENDING')",
      ).run(meetupId);
    }
    const sentRows = db
      .query(
        "SELECT base_at, offset_seconds FROM reminder_schedules WHERE meetup_id = ? AND status = 'SENT'",
      )
      .all(meetupId) as { base_at: number; offset_seconds: number }[];
    const sent = new Set(sentRows.map((row) => `${row.base_at}:${row.offset_seconds}`));
    for (const offset of offsets) {
      if (!enabled) continue;
      if (sent.has(`${baseAt}:${offset}`)) continue;
      const scheduledAt = baseAt - offset * 1000;
      if (scheduledAt <= now) continue;
      db.query(
        `INSERT OR IGNORE INTO reminder_schedules
           (meetup_id, base_at, offset_seconds, scheduled_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
      ).run(meetupId, baseAt, offset, scheduledAt, now, now);
    }
  })();
}

/** Saves enabled/offsets with optimistic concurrency and rebuilds the pending schedule. */
export function saveReminderSettings(
  meetupId: number,
  expectedVersion: number,
  enabled: boolean,
  offsets: number[],
  now = Date.now(),
): ReminderSettings {
  const validOffsets = validateReminderOffsets(enabled, offsets);
  getReminderSettings(meetupId);
  db.transaction(() => {
    const result = db
      .query(
        "UPDATE reminder_settings SET enabled = ?, version = version + 1, updated_at = ? WHERE meetup_id = ? AND version = ?",
      )
      .run(enabled ? 1 : 0, now, meetupId, expectedVersion);
    if (Number(result.changes) === 0) throw new ReminderVersionConflictError();
    db.query("DELETE FROM reminder_offsets WHERE meetup_id = ?").run(meetupId);
    for (const offset of validOffsets) {
      db.query("INSERT INTO reminder_offsets (meetup_id, offset_seconds) VALUES (?, ?)").run(meetupId, offset);
    }
    recalculateSchedules(meetupId, { resetAll: false, now });
  })();
  return getReminderSettings(meetupId);
}

export function listSchedules(meetupId: number): ReminderSchedule[] {
  return (
    db
      .query("SELECT * FROM reminder_schedules WHERE meetup_id = ? ORDER BY scheduled_at ASC")
      .all(meetupId) as Parameters<typeof toReminderSchedule>[0][]
  ).map(toReminderSchedule);
}

export function getSchedule(id: number): ReminderSchedule | null {
  const row = db.query("SELECT * FROM reminder_schedules WHERE id = ?").get(id) as
    | Parameters<typeof toReminderSchedule>[0]
    | null;
  return row ? toReminderSchedule(row) : null;
}

export function listDueSchedules(now = Date.now()): ReminderSchedule[] {
  return (
    db
      .query(
        `SELECT * FROM reminder_schedules
         WHERE status = 'PENDING' AND scheduled_at <= ? AND scheduled_at + ? >= ?
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY scheduled_at ASC`,
      )
      .all(now, REMINDER_WINDOW_MS, now, now) as Parameters<typeof toReminderSchedule>[0][]
  ).map(toReminderSchedule);
}

export function listExpiredSchedules(now = Date.now()): ReminderSchedule[] {
  return (
    db
      .query("SELECT * FROM reminder_schedules WHERE status = 'PENDING' AND scheduled_at + ? < ?")
      .all(REMINDER_WINDOW_MS, now) as Parameters<typeof toReminderSchedule>[0][]
  ).map(toReminderSchedule);
}

export function listStaleSending(now = Date.now(), staleAfterMs = 60_000): ReminderSchedule[] {
  return (
    db
      .query("SELECT * FROM reminder_schedules WHERE status = 'SENDING' AND claimed_at <= ?")
      .all(now - staleAfterMs) as Parameters<typeof toReminderSchedule>[0][]
  ).map(toReminderSchedule);
}

/** Claims a pending schedule for sending. Returns false when another tick owns it. */
export function claimSchedule(id: number, now = Date.now()): boolean {
  const result = db
    .query(
      `UPDATE reminder_schedules
       SET status = 'SENDING', claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
    )
    .run(now, now, id, now);
  return Number(result.changes) === 1;
}

export function resetSendingToPending(id: number, now = Date.now()): void {
  db.query(
    "UPDATE reminder_schedules SET status = 'PENDING', next_retry_at = ?, claimed_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now, now, id);
}

export function scheduleRetry(
  id: number,
  attempts: number,
  nextRetryAt: number,
  lastError: string,
  now = Date.now(),
): void {
  db.query(
    `UPDATE reminder_schedules
     SET status = 'PENDING', attempts = ?, next_retry_at = ?, last_error = ?, claimed_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(attempts, nextRetryAt, lastError.slice(0, 1000), now, id);
}

function insertHistory(schedule: ReminderSchedule, status: ReminderHistory["status"], reason: string | null, sentAt: number | null, now: number): void {
  db.query(
    `INSERT OR IGNORE INTO reminder_history
       (meetup_id, schedule_id, base_at, offset_seconds, scheduled_at, sent_at, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    schedule.meetupId,
    schedule.id,
    schedule.baseAt,
    schedule.offsetSeconds,
    schedule.scheduledAt,
    sentAt,
    status,
    reason?.slice(0, 1000) ?? null,
    now,
  );
}

export function finishSchedule(
  id: number,
  status: "SENT" | "FAILED" | "SKIPPED",
  reason: string | null,
  sentAt: number | null = null,
  now = Date.now(),
): ReminderSchedule | null {
  const schedule = getSchedule(id);
  if (!schedule) return null;
  db.transaction(() => {
    db.query(
      `UPDATE reminder_schedules
       SET status = ?, sent_at = ?, last_error = CASE WHEN ? = 'FAILED' THEN ? ELSE last_error END,
           skip_reason = CASE WHEN ? = 'SKIPPED' THEN ? ELSE skip_reason END,
           claimed_at = NULL, next_retry_at = NULL, updated_at = ?
       WHERE id = ? AND status NOT IN ('SENT', 'SKIPPED')`,
    ).run(
      status,
      sentAt,
      status,
      reason?.slice(0, 1000) ?? null,
      status,
      reason?.slice(0, 1000) ?? null,
      now,
      id,
    );
    insertHistory(schedule, status, reason, sentAt, now);
  })();
  return getSchedule(id);
}

/** Marks pending/retrying schedules skipped and stops pending failure warnings. */
export function stopRemindersForMeetup(meetupId: number, reason: string, now = Date.now()): void {
  const schedules = db
    .query("SELECT * FROM reminder_schedules WHERE meetup_id = ? AND status IN ('PENDING','SENDING')")
    .all(meetupId) as Parameters<typeof toReminderSchedule>[0][];
  db.transaction(() => {
    for (const row of schedules) {
      const schedule = toReminderSchedule(row);
      db.query(
        `UPDATE reminder_schedules
         SET status = 'SKIPPED', skip_reason = ?, claimed_at = NULL, next_retry_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(reason, now, schedule.id);
      insertHistory(schedule, "SKIPPED", reason, null, now);
    }
    db.query(
      "UPDATE reminder_failures SET channel_status = 'SKIPPED', dm_status = CASE WHEN dm_status = 'PENDING' THEN 'SKIPPED' ELSE dm_status END, updated_at = ? WHERE meetup_id = ? AND channel_status = 'PENDING'",
    ).run(now, meetupId);
  })();
}

export function pruneReminderHistory(now = Date.now()): void {
  db.query("DELETE FROM reminder_history WHERE created_at < ?").run(now - REMINDER_HISTORY_MS);
}

export interface HistoryPage {
  rows: ReminderHistory[];
  total: number;
}

export function listReminderHistory(meetupId: number, limit: number, offset: number): HistoryPage {
  const rows = db
    .query(
      "SELECT * FROM reminder_history WHERE meetup_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(meetupId, limit, offset) as Parameters<typeof toReminderHistory>[0][];
  const total = db.query("SELECT COUNT(*) AS count FROM reminder_history WHERE meetup_id = ?").get(meetupId) as {
    count: number;
  };
  return { rows: rows.map(toReminderHistory), total: total.count };
}

export interface FailureInput {
  meetupId: number;
  scheduleId: number;
  scheduledAt: number;
  failedAt: number;
  error: string;
}

/** Creates the failure record before DMs are attempted so a crash cannot lose it. */
export function createFailureRecord(input: FailureInput, now = Date.now()): ReminderFailure {
  const row = db
    .query(
      `INSERT INTO reminder_failures
         (meetup_id, schedule_id, scheduled_at, failed_at, dm_sent, dm_failed, dm_status,
          channel_status, error, channel_error, warning_deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 'PENDING', 'PENDING', ?, NULL, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      input.meetupId,
      input.scheduleId,
      input.scheduledAt,
      input.failedAt,
      input.error.slice(0, 1000),
      input.failedAt + FAILURE_WARNING_WINDOW_MS,
      now,
      now,
    ) as Parameters<typeof toReminderFailure>[0];
  return toReminderFailure(row);
}

export function updateFailureDmStatus(
  id: number,
  dmSent: number,
  dmFailed: number,
  dmStatus: ReminderFailure["dmStatus"],
  now = Date.now(),
): void {
  db.query(
    "UPDATE reminder_failures SET dm_sent = ?, dm_failed = ?, dm_status = ?, updated_at = ? WHERE id = ?",
  ).run(dmSent, dmFailed, dmStatus, now, id);
}

export function listFailedSchedulesWithoutFailure(): ReminderSchedule[] {
  return (
    db
      .query(
        `SELECT s.* FROM reminder_schedules s
         LEFT JOIN reminder_failures f ON f.schedule_id = s.id
         WHERE s.status = 'FAILED' AND f.id IS NULL`,
      )
      .all() as Parameters<typeof toReminderSchedule>[0][]
  ).map(toReminderSchedule);
}

export function updateFailureChannelStatus(
  id: number,
  status: ReminderFailure["channelStatus"],
  error: string | null = null,
  now = Date.now(),
): void {
  db.query(
    "UPDATE reminder_failures SET channel_status = ?, channel_error = ?, updated_at = ? WHERE id = ? AND channel_status = 'PENDING'",
  ).run(status, error?.slice(0, 1000) ?? null, now, id);
}

export function listPendingChannelWarnings(now = Date.now()): ReminderFailure[] {
  return (
    db
      .query(
        `SELECT * FROM reminder_failures
         WHERE channel_status = 'PENDING' AND warning_deadline > ? AND updated_at <= ?
         ORDER BY failed_at ASC`,
      )
      .all(now, now - 60_000) as Parameters<typeof toReminderFailure>[0][]
  ).map(toReminderFailure);
}

export function expireChannelWarnings(now = Date.now()): void {
  db.query(
    "UPDATE reminder_failures SET channel_status = 'EXPIRED', updated_at = ? WHERE channel_status = 'PENDING' AND warning_deadline <= ?",
  ).run(now, now);
}

export function getFailureBySchedule(scheduleId: number): ReminderFailure | null {
  const row = db
    .query("SELECT * FROM reminder_failures WHERE schedule_id = ? ORDER BY id DESC LIMIT 1")
    .get(scheduleId) as Parameters<typeof toReminderFailure>[0] | null;
  return row ? toReminderFailure(row) : null;
}

export function remainingMinutes(baseAt: number, now = Date.now()): number {
  return Math.max(0, Math.round((baseAt - now) / 60_000));
}

export function isReminderTerminal(status: ReminderStatus): boolean {
  return status === "SENT" || status === "FAILED" || status === "SKIPPED";
}
