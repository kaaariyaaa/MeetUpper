export type MeetupMode = "PUBLIC" | "PRIVATE";
export type ApprovalMode = "DIRECT" | "HOST" | "VOTE";
export type MeetupState = "ACTIVE" | "ARCHIVED" | "CANCELLED";

export type ParticipantState =
  | "INVITED"
  | "APPLIED"
  | "APPROVED"
  | "DECLINED"
  | "REJECTED"
  | "CANCELLED"
  | "KICKED";

export interface Meetup {
  id: number;
  guildId: string;
  hostId: string;
  name: string;
  description: string;
  /** 0 means no limit. */
  capacity: number;
  /** Epoch ms (UTC). */
  startAt: number;
  /** Epoch ms (UTC), separate from startAt. */
  meetingAt: number | null;
  meetingPlace: string | null;
  mode: MeetupMode;
  approvalMode: ApprovalMode;
  requiredVotes: number;
  eventEnabled: boolean;
  state: MeetupState;
  channelId: string | null;
  forumThreadId: string | null;
  eventId: string | null;
  createdAt: number;
}

export interface Participant {
  meetupId: number;
  userId: string;
  state: ParticipantState;
  invitedBy: string | null;
  invitedAt: number | null;
  appliedAt: number | null;
  approvedBy: string | null;
  approvedAt: number | null;
  updatedAt: number;
}

export type InviteRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface InviteRequest {
  id: number;
  meetupId: number;
  requesterId: string;
  targetId: string;
  status: InviteRequestStatus;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
}

export type ReminderStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
export type ReminderHistoryStatus = "SENT" | "FAILED" | "SKIPPED";
export type FailureDmStatus = "PENDING" | "SENT" | "PARTIAL" | "FAILED" | "SKIPPED";
export type FailureChannelStatus = "PENDING" | "SENT" | "EXPIRED" | "SKIPPED";

export interface ReminderSettings {
  meetupId: number;
  enabled: boolean;
  version: number;
  updatedAt: number;
}

export interface ReminderSchedule {
  id: number;
  meetupId: number;
  baseAt: number;
  offsetSeconds: number;
  scheduledAt: number;
  status: ReminderStatus;
  attempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  skipReason: string | null;
  claimedAt: number | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReminderHistory {
  id: number;
  meetupId: number;
  scheduleId: number | null;
  baseAt: number;
  offsetSeconds: number;
  scheduledAt: number;
  sentAt: number | null;
  status: ReminderHistoryStatus;
  reason: string | null;
  createdAt: number;
}

export interface ReminderFailure {
  id: number;
  meetupId: number;
  scheduleId: number;
  scheduledAt: number;
  failedAt: number;
  dmSent: number;
  dmFailed: number;
  dmStatus: FailureDmStatus;
  channelStatus: FailureChannelStatus;
  error: string | null;
  channelError: string | null;
  warningDeadline: number;
  createdAt: number;
  updatedAt: number;
}
