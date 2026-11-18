import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-apply-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { findButton, findSelectMenu, getSubcommands } = await import("../src/core/registry.ts");
const {
  applicationComponents,
  applicationDenial,
  applicationEmbed,
  applyConfirmComponents,
  applyConfirmEmbed,
  joinableMeetups,
  submitApplication,
} = await import("../src/features/apply.ts");
const { applyButtonRow } = await import("../src/core/views.ts");
const { createMeetup, getParticipant, setParticipantState, updateMeetup } = await import(
  "../src/core/meetup.ts"
);
type CreateMeetupInput = Parameters<typeof createMeetup>[0];

function newMeetup(overrides: Partial<CreateMeetupInput> = {}) {
  return createMeetup({
    guildId: "guild",
    hostId: "host",
    name: "テストmeetup",
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

  // The slash entry point opens a browse-namespace picker/confirmation UI.
  expect(findSelectMenu("browse:apply-pick:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("browse:apply-list:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("browse:apply-prev:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("browse:apply-next:abc123")?.args).toEqual(["abc123"]);
});

test("apply confirmation panel keeps the meeting place private", () => {
  const meetup = newMeetup({ meetingPlace: "秘密の場所" });
  const embed = applyConfirmEmbed(meetup).toJSON();

  expect(embed.title).toBe(`参加確認: ${meetup.name}`);
  expect(embed.description).toContain("このMeetUpへ参加します。");
  expect(embed.description).not.toContain("秘密の場所");
  expect(embed.footer?.text).toBe(`MeetUp ID: ${meetup.id}`);

  const ids = (rows: { toJSON(): { components: unknown[] } }[], key = "custom_id") =>
    rows.flatMap((row) =>
      row
        .toJSON()
        .components.map((component) =>
          key in (component as Record<string, unknown>)
            ? String((component as { custom_id: string }).custom_id)
            : "",
        ),
    );

  const idsWithoutBack = ids(applyConfirmComponents(meetup));
  expect(idsWithoutBack).toContain(`apply:start:${meetup.id}`);
  expect(idsWithoutBack).toContain(`browse:show:${meetup.id}`);
  expect(idsWithoutBack).not.toContain("browse:apply-list:sess");

  const idsWithBack = ids(applyConfirmComponents(meetup, "sess"));
  expect(idsWithBack).toContain("browse:apply-list:sess");
});

test("joinable list holds public meetups and invited private meetups only", () => {
  const guildId = "g-joinable";
  const publicMeetup = newMeetup({ guildId });
  const privateMeetup = newMeetup({ guildId, mode: "PRIVATE" });
  const invited = newMeetup({ guildId, mode: "PRIVATE" });
  setParticipantState(invited.id, "u-join", "DECLINED", { invitedBy: "host" });
  const cancelled = newMeetup({ guildId });
  updateMeetup(cancelled.id, { state: "ARCHIVED" });

  const ids = joinableMeetups(guildId, "u-join")
    .map((meetup) => meetup.id)
    .sort((a, b) => a - b);
  expect(ids).toEqual([publicMeetup.id, invited.id].sort((a, b) => a - b));

  setParticipantState(publicMeetup.id, "u-join", "APPROVED", { approvedBy: "host" });
  expect(joinableMeetups(guildId, "u-join").map((meetup) => meetup.id)).not.toContain(publicMeetup.id);
  expect(joinableMeetups(guildId, "u-join").map((meetup) => meetup.id)).not.toContain(privateMeetup.id);
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

  const unlimited = newMeetup({ capacity: 0 });
  const unlimitedEmbed = applicationEmbed(unlimited, "u3", 5, 0, Date.now()).toJSON();
  expect(unlimitedEmbed.description).not.toContain("定員に達しています");
  expect(unlimitedEmbed.fields?.some((field) => field.name === "定員" && field.value.includes("定員なし"))).toBe(
    true,
  );

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

test("kicked participants cannot re-apply", () => {
  const meetup = newMeetup();
  setParticipantState(meetup.id, "kicked-user", "KICKED");
  expect(applicationDenial(meetup, "kicked-user")).toBe("このMeetUpからは退出させられています");
});

test("direct-join meetups approve the applicant immediately", async () => {
  const meetup = newMeetup({ approvalMode: "DIRECT" });
  updateMeetup(meetup.id, { channelId: "chan-direct" });

  const sent: unknown[] = [];
  const channel = {
    id: "chan-direct",
    type: ChannelType.GuildText,
    send: async (payload: unknown) => {
      sent.push(payload);
    },
    permissionOverwrites: {
      cache: new Map(),
      edit: async () => undefined,
      delete: async () => undefined,
    },
  };
  const guild = {
    id: "guild",
    client: { user: { id: "bot" } },
    roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" } },
    channels: { fetch: async (id: string) => (id === "chan-direct" ? channel : null) },
  };
  const replies: unknown[] = [];
  const interaction = {
    guild,
    user: { id: "u-direct" },
    client: {},
    deferred: false,
    replied: false,
    deferReply: async () => {
      interaction.deferred = true;
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    editReply: async (payload: unknown) => {
      replies.push(payload);
    },
    followUp: async (payload: unknown) => {
      replies.push(payload);
    },
  };

  await submitApplication(interaction as never, meetup.id);

  expect(getParticipant(meetup.id, "u-direct")?.state).toBe("APPROVED");
  expect(JSON.stringify(sent)).toContain("参加しました");
  expect(JSON.stringify(replies)).toContain("参加しました");
});

test("recruitment button label follows the join mode", () => {
  const direct = applyButtonRow(newMeetup({ approvalMode: "DIRECT" })).toJSON();
  expect(JSON.stringify(direct)).toContain("参加する");
  expect(JSON.stringify(direct)).not.toContain("参加申請");

  const approval = applyButtonRow(newMeetup({ approvalMode: "HOST" })).toJSON();
  expect(JSON.stringify(approval)).toContain("参加申請");
});
