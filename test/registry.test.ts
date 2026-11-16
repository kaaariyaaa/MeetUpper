import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH ??= join(tmpdir(), `meetupper-registry-${process.pid}-${Date.now()}.db`);

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
    "invite",
    "leave",
    "list",
    "members",
    "remind",
    "show",
  ]);
});
