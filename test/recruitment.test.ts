import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";

process.env.DB_PATH = join(tmpdir(), `meetupper-recruitment-${process.pid}-${Date.now()}.db`);
const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const {
  createMeetup,
  isRecruitmentClosed,
  listRecruitmentsToClose,
  updateMeetup,
} = await import("../src/core/meetup.ts");
const { tickReminders } = await import("../src/core/reminderEngine.ts");

function makeMeetup(options: { startAt: number; threadId?: string }) {
  const meetup = createMeetup({
    guildId: "g-recruit",
    hostId: "host",
    name: "募集クローズテスト",
    description: "",
    capacity: 0,
    startAt: options.startAt,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  if (options.threadId) updateMeetup(meetup.id, { forumThreadId: options.threadId });
  return meetup;
}

function fakeClient(thread: Record<string, unknown> | null, counter: { count: number }): Client {
  const channelThread = thread
    ? {
        ...thread,
        isThread: () => true,
        setLocked: async (value: boolean) => {
          counter.count += 1;
          (thread as { locked?: boolean }).locked = value;
        },
        setArchived: async (value: boolean) => {
          counter.count += 1;
          (thread as { archived?: boolean }).archived = value;
        },
      }
    : null;
  const guild = {
    id: "g-recruit",
    channels: { fetch: async (id: string) => (id === "thread-1" ? channelThread : null) },
  };
  return {
    isReady: () => true,
    guilds: { cache: new Map([["g-recruit", guild]]) },
  } as unknown as Client;
}

test("started Public recruitment is closed and locked exactly once", async () => {
  const meetup = makeMeetup({ startAt: Date.now() - 60_000, threadId: "thread-1" });
  const thread: { locked?: boolean; archived?: boolean } = {};
  const counter = { count: 0 };

  await tickReminders(fakeClient(thread, counter), Date.now());
  expect(thread.locked).toBe(true);
  expect(thread.archived).toBe(true);
  expect(counter.count).toBe(2);
  expect(isRecruitmentClosed(meetup.id)).toBe(true);

  await tickReminders(fakeClient(thread, counter), Date.now());
  expect(counter.count).toBe(2);
});

test("future Public recruitment stays open until its start time", async () => {
  makeMeetup({ startAt: Date.now() + 60 * 60 * 1000, threadId: "thread-1" });
  const thread: { locked?: boolean } = {};
  const counter = { count: 0 };

  await tickReminders(fakeClient(thread, counter), Date.now());
  expect(thread.locked).toBeUndefined();
  expect(counter.count).toBe(0);
  expect(listRecruitmentsToClose(Date.now()).length).toBe(0);
});

test("cancelled Public recruitment is queued for closure even before the start time", () => {
  const meetup = makeMeetup({ startAt: Date.now() + 60 * 60 * 1000, threadId: "thread-1" });
  db.query("UPDATE meetups SET state = 'CANCELLED' WHERE id = ?").run(meetup.id);
  const queued = listRecruitmentsToClose(Date.now()).map((item) => item.id);
  expect(queued).toContain(meetup.id);
});
