import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-invite-test-${process.pid}-${Date.now()}.db`);

const { getSubcommands, findButton } = await import("../src/core/registry.ts");
const { createMeetup } = await import("../src/core/meetup.ts");
const { inviteEmbed } = await import("../src/features/invite.ts");

function inviteSubcommand() {
  return getSubcommands().find((entry) => entry.name === "invite");
}

test("invite registers its subcommand with required options", () => {
  const entry = inviteSubcommand();
  expect(entry).toBeDefined();
  expect(entry?.builder.name).toBe("invite");

  const json = entry!.builder.toJSON();
  const options = json.options ?? [];
  const meetup = options.find((option) => option.name === "meetup");
  const user = options.find((option) => option.name === "user");
  expect(meetup?.required).toBe(true);
  expect(user?.required).toBe(true);
});

test("invite buttons route with exact custom IDs", () => {
  expect(findButton("invite:accept:42")?.args).toEqual(["42"]);
  expect(findButton("invite:decline:42")?.args).toEqual(["42"]);
  expect(findButton("invite:approve:7")?.args).toEqual(["7"]);
  expect(findButton("invite:reject:7")?.args).toEqual(["7"]);

  expect(findButton("invite:accept:abc")).toBeUndefined();
  expect(findButton("invite:accept")).toBeUndefined();
  expect(findButton("other:accept:42")).toBeUndefined();
  expect(findButton("invite:unknown:42")).toBeUndefined();
});

test("invite embed hides the meeting place and shows the inviter", () => {
  const meetup = createMeetup({
    guildId: "guild",
    hostId: "host",
    name: "秘密のオフ会",
    description: "test",
    capacity: 4,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: "極秘の集合場所",
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });

  const json = JSON.stringify(inviteEmbed(meetup, "inviter").toJSON());
  expect(json).not.toContain("極秘の集合場所");
  expect(json).not.toContain("集合場所");
  expect(json).toContain("<@inviter>");
  expect(json).toContain("招待されています");
});
