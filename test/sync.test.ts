import { expect, test } from "bun:test";
import { ChannelType, OverwriteType } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH ??= join(tmpdir(), `meetupper-sync-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");

const { addCohost, archiveMeetup, createMeetup, getMeetup, setParticipantState, updateMeetup } =
  await import("../src/core/meetup.ts");
const { syncMeetupAccess } = await import("../src/core/discord.ts");

function makeMeetup() {
  const meetup = createMeetup({
    guildId: "g1",
    hostId: "host",
    name: "権限テスト",
    description: "",
    capacity: 5,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: null,
    mode: "PRIVATE",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
  });
  updateMeetup(meetup.id, { channelId: "chan-1" });
  setParticipantState(meetup.id, "approved-user", "APPROVED");
  addCohost(meetup.id, "cohost");
  return getMeetup(meetup.id)!;
}

function fakeGuild() {
  const edits: { id: string; options: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const overwrites = new Map<string, { type: OverwriteType }>([
    ["role-admin", { type: OverwriteType.Role }],
    ["stale-user", { type: OverwriteType.Member }],
    ["role-everyone", { type: OverwriteType.Role }],
  ]);
  const channel = {
    type: ChannelType.GuildText,
    permissionOverwrites: {
      cache: overwrites,
      edit: async (id: string, options: Record<string, unknown>) => {
        edits.push({ id, options });
      },
      delete: async (id: string) => {
        deleted.push(id);
      },
    },
  };
  const guild = {
    id: "g1",
    client: { user: { id: "bot" } },
    roles: { everyone: { id: "role-everyone" } },
    channels: { fetch: async () => channel },
  };
  return { guild, edits, deleted };
}

test("syncMeetupAccess keeps role overwrites and revokes stale members", async () => {
  const meetup = makeMeetup();
  const { guild, edits, deleted } = fakeGuild();
  await syncMeetupAccess(guild as never, meetup);

  expect(deleted).toEqual(["stale-user"]);
  expect(edits.some((edit) => edit.id === "role-admin")).toBe(false);
  expect(edits.find((edit) => edit.id === "host")?.options.ManageChannels).toBe(true);
  expect(edits.find((edit) => edit.id === "cohost")?.options.ManageChannels).toBeNull();
  expect(edits.find((edit) => edit.id === "approved-user")?.options.ViewChannel).toBe(true);
});

test("syncMeetupAccess removes channel management after archive", async () => {
  const meetup = makeMeetup();
  archiveMeetup(meetup);
  const archived = getMeetup(meetup.id)!;
  const { guild, edits } = fakeGuild();
  await syncMeetupAccess(guild as never, archived);

  expect(edits.find((edit) => edit.id === "host")?.options.ManageChannels).toBeNull();
  expect(edits.find((edit) => edit.id === "cohost")?.options.ManageChannels).toBeNull();
});
