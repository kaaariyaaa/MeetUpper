import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-ops-test-${process.pid}-${Date.now()}.db`);
const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const { addCohost, createMeetup, getMeetup, getParticipant, setParticipantState } = await import(
  "../src/core/meetup.ts"
);
const { formatInZone } = await import("../src/core/time.ts");
await import("../src/features/ops.ts");
const { findButton, findModal, getSubcommands } = await import("../src/core/registry.ts");

interface Call {
  type: string;
  payload?: Record<string, unknown> & { components?: unknown[] };
}

function fakeInteraction(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const interaction: Record<string, unknown> = {
    user: { id: "host" },
    guild: { id: "g1" },
    guildId: "g1",
    deferred: false,
    replied: false,
    client: { users: { fetch: async () => ({ send: async () => undefined }) } },
    memberPermissions: { has: () => false },
    reply: async (payload: Call["payload"]) => {
      calls.push({ type: "reply", payload });
      interaction.replied = true;
    },
    editReply: async (payload: Call["payload"]) => {
      calls.push({ type: "editReply", payload });
    },
    followUp: async (payload: Call["payload"]) => {
      calls.push({ type: "followUp", payload });
    },
    deferReply: async (payload: Call["payload"]) => {
      calls.push({ type: "deferReply", payload });
      interaction.deferred = true;
    },
    update: async (payload: Call["payload"]) => {
      calls.push({ type: "update", payload });
      interaction.replied = true;
    },
    showModal: async (modal: { toJSON: () => unknown }) => {
      calls.push({ type: "showModal", payload: modal.toJSON() as Call["payload"] });
    },
  };
  Object.assign(interaction, overrides);
  return { interaction, calls };
}

function slash(meetupId: number | null, userId = "host") {
  return fakeInteraction({
    user: { id: userId },
    options: { getInteger: () => meetupId },
  });
}

function modalInteraction(values: Record<string, string>, userId = "host") {
  const context = fakeInteraction({ user: { id: userId } });
  context.interaction.fields = {
    getTextInputValue: (id: string) => values[id] ?? "",
  };
  return context;
}

function customIds(payload: Call["payload"]): string[] {
  const rows = (payload?.components ?? []) as { toJSON?: () => { components: { custom_id: string }[] } }[];
  return rows.flatMap((row) => (row.toJSON ? row.toJSON().components.map((part) => part.custom_id) : []));
}

function subcommand(name: string) {
  const entry = getSubcommands().find((item) => item.name === name);
  if (!entry) throw new Error(`missing subcommand ${name}`);
  return entry;
}

function makeMeetup(overrides: Record<string, unknown> = {}) {
  const startAt = Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 60_000) * 60_000;
  return createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "テストMeetUp",
    description: "",
    capacity: 0,
    startAt,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
    ...overrides,
  });
}

test("info denies non-managers", async () => {
  const meetup = makeMeetup();
  const { interaction, calls } = slash(meetup.id, "stranger");
  await subcommand("info").execute(interaction as never);

  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0]?.payload)).toContain("主催者または共同主催者");
});

test("info modal is prefilled and rejects past or post-start meeting times", async () => {
  const startAt = Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 60_000) * 60_000;
  const meetingAt = startAt - 2 * 60 * 60 * 1000;
  const meetup = makeMeetup({ startAt, meetingAt, meetingPlace: "駅前" });

  const { interaction, calls } = slash(meetup.id);
  await subcommand("info").execute(interaction as never);

  const modal = calls[0]?.payload as {
    components: { components: { value: string }[] }[];
  };
  const values = modal.components.flatMap((row) => row.components.map((part) => part.value));
  expect(values).toContain(formatInZone(meetingAt));
  expect(values).toContain("駅前");

  const submit = findModal(`ops:info-modal:${meetup.id}`);
  expect(submit).toBeDefined();

  const past = modalInteraction({ "meeting-time": "2000-01-01 10:00", "meeting-place": "" });
  await submit!.handler(past.interaction as never, submit!.args);
  expect(JSON.stringify(past.calls[0]?.payload)).toContain("未来の日時");
  expect(getMeetup(meetup.id)?.meetingAt).toBe(meetingAt);

  const afterStart = modalInteraction({
    "meeting-time": formatInZone(startAt + 60 * 60 * 1000),
    "meeting-place": "",
  });
  await submit!.handler(afterStart.interaction as never, submit!.args);
  expect(JSON.stringify(afterStart.calls[0]?.payload)).toContain("開催日時より後");
  expect(getMeetup(meetup.id)?.meetingAt).toBe(meetingAt);

  const validAt = startAt - 60 * 60 * 1000;
  const valid = modalInteraction({
    "meeting-time": formatInZone(validAt),
    "meeting-place": "新宿駅",
  });
  await submit!.handler(valid.interaction as never, submit!.args);
  expect(JSON.stringify(valid.calls[0]?.payload)).toContain("集合情報を更新しました");
  expect(getMeetup(meetup.id)?.meetingAt).toBe(validAt);
  expect(getMeetup(meetup.id)?.meetingPlace).toBe("新宿駅");

  // Blank time keeps the current value, blank place clears it.
  const blank = modalInteraction({ "meeting-time": "", "meeting-place": "" });
  await submit!.handler(blank.interaction as never, submit!.args);
  expect(getMeetup(meetup.id)?.meetingAt).toBe(validAt);
  expect(getMeetup(meetup.id)?.meetingPlace).toBeNull();
});

test("leave asks for confirmation and cancels an approved participant", async () => {
  const meetup = makeMeetup();
  setParticipantState(meetup.id, "member", "APPROVED");

  const { interaction, calls } = slash(meetup.id, "member");
  await subcommand("leave").execute(interaction as never);

  const confirmId = customIds(calls[0]?.payload).find((id) => id.startsWith("ops:confirm:leave:"));
  expect(confirmId).toBeDefined();
  expect(getParticipant(meetup.id, "member")?.state).toBe("APPROVED");

  const routed = findButton(confirmId!)!;
  const click = fakeInteraction({ customId: confirmId, user: { id: "member" } });
  await routed.handler(click.interaction as never, routed.args);

  expect(getParticipant(meetup.id, "member")?.state).toBe("CANCELLED");
  expect(JSON.stringify(click.calls[0]?.payload)).toContain("参加をキャンセルしました");
});

test("leave without a target shows the participant's approved meetups", async () => {
  const meetup = makeMeetup();
  setParticipantState(meetup.id, "member", "APPROVED");

  const { interaction, calls } = fakeInteraction({
    user: { id: "member" },
    options: { getInteger: () => null },
    channel: null,
    channelId: "",
  });
  await subcommand("leave").execute(interaction as never);

  expect(customIds(calls[0]?.payload)).toContain("ops:pick:leave");
});

test("archive denies non-managers and only changes state after confirmation", async () => {
  const meetup = makeMeetup();

  const denied = slash(meetup.id, "stranger");
  await subcommand("archive").execute(denied.interaction as never);
  expect(JSON.stringify(denied.calls[0]?.payload)).toContain("主催者または共同主催者");

  const { interaction, calls } = slash(meetup.id);
  await subcommand("archive").execute(interaction as never);
  const confirmId = customIds(calls[0]?.payload).find((id) => id.startsWith("ops:confirm:archive:"));
  expect(confirmId).toBeDefined();
  expect(getMeetup(meetup.id)?.state).toBe("ACTIVE");

  const routed = findButton(confirmId!)!;
  const click = fakeInteraction({ customId: confirmId });
  await routed.handler(click.interaction as never, routed.args);

  expect(getMeetup(meetup.id)?.state).toBe("ARCHIVED");
  expect(JSON.stringify(click.calls[0]?.payload)).toContain("アーカイブしました");
});

test("cohosts may cancel and the confirmation applies the cancellation", async () => {
  const meetup = makeMeetup();
  addCohost(meetup.id, "cohost");

  const { interaction, calls } = slash(meetup.id, "cohost");
  await subcommand("cancel").execute(interaction as never);
  const confirmId = customIds(calls[0]?.payload).find((id) => id.startsWith("ops:confirm:cancel:"));
  expect(confirmId).toBeDefined();

  const routed = findButton(confirmId!)!;
  const click = fakeInteraction({ customId: confirmId, user: { id: "cohost" } });
  await routed.handler(click.interaction as never, routed.args);

  expect(getMeetup(meetup.id)?.state).toBe("CANCELLED");
  expect(JSON.stringify(click.calls[0]?.payload)).toContain("MeetUpを中止しました");
});
