import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH ??= join(tmpdir(), `meetupper-init-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

await import("../src/features/init.ts");
const { getSubcommands } = await import("../src/core/registry.ts");

test("init is registered and rejects non-administrators", async () => {
  const entry = getSubcommands().find((item) => item.name === "init");
  expect(entry).toBeDefined();

  const replies: unknown[] = [];
  const interaction = {
    guild: { id: "g1" },
    memberPermissions: { has: () => false },
    deferred: false,
    replied: false,
    reply: async (payload: unknown) => {
      replies.push(payload);
    },
  };
  await entry!.execute(interaction as never);

  expect(replies).toHaveLength(1);
  expect(JSON.stringify(replies[0])).toContain("サーバー管理者のみ");
});
