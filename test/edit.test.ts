import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-edit-test-${process.pid}-${Date.now()}.db`);
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const { getMeetup, addCohost, cancelMeetup, createMeetup, removeCohost } = await import(
  "../src/core/meetup.ts"
);
const { listSchedules } = await import("../src/core/reminders.ts");
const { findButton, findModal, findSelectMenu, getSubcommands } = await import(
  "../src/core/registry.ts"
);
const { formatInZone } = await import("../src/core/time.ts");
await import("../src/features/edit.ts");

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function makeMeetup(
  options: {
    mode?: "PUBLIC" | "PRIVATE";
    startAt?: number;
    meetingAt?: number | null;
    approvalMode?: "DIRECT" | "HOST" | "VOTE";
    cohosts?: string[];
  } = {},
) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "編集テストMeetUp",
    description: "元の説明",
    capacity: 5,
    startAt: options.startAt ?? Math.floor((Date.now() + 10 * DAY) / 60_000) * 60_000,
    meetingAt: options.meetingAt ?? null,
    meetingPlace: null,
    mode: options.mode ?? "PUBLIC",
    approvalMode: options.approvalMode ?? "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  for (const userId of options.cohosts ?? []) addCohost(meetup.id, userId);
  return meetup;
}

interface ComponentJson {
  custom_id?: string;
  disabled?: boolean;
  options?: { value?: string; label?: string; default?: boolean }[];
}
interface RowJson {
  components?: ComponentJson[];
}
interface EmbedJson {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
}
interface PayloadJson {
  embeds?: { data?: EmbedJson }[];
  components?: { toJSON: () => RowJson }[];
}

function asPayload(value: unknown): PayloadJson {
  return (value ?? {}) as PayloadJson;
}

function embedData(payload: PayloadJson): EmbedJson {
  return payload.embeds?.[0]?.data ?? {};
}

function rows(payload: PayloadJson): RowJson[] {
  return (payload.components ?? []).map((row) => row.toJSON());
}

function component(payload: PayloadJson, customIdPrefix: string): ComponentJson | undefined {
  for (const row of rows(payload)) {
    for (const item of row.components ?? []) {
      if (item.custom_id?.startsWith(customIdPrefix)) return item;
    }
  }
  return undefined;
}

function customIds(payload: PayloadJson): string[] {
  return rows(payload).flatMap((row) => (row.components ?? []).map((item) => item.custom_id ?? ""));
}

function field(payload: PayloadJson, name: string): string | undefined {
  return embedData(payload).fields?.find((item) => item.name === name)?.value;
}

function panelText(payload: PayloadJson): string {
  return JSON.stringify(payload);
}

function commandInteraction(meetupId: number | null, userId = "host", guildId = "g1") {
  const calls: { type: string; payload: unknown }[] = [];
  const interaction = {
    guild: { id: guildId },
    guildId,
    channel: null,
    channelId: "other",
    user: { id: userId },
    deferred: false,
    replied: false,
    options: { getInteger: () => meetupId },
    deferReply: async () => {
      interaction.deferred = true;
    },
    reply: async (payload: unknown) => {
      calls.push({ type: "reply", payload });
    },
    editReply: async (payload: unknown) => {
      calls.push({ type: "editReply", payload });
    },
    followUp: async (payload: unknown) => {
      calls.push({ type: "followUp", payload });
    },
  };
  return { interaction, calls };
}

async function openHub(meetupId: number, userId = "host", guildId = "g1") {
  const { interaction, calls } = commandInteraction(meetupId, userId, guildId);
  const entry = getSubcommands().find((item) => item.name === "edit")!;
  await entry.execute(interaction as never);
  return calls;
}

function hubPayload(calls: { payload: unknown }[]): PayloadJson {
  return asPayload(calls[calls.length - 1]?.payload);
}

function sessionIdFrom(calls: { payload: unknown }[]): string {
  return component(hubPayload(calls), "edit:basic:")?.custom_id?.split(":")[2] ?? "";
}

interface FakeOptions {
  userId?: string;
  guildId?: string;
}

function buttonInteraction(customId: string, options: FakeOptions = {}) {
  const updates: unknown[] = [];
  const replies: unknown[] = [];
  const modals: unknown[] = [];
  const guildId = options.guildId ?? "g1";
  const interaction = {
    customId,
    guildId,
    guild: { id: guildId },
    user: { id: options.userId ?? "host" },
    deferred: false,
    replied: false,
    isModalSubmit: () => false,
    update: async (payload: unknown) => {
      updates.push(payload);
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    followUp: async (payload: unknown) => {
      replies.push(payload);
    },
    editReply: async (payload: unknown) => {
      updates.push(payload);
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    showModal: async (modal: unknown) => {
      modals.push(modal);
    },
  };
  return { interaction, updates, replies, modals };
}

function selectInteraction(customId: string, value: string, options: FakeOptions = {}) {
  const fake = buttonInteraction(customId, options);
  return { ...fake, interaction: { ...fake.interaction, values: [value] } };
}

function modalInteraction(customId: string, values: Record<string, string>, options: FakeOptions = {}) {
  const updates: unknown[] = [];
  const replies: unknown[] = [];
  const guildId = options.guildId ?? "g1";
  const interaction = {
    customId,
    guildId,
    guild: { id: guildId },
    user: { id: options.userId ?? "host" },
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: (key: string) => values[key] ?? "" },
    update: async (payload: unknown) => {
      updates.push(payload);
    },
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
    followUp: async (payload: unknown) => {
      replies.push(payload);
    },
    editReply: async (payload: unknown) => {
      updates.push(payload);
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    deferUpdate: async () => {
      interaction.deferred = true;
    },
  };
  return { interaction, updates, replies };
}

async function click(customId: string, options: FakeOptions = {}) {
  const entry = findButton(customId)!;
  const fake = buttonInteraction(customId, options);
  await entry.handler(fake.interaction as never, entry.args);
  return fake;
}

async function choose(customId: string, value: string, options: FakeOptions = {}) {
  const entry = findSelectMenu(customId)!;
  const fake = selectInteraction(customId, value, options);
  await entry.handler(fake.interaction as never, entry.args);
  return fake;
}

async function submit(customId: string, values: Record<string, string>, options: FakeOptions = {}) {
  const entry = findModal(customId)!;
  const fake = modalInteraction(customId, values, options);
  await entry.handler(fake.interaction as never, entry.args);
  return fake;
}

test("edit takes only the optional meetup argument and shows every hub control", async () => {
  const entry = getSubcommands().find((item) => item.name === "edit")!;
  expect(entry.builder.toJSON().options?.map((option) => option.name)).toEqual(["meetup"]);

  const meetup = makeMeetup({ cohosts: ["c1"] });
  const calls = await openHub(meetup.id);
  expect(calls[0]?.type).toBe("editReply");

  const payload = hubPayload(calls);
  expect(embedData(payload).title).toContain("MeetUp設定");
  expect(field(payload, "名前")).toBe("編集テストMeetUp");
  expect(field(payload, "定員")).toBe("5人");
  expect(field(payload, "参加方法")).toBe("主催者承認");
  expect(field(payload, "イベント連携")).toBe("OFF");
  expect(field(payload, "共同主催者")).toContain("<@c1>");
  expect(field(payload, "リマインダー")).toContain("ON");

  const ids = customIds(payload);
  for (const expected of [
    "edit:basic:",
    "edit:approval:",
    "edit:meeting:",
    `people:cohost-open:${meetup.id}`,
    `people:host-open:${meetup.id}`,
    `reminder:open:${meetup.id}`,
    `ops:archive-open:${meetup.id}`,
    `ops:cancel-open:${meetup.id}`,
    "edit:save:",
    "edit:cancel:",
  ]) {
    expect(ids.some((id) => id.startsWith(expected))).toBe(true);
  }
  expect(component(payload, "edit:event:")?.disabled).toBe(false);
});

test("sub-screens only change the draft and 保存 applies everything at once", async () => {
  const meetup = makeMeetup();
  const calls = await openHub(meetup.id);
  const id = sessionIdFrom(calls);

  const start = formatInZone(Date.now() + 12 * DAY);
  const meeting = formatInZone(Date.now() + 6 * DAY);

  const basic = await click(`edit:basic:${id}`);
  expect(basic.modals).toHaveLength(1);
  const basicPayload = await submit(`edit:basic:${id}`, {
    name: "新しい名前",
    description: "新しい説明",
    capacity: "8",
    start,
  });
  let hub = asPayload(basicPayload.updates[0]);
  expect(field(hub, "名前")).toBe("新しい名前");
  expect(field(hub, "定員")).toBe("8人");
  expect(embedData(hub).description).toContain("未保存の変更があります");
  expect(getMeetup(meetup.id)!.name).toBe("編集テストMeetUp");

  const meetingSubmit = await submit(`edit:meeting:${id}`, {
    "meeting-time": meeting,
    "meeting-place": "渋谷駅",
  });
  hub = asPayload(meetingSubmit.updates[0]);
  expect(field(hub, "集合場所")).toBe("渋谷駅");
  expect(getMeetup(meetup.id)!.meetingAt).toBeNull();

  const approval = await click(`edit:approval:${id}`);
  expect(panelText(asPayload(approval.updates[0]))).toContain("参加方法");
  const vote = await choose(`edit:mode:${id}`, "VOTE");
  expect(vote.modals).toHaveLength(1);
  const votes = await submit(`edit:votes:${id}`, { "required-votes": "3" });
  hub = asPayload(votes.updates[0]);
  expect(field(hub, "参加方法")).toBe("参加者投票（必要票数 3）");

  const saved = await click(`edit:save:${id}`);
  expect(panelText(asPayload(saved.updates[saved.updates.length - 1]))).toContain("保存しました");

  const updated = getMeetup(meetup.id)!;
  expect(updated.name).toBe("新しい名前");
  expect(updated.description).toBe("新しい説明");
  expect(updated.capacity).toBe(8);
  expect(updated.approvalMode).toBe("VOTE");
  expect(updated.requiredVotes).toBe(3);
  expect(updated.meetingPlace).toBe("渋谷駅");
  expect(updated.meetingAt).not.toBeNull();

  const stale = await click(`edit:basic:${id}`);
  expect(JSON.stringify(stale.replies)).toContain("有効期限");
});

test("キャンセル drops the session without touching the database", async () => {
  const meetup = makeMeetup();
  const calls = await openHub(meetup.id);
  const id = sessionIdFrom(calls);

  await submit(`edit:basic:${id}`, {
    name: "破棄される名前",
    description: "",
    capacity: "0",
    start: formatInZone(Date.now() + 10 * DAY),
  });
  const cancelled = await click(`edit:cancel:${id}`);
  expect(panelText(asPayload(cancelled.updates[0]))).toContain("破棄");

  const stored = getMeetup(meetup.id)!;
  expect(stored.name).toBe("編集テストMeetUp");
  expect(stored.capacity).toBe(5);

  const after = await click(`edit:basic:${id}`);
  expect(JSON.stringify(after.replies)).toContain("有効期限");
});

test("validation blocks past or late meeting times and start before meeting time", async () => {
  const startAt = Date.now() + 10 * DAY;
  const meetup = makeMeetup({ startAt, meetingAt: Date.now() + 5 * DAY });
  const calls = await openHub(meetup.id);
  const id = sessionIdFrom(calls);

  let fake = await submit(`edit:basic:${id}`, {
    name: "編集テストMeetUp",
    description: "元の説明",
    capacity: "5",
    start: formatInZone(Date.now() + 4 * DAY),
  });
  expect(panelText(asPayload(fake.updates[0]))).toContain("集合時間は開催日時より後に設定できません");

  fake = await submit(`edit:meeting:${id}`, {
    "meeting-time": formatInZone(Date.now() - HOUR),
    "meeting-place": "渋谷駅",
  });
  expect(panelText(asPayload(fake.updates[0]))).toContain("未来の日時");

  fake = await submit(`edit:meeting:${id}`, {
    "meeting-time": formatInZone(Date.now() + 12 * DAY),
    "meeting-place": "渋谷駅",
  });
  expect(panelText(asPayload(fake.updates[0]))).toContain("集合時間は開催日時より後に設定できません");

  fake = await submit(`edit:basic:${id}`, {
    name: "編集テストMeetUp",
    description: "元の説明",
    capacity: "abc",
    start: formatInZone(startAt),
  });
  expect(panelText(asPayload(fake.updates[0]))).toContain("整数");

  expect(getMeetup(meetup.id)!.meetingAt).toBe(meetup.meetingAt);
  expect(getMeetup(meetup.id)!.name).toBe("編集テストMeetUp");
});

test("保存 re-validates a draft whose meeting time has gone stale", async () => {
  const meetup = makeMeetup({ meetingAt: Date.now() - HOUR });
  const calls = await openHub(meetup.id);
  const id = sessionIdFrom(calls);

  const saved = await click(`edit:save:${id}`);
  expect(panelText(asPayload(saved.updates[saved.updates.length - 1]))).toContain("未来の日時");
  expect(getMeetup(meetup.id)!.meetingAt).toBe(meetup.meetingAt);
});

test("Private meetups keep HOST approval and cannot enable event links", async () => {
  const meetup = makeMeetup({ mode: "PRIVATE", approvalMode: "HOST" });
  const calls = await openHub(meetup.id);
  const id = sessionIdFrom(calls);
  const payload = hubPayload(calls);
  expect(component(payload, "edit:event:")?.disabled).toBe(true);

  const toggled = await click(`edit:event:${id}`);
  expect(panelText(asPayload(toggled.updates[0]))).toContain("Public");
  expect(field(asPayload(toggled.updates[0]), "イベント連携")).toBe("OFF");

  const approval = await click(`edit:approval:${id}`);
  expect(component(asPayload(approval.updates[0]), "edit:mode:")?.disabled).toBe(true);
});

test("re-checks owner, guild, manager permission and ACTIVE state on every click", async () => {
  const meetup = makeMeetup({ cohosts: ["c1"] });

  const cohostCalls = await openHub(meetup.id, "c1");
  const cohostId = sessionIdFrom(cohostCalls);
  removeCohost(meetup.id, "c1");
  const demoted = await click(`edit:basic:${cohostId}`, { userId: "c1" });
  expect(JSON.stringify(demoted.replies)).toContain("主催者または共同主催者");

  const hostCalls = await openHub(meetup.id);
  const id = sessionIdFrom(hostCalls);
  const stranger = await click(`edit:basic:${id}`, { userId: "u2" });
  expect(JSON.stringify(stranger.replies)).toContain("有効期限");

  const wrongGuild = await click(`edit:basic:${id}`, { guildId: "g2" });
  expect(JSON.stringify(wrongGuild.replies)).toContain("有効期限");

  cancelMeetup(meetup);
  const inactive = await click(`edit:basic:${id}`);
  expect(JSON.stringify(inactive.replies)).toContain("ACTIVE");
});

test("reminders are rebuilt only when the base date changes", async () => {
  const startAt = Math.floor((Date.now() + 10 * DAY) / 60_000) * 60_000;
  const meetup = makeMeetup({ startAt });
  const before = listSchedules(meetup.id);
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((schedule) => schedule.baseAt === startAt)).toBe(true);

  // A name-only save leaves the existing schedule rows alone.
  let calls = await openHub(meetup.id);
  let id = sessionIdFrom(calls);
  await submit(`edit:basic:${id}`, {
    name: "名前だけ変更",
    description: "元の説明",
    capacity: "5",
    start: formatInZone(startAt),
  });
  await click(`edit:save:${id}`);
  const afterName = listSchedules(meetup.id);
  expect(afterName.map((schedule) => schedule.id)).toEqual(before.map((schedule) => schedule.id));

  // Moving the start date (no meeting time) rebuilds every schedule from the new base.
  const newStart = startAt + DAY;
  calls = await openHub(meetup.id);
  id = sessionIdFrom(calls);
  await submit(`edit:basic:${id}`, {
    name: "名前だけ変更",
    description: "元の説明",
    capacity: "5",
    start: formatInZone(newStart),
  });
  await click(`edit:save:${id}`);
  const afterStart = listSchedules(meetup.id);
  expect(afterStart.length).toBe(before.length);
  expect(afterStart.every((schedule) => schedule.baseAt === newStart)).toBe(true);
});
