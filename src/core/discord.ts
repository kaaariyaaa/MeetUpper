import {
  ChannelType,
  MessageFlags,
  OverwriteType,
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

const SETUP_REQUIRED_MESSAGE =
  "サーバーのセットアップが完了していません。管理者が `/meetup init` を実行してください。";

/** Discord hides channels the bot cannot view (name becomes "___hidden___"), so check by permission. */
function botCanView(guild: Guild, channel: GuildChannel): boolean {
  const me = guild.members.me;
  // ponytail: no cached self-member means we cannot judge; let creation proceed.
  if (!me) return true;
  return channel.permissionsFor(me).has(PermissionFlagsBits.ViewChannel);
}

function layoutPermissionGuidance(): string {
  return [
    `Bot が ${config.categoryName} カテゴリを閲覧できません。`,
    `サーバー管理者は ${config.categoryName} カテゴリの権限で Bot に「チャンネルを見る」「チャンネルを管理」を許可してから、\`/meetup init\` を再実行してください。`,
  ].join("\n");
}

/** Why the layout cannot be used: missing permission on the category, or setup not run yet. */
export function setupRequiredMessage(guild: Guild): string {
  const category = guild.channels.cache.find(
    (channel): channel is CategoryChannel =>
      channel.type === ChannelType.GuildCategory && channel.name === config.categoryName,
  );
  if (category && !botCanView(guild, category)) return layoutPermissionGuidance();
  return SETUP_REQUIRED_MESSAGE;
}

/** True when the MeetUp category, オフ会募集 forum and 招待 channel all exist. */
export async function isLayoutInitialized(guild: Guild): Promise<boolean> {
  const find = () => {
    const category = guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory && channel.name === config.categoryName,
    );
    if (!category) return false;
    const hasForum = guild.channels.cache.some(
      (channel) =>
        channel.parentId === category.id &&
        channel.type === ChannelType.GuildForum &&
        channel.name === config.forumName,
    );
    const hasInvite = guild.channels.cache.some(
      (channel) =>
        channel.parentId === category.id &&
        channel.type === ChannelType.GuildText &&
        channel.name === config.inviteName,
    );
    return hasForum && hasInvite;
  };
  if (find()) return true;
  await guild.channels.fetch().catch(() => undefined);
  return find();
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

  // Without ViewChannel the bot can neither see nor fix the channels it creates below the category.
  if (!botCanView(guild, category)) throw new Error(layoutPermissionGuidance());

  // Granting the bot access at creation time also survives later category permission changes.
  const botId = guild.client.user?.id;
  const botAccess = botId ? [{ id: botId, allow: [PermissionFlagsBits.ViewChannel] }] : [];

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
      permissionOverwrites: botAccess,
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
      permissionOverwrites: botAccess,
    });
  }

  // Report the layout as ready only when the bot can actually use it.
  for (const channel of [forum, inviteChannel]) {
    if (!botCanView(guild, channel)) throw new Error(layoutPermissionGuidance());
  }

  if (forum.position !== 0) await forum.setPosition(0).catch(() => undefined);
  if (inviteChannel.position !== 1) await inviteChannel.setPosition(1).catch(() => undefined);
  await applyLayoutPermissions(guild, forum, inviteChannel);
  return { category, forum, inviteChannel };
}

/** Re-applies the fixed forum/invite rules even when the channels already existed. */
async function applyLayoutPermissions(
  guild: Guild,
  forum: ForumChannel,
  inviteChannel: TextChannel,
): Promise<void> {
  const everyone = guild.roles.everyone;
  await forum.permissionOverwrites
    .edit(everyone, {
      ViewChannel: true,
      SendMessages: false,
      SendMessagesInThreads: true,
      ReadMessageHistory: true,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
    })
    .catch(() => undefined);
  await inviteChannel.permissionOverwrites
    .edit(everyone, {
      ViewChannel: true,
      SendMessages: false,
      CreatePrivateThreads: false,
      SendMessagesInThreads: true,
      ReadMessageHistory: true,
    })
    .catch(() => undefined);

  const me = guild.members.me;
  if (!me) return;
  await forum.permissionOverwrites
    .edit(me, {
      ViewChannel: true,
      SendMessages: true,
      SendMessagesInThreads: true,
      ReadMessageHistory: true,
      CreatePublicThreads: true,
      CreatePrivateThreads: true,
      ManageThreads: true,
    })
    .catch(() => undefined);
  await inviteChannel.permissionOverwrites
    .edit(me, {
      ViewChannel: true,
      SendMessages: true,
      SendMessagesInThreads: true,
      CreatePrivateThreads: true,
      ReadMessageHistory: true,
      ManageThreads: true,
    })
    .catch(() => undefined);
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
  await moveArchivedToBottom(guild, layout.category.id);
  return channel;
}

/** Keeps archived channels at the bottom of their category after a new channel is appended. */
async function moveArchivedToBottom(guild: Guild, categoryId: string): Promise<void> {
  const archived = childrenOf(guild, categoryId)
    .filter((channel) => isArchivedChannel(channel.name))
    .sort((a, b) => a.position - b.position);
  for (const channel of archived) {
    await channel.setPosition(9999).catch(() => undefined);
  }
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
  // ManageChannels is granted by the host only; cohosts get it from the guild role, not this channel.
  await channel.permissionOverwrites.edit(meetup.hostId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    ManageChannels: meetup.state === "ACTIVE" ? true : null,
  });
  for (const cohostId of listCohosts(meetup.id)) {
    await channel.permissionOverwrites
      .edit(cohostId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        ManageChannels: null,
      })
      .catch(() => undefined);
  }
  for (const userId of allowed) {
    if (userId === meetup.hostId || userId === botId) continue;
    await channel.permissionOverwrites
      .edit(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      })
      .catch(() => undefined);
  }
  // Preserve role overwrites added by server admins; only stale member overwrites are revoked.
  for (const [id, overwrite] of channel.permissionOverwrites.cache) {
    if (allowed.has(id) || id === guild.roles.everyone.id) continue;
    if (overwrite.type !== OverwriteType.Member) continue;
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
      ManageChannels: null,
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
  let thread: ThreadChannel | null = null;
  try {
    const layout = await ensureLayout(guild);
    thread = await layout.inviteChannel.threads.create({
      name: label.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
      autoArchiveDuration: 1440,
      reason: "招待DMの代替",
    });
    await thread.members.add(targetId);
    return thread;
  } catch {
    if (thread) await thread.delete().catch(() => undefined);
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
  if (interaction.deferred && !interaction.replied) {
    // Resolve the deferred reply instead of sending a second ephemeral message.
    const { flags: _flags, ...rest } = payload;
    await interaction.editReply(rest);
  } else if (interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

/** Acknowledges a slash command immediately so slow REST work cannot miss the 3s window. */
export async function deferEphemeral(interaction: RepliableInteraction): Promise<void> {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
