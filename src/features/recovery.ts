import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  type ButtonInteraction,
  type Guild,
  type TextChannel,
} from "discord.js";
import { button, setup } from "../core/registry.ts";
import {
  cancelMeetup,
  canManage,
  getMeetup,
  getMeetupByChannelId,
  listParticipants,
} from "../core/meetup.ts";
import {
  createMeetupChannel,
  replyEphemeral,
  replyError,
  sendToMeetupChannel,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
import { cancelEvent } from "../core/events.ts";
import type { Meetup } from "../core/types.ts";

// ponytail: in-memory only, a restart mid-handling could recover twice; acceptable, channels die anyway.
const handledChannels = new Set<string>();

function recoveryNotice(meetup: Meetup, deletedChannelName: string) {
  const embed = new EmbedBuilder()
    .setTitle("専用チャンネルを再作成しました")
    .setColor(0xe67e22)
    .setDescription("Discord上で削除されたため再作成しました。このオフ会を中止しますか？")
    .addFields(
      { name: "オフ会名", value: meetup.name, inline: true },
      { name: "削除されたチャンネル", value: deletedChannelName, inline: true },
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`recover:cancel:${meetup.id}`)
      .setLabel("オフ会を中止する")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`recover:keep:${meetup.id}`)
      .setLabel("ACTIVEを維持する")
      .setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [row] };
}

async function handleChannelDelete(deleted: { id: string; name: string }, guild: Guild): Promise<void> {
  const meetup = getMeetupByChannelId(deleted.id);
  if (!meetup) return;

  let channel: TextChannel;
  try {
    channel = await createMeetupChannel(guild, meetup);
    await syncMeetupAccess(guild, getMeetup(meetup.id)!);
  } catch (error) {
    console.error(`オフ会チャンネルの再作成に失敗しました: meetup=${meetup.id}`, error);
    return;
  }

  const payload = recoveryNotice(meetup, deleted.name);
  await channel.send({ content: `<@${meetup.hostId}>`, ...payload }).catch((error) => {
    console.error(`復旧通知の送信に失敗しました: meetup=${meetup.id}`, error);
  });
  await tryDM(guild.client, meetup.hostId, payload);
}

setup((client) => {
  client.on(Events.ChannelDelete, async (channel) => {
    if (channel.isDMBased() || channel.isThread()) return;
    if (!channel.guild) return;
    if (handledChannels.has(channel.id)) return;
    handledChannels.add(channel.id);
    try {
      await handleChannelDelete(channel, channel.guild);
    } catch (error) {
      console.error("チャンネル削除イベントの処理に失敗しました", error);
    }
  });
});

function parseMeetupId(args: string[]): number | null {
  const id = Number(args[0]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

button(/^recover:cancel:(\d+)$/, async (interaction: ButtonInteraction, args) => {
  try {
    if (!interaction.guild) {
      await replyEphemeral(interaction, "この操作はサーバー内でのみ実行できます。");
      return;
    }
    const id = parseMeetupId(args);
    if (id === null) {
      await replyEphemeral(interaction, "オフ会IDが不正です。");
      return;
    }
    const meetup = getMeetup(id);
    if (!meetup) {
      await replyEphemeral(interaction, "オフ会が見つかりません。");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "この操作は主催者または共同主催者のみが実行できます。");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, `このオフ会は${meetup.state}のため中止できません。`);
      return;
    }

    const guild = interaction.guild;
    cancelMeetup(meetup);
    const cancelled = getMeetup(id)!;
    await cancelEvent(guild, cancelled);
    await interaction.update({ content: "オフ会を中止しました", embeds: [], components: [] });

    await sendToMeetupChannel(guild, cancelled, {
      content: `オフ会「${cancelled.name}」は中止されました。`,
    });
    for (const participant of listParticipants(id, ["APPROVED"])) {
      await tryDM(
        interaction.client,
        participant.userId,
        `参加していたオフ会「${cancelled.name}」は中止されました。`,
      );
    }
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^recover:keep:(\d+)$/, async (interaction: ButtonInteraction, args) => {
  try {
    if (!interaction.guild) {
      await replyEphemeral(interaction, "この操作はサーバー内でのみ実行できます。");
      return;
    }
    const id = parseMeetupId(args);
    if (id === null) {
      await replyEphemeral(interaction, "オフ会IDが不正です。");
      return;
    }
    const meetup = getMeetup(id);
    if (!meetup) {
      await replyEphemeral(interaction, "オフ会が見つかりません。");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "この操作は主催者または共同主催者のみが実行できます。");
      return;
    }

    await interaction.update({
      content: "ACTIVEを維持します。専用チャンネルは再作成済みです。",
      embeds: [],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});
