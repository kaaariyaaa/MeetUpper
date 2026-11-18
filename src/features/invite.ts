import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  type ButtonInteraction,
  type Guild,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import {
  announceJoin,
  createInviteThread,
  deferEphemeral,
  deleteThread,
  fetchMember,
  meetupFromInteraction,
  messageEmbed,
  replyEphemeral,
  replyError,
  sendDM,
  sendToMeetupChannel,
  sendToMeetupChannelMessage,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
import { recordParticipationMessage } from "../core/participation.ts";
import {
  approveParticipant,
  canManage,
  countApproved,
  createInviteRequest,
  decideInviteRequest,
  deleteParticipant,
  getInviteRequest,
  getMeetup,
  getParticipant,
  hasPendingInviteRequest,
  listCohosts,
  listMeetups,
  setParticipantState,
} from "../core/meetup.ts";
import { button, selectMenu, subcommand } from "../core/registry.ts";
import type { InviteRequest, Meetup } from "../core/types.ts";
import {
  confirmButtons,
  createUiSession,
  dropUiSession,
  getUiSession,
  meetupNavRow,
  meetupSelectRow,
  selectedNumber,
  userSelectRow,
  type UiSession,
} from "../core/ui.ts";
import { meetupEmbed } from "../core/views.ts";

type InviteDelivery = "DM" | "THREAD" | "FAILED";

/** Invite card: never exposes the meeting place, even to the invitee before approval. */
export function inviteEmbed(meetup: Meetup, inviterId: string): EmbedBuilder {
  const embed = meetupEmbed(meetup);
  const description = embed.data.description ?? "";
  return embed
    .setDescription(`${description}\n\n<@${inviterId}> さんから招待されています。`.slice(0, 4000))
    .setFooter({ text: `MeetUp ID: ${meetup.id}` });
}

function inviteComponents(meetup: Meetup): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`invite:accept:${meetup.id}`)
        .setLabel("参加する")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`invite:decline:${meetup.id}`)
        .setLabel("参加しない")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function requestComponents(requestId: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`invite:approve:${requestId}`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`invite:reject:${requestId}`)
        .setLabel("却下")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function adminMentions(meetup: Meetup): string {
  return [meetup.hostId, ...listCohosts(meetup.id)].map((id) => `<@${id}>`).join(" ");
}

function deliveryLabel(delivery: InviteDelivery): string {
  switch (delivery) {
    case "DM":
      return "招待DMを送信しました";
    case "THREAD":
      return "招待用のプライベートスレッドを作成しました";
    case "FAILED":
      return "招待の送信に失敗しました";
  }
}

/** DM first; on failure a private thread in the invite channel; then notify the host side. */
async function deliverInvite(
  guild: Guild,
  meetup: Meetup,
  targetId: string,
  inviterId: string,
): Promise<InviteDelivery> {
  const embeds = [inviteEmbed(meetup, inviterId)];
  const components = inviteComponents(meetup);

  const message = await sendDM(guild.client, targetId, { embeds, components });
  if (message) {
    recordParticipationMessage(meetup.id, "invite", message.channelId, message.id);
    return "DM";
  }

  const thread = await createInviteThread(guild, targetId, `招待-${meetup.id}-${targetId.slice(-4)}`);
  if (thread) {
    try {
      const sent = await thread.send({
        content: `<@${targetId}> さん、招待が届いています。`,
        embeds,
        components,
      });
      recordParticipationMessage(meetup.id, "invite", thread.id, sent.id);
      return "THREAD";
    } catch {
      await deleteThread(thread);
    }
  }

  await sendToMeetupChannel(
    guild,
    meetup,
    `${adminMentions(meetup)}\n招待失敗: <@${targetId}> にDMもスレッドも送信できませんでした`,
  );
  return "FAILED";
}

async function notifyRequester(
  interaction: ButtonInteraction,
  guild: Guild,
  meetup: Meetup,
  request: InviteRequest,
  text: string,
): Promise<void> {
  const sent = await tryDM(interaction.client, request.requesterId, `<@${request.targetId}> の${text}`);
  if (!sent) {
    await sendToMeetupChannel(guild, meetup, `<@${request.requesterId}> ${text}`);
  }
}

function privateThreadOf(interaction: ButtonInteraction) {
  const channel = interaction.channel;
  return channel && channel.type === ChannelType.PrivateThread ? channel : null;
}

interface InviteFlowData {
  meetupId: number | null;
  targetId?: string;
}

const EXPIRED_MESSAGE = "この操作は期限切れです。もう一度コマンドからやり直してください。";

/** Host/cohost invites directly; an approved participant routes through host approval. */
export function canInvite(meetup: Meetup, userId: string): boolean {
  return canManage(meetup, userId) || getParticipant(meetup.id, userId)?.state === "APPROVED";
}

const INVITE_PERMISSION_MESSAGE =
  "参加確定者のみ招待できます（主催者・共同主催者は直接招待できます）";

/** Why this target cannot be invited by this actor, or null when allowed. */
export function inviteTargetDenial(
  meetup: Meetup,
  actorId: string,
  target: { id: string; bot?: boolean },
): string | null {
  if (!canInvite(meetup, actorId)) return INVITE_PERMISSION_MESSAGE;
  if (target.id === actorId) return "自分自身を招待することはできません";
  if (target.bot) return "Botを招待することはできません";
  if (target.id === meetup.hostId) return "主催者はすでに参加しています";
  if (listCohosts(meetup.id).includes(target.id)) return "共同主催者はすでに参加しています";
  const existing = getParticipant(meetup.id, target.id)?.state;
  if (existing === "APPROVED") return "すでに参加が確定しています";
  if (existing === "INVITED") return "すでに招待済みです";
  if (existing === "APPLIED") return "すでに参加申請中です";
  return null;
}

function userSelectPanel(meetup: Meetup, sessionId: string) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("招待するメンバーを選択")
        .setColor(0x5865f2)
        .setDescription(`「${meetup.name}」に招待するメンバーを選択してください。`),
    ],
    components: [userSelectRow(`people:invite-target:${sessionId}`)],
  };
}

function confirmationPanel(meetup: Meetup, targetId: string, actorId: string, sessionId: string) {
  const direct = canManage(meetup, actorId);
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("招待の確認")
        .setColor(0xf1c40f)
        .setDescription(
          [
            `<@${targetId}> を「${meetup.name}」に招待します。`,
            direct
              ? "招待DMを送信します（届かない場合は招待チャンネルのプライベートスレッドに投稿します）。"
              : "参加確定者からの招待のため、主催者へ招待申請を送ります。",
          ].join("\n"),
        )
        .addFields(
          { name: "MeetUp", value: meetup.name, inline: true },
          { name: "対象", value: `<@${targetId}>`, inline: true },
        ),
    ],
    components: [
      confirmButtons(
        `people:invite-confirm:${sessionId}`,
        `people:invite-cancel:${sessionId}`,
        "招待する",
        "キャンセル",
      ),
    ],
  };
}

async function openInvitePanel(
  interaction: RepliableInteraction,
  meetup: Meetup,
): Promise<void> {
  const session = createUiSession<InviteFlowData>({
    ownerId: interaction.user.id,
    guildId: meetup.guildId,
    meetupId: meetup.id,
    data: { meetupId: meetup.id },
  });
  await replyEphemeral(interaction, userSelectPanel(meetup, session.id));
}

async function openMeetupPicker(interaction: RepliableInteraction, guild: Guild): Promise<void> {
  const choices = listMeetups(guild.id, ["ACTIVE"]).filter((meetup) =>
    canInvite(meetup, interaction.user.id),
  );
  if (choices.length === 0) {
    await replyEphemeral(interaction, "招待できるMeetUpがありません");
    return;
  }
  const session = createUiSession<InviteFlowData>({
    ownerId: interaction.user.id,
    guildId: guild.id,
    meetupId: null,
    data: { meetupId: null },
  });
  await replyEphemeral(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle("MeetUpを選択")
        .setColor(0x5865f2)
        .setDescription("招待するMeetUpを選択してください。"),
    ],
    components: [meetupSelectRow(`people:invite-meetup:${session.id}`, choices.map((meetup) => ({ meetup })))],
  });
}

async function submitInviteRequest(
  guild: Guild,
  meetup: Meetup,
  requesterId: string,
  targetId: string,
): Promise<boolean> {
  if (hasPendingInviteRequest(meetup.id, targetId)) return false;
  const request = createInviteRequest(meetup.id, requesterId, targetId);
  const message = await sendToMeetupChannelMessage(guild, meetup, {
    content: `${adminMentions(meetup)}\n<@${requesterId}> さんから招待申請が届きました。`,
    embeds: [
      new EmbedBuilder()
        .setTitle("招待申請")
        .setColor(0xf1c40f)
        .addFields(
          { name: "申請者", value: `<@${request.requesterId}>`, inline: true },
          { name: "招待対象", value: `<@${request.targetId}>`, inline: true },
          { name: "meetup", value: meetup.name, inline: true },
        ),
    ],
    components: requestComponents(request.id),
  });
  if (!message) {
    decideInviteRequest(request.id, "REJECTED", requesterId);
    return false;
  }
  recordParticipationMessage(meetup.id, "invite_request", message.channelId, message.id);
  return true;
}

function meetupForSession(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction,
  session: UiSession<InviteFlowData>,
): Meetup | null {
  const guild = interaction.guild;
  const meetup = session.data.meetupId === null ? null : getMeetup(session.data.meetupId);
  return guild && meetup && meetup.guildId === guild.id ? meetup : null;
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("invite")
    .setDescription("メンバーをMeetUpに招待します")
    .addIntegerOption((option) =>
      option
        .setName("meetup")
        .setDescription("MeetUp ID（専用チャンネル内なら省略可）")
        .setMinValue(1),
    ),
  async (interaction) => {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await replyEphemeral(interaction, "サーバー内でのみ実行できます");
        return;
      }
      await deferEphemeral(interaction);

      const id = interaction.options.getInteger("meetup");
      const context = id === null ? meetupFromInteraction(interaction) : null;
      const meetup = id !== null ? getMeetup(id) : context;
      if (id !== null && (!meetup || meetup.guildId !== guild.id)) {
        await replyEphemeral(interaction, "MeetUpが見つかりません");
        return;
      }
      if (meetup) {
        if (meetup.guildId !== guild.id) {
          await replyEphemeral(interaction, "MeetUpが見つかりません");
          return;
        }
        if (meetup.state !== "ACTIVE") {
          await replyEphemeral(interaction, "終了または中止されたMeetUpには招待できません");
          return;
        }
        if (!canInvite(meetup, interaction.user.id)) {
          await replyEphemeral(interaction, INVITE_PERMISSION_MESSAGE);
          return;
        }
        await openInvitePanel(interaction, meetup);
        return;
      }
      await openMeetupPicker(interaction, guild);
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

button(/^people:invite-open:(\d+)$/, async (interaction, args) => {
  try {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, "サーバー内でのみ実行できます");
      return;
    }
    const meetup = getMeetup(Number(args[0] ?? ""));
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "終了または中止されたMeetUpには招待できません");
      return;
    }
    if (!canInvite(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, INVITE_PERMISSION_MESSAGE);
      return;
    }
    await openInvitePanel(interaction, meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^people:invite-meetup:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<InviteFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    const guild = interaction.guild;
    const meetupId = selectedNumber(interaction);
    const meetup = meetupId === null ? null : getMeetup(meetupId);
    if (
      !guild ||
      !meetup ||
      meetup.guildId !== guild.id ||
      meetup.state !== "ACTIVE" ||
      !canInvite(meetup, interaction.user.id)
    ) {
      await replyEphemeral(interaction, "このMeetUpには招待できません");
      return;
    }
    session.meetupId = meetup.id;
    session.data = { meetupId: meetup.id };
    await interaction.update(userSelectPanel(meetup, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^people:invite-target:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<InviteFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    const meetup = meetupForSession(interaction, session);
    if (!meetup || meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "このMeetUpには招待できません");
      return;
    }
    const target = (interaction as unknown as UserSelectMenuInteraction).users.first();
    if (!target) {
      await replyEphemeral(interaction, "対象のメンバーを選択してください");
      return;
    }
    const denial = inviteTargetDenial(meetup, interaction.user.id, target);
    if (denial) {
      await interaction.update({
        embeds: [messageEmbed(denial)],
        components: [userSelectRow(`people:invite-target:${session.id}`)],
      });
      return;
    }
    session.data = { meetupId: meetup.id, targetId: target.id };
    await interaction.update(
      confirmationPanel(meetup, target.id, interaction.user.id, session.id),
    );
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^people:invite-confirm:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<InviteFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const guild = interaction.guild;
    const meetup = session.data.meetupId === null ? null : getMeetup(session.data.meetupId);
    if (!guild || !meetup || meetup.guildId !== guild.id || meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "このMeetUpには招待できません");
      return;
    }
    const targetId = session.data.targetId;
    if (!targetId) {
      await replyEphemeral(interaction, "招待するメンバーを選択してください");
      return;
    }
    const target = await interaction.client.users.fetch(targetId).catch(() => null);
    if (!target) {
      dropUiSession(session.id);
      await interaction.editReply({
        embeds: [messageEmbed("対象のユーザーが見つかりません")],
        components: [],
      });
      return;
    }
    const denial = inviteTargetDenial(meetup, interaction.user.id, target);
    if (denial) {
      dropUiSession(session.id);
      await interaction.editReply({ embeds: [messageEmbed(denial)], components: [] });
      return;
    }

    dropUiSession(session.id);
    if (canManage(meetup, interaction.user.id)) {
      const previous = getParticipant(meetup.id, targetId);
      setParticipantState(meetup.id, targetId, "INVITED", { invitedBy: interaction.user.id });
      const delivery = await deliverInvite(guild, meetup, targetId, interaction.user.id);
      if (delivery === "FAILED") {
        // A failed delivery must not lock the target into 招待中 forever.
        if (previous) setParticipantState(meetup.id, targetId, previous.state);
        else deleteParticipant(meetup.id, targetId);
      }
      const detail =
        delivery === "DM"
          ? "招待DMを送信しました"
          : delivery === "THREAD"
            ? "DMを送信できなかったため、招待チャンネルのプライベートスレッドで招待しました"
            : "DMもスレッドも送信できませんでした";
      await interaction.editReply({
        embeds: [messageEmbed(`<@${targetId}> への${detail}`)],
        components: [meetupNavRow(meetup.id)],
      });
      return;
    }

    if (getParticipant(meetup.id, interaction.user.id)?.state !== "APPROVED") {
      await interaction.editReply({
        embeds: [messageEmbed(INVITE_PERMISSION_MESSAGE)],
        components: [],
      });
      return;
    }
    if (hasPendingInviteRequest(meetup.id, targetId)) {
      await interaction.editReply({
        embeds: [messageEmbed("この対象への招待申請はすでに承認待ちです")],
        components: [],
      });
      return;
    }
    const sent = await submitInviteRequest(guild, meetup, interaction.user.id, targetId);
    await interaction.editReply({
      embeds: [
        messageEmbed(
          sent
            ? "主催者へ招待申請を送りました"
            : "招待申請を専用チャンネルへ投稿できませんでした。主催者へ直接確認してください。",
        ),
      ],
      components: [meetupNavRow(meetup.id)],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^people:invite-cancel:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<InviteFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    dropUiSession(session.id);
    await interaction.update({
      embeds: [messageEmbed("招待をキャンセルしました")],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^invite:accept:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0] ?? ""));
    if (!meetup) {
      await replyEphemeral(interaction, "MeetUpが見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "このMeetUpは現在参加を受け付けていません");
      return;
    }
    if (getParticipant(meetup.id, interaction.user.id)?.state !== "INVITED") {
      await replyEphemeral(interaction, "招待が見つかりません");
      return;
    }

    const guild = interaction.guild ?? interaction.client.guilds.cache.get(meetup.guildId) ?? null;
    await interaction.deferUpdate();
    if (guild && !(await fetchMember(guild, interaction.user.id))) {
      await interaction.editReply({
        embeds: [messageEmbed("サーバーに参加していないため、この招待には参加できません。")],
        components: [],
      });
      return;
    }

    approveParticipant(meetup, interaction.user.id, "invite");
    const overCapacity = meetup.capacity > 0 && countApproved(meetup.id) > meetup.capacity;
    await interaction.editReply({
      embeds: [messageEmbed(`参加が確定しました${overCapacity ? "\n⚠️ 定員を超えています。主催者へ確認してください。" : ""}`)],
      components: [],
    });
    if (guild) {
      await syncMeetupAccess(guild, getMeetup(meetup.id)!).catch((error) =>
        console.error("参加者の権限同期に失敗しました", error),
      );
      await announceJoin(
        guild,
        meetup,
        interaction.user.id,
        overCapacity ? "⚠️ 定員を超えています。主催者へ確認してください。" : undefined,
      );
    }
    await deleteThread(privateThreadOf(interaction));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^invite:decline:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0] ?? ""));
    if (!meetup) {
      await replyEphemeral(interaction, "MeetUpが見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "このMeetUpは現在参加を受け付けていません");
      return;
    }
    if (getParticipant(meetup.id, interaction.user.id)?.state !== "INVITED") {
      await replyEphemeral(interaction, "招待が見つかりません");
      return;
    }

    await interaction.deferUpdate();
    setParticipantState(meetup.id, interaction.user.id, "DECLINED");
    await interaction.editReply({
      embeds: [messageEmbed(`招待を辞退しました。後から参加申請する場合は /meetupper apply meetup:${meetup.id} を実行してください。`)],
      components: [],
    });
    await deleteThread(privateThreadOf(interaction));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^invite:approve:(\d+)$/, async (interaction, args) => {
  try {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, "サーバー内でのみ操作できます");
      return;
    }
    const request = getInviteRequest(Number(args[0] ?? ""));
    if (!request) {
      await replyEphemeral(interaction, "招待申請が見つかりません");
      return;
    }
    const meetup = getMeetup(request.meetupId);
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "終了または中止されたMeetUpでは操作できません");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ操作できます");
      return;
    }
    if (request.status !== "PENDING") {
      await replyEphemeral(interaction, "この招待申請はすでに処理済みです");
      return;
    }
    const existing = getParticipant(meetup.id, request.targetId)?.state;
    if (existing === "APPROVED" || existing === "INVITED") {
      await replyEphemeral(interaction, `<@${request.targetId}> はすでに参加確定または招待中です`);
      return;
    }

    await interaction.deferUpdate();
    if (decideInviteRequest(request.id, "APPROVED", interaction.user.id) === 0) {
      await interaction.editReply({
        embeds: [messageEmbed("この招待申請はすでに処理済みです")],
        components: [],
      });
      return;
    }
    const previous = getParticipant(meetup.id, request.targetId);
    setParticipantState(meetup.id, request.targetId, "INVITED", {
      invitedBy: request.requesterId,
    });
    const delivery = await deliverInvite(guild, meetup, request.targetId, request.requesterId);
    if (delivery === "FAILED") {
      if (previous) setParticipantState(meetup.id, request.targetId, previous.state);
      else deleteParticipant(meetup.id, request.targetId);
    }
    await notifyRequester(
      interaction,
      guild,
      meetup,
      request,
      `招待申請が承認されました。${deliveryLabel(delivery)}`,
    );
    await interaction.editReply({
      embeds: [messageEmbed(`招待申請を承認しました。${deliveryLabel(delivery)}（対象: <@${request.targetId}>）`)],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^invite:reject:(\d+)$/, async (interaction, args) => {
  try {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, "サーバー内でのみ操作できます");
      return;
    }
    const request = getInviteRequest(Number(args[0] ?? ""));
    if (!request) {
      await replyEphemeral(interaction, "招待申請が見つかりません");
      return;
    }
    const meetup = getMeetup(request.meetupId);
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "終了または中止されたMeetUpでは操作できません");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ操作できます");
      return;
    }
    if (request.status !== "PENDING") {
      await replyEphemeral(interaction, "この招待申請はすでに処理済みです");
      return;
    }

    await interaction.deferUpdate();
    if (decideInviteRequest(request.id, "REJECTED", interaction.user.id) === 0) {
      await interaction.editReply({
        embeds: [messageEmbed("この招待申請はすでに処理済みです")],
        components: [],
      });
      return;
    }
    await notifyRequester(interaction, guild, meetup, request, "招待申請は却下されました。");
    await interaction.editReply({
      embeds: [messageEmbed(`招待申請を却下しました（対象: <@${request.targetId}>）`)],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});
