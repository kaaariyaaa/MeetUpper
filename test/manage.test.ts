import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-manage-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { findButton, getSubcommands } = await import("../src/core/registry.ts");
const { createMeetup, updateMeetup } = await import("../src/core/meetup.ts");
await import("../src/features/manage.ts");

test("manage registers its subcommands", () => {
  const names = getSubcommands().map((entry) => entry.name);
  for (const name of ["info", "leave", "members", "cohost", "host", "archive", "cancel"]) {
    expect(names).toContain(name);
  }
});

test("manage buttons route their meetup id", () => {
  expect(findButton("manage:confirm-archive:12")?.args).toEqual(["12"]);
  expect(findButton("manage:confirm-cancel:34")?.args).toEqual(["34"]);
  expect(findButton("manage:abort")?.args).toEqual([]);
  expect(findButton("manage:confirm-archive:abc")).toBeUndefined();
});

function makeMeetup(channelId: string) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "テスト",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId });
}

function fakeInteraction(channelId: string | null, meetupId: number | null) {
  const calls: unknown[] = [];
  const interaction = {
    guild: { id: "g1" },
    channel: null,
    channelId,
    user: { id: "host" },
    deferred: false,
    replied: false,
    options: { getInteger: () => meetupId },
    reply: async (payload: unknown) => calls.push(payload),
    editReply: async (payload: unknown) => calls.push(payload),
    followUp: async (payload: unknown) => calls.push(payload),
    deferReply: async () => {
      interaction.deferred = true;
    },
  };
  return { interaction, calls };
}

test("cancel resolves the meetup from its dedicated channel when the id is omitted", async () => {
  makeMeetup("meetup-231-test");
  const cancel = getSubcommands().find((entry) => entry.name === "cancel")!;

  const { interaction, calls } = fakeInteraction("meetup-231-test", null);
  await cancel.execute(interaction as never);

  expect(JSON.stringify(calls)).toContain("manage:confirm-cancel");
});

test("cancel asks for an id outside the meetup channel", async () => {
  makeMeetup("meetup-232-test");
  const cancel = getSubcommands().find((entry) => entry.name === "cancel")!;

  const { interaction, calls } = fakeInteraction("other-channel", null);
  await cancel.execute(interaction as never);

  expect(JSON.stringify(calls)).toContain("専用チャンネル");
});
