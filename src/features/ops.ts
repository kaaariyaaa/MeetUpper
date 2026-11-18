import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandSubcommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { config } from "../config.ts";
import { db } from "../db.ts";
import {
  archiveChannel,
  ensureLayout,
  isLayoutInitialized,
  meetupFromInteraction,
  messageEmbed,
  replyEphemeral,
  replyError,
  revokeChannelAccess,
  sendToMeetupChannel,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
import { cancelEvent } from "../core/events.ts";
import {
  archiveMeetup,
  canManage,
  cancelMeetup,
  getMeetup,
  getParticipant,
  isHost,
  listCohosts,
  listMeetups,
  listParticipants,
  setParticipantState,
  updateMeetup,
  validateMeetingTime,
} from "../core/meetup.ts";
import { recalculateSchedules, reminderBaseAt } from "../core/reminders.ts";
import { button, modal, selectMenu, subcommand } from "../core/registry.ts";
import { formatInZone, parseDateTime } from "../core/time.ts";
import {
  confirmButtons,
  createUiSession,
  dropUiSession,
  getUiSession,
  meetupSelectRow,
  selectedNumber,
  type UiSession,
} from "../core/ui.ts";
import type { Meetup } from "../core/types.ts";
import { dateTimeHint, meetupEmbed } from "../core/views.ts";

type OpsAction = "info" | "leave" | "archive" | "cancel" | "init";
type ModalOpener = ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction;

interface OpsSessionData {
  action: OpsAction;
}

const INFO_TIME_INPUT = "meeting-time";
const INFO_PLACE_INPUT = "meeting-place";

const COLOR_PRIMARY = 0x5865f2;
const COLOR_WARNING = 0xe67e22;
const COLOR_DANGER = 0xe74c3c;

function actionFromArgs(value: string | undefined): OpsAction | null {
  return value === "info" ||
    value === "leave" ||
    value === "archive" ||
    value === "cancel" ||
    value === "init"
    ? value
    : null;
}

async function requireGuild(interaction: RepliableInteraction): Promise<Guild | null> {
  if (!interaction.guild) {
    await replyEphemeral(interaction, "この操作はサーバー内でのみ実行できます。");
    return null;
  }
  return interaction.guild;
}

function isAdministrator(interaction: RepliableInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function startSession(interaction: RepliableInteraction, action: OpsAction, meetupId: number | null): string {
  const guildId = interaction.guildId ?? interaction.guild?.id ?? "";
  return createUiSession<OpsSessionData>({
    ownerId: interaction.user.id,
    guildId,
    meetupId,
    data: { action },
  }).id;
}

async function requireSession(
  interaction: ButtonInteraction,
  sessionId: string,
  action: OpsAction,
): Promise<UiSession<OpsSessionData> | null> {
  const session = getUiSession<OpsSessionData>(interaction, sessionId);
  if (!session || session.data.action !== action) {
    await replyEphemeral(
      interaction,
      "この確認画面は無効か期限切れです。コマンドを実行し直してください。",
    );
    return null;
  }
  return session;
}

function confirmationPanel(
  action: OpsAction,
  sessionId: string,
  title: string,
  description: string,
  color: number,
) {
  return {
    embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(color)],
    components: [
      confirmButtons(
        `ops:confirm:${action}:${sessionId}`,
        `ops:abort:${sessionId}`,
        "実行する",
        "キャンセル",
      ),
    ],
  };
}

/* --- shared target picking --- */

async function showPicker(
  interaction: RepliableInteraction,
  action: OpsAction,
  meetups: Meetup[],
  placeholder: string,
  emptyMessage: string,
): Promise<void> {
  if (meetups.length === 0) {
    await replyEphemeral(interaction, emptyMessage);
    return;
  }
  await replyEphemeral(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setDescription("操作するMeetUpを選択してください。"),
    ],
    components: [meetupSelectRow(`ops:pick:${action}`, meetups.map((meetup) => ({ meetup })), placeholder)],
  });
}

async function runTargetCommand(
  interaction: ChatInputCommandInteraction,
  open: (meetup: Meetup) => Promise<void>,
  pick: (guild: Guild) => Promise<void>,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
    return;
  }
  const id = interaction.options.getInteger("meetup");
  if (id !== null) {
    const meetup = getMeetup(id);
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    await open(meetup);
    return;
  }
  const meetup = meetupFromInteraction(interaction);
  if (meetup && meetup.guildId === guild.id) {
    await open(meetup);
    return;
  }
  await pick(guild);
}

async function meetupForButton(
  interaction: ButtonInteraction,
  idText: string,
): Promise<{ guild: Guild; meetup: Meetup } | null> {
  const guild = await requireGuild(interaction);
  if (!guild) return null;
  const id = Number(idText);
  if (!Number.isInteger(id) || id <= 0) {
    await replyEphemeral(interaction, "MeetUp IDが不正です。");
    return null;
  }
  const meetup = getMeetup(id);
  if (!meetup || meetup.guildId !== guild.id) {
    await replyEphemeral(interaction, "MeetUpが見つかりません。");
    return null;
  }
  return { guild, meetup };
}

/* --- info --- */

function infoModal(meetup: Meetup): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`ops:info-modal:${meetup.id}`)
    .setTitle("集合情報の変更")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(INFO_TIME_INPUT)
          .setLabel("集合時間 (YYYY-MM-DD HH:mm)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(32)
          .setValue(meetup.meetingAt !== null ? formatInZone(meetup.meetingAt) : "")
          .setPlaceholder("空欄で保存すると現在の集合時間を維持します"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(INFO_PLACE_INPUT)
          .setLabel("集合場所（空欄で削除）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(200)
          .setValue(meetup.meetingPlace ?? ""),
      ),
    );
}

async function openInfoPanel(interaction: ModalOpener, meetup: Meetup): Promise<void> {
  if (!canManage(meetup, interaction.user.id)) {
    await replyEphemeral(interaction, "主催者または共同主催者のみ集合情報を変更できます。");
    return;
  }
  if (meetup.state !== "ACTIVE") {
    await replyEphemeral(interaction, "ACTIVEなMeetUpのみ集合情報を変更できます。");
    return;
  }
  await interaction.showModal(infoModal(meetup));
}

async function notifyChannel(guild: Guild, meetup: Meetup, content: string): Promise<void> {
  const current = getMeetup(meetup.id) ?? meetup;
  await sendToMeetupChannel(guild, current, {
    embeds: [messageEmbed(content), meetupEmbed(current, { includeMeetingPlace: true })],
  });
}

async function notifyMeetingInfo(guild: Guild, meetup: Meetup): Promise<void> {
  const mentions = listParticipants(meetup.id, ["APPROVED"])
    .map((participant) => `<@${participant.userId}>`)
    .join(" ");
  await sendToMeetupChannel(guild, meetup, {
    content: mentions || undefined,
    embeds: [meetupEmbed(meetup, { includeMeetingPlace: true })],
  });
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("info")
    .setDescription("集合時間・集合場所を変更します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      await runTargetCommand(
        interaction,
        (meetup) => openInfoPanel(interaction, meetup),
        (guild) =>
          showPicker(
            interaction,
            "info",
            listMeetups(guild.id, ["ACTIVE"]).filter((meetup) =>
              canManage(meetup, interaction.user.id),
            ),
            "集合情報を変更するMeetUp",
            "管理できるACTIVEなMeetUpがありません。",
          ),
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

modal(/^ops:info-modal:(\d+)$/, async (interaction, args) => {
  try {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, "この操作はサーバー内でのみ実行できます。");
      return;
    }
    const meetup = getMeetup(Number(args[0]));
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ集合情報を変更できます。");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "ACTIVEなMeetUpのみ集合情報を変更できます。");
      return;
    }

    const timeInput = interaction.fields.getTextInputValue(INFO_TIME_INPUT).trim();
    const placeInput = interaction.fields.getTextInputValue(INFO_PLACE_INPUT).trim();

    // Blank time keeps the current value; blank place deliberately clears it.
    let meetingAt = meetup.meetingAt;
    if (timeInput !== "") {
      const parsed = parseDateTime(timeInput, config.timeZone);
      if (parsed === null) {
        await replyEphemeral(interaction, `集合時間の形式が正しくありません。${dateTimeHint()}`);
        return;
      }
      try {
        validateMeetingTime(meetup.startAt, parsed);
      } catch (error) {
        await replyEphemeral(interaction, error instanceof Error ? error.message : String(error));
        return;
      }
      meetingAt = parsed;
    }
    const meetingPlace = placeInput === "" ? null : placeInput;

    const previousBase = reminderBaseAt(meetup);
    db.transaction(() => {
      updateMeetup(meetup.id, { meetingAt, meetingPlace });
      const updated = getMeetup(meetup.id)!;
      if (meetingAt !== meetup.meetingAt && reminderBaseAt(updated) !== previousBase) {
        recalculateSchedules(meetup.id, { resetAll: true });
      }
    })();
    const updated = getMeetup(meetup.id)!;

    await replyEphemeral(interaction, "集合情報を更新しました。");
    await notifyMeetingInfo(guild, updated);
  } catch (error) {
    await replyError(interaction, error);
  }
});

/* --- leave --- */

function leaveDenial(meetup: Meetup, userId: string): string | null {
  if (meetup.state !== "ACTIVE") return "ACTIVEなMeetUpのみ参加をキャンセルできます。";
  if (getParticipant(meetup.id, userId)?.state !== "APPROVED") {
    return "参加確定者のみ参加をキャンセルできます。";
  }
  if (isHost(meetup, userId) || listCohosts(meetup.id).includes(userId)) {
    return "主催者・共同主催者は参加キャンセルできません。";
  }
  return null;
}

async function openLeavePanel(interaction: RepliableInteraction, meetup: Meetup): Promise<void> {
  const denial = leaveDenial(meetup, interaction.user.id);
  if (denial) {
    await replyEphemeral(interaction, denial);
    return;
  }
  const sessionId = startSession(interaction, "leave", meetup.id);
  await replyEphemeral(
    interaction,
    confirmationPanel(
      "leave",
      sessionId,
      "参加をキャンセルしますか？",
      `「${meetup.name}」の参加をキャンセルします。専用チャンネルの閲覧権限が解除され、参加者へ通知されます。`,
      COLOR_WARNING,
    ),
  );
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("leave")
    .setDescription("参加をキャンセルします")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      await runTargetCommand(
        interaction,
        (meetup) => openLeavePanel(interaction, meetup),
        (guild) =>
          showPicker(
            interaction,
            "leave",
            listMeetups(guild.id, ["ACTIVE"]).filter(
              (meetup) => leaveDenial(meetup, interaction.user.id) === null,
            ),
            "参加をキャンセルするMeetUp",
            "参加中のMeetUpはありません。",
          ),
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

/* --- archive --- */

function archiveDenial(meetup: Meetup, userId: string): string | null {
  if (!canManage(meetup, userId)) return "主催者または共同主催者のみアーカイブできます。";
  if (meetup.state === "ARCHIVED") return "アーカイブ済みのMeetUpは操作できません。";
  return null;
}

async function openArchivePanel(interaction: RepliableInteraction, meetup: Meetup): Promise<void> {
  const denial = archiveDenial(meetup, interaction.user.id);
  if (denial) {
    await replyEphemeral(interaction, denial);
    return;
  }
  const sessionId = startSession(interaction, "archive", meetup.id);
  await replyEphemeral(
    interaction,
    confirmationPanel(
      "archive",
      sessionId,
      "アーカイブしますか？",
      `「${meetup.name}」をアーカイブします。リマインダーは停止され、チャンネル名に archive- が付与されます。`,
      COLOR_WARNING,
    ),
  );
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("archive")
    .setDescription("MeetUpをアーカイブします")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      await runTargetCommand(
        interaction,
        (meetup) => openArchivePanel(interaction, meetup),
        (guild) =>
          showPicker(
            interaction,
            "archive",
            listMeetups(guild.id, ["ACTIVE", "CANCELLED"]).filter(
              (meetup) => archiveDenial(meetup, interaction.user.id) === null,
            ),
            "アーカイブするMeetUp",
            "アーカイブできるMeetUpがありません。",
          ),
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

/* --- cancel --- */

function cancelDenial(meetup: Meetup, userId: string): string | null {
  if (!canManage(meetup, userId)) return "主催者または共同主催者のみMeetUpを中止できます。";
  if (meetup.state !== "ACTIVE") return "ACTIVEなMeetUpのみ中止できます。";
  return null;
}

async function openCancelPanel(interaction: RepliableInteraction, meetup: Meetup): Promise<void> {
  const denial = cancelDenial(meetup, interaction.user.id);
  if (denial) {
    await replyEphemeral(interaction, denial);
    return;
  }
  const sessionId = startSession(interaction, "cancel", meetup.id);
  await replyEphemeral(
    interaction,
    confirmationPanel(
      "cancel",
      sessionId,
      "MeetUpを中止しますか？",
      `「${meetup.name}」を中止します。参加確定者へチャンネルとDMで通知されます。この操作は取り消せません。`,
      COLOR_DANGER,
    ),
  );
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("cancel")
    .setDescription("MeetUpを中止します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      await runTargetCommand(
        interaction,
        (meetup) => openCancelPanel(interaction, meetup),
        (guild) =>
          showPicker(
            interaction,
            "cancel",
            listMeetups(guild.id, ["ACTIVE"]).filter(
              (meetup) => cancelDenial(meetup, interaction.user.id) === null,
            ),
            "中止するMeetUp",
            "中止できるMeetUpがありません。",
          ),
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

/* --- cross-feature entry points --- */

button(/^ops:info-open:(\d+)$/, async (interaction, args) => {
  try {
    const context = await meetupForButton(interaction, args[0] ?? "");
    if (!context) return;
    await openInfoPanel(interaction, context.meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^ops:leave-open:(\d+)$/, async (interaction, args) => {
  try {
    const context = await meetupForButton(interaction, args[0] ?? "");
    if (!context) return;
    await openLeavePanel(interaction, context.meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^ops:archive-open:(\d+)$/, async (interaction, args) => {
  try {
    const context = await meetupForButton(interaction, args[0] ?? "");
    if (!context) return;
    await openArchivePanel(interaction, context.meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^ops:cancel-open:(\d+)$/, async (interaction, args) => {
  try {
    const context = await meetupForButton(interaction, args[0] ?? "");
    if (!context) return;
    await openCancelPanel(interaction, context.meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^ops:pick:(info|leave|archive|cancel)$/, async (interaction, args) => {
  try {
    const action = actionFromArgs(args[0]);
    if (!action || action === "init") {
      await replyEphemeral(interaction, "無効な操作です。");
      return;
    }
    const guild = await requireGuild(interaction);
    if (!guild) return;
    const meetup = getMeetup(selectedNumber(interaction) ?? 0);
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (action === "info") await openInfoPanel(interaction, meetup);
    else if (action === "leave") await openLeavePanel(interaction, meetup);
    else if (action === "archive") await openArchivePanel(interaction, meetup);
    else await openCancelPanel(interaction, meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

/* --- confirmations --- */

button(/^ops:confirm:(leave|archive|cancel|init):([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const action = actionFromArgs(args[0]);
    if (!action) {
      await replyEphemeral(interaction, "無効な操作です。");
      return;
    }
    const session = await requireSession(interaction, args[1] ?? "", action);
    if (!session) return;
    const guild = await requireGuild(interaction);
    if (!guild) return;

    if (action === "init") {
      if (!isAdministrator(interaction)) {
        await replyEphemeral(interaction, "このコマンドはサーバー管理者のみ実行できます。");
        return;
      }
      const reused = await isLayoutInitialized(guild);
      const layout = await ensureLayout(guild);
      dropUiSession(session.id);
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle(reused ? "セットアップ済みのレイアウト" : "セットアップ完了")
            .setColor(0x2ecc71)
            .setDescription(
              [
                reused
                  ? "既存のMeetUpレイアウトを再利用し、権限と並び順を整えました。"
                  : "MeetUpレイアウトを作成しました。",
                `カテゴリ: ${layout.category.name}`,
                `募集フォーラム: <#${layout.forum.id}>`,
                `招待チャンネル: <#${layout.inviteChannel.id}>`,
              ].join("\n"),
            ),
        ],
        components: [],
      });
      return;
    }

    const meetup = session.meetupId === null ? null : getMeetup(session.meetupId);
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }

    if (action === "leave") {
      const denial = leaveDenial(meetup, interaction.user.id);
      if (denial) {
        await replyEphemeral(interaction, denial);
        return;
      }
      setParticipantState(meetup.id, interaction.user.id, "CANCELLED");
      dropUiSession(session.id);
      await interaction.update({
        embeds: [messageEmbed("参加をキャンセルしました。")],
        components: [],
      });
      await revokeChannelAccess(guild, meetup, interaction.user.id);
      await notifyChannel(guild, meetup, `<@${interaction.user.id}> が参加をキャンセルしました。`);
      return;
    }

    if (action === "archive") {
      const denial = archiveDenial(meetup, interaction.user.id);
      if (denial) {
        await replyEphemeral(interaction, denial);
        return;
      }
      archiveMeetup(meetup);
      const updated = getMeetup(meetup.id)!;
      dropUiSession(session.id);
      await interaction.update({ embeds: [messageEmbed("アーカイブしました。")], components: [] });
      await archiveChannel(guild, updated);
      await syncMeetupAccess(guild, updated).catch((error) =>
        console.error("アーカイブ後の権限同期に失敗しました", error),
      );
      if (updated.eventId) await cancelEvent(guild, updated);
      return;
    }

    const denial = cancelDenial(meetup, interaction.user.id);
    if (denial) {
      await replyEphemeral(interaction, denial);
      return;
    }
    cancelMeetup(meetup);
    const updated = getMeetup(meetup.id)!;
    dropUiSession(session.id);
    await interaction.update({ embeds: [messageEmbed("MeetUpを中止しました。")], components: [] });
    await cancelEvent(guild, updated);
    const message = `MeetUpが中止されました: ${updated.name}`;
    await notifyChannel(guild, updated, message);
    const targets = listParticipants(updated.id, ["APPROVED", "APPLIED", "INVITED"]);
    await Promise.all(
      targets.map((participant) => tryDM(interaction.client, participant.userId, message)),
    );
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^ops:abort:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<OpsSessionData>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(
        interaction,
        "この確認画面は無効か期限切れです。コマンドを実行し直してください。",
      );
      return;
    }
    dropUiSession(session.id);
    await interaction.update({ embeds: [messageEmbed("キャンセルしました。")], components: [] });
  } catch (error) {
    await replyError(interaction, error);
  }
});
