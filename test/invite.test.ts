import { expect, test } from "bun:test";
import { ChannelType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-invite-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { getSubcommands, findButton, findSelectMenu } = await import("../src/core/registry.ts");
const {
  addCohost,
  createInviteRequest,
  createMeetup,
  decideInviteRequest,
  getInviteRequest,
  getParticipant,
  hasPendingInviteRequest,
  setParticipantState,
  updateMeetup,
} = await import("../src/core/meetup.ts");
const { inviteEmbed, inviteTargetDenial } = await import("../src/features/invite.ts");

function inviteSubcommand() {
  return getSubcommands().find((entry) => entry.name === "invite");
}

test("invite registers its subcommand with only an optional meetup id", () => {
  const entry = inviteSubcommand();
  expect(entry).toBeDefined();
  expect(entry?.builder.name).toBe("invite");

  const json = entry!.builder.toJSON();
  const options = json.options ?? [];
  expect(options.map((option) => option.name)).toEqual(["meetup"]);
  expect(options[0]?.required).toBeFalsy();
});

test("invite buttons route with exact custom IDs", () => {
  expect(findButton("invite:accept:42")?.args).toEqual(["42"]);
  expect(findButton("invite:decline:42")?.args).toEqual(["42"]);
  expect(findButton("invite:approve:7")?.args).toEqual(["7"]);
  expect(findButton("invite:reject:7")?.args).toEqual(["7"]);
  expect(findButton("people:invite-open:42")?.args).toEqual(["42"]);

  expect(findButton("invite:accept:abc")).toBeUndefined();
  expect(findButton("invite:accept")).toBeUndefined();
  expect(findButton("other:accept:42")).toBeUndefined();
  expect(findButton("invite:unknown:42")).toBeUndefined();
});

test("invite UI selects route in the people namespace", () => {
  expect(findSelectMenu("people:invite-meetup:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("people:invite-target:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("people:invite-confirm:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("people:invite-cancel:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("people:invite-target")).toBeUndefined();
});

test("invite eligibility rejects self, bot, host side and existing participants", () => {
  const meetup = createMeetup({
    guildId: "g-eligibility",
    hostId: "host",
    name: "招待資格",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });

  expect(inviteTargetDenial(meetup, "host", { id: "u-new" })).toBeNull();
  expect(inviteTargetDenial(meetup, "host", { id: "host" })).toContain("自分自身");
  expect(inviteTargetDenial(meetup, "host", { id: "bot", bot: true })).toContain("Bot");
  expect(inviteTargetDenial(meetup, "u-new", { id: "u-other" })).toContain("参加確定者");

  addCohost(meetup.id, "manager");
  expect(inviteTargetDenial(meetup, "manager", { id: "host" })).toContain("主催者");

  setParticipantState(meetup.id, "u-approved", "APPROVED");
  expect(inviteTargetDenial(meetup, "u-approved", { id: "u-new" })).toBeNull();
  expect(inviteTargetDenial(meetup, "host", { id: "u-approved" })).toContain("参加が確定");

  setParticipantState(meetup.id, "u-invited", "INVITED");
  expect(inviteTargetDenial(meetup, "host", { id: "u-invited" })).toContain("招待済み");

  setParticipantState(meetup.id, "u-applied", "APPLIED");
  expect(inviteTargetDenial(meetup, "host", { id: "u-applied" })).toContain("参加申請中");
});

test("invite UI sends a confirmation and delivers the invite DM", async () => {
  const meetup = createMeetup({
    guildId: "g-invite-flow",
    hostId: "host",
    name: "UI招待",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });

  const userMessages: unknown[] = [];
  const guild = {
    id: "g-invite-flow",
    client: {
      user: { id: "bot" },
      users: {
        fetch: async (id: string) => ({
          id,
          send: async (payload: unknown) => {
            userMessages.push(payload);
          },
        }),
      },
    },
    members: { me: { id: "bot" }, fetch: async () => ({}) },
    channels: { fetch: async () => null },
  };

  const replies: { payload?: Record<string, unknown> }[] = [];
  const entryInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    deferred: false,
    replied: false,
    reply: async (payload: Record<string, unknown>) => {
      replies.push({ payload });
    },
    editReply: async () => undefined,
    followUp: async () => undefined,
  };

  const open = findButton(`people:invite-open:${meetup.id}`)!;
  await open.handler(entryInteraction as never, open.args);
  const selectId = JSON.stringify(replies[0]?.payload).match(
    /people:invite-target:[0-9a-z]+/,
  )?.[0];
  expect(selectId).toBeDefined();

  const targetUser = { id: "u-target", bot: false };
  const updates: { payload?: Record<string, unknown> }[] = [];
  const selectInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: selectId,
    values: ["u-target"],
    users: { first: () => targetUser },
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const select = findSelectMenu(selectId!)!;
  await select.handler(selectInteraction as never, select.args);
  const confirmId = JSON.stringify(updates[0]?.payload).match(
    /people:invite-confirm:[0-9a-z]+/,
  )?.[0];
  expect(confirmId).toBeDefined();

  const confirmInteraction = {
    user: { id: "host" },
    guild,
    guildId: guild.id,
    client: guild.client,
    customId: confirmId,
    deferUpdate: async () => undefined,
    editReply: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updates.push({ payload });
    },
    reply: async () => undefined,
    followUp: async () => undefined,
  };
  const confirm = findButton(confirmId!)!;
  await confirm.handler(confirmInteraction as never, confirm.args);

  expect(getParticipant(meetup.id, "u-target")?.state).toBe("INVITED");
  expect(userMessages).toHaveLength(1);
  expect(JSON.stringify(updates.at(-1)?.payload)).toContain("招待DMを送信しました");
});

test("invite embed hides the meeting place and shows the inviter", () => {
  const meetup = createMeetup({
    guildId: "guild",
    hostId: "host",
    name: "秘密のmeetup",
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

test("invite request decisions are atomic and pending requests block duplicates", () => {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "招待申請テスト",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });

  const request = createInviteRequest(meetup.id, "u1", "u2");
  expect(hasPendingInviteRequest(meetup.id, "u2")).toBe(true);
  expect(decideInviteRequest(request.id, "APPROVED", "host")).toBe(1);
  expect(decideInviteRequest(request.id, "REJECTED", "host")).toBe(0);
  expect(getInviteRequest(request.id)?.status).toBe("APPROVED");
  expect(hasPendingInviteRequest(meetup.id, "u2")).toBe(false);
});

test("accepting an invite announces the new member in the meetup channel", async () => {
  const meetup = createMeetup({
    guildId: "g-invite",
    hostId: "host",
    name: "参加通知",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId: "chan-join" });
  setParticipantState(meetup.id, "u9", "INVITED", { invitedBy: "host" });

  const sent: unknown[] = [];
  const channel = {
    id: "chan-join",
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
    id: "g-invite",
    client: { user: { id: "bot" } },
    roles: { everyone: { id: "everyone" } },
    members: { me: { id: "bot" }, fetch: async () => ({ id: "u9" }) },
    channels: { fetch: async (id: string) => (id === "chan-join" ? channel : null) },
  };
  const interaction = {
    user: { id: "u9" },
    guild,
    client: { guilds: { cache: new Map([["g-invite", guild]]) } },
    channel: null,
    deferred: false,
    replied: false,
    deferUpdate: async () => undefined,
    editReply: async () => undefined,
    reply: async () => undefined,
    followUp: async () => undefined,
  };

  const accept = findButton(`invite:accept:${meetup.id}`)!;
  await accept.handler(interaction as never, accept.args);

  expect(JSON.stringify(sent)).toContain("<@u9> が参加しました");
});
