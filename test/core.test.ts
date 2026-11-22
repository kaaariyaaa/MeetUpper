import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const {
  createMeetup,
  getMeetup,
  setParticipantState,
  countApproved,
  addVote,
  countVotes,
  archiveMeetup,
  updateMeetup,
} = await import("../src/core/meetup.ts");
const { parseDateTime } = await import("../src/core/time.ts");

test("parseDateTime reads JST wall-clock time as UTC", () => {
  expect(parseDateTime("2026-12-01 19:00")).toBe(Date.UTC(2026, 11, 1, 10, 0));
  expect(parseDateTime("2026-12-01T10:00:00Z")).toBe(Date.UTC(2026, 11, 1, 10, 0));
  expect(parseDateTime("2026-12-01")).toBe(Date.UTC(2026, 10, 30, 15, 0));
  expect(parseDateTime("not a date")).toBeNull();
});

test("participant states, votes and reminders", () => {
  const meetup = createMeetup({
    guildId: "1",
    hostId: "host",
    name: "東京meetup",
    description: "test",
    capacity: 3,
    startAt: Date.now() + 48 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "VOTE",
    requiredVotes: 2,
    eventEnabled: false,
  });

  expect(getMeetup(meetup.id)?.name).toBe("東京meetup");
  expect(countApproved(meetup.id)).toBe(0);

  setParticipantState(meetup.id, "u1", "APPROVED", { approvedBy: "host" });
  setParticipantState(meetup.id, "u2", "APPLIED");
  expect(countApproved(meetup.id)).toBe(1);

  expect(addVote(meetup.id, "u2", "u1")).toBe(1);
  expect(addVote(meetup.id, "u2", "u1")).toBe(1);
  expect(addVote(meetup.id, "u2", "u3")).toBe(2);
  expect(countVotes(meetup.id, "u2")).toBe(2);

  // A re-application starts with zero votes, and a former participant loses their vote.
  setParticipantState(meetup.id, "u2", "APPLIED");
  addVote(meetup.id, "u2", "u1");
  expect(countVotes(meetup.id, "u2")).toBe(1);
  setParticipantState(meetup.id, "u2", "DECLINED");
  setParticipantState(meetup.id, "u2", "APPLIED");
  expect(countVotes(meetup.id, "u2")).toBe(0);
  addVote(meetup.id, "u2", "u1");
  setParticipantState(meetup.id, "u1", "CANCELLED");
  expect(countVotes(meetup.id, "u2")).toBe(0);

  const updated = updateMeetup(meetup.id, {
    capacity: 5,
    startAt: meetup.startAt! + 60 * 60 * 1000,
    name: "東京MeetUp（変更後）",
  });
  expect(updated?.capacity).toBe(5);
  expect(updated?.name).toBe("東京MeetUp（変更後）");
  expect(updated?.startAt).toBe(meetup.startAt! + 60 * 60 * 1000);

  archiveMeetup(meetup);
  expect(getMeetup(meetup.id)?.state).toBe("ARCHIVED");
});
