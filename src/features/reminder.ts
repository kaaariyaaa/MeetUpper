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
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import {
  deferEphemeral,
  replyEphemeral,
  replyError,
  resolveTargetMeetup,
} from "../core/discord.ts";
import { canManage, getMeetup } from "../core/meetup.ts";
import {
  MAX_REMINDER_OFFSETS,
  PRESET_REMINDER_OFFSETS,
  ReminderVersionConflictError,
  formatOffset,
  getReminderOffsets,
  getReminderSettings,
  listReminderHistory,
  listSchedules,
  offsetFromParts,
  reminderBaseAt,
  saveReminderSettings,
  validateReminderOffsets,
} from "../core/reminders.ts";
import { tickReminders } from "../core/reminderEngine.ts";
import { button, modal, selectMenu, setup, subcommand } from "../core/registry.ts";
import { discordTimestamp } from "../core/time.ts";
import type { Meetup, ReminderSchedule } from "../core/types.ts";

const DRAFT_TTL_MS = 15 * 60 * 1000;
const HISTORY_PAGE_SIZE = 5;

interface Draft {
  id: string;
  meetupId: number;
  guildId: string;
  ownerId: string;
  version: number;
  enabled: boolean;
  offsets: number[];
  expiresAt: number;
}

const drafts = new Map<string, Draft>();

function newSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function cleanupDrafts(now = Date.now()): void {
  for (const [key, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(key);
  }
}

function getDraft(id: string): Draft | null {
  cleanupDrafts();
  return drafts.get(id) ?? null;
}

function sameSettings(draft: Draft, meetupId: number): boolean {
  const settings = getReminderSettings(meetupId);
  const offsets = getReminderOffsets(meetupId);
  return (
    settings.enabled === draft.enabled &&
    offsets.length === draft.offsets.length &&
    offsets.every((offset, index) => offset === draft.offsets[index])
  );
}

function statusLabel(
  schedule: ReminderSchedule | undefined,
  baseAt: number,
  offset: number,
  enabled: boolean,
): string {
  if (!schedule) {
    if (baseAt - offset * 1000 <= Date.now()) return "登録なし（過去）";
    return enabled ? "未保存" : "OFFのため未登録";
  }
  switch (schedule.status) {
    case "PENDING":
      return "送信待ち";
    case "SENDING":
      return "送信中";
    case "SENT":
      return "送信済み";
    case "FAILED":
      return schedule.lastError ? `失敗: ${schedule.lastError}` : "失敗";
    case "SKIPPED":
      return schedule.skipReason ? `スキップ: ${schedule.skipReason}` : "スキップ";
  }
}

function panelEmbed(meetup: Meetup, draft: Draft, notice?: string): EmbedBuilder {
  const baseAt = reminderBaseAt(meetup);
  const schedules = listSchedules(meetup.id);
  const embed = new EmbedBuilder()
    .setTitle(`リマインダー設定: ${meetup.name}`)
    .setColor(draft.enabled ? 0x2ecc71 : 0x95a5a6)
    .setDescription(
      [
        `自動通知: **${draft.enabled ? "ON" : "OFF"}**`,
        `通知基準: ${meetup.meetingAt !== null ? "集合時間" : "開催日時"} ${discordTimestamp(baseAt)}`,
        sameSettings(draft, meetup.id) ? null : "未保存の変更があります。",
        notice ?? null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setFooter({ text: `設定バージョン: ${draft.version}` });

  if (draft.offsets.length === 0) {
    embed.addFields({ name: "通知時刻", value: "設定なし", inline: false });
  }
  for (const offset of draft.offsets) {
    const scheduledAt = baseAt - offset * 1000;
    const schedule = schedules.find(
      (item) => item.baseAt === baseAt && item.offsetSeconds === offset,
    );
    const status = statusLabel(schedule, baseAt, offset, draft.enabled);
    const sentLine = schedule?.sentAt ? `\n送信: ${discordTimestamp(schedule.sentAt, "t")}` : "";
    embed.addFields({
      name: formatOffset(offset),
      value: `${discordTimestamp(scheduledAt, "F")}\n${status}${sentLine}`,
      inline: true,
    });
  }
  return embed;
}

function panelComponents(draft: Draft): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const controls = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reminder:toggle:${draft.id}`)
      .setLabel(`自動通知: ${draft.enabled ? "ON" : "OFF"}`)
      .setStyle(draft.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:custom:${draft.id}`)
      .setLabel("自由設定")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:history:${draft.id}:0`)
      .setLabel("履歴")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:save:${draft.id}`)
      .setLabel("保存")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`reminder:cancel:${draft.id}`)
      .setLabel("キャンセル")
      .setStyle(ButtonStyle.Danger),
  );

  const addSelect = new StringSelectMenuBuilder()
    .setCustomId(`reminder:preset:${draft.id}`)
    .setPlaceholder("選択式の通知時刻を追加")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      PRESET_REMINDER_OFFSETS.map((preset) => ({
        label: preset.label,
        value: String(preset.seconds),
        disabled:
          draft.offsets.includes(preset.seconds) || draft.offsets.length >= MAX_REMINDER_OFFSETS,
      })),
    );

  const removeSelect = new StringSelectMenuBuilder()
    .setCustomId(`reminder:remove:${draft.id}`)
    .setPlaceholder(draft.offsets.length === 0 ? "削除できる通知時刻がありません" : "削除する通知時刻")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(draft.offsets.length === 0)
    .addOptions(
      draft.offsets.map((offset) =>
        new StringSelectMenuOptionBuilder().setLabel(formatOffset(offset)).setValue(String(offset)),
      ),
    );

  return [
    controls,
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(addSelect),
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(removeSelect),
  ];
}

async function resolveDraft(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
): Promise<{ draft: Draft; meetup: Meetup } | null> {
  const id = interaction.customId.split(":")[2] ?? "";
  const draft = getDraft(id);
  if (!draft) {
    await replyEphemeral(interaction, "設定画面の有効期限が切れました。`/meetupper reminder` を開き直してください。");
    return null;
  }
  if (draft.ownerId !== interaction.user.id) {
    await replyEphemeral(interaction, "この設定画面は開いた本人だけが操作できます。");
    return null;
  }
  const meetup = getMeetup(draft.meetupId);
  if (!meetup || meetup.guildId !== draft.guildId || meetup.state !== "ACTIVE") {
    await replyEphemeral(interaction, "ACTIVEなMeetUpが見つかりません。");
    return null;
  }
  if (!canManage(meetup, interaction.user.id)) {
    await replyEphemeral(interaction, "主催者または共同主催者のみ操作できます。");
    return null;
  }
  return { draft, meetup };
}

function parseField(value: string, label: string): number {
  const text = value.trim();
  if (text === "") return 0;
  if (!/^\d+$/.test(text)) throw new Error(`${label}は0以上の整数で入力してください。`);
  return Number(text);
}

function historyEmbed(meetup: Meetup, page: number): EmbedBuilder {
  const { rows, total } = listReminderHistory(meetup.id, HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const embed = new EmbedBuilder()
    .setTitle(`リマインダー履歴: ${meetup.name}`)
    .setColor(0x5865f2)
    .setFooter({ text: `${page + 1} / ${pages} ページ（${total}件・90日保存）` });
  if (rows.length === 0) {
    embed.setDescription("履歴はありません。");
    return embed;
  }
  embed.setDescription(
    rows
      .map((row) => {
        const sent = row.sentAt ? ` / 送信 ${discordTimestamp(row.sentAt, "t")}` : "";
        const reason = row.reason ? `\n理由: ${row.reason}` : "";
        return `**${row.status}** ${discordTimestamp(row.scheduledAt, "F")}（${formatOffset(row.offsetSeconds)} / 基準 ${discordTimestamp(row.baseAt, "d")}）${sent}${reason}`;
      })
      .join("\n\n"),
  );
  return embed;
}

function historyComponents(draft: Draft, page: number, total: number): ActionRowBuilder<ButtonBuilder>[] {
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`reminder:history:${draft.id}:${page - 1}`)
        .setLabel("前へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`reminder:history:${draft.id}:${page + 1}`)
        .setLabel("次へ")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page + 1 >= pages),
      new ButtonBuilder()
        .setCustomId(`reminder:back:${draft.id}`)
        .setLabel("設定へ戻る")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

async function updatePanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  draft: Draft,
  meetup: Meetup,
  notice?: string,
): Promise<void> {
  const payload = {
    embeds: [panelEmbed(meetup, draft, notice)],
    components: panelComponents(draft),
  };
  if (interaction.isModalSubmit()) {
    await interaction.deferUpdate();
    await interaction.editReply(payload);
    return;
  }
  await interaction.update(payload);
}

async function updateHistory(
  interaction: ButtonInteraction,
  draft: Draft,
  meetup: Meetup,
  page: number,
): Promise<void> {
  const total = listReminderHistory(meetup.id, 1, 0).total;
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  await interaction.update({
    embeds: [historyEmbed(meetup, safePage)],
    components: historyComponents(draft, safePage, total),
  });
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("reminder")
    .setDescription("自動リマインダーの設定を開きます")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    if (!interaction.guild) {
      await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
      return;
    }
    await deferEphemeral(interaction);
    try {
      const meetup = resolveTargetMeetup(interaction.guild, interaction);
      if (!canManage(meetup, interaction.user.id)) {
        await replyEphemeral(interaction, "主催者または共同主催者のみ設定を変更できます。");
        return;
      }
      if (meetup.state !== "ACTIVE") {
        await replyEphemeral(interaction, "ACTIVEなMeetUpのみ設定を変更できます。");
        return;
      }
      cleanupDrafts();
      const settings = getReminderSettings(meetup.id);
      const offsets = getReminderOffsets(meetup.id);
      const draft: Draft = {
        id: newSessionId(),
        meetupId: meetup.id,
        guildId: meetup.guildId,
        ownerId: interaction.user.id,
        version: settings.version,
        enabled: settings.enabled,
        offsets,
        expiresAt: Date.now() + DRAFT_TTL_MS,
      };
      drafts.set(draft.id, draft);
      await replyEphemeral(interaction, {
        embeds: [panelEmbed(meetup, draft)],
        components: panelComponents(draft),
      });
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

button(/^reminder:toggle:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  if (!draft.enabled && draft.offsets.length === 0) {
    await updatePanel(
      interaction,
      draft,
      meetup,
      "通知時刻が0件のためONにできません。先に時刻を追加してください。",
    );
    return;
  }
  draft.enabled = !draft.enabled;
  await updatePanel(interaction, draft, meetup);
});

button(/^reminder:custom:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft } = resolved;
  const modal = new ModalBuilder()
    .setCustomId(`reminder:modal:${draft.id}`)
    .setTitle("通知時刻の自由設定（最短1分前）")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("days")
          .setLabel("日（0以上）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(4),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("hours")
          .setLabel("時間（0以上・24時間超も可）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(4),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("minutes")
          .setLabel("分（0以上）")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(4),
      ),
    );
  await interaction.showModal(modal);
});

modal(/^reminder:modal:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  try {
    const days = parseField(interaction.fields.getTextInputValue("days"), "日");
    const hours = parseField(interaction.fields.getTextInputValue("hours"), "時間");
    const minutes = parseField(interaction.fields.getTextInputValue("minutes"), "分");
    const offset = offsetFromParts(days, hours, minutes);
    const offsets = validateReminderOffsets(
      draft.enabled,
      draft.offsets.includes(offset) ? draft.offsets : [...draft.offsets, offset],
    );
    draft.offsets = offsets;
    await updatePanel(interaction, draft, meetup);
  } catch (error) {
    await replyEphemeral(interaction, error instanceof Error ? error.message : String(error));
  }
});

button(/^reminder:save:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  try {
    const saved = saveReminderSettings(meetup.id, draft.version, draft.enabled, draft.offsets);
    draft.version = saved.version;
    draft.enabled = saved.enabled;
    draft.offsets = getReminderOffsets(meetup.id);
    await updatePanel(interaction, draft, meetup, "保存しました。");
  } catch (error) {
    if (error instanceof ReminderVersionConflictError) {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle("保存できませんでした")
            .setColor(0xe74c3c)
            .setDescription(
              "他の管理者が先に設定を保存しました。最新の設定を読み直してから、もう一度編集してください。",
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`reminder:reload:${draft.id}`)
              .setLabel("最新の設定を読み込む")
              .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
              .setCustomId(`reminder:cancel:${draft.id}`)
              .setLabel("閉じる")
              .setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
      return;
    }
    await replyEphemeral(interaction, error instanceof Error ? error.message : String(error));
  }
});

button(/^reminder:reload:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  const settings = getReminderSettings(meetup.id);
  draft.version = settings.version;
  draft.enabled = settings.enabled;
  draft.offsets = getReminderOffsets(meetup.id);
  await updatePanel(interaction, draft, meetup, "最新の設定を読み込みました。");
});

button(/^reminder:cancel:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  drafts.delete(resolved.draft.id);
  await interaction.update({
    embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription("設定の変更を破棄しました。")],
    components: [],
  });
});

button(/^reminder:history:([A-Za-z0-9]+):(\d+)$/, async (interaction, args) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const page = Number(args[1] ?? "0");
  await updateHistory(interaction, resolved.draft, resolved.meetup, Number.isFinite(page) ? page : 0);
});

button(/^reminder:back:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  await updatePanel(interaction, resolved.draft, resolved.meetup);
});

selectMenu(/^reminder:preset:([A-Za-z0-9]+)$/, async (interaction, args) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  const offset = Number(interaction.values[0]);
  if (!Number.isFinite(offset) || offset < 60) {
    await replyEphemeral(interaction, "通知時刻が不正です。");
    return;
  }
  try {
    draft.offsets = validateReminderOffsets(
      draft.enabled,
      draft.offsets.includes(offset) ? draft.offsets : [...draft.offsets, offset],
    );
    await updatePanel(interaction, draft, meetup);
  } catch (error) {
    await replyEphemeral(interaction, error instanceof Error ? error.message : String(error));
  }
});

selectMenu(/^reminder:remove:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  const offset = Number(interaction.values[0]);
  if (draft.enabled && draft.offsets.length <= 1) {
    await updatePanel(
      interaction,
      draft,
      meetup,
      "最後の1件は削除できません。自動通知をOFFにしてから削除してください。",
    );
    return;
  }
  draft.offsets = draft.offsets.filter((value) => value !== offset);
  await updatePanel(interaction, draft, meetup);
});

setup((client) => {
  void tickReminders(client);
  const timer = setInterval(() => void tickReminders(client), 30_000);
  timer.unref?.();
});
