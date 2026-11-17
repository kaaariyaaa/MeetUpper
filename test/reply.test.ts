import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-reply-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { deferEphemeral, replyEphemeral } = await import("../src/core/discord.ts");

interface Call {
  type: "reply" | "editReply" | "followUp" | "deferReply";
  payload?: Record<string, unknown>;
}

function fakeInteraction() {
  const calls: Call[] = [];
  const interaction = {
    deferred: false,
    replied: false,
    reply: async (payload: Record<string, unknown>) => {
      calls.push({ type: "reply", payload });
    },
    editReply: async (payload: Record<string, unknown>) => {
      calls.push({ type: "editReply", payload });
    },
    followUp: async (payload: Record<string, unknown>) => {
      calls.push({ type: "followUp", payload });
    },
    deferReply: async (payload: Record<string, unknown>) => {
      calls.push({ type: "deferReply", payload });
      interaction.deferred = true;
    },
  };
  return { interaction, calls };
}

test("deferEphemeral acknowledges only once", async () => {
  const { interaction, calls } = fakeInteraction();
  await deferEphemeral(interaction as never);
  await deferEphemeral(interaction as never);
  expect(calls.filter((call) => call.type === "deferReply")).toHaveLength(1);
  expect(calls[0]?.payload?.flags).toBeDefined();
});

test("replyEphemeral resolves a deferred reply with editReply (no double message)", async () => {
  const { interaction, calls } = fakeInteraction();
  await deferEphemeral(interaction as never);
  await replyEphemeral(interaction as never, "done");
  expect(calls.map((call) => call.type)).toEqual(["deferReply", "editReply"]);
  expect(JSON.stringify(calls[1]?.payload)).toContain("done");
  expect(calls[1]?.payload?.flags).toBeUndefined();
});

test("replyEphemeral uses followUp after a reply already exists", async () => {
  const { interaction, calls } = fakeInteraction();
  interaction.replied = true;
  await replyEphemeral(interaction as never, "again");
  expect(calls.map((call) => call.type)).toEqual(["followUp"]);
  expect(calls[0]?.payload?.flags).toBeDefined();
});
