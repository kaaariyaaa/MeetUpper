import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  LabelBuilder,
  ModalBuilder,
  SlashCommandSubcommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import { config } from "../config.ts";
import {
  createMeetupChannel,
  deferEphemeral,
  ensureLayout,
  isLayoutInitialized,
  replyEphemeral,
  replyError,
  setupRequiredMessage,
  syncMeetupAccess,
} from "../core/discord.ts";
import {
  createMeetup,
  deleteMeetup,
  getMeetup,
  updateMeetup,
  type CreateMeetupInput,
} from "../core/meetup.ts";
import { button, modal, subcommand } from "../core/registry.ts";
import { parseDateTime } from "../core/time.ts";
import type { ApprovalMode, MeetupMode } from "../core/types.ts";
import { createUiSession, dropUiSession, getUiSession } from "../core/ui.ts";
import { applyButtonRow, dateTimeHint, meetupEmbed, publicEmbed } from "../core/views.ts";

const MODE_ID = "create:mode";
const APPROVAL_ID = "create:approval";
const NAME_ID = "create:name";
const START_ID = "create:start";

const MODE_OPTIONS = [
  {
    label: "Public（公開）",
    value: "PUBLIC",
    description: "誰でも募集を閲覧・参加申請できます",
  },
  {
    label: "Private（招待制）",
    value: "PRIVATE",
    description: "招待された人だけが参加できます",
  },
] as const;

const APPROVAL_OPTIONS = [
  { label: "直参加", value: "DIRECT", description: "参加申請するとすぐに参加確定します" },
  { label: "主催者承認", value: "HOST", description: "主催者・共同主催者が承認します" },
  { label: "参加者投票", value: "VOTE", description: "参加確定者の賛成票で承認します" },
] as const;

export interface CreateFormValues {
  mode: string | null;
  approval: string | null;
  name: string;
  start: string;
}

export interface CreateDraft {
  mode: MeetupMode;
  approvalMode: ApprovalMode;
  name: string;
  startAt: number | null;
}

/** One modal for every create setting; Discord requires the four labels to be static. */
export function createModal(sessionId: string): ModalBuilder {
  const mode = new StringSelectMenuBuilder()
    .setCustomId(MODE_ID)
    .setPlaceholder("公開モードを選択")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      MODE_OPTIONS.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDescription(option.description),
      ),
    );
  const approval = new StringSelectMenuBuilder()
    .setCustomId(APPROVAL_ID)
    .setPlaceholder("参加方法を選択")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      APPROVAL_OPTIONS.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDescription(option.description),
      ),
    );
  const name = new TextInputBuilder()
    .setCustomId(NAME_ID)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true)
    .setPlaceholder("例: 東京MeetUp");
  const start = new TextInputBuilder()
    .setCustomId(START_ID)
    .setStyle(TextInputStyle.Short)
    .setMaxLength(32)
    .setRequired(false)
    .setPlaceholder("例: 2026-12-01 19:00（空欄で未定）");

  return new ModalBuilder()
    .setCustomId(`create:submit:${sessionId}`)
    .setTitle("MeetUpを作成")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("公開モード")
        .setDescription("Privateは招待制で、参加方法は主催者承認に固定されます。")
        .setStringSelectMenuComponent(mode),
      new LabelBuilder()
        .setLabel("参加方法")
        .setDescription("Privateを選んだ場合は主催者承認のみ有効です。")
        .setStringSelectMenuComponent(approval),
      new LabelBuilder().setLabel("MeetUp名").setTextInputComponent(name),
      new LabelBuilder()
        .setLabel("開催日時")
        .setDescription(`${config.timeZone} の YYYY-MM-DD HH:mm 形式。空欄の場合は未定になります。`)
        .setTextInputComponent(start),
    );
}

function selectedMode(value: string | null): MeetupMode {
  if (value === "PUBLIC" || value === "PRIVATE") return value;
  throw new Error("公開モードを選択してください。");
}

function selectedApproval(value: string | null): ApprovalMode {
  if (value === "DIRECT" || value === "HOST" || value === "VOTE") return value;
  throw new Error("参加方法を選択してください。");
}

/** Validates the modal values: Private stays on host approval and a supplied date must be in the future. */
export function parseCreateForm(values: CreateFormValues, now = Date.now()): CreateDraft {
  const mode = selectedMode(values.mode);
  // Private is fixed to host approval; ignore a non-HOST modal choice instead of failing the flow.
  const approvalMode = mode === "PRIVATE" ? "HOST" : selectedApproval(values.approval);

  const name = values.name.trim();
  if (!name) throw new Error("MeetUp名を入力してください。");
  if (name.length > 100) throw new Error("MeetUp名は100文字以内で入力してください。");

  let startAt: number | null = null;
  if (values.start.trim() !== "") {
    startAt = parseDateTime(values.start, config.timeZone);
    if (startAt === null) {
      throw new Error(`開催日時を解析できませんでした。\n${dateTimeHint()}`);
    }
    if (startAt <= now) {
      throw new Error("開催日時は未来の日時を指定してください。");
    }
  }

  return { mode, approvalMode, name, startAt };
}

/** Fixed create-time values from the UI spec: no capacity/description/meeting info, event off, reminders on. */
export function createInputFromDraft(
  guildId: string,
  hostId: string,
  draft: CreateDraft,
): CreateMeetupInput {
  return {
    guildId,
    hostId,
    name: draft.name,
    description: "",
    capacity: 0,
    startAt: draft.startAt,
    meetingAt: null,
    meetingPlace: null,
    mode: draft.mode,
    approvalMode: draft.approvalMode,
    requiredVotes: 1,
    eventEnabled: false,
    reminderEnabled: true,
  };
}

/** Success panel buttons: the cross-feature IDs are fixed by docs/UI_SPEC.md. */
export function createResultRow(meetupId: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`browse:show:${meetupId}`)
      .setLabel("MeetUpを開く")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`edit:open:${meetupId}`)
      .setLabel("編集")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`reminder:open:${meetupId}`)
      .setLabel("リマインダー")
      .setStyle(ButtonStyle.Secondary),
  );
}

function selectValue(interaction: ModalSubmitInteraction, customId: string): string | null {
  try {
    return interaction.fields.getStringSelectValues(customId)[0] ?? null;
  } catch {
    return null;
  }
}

async function requireGuild(interaction: ChatInputCommandInteraction): Promise<Guild | null> {
  if (!interaction.guild) {
    await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
    return null;
  }
  return interaction.guild;
}

async function openCreateModal(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, "この操作はサーバー内でのみ使用できます。");
    return;
  }
  if (!(await isLayoutInitialized(guild))) {
    await replyEphemeral(interaction, setupRequiredMessage(guild));
    return;
  }
  const session = createUiSession<null>({
    ownerId: interaction.user.id,
    guildId: guild.id,
    data: null,
  });
  await interaction.showModal(createModal(session.id));
}

subcommand(
  new SlashCommandSubcommandBuilder().setName("create").setDescription("MeetUpを作成します"),
  async (interaction) => {
    try {
      await openCreateModal(interaction);
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

button(/^create:open$/, async (interaction) => {
  try {
    await openCreateModal(interaction);
  } catch (error) {
    await replyError(interaction, error);
  }
});

modal(/^create:submit:([a-z0-9]+)$/, async (interaction, args) => {
  const sessionId = args[0];
  if (!sessionId) {
    await replyEphemeral(interaction, "この操作は現在利用できません。最初からやり直してください。");
    return;
  }
  try {
    const session = getUiSession(interaction, sessionId);
    if (!interaction.guild || !session) {
      await replyEphemeral(interaction, "この操作は現在利用できません。最初からやり直してください。");
      return;
    }
    const guild = interaction.guild;
    // Consume the session first so a duplicate submit cannot create a second MeetUp.
    dropUiSession(sessionId);
    await deferEphemeral(interaction);

    let draft: CreateDraft;
    try {
      draft = parseCreateForm({
        mode: selectValue(interaction, MODE_ID),
        approval: selectValue(interaction, APPROVAL_ID),
        name: interaction.fields.getTextInputValue(NAME_ID),
        start: interaction.fields.getTextInputValue(START_ID),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replyEphemeral(interaction, `${message}\nもう一度 \`/meetupper create\` からやり直してください。`);
      return;
    }

    const meetup = createMeetup(createInputFromDraft(guild.id, interaction.user.id, draft));

    let channel: TextChannel;
    try {
      channel = await createMeetupChannel(guild, meetup);
    } catch (error) {
      console.error("MeetUp専用チャンネルの作成に失敗しました", error);
      deleteMeetup(meetup.id);
      await replyEphemeral(
        interaction,
        "専用チャンネルを作成できなかったため、MeetUpの作成を取り消しました。" +
          "チャンネル数やBotの権限を確認してください。",
      );
      return;
    }

    const warnings: string[] = [];
    // No cohosts yet, but syncing now keeps the channel overwrites canonical.
    await syncMeetupAccess(guild, getMeetup(meetup.id)!).catch((error) => {
      console.error("専用チャンネルの権限設定に失敗しました", error);
      warnings.push("専用チャンネルの権限設定に失敗しました。Botの権限を確認してください。");
    });

    if (draft.mode === "PUBLIC") {
      try {
        const layout = await ensureLayout(guild);
        const thread = await layout.forum.threads.create({
          name: meetup.name.slice(0, 100),
          message: { embeds: [publicEmbed(meetup)], components: [applyButtonRow(meetup)] },
        });
        updateMeetup(meetup.id, { forumThreadId: thread.id });
      } catch (error) {
        console.error("募集フォーラムへの投稿に失敗しました", error);
        warnings.push("募集フォーラムへの投稿に失敗しました。");
      }
    }

    const embed = meetupEmbed(getMeetup(meetup.id) ?? meetup).addFields({
      name: "専用チャンネル",
      value: `<#${channel.id}>`,
      inline: false,
    });
    if (warnings.length > 0) {
      embed.addFields({ name: "注意", value: warnings.join("\n").slice(0, 1024), inline: false });
    }
    await replyEphemeral(interaction, { embeds: [embed], components: [createResultRow(meetup.id)] });
  } catch (error) {
    await replyError(interaction, error);
  }
});
