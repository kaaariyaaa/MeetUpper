import { expect, test } from "bun:test";
import { GuildScheduledEventStatus } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH ??= join(tmpdir(), `meetupper-events-test-${process.pid}-${Date.now()}.db`);

const { createMeetup } = await import("../src/core/meetup.ts");
const { cancelEvent } = await import("../src/core/events.ts");

function makeMeetup(eventId: string | null) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "イベントテスト",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: true,
  });
  return { ...meetup, eventId };
}

test("cancelEvent marks the event cancelled instead of deleting it", async () => {
  const calls: string[] = [];
  const event = {
    status: GuildScheduledEventStatus.Scheduled,
    setStatus: async (status: number) => {
      calls.push(`set:${status}`);
    },
    delete: async () => {
      calls.push("delete");
    },
  };
  const guild = { scheduledEvents: { fetch: async () => event } };
  await cancelEvent(guild as never, makeMeetup("event-1") as never);
  expect(calls).toEqual([`set:${GuildScheduledEventStatus.Canceled}`]);
});

test("cancelEvent is a no-op without an event and skips already cancelled events", async () => {
  const calls: string[] = [];
  const event = {
    status: GuildScheduledEventStatus.Canceled,
    setStatus: async () => {
      calls.push("set");
    },
    delete: async () => {
      calls.push("delete");
    },
  };
  const guild = { scheduledEvents: { fetch: async () => event } };
  await cancelEvent(guild as never, makeMeetup(null) as never);
  await cancelEvent(guild as never, makeMeetup("event-1") as never);
  expect(calls).toEqual([]);
});
