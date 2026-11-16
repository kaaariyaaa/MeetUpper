import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-manage-test-${process.pid}-${Date.now()}.db`);

const { findButton, getSubcommands } = await import("../src/core/registry.ts");
await import("../src/features/manage.ts");

test("manage registers its subcommands", () => {
  const names = getSubcommands().map((entry) => entry.name);
  for (const name of ["info", "leave", "members", "cohost", "host", "archive", "cancel"]) {
    expect(names).toContain(name);
  }
});

test("manage buttons route their meetup id", () => {
  expect(findButton("manage:confirm-archive:12")?.args).toEqual(["12"]);
  expect(findButton("manage:confirm-cancel:34")?.args).toEqual(["34"]);
  expect(findButton("manage:abort")?.args).toEqual([]);
  expect(findButton("manage:confirm-archive:abc")).toBeUndefined();
});
