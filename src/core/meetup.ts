import { db, toMeetup, toParticipant, toInviteRequest } from "../db.ts";
import type {
  ApprovalMode,
  InviteRequest,
  InviteRequestStatus,
  Meetup,
  MeetupMode,
  MeetupState,
  Participant,
  ParticipantState,
} from "./types.ts";
import { initReminderSettings, stopRemindersForMeetup } from "./reminders.ts";

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
  /** Automatic reminders are enabled unless explicitly disabled. */
  reminderEnabled?: boolean;
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
  const meetup = toMeetup(row);
  initReminderSettings(meetup.id, input.reminderEnabled ?? true);
  return meetup;
}

/** New/changed meeting times must be future and not later than the start time. */
export function validateMeetingTime(startAt: number, meetingAt: number | null, now = Date.now()): void {
  if (meetingAt === null) return;
  if (meetingAt > startAt) throw new Error("集合時間は開催日時より後に設定できません。");
  if (meetingAt <= now) throw new Error("集合時間には未来の日時を指定してください。");
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

/** Finds the meetup owning a dedicated channel, whatever its state (for command routing). */
export function findMeetupByChannelId(channelId: string): Meetup | null {
  const row = db.query("SELECT * FROM meetups WHERE channel_id = ? ORDER BY id DESC LIMIT 1").get(channelId) as
    | Parameters<typeof toMeetup>[0]
    | null;
  return row ? toMeetup(row) : null;
}

/** Finds the meetup owning a recruitment forum thread, whatever its state (for command routing). */
export function findMeetupByThreadId(threadId: string): Meetup | null {
  const row = db.query("SELECT * FROM meetups WHERE forum_thread_id = ? ORDER BY id DESC LIMIT 1").get(threadId) as
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
      | "approvalMode"
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
    approvalMode: "approval_mode",
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
  const invitedAt = options.invitedBy ? now : (previous?.invitedAt ?? null);

  // A new application starts from zero votes; a former participant cannot keep voting.
  if (state === "APPLIED") {
    db.query("DELETE FROM votes WHERE meetup_id = ? AND applicant_id = ?").run(meetupId, userId);
  }
  if (previous?.state === "APPROVED" && state !== "APPROVED") {
    db.query("DELETE FROM votes WHERE meetup_id = ? AND voter_id = ?").run(meetupId, userId);
  }
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

export function deleteParticipant(meetupId: number, userId: string): void {
  db.query("DELETE FROM participants WHERE meetup_id = ? AND user_id = ?").run(meetupId, userId);
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

export function decideInviteRequest(id: number, status: InviteRequestStatus, decidedBy: string): number {
  const result = db
    .query("UPDATE invite_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'")
    .run(status, decidedBy, Date.now(), id);
  return Number(result.changes);
}

export function hasPendingInviteRequest(meetupId: number, targetId: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM invite_requests WHERE meetup_id = ? AND target_id = ? AND status = 'PENDING'")
      .get(meetupId, targetId),
  );
}

export function listPendingInviteRequests(meetupId: number): InviteRequest[] {
  const rows = db
    .query("SELECT * FROM invite_requests WHERE meetup_id = ? AND status = 'PENDING' ORDER BY created_at ASC")
    .all(meetupId) as Parameters<typeof toInviteRequest>[0][];
  return rows.map(toInviteRequest);
}

/* --- recruitment closure --- */

export function markRecruitmentClosed(meetupId: number, now = Date.now()): void {
  db.query(
    "INSERT OR IGNORE INTO recruitment_closures (meetup_id, closed_at) VALUES (?, ?)",
  ).run(meetupId, now);
}

export function isRecruitmentClosed(meetupId: number): boolean {
  return Boolean(
    db.query("SELECT 1 FROM recruitment_closures WHERE meetup_id = ?").get(meetupId),
  );
}

/** Public MeetUps whose recruitment must be closed (started, cancelled or archived) and is still open. */
export function listRecruitmentsToClose(now = Date.now()): Meetup[] {
  return (
    db
      .query(
        `SELECT m.* FROM meetups m
         LEFT JOIN recruitment_closures c ON c.meetup_id = m.id
         WHERE m.mode = 'PUBLIC'
           AND m.forum_thread_id IS NOT NULL
           AND (m.state IN ('CANCELLED', 'ARCHIVED') OR m.start_at <= ?)
           AND c.meetup_id IS NULL
         ORDER BY m.start_at ASC`,
      )
      .all(now) as Parameters<typeof toMeetup>[0][]
  ).map(toMeetup);
}

/* --- lifecycle --- */

export interface TransitionResult {
  meetup: Meetup;
  changed: boolean;
}

export function archiveMeetup(meetup: Meetup): Meetup {
  setMeetupState(meetup.id, "ARCHIVED");
  stopRemindersForMeetup(meetup.id, "MeetUpがアーカイブされたため停止");
  return getMeetup(meetup.id)!;
}

export function cancelMeetup(meetup: Meetup): Meetup {
  setMeetupState(meetup.id, "CANCELLED");
  stopRemindersForMeetup(meetup.id, "MeetUpが中止されたため停止");
  return getMeetup(meetup.id)!;
}

export function approveParticipant(meetup: Meetup, userId: string, approvedBy: string): Participant {
  return setParticipantState(meetup.id, userId, "APPROVED", { approvedBy });
}

export function rejectParticipant(meetupId: number, userId: string): Participant {
  return setParticipantState(meetupId, userId, "REJECTED");
}
