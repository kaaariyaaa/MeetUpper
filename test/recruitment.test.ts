import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedBuilder, type Client } from "discord.js";

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
const { listParticipationMessages, recordParticipationMessage } = await import(
  "../src/core/participation.ts"
);

function makeMeetup(options: { startAt: number; threadId?: string; mode?: "PUBLIC" | "PRIVATE" }) {
  const meetup = createMeetup({
    guildId: "g-recruit",
    hostId: "host",
    name: "募集クローズテスト",
    description: "",
    capacity: 0,
    startAt: options.startAt,
    meetingAt: null,
    meetingPlace: null,
    mode: options.mode ?? "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  if (options.threadId) updateMeetup(meetup.id, { forumThreadId: options.threadId });
  return meetup;
}

function fakeClient(
  thread: Record<string, unknown> | null,
  counter: { count: number },
  participationChannels: Record<string, unknown> = {},
): Client {
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
    channels: { fetch: async (id: string) => participationChannels[id] ?? null },
    guilds: { cache: new Map([["g-recruit", guild]]) },
  } as unknown as Client;
}

/** A text channel holding one participation message; `edits` records every edit attempt. */
function participationChannel(edit: (payload: ParticipationPayload) => Promise<void>) {
  const message = {
    embeds: [new EmbedBuilder().setTitle("募集")],
    content: "",
    edit,
  };
  return { isTextBased: () => true, messages: { fetch: async () => message } };
}

interface ParticipationPayload {
  content?: string | null;
  components?: unknown[];
  embeds?: { toJSON: () => { fields?: { name: string; value: string }[] } }[];
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

test("started Public and Private participation messages lose their components and get 募集状況", async () => {
  const publicMeetup = makeMeetup({ startAt: Date.now() - 60_000 });
  const privateMeetup = makeMeetup({ startAt: Date.now() - 60_000, mode: "PRIVATE" });
  recordParticipationMessage(publicMeetup.id, "application", "part-public", "msg-public");
  recordParticipationMessage(privateMeetup.id, "invite", "part-private", "msg-private");

  const publicEdits: ParticipationPayload[] = [];
  const privateEdits: ParticipationPayload[] = [];
  const client = fakeClient(null, { count: 0 }, {
    "part-public": participationChannel(async (payload) => {
      publicEdits.push(payload);
    }),
    "part-private": participationChannel(async (payload) => {
      privateEdits.push(payload);
    }),
  });

  await tickReminders(client, Date.now());

  for (const [edits, meetupId] of [
    [publicEdits, publicMeetup.id],
    [privateEdits, privateMeetup.id],
  ] as const) {
    expect(edits).toHaveLength(1);
    expect(edits[0]?.components).toEqual([]);
    const fields = edits[0]?.embeds?.[0]?.toJSON().fields ?? [];
    expect(fields).toContainEqual({ name: "募集状況", value: "募集は終了しました" });
    expect(listParticipationMessages(meetupId)).toHaveLength(0);
  }
});

test("a participation message whose edit fails keeps its row for retry", async () => {
  const meetup = makeMeetup({ startAt: Date.now() - 60_000 });
  recordParticipationMessage(meetup.id, "application", "part-fail", "msg-fail");

  const client = fakeClient(null, { count: 0 }, {
    "part-fail": participationChannel(async () => {
      throw new Error("edit failed");
    }),
  });

  await tickReminders(client, Date.now());

  expect(listParticipationMessages(meetup.id).map((entry) => entry.messageId)).toEqual(["msg-fail"]);
});


test("started recruitment edit removes the apply button and adds 募集状況", async () => {
  const meetup = makeMeetup({ startAt: Date.now() - 60_000, threadId: "thread-1" });
  const edits: { components?: unknown[]; embeds?: unknown[]; content?: string }[] = [];
  const starter = {
    content: "",
    embeds: [],
    edit: async (payload: { components?: unknown[]; embeds?: unknown[]; content?: string }) => {
      edits.push(payload);
    },
  };
  const thread = {
    locked: false,
    archived: false,
    isThread: () => true,
    fetchStarterMessage: async () => starter,
    setLocked: async (value: boolean) => {
      thread.locked = value;
    },
    setArchived: async (value: boolean) => {
      thread.archived = value;
    },
  };
  const guild = {
    id: "g-recruit",
    channels: { fetch: async (id: string) => (id === "thread-1" ? thread : null) },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([["g-recruit", guild]]) },
  } as unknown as Client;

  await tickReminders(client, Date.now());
  expect(edits.length).toBe(1);
  expect(edits[0]?.components).toEqual([]);
  expect(edits[0]?.content).toContain("募集は終了しました");
  expect(isRecruitmentClosed(meetup.id)).toBe(true);
});
