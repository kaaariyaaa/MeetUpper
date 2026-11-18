import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  type CategoryChannel,
  type ChatInputCommandInteraction,
  type Client,
  type ForumChannel,
  type Guild,
  type GuildBasedChannel,
  type GuildChannel,
  type GuildMember,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type RepliableInteraction,
  type TextChannel,
  type ThreadChannel,
  type User,
} from "discord.js";
import { db } from "../db.ts";
import { config } from "../config.ts";
import type { Meetup } from "./types.ts";
import {
  countApproved,
  findMeetupByChannelId,
  findMeetupByThreadId,
  getMeetup,
  listCohosts,
  listParticipants,
  updateMeetup,
} from "./meetup.ts";

const CATEGORY_CHANNEL_LIMIT = 50;

export interface GuildLayout {
  category: CategoryChannel;
  forum: ForumChannel;
  inviteChannel: TextChannel;
}

const SETUP_REQUIRED_MESSAGE =
  "サーバーのセットアップが完了していません。管理者が `/meetupper init` を実行してください。";

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
    `サーバー管理者は ${config.categoryName} カテゴリの権限で Bot に「チャンネルを見る」「チャンネルを管理」を許可してから、\`/meetupper init\` を再実行してください。`,
  ].join("\n");
}

/** Why the layout cannot be used: missing permission on the category, or setup not run yet. */
export function setupRequiredMessage(guild: Guild): string {
  const stored = readStoredLayout(guild.id);
  const tracked = stored ? guild.channels.cache.get(stored.category_id) : null;
  const category =
    tracked?.type === ChannelType.GuildCategory ? tracked : findCategoryByName(guild);
  if (category && !botCanView(guild, category)) return layoutPermissionGuidance();
  return SETUP_REQUIRED_MESSAGE;
}

function isForumName(name: string): boolean {
  return name === config.forumName || name === config.legacyForumName;
}

interface StoredLayout {
  category_id: string;
  forum_id: string;
  invite_channel_id: string;
}

function readStoredLayout(guildId: string): StoredLayout | null {
  const row = db
    .query("SELECT category_id, forum_id, invite_channel_id FROM guild_layouts WHERE guild_id = ?")
    .get(guildId) as StoredLayout | null;
  return row ?? null;
}

function saveStoredLayout(
  guildId: string,
  categoryId: string,
  forumId: string,
  inviteChannelId: string,
): void {
  db.query(
    `INSERT INTO guild_layouts (guild_id, category_id, forum_id, invite_channel_id, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET
       category_id = excluded.category_id,
       forum_id = excluded.forum_id,
       invite_channel_id = excluded.invite_channel_id,
       updated_at = excluded.updated_at`,
  ).run(guildId, categoryId, forumId, inviteChannelId, Date.now());
}

async function resolveChannelById(guild: Guild, id: string): Promise<GuildBasedChannel | null> {
  const cached = guild.channels.cache.get(id);
  if (cached) return cached;
  try {
    return await guild.channels.fetch(id);
  } catch (error) {
    // Only "unknown channel" means the stored channel is gone; other failures must not become duplicates.
    if (error instanceof DiscordAPIError && (error.code === 10003 || error.status === 404)) {
      return null;
    }
    throw new Error(layoutPermissionGuidance());
  }
}

function findCategoryByName(guild: Guild): CategoryChannel | null {
  return (
    guild.channels.cache.find(
      (channel): channel is CategoryChannel =>
        channel.type === ChannelType.GuildCategory && channel.name === config.categoryName,
    ) ?? null
  );
}

function findForumChannel(guild: Guild, categoryId?: string): ForumChannel | null {
  return (
    guild.channels.cache.find(
      (channel): channel is ForumChannel =>
        channel.type === ChannelType.GuildForum &&
        isForumName(channel.name) &&
        (categoryId === undefined || channel.parentId === categoryId),
    ) ?? null
  );
}

function findInviteChannel(guild: Guild, categoryId?: string): TextChannel | null {
  return (
    guild.channels.cache.find(
      (channel): channel is TextChannel =>
        channel.type === ChannelType.GuildText &&
        channel.name === config.inviteName &&
        (categoryId === undefined || channel.parentId === categoryId),
    ) ?? null
  );
}

/** True when the MeetUp category, MeetUp募集 forum and 招待 channel all exist. */
export async function isLayoutInitialized(guild: Guild): Promise<boolean> {
  const stored = readStoredLayout(guild.id);
  if (stored) {
    const [category, forum, invite] = await Promise.all([
      resolveChannelById(guild, stored.category_id),
      resolveChannelById(guild, stored.forum_id),
      resolveChannelById(guild, stored.invite_channel_id),
    ]);
    if (
      category?.type === ChannelType.GuildCategory &&
      forum?.type === ChannelType.GuildForum &&
      invite?.type === ChannelType.GuildText
    ) {
      return true;
    }
  }
  const find = () => {
    const category = findCategoryByName(guild);
    return (
      category !== null &&
      findForumChannel(guild, category.id) !== null &&
      findInviteChannel(guild, category.id) !== null
    );
  };
  if (find()) return true;
  await guild.channels.fetch().catch(() => undefined);
  return find();
}

/** Tells the meetup channel (host, cohosts and approved members) that someone joined. */
export async function announceJoin(
  guild: Guild,
  meetup: Meetup,
  userId: string,
  warning?: string,
): Promise<void> {
  const current = getMeetup(meetup.id) ?? meetup;
  const sent = await sendToMeetupChannel(guild, current, {
    content: `<@${userId}> が参加しました（確定 ${countApproved(current.id)}人）${warning ? `\n${warning}` : ""}`,
  });
  if (!sent) console.error(`参加通知を送信できませんでした: meetup=${meetup.id}`);
}

/** The meetup owning a channel: its dedicated channel, a thread in it, or the recruitment thread. */
export function meetupFromChannel(
  channel: { id: string; isThread?: () => boolean; parentId?: string | null } | null,
): Meetup | null {
  if (!channel) return null;
  if (channel.isThread?.()) {
    const parentId = channel.parentId ?? null;
    return findMeetupByThreadId(channel.id) ?? (parentId ? findMeetupByChannelId(parentId) : null);
  }
  return findMeetupByChannelId(channel.id);
}

/** Meetup owning the channel/thread the command was run in, without the id option. */
export function meetupFromInteraction(interaction: ChatInputCommandInteraction): Meetup | null {
  return (
    meetupFromChannel(interaction.channel) ??
    findMeetupByThreadId(interaction.channelId) ??
    findMeetupByChannelId(interaction.channelId)
  );
}

/** Resolves the subcommand's meetup from the optional `meetup` id or the channel it was run in. */
export function resolveTargetMeetup(guild: Guild, interaction: ChatInputCommandInteraction): Meetup {
  const id = interaction.options.getInteger("meetup");
  if (id !== null) {
    const meetup = getMeetup(id);
    if (!meetup || meetup.guildId !== guild.id) throw new Error("MeetUpが見つかりません。");
    return meetup;
  }
  const meetup = meetupFromInteraction(interaction);
  if (!meetup || meetup.guildId !== guild.id) {
    throw new Error(
      "MeetUp IDを指定するか、MeetUpの専用チャンネルまたは募集スレッド内で実行してください。",
    );
  }
  return meetup;
}

const layoutInFlight = new Map<string, Promise<GuildLayout>>();

export function ensureLayout(guild: Guild): Promise<GuildLayout> {
  const running = layoutInFlight.get(guild.id);
  if (running) return running;
  const promise = ensureLayoutInner(guild).finally(() => layoutInFlight.delete(guild.id));
  layoutInFlight.set(guild.id, promise);
  return promise;
}

async function ensureLayoutInner(guild: Guild): Promise<GuildLayout> {
  requireLayoutPermissions(guild);
  const stored = readStoredLayout(guild.id);

  let category: CategoryChannel | null = null;
  if (stored) {
    const resolved = await resolveChannelById(guild, stored.category_id);
    if (resolved?.type === ChannelType.GuildCategory) category = resolved;
  }
  if (!category) {
    category = findCategoryByName(guild);
    if (!category) {
      await guild.channels.fetch().catch(() => undefined);
      category = findCategoryByName(guild);
    }
  }
  if (!category) {
    category = await guild.channels.create({
      name: config.categoryName,
      type: ChannelType.GuildCategory,
    });
  }

  // Without ViewChannel the bot can neither see nor fix the channels it creates below the category.
  if (!botCanView(guild, category)) throw new Error(layoutPermissionGuidance());

  // The layout rules live on the category; channels that stay there inherit them.
  await applyLayoutPermissions(guild, category);

  let forum: ForumChannel | null = null;
  let adoptedForumByName = false;
  if (stored) {
    const resolved = await resolveChannelById(guild, stored.forum_id);
    if (resolved?.type === ChannelType.GuildForum) forum = resolved;
  }
  if (!forum) {
    // A tracked row must not adopt an unrelated same-named channel; only a first-time setup may.
    forum = stored ? null : findForumChannel(guild, category.id);
    if (!forum && !stored) {
      await guild.channels.fetch().catch(() => undefined);
      forum = findForumChannel(guild, category.id);
    }
    if (forum) adoptedForumByName = true;
  }
  if (!forum) {
    forum = await guild.channels.create({
      name: config.forumName,
      type: ChannelType.GuildForum,
      parent: category.id,
    });
  }

  // Legacy names are migrated only when the channel was adopted by name, not when its id is tracked.
  if (adoptedForumByName && forum.name !== config.forumName) {
    await forum.setName(config.forumName).catch(() => undefined);
  }

  let inviteChannel: TextChannel | null = null;
  if (stored) {
    const resolved = await resolveChannelById(guild, stored.invite_channel_id);
    if (resolved?.type === ChannelType.GuildText) inviteChannel = resolved;
  }
  if (!inviteChannel) {
    inviteChannel = stored ? null : findInviteChannel(guild, category.id);
    if (!inviteChannel && !stored) {
      await guild.channels.fetch().catch(() => undefined);
      inviteChannel = findInviteChannel(guild, category.id);
    }
  }
  if (!inviteChannel) {
    inviteChannel = await guild.channels.create({
      name: config.inviteName,
      type: ChannelType.GuildText,
      parent: category.id,
    });
  }

  if (
    !stored ||
    stored.category_id !== category.id ||
    stored.forum_id !== forum.id ||
    stored.invite_channel_id !== inviteChannel.id
  ) {
    saveStoredLayout(guild.id, category.id, forum.id, inviteChannel.id);
  }

  for (const channel of [forum, inviteChannel]) {
    if (channel.parentId === category.id) {
      // Inherit the category rules so future category edits keep applying.
      if (channel.permissionOverwrites.cache.size > 0) {
        await channel.permissionOverwrites.set([]).catch(() => undefined);
      }
    } else {
      // Moved out of the layout category: apply only the fixed rules directly on the channel.
      await channel.permissionOverwrites
        .edit(guild.roles.everyone, LAYOUT_EVERYONE_PERMISSIONS)
        .catch(() => undefined);
      if (guild.members.me) {
        await channel.permissionOverwrites
          .edit(guild.members.me, LAYOUT_BOT_PERMISSIONS)
          .catch(() => undefined);
      }
    }
    if (!botCanView(guild, channel)) throw new Error(layoutPermissionGuidance());
  }

  // Never drag a deliberately moved channel back; only order the channels still in the category.
  if (forum.parentId === category.id && forum.position !== 0) {
    await forum.setPosition(0).catch(() => undefined);
  }
  if (inviteChannel.parentId === category.id && inviteChannel.position !== 1) {
    await inviteChannel.setPosition(1).catch(() => undefined);
  }
  return { category, forum, inviteChannel };
}

const LAYOUT_EVERYONE_PERMISSIONS = {
  ViewChannel: true,
  SendMessages: false,
  SendMessagesInThreads: true,
  ReadMessageHistory: true,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
};

const LAYOUT_BOT_PERMISSIONS = {
  ViewChannel: true,
  SendMessages: true,
  SendMessagesInThreads: true,
  ReadMessageHistory: true,
  CreatePublicThreads: true,
  CreatePrivateThreads: true,
  ManageThreads: true,
};

/**
 * Discord rejects an overwrite that touches a permission the bot does not hold itself, which silently
 * broke the whole layout setup. Fail with the missing permission instead.
 */
function requireLayoutPermissions(guild: Guild): void {
  const me = guild.members.me;
  if (!me) return;
  const missing = new Set<string>();
  for (const options of [LAYOUT_EVERYONE_PERMISSIONS, LAYOUT_BOT_PERMISSIONS]) {
    for (const key of Object.keys(options) as (keyof typeof PermissionFlagsBits)[]) {
      if (!me.permissions.has(PermissionFlagsBits[key])) missing.add(key);
    }
  }
  if (missing.size > 0) {
    throw new Error(
      `Bot に不足している権限があります: ${[...missing].join(", ")}。` +
        "サーバー設定のロールで MeetUpper に付与してから、もう一度 /meetupper init を実行してください。",
    );
  }
}

/** Re-applies the fixed layout rules to the category, which every channel below it inherits. */
async function applyLayoutPermissions(guild: Guild, category: CategoryChannel): Promise<void> {
  await category.permissionOverwrites.edit(guild.roles.everyone, LAYOUT_EVERYONE_PERMISSIONS);
  const me = guild.members.me;
  if (me) await category.permissionOverwrites.edit(me, LAYOUT_BOT_PERMISSIONS);
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

export function channelSlug(meetup: Meetup): string {
  const cleaned = meetup.name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .slice(0, 100);
  // Discord requires 2-100 characters for channel names.
  return cleaned.length >= 2 ? cleaned : "offkai";
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

/** Locks and archives the Public recruitment thread when the MeetUp is archived. */
export async function closeRecruitmentThread(guild: Guild, meetup: Meetup): Promise<void> {
  if (meetup.mode !== "PUBLIC" || !meetup.forumThreadId) return;
  const thread = await guild.channels.fetch(meetup.forumThreadId).catch(() => null);
  if (!thread || !thread.isThread()) return;
  await thread.setLocked(true).catch(() => undefined);
  await thread.setArchived(true).catch(() => undefined);
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
    await user.send(typeof payload === "string" ? { embeds: [messageEmbed(payload)] } : withEmbed(payload));
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

const MESSAGE_COLOR = 0x5865f2;

/** Bot text is always rendered as an embed. */
export function messageEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder().setColor(MESSAGE_COLOR).setDescription(text.slice(0, 4000));
}

/** Plain-text payloads become embeds; payloads that already carry embeds are left alone. */
function withEmbed<T extends { content?: string | null; embeds?: readonly unknown[] }>(payload: T): T {
  if (!payload.content || (payload.embeds?.length ?? 0) > 0) return payload;
  const { content, ...rest } = payload;
  return { ...rest, embeds: [messageEmbed(content)] } as unknown as T;
}

export async function replyEphemeral(
  interaction: RepliableInteraction,
  options: string | InteractionReplyOptions,
): Promise<void> {
  const payload: InteractionReplyOptions =
    typeof options === "string" ? { embeds: [messageEmbed(options)] } : withEmbed(options);
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
    await channel.send(typeof payload === "string" ? { embeds: [messageEmbed(payload)] } : withEmbed(payload));
    return true;
  } catch {
    return false;
  }
}
