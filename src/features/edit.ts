import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandSubcommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import { db } from "../db.ts";
import {
  deferEphemeral,
  ensureLayout,
  messageEmbed,
  replyEphemeral,
  replyError,
  sendToMeetupChannel,
} from "../core/discord.ts";
import { cancelEvent, syncEventCreation, updateEvent } from "../core/events.ts";
import {
  canManage,
  clearRecruitmentClosed,
  countApproved,
  getMeetup,
  isHost,
  isParticipationOpen,
  isRecruitmentClosed,
  listCohosts,
  listMeetups,
  updateMeetup,
} from "../core/meetup.ts";
import {
  formatOffset,
  getReminderOffsets,
  getReminderSettings,
  recalculateSchedules,
  reminderBaseAt,
} from "../core/reminders.ts";
import {
  createUiSession,
  dropUiSession,
  getUiSession,
  meetupNavRow,
  meetupSelectRow,
  selectedNumber,
} from "../core/ui.ts";
import { button, modal, selectMenu, subcommand } from "../core/registry.ts";
import { discordTimestamp, formatInZone, parseDateTime } from "../core/time.ts";
import type { ApprovalMode, Meetup } from "../core/types.ts";
import { applyButtonRow, capacityLabel, dateTimeHint, meetupEmbed, publicEmbed } from "../core/views.ts";

/** Value object kept in the ui.ts session until 保存. */
export interface EditDraft {
  name: string;
  description: string;
  capacity: number;
  startAt: number | null;
  approvalMode: ApprovalMode;
  requiredVotes: number;
  meetingAt: number | null;
  meetingPlace: string | null;
  eventEnabled: boolean;
}

export function draftFromMeetup(meetup: Meetup): EditDraft {
  return {
    name: meetup.name,
    description: meetup.description,
    capacity: meetup.capacity,
    startAt: meetup.startAt,
    approvalMode: meetup.approvalMode,
    requiredVotes: meetup.requiredVotes,
    meetingAt: meetup.meetingAt,
    meetingPlace: meetup.meetingPlace,
    eventEnabled: meetup.eventEnabled,
  };
}

function sameDraft(meetup: Meetup, draft: EditDraft): boolean {
  return (
    meetup.name === draft.name &&
    meetup.description === draft.description &&
    meetup.capacity === draft.capacity &&
    meetup.startAt === draft.startAt &&
    meetup.approvalMode === draft.approvalMode &&
    meetup.requiredVotes === draft.requiredVotes &&
    meetup.meetingAt === draft.meetingAt &&
    meetup.meetingPlace === draft.meetingPlace &&
    meetup.eventEnabled === draft.eventEnabled
  );
}

function approvalText(draft: EditDraft): string {
  if (draft.approvalMode === "VOTE") return `参加者投票（必要票数 ${draft.requiredVotes}）`;
  if (draft.approvalMode === "DIRECT") return "直参加";
  return "主催者承認";
}

/** Cross-field rules; enforced both when a sub-screen is submitted and again at save. */
export function validateDraft(
  draft: EditDraft,
  mode: Meetup["mode"],
  now = Date.now(),
  options: { originalMeetingAt?: number | null; originalStartAt?: number | null } = {},
): void {
  if (!draft.name.trim()) throw new Error("MeetUp名を入力してください。");
  if (draft.name.trim().length > 100) throw new Error("MeetUp名は100文字以内で入力してください。");
  if (!Number.isInteger(draft.capacity) || draft.capacity < 0 || draft.capacity > 1000) {
    throw new Error("定員は0〜1000の整数で入力してください（0は定員なし）。");
  }
  if (mode === "PRIVATE" && draft.approvalMode !== "HOST") {
    throw new Error("招待制のMeetUpは主催者承認に固定です。");
  }
  if (
    draft.approvalMode === "VOTE" &&
    (!Number.isInteger(draft.requiredVotes) || draft.requiredVotes < 1 || draft.requiredVotes > 100)
  ) {
    throw new Error("必要票数は1〜100の整数で入力してください。");
  }
  if (mode !== "PUBLIC" && draft.eventEnabled) {
    throw new Error("イベント連携はPublicのMeetUpのみ設定できます。");
  }
  const startChanged = options.originalStartAt === undefined || options.originalStartAt !== draft.startAt;
  if (startChanged && draft.startAt !== null && draft.startAt <= now) {
    throw new Error("開催日時は未来の日時を指定してください。");
  }
  if (draft.meetingAt !== null) {
    if (draft.startAt !== null && draft.meetingAt > draft.startAt) {
      throw new Error("集合時間は開催日時より後に設定できません。");
    }
    // An already stored past meeting time may remain; only a newly changed one must be future.
    const meetingChanged =
      options.originalMeetingAt === undefined || options.originalMeetingAt !== draft.meetingAt;
    if (meetingChanged && draft.meetingAt <= now) {
      throw new Error("集合時間には未来の日時を指定してください。");
    }
  }
}

function reminderStatus(meetupId: number): string {
  const settings = getReminderSettings(meetupId);
  if (!settings.enabled) return "OFF";
  const offsets = getReminderOffsets(meetupId);
  if (offsets.length === 0) return "ON（通知時刻なし）";
  return `ON（${offsets.map(formatOffset).join(" / ")}）`;
}

function hubEmbed(meetup: Meetup, draft: EditDraft, notice?: string): EmbedBuilder {
  const cohosts = listCohosts(meetup.id);
  const description = [sameDraft(meetup, draft) ? null : "未保存の変更があります。", notice]
    .filter(Boolean)
    .join("\n");
  return new EmbedBuilder()
    .setTitle(`MeetUp設定: ${meetup.name}`)
    .setColor(sameDraft(meetup, draft) ? 0x5865f2 : 0xe67e22)
    .setDescription(description || null)
    .addFields(
      { name: "名前", value: draft.name.slice(0, 100) || "（未設定）", inline: true },
      { name: "定員", value: capacityLabel(draft.capacity), inline: true },
      {
        name: "開催日時",
        value: draft.startAt === null ? "未定" : discordTimestamp(draft.startAt),
        inline: true,
      },
      { name: "説明", value: draft.description.slice(0, 1000) || "説明なし", inline: false },
      { name: "参加方法", value: approvalText(draft), inline: true },
      {
        name: "集合時間",
        value: draft.meetingAt === null ? "未設定" : discordTimestamp(draft.meetingAt),
        inline: true,
      },
      { name: "集合場所", value: draft.meetingPlace?.slice(0, 1000) || "未設定", inline: true },
      { name: "イベント連携", value: draft.eventEnabled ? "ON" : "OFF", inline: true },
      {
        name: "共同主催者",
        value: cohosts.length > 0 ? cohosts.map((id) => `<@${id}>`).join(" ").slice(0, 1000) : "なし",
        inline: false,
      },
      { name: "リマインダー", value: reminderStatus(meetup.id), inline: false },
      { name: "状態", value: meetup.state, inline: true },
    );
}

function hubComponents(
  meetup: Meetup,
  draft: EditDraft,
  sessionId: string,
  userId: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const links = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reminder:open:${meetup.id}`)
      .setLabel("リマインダー")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ops:archive-open:${meetup.id}`)
      .setLabel("アーカイブ")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ops:cancel-open:${meetup.id}`)
      .setLabel("中止")
      .setStyle(ButtonStyle.Danger),
  );
  const people: ButtonBuilder[] = [];
  if (isHost(meetup, userId)) {
    people.push(
      new ButtonBuilder()
        .setCustomId(`people:cohost-open:${meetup.id}`)
        .setLabel("共同主催者")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`people:host-open:${meetup.id}`)
        .setLabel("主催者変更")
        .setStyle(ButtonStyle.Secondary),
    );
  }
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`edit:basic:${sessionId}`)
        .setLabel("基本情報")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`edit:approval:${sessionId}`)
        .setLabel("参加方法")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`edit:meeting:${sessionId}`)
        .setLabel("集合情報")
        .setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder<MessageActionRowComponentBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`edit:event:${sessionId}`)
          .setLabel(`イベント連携: ${draft.eventEnabled ? "ON" : "OFF"}`)
          .setStyle(draft.eventEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(meetup.mode !== "PUBLIC" || draft.startAt === null),
      )
      .addComponents(...people),
    links,
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`edit:save:${sessionId}`)
        .setLabel("保存")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`edit:cancel:${sessionId}`)
        .setLabel("キャンセル")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function textInputRow(
  id: string,
  label: string,
  value: string,
  options: { required?: boolean; maxLength?: number; style?: TextInputStyle; placeholder?: string } = {},
): ActionRowBuilder<TextInputBuilder> {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(options.style ?? TextInputStyle.Short)
    .setRequired(options.required ?? false)
    .setMaxLength(options.maxLength ?? 100);
  if (value) input.setValue(value.slice(0, options.maxLength ?? 100));
  if (options.placeholder) input.setPlaceholder(options.placeholder);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

function basicModal(sessionId: string, draft: EditDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`edit:basic:${sessionId}`)
    .setTitle("基本情報を編集")
    .addComponents(
      textInputRow("name", "MeetUp名", draft.name, { required: true, maxLength: 100 }),
      textInputRow("description", "説明", draft.description, {
        style: TextInputStyle.Paragraph,
        maxLength: 1000,
      }),
      textInputRow("capacity", "定員（0で定員なし）", String(draft.capacity), {
        required: true,
        maxLength: 4,
      }),
      textInputRow(
        "start",
        "開催日時 (YYYY-MM-DD HH:mm・空欄で未定)",
        draft.startAt === null ? "" : formatInZone(draft.startAt),
        { required: false, maxLength: 32 },
      ),
    );
}

function meetingModal(sessionId: string, draft: EditDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`edit:meeting:${sessionId}`)
    .setTitle("集合情報を編集")
    .addComponents(
      textInputRow(
        "meeting-time",
        "集合時間 (YYYY-MM-DD HH:mm, 空で未設定)",
        draft.meetingAt === null ? "" : formatInZone(draft.meetingAt),
        { maxLength: 32, placeholder: "空欄で集合時間なし" },
      ),
      textInputRow("meeting-place", "集合場所", draft.meetingPlace ?? "", {
        maxLength: 200,
        placeholder: "空欄で集合場所なし",
      }),
    );
}

function votesModal(sessionId: string, draft: EditDraft): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`edit:votes:${sessionId}`)
    .setTitle("参加者投票の必要票数")
    .addComponents(
      textInputRow("required-votes", "必要票数（1〜100）", String(draft.requiredVotes), {
        required: true,
        maxLength: 3,
      }),
    );
}

async function renderHub(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
  meetup: Meetup,
  draft: EditDraft,
  sessionId: string,
  notice?: string,
): Promise<void> {
  const payload = {
    embeds: [hubEmbed(meetup, draft, notice)],
    components: hubComponents(meetup, draft, sessionId, interaction.user.id),
  };
  if (interaction.isModalSubmit()) {
    await interaction.deferUpdate();
    await interaction.editReply(payload);
    return;
  }
  await interaction.update(payload);
}

function approvalEmbed(draft: EditDraft, meetup: Meetup): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("参加方法")
    .setColor(0x5865f2)
    .setDescription(
      [
        `現在: **${approvalText(draft)}**`,
        "",
        "直参加: 申請するとすぐに参加確定します。",
        "主催者承認: 主催者・共同主催者が承認します。",
        "参加者投票: 参加確定者の賛成票が必要票数に達すると承認されます。",
        meetup.mode === "PRIVATE" ? "\n招待制のMeetUpは主催者承認に固定です。" : null,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    );
}

function approvalComponents(
  meetup: Meetup,
  draft: EditDraft,
  sessionId: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`edit:mode:${sessionId}`)
    .setPlaceholder("参加方法を選択")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(meetup.mode === "PRIVATE")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("直参加")
        .setValue("DIRECT")
        .setDefault(draft.approvalMode === "DIRECT"),
      new StringSelectMenuOptionBuilder()
        .setLabel("主催者承認")
        .setValue("HOST")
        .setDefault(draft.approvalMode === "HOST"),
      new StringSelectMenuOptionBuilder()
        .setLabel("参加者投票")
        .setValue("VOTE")
        .setDefault(draft.approvalMode === "VOTE"),
    );
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`edit:back:${sessionId}`)
        .setLabel("設定へ戻る")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function parseInteger(value: string, label: string, min: number, max: number): number {
  const text = value.trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label}は${min}以上の整数で入力してください。`);
  const parsed = Number(text);
  if (parsed < min || parsed > max) throw new Error(`${label}は${min}〜${max}の範囲で入力してください。`);
  return parsed;
}

interface ResolvedSession {
  sessionId: string;
  draft: EditDraft;
  meetup: Meetup;
}

async function resolveSession(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
  sessionId: string,
): Promise<ResolvedSession | null> {
  const session = getUiSession<EditDraft>(interaction, sessionId);
  if (!session) {
    await replyEphemeral(
      interaction,
      "編集画面の有効期限が切れました。`/meetupper edit` を開き直してください。",
    );
    return null;
  }
  if (session.meetupId === null) {
    await replyEphemeral(interaction, "編集対象のMeetUpが見つかりません。");
    return null;
  }
  const meetup = getMeetup(session.meetupId);
  if (!meetup || meetup.guildId !== session.guildId) {
    await replyEphemeral(interaction, "MeetUpが見つかりません。");
    return null;
  }
  // Ownership, guild and permission are re-checked on every interaction (ui.ts covers the first two).
  if (meetup.state !== "ACTIVE") {
    await replyEphemeral(interaction, "ACTIVEなMeetUpのみ編集できます。");
    return null;
  }
  if (!canManage(meetup, interaction.user.id)) {
    await replyEphemeral(interaction, "主催者または共同主催者のみ編集できます。");
    return null;
  }
  return { sessionId: session.id, draft: session.data, meetup };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function openHub(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction,
  meetup: Meetup,
): Promise<void> {
  if (!canManage(meetup, interaction.user.id)) {
    await replyEphemeral(interaction, "主催者または共同主催者のみ編集できます。");
    return;
  }
  if (meetup.state !== "ACTIVE") {
    await replyEphemeral(interaction, "ACTIVEなMeetUpのみ編集できます。");
    return;
  }
  const draft = draftFromMeetup(meetup);
  const session = createUiSession({
    ownerId: interaction.user.id,
    guildId: meetup.guildId,
    meetupId: meetup.id,
    data: draft,
  });
  await replyEphemeral(interaction, {
    embeds: [hubEmbed(meetup, draft)],
    components: hubComponents(meetup, draft, session.id, interaction.user.id),
  });
}

/** Applies every draft field, rebuilds reminders only when the base time moved, then syncs Discord. */
export async function commitDraft(
  guild: Guild,
  meetup: Meetup,
  draft: EditDraft,
  now = Date.now(),
): Promise<{ updated: Meetup; warnings: string[]; changed: boolean }> {
  validateDraft(draft, meetup.mode, now, {
    originalMeetingAt: meetup.meetingAt,
    originalStartAt: meetup.startAt,
  });
  const changed = !sameDraft(meetup, draft);
  if (!changed) return { updated: meetup, warnings: [], changed: false };

  const previousBase = reminderBaseAt(meetup);
  const hadEventId = meetup.eventId;
  db.transaction(() => {
    updateMeetup(meetup.id, {
      name: draft.name.trim(),
      description: draft.description.trim(),
      capacity: draft.capacity,
      startAt: draft.startAt,
      approvalMode: draft.approvalMode,
      meetingAt: draft.meetingAt,
      meetingPlace: draft.meetingPlace?.trim() || null,
    });
    // updateMeetup has no columns for these two, so they are written directly.
    db.query("UPDATE meetups SET required_votes = ?, event_enabled = ? WHERE id = ?").run(
      draft.requiredVotes,
      draft.eventEnabled ? 1 : 0,
      meetup.id,
    );
    const recalculated = getMeetup(meetup.id)!;
    if (reminderBaseAt(recalculated) !== previousBase) {
      recalculateSchedules(meetup.id, { resetAll: true, now });
    }
  })();

  let updated = getMeetup(meetup.id)!;
  const warnings: string[] = [];

  if (updated.mode === "PUBLIC" && updated.eventEnabled && updated.startAt !== null) {
    if (hadEventId) {
      await updateEvent(guild, updated);
    } else if (!(await syncEventCreation(guild, updated))) {
      warnings.push(
        "Discordスケジュールイベントを作成できませんでした。Botの「イベントを作成」権限を確認してください。",
      );
    }
  } else if (updated.eventId) {
    await cancelEvent(guild, updated);
    updateMeetup(updated.id, { eventId: null });
    updated = getMeetup(updated.id)!;
  }
  if (updated.mode === "PUBLIC" && updated.eventEnabled && updated.startAt === null) {
    warnings.push("開催日時が未定のため、スケジュールイベントは作成していません。");
  }

  if (updated.mode === "PUBLIC") {
    const open = isParticipationOpen(updated);
    if (!updated.forumThreadId && open) {
      try {
        const layout = await ensureLayout(guild);
        const thread = await layout.forum.threads.create({
          name: updated.name.slice(0, 100),
          message: { embeds: [publicEmbed(updated)], components: [applyButtonRow(updated)] },
        });
        updateMeetup(updated.id, { forumThreadId: thread.id });
        updated = getMeetup(updated.id)!;
      } catch (error) {
        console.error("募集投稿の作成に失敗しました", error);
        warnings.push("募集フォーラムへの投稿に失敗しました。");
      }
    }

    if (updated.forumThreadId) {
      try {
        const thread = await guild.channels.fetch(updated.forumThreadId);
        if (thread?.isThread()) {
          if (open && isRecruitmentClosed(updated.id)) {
            let reopened = true;
            if (thread.archived) {
              await thread.setArchived(false).catch(() => {
                reopened = false;
              });
            }
            if (thread.locked) {
              await thread.setLocked(false).catch(() => {
                reopened = false;
              });
            }
            if (reopened) clearRecruitmentClosed(updated.id);
          }
          await thread.setName(updated.name.slice(0, 100));
          const starter = await thread.fetchStarterMessage().catch(() => null);
          if (starter) {
            const embeds = open
              ? [publicEmbed(updated)]
              : [publicEmbed(updated).addFields({ name: "募集状況", value: "募集は終了しました" })];
            await starter.edit({
              embeds,
              components: open ? [applyButtonRow(updated)] : [],
            });
          }
        }
      } catch (error) {
        console.error("募集投稿の更新に失敗しました", error);
        warnings.push("募集投稿の更新に失敗しました。");
      }
    }
  }

  if (
    draft.capacity !== meetup.capacity &&
    updated.capacity > 0 &&
    countApproved(updated.id) > updated.capacity
  ) {
    warnings.push("確定済みの参加者数が新しい定員を超えています。");
  }

  const sent = await sendToMeetupChannel(guild, updated, {
    embeds: [
      messageEmbed("MeetUp情報が更新されました。"),
      meetupEmbed(updated, { includeMeetingPlace: true }),
    ],
  });
  if (!sent) console.error(`更新通知を送信できませんでした: meetup=${updated.id}`);

  return { updated, warnings, changed: true };
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("edit")
    .setDescription("MeetUpの設定をまとめて編集します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
      return;
    }
    await deferEphemeral(interaction);
    try {
      const id = interaction.options.getInteger("meetup");
      const meetup = id !== null ? getMeetup(id) : null;
      if (id !== null && (!meetup || meetup.guildId !== guild.id)) {
        await replyEphemeral(interaction, "MeetUpが見つかりません。");
        return;
      }
      if (meetup) {
        await openHub(interaction, meetup);
        return;
      }
      const choices = listMeetups(guild.id, ["ACTIVE"]).filter((item) =>
        canManage(item, interaction.user.id),
      );
      if (choices.length === 0) {
        await replyEphemeral(interaction, "編集できるMeetUpがありません。");
        return;
      }
      const session = createUiSession<null>({
        ownerId: interaction.user.id,
        guildId: guild.id,
        data: null,
      });
      await replyEphemeral(interaction, {
        embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription("編集するMeetUpを選択してください。")],
        components: [meetupSelectRow(`edit:pick:${session.id}`, choices.map((item) => ({ meetup: item })))],
      });
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

selectMenu(/^edit:pick:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<null>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, "画面の有効期限が切れました。コマンドを開き直してください。");
      return;
    }
    const meetup = getMeetup(selectedNumber(interaction) ?? 0);
    if (!meetup || meetup.guildId !== session.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (meetup.state !== "ACTIVE" || !canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "このMeetUpは編集できません。");
      return;
    }
    await openHub(interaction, meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^edit:open:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0]));
    if (!meetup || meetup.guildId !== interaction.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    await openHub(interaction, meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^edit:basic:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  await interaction.showModal(basicModal(resolved.sessionId, resolved.draft));
});

button(/^edit:meeting:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  await interaction.showModal(meetingModal(resolved.sessionId, resolved.draft));
});

button(/^edit:approval:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  await interaction.update({
    embeds: [approvalEmbed(resolved.draft, resolved.meetup)],
    components: approvalComponents(resolved.meetup, resolved.draft, resolved.sessionId),
  });
});

button(/^edit:back:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  await renderHub(interaction, resolved.meetup, resolved.draft, resolved.sessionId);
});

button(/^edit:event:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  if (resolved.meetup.mode !== "PUBLIC") {
    await renderHub(
      interaction,
      resolved.meetup,
      resolved.draft,
      resolved.sessionId,
      "イベント連携はPublicのMeetUpのみ設定できます。",
    );
    return;
  }
  resolved.draft.eventEnabled = !resolved.draft.eventEnabled;
  await renderHub(interaction, resolved.meetup, resolved.draft, resolved.sessionId);
});

button(/^edit:save:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, "この操作はサーバー内でのみ使用できます。");
    return;
  }
  await interaction.deferUpdate();
  try {
    const result = await commitDraft(guild, resolved.meetup, resolved.draft);
    dropUiSession(resolved.sessionId);
    const lines = [
      result.changed ? "MeetUp情報を保存しました。" : "変更はありません。",
      ...result.warnings,
    ];
    await interaction.editReply({
      embeds: [messageEmbed(lines.join("\n"))],
      components: result.changed ? [meetupNavRow(result.updated.id)] : [],
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [hubEmbed(resolved.meetup, resolved.draft, errorMessage(error))],
      components: hubComponents(
        resolved.meetup,
        resolved.draft,
        resolved.sessionId,
        interaction.user.id,
      ),
    });
  }
});

button(/^edit:cancel:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  dropUiSession(resolved.sessionId);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription("編集内容を破棄しました。")],
    components: [],
  });
});

selectMenu(/^edit:mode:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  if (resolved.meetup.mode === "PRIVATE") {
    await renderHub(
      interaction,
      resolved.meetup,
      resolved.draft,
      resolved.sessionId,
      "招待制のMeetUpは主催者承認に固定です。",
    );
    return;
  }
  const value = interaction.values[0] as ApprovalMode;
  if (!["DIRECT", "HOST", "VOTE"].includes(value)) {
    await renderHub(
      interaction,
      resolved.meetup,
      resolved.draft,
      resolved.sessionId,
      "参加方法が不正です。",
    );
    return;
  }
  resolved.draft.approvalMode = value;
  if (value === "VOTE") {
    await interaction.showModal(votesModal(resolved.sessionId, resolved.draft));
    return;
  }
  await renderHub(interaction, resolved.meetup, resolved.draft, resolved.sessionId);
});

modal(/^edit:basic:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  const { draft, meetup, sessionId } = resolved;
  try {
    const name = interaction.fields.getTextInputValue("name").trim();
    const description = interaction.fields.getTextInputValue("description").trim();
    const capacity = parseInteger(
      interaction.fields.getTextInputValue("capacity"),
      "定員",
      0,
      1000,
    );
    const startText = interaction.fields.getTextInputValue("start").trim();
    // Keeping the shown value preserves the exact stored timestamp (and avoids a reminder rebuild
    // caused only by reformatting seconds away).
    let startAt: number | null;
    if (draft.startAt !== null && startText === formatInZone(draft.startAt)) {
      startAt = draft.startAt;
    } else if (startText === "") {
      startAt = null;
    } else {
      startAt = parseDateTime(startText);
      if (startAt === null) {
        throw new Error(`開催日時の形式が正しくありません。${dateTimeHint()}`);
      }
    }
    const candidate: EditDraft = {
      ...draft,
      name,
      description,
      capacity,
      startAt,
      eventEnabled: startAt === null ? false : draft.eventEnabled,
    };
    validateDraft(candidate, meetup.mode, Date.now(), {
      originalMeetingAt: meetup.meetingAt,
      originalStartAt: meetup.startAt,
    });
    Object.assign(draft, candidate);
    await renderHub(interaction, meetup, draft, sessionId);
  } catch (error) {
    await renderHub(interaction, meetup, draft, sessionId, errorMessage(error));
  }
});

modal(/^edit:meeting:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  const { draft, meetup, sessionId } = resolved;
  try {
    const timeText = interaction.fields.getTextInputValue("meeting-time").trim();
    let meetingAt: number | null = null;
    if (timeText) {
      meetingAt =
        draft.meetingAt !== null && timeText === formatInZone(draft.meetingAt)
          ? draft.meetingAt
          : parseDateTime(timeText);
      if (meetingAt === null) {
        throw new Error(`集合時間の形式が正しくありません。${dateTimeHint()}`);
      }
    }
    const meetingPlace = interaction.fields.getTextInputValue("meeting-place").trim() || null;
    const candidate: EditDraft = { ...draft, meetingAt, meetingPlace };
    validateDraft(candidate, meetup.mode, Date.now(), {
      originalMeetingAt: meetup.meetingAt,
      originalStartAt: meetup.startAt,
    });
    Object.assign(draft, candidate);
    await renderHub(interaction, meetup, draft, sessionId);
  } catch (error) {
    await renderHub(interaction, meetup, draft, sessionId, errorMessage(error));
  }
});

modal(/^edit:votes:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveSession(interaction, args[0]!);
  if (!resolved) return;
  const { draft, meetup, sessionId } = resolved;
  try {
    const requiredVotes = parseInteger(
      interaction.fields.getTextInputValue("required-votes"),
      "必要票数",
      1,
      100,
    );
    const candidate: EditDraft = { ...draft, requiredVotes };
    validateDraft(candidate, meetup.mode, Date.now(), {
      originalMeetingAt: meetup.meetingAt,
      originalStartAt: meetup.startAt,
    });
    Object.assign(draft, candidate);
    await renderHub(interaction, meetup, draft, sessionId);
  } catch (error) {
    await renderHub(interaction, meetup, draft, sessionId, errorMessage(error));
  }
});
