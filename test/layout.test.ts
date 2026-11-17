import { expect, test } from "bun:test";
import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH ??= join(tmpdir(), `meetupper-layout-test-${process.pid}-${Date.now()}.db`);

const { channelSlug, ensureLayout, isLayoutInitialized, setupRequiredMessage } = await import(
  "../src/core/discord.ts"
);

const VIEW = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
const NONE = new PermissionsBitField([]);
const me = { id: "bot" };

function makeChannel(data: { id: string; name: string; type: ChannelType; parentId: string | null }, viewable: boolean) {
  return {
    ...data,
    position: 0,
    permissionOverwrites: {
      cache: new Collection<string, unknown>(),
      edit: async () => undefined,
      delete: async () => undefined,
    },
    permissionsFor: () => (viewable ? VIEW : NONE),
    setPosition: async () => undefined,
  };
}

function makeGuild() {
  const cache = new Collection<string, ReturnType<typeof makeChannel>>();
  const created: { type: ChannelType; name: string; parent?: string; permissionOverwrites?: unknown[] }[] = [];
  let id = 0;
  const guild = {
    id: "g1",
    client: { user: { id: "bot" } },
    roles: { everyone: { id: "everyone" } },
    members: { me },
    channels: {
      cache,
      fetch: async () => cache,
      create: async (data: { name: string; type: ChannelType; parent?: string; permissionOverwrites?: unknown[] }) => {
        created.push(data);
        const channel = makeChannel(
          { id: `c${(id += 1)}`, name: data.name, type: data.type, parentId: data.parent ?? null },
          true,
        );
        cache.set(channel.id, channel);
        return channel;
      },
    },
  };
  return { guild: guild as never, created, cache };
}

test("init refuses to create channels in a category the bot cannot view", async () => {
  const { guild, created, cache } = makeGuild();
  cache.set(
    "cat",
    makeChannel({ id: "cat", name: "MeetUp", type: ChannelType.GuildCategory, parentId: null }, false),
  );

  await expect(ensureLayout(guild)).rejects.toThrow("チャンネルを見る");
  expect(created).toHaveLength(0);
  expect(setupRequiredMessage(guild)).toContain("チャンネルを見る");
});

test("init creates a layout the bot can use and grants itself access at creation", async () => {
  const { guild, created } = makeGuild();

  await ensureLayout(guild);

  expect(created.map((channel) => channel.type)).toEqual([
    ChannelType.GuildCategory,
    ChannelType.GuildForum,
    ChannelType.GuildText,
  ]);
  for (const channel of created.slice(1)) {
    expect(channel.permissionOverwrites?.[0]).toEqual({
      id: "bot",
      allow: [PermissionFlagsBits.ViewChannel],
    });
  }
  expect(await isLayoutInitialized(guild)).toBe(true);
  expect(setupRequiredMessage(guild)).toContain("/meetup init");
});

test("meetup channel names are the meetup name only", () => {
  const name = (value: string) => channelSlug({ name: value } as never);
  expect(name(" 東京 オフ会 ")).toBe("東京-オフ会");
  expect(name("test!")).toBe("test");
  expect(name("")).toBe("offkai");
  expect(name("x")).toBe("offkai");
});
