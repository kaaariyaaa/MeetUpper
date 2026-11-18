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
  Events as DiscordEvents,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
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
  pruneReminderHistory,
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
  changeOffset?: number;
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
      return schedule.lastError ? `失敗: ${schedule.lastError.slice(0, 200)}` : "失敗";
    case "SKIPPED":
      return schedule.skipReason ? `スキップ: ${schedule.skipReason.slice(0, 200)}` : "スキップ";
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
  const atMax = draft.offsets.length >= MAX_REMINDER_OFFSETS;
  const controls = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`reminder:toggle:${draft.id}`)
      .setLabel(`自動通知: ${draft.enabled ? "ON" : "OFF"}`)
      .setStyle(draft.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:custom:${draft.id}`)
      .setLabel("自由設定")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atMax),
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
    .setPlaceholder(atMax ? "通知時刻は最大5件です" : "選択式の通知時刻を追加")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(atMax)
    .addOptions(
      PRESET_REMINDER_OFFSETS.map((preset) => ({
        label: preset.label,
        value: String(preset.seconds),
        disabled: draft.offsets.includes(preset.seconds),
      })),
    );

  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [
    controls,
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(addSelect),
  ];

  if (draft.offsets.length > 0) {
    const removeSelect = new StringSelectMenuBuilder()
      .setCustomId(`reminder:remove:${draft.id}`)
      .setPlaceholder("削除する通知時刻")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        draft.offsets.map((offset) =>
          new StringSelectMenuOptionBuilder().setLabel(formatOffset(offset)).setValue(String(offset)),
        ),
      );
    const changeSelect = new StringSelectMenuBuilder()
      .setCustomId(`reminder:change:${draft.id}`)
      .setPlaceholder("変更する通知時刻")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(
        draft.offsets.map((offset) =>
          new StringSelectMenuOptionBuilder().setLabel(formatOffset(offset)).setValue(String(offset)),
        ),
      );
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(removeSelect),
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(changeSelect),
    );
  }
  return rows;
}

async function resolveDraft(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
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
  // Every control must prove it belongs to this guild's panel, not just to a matching draft id.
  const interactionGuildId = interaction.guildId ?? interaction.guild?.id ?? null;
  if (interactionGuildId === null || interactionGuildId !== draft.guildId) {
    await replyEphemeral(interaction, "この設定画面は別のサーバーでは操作できません。");
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
  // Only a successfully authorised interaction keeps the draft alive.
  draft.expiresAt = Date.now() + DRAFT_TTL_MS;
  return { draft, meetup };
}

function parseField(value: string, label: string): number {
  const text = value.trim();
  if (text === "") return 0;
  if (!/^\d+$/.test(text)) throw new Error(`${label}は0以上の整数で入力してください。`);
  return Number(text);
}

function historyEmbed(
  meetup: Meetup,
  rows: ReturnType<typeof listReminderHistory>["rows"],
  total: number,
  page: number,
): EmbedBuilder {
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
        const reason = row.reason ? `\n理由: ${row.reason.slice(0, 200)}` : "";
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
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
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
  // The history view is also the natural place to enforce the 90-day retention window.
  pruneReminderHistory();
  const requestedPage = Math.max(0, page);
  let history = listReminderHistory(meetup.id, HISTORY_PAGE_SIZE, requestedPage * HISTORY_PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(history.total / HISTORY_PAGE_SIZE));
  const safePage = Math.min(requestedPage, pages - 1);
  if (safePage !== requestedPage) {
    history = listReminderHistory(meetup.id, HISTORY_PAGE_SIZE, safePage * HISTORY_PAGE_SIZE);
  }
  await interaction.update({
    embeds: [historyEmbed(meetup, history.rows, history.total, safePage)],
    components: historyComponents(draft, safePage, history.total),
  });
}

async function openReminderPanel(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  meetup: Meetup,
): Promise<void> {
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
      await openReminderPanel(interaction, meetup);
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

button(/^reminder:open:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0]));
    if (!meetup || meetup.guildId !== interaction.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    await openReminderPanel(interaction, meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

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

function offsetModal(draft: Draft, changeOffset?: number): ModalBuilder {
  const seconds = changeOffset ?? 0;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const input = (id: string, label: string, value: number) =>
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(4)
      .setValue(value > 0 ? String(value) : "");
  return new ModalBuilder()
    .setCustomId(`reminder:modal:${draft.id}`)
    .setTitle(changeOffset === undefined ? "通知時刻の自由設定（最短1分前）" : "通知時刻の変更")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input("days", "日（0以上）", days)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("hours", "時間（0以上・24時間超も可）", hours),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(input("minutes", "分（0以上）", minutes)),
    );
}

button(/^reminder:custom:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  if (resolved.draft.offsets.length >= MAX_REMINDER_OFFSETS) {
    await updatePanel(interaction, resolved.draft, resolved.meetup, "通知時刻は最大5件です。");
    return;
  }
  resolved.draft.changeOffset = undefined;
  await interaction.showModal(offsetModal(resolved.draft));
});

selectMenu(/^reminder:change:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const offset = Number(interaction.values[0]);
  if (!resolved.draft.offsets.includes(offset)) {
    await updatePanel(interaction, resolved.draft, resolved.meetup, "通知時刻が不正です。");
    return;
  }
  resolved.draft.changeOffset = offset;
  await interaction.showModal(offsetModal(resolved.draft, offset));
});

modal(/^reminder:modal:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  let offsets: number[];
  try {
    const days = parseField(interaction.fields.getTextInputValue("days"), "日");
    const hours = parseField(interaction.fields.getTextInputValue("hours"), "時間");
    const minutes = parseField(interaction.fields.getTextInputValue("minutes"), "分");
    const offset = offsetFromParts(days, hours, minutes);
    const base = draft.offsets.filter((value) => value !== draft.changeOffset);
    offsets = validateReminderOffsets(draft.enabled, base.includes(offset) ? base : [...base, offset]);
  } catch (error) {
    await updatePanel(
      interaction,
      draft,
      meetup,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  draft.offsets = offsets;
  draft.changeOffset = undefined;
  await updatePanel(interaction, draft, meetup);
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
    await updatePanel(interaction, draft, meetup, error instanceof Error ? error.message : String(error));
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
  if (!PRESET_REMINDER_OFFSETS.some((preset) => preset.seconds === offset)) {
    await updatePanel(interaction, draft, meetup, "選択式にない通知時刻です。");
    return;
  }
  try {
    draft.offsets = validateReminderOffsets(
      draft.enabled,
      draft.offsets.includes(offset) ? draft.offsets : [...draft.offsets, offset],
    );
    await updatePanel(interaction, draft, meetup);
  } catch (error) {
    await updatePanel(interaction, draft, meetup, error instanceof Error ? error.message : String(error));
  }
});

selectMenu(/^reminder:remove:([A-Za-z0-9]+)$/, async (interaction) => {
  const resolved = await resolveDraft(interaction);
  if (!resolved) return;
  const { draft, meetup } = resolved;
  const offset = Number(interaction.values[0]);
  if (!draft.offsets.includes(offset)) {
    await updatePanel(interaction, draft, meetup, "通知時刻が不正です。");
    return;
  }
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
  client.once(DiscordEvents.ClientReady, () => void tickReminders(client));
  const timer = setInterval(() => void tickReminders(client), 30_000);
  timer.unref?.();
});
