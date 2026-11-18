import { expect, test } from "bun:test";
import { ComponentType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-create-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { createInputFromDraft, createModal, createResultRow, parseCreateForm } = await import(
  "../src/features/create.ts"
);
const { findModal, getSubcommands } = await import("../src/core/registry.ts");

test("create is registered without options", () => {
  const entries = getSubcommands();
  const create = entries.find((entry) => entry.name === "create");
  expect(create).toBeDefined();
  expect(create?.builder.toJSON().options ?? []).toEqual([]);
});

test("create modal has the four UI-spec fields and cross-feature ids", () => {
  const json = createModal("abcdef1234").toJSON();
  expect(json.custom_id).toBe("create:submit:abcdef1234");
  expect(json.title).toBe("MeetUpを作成");

  const labels = json.components as {
    label: string;
    component: { type: ComponentType; custom_id: string; options?: { value: string }[] };
  }[];
  expect(labels.map((label) => label.label)).toEqual([
    "公開モード",
    "参加方法",
    "MeetUp名",
    "開催日時",
  ]);

  const [mode, approval, name, start] = labels;
  expect(mode?.component.type).toBe(ComponentType.StringSelect);
  expect(mode?.component.custom_id).toBe("create:mode");
  expect(mode?.component.options?.map((option) => option.value)).toEqual(["PUBLIC", "PRIVATE"]);

  expect(approval?.component.type).toBe(ComponentType.StringSelect);
  expect(approval?.component.custom_id).toBe("create:approval");
  expect(approval?.component.options?.map((option) => option.value)).toEqual([
    "DIRECT",
    "HOST",
    "VOTE",
  ]);

  expect(name?.component.type).toBe(ComponentType.TextInput);
  expect(name?.component.custom_id).toBe("create:name");
  expect(start?.component.type).toBe(ComponentType.TextInput);
  expect(start?.component.custom_id).toBe("create:start");

  expect(findModal("create:submit:abcdef1234")?.args).toEqual(["abcdef1234"]);
});

test("parseCreateForm accepts public joins and enforces private host approval", () => {
  const base = {
    mode: "PUBLIC",
    approval: "DIRECT",
    name: " テストMeetUp ",
    start: "2099-01-01 12:00",
  };

  const direct = parseCreateForm(base, Date.now());
  expect(direct.name).toBe("テストMeetUp");
  expect(direct.mode).toBe("PUBLIC");
  expect(direct.approvalMode).toBe("DIRECT");
  expect(direct.startAt).toBeGreaterThan(Date.now());

  expect(parseCreateForm({ ...base, mode: "PRIVATE", approval: "HOST" }).approvalMode).toBe("HOST");
  // Private is fixed to HOST; other modal choices are ignored rather than rejected.
  expect(parseCreateForm({ ...base, mode: "PRIVATE", approval: "DIRECT" }).approvalMode).toBe("HOST");
  expect(parseCreateForm({ ...base, mode: "PRIVATE", approval: "VOTE" }).approvalMode).toBe("HOST");
});

test("parseCreateForm rejects missing selections, names and dates", () => {
  const base = {
    mode: "PUBLIC",
    approval: "DIRECT",
    name: "テスト",
    start: "2099-01-01 12:00",
  };

  expect(() => parseCreateForm({ ...base, mode: null })).toThrow(/公開モード/);
  expect(() => parseCreateForm({ ...base, approval: null })).toThrow(/参加方法/);
  expect(() => parseCreateForm({ ...base, name: "   " })).toThrow(/MeetUp名/);
  expect(() => parseCreateForm({ ...base, start: "not a date" })).toThrow(/解析/);
  expect(() => parseCreateForm({ ...base, start: "2000-01-01 00:00" })).toThrow(/未来/);
});

test("create uses the fixed UI-spec defaults", () => {
  const draft = parseCreateForm(
    {
      mode: "PUBLIC",
      approval: "VOTE",
      name: "テスト",
      start: "2099-01-01 12:00",
    },
    Date.now(),
  );
  const input = createInputFromDraft("guild", "host", draft);
  expect(input).toMatchObject({
    guildId: "guild",
    hostId: "host",
    description: "",
    capacity: 0,
    meetingAt: null,
    meetingPlace: null,
    mode: "PUBLIC",
    approvalMode: "VOTE",
    requiredVotes: 1,
    eventEnabled: false,
    reminderEnabled: true,
  });
});

test("success panel links to browse, edit and reminder by fixed ids", () => {
  const row = createResultRow(42).toJSON();
  expect(
    row.components.map((component) => ("label" in component ? component.label : undefined)),
  ).toEqual([
    "MeetUpを開く",
    "編集",
    "リマインダー",
  ]);
  expect(
    row.components.map((component) => ("custom_id" in component ? component.custom_id : undefined)),
  ).toEqual(["browse:show:42", "edit:open:42", "reminder:open:42"]);
});
