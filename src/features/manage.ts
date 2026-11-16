import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
} from "discord.js";
import { button, subcommand } from "../core/registry.ts";
import {
  addCohost,
  archiveMeetup,
  canManage,
  cancelMeetup,
  countApproved,
  deleteReminders,
  getMeetup,
  getParticipant,
  isHost,
  listCohosts,
  listParticipants,
  removeCohost,
  scheduleReminders,
  setParticipantState,
  updateMeetup,
} from "../core/meetup.ts";
import {
  archiveChannel,
  replyEphemeral,
  replyError,
  revokeChannelAccess,
  sendToMeetupChannel,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
import { cancelEvent, updateEvent } from "../core/events.ts";
import { parseDateTime } from "../core/time.ts";
import { dateTimeHint, meetupEmbed, participantsSummary } from "../core/views.ts";
import type { Meetup } from "../core/types.ts";

const ABORT_ID = "manage:abort";

async function runCommand(
  interaction: ChatInputCommandInteraction,
  action: (guild: Guild) => Promise<void>,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, "サーバー内でのみ使用できます。");
    return;
  }
  try {
    await action(guild);
  } catch (error) {
    await replyError(interaction, error);
  }
}

async function runButton(
  interaction: ButtonInteraction,
  action: (guild: Guild) => Promise<void>,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, "サーバー内でのみ使用できます。");
    return;
  }
  try {
    await action(guild);
  } catch (error) {
    await replyError(interaction, error);
  }
}

function resolveMeetup(guild: Guild, id: number): Meetup {
  const meetup = getMeetup(id);
  if (!meetup || meetup.guildId !== guild.id) throw new Error("オフ会が見つかりません。");
  return meetup;
}

function requireManage(meetup: Meetup, userId: string): void {
  if (!canManage(meetup, userId)) throw new Error("このオフ会を管理する権限がありません。");
}

function requireHost(meetup: Meetup, userId: string): void {
  if (!isHost(meetup, userId)) throw new Error("主催者のみ実行できます。");
}

function requireActive(meetup: Meetup): void {
  if (meetup.state !== "ACTIVE") throw new Error("ACTIVE のオフ会のみ操作できます。");
}

/** Channel notice restricted to the meetup channel audience (host, cohosts, approved). */
async function notifyChannel(guild: Guild, meetupId: number, content: string | undefined): Promise<void> {
  const meetup = getMeetup(meetupId);
  if (!meetup) return;
  await sendToMeetupChannel(guild, meetup, {
    ...(content ? { content } : {}),
    embeds: [meetupEmbed(meetup, { includeMeetingPlace: true })],
  });
}

function confirmRow(confirmId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel("実行する").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(ABORT_ID).setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
  );
}

function chunk(text: string, limit = 1900): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
      continue;
    }
    for (let index = 0; index < line.length; index += limit) {
      chunks.push(line.slice(index, index + limit));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

/* --- info --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("info")
    .setDescription("集合時間・集合場所を更新します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("meeting-time")
        .setDescription("集合時間 (YYYY-MM-DD HH:mm)")
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName("meeting-place").setDescription("集合場所").setRequired(false),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireManage(meetup, interaction.user.id);

      const timeInput = interaction.options.getString("meeting-time")?.trim();
      const placeInput = interaction.options.getString("meeting-place")?.trim();
      if (!timeInput && !placeInput) {
        throw new Error("集合時間または集合場所のいずれかを指定してください。");
      }

      const fields: { meetingAt?: number | null; meetingPlace?: string | null } = {};
      if (timeInput) {
        const meetingAt = parseDateTime(timeInput);
        if (meetingAt === null) {
          throw new Error(`集合時間の形式が正しくありません。${dateTimeHint()}`);
        }
        fields.meetingAt = meetingAt;
      }
      if (placeInput) fields.meetingPlace = placeInput;
      updateMeetup(meetup.id, fields);

      const approved = listParticipants(meetup.id, ["APPROVED"]);
      const mentions = approved.map((participant) => `<@${participant.userId}>`).join(" ");
      await notifyChannel(guild, meetup.id, mentions || undefined);
      await replyEphemeral(interaction, "集合情報を更新しました");
    });
  },
);

/* --- leave --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("leave")
    .setDescription("参加をキャンセルします")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      const actorId = interaction.user.id;

      if (getParticipant(meetup.id, actorId)?.state !== "APPROVED") {
        throw new Error("参加確定者のみ参加をキャンセルできます。");
      }
      if (isHost(meetup, actorId) || listCohosts(meetup.id).includes(actorId)) {
        throw new Error("主催者・共同主催者は参加キャンセルできません");
      }

      setParticipantState(meetup.id, actorId, "CANCELLED");
      await revokeChannelAccess(guild, meetup, actorId);
      await notifyChannel(guild, meetup.id, `<@${actorId}> が参加をキャンセルしました。`);
      await replyEphemeral(interaction, "参加をキャンセルしました");
    });
  },
);

/* --- members --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("members")
    .setDescription("参加者一覧を表示します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireManage(meetup, interaction.user.id);
      for (const part of chunk(participantsSummary(meetup.id))) {
        await replyEphemeral(interaction, part);
      }
    });
  },
);

/* --- cohost --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("cohost")
    .setDescription("共同主催者を追加・削除します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("対象ユーザー").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("操作")
        .setRequired(true)
        .addChoices({ name: "追加", value: "add" }, { name: "削除", value: "remove" }),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireHost(meetup, interaction.user.id);
      const target = interaction.options.getUser("user", true);
      const action = interaction.options.getString("action", true);

      if (action === "add") {
        addCohost(meetup.id, target.id);
      } else {
        removeCohost(meetup.id, target.id);
      }
      await syncMeetupAccess(guild, getMeetup(meetup.id)!);

      const label = action === "add" ? "追加" : "削除";
      await notifyChannel(guild, meetup.id, `共同主催者を${label}しました: <@${target.id}>`);
      await replyEphemeral(
        interaction,
        action === "add" ? "共同主催者を追加しました" : "共同主催者を削除しました",
      );
    });
  },
);

/* --- host transfer --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("host")
    .setDescription("主催者を変更します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("新しい主催者").setRequired(true),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireHost(meetup, interaction.user.id);
      const target = interaction.options.getUser("user", true);
      if (target.bot || target.id === interaction.user.id) {
        throw new Error("自分自身やBotを主催者にすることはできません。");
      }

      const previousHostId = meetup.hostId;
      updateMeetup(meetup.id, { hostId: target.id });
      await syncMeetupAccess(guild, getMeetup(meetup.id)!);

      await notifyChannel(
        guild,
        meetup.id,
        `主催者を <@${target.id}> に変更しました。\n` +
          `<@${previousHostId}> はこのチャンネルの管理権限を失います。` +
          "サーバー全体の管理者権限を持つ場合は引き続き管理できます。",
      );
      await replyEphemeral(interaction, `主催者を <@${target.id}> に変更しました`);
    });
  },
);


/* --- edit --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("edit")
    .setDescription("オフ会の基本情報を編集します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("name").setDescription("新しいオフ会名").setMaxLength(100),
    )
    .addStringOption((option) => option.setName("description").setDescription("新しい説明"))
    .addIntegerOption((option) =>
      option.setName("capacity").setDescription("新しい定員").setMinValue(1).setMaxValue(1000),
    )
    .addStringOption((option) =>
      option.setName("start").setDescription("新しい開催日時 (YYYY-MM-DD HH:mm)"),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireManage(meetup, interaction.user.id);
      requireActive(meetup);

      const name = interaction.options.getString("name")?.trim();
      const description = interaction.options.getString("description")?.trim();
      const capacity = interaction.options.getInteger("capacity");
      const startInput = interaction.options.getString("start")?.trim();
      if (!name && description === undefined && capacity === null && !startInput) {
        throw new Error("変更する項目を1つ以上指定してください。");
      }

      const fields: {
        name?: string;
        description?: string;
        capacity?: number;
        startAt?: number;
      } = {};
      if (name) fields.name = name;
      if (description !== undefined) fields.description = description;
      if (capacity !== null) fields.capacity = capacity;
      if (startInput) {
        const startAt = parseDateTime(startInput);
        if (startAt === null) throw new Error(`開催日時の形式が正しくありません。${dateTimeHint()}`);
        fields.startAt = startAt;
      }

      updateMeetup(meetup.id, fields);
      const updated = getMeetup(meetup.id)!;
      if (fields.startAt !== undefined) {
        deleteReminders(updated.id);
        scheduleReminders(updated.id, updated.startAt);
      }
      if (updated.mode === "PUBLIC" && updated.eventId) await updateEvent(guild, updated);

      const warnings: string[] = [];
      if (capacity !== null && countApproved(updated.id) > capacity) {
        warnings.push("確定済みの参加者数が新しい定員を超えています");
      }
      await notifyChannel(guild, updated.id, "オフ会の基本情報が更新されました。");
      await replyEphemeral(interaction, ["オフ会情報を更新しました", ...warnings].join("\n"));
    });
  },
);

/* --- archive --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("archive")
    .setDescription("オフ会をアーカイブします")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireManage(meetup, interaction.user.id);
      requireActive(meetup);

      const embed = new EmbedBuilder()
        .setTitle("アーカイブしますか？")
        .setDescription(
          `「${meetup.name}」をアーカイブします。リマインドは停止され、チャンネル名に archive- が付与されます。`,
        )
        .setColor(0xe67e22);
      await replyEphemeral(interaction, {
        embeds: [embed],
        components: [confirmRow(`manage:confirm-archive:${meetup.id}`)],
      });
    });
  },
);

/* --- cancel --- */

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("cancel")
    .setDescription("オフ会を中止します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    ),
  async (interaction) => {
    await runCommand(interaction, async (guild) => {
      const meetup = resolveMeetup(guild, interaction.options.getInteger("meetup", true));
      requireHost(meetup, interaction.user.id);
      requireActive(meetup);

      const embed = new EmbedBuilder()
        .setTitle("オフ会を中止しますか？")
        .setDescription(
          `「${meetup.name}」を中止します。参加確定者へチャンネルとDMで通知されます。` +
            "この操作は取り消せません。",
        )
        .setColor(0xe74c3c);
      await replyEphemeral(interaction, {
        embeds: [embed],
        components: [confirmRow(`manage:confirm-cancel:${meetup.id}`)],
      });
    });
  },
);

/* --- buttons --- */

button(/^manage:confirm-archive:(\d+)$/, async (interaction, args) => {
  await runButton(interaction, async (guild) => {
    const meetup = resolveMeetup(guild, Number(args[0]));
    requireManage(meetup, interaction.user.id);
    requireActive(meetup);

    archiveMeetup(meetup);
    await archiveChannel(guild, getMeetup(meetup.id)!);
    await interaction.update({ content: "アーカイブしました", embeds: [], components: [] });
  });
});

button(/^manage:confirm-cancel:(\d+)$/, async (interaction, args) => {
  await runButton(interaction, async (guild) => {
    const meetup = resolveMeetup(guild, Number(args[0]));
    requireHost(meetup, interaction.user.id);
    requireActive(meetup);

    cancelMeetup(meetup);
    const updated = getMeetup(meetup.id)!;
    await cancelEvent(guild, updated);

    const message = `オフ会が中止されました: ${updated.name}`;
    await notifyChannel(guild, updated.id, message);
    const approved = listParticipants(updated.id, ["APPROVED"]);
    await Promise.all(approved.map((participant) => tryDM(interaction.client, participant.userId, message)));

    await interaction.update({ content: "オフ会を中止しました", embeds: [], components: [] });
  });
});

button(/^manage:abort$/, async (interaction) => {
  await runButton(interaction, async () => {
    await interaction.update({ content: "キャンセルしました", embeds: [], components: [] });
  });
});
