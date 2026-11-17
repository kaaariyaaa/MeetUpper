import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-registry-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

await import("../src/features/index.ts");
const { getSubcommands } = await import("../src/core/registry.ts");

test("all feature modules register their subcommands", () => {
  const names = getSubcommands().map((entry) => entry.name).sort();
  expect(names).toEqual([
    "apply",
    "archive",
    "cancel",
    "cohost",
    "create",
    "edit",
    "host",
    "info",
    "init",
    "invite",
    "kick",
    "leave",
    "list",
    "members",
    "remind",
    "show",
  ]);
});

test("required options precede optional options in every subcommand", () => {
  for (const entry of getSubcommands()) {
    const options = entry.builder.toJSON().options ?? [];
    const firstOptional = options.findIndex((option) => !option.required);
    if (firstOptional === -1) continue;
    const trailing = options.slice(firstOptional);
    expect({ subcommand: entry.name, optionalFirst: trailing.every((option) => !option.required) }).toEqual({
      subcommand: entry.name,
      optionalFirst: true,
    });
  }
});
