import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ButtonInteraction } from "discord.js";

process.env.DB_PATH ??= join(tmpdir(), `meetupper-recovery-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { findButton } = await import("../src/core/registry.ts");
await import("../src/features/recovery.ts");
const { addCohost, createMeetup, getMeetup, setParticipantState, updateMeetup } = await import(
  "../src/core/meetup.ts"
);

function newMeetup(name: string) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name,
    description: "test",
    capacity: 5,
    startAt: Date.now() + 48 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: "秘密の集合場所",
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId: `chan-${meetup.id}` });
  return getMeetup(meetup.id)!;
}

/** Minimal button interaction: guild present, no channel access, DMs always fail. */
function fakeInteraction(userId: string) {
  const updated: Record<string, unknown>[] = [];
  const replies: Record<string, unknown>[] = [];
  const dms: string[] = [];
  const interaction = {
    guild: { id: "g1", channels: { fetch: async () => null } },
    user: { id: userId },
    client: {
      users: {
        fetch: async (id: string) => {
          dms.push(id);
          throw new Error("DM不可");
        },
      },
    },
    deferred: false,
    replied: false,
    reply: async (payload: Record<string, unknown>) => {
      replies.push(payload);
    },
    followUp: async (payload: Record<string, unknown>) => {
      replies.push(payload);
    },
    update: async (payload: Record<string, unknown>) => {
      updated.push(payload);
    },
  };
  return { interaction: interaction as unknown as ButtonInteraction, updated, replies, dms };
}

test("recover:cancel cancels the meetup, notifies and hides the meeting place", async () => {
  const meetup = newMeetup("東京オフ会");
  setParticipantState(meetup.id, "u1", "APPROVED");

  const routed = findButton(`recover:cancel:${meetup.id}`);
  expect(routed).toBeDefined();
  const { interaction, updated, replies, dms } = fakeInteraction("host");
  await routed!.handler(interaction, routed!.args);

  expect(getMeetup(meetup.id)?.state).toBe("CANCELLED");
  expect(updated).toHaveLength(1);
  expect(updated[0]?.content).toBe("オフ会を中止しました");
  expect(updated[0]?.components).toEqual([]);
  expect(dms).toEqual(["u1"]);
  expect(JSON.stringify(replies)).not.toContain("秘密の集合場所");
});

test("recover:cancel rejects non-managers and non-ACTIVE meetups", async () => {
  const meetup = newMeetup("大阪オフ会");

  const guest = fakeInteraction("someone");
  await findButton(`recover:cancel:${meetup.id}`)!.handler(guest.interaction, [`${meetup.id}`]);
  expect(guest.replies[0]?.content).toContain("主催者");
  expect(getMeetup(meetup.id)?.state).toBe("ACTIVE");

  addCohost(meetup.id, "co");
  const cohost = fakeInteraction("co");
  await findButton(`recover:cancel:${meetup.id}`)!.handler(cohost.interaction, [`${meetup.id}`]);
  expect(getMeetup(meetup.id)?.state).toBe("CANCELLED");

  const again = fakeInteraction("host");
  await findButton(`recover:cancel:${meetup.id}`)!.handler(again.interaction, [`${meetup.id}`]);
  expect(again.replies[0]?.content).toContain("CANCELLED");
});

test("recover:keep keeps ACTIVE and clears the buttons", async () => {
  const meetup = newMeetup("名古屋オフ会");
  addCohost(meetup.id, "co");

  const { interaction, updated } = fakeInteraction("co");
  await findButton(`recover:keep:${meetup.id}`)!.handler(interaction, [`${meetup.id}`]);

  expect(getMeetup(meetup.id)?.state).toBe("ACTIVE");
  expect(updated[0]?.content).toContain("ACTIVEを維持します");
  expect(updated[0]?.components).toEqual([]);
});
