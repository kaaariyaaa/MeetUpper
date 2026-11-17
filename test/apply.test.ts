import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-apply-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { findButton, getSubcommands } = await import("../src/core/registry.ts");
const { applicationComponents, applicationDenial, applicationEmbed } = await import(
  "../src/features/apply.ts"
);
const { createMeetup, setParticipantState } = await import("../src/core/meetup.ts");
type CreateMeetupInput = Parameters<typeof createMeetup>[0];

function newMeetup(overrides: Partial<CreateMeetupInput> = {}) {
  return createMeetup({
    guildId: "guild",
    hostId: "host",
    name: "テストオフ会",
    description: "test",
    capacity: 2,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: "秘密の場所",
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
    ...overrides,
  });
}

test("apply subcommand and button ids are registered in the apply namespace", () => {
  expect(getSubcommands().some((entry) => entry.name === "apply")).toBe(true);

  expect(findButton("apply:start:42")?.args).toEqual(["42"]);
  expect(findButton("apply:approve:42:7")?.args).toEqual(["42", "7"]);
  expect(findButton("apply:reject:42:7")?.args).toEqual(["42", "7"]);
  expect(findButton("apply:vote:42:7")?.args).toEqual(["42", "7"]);
  expect(findButton("apply:unknown:42:7")).toBeUndefined();
});

test("public applications follow participant state rules", () => {
  const meetup = newMeetup();

  expect(applicationDenial(meetup, "host")).toBe("主催者側は参加申請できません");
  expect(applicationDenial(meetup, "u1")).toBeNull();

  setParticipantState(meetup.id, "u1", "APPLIED");
  expect(applicationDenial(meetup, "u1")).toBe("既に申請中です");

  setParticipantState(meetup.id, "u1", "APPROVED", { approvedBy: "host" });
  expect(applicationDenial(meetup, "u1")).toBe("既に参加確定しています");

  setParticipantState(meetup.id, "u1", "REJECTED");
  expect(applicationDenial(meetup, "u1")).toBe("参加申請は却下されています");

  setParticipantState(meetup.id, "u1", "INVITED", { invitedBy: "host" });
  expect(applicationDenial(meetup, "u1")).toBe("招待DMから参加してください");
});

test("private applications require a prior invitation", () => {
  const meetup = newMeetup({ mode: "PRIVATE" });

  expect(applicationDenial(meetup, "stranger")).toBe("招待されたユーザーのみ参加申請できます");

  setParticipantState(meetup.id, "declined", "DECLINED", { invitedBy: "host" });
  expect(applicationDenial(meetup, "declined")).toBeNull();
});

test("application panel exposes capacity, approval mode and buttons", () => {
  const hostMeetup = newMeetup({ capacity: 2 });
  const embed = applicationEmbed(hostMeetup, "u1", 2, 0, Date.now()).toJSON();

  expect(embed.title).toBe("参加申請");
  expect(embed.description).toContain("<@u1>");
  expect(embed.description).toContain("定員に達しています");
  expect(embed.fields?.some((field) => field.name === "定員" && field.value.includes("2人"))).toBe(
    true,
  );

  const hostRow = applicationComponents(hostMeetup, "u1")[0]?.toJSON();
  expect(hostRow?.components.map((component) => ("custom_id" in component ? component.custom_id : undefined))).toEqual([
    `apply:approve:${hostMeetup.id}:u1`,
    `apply:reject:${hostMeetup.id}:u1`,
  ]);

  const voteMeetup = newMeetup({ approvalMode: "VOTE", requiredVotes: 2 });
  const voteEmbed = applicationEmbed(voteMeetup, "u2", 0, 0, Date.now()).toJSON();
  expect(voteEmbed.fields?.some((field) => field.value.includes("必要票数 2 / 現在 0票"))).toBe(
    true,
  );
  const voteRow = applicationComponents(voteMeetup, "u2")[0]?.toJSON();
  expect(voteRow?.components.map((component) => ("custom_id" in component ? component.custom_id : undefined))).toEqual([
    `apply:vote:${voteMeetup.id}:u2`,
    `apply:reject:${voteMeetup.id}:u2`,
  ]);
});
