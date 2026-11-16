import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-create-test-${process.pid}-${Date.now()}.db`);
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { extractCohostIds } = await import("../src/features/create.ts");
const { getSubcommands } = await import("../src/core/registry.ts");

test("create/list/show subcommands are registered", () => {
  const entries = getSubcommands();
  const names = entries.map((entry) => entry.name);
  expect(names).toContain("create");
  expect(names).toContain("list");
  expect(names).toContain("show");

  const create = entries.find((entry) => entry.name === "create");
  const options = create?.builder.toJSON().options ?? [];
  expect(options.map((option) => option.name)).toEqual([
    "name",
    "description",
    "capacity",
    "start",
    "meeting-time",
    "meeting-place",
    "mode",
    "approval",
    "required-votes",
    "cohosts",
    "event",
  ]);
  expect(options.filter((option) => option.required).map((option) => option.name)).toEqual([
    "name",
    "capacity",
    "start",
    "mode",
  ]);

  const show = entries.find((entry) => entry.name === "show");
  expect(show?.builder.toJSON().options?.map((option) => option.name)).toEqual(["meetup"]);
});

test("extractCohostIds reads mentions and raw ids without duplicates", () => {
  expect(extractCohostIds("<@123> <@!456>, 789")).toEqual(["123", "456", "789"]);
  expect(extractCohostIds("123, 123")).toEqual(["123"]);
  expect(extractCohostIds("")).toEqual([]);
});
