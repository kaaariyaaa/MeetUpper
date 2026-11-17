import { expect, setSystemTime, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-reminder-ui-test-${process.pid}-${Date.now()}.db`);
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { db } = await import("../src/db.ts");
db.exec("DELETE FROM meetups");

const {
  DEFAULT_REMINDER_OFFSETS,
  getReminderOffsets,
  getReminderSettings,
  listSchedules,
  saveReminderSettings,
} = await import("../src/core/reminders.ts");
const { addCohost, cancelMeetup, createMeetup, removeCohost, setParticipantState, updateMeetup } =
  await import("../src/core/meetup.ts");
const { findButton, findModal, findSelectMenu, getSubcommands } = await import("../src/core/registry.ts");
await import("../src/features/reminder.ts");

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

interface ComponentJson {
  custom_id?: string;
  disabled?: boolean;
  options?: { value?: string }[];
}
interface RowJson {
  components?: ComponentJson[];
}
interface EmbedJson {
  title?: string;
  description?: string;
  fields?: { name: string; value: string }[];
  footer?: { text?: string };
}
interface PayloadJson {
  embeds?: { data?: EmbedJson }[];
  components?: { toJSON: () => RowJson }[];
}

function makeMeetup(
  options: { approved?: string[]; cohosts?: string[]; reminderEnabled?: boolean } = {},
) {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "UIテストMeetUp",
    description: "",
    capacity: 5,
    startAt: Date.now() + 10 * DAY,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
    reminderEnabled: options.reminderEnabled ?? true,
  });
  updateMeetup(meetup.id, { channelId: "chan-1" });
  for (const userId of options.cohosts ?? []) addCohost(meetup.id, userId);
  for (const userId of options.approved ?? []) {
    setParticipantState(meetup.id, userId, "APPROVED", { approvedBy: "host" });
  }
  return meetup;
}

function asPayload(value: unknown): PayloadJson {
  return (value ?? {}) as PayloadJson;
}

function panelText(payload: PayloadJson): string {
  return JSON.stringify(payload);
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

function optionCount(payload: PayloadJson, customIdPrefix: string): number {
  return component(payload, customIdPrefix)?.options?.length ?? 0;
}

function commandInteraction(meetupId: number, userId = "host", guildId = "g1") {
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
    reply: async (payload: unknown) => {
      calls.push({ type: "reply", payload });
    },
    editReply: async (payload: unknown) => {
      calls.push({ type: "editReply", payload });
    },
    followUp: async (payload: unknown) => {
      calls.push({ type: "followUp", payload });
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
  };
  return { interaction, calls };
}

async function openPanel(meetupId: number, userId = "host", guildId = "g1") {
  const { interaction, calls } = commandInteraction(meetupId, userId, guildId);
  const entry = getSubcommands().find((item) => item.name === "reminder")!;
  await entry.execute(interaction as never);
  return calls;
}

function panelPayload(calls: { payload: unknown }[]): PayloadJson {
  return asPayload(calls[0]?.payload);
}

function sessionIdFrom(calls: { payload: unknown }[]): string {
  const first = panelPayload(calls).components?.[0]?.toJSON().components?.[0];
  return first?.custom_id?.split(":")[2] ?? "";
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
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload: unknown) => {
      updates.push(payload);
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
  const updates: unknown[] = [];
  const replies: unknown[] = [];
  const modals: unknown[] = [];
  const guildId = options.guildId ?? "g1";
  const interaction = {
    customId,
    values: [value],
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
    deferUpdate: async () => {
      interaction.deferred = true;
    },
    showModal: async (modal: unknown) => {
      modals.push(modal);
    },
  };
  return { interaction, updates, replies, modals };
}

function modalInteraction(
  customId: string,
  values: Record<string, string>,
  options: FakeOptions = {},
) {
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

async function submit(
  customId: string,
  values: Record<string, string>,
  options: FakeOptions = {},
) {
  const entry = findModal(customId)!;
  const fake = modalInteraction(customId, values, options);
  await entry.handler(fake.interaction as never, entry.args);
  return fake;
}

test("zero-offset panel renders without an empty select menu", async () => {
  const meetup = makeMeetup();
  const settings = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, settings.version, false, []);

  const calls = await openPanel(meetup.id);
  const payload = panelPayload(calls);
  const id = sessionIdFrom(calls);

  expect(
    embedData(payload).fields?.some((field) => field.name === "通知時刻" && field.value === "設定なし"),
  ).toBe(true);
  expect(embedData(payload).description).toContain("自動通知: **OFF**");
  for (const row of rows(payload)) {
    expect(row.components?.length ?? 0).toBeGreaterThan(0);
    for (const item of row.components ?? []) {
      if (item.options) expect(item.options.length).toBeGreaterThan(0);
    }
  }
  expect(optionCount(payload, "reminder:preset:")).toBe(9);
  expect(component(payload, "reminder:remove:")).toBeUndefined();
  expect(component(payload, "reminder:change:")).toBeUndefined();

  const on = await click(`reminder:toggle:${id}`);
  expect(panelText(asPayload(on.updates[0]))).toContain("ONにできません");
});

test("all controls reject non-owners, wrong guilds, revoked managers and inactive meetups", async () => {
  const meetup = makeMeetup({ approved: ["u1"], cohosts: ["c1"] });
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  const buttons = [
    `reminder:toggle:${id}`,
    `reminder:custom:${id}`,
    `reminder:history:${id}:0`,
    `reminder:save:${id}`,
    `reminder:cancel:${id}`,
  ];
  for (const customId of buttons) {
    const fake = await click(customId, { userId: "u1" });
    expect(JSON.stringify(fake.replies)).toContain("開いた本人だけ");
  }
  for (const customId of [
    `reminder:preset:${id}`,
    `reminder:remove:${id}`,
    `reminder:change:${id}`,
  ]) {
    const fake = await choose(customId, String(DEFAULT_REMINDER_OFFSETS[0]!), { userId: "u1" });
    expect(JSON.stringify(fake.replies)).toContain("開いた本人だけ");
  }
  const unauthorisedModal = await submit(
    `reminder:modal:${id}`,
    { days: "2", hours: "0", minutes: "0" },
    { userId: "u1" },
  );
  expect(JSON.stringify(unauthorisedModal.replies)).toContain("開いた本人だけ");

  expect(getReminderSettings(meetup.id).enabled).toBe(true);
  expect(getReminderOffsets(meetup.id)).toEqual([...DEFAULT_REMINDER_OFFSETS]);

  const wrongGuild = await click(`reminder:toggle:${id}`, { guildId: "g2" });
  expect(JSON.stringify(wrongGuild.replies)).toContain("別のサーバー");

  const cohostCalls = await openPanel(meetup.id, "c1");
  const cohostId = sessionIdFrom(cohostCalls);
  removeCohost(meetup.id, "c1");
  const demoted = await click(`reminder:toggle:${cohostId}`, { userId: "c1" });
  expect(JSON.stringify(demoted.replies)).toContain("主催者または共同主催者");

  cancelMeetup(meetup);
  const inactive = await click(`reminder:toggle:${id}`);
  expect(JSON.stringify(inactive.replies)).toContain("ACTIVE");
});

test("ON needs one offset and the last offset can only be removed while OFF", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  await choose(`reminder:remove:${id}`, String(3 * 60 * 60));
  await choose(`reminder:remove:${id}`, String(30 * 60));

  const blocked = await choose(`reminder:remove:${id}`, String(24 * 60 * 60));
  expect(panelText(asPayload(blocked.updates[0]))).toContain("最後の1件");

  const off = await click(`reminder:toggle:${id}`);
  expect(panelText(asPayload(off.updates[0]))).toContain("自動通知: **OFF**");

  const removed = await choose(`reminder:remove:${id}`, String(24 * 60 * 60));
  expect(panelText(asPayload(removed.updates[0]))).toContain("設定なし");

  const on = await click(`reminder:toggle:${id}`);
  expect(panelText(asPayload(on.updates[0]))).toContain("ONにできません");
});

test("preset adds collapse duplicates and stop at five", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  let fake = await choose(`reminder:preset:${id}`, String(3 * 60 * 60));
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(3);

  fake = await choose(`reminder:preset:${id}`, String(7 * 24 * 60 * 60));
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(4);
  fake = await choose(`reminder:preset:${id}`, String(3 * 24 * 60 * 60));
  const atMax = asPayload(fake.updates[0]);
  expect(optionCount(atMax, "reminder:remove:")).toBe(5);
  expect(component(atMax, "reminder:preset:")?.disabled).toBe(true);

  fake = await choose(`reminder:preset:${id}`, String(60 * 60));
  expect(panelText(asPayload(fake.updates[0]))).toContain("最大5件");
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(5);

  const custom = await click(`reminder:custom:${id}`);
  expect(panelText(asPayload(custom.updates[0]))).toContain("最大5件");
  expect(custom.modals).toHaveLength(0);
});

test("custom modal adds offsets, collapses duplicates and enforces the one-minute floor", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  const custom = await click(`reminder:custom:${id}`);
  expect(custom.modals).toHaveLength(1);
  expect(panelText(asPayload(custom.modals[0]))).toContain("自由設定");

  let fake = await submit(`reminder:modal:${id}`, { days: "0", hours: "0", minutes: "0" });
  expect(panelText(asPayload(fake.updates[0]))).toContain("1分");
  fake = await submit(`reminder:modal:${id}`, { days: "abc", hours: "0", minutes: "0" });
  expect(panelText(asPayload(fake.updates[0]))).toContain("0以上の整数");

  fake = await submit(`reminder:modal:${id}`, { days: "0", hours: "0", minutes: "45" });
  expect(panelText(asPayload(fake.updates[0]))).toContain("45分前");
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(4);

  fake = await submit(`reminder:modal:${id}`, { days: "0", hours: "0", minutes: "30" });
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(4);

  await choose(`reminder:preset:${id}`, String(7 * 24 * 60 * 60));
  expect(optionCount(asPayload((await choose(`reminder:preset:${id}`, String(3 * 24 * 60 * 60))).updates[0]), "reminder:remove:")).toBe(5);
  fake = await submit(`reminder:modal:${id}`, { days: "0", hours: "2", minutes: "0" });
  expect(panelText(asPayload(fake.updates[0]))).toContain("最大5件");
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(5);
});

test("change select opens a prefilled modal and replaces the chosen offset", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  const opened = await choose(`reminder:change:${id}`, String(30 * 60));
  expect(opened.modals).toHaveLength(1);
  const modalJson = panelText(asPayload(opened.modals[0]));
  expect(modalJson).toContain("通知時刻の変更");
  expect(modalJson).toContain('"value":"30"');

  let fake = await submit(`reminder:modal:${id}`, { days: "0", hours: "0", minutes: "15" });
  expect(panelText(asPayload(fake.updates[0]))).toContain("15分前");
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(3);

  await choose(`reminder:change:${id}`, String(3 * 60 * 60));
  fake = await submit(`reminder:modal:${id}`, { days: "0", hours: "0", minutes: "0" });
  expect(panelText(asPayload(fake.updates[0]))).toContain("1分");
  expect(optionCount(asPayload(fake.updates[0]), "reminder:remove:")).toBe(3);
  expect(panelText(asPayload(fake.updates[0]))).toContain("3時間前");
});

test("settings panel shows the current status and reason", async () => {
  const meetup = makeMeetup();
  db.query(
    "UPDATE reminder_schedules SET status = 'FAILED', last_error = ? WHERE meetup_id = ? AND offset_seconds = ?",
  ).run("Discord API 500", meetup.id, 3 * 60 * 60);
  db.query(
    "UPDATE reminder_schedules SET status = 'SKIPPED', skip_reason = ? WHERE meetup_id = ? AND offset_seconds = ?",
  ).run("通知対象者がいない", meetup.id, 30 * 60);

  const text = panelText(panelPayload(await openPanel(meetup.id)));
  expect(text).toContain("送信待ち");
  expect(text).toContain("失敗: Discord API 500");
  expect(text).toContain("スキップ: 通知対象者がいない");
});

test("history pages newest first with status/reason and hides expired rows", async () => {
  const meetup = makeMeetup();
  const now = Date.now();
  const statuses = ["SENT", "FAILED", "SKIPPED", "FAILED", "SKIPPED", "FAILED", "SKIPPED"];
  const insert = db.query(
    `INSERT INTO reminder_history
       (meetup_id, schedule_id, base_at, offset_seconds, scheduled_at, sent_at, status, reason, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  );
  statuses.forEach((status, index) => {
    insert.run(
      meetup.id,
      now,
      30 * 60,
      now - index * DAY,
      status === "SENT" ? now - index * DAY : null,
      status,
      status === "SENT" ? null : `reason-${index}`,
      now - index * DAY,
    );
  });
  insert.run(meetup.id, now, 30 * 60, now - 91 * DAY, null, "SENT", "reason-91", now - 91 * DAY);

  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  const first = await click(`reminder:history:${id}:0`);
  const firstPayload = asPayload(first.updates[0]);
  const firstText = panelText(firstPayload);
  expect(embedData(firstPayload).footer?.text).toBe("1 / 2 ページ（7件・90日保存）");
  expect(firstText).toContain("SENT");
  expect(firstText).toContain("理由: reason-1");
  expect(firstText).toContain("理由: reason-2");
  expect(firstText.indexOf("reason-1")).toBeLessThan(firstText.indexOf("reason-2"));
  expect(firstText).not.toContain("reason-91");

  const second = await click(`reminder:history:${id}:1`);
  const secondPayload = asPayload(second.updates[0]);
  expect(embedData(secondPayload).footer?.text).toBe("2 / 2 ページ（7件・90日保存）");
  expect(panelText(secondPayload)).toContain("理由: reason-6");
});

test("draft edits never touch the DB and cancel discards them", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  await click(`reminder:toggle:${id}`);
  await choose(`reminder:preset:${id}`, String(7 * 24 * 60 * 60));

  expect(getReminderSettings(meetup.id).enabled).toBe(true);
  expect(getReminderOffsets(meetup.id)).toEqual([...DEFAULT_REMINDER_OFFSETS]);
  expect(listSchedules(meetup.id)).toHaveLength(3);

  const cancelled = await click(`reminder:cancel:${id}`);
  expect(panelText(asPayload(cancelled.updates[0]))).toContain("破棄");
  expect(getReminderSettings(meetup.id).enabled).toBe(true);
  expect(getReminderOffsets(meetup.id)).toEqual([...DEFAULT_REMINDER_OFFSETS]);

  const save = await click(`reminder:save:${id}`);
  expect(JSON.stringify(save.replies)).toContain("有効期限");
});

test("save commits the draft in one step and bumps the version", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  await click(`reminder:toggle:${id}`);
  await choose(`reminder:preset:${id}`, String(7 * 24 * 60 * 60));
  const saved = await click(`reminder:save:${id}`);
  expect(panelText(asPayload(saved.updates[0]))).toContain("保存しました");

  expect(getReminderSettings(meetup.id).enabled).toBe(false);
  expect(getReminderOffsets(meetup.id)).toEqual([7 * 24 * 60 * 60, ...DEFAULT_REMINDER_OFFSETS]);
  expect(getReminderSettings(meetup.id).version).toBe(2);
});

test("a stale save conflicts and reload picks up the latest settings", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);

  const current = getReminderSettings(meetup.id);
  saveReminderSettings(meetup.id, current.version, false, [60 * 60]);

  const stale = await click(`reminder:save:${id}`);
  expect(panelText(asPayload(stale.updates[0]))).toContain("他の管理者");
  expect(component(asPayload(stale.updates[0]), "reminder:reload:")).toBeDefined();

  const reloaded = await click(`reminder:reload:${id}`);
  const text = panelText(asPayload(reloaded.updates[0]));
  expect(text).toContain("最新の設定を読み込みました");
  expect(text).toContain("自動通知: **OFF**");
  expect(text).toContain("1時間前");
});

test("draft TTL refreshes while in use and expires after inactivity", async () => {
  const meetup = makeMeetup();
  const calls = await openPanel(meetup.id);
  const id = sessionIdFrom(calls);
  const startedAt = Date.now();

  try {
    setSystemTime(new Date(startedAt + 14 * MINUTE));
    const first = await click(`reminder:toggle:${id}`);
    expect(JSON.stringify(first.replies)).not.toContain("有効期限");

    setSystemTime(new Date(startedAt + 28 * MINUTE));
    const second = await click(`reminder:toggle:${id}`);
    expect(JSON.stringify(second.replies)).not.toContain("有効期限");

    setSystemTime(new Date(startedAt + 45 * MINUTE));
    const expired = await click(`reminder:toggle:${id}`);
    expect(JSON.stringify(expired.replies)).toContain("有効期限");
  } finally {
    setSystemTime();
  }
});
