import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type {
  Meetup,
  Participant,
  InviteRequest,
  ReminderSettings,
  ReminderSchedule,
  ReminderHistory,
  ReminderFailure,
} from "./core/types.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS meetups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  meeting_at INTEGER,
  meeting_place TEXT,
  mode TEXT NOT NULL,
  approval_mode TEXT NOT NULL DEFAULT 'HOST',
  required_votes INTEGER NOT NULL DEFAULT 1,
  event_enabled INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  channel_id TEXT,
  forum_thread_id TEXT,
  event_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  state TEXT NOT NULL,
  invited_by TEXT,
  invited_at INTEGER,
  applied_at INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (meetup_id, user_id)
);

CREATE TABLE IF NOT EXISTS cohosts (
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (meetup_id, user_id)
);

CREATE TABLE IF NOT EXISTS votes (
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  applicant_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (meetup_id, applicant_id, voter_id)
);

CREATE TABLE IF NOT EXISTS invite_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  requester_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER
);

DROP TABLE IF EXISTS reminders;

CREATE TABLE IF NOT EXISTS reminder_settings (
  meetup_id INTEGER PRIMARY KEY REFERENCES meetups(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_offsets (
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  offset_seconds INTEGER NOT NULL,
  PRIMARY KEY (meetup_id, offset_seconds)
);

CREATE TABLE IF NOT EXISTS reminder_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  base_at INTEGER NOT NULL,
  offset_seconds INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error TEXT,
  skip_reason TEXT,
  claimed_at INTEGER,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (meetup_id, base_at, offset_seconds)
);

CREATE INDEX IF NOT EXISTS idx_reminder_schedules_due
  ON reminder_schedules (scheduled_at) WHERE status IN ('PENDING', 'SENDING');

CREATE INDEX IF NOT EXISTS idx_reminder_schedules_sending
  ON reminder_schedules (claimed_at) WHERE status = 'SENDING';

CREATE TABLE IF NOT EXISTS reminder_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  schedule_id INTEGER,
  base_at INTEGER NOT NULL,
  offset_seconds INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  sent_at INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_history_once
  ON reminder_history (schedule_id, status) WHERE schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reminder_history_meetup
  ON reminder_history (meetup_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reminder_history_created
  ON reminder_history (created_at);

CREATE TABLE IF NOT EXISTS reminder_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  schedule_id INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  failed_at INTEGER NOT NULL,
  dm_sent INTEGER NOT NULL DEFAULT 0,
  dm_failed INTEGER NOT NULL DEFAULT 0,
  dm_status TEXT NOT NULL DEFAULT 'PENDING',
  channel_status TEXT NOT NULL DEFAULT 'PENDING',
  error TEXT,
  channel_error TEXT,
  warning_deadline INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_failures_warning
  ON reminder_failures (channel_status, warning_deadline);
`);

const failureColumns = db.query("PRAGMA table_info(reminder_failures)").all() as { name: string }[];
if (!failureColumns.some((column) => column.name === "error")) {
  db.exec("ALTER TABLE reminder_failures ADD COLUMN error TEXT");
}

interface MeetupRow {
  id: number;
  guild_id: string;
  host_id: string;
  name: string;
  description: string;
  capacity: number;
  start_at: number;
  meeting_at: number | null;
  meeting_place: string | null;
  mode: string;
  approval_mode: string;
  required_votes: number;
  event_enabled: number;
  state: string;
  channel_id: string | null;
  forum_thread_id: string | null;
  event_id: string | null;
  created_at: number;
}

export function toMeetup(row: MeetupRow): Meetup {
  return {
    id: row.id,
    guildId: row.guild_id,
    hostId: row.host_id,
    name: row.name,
    description: row.description,
    capacity: row.capacity,
    startAt: row.start_at,
    meetingAt: row.meeting_at,
    meetingPlace: row.meeting_place,
    mode: row.mode as Meetup["mode"],
    approvalMode: row.approval_mode as Meetup["approvalMode"],
    requiredVotes: row.required_votes,
    eventEnabled: row.event_enabled === 1,
    state: row.state as Meetup["state"],
    channelId: row.channel_id,
    forumThreadId: row.forum_thread_id,
    eventId: row.event_id,
    createdAt: row.created_at,
  };
}

interface ParticipantRow {
  meetup_id: number;
  user_id: string;
  state: string;
  invited_by: string | null;
  invited_at: number | null;
  applied_at: number | null;
  approved_by: string | null;
  approved_at: number | null;
  updated_at: number;
}

export function toParticipant(row: ParticipantRow): Participant {
  return {
    meetupId: row.meetup_id,
    userId: row.user_id,
    state: row.state as Participant["state"],
    invitedBy: row.invited_by,
    invitedAt: row.invited_at,
    appliedAt: row.applied_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
  };
}

interface InviteRequestRow {
  id: number;
  meetup_id: number;
  requester_id: string;
  target_id: string;
  status: string;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
}

export function toInviteRequest(row: InviteRequestRow): InviteRequest {
  return {
    id: row.id,
    meetupId: row.meetup_id,
    requesterId: row.requester_id,
    targetId: row.target_id,
    status: row.status as InviteRequest["status"],
    createdAt: row.created_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

interface ReminderSettingsRow {
  meetup_id: number;
  enabled: number;
  version: number;
  updated_at: number;
}

export function toReminderSettings(row: ReminderSettingsRow): ReminderSettings {
  return {
    meetupId: row.meetup_id,
    enabled: row.enabled === 1,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

interface ReminderScheduleRow {
  id: number;
  meetup_id: number;
  base_at: number;
  offset_seconds: number;
  scheduled_at: number;
  status: string;
  attempts: number;
  next_retry_at: number | null;
  last_error: string | null;
  skip_reason: string | null;
  claimed_at: number | null;
  sent_at: number | null;
  created_at: number;
  updated_at: number;
}

export function toReminderSchedule(row: ReminderScheduleRow): ReminderSchedule {
  return {
    id: row.id,
    meetupId: row.meetup_id,
    baseAt: row.base_at,
    offsetSeconds: row.offset_seconds,
    scheduledAt: row.scheduled_at,
    status: row.status as ReminderSchedule["status"],
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    skipReason: row.skip_reason,
    claimedAt: row.claimed_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ReminderHistoryRow {
  id: number;
  meetup_id: number;
  schedule_id: number | null;
  base_at: number;
  offset_seconds: number;
  scheduled_at: number;
  sent_at: number | null;
  status: string;
  reason: string | null;
  created_at: number;
}

export function toReminderHistory(row: ReminderHistoryRow): ReminderHistory {
  return {
    id: row.id,
    meetupId: row.meetup_id,
    scheduleId: row.schedule_id,
    baseAt: row.base_at,
    offsetSeconds: row.offset_seconds,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    status: row.status as ReminderHistory["status"],
    reason: row.reason,
    createdAt: row.created_at,
  };
}

interface ReminderFailureRow {
  id: number;
  meetup_id: number;
  schedule_id: number;
  scheduled_at: number;
  failed_at: number;
  dm_sent: number;
  dm_failed: number;
  dm_status: string;
  channel_status: string;
  error: string | null;
  channel_error: string | null;
  warning_deadline: number;
  created_at: number;
  updated_at: number;
}

export function toReminderFailure(row: ReminderFailureRow): ReminderFailure {
  return {
    id: row.id,
    meetupId: row.meetup_id,
    scheduleId: row.schedule_id,
    scheduledAt: row.scheduled_at,
    failedAt: row.failed_at,
    dmSent: row.dm_sent,
    dmFailed: row.dm_failed,
    dmStatus: row.dm_status as ReminderFailure["dmStatus"],
    channelStatus: row.channel_status as ReminderFailure["channelStatus"],
    error: row.error,
    channelError: row.channel_error,
    warningDeadline: row.warning_deadline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type {
  MeetupRow,
  ParticipantRow,
  InviteRequestRow,
  ReminderSettingsRow,
  ReminderScheduleRow,
  ReminderHistoryRow,
  ReminderFailureRow,
};
