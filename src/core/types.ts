export type MeetupMode = "PUBLIC" | "PRIVATE";
export type ApprovalMode = "HOST" | "VOTE";
export type MeetupState = "ACTIVE" | "ARCHIVED" | "CANCELLED";

export type ParticipantState =
  | "INVITED"
  | "APPLIED"
  | "APPROVED"
  | "DECLINED"
  | "REJECTED"
  | "CANCELLED";

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

export interface Reminder {
  meetupId: number;
  kind: string;
  remindAt: number;
  sentAt: number | null;
}
