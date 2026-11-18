import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  type ButtonInteraction,
  type Guild,
  type MessageActionRowComponentBuilder,
  type RepliableInteraction,
} from "discord.js";
import {
  addVote,
  approveParticipant,
  canManage,
  countApproved,
  deleteParticipant,
  getMeetup,
  getParticipant,
  hasVoted,
  listCohosts,
  listMeetups,
  listParticipants,
  rejectParticipant,
  setParticipantState,
} from "../core/meetup.ts";
import {
  announceJoin,
  deferEphemeral,
  meetupFromInteraction,
  replyEphemeral,
  replyError,
  sendToMeetupChannel,
  sendToMeetupChannelMessage,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
import { recordParticipationMessage } from "../core/participation.ts";
import { button, selectMenu, subcommand } from "../core/registry.ts";
import { discordTimestamp } from "../core/time.ts";
import type { Meetup } from "../core/types.ts";
import {
  createUiSession,
  getUiSession,
  meetupSelectRow,
  pageRow,
  selectedNumber,
  type UiSession,
} from "../core/ui.ts";
import { applyButtonRow, capacityLabel, meetupEmbed } from "../core/views.ts";

const NOT_RECRUITING = "このMeetUpは現在募集していません";

/** Returns the reason this user cannot apply, or null when they may apply. */
export function applicationDenial(meetup: Meetup, userId: string): string | null {
  if (canManage(meetup, userId)) return "主催者側は参加申請できません";

  const participant = getParticipant(meetup.id, userId);
  switch (participant?.state) {
    case "APPROVED":
      return "既に参加確定しています";
    case "APPLIED":
      return "既に申請中です";
    case "INVITED":
      return "招待DMから参加してください";
    case "REJECTED":
      return "参加申請は却下されています";
    case "KICKED":
      return "このMeetUpからは退出させられています";
  }

  if (meetup.mode === "PRIVATE") {
    // Anyone who was ever invited (declined or cancelled later) may apply again.
    if (participant?.invitedAt == null) return "招待されたユーザーのみ参加申請できます";
  }
  return null;
}

/** Panel embed for a pending application. Exact meeting place is never included. */
export function applicationEmbed(
  meetup: Meetup,
  applicantId: string,
  approved: number,
  voteCount: number,
  appliedAt: number,
): EmbedBuilder {
  const description = [`<@${applicantId}> が参加を申請しました。`];
  if (meetup.capacity > 0 && approved >= meetup.capacity) {
    description.push("", "⚠️ 定員に達しています（承認すると超過します）");
  }

  const embed = new EmbedBuilder()
    .setTitle("参加申請")
    .setColor(0xf1c40f)
    .setDescription(description.join("\n"))
    .addFields(
      { name: "定員", value: `${capacityLabel(meetup.capacity)}（承認済み ${approved}人）`, inline: true },
      {
        name: "承認方式",
        value:
          meetup.approvalMode === "VOTE"
            ? `参加者投票（必要票数 ${meetup.requiredVotes}）`
            : meetup.approvalMode === "DIRECT"
              ? "直参加"
              : "主催者承認",
        inline: true,
      },
      { name: "申請日時", value: discordTimestamp(appliedAt), inline: true },
    );

  if (meetup.approvalMode === "VOTE") {
    embed.addFields({
      name: "投票状況",
      value: `必要票数 ${meetup.requiredVotes} / 現在 ${voteCount}票`,
      inline: false,
    });
  }
  return embed;
}

export function applicationComponents(
  meetup: Meetup,
  applicantId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (meetup.approvalMode === "VOTE") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`apply:vote:${meetup.id}:${applicantId}`)
        .setLabel("賛成票")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`apply:reject:${meetup.id}:${applicantId}`)
        .setLabel("却下")
        .setStyle(ButtonStyle.Danger),
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`apply:approve:${meetup.id}:${applicantId}`)
        .setLabel("承認")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`apply:reject:${meetup.id}:${applicantId}`)
        .setLabel("却下")
        .setStyle(ButtonStyle.Danger),
    );
  }
  return [row];
}

function applicationPanelContent(meetup: Meetup, applicantId: string): string {
  const audience =
    meetup.approvalMode === "VOTE"
      ? listParticipants(meetup.id, ["APPROVED"]).map((p) => `<@${p.userId}>`)
      : [meetup.hostId, ...listCohosts(meetup.id)].map((id) => `<@${id}>`);
  return `${audience.join(" ")} 参加申請が届きました。\n申請者: <@${applicantId}>`;
}

function resultEmbed(
  meetup: Meetup,
  applicantId: string,
  approved: boolean,
  actorId: string,
  warning?: string,
): EmbedBuilder {
  const lines = [
    approved
      ? `<@${applicantId}> の参加が確定しました。`
      : `<@${applicantId}> の参加申請を却下しました。`,
  ];
  if (warning) lines.push("", warning);
  return new EmbedBuilder()
    .setTitle(approved ? "参加確定" : "参加申請を却下")
    .setColor(approved ? 0x2ecc71 : 0xe74c3c)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "meetup", value: meetup.name, inline: true },
      { name: "対応者", value: `<@${actorId}>`, inline: true },
    );
}

/** Handles both the /meetupper apply subcommand and the forum post's apply button. */
export async function submitApplication(interaction: RepliableInteraction, meetupId: number): Promise<void> {
  try {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, "サーバー内でのみ使用できます");
      return;
    }
    await deferEphemeral(interaction);
    const meetup = getMeetup(meetupId);
    if (!meetup || meetup.guildId !== guild.id || meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, NOT_RECRUITING);
      return;
    }
    const denial = applicationDenial(meetup, interaction.user.id);
    if (denial) {
      await replyEphemeral(interaction, denial);
      return;
    }

    if (meetup.approvalMode === "DIRECT") {
      approveParticipant(meetup, interaction.user.id, interaction.user.id);
      const joined = getMeetup(meetup.id)!;
      await syncMeetupAccess(guild, joined).catch((error) =>
        console.error("参加者の権限同期に失敗しました", error),
      );
      const overCapacity = joined.capacity > 0 && countApproved(joined.id) > joined.capacity;
      await announceJoin(
        guild,
        joined,
        interaction.user.id,
        overCapacity ? "⚠️ 定員を超えています。主催者へ確認してください。" : undefined,
      );
      await replyEphemeral(
        interaction,
        `参加しました${overCapacity ? "\n⚠️ 定員を超えています。主催者へ確認してください。" : ""}`,
      );
      return;
    }

    const previous = getParticipant(meetup.id, interaction.user.id);
    setParticipantState(meetup.id, interaction.user.id, "APPLIED");
    const participant = getParticipant(meetup.id, interaction.user.id);
    const appliedAt = participant?.appliedAt ?? Date.now();

    const message = await sendToMeetupChannelMessage(guild, meetup, {
      content: applicationPanelContent(meetup, interaction.user.id),
      embeds: [applicationEmbed(meetup, interaction.user.id, countApproved(meetup.id), 0, appliedAt)],
      components: applicationComponents(meetup, interaction.user.id),
    });

    if (!message) {
      // No panel means no way to approve, so do not leave an unreachable application.
      if (previous) setParticipantState(meetup.id, interaction.user.id, previous.state);
      else deleteParticipant(meetup.id, interaction.user.id);
      await replyEphemeral(
        interaction,
        "参加申請を登録できませんでした（主催者チャンネルへ通知できません）。時間をおいて再実行するか、主催者へ直接連絡してください。",
      );
      return;
    }

    recordParticipationMessage(meetup.id, "application", message.channelId, message.id);
    await replyEphemeral(interaction, "参加申請を送りました");
  } catch (error) {
    await replyError(interaction, error);
  }
}

async function loadActiveMeetup(
  interaction: ButtonInteraction,
  meetupId: number,
): Promise<{ guild: Guild; meetup: Meetup } | null> {
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, "サーバー内でのみ使用できます");
    return null;
  }
  const meetup = getMeetup(meetupId);
  if (!meetup || meetup.guildId !== guild.id || meetup.state !== "ACTIVE") {
    await replyEphemeral(interaction, NOT_RECRUITING);
    return null;
  }
  return { guild, meetup };
}

async function requireApplicant(
  interaction: ButtonInteraction,
  meetupId: number,
  applicantId: string,
): Promise<boolean> {
  const participant = getParticipant(meetupId, applicantId);
  if (!participant) {
    await replyEphemeral(interaction, "申請が見つかりません");
    return false;
  }
  if (participant.state === "APPROVED") {
    await replyEphemeral(interaction, "この申請は既に承認されています");
    return false;
  }
  if (participant.state === "REJECTED") {
    await replyEphemeral(interaction, "この申請は既に却下されています");
    return false;
  }
  if (participant.state !== "APPLIED") {
    await replyEphemeral(interaction, "この申請は現在処理できません");
    return false;
  }
  return true;
}

async function confirmApproval(
  interaction: ButtonInteraction,
  guild: Guild,
  meetup: Meetup,
  applicantId: string,
  approvedBy: string,
): Promise<void> {
  approveParticipant(meetup, applicantId, approvedBy);
  const warning =
    meetup.capacity > 0 && countApproved(meetup.id) > meetup.capacity
      ? "⚠️ 定員を超えて承認しました。参加希望者へ状況を共有してください。"
      : undefined;
  await interaction.update({
    embeds: [resultEmbed(meetup, applicantId, true, interaction.user.id, warning)],
    components: [],
  });
  await syncMeetupAccess(guild, getMeetup(meetup.id)!).catch((error) =>
    console.error("参加者の権限同期に失敗しました", error),
  );
  await tryDM(
    interaction.client,
    applicantId,
    `参加が確定しました: ${meetup.name}${warning ? `\n${warning}` : ""}`,
  );
  await announceJoin(guild, meetup, applicantId, warning);
}

/* --- apply UI --- */

const APPLY_PAGE_SIZE = 25;
const SESSION_EXPIRED = "画面の有効期限が切れました。コマンドを開き直してください。";

interface ApplyPickerState {
  page: number;
}

type ApplySession = UiSession<ApplyPickerState>;

/** MeetUps this user may apply to: Public or an invited Private one. */
export function joinableMeetups(guildId: string, userId: string): Meetup[] {
  return listMeetups(guildId).filter(
    (meetup) => meetup.state === "ACTIVE" && applicationDenial(meetup, userId) === null,
  );
}

export function applyConfirmEmbed(meetup: Meetup): EmbedBuilder {
  const embed = meetupEmbed(meetup);
  return embed
    .setTitle(`参加確認: ${meetup.name}`)
    .setDescription(["このMeetUpへ参加します。", embed.data.description ?? ""].join("\n\n").slice(0, 4000))
    .setFooter({ text: `MeetUp ID: ${meetup.id}` });
}

export function applyConfirmComponents(
  meetup: Meetup,
  backSessionId?: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows = [applyButtonRow(meetup)];
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`browse:show:${meetup.id}`)
      .setLabel("詳細")
      .setStyle(ButtonStyle.Secondary),
  );
  if (backSessionId) {
    controls.addComponents(
      new ButtonBuilder()
        .setCustomId(`browse:apply-list:${backSessionId}`)
        .setLabel("一覧に戻る")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  rows.push(controls);
  return rows;
}

function applyPickerPayload(session: ApplySession, userId: string): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const meetups = joinableMeetups(session.guildId, userId);
  const pages = Math.max(1, Math.ceil(meetups.length / APPLY_PAGE_SIZE));
  const page = Math.min(Math.max(session.data.page, 0), pages - 1);
  session.data.page = page;
  const items = meetups.slice(page * APPLY_PAGE_SIZE, (page + 1) * APPLY_PAGE_SIZE);

  const embed = new EmbedBuilder()
    .setTitle("参加するMeetUpを選択")
    .setColor(0x5865f2)
    .setDescription(
      [
        `参加できます: ${meetups.length}件`,
        items.length === 0 ? "参加できるMeetUpはありません。" : "MeetUpを選ぶと参加確認に進みます。",
        pages > 1 ? `ページ ${page + 1}/${pages}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );

  const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (items.length > 0) {
    components.push(
      meetupSelectRow(
        `browse:apply-pick:${session.id}`,
        items.map((meetup) => ({ meetup })),
      ),
    );
  }
  if (pages > 1) {
    components.push(
      pageRow(`browse:apply-prev:${session.id}`, `browse:apply-next:${session.id}`, page, pages),
    );
  }
  return { embeds: [embed], components };
}

/** Slash entry point: confirmation panel for a known MeetUp, joinable picker otherwise. */
subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("apply")
    .setDescription("MeetUpに参加申請します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（募集スレッド内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await replyEphemeral(interaction, "サーバー内でのみ使用できます");
        return;
      }
      const id = interaction.options.getInteger("meetup");
      const meetup = id === null ? meetupFromInteraction(interaction) : getMeetup(id);
      if (id !== null && (!meetup || meetup.guildId !== guild.id)) {
        await replyEphemeral(interaction, "MeetUpが見つかりません。");
        return;
      }

      await deferEphemeral(interaction);
      if (!meetup || meetup.guildId !== guild.id) {
        const session = createUiSession<ApplyPickerState>({
          ownerId: interaction.user.id,
          guildId: guild.id,
          data: { page: 0 },
        });
        await replyEphemeral(interaction, applyPickerPayload(session, interaction.user.id));
        return;
      }
      if (meetup.state !== "ACTIVE") {
        await replyEphemeral(interaction, NOT_RECRUITING);
        return;
      }
      const denial = applicationDenial(meetup, interaction.user.id);
      if (denial) {
        await replyEphemeral(interaction, denial);
        return;
      }
      await replyEphemeral(interaction, {
        embeds: [applyConfirmEmbed(meetup)],
        components: applyConfirmComponents(meetup),
      });
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

selectMenu(/^browse:apply-pick:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<ApplyPickerState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    const meetupId = selectedNumber(interaction);
    const meetup = meetupId === null ? null : getMeetup(meetupId);
    if (!meetup || meetup.guildId !== session.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, NOT_RECRUITING);
      return;
    }
    const denial = applicationDenial(meetup, interaction.user.id);
    if (denial) {
      await replyEphemeral(interaction, denial);
      return;
    }
    await interaction.update({
      embeds: [applyConfirmEmbed(meetup)],
      components: applyConfirmComponents(meetup, session.id),
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:apply-list:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<ApplyPickerState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    await interaction.update(applyPickerPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:apply-prev:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<ApplyPickerState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    session.data.page = Math.max(0, session.data.page - 1);
    await interaction.update(applyPickerPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:apply-next:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<ApplyPickerState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    session.data.page += 1;
    await interaction.update(applyPickerPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^apply:start:(\d+)$/, async (interaction, args) => {
  try {
    const meetupId = Number(args[0]);
    if (!Number.isInteger(meetupId)) {
      await replyEphemeral(interaction, "無効な操作です");
      return;
    }
    await submitApplication(interaction, meetupId);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^apply:approve:(\d+):(\d+)$/, async (interaction, args) => {
  try {
    const meetupId = Number(args[0]);
    const applicantId = args[1];
    if (!Number.isInteger(meetupId) || !applicantId) {
      await replyEphemeral(interaction, "無効な操作です");
      return;
    }
    const context = await loadActiveMeetup(interaction, meetupId);
    if (!context) return;
    if (!canManage(context.meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ操作できます");
      return;
    }
    if (!(await requireApplicant(interaction, meetupId, applicantId))) return;
    await confirmApproval(interaction, context.guild, context.meetup, applicantId, interaction.user.id);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^apply:reject:(\d+):(\d+)$/, async (interaction, args) => {
  try {
    const meetupId = Number(args[0]);
    const applicantId = args[1];
    if (!Number.isInteger(meetupId) || !applicantId) {
      await replyEphemeral(interaction, "無効な操作です");
      return;
    }
    const context = await loadActiveMeetup(interaction, meetupId);
    if (!context) return;
    if (!canManage(context.meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ操作できます");
      return;
    }
    if (!(await requireApplicant(interaction, meetupId, applicantId))) return;

    rejectParticipant(meetupId, applicantId);
    await interaction.update({
      embeds: [resultEmbed(context.meetup, applicantId, false, interaction.user.id)],
      components: [],
    });
    await tryDM(interaction.client, applicantId, "参加申請は承認されませんでした");
    await sendToMeetupChannel(context.guild, context.meetup, {
      content: `<@${applicantId}> の参加申請を却下しました。`,
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^apply:vote:(\d+):(\d+)$/, async (interaction, args) => {
  try {
    const meetupId = Number(args[0]);
    const applicantId = args[1];
    if (!Number.isInteger(meetupId) || !applicantId) {
      await replyEphemeral(interaction, "無効な操作です");
      return;
    }
    const context = await loadActiveMeetup(interaction, meetupId);
    if (!context) return;
    const { meetup } = context;
    if (meetup.approvalMode !== "VOTE") {
      await replyEphemeral(interaction, "このMeetUpは参加者投票ではありません");
      return;
    }
    if (interaction.user.id === applicantId) {
      await replyEphemeral(interaction, "自分の申請には投票できません");
      return;
    }
    if (getParticipant(meetupId, interaction.user.id)?.state !== "APPROVED") {
      await replyEphemeral(interaction, "参加確定者のみ投票できます");
      return;
    }
    if (!(await requireApplicant(interaction, meetupId, applicantId))) return;
    if (hasVoted(meetupId, applicantId, interaction.user.id)) {
      await replyEphemeral(interaction, "既に投票しています");
      return;
    }

    const count = addVote(meetupId, applicantId, interaction.user.id);
    if (count >= meetup.requiredVotes) {
      await confirmApproval(interaction, context.guild, meetup, applicantId, "vote");
      return;
    }

    const appliedAt = getParticipant(meetupId, applicantId)?.appliedAt ?? Date.now();
    await interaction.update({
      embeds: [applicationEmbed(meetup, applicantId, countApproved(meetupId), count, appliedAt)],
      components: applicationComponents(meetup, applicantId),
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});
