import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";

process.env.DB_PATH = join(tmpdir(), `meetupper-participation-${process.pid}-${Date.now()}.db`);
const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const { createMeetup, updateMeetup } = await import("../src/core/meetup.ts");
const {
  listParticipationMessages,
  recordParticipationMessage,
  sweepParticipationMessages,
} = await import("../src/core/participation.ts");

function makeMeetup() {
  const meetup = createMeetup({
    guildId: "g-part",
    hostId: "host",
    name: "参加導線テスト",
    description: "",
    capacity: 0,
    startAt: Date.now() - 60_000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId: null });
  return meetup;
}

function fakeChannel(id: string, edits: Record<string, unknown>[]) {
  const message = {
    id: `msg-${id}`,
    content: "",
    embeds: [],
    edit: async (payload: Record<string, unknown>) => {
      edits.push({ channel: id, ...payload });
    },
  };
  return {
    id,
    isTextBased: () => true,
    messages: { fetch: async () => message },
  };
}

test("a transient channel failure keeps the row and does not stop other rows", async () => {
  const meetup = makeMeetup();
  recordParticipationMessage(meetup.id, "invite", "chan-a", "msg-chan-a");
  recordParticipationMessage(meetup.id, "invite", "chan-b", "msg-chan-b");

  const edits: Record<string, unknown>[] = [];
  let failA = true;
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (id === "chan-a" && failA) throw new Error("network error");
        return fakeChannel(id, edits);
      },
    },
  } as unknown as Client;

  await sweepParticipationMessages(client, Date.now());
  const remaining = listParticipationMessages(meetup.id);
  expect(remaining.map((row) => row.channelId)).toEqual(["chan-a"]);
  expect(edits.some((edit) => edit.channel === "chan-b")).toBe(true);

  failA = false;
  await sweepParticipationMessages(client, Date.now());
  expect(listParticipationMessages(meetup.id)).toEqual([]);
  expect(edits.some((edit) => edit.channel === "chan-a" && edit.components !== undefined)).toBe(true);
});
