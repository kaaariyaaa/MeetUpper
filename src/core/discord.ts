import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type CategoryChannel,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildChannel,
  type GuildMember,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type RepliableInteraction,
  type TextChannel,
  type ThreadChannel,
  type User,
} from "discord.js";
import { config } from "../config.ts";
import type { Meetup } from "./types.ts";
import { listCohosts, listParticipants, updateMeetup } from "./meetup.ts";

const CATEGORY_CHANNEL_LIMIT = 50;

export interface GuildLayout {
  category: CategoryChannel;
  forum: ForumChannel;
  inviteChannel: TextChannel;
}

export async function ensureLayout(guild: Guild): Promise<GuildLayout> {
  let category = guild.channels.cache.find(
    (channel): channel is CategoryChannel =>
      channel.type === ChannelType.GuildCategory && channel.name === config.categoryName,
  );
  if (!category) {
    await guild.channels.fetch();
    category = guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory && channel.name === config.categoryName,
    );
  }
  if (!category) {
    category = await guild.channels.create({
      name: config.categoryName,
      type: ChannelType.GuildCategory,
    });
  }

  let forum = guild.channels.cache.find(
    (channel): channel is ForumChannel =>
      channel.parentId === category!.id &&
      channel.type === ChannelType.GuildForum &&
      channel.name === config.forumName,
  );
  if (!forum) {
    forum = await guild.channels.create({
      name: config.forumName,
      type: ChannelType.GuildForum,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads],
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ReadMessageHistory],
        },
      ],
    });
  }

  let inviteChannel = guild.channels.cache.find(
    (channel): channel is TextChannel =>
      channel.parentId === category!.id &&
      channel.type === ChannelType.GuildText &&
      channel.name === config.inviteName,
  );
  if (!inviteChannel) {
    inviteChannel = await guild.channels.create({
      name: config.inviteName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePrivateThreads],
        },
      ],
    });
  }

  if (forum.position !== 0) await forum.setPosition(0).catch(() => undefined);
  if (inviteChannel.position !== 1) await inviteChannel.setPosition(1).catch(() => undefined);
  return { category, forum, inviteChannel };
}

function childrenOf(guild: Guild, categoryId: string): GuildChannel[] {
  const result: GuildChannel[] = [];
  for (const channel of guild.channels.cache.values()) {
    if (channel.parentId !== categoryId || channel.isThread()) continue;
    result.push(channel as GuildChannel);
  }
  return result;
}

function isArchivedChannel(name: string): boolean {
  return name.startsWith("archive-");
}

async function findOrCreateTargetCategory(
  guild: Guild,
  pinnedIds: string[],
): Promise<CategoryChannel> {
  for (let n = 2; n < 100; n += 1) {
    const name = `${config.categoryName}-${n}`;
    let category = guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory && channel.name === name,
    );
    if (!category) {
      category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
      await category.setPosition(9999).catch(() => undefined);
      return category;
    }
    const count = childrenOf(guild, category.id).filter((c) => !pinnedIds.includes(c.id)).length;
    if (count < CATEGORY_CHANNEL_LIMIT) return category;
  }
  throw new Error("MeetUpカテゴリの空きを作れませんでした（MeetUp-Nの上限に到達）");
}

/** Moves archived channels first, then active meetup channels, until the source category has room. */
export async function ensureCategorySpace(
  guild: Guild,
  category: CategoryChannel,
  pinnedIds: string[],
): Promise<void> {
  let children = childrenOf(guild, category.id);
  while (children.length >= CATEGORY_CHANNEL_LIMIT) {
    const target = await findOrCreateTargetCategory(guild, pinnedIds);
    const candidates = children
      .filter((channel) => !pinnedIds.includes(channel.id))
      .sort((a, b) => {
        const archived = Number(isArchivedChannel(b.name)) - Number(isArchivedChannel(a.name));
        return archived !== 0 ? archived : a.position - b.position;
      });
    const movable = candidates[0];
    if (!movable) throw new Error("移動できるチャンネルがありません");
    await movable.setParent(target.id, { lockPermissions: false });
    children = childrenOf(guild, category.id);
  }
}

export async function createMeetupChannel(guild: Guild, meetup: Meetup): Promise<TextChannel> {
  const layout = await ensureLayout(guild);
  await ensureCategorySpace(guild, layout.category, [layout.forum.id, layout.inviteChannel.id]);

  const botId = guild.client.user?.id;
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: meetup.hostId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...(botId
      ? [
          {
            id: botId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ]
      : []),
  ];

  const channel = await guild.channels.create({
    name: channelSlug(meetup),
    type: ChannelType.GuildText,
    parent: layout.category.id,
    permissionOverwrites,
  });
  updateMeetup(meetup.id, { channelId: channel.id });
  return channel;
}

function channelSlug(meetup: Meetup): string {
  const cleaned = meetup.name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 80);
  return `meetup-${meetup.id}-${cleaned || "offkai"}`;
}

export async function getMeetupChannel(guild: Guild, meetup: Meetup): Promise<TextChannel | null> {
  if (!meetup.channelId) return null;
  const channel = await guild.channels.fetch(meetup.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

/** Re-applies channel access for host, cohosts and approved participants; revokes everyone else. */
export async function syncMeetupAccess(guild: Guild, meetup: Meetup): Promise<void> {
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return;
  const botId = guild.client.user?.id;
  const allowed = new Set<string>([meetup.hostId, ...listCohosts(meetup.id)]);
  for (const participant of listParticipants(meetup.id, ["APPROVED"])) allowed.add(participant.userId);
  if (botId) allowed.add(botId);

  await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
  await channel.permissionOverwrites.edit(meetup.hostId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: meetup.state === "ACTIVE",
  });
  for (const cohostId of listCohosts(meetup.id)) {
    await channel.permissionOverwrites.edit(cohostId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: meetup.state === "ACTIVE",
    });
  }
  for (const userId of allowed) {
    if (userId === meetup.hostId || userId === botId) continue;
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    });
  }
  for (const [id] of channel.permissionOverwrites.cache) {
    if (allowed.has(id) || id === guild.roles.everyone.id) continue;
    await channel.permissionOverwrites.delete(id).catch(() => undefined);
  }
}

export async function grantChannelAccess(guild: Guild, meetup: Meetup, userId: string): Promise<void> {
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return;
  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });
}

export async function revokeChannelAccess(guild: Guild, meetup: Meetup, userId: string): Promise<void> {
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return;
  await channel.permissionOverwrites.delete(userId).catch(() => undefined);
}

/** Renames with archive- prefix, removes host ManageChannels and moves the channel to the bottom. */
export async function archiveChannel(guild: Guild, meetup: Meetup): Promise<void> {
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return;
  if (!isArchivedChannel(channel.name)) {
    await channel.setName(`archive-${channel.name}`.slice(0, 100)).catch(() => undefined);
  }
  await channel.permissionOverwrites
    .edit(meetup.hostId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: false,
    })
    .catch(() => undefined);
  await channel.setPosition(9999).catch(() => undefined);
}

export async function moveChannelToBottom(channel: TextChannel): Promise<void> {
  await channel.setPosition(9999).catch(() => undefined);
}

/** Returns false when the user has DMs closed or shares no guild with the bot. */
export async function tryDM(
  client: Client,
  userId: string,
  payload: string | MessageCreateOptions,
): Promise<boolean> {
  try {
    const user: User = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

export async function createInviteThread(
  guild: Guild,
  targetId: string,
  label: string,
): Promise<ThreadChannel | null> {
  try {
    const layout = await ensureLayout(guild);
    const thread = await layout.inviteChannel.threads.create({
      name: label.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 1440,
      reason: "招待DMの代替",
    });
    await thread.members.add(targetId);
    return thread;
  } catch {
    return null;
  }
}

export async function deleteThread(thread: ThreadChannel | null | undefined): Promise<void> {
  if (!thread) return;
  await thread.delete().catch(() => undefined);
}

export async function replyEphemeral(
  interaction: RepliableInteraction,
  options: string | InteractionReplyOptions,
): Promise<void> {
  const payload: InteractionReplyOptions = typeof options === "string" ? { content: options } : options;
  payload.flags = MessageFlags.Ephemeral;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

export async function replyError(interaction: RepliableInteraction, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  try {
    await replyEphemeral(interaction, `エラー: ${message}`.slice(0, 1900));
  } catch {
    // interaction may already be gone
  }
}

export async function fetchMember(guild: Guild, userId: string): Promise<GuildMember | null> {
  return guild.members.fetch(userId).catch(() => null);
}

export async function sendToMeetupChannel(
  guild: Guild,
  meetup: Meetup,
  payload: string | MessageCreateOptions,
): Promise<boolean> {
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return false;
  try {
    await channel.send(payload);
    return true;
  } catch {
    return false;
  }
}
