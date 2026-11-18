import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(tmpdir(), `meetupper-browse-test-${process.pid}-${Date.now()}.db`);
const { db: testDb } = await import("../src/db.ts");
testDb.exec("DELETE FROM meetups");
process.env.DEFAULT_TIMEZONE = "Asia/Tokyo";

const { findButton, findSelectMenu, getSubcommands } = await import("../src/core/registry.ts");
const {
  canViewMeetup,
  meetupDetailComponents,
  meetupDetailEmbed,
  meetupsForFilter,
  membersPanel,
} = await import("../src/features/browse.ts");
const { createMeetup, setParticipantState } = await import("../src/core/meetup.ts");
type CreateMeetupInput = Parameters<typeof createMeetup>[0];

function newMeetup(overrides: Partial<CreateMeetupInput> = {}) {
  return createMeetup({
    guildId: "guild",
    hostId: "host",
    name: "テストmeetup",
    description: "test",
    capacity: 0,
    startAt: Date.now() + 24 * 60 * 60 * 1000,
    meetingAt: null,
    meetingPlace: "秘密の場所",
    mode: "PUBLIC",
    approvalMode: "HOST",
    requiredVotes: 1,
    eventEnabled: false,
    ...overrides,
  });
}

function componentIds(rows: { toJSON(): { components: unknown[] } }[]): string[] {
  return rows.flatMap((row) =>
    row
      .toJSON()
      .components.map((component) =>
        "custom_id" in (component as Record<string, unknown>)
          ? String((component as { custom_id: string }).custom_id)
          : "",
      ),
  );
}

test("browse subcommands and component ids are registered", () => {
  const names = getSubcommands().map((entry) => entry.name);
  expect(names).toEqual(expect.arrayContaining(["list", "show", "members"]));

  expect(findButton("browse:show:42")?.args).toEqual(["42"]);
  expect(findButton("browse:members:42")?.args).toEqual(["42"]);
  expect(findButton("browse:members-page:42:1")?.args).toEqual(["42", "1"]);
  expect(findButton("browse:list:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("browse:filter:abc123")?.args).toEqual(["abc123"]);
  expect(findSelectMenu("browse:pick:abc123")?.args).toEqual(["abc123"]);
  expect(findButton("browse:unknown:42")).toBeUndefined();
});

test("private meetups are visible only to the host side and invited/applying users", () => {
  const guildId = "g-visibility";
  const publicMeetup = newMeetup({ guildId });
  const privateMeetup = newMeetup({ guildId, mode: "PRIVATE" });

  expect(canViewMeetup(publicMeetup, "stranger")).toBe(true);
  expect(canViewMeetup(privateMeetup, "stranger")).toBe(false);
  expect(canViewMeetup(privateMeetup, "host")).toBe(true);

  setParticipantState(privateMeetup.id, "invited", "INVITED", { invitedBy: "host" });
  expect(canViewMeetup(privateMeetup, "invited")).toBe(true);
  setParticipantState(privateMeetup.id, "applied", "APPLIED");
  expect(canViewMeetup(privateMeetup, "applied")).toBe(true);

  setParticipantState(privateMeetup.id, "rejected", "REJECTED");
  expect(canViewMeetup(privateMeetup, "rejected")).toBe(false);
  setParticipantState(privateMeetup.id, "kicked", "KICKED");
  expect(canViewMeetup(privateMeetup, "kicked")).toBe(false);
});

test("dashboard filters split recruiting, joined and managed meetups", () => {
  const guildId = "g-filters";
  const managed = newMeetup({ guildId, hostId: "user" });
  const joined = newMeetup({ guildId });
  setParticipantState(joined.id, "user", "APPROVED", { approvedBy: "host" });
  const applied = newMeetup({ guildId });
  setParticipantState(applied.id, "user", "APPLIED");
  const other = newMeetup({ guildId });

  const ids = (filter: "recruiting" | "joined" | "managing") =>
    meetupsForFilter(guildId, "user", filter)
      .map((meetup) => meetup.id)
      .sort((a, b) => a - b);

  expect(ids("managing")).toEqual([managed.id]);
  expect(ids("joined")).toEqual([joined.id]);
  expect(ids("recruiting")).toEqual(
    [managed.id, joined.id, applied.id, other.id].sort((a, b) => a - b),
  );
});

test("detail buttons follow the actor's permissions and state", () => {
  const meetup = newMeetup({ guildId: "g-detail", hostId: "host" });

  const hostIds = componentIds(meetupDetailComponents(meetup, "host"));
  expect(hostIds).toEqual(
    expect.arrayContaining([
      `people:invite-open:${meetup.id}`,
      `browse:members:${meetup.id}`,
      `edit:open:${meetup.id}`,
      `ops:info-open:${meetup.id}`,
      `reminder:open:${meetup.id}`,
      `ops:archive-open:${meetup.id}`,
      `ops:cancel-open:${meetup.id}`,
    ]),
  );
  expect(hostIds).not.toContain(`apply:start:${meetup.id}`);
  expect(hostIds).not.toContain(`ops:leave-open:${meetup.id}`);

  const guestIds = componentIds(meetupDetailComponents(meetup, "guest"));
  expect(guestIds).toContain(`apply:start:${meetup.id}`);
  expect(guestIds).not.toContain(`people:invite-open:${meetup.id}`);
  expect(guestIds).not.toContain(`ops:cancel-open:${meetup.id}`);

  setParticipantState(meetup.id, "guest", "APPROVED", { approvedBy: "host" });
  const approvedIds = componentIds(meetupDetailComponents(meetup, "guest"));
  expect(approvedIds).toContain(`ops:leave-open:${meetup.id}`);
  expect(approvedIds).not.toContain(`apply:start:${meetup.id}`);

  const backIds = componentIds(meetupDetailComponents(meetup, "host", "sess1"));
  expect(backIds).toContain("browse:list:sess1");
});

test("detail embed hides the meeting place from people who are not approved", () => {
  const meetup = newMeetup({ guildId: "g-place" });
  const hostEmbed = meetupDetailEmbed(meetup, "host").toJSON();
  expect(hostEmbed.fields?.some((field) => field.name === "集合場所")).toBe(true);

  const outsiderEmbed = meetupDetailEmbed(meetup, "outsider").toJSON();
  expect(outsiderEmbed.fields?.some((field) => field.name === "集合場所")).toBe(false);
  expect(outsiderEmbed.footer?.text).toBe(`MeetUp ID: ${meetup.id}`);

  setParticipantState(meetup.id, "member", "APPROVED", { approvedBy: "host" });
  const approvedEmbed = meetupDetailEmbed(meetup, "member").toJSON();
  expect(approvedEmbed.fields?.some((field) => field.name === "集合場所")).toBe(true);
});

test("members panel groups states and paginates", () => {
  const meetup = newMeetup({ guildId: "g-members" });
  for (let index = 0; index < 12; index += 1) {
    setParticipantState(meetup.id, `m${String(index).padStart(2, "0")}`, "APPROVED", { approvedBy: "host" });
  }
  setParticipantState(meetup.id, "applicant", "APPLIED");

  const first = membersPanel(meetup, 0);
  expect(first.pages).toBe(2);
  expect(first.page).toBe(0);
  expect(first.embed.data.description).toContain("確定 12人 / 申請中 1人");
  expect(first.embed.data.description).toContain("APPROVED");
  expect(first.embed.data.description).toContain("<@m00>");
  expect(first.embed.data.footer?.text).toContain("ページ 1/2");

  const second = membersPanel(meetup, 1);
  expect(second.page).toBe(1);
  expect(second.embed.data.description).toContain("<@m11>");
  expect(second.embed.data.description).toContain("APPLIED");

  expect(membersPanel(meetup, 99).page).toBe(1);
});
