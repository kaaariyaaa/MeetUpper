import { db, toMeetup, toParticipant, toInviteRequest, toReminder } from "../db.ts";
import type {
  ApprovalMode,
  InviteRequest,
  InviteRequestStatus,
  Meetup,
  MeetupMode,
  MeetupState,
  Participant,
  ParticipantState,
  Reminder,
} from "./types.ts";
import { config } from "../config.ts";

export interface CreateMeetupInput {
  guildId: string;
  hostId: string;
  name: string;
  description: string;
  capacity: number;
  startAt: number;
  meetingAt: number | null;
  meetingPlace: string | null;
  mode: MeetupMode;
  approvalMode: ApprovalMode;
  requiredVotes: number;
  eventEnabled: boolean;
}

export function createMeetup(input: CreateMeetupInput): Meetup {
  const now = Date.now();
  const row = db
    .query(
      `INSERT INTO meetups
       (guild_id, host_id, name, description, capacity, start_at, meeting_at, meeting_place,
        mode, approval_mode, required_votes, event_enabled, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
       RETURNING *`,
    )
    .get(
      input.guildId,
      input.hostId,
      input.name,
      input.description,
      input.capacity,
      input.startAt,
      input.meetingAt,
      input.meetingPlace,
      input.mode,
      input.approvalMode,
      input.requiredVotes,
      input.eventEnabled ? 1 : 0,
      now,
    ) as Parameters<typeof toMeetup>[0];
  return toMeetup(row);
}

export function deleteMeetup(id: number): void {
  db.query("DELETE FROM meetups WHERE id = ?").run(id);
}

export function getMeetup(id: number): Meetup | null {
  const row = db.query("SELECT * FROM meetups WHERE id = ?").get(id) as
    | Parameters<typeof toMeetup>[0]
    | null;
  return row ? toMeetup(row) : null;
}

export function getMeetupByChannelId(channelId: string): Meetup | null {
  const row = db.query("SELECT * FROM meetups WHERE channel_id = ? AND state = 'ACTIVE'").get(channelId) as
    | Parameters<typeof toMeetup>[0]
    | null;
  return row ? toMeetup(row) : null;
}

export function listMeetups(guildId: string, states: MeetupState[] = ["ACTIVE"]): Meetup[] {
  const placeholders = states.map(() => "?").join(", ");
  const rows = db
    .query(`SELECT * FROM meetups WHERE guild_id = ? AND state IN (${placeholders}) ORDER BY start_at ASC`)
    .all(guildId, ...states) as Parameters<typeof toMeetup>[0][];
  return rows.map(toMeetup);
}

export function updateMeetup(
  id: number,
  fields: Partial<
    Pick<
      Meetup,
      | "name"
      | "description"
      | "capacity"
      | "startAt"
      | "hostId"
      | "meetingAt"
      | "meetingPlace"
      | "channelId"
      | "forumThreadId"
      | "eventId"
      | "state"
    >
  >,
): Meetup | null {
  const mapping: Record<string, string> = {
    name: "name",
    description: "description",
    capacity: "capacity",
    startAt: "start_at",
    hostId: "host_id",
    meetingAt: "meeting_at",
    meetingPlace: "meeting_place",
    channelId: "channel_id",
    forumThreadId: "forum_thread_id",
    eventId: "event_id",
    state: "state",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const column = mapping[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  if (sets.length === 0) return getMeetup(id);
  db.query(`UPDATE meetups SET ${sets.join(", ")} WHERE id = ?`).run(...(values as never[]), id);
  return getMeetup(id);
}

export function setMeetupState(id: number, state: MeetupState): void {
  db.query("UPDATE meetups SET state = ? WHERE id = ?").run(state, id);
}

/* --- permissions --- */

export function listCohosts(meetupId: number): string[] {
  const rows = db.query("SELECT user_id FROM cohosts WHERE meetup_id = ?").all(meetupId) as {
    user_id: string;
  }[];
  return rows.map((r) => r.user_id);
}

export function addCohost(meetupId: number, userId: string): void {
  db.query("INSERT OR IGNORE INTO cohosts (meetup_id, user_id) VALUES (?, ?)").run(meetupId, userId);
}

export function removeCohost(meetupId: number, userId: string): void {
  db.query("DELETE FROM cohosts WHERE meetup_id = ? AND user_id = ?").run(meetupId, userId);
}

export function isHost(meetup: Meetup, userId: string): boolean {
  return meetup.hostId === userId;
}

export function canManage(meetup: Meetup, userId: string): boolean {
  return isHost(meetup, userId) || listCohosts(meetup.id).includes(userId);
}

/* --- participants --- */

export function getParticipant(meetupId: number, userId: string): Participant | null {
  const row = db
    .query("SELECT * FROM participants WHERE meetup_id = ? AND user_id = ?")
    .get(meetupId, userId) as Parameters<typeof toParticipant>[0] | null;
  return row ? toParticipant(row) : null;
}

export function listParticipants(meetupId: number, states?: ParticipantState[]): Participant[] {
  if (!states || states.length === 0) {
    return (db.query("SELECT * FROM participants WHERE meetup_id = ?").all(meetupId) as Parameters<typeof toParticipant>[0][]).map(toParticipant);
  }
  const placeholders = states.map(() => "?").join(", ");
  return (
    db
      .query(`SELECT * FROM participants WHERE meetup_id = ? AND state IN (${placeholders})`)
      .all(meetupId, ...states) as Parameters<typeof toParticipant>[0][]
  ).map(toParticipant);
}

export function countApproved(meetupId: number): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM participants WHERE meetup_id = ? AND state = 'APPROVED'")
    .get(meetupId) as { count: number };
  return row.count;
}

export interface SetParticipantOptions {
  invitedBy?: string;
  approvedBy?: string;
}

/** Upserts a participant state, preserving history fields where relevant. */
export function setParticipantState(
  meetupId: number,
  userId: string,
  state: ParticipantState,
  options: SetParticipantOptions = {},
): Participant {
  const now = Date.now();
  const previous = getParticipant(meetupId, userId);
  const invitedBy = options.invitedBy ?? previous?.invitedBy ?? null;
  const invitedAt = options.invitedBy ? (previous?.invitedAt ?? now) : (previous?.invitedAt ?? null);
  const appliedAt = state === "APPLIED" ? now : (previous?.appliedAt ?? null);
  const approvedBy = state === "APPROVED" ? (options.approvedBy ?? previous?.approvedBy ?? null) : (previous?.approvedBy ?? null);
  const approvedAt = state === "APPROVED" ? now : (previous?.approvedAt ?? null);

  db.query(
    `INSERT INTO participants
       (meetup_id, user_id, state, invited_by, invited_at, applied_at, approved_by, approved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meetup_id, user_id) DO UPDATE SET
       state = excluded.state,
       invited_by = excluded.invited_by,
       invited_at = excluded.invited_at,
       applied_at = excluded.applied_at,
       approved_by = excluded.approved_by,
       approved_at = excluded.approved_at,
       updated_at = excluded.updated_at`,
  ).run(meetupId, userId, state, invitedBy, invitedAt, appliedAt, approvedBy, approvedAt, now);
  return getParticipant(meetupId, userId)!;
}

/* --- votes --- */

export function addVote(meetupId: number, applicantId: string, voterId: string): number {
  db.query("INSERT OR IGNORE INTO votes (meetup_id, applicant_id, voter_id, created_at) VALUES (?, ?, ?, ?)").run(
    meetupId,
    applicantId,
    voterId,
    Date.now(),
  );
  return countVotes(meetupId, applicantId);
}

export function countVotes(meetupId: number, applicantId: string): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM votes WHERE meetup_id = ? AND applicant_id = ?")
    .get(meetupId, applicantId) as { count: number };
  return row.count;
}

export function hasVoted(meetupId: number, applicantId: string, voterId: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM votes WHERE meetup_id = ? AND applicant_id = ? AND voter_id = ?")
      .get(meetupId, applicantId, voterId),
  );
}

/* --- invite requests (participant-initiated invitations) --- */

export function createInviteRequest(meetupId: number, requesterId: string, targetId: string): InviteRequest {
  const row = db
    .query(
      "INSERT INTO invite_requests (meetup_id, requester_id, target_id, status, created_at) VALUES (?, ?, ?, 'PENDING', ?) RETURNING *",
    )
    .get(meetupId, requesterId, targetId, Date.now()) as Parameters<typeof toInviteRequest>[0];
  return toInviteRequest(row);
}

export function getInviteRequest(id: number): InviteRequest | null {
  const row = db.query("SELECT * FROM invite_requests WHERE id = ?").get(id) as
    | Parameters<typeof toInviteRequest>[0]
    | null;
  return row ? toInviteRequest(row) : null;
}

export function decideInviteRequest(id: number, status: InviteRequestStatus, decidedBy: string): void {
  db.query("UPDATE invite_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(
    status,
    decidedBy,
    Date.now(),
    id,
  );
}

export function listPendingInviteRequests(meetupId: number): InviteRequest[] {
  const rows = db
    .query("SELECT * FROM invite_requests WHERE meetup_id = ? AND status = 'PENDING' ORDER BY created_at ASC")
    .all(meetupId) as Parameters<typeof toInviteRequest>[0][];
  return rows.map(toInviteRequest);
}

/* --- reminders --- */

export function scheduleReminders(meetupId: number, startAt: number, now = Date.now()): void {
  for (const offset of config.reminderOffsets) {
    const remindAt = startAt - offset.seconds * 1000;
    if (remindAt <= now) continue;
    db.query("INSERT OR IGNORE INTO reminders (meetup_id, kind, remind_at) VALUES (?, ?, ?)").run(
      meetupId,
      offset.kind,
      remindAt,
    );
  }
}

export function dueReminders(now = Date.now()): Reminder[] {
  const rows = db
    .query("SELECT * FROM reminders WHERE sent_at IS NULL AND remind_at <= ? ORDER BY remind_at ASC")
    .all(now) as Parameters<typeof toReminder>[0][];
  return rows.map(toReminder);
}

export function markReminderSent(meetupId: number, kind: string): void {
  db.query("UPDATE reminders SET sent_at = ? WHERE meetup_id = ? AND kind = ?").run(Date.now(), meetupId, kind);
}

export function deleteReminders(meetupId: number): void {
  db.query("DELETE FROM reminders WHERE meetup_id = ?").run(meetupId);
}

/* --- lifecycle --- */

export interface TransitionResult {
  meetup: Meetup;
  changed: boolean;
}

export function archiveMeetup(meetup: Meetup): Meetup {
  setMeetupState(meetup.id, "ARCHIVED");
  deleteReminders(meetup.id);
  return getMeetup(meetup.id)!;
}

export function cancelMeetup(meetup: Meetup): Meetup {
  setMeetupState(meetup.id, "CANCELLED");
  deleteReminders(meetup.id);
  return getMeetup(meetup.id)!;
}

export function approveParticipant(meetup: Meetup, userId: string, approvedBy: string): Participant {
  return setParticipantState(meetup.id, userId, "APPROVED", { approvedBy });
}

export function rejectParticipant(meetupId: number, userId: string): Participant {
  return setParticipantState(meetupId, userId, "REJECTED");
}
