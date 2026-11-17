import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type TextChannel,
} from "discord.js";
import { config } from "../config.ts";
import {
  createMeetupChannel,
  deferEphemeral,
  ensureLayout,
  fetchMember,
  isLayoutInitialized,
  replyEphemeral,
  replyError,
  syncMeetupAccess,
} from "../core/discord.ts";
import { syncEventCreation } from "../core/events.ts";
import {
  addCohost,
  canManage,
  countApproved,
  createMeetup,
  deleteMeetup,
  getMeetup,
  getParticipant,
  listMeetups,
  updateMeetup,
} from "../core/meetup.ts";
import { subcommand } from "../core/registry.ts";
import { discordTimestamp, parseDateTime } from "../core/time.ts";
import type { ApprovalMode, MeetupMode } from "../core/types.ts";
import { dateTimeHint, meetupEmbed, publicEmbed } from "../core/views.ts";

/** "カンマ区切りのメンションまたはID" から数字IDだけを取り出す。 */
export function extractCohostIds(input: string): string[] {
  const ids = new Set<string>();
  for (const match of input.matchAll(/<@!?(\d+)>|(\d+)/g)) {
    const id = match[1] ?? match[2];
    if (id) ids.add(id);
  }
  return [...ids];
}

async function requireGuild(interaction: ChatInputCommandInteraction): Promise<Guild | null> {
  if (!interaction.guild) {
    await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
    return null;
  }
  return interaction.guild;
}

function parseOptionalDateTime(input: string | null): number | null | undefined {
  if (input === null || input.trim() === "") return null;
  const parsed = parseDateTime(input, config.timeZone);
  return parsed ?? undefined;
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("create")
    .setDescription("オフ会を作成します")
    // Discord requires every required option to precede all optional options.
    .addStringOption((option) =>
      option.setName("name").setDescription("オフ会名").setMaxLength(100).setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("capacity").setDescription("定員").setMinValue(1).setMaxValue(1000).setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("start")
        .setDescription("開催日時 (例: 2026-12-01 19:00, Asia/Tokyo)")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("公開モード")
        .setRequired(true)
        .addChoices({ name: "公開", value: "PUBLIC" }, { name: "招待制", value: "PRIVATE" }),
    )
    .addStringOption((option) => option.setName("description").setDescription("説明"))
    .addStringOption((option) => option.setName("meeting-time").setDescription("集合時間"))
    .addStringOption((option) => option.setName("meeting-place").setDescription("集合場所"))
    .addStringOption((option) =>
      option
        .setName("approval")
        .setDescription("承認方式")
        .addChoices({ name: "主催者承認", value: "HOST" }, { name: "参加者投票", value: "VOTE" }),
    )
    .addIntegerOption((option) =>
      option
        .setName("required-votes")
        .setDescription("参加者投票の必要票数")
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addStringOption((option) =>
      option.setName("cohosts").setDescription("共同主催者のメンションまたはIDをカンマ区切り"),
    )
    .addBooleanOption((option) =>
      option
        .setName("event")
        .setDescription("Discordスケジュールイベントを作成する (Publicのみ)"),
    ),
  async (interaction) => {
    try {
      const guild = await requireGuild(interaction);
      if (!guild) return;
      await deferEphemeral(interaction);
      if (!(await isLayoutInitialized(guild))) {
        await replyEphemeral(
          interaction,
          "サーバーのセットアップが完了していません。管理者が `/meetup init` を実行してください。",
        );
        return;
      }

      const startAt = parseDateTime(interaction.options.getString("start", true), config.timeZone);
      if (startAt === null) {
        await replyEphemeral(interaction, `開催日時を解析できませんでした。\n${dateTimeHint()}`);
        return;
      }
      if (startAt <= Date.now()) {
        await replyEphemeral(interaction, "開催日時は未来の日時を指定してください。");
        return;
      }

      const meetingAt = parseOptionalDateTime(interaction.options.getString("meeting-time"));
      if (meetingAt === undefined) {
        await replyEphemeral(interaction, `集合時間を解析できませんでした。\n${dateTimeHint()}`);
        return;
      }

      const mode = interaction.options.getString("mode", true) as MeetupMode;
      // Private meetups always use host approval; voting is a Public-only mechanism.
      const approvalMode: ApprovalMode =
        mode === "PRIVATE"
          ? "HOST"
          : ((interaction.options.getString("approval") ?? "HOST") as ApprovalMode);
      const requiredVotesInput = interaction.options.getInteger("required-votes");
      if (approvalMode === "VOTE" && requiredVotesInput === null) {
        await replyEphemeral(
          interaction,
          "参加者投票を選ぶ場合は必要票数 (required-votes) も指定してください。",
        );
        return;
      }
      const requiredVotes = requiredVotesInput ?? 1;

      const eventRequested = interaction.options.getBoolean("event") ?? false;
      const eventEnabled = mode === "PUBLIC" && eventRequested;
      const meetup = createMeetup({
        guildId: guild.id,
        hostId: interaction.user.id,
        name: interaction.options.getString("name", true),
        description: interaction.options.getString("description") ?? "",
        capacity: interaction.options.getInteger("capacity", true),
        startAt,
        meetingAt,
        meetingPlace: interaction.options.getString("meeting-place"),
        mode,
        approvalMode,
        requiredVotes,
        eventEnabled,
      });

      const cohostInput = interaction.options.getString("cohosts");
      if (cohostInput) {
        const botId = guild.client.user?.id;
        for (const userId of extractCohostIds(cohostInput)) {
          if (userId === meetup.hostId || userId === botId) continue;
          if (!(await fetchMember(guild, userId))) continue;
          addCohost(meetup.id, userId);
        }
      }

      let channel: TextChannel;
      try {
        channel = await createMeetupChannel(guild, meetup);
      } catch (error) {
        console.error("オフ会専用チャンネルの作成に失敗しました", error);
        deleteMeetup(meetup.id);
        await replyEphemeral(
          interaction,
          "専用チャンネルを作成できなかったため、オフ会の作成を取り消しました。" +
            "チャンネル数やBotの権限を確認してください。",
        );
        return;
      }

      const warnings: string[] = [];
      // Cohosts named at creation need their overwrites before any other action syncs them.
      await syncMeetupAccess(guild, getMeetup(meetup.id)!).catch((error) => {
        console.error("共同主催者の権限設定に失敗しました", error);
        warnings.push("共同主催者の権限設定に失敗しました。Botの権限を確認してください。");
      });

      if (mode === "PUBLIC") {
        try {
          const layout = await ensureLayout(guild);
          const applyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`apply:start:${meetup.id}`)
              .setLabel("参加申請")
              .setStyle(ButtonStyle.Primary),
          );
          const thread = await layout.forum.threads.create({
            name: meetup.name.slice(0, 100),
            message: { embeds: [publicEmbed(meetup)], components: [applyRow] },
          });
          updateMeetup(meetup.id, { forumThreadId: thread.id });
        } catch (error) {
          console.error("募集フォーラムへの投稿に失敗しました", error);
          warnings.push("募集フォーラムへの投稿に失敗しました。");
        }
      }

      if (eventEnabled) {
        const event = await syncEventCreation(guild, meetup);
        if (!event) {
          warnings.push(
            "Discordスケジュールイベントを作成できませんでした。Botに「イベントを作成」権限があるか確認してください。",
          );
        }
      }

      await replyEphemeral(
        interaction,
        [
          "オフ会を作成しました。",
          `専用チャンネル: <#${channel.id}>`,
          `オフ会ID: ${meetup.id}`,
          ...warnings,
        ].join("\n"),
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("list")
    .setDescription("ACTIVEなオフ会の一覧を表示します"),
  async (interaction) => {
    try {
      const guild = await requireGuild(interaction);
      if (!guild) return;

      const userId = interaction.user.id;
      const meetups = listMeetups(guild.id).filter((meetup) => {
        if (meetup.mode === "PUBLIC") return true;
        if (canManage(meetup, userId)) return true;
        const state = getParticipant(meetup.id, userId)?.state;
        return state !== undefined && state !== "REJECTED";
      });
      if (meetups.length === 0) {
        await replyEphemeral(interaction, "ACTIVEなオフ会はありません");
        return;
      }

      const lines = meetups.map(
        (meetup) =>
          `**#${meetup.id} ${meetup.name}**\n${discordTimestamp(meetup.startAt)} / ${meetup.mode} / ${meetup.state} / 確定 ${countApproved(meetup.id)}人`,
      );
      const embed = new EmbedBuilder()
        .setTitle("オフ会一覧")
        .setDescription(lines.join("\n").slice(0, 4000));
      await replyEphemeral(interaction, { embeds: [embed] });
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("show")
    .setDescription("オフ会の詳細を表示します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    ),
  async (interaction) => {
    try {
      const guild = await requireGuild(interaction);
      if (!guild) return;

      const meetup = getMeetup(interaction.options.getInteger("meetup", true));
      if (!meetup || meetup.guildId !== guild.id) {
        await replyEphemeral(interaction, "オフ会が見つかりません。");
        return;
      }

      const userId = interaction.user.id;
      const manager = canManage(meetup, userId);
      const participant = getParticipant(meetup.id, userId);
      if (meetup.mode === "PRIVATE" && !manager && !participant) {
        await replyEphemeral(interaction, "このオフ会を表示する権限がありません。");
        return;
      }

      const includeMeetingPlace = manager || participant?.state === "APPROVED";
      await replyEphemeral(interaction, { embeds: [meetupEmbed(meetup, { includeMeetingPlace })] });
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);
