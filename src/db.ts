import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type { Meetup, Participant, InviteRequest, Reminder } from "./core/types.ts";

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

CREATE TABLE IF NOT EXISTS reminders (
  meetup_id INTEGER NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (meetup_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (remind_at) WHERE sent_at IS NULL;
`);

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

interface ReminderRow {
  meetup_id: number;
  kind: string;
  remind_at: number;
  sent_at: number | null;
}

export function toReminder(row: ReminderRow): Reminder {
  return { meetupId: row.meetup_id, kind: row.kind, remindAt: row.remind_at, sentAt: row.sent_at };
}

export type { MeetupRow, ParticipantRow, InviteRequestRow, ReminderRow };
