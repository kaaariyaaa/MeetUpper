import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  type ButtonInteraction,
  type Guild,
} from "discord.js";
import {
  createInviteThread,
  deferEphemeral,
  deleteThread,
  fetchMember,
  replyEphemeral,
  replyError,
  sendToMeetupChannel,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
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
  setParticipantState,
} from "../core/meetup.ts";
import { button, subcommand } from "../core/registry.ts";
import type { InviteRequest, Meetup } from "../core/types.ts";
import { meetupEmbed } from "../core/views.ts";

type InviteDelivery = "DM" | "THREAD" | "FAILED";

/** Invite card: never exposes the meeting place, even to the invitee before approval. */
export function inviteEmbed(meetup: Meetup, inviterId: string): EmbedBuilder {
  const embed = meetupEmbed(meetup);
  const description = embed.data.description ?? "";
  return embed
    .setDescription(`${description}\n\n<@${inviterId}> さんから招待されています。`.slice(0, 4000))
    .setFooter({ text: `オフ会ID: ${meetup.id}` });
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

  if (await tryDM(guild.client, targetId, { embeds, components })) return "DM";

  const thread = await createInviteThread(guild, targetId, `招待-${meetup.id}-${targetId.slice(-4)}`);
  if (thread) {
    try {
      await thread.send({ content: `<@${targetId}> さん、招待が届いています。`, embeds, components });
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

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("invite")
    .setDescription("メンバーをオフ会に招待します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true),
    )
    .addUserOption((option) =>
      option.setName("user").setDescription("招待するメンバー").setRequired(true),
    ),
  async (interaction) => {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await replyEphemeral(interaction, "サーバー内でのみ実行できます");
        return;
      }
      await deferEphemeral(interaction);

      const meetup = getMeetup(interaction.options.getInteger("meetup", true));
      if (!meetup || meetup.guildId !== guild.id) {
        await replyEphemeral(interaction, "オフ会が見つかりません");
        return;
      }
      if (meetup.state !== "ACTIVE") {
        await replyEphemeral(interaction, "終了または中止されたオフ会には招待できません");
        return;
      }

      const target = interaction.options.getUser("user", true);
      const actorId = interaction.user.id;
      const existing = getParticipant(meetup.id, target.id)?.state;

      if (target.id === actorId) {
        await replyEphemeral(interaction, "自分自身を招待することはできません");
        return;
      }
      if (target.bot) {
        await replyEphemeral(interaction, "Botを招待することはできません");
        return;
      }
      if (target.id === meetup.hostId) {
        await replyEphemeral(interaction, "主催者はすでに参加しています");
        return;
      }
      if (listCohosts(meetup.id).includes(target.id)) {
        await replyEphemeral(interaction, "共同主催者はすでに参加しています");
        return;
      }
      if (existing === "APPROVED") {
        await replyEphemeral(interaction, "すでに参加が確定しています");
        return;
      }
      if (existing === "INVITED") {
        await replyEphemeral(interaction, "すでに招待済みです");
        return;
      }
      if (existing === "APPLIED") {
        await replyEphemeral(interaction, "すでに参加申請中です");
        return;
      }

      if (canManage(meetup, actorId)) {
        const previous = getParticipant(meetup.id, target.id);
        setParticipantState(meetup.id, target.id, "INVITED", { invitedBy: actorId });
        const delivery = await deliverInvite(guild, meetup, target.id, actorId);
        if (delivery === "FAILED") {
          // A failed delivery must not lock the target into 招待中 forever.
          if (previous) setParticipantState(meetup.id, target.id, previous.state);
          else deleteParticipant(meetup.id, target.id);
        }
        const detail =
          delivery === "DM"
            ? "招待DMを送信しました"
            : delivery === "THREAD"
              ? "DMを送信できなかったため、招待チャンネルのプライベートスレッドで招待しました"
              : "DMもスレッドも送信できませんでした";
        await replyEphemeral(interaction, `<@${target.id}> への${detail}`);
        return;
      }

      if (getParticipant(meetup.id, actorId)?.state === "APPROVED") {
        if (hasPendingInviteRequest(meetup.id, target.id)) {
          await replyEphemeral(interaction, "この対象への招待申請はすでに承認待ちです");
          return;
        }
        const request = createInviteRequest(meetup.id, actorId, target.id);
        const sent = await sendToMeetupChannel(guild, meetup, {
          content: `${adminMentions(meetup)}\n<@${actorId}> さんから招待申請が届きました。`,
          embeds: [
            new EmbedBuilder()
              .setTitle("招待申請")
              .setColor(0xf1c40f)
              .addFields(
                { name: "申請者", value: `<@${request.requesterId}>`, inline: true },
                { name: "招待対象", value: `<@${request.targetId}>`, inline: true },
                { name: "オフ会", value: meetup.name, inline: true },
              ),
          ],
          components: requestComponents(request.id),
        });
        if (!sent) {
          decideInviteRequest(request.id, "REJECTED", actorId);
          await replyEphemeral(
            interaction,
            "招待申請を専用チャンネルへ投稿できませんでした。主催者へ直接確認してください。",
          );
          return;
        }
        await replyEphemeral(interaction, "主催者へ招待申請を送りました");
        return;
      }

      await replyEphemeral(
        interaction,
        "参加確定者のみ招待できます（主催者・共同主催者は直接招待できます）",
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

button(/^invite:accept:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0] ?? ""));
    if (!meetup) {
      await replyEphemeral(interaction, "オフ会が見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "このオフ会は現在参加を受け付けていません");
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
        content: "サーバーに参加していないため、この招待には参加できません。",
        embeds: [],
        components: [],
      });
      return;
    }

    approveParticipant(meetup, interaction.user.id, "invite");
    const overCapacity = countApproved(meetup.id) > meetup.capacity;
    await interaction.editReply({
      content: `参加が確定しました${overCapacity ? "\n⚠️ 定員を超えています。主催者へ確認してください。" : ""}`,
      embeds: [],
      components: [],
    });
    if (guild) {
      await syncMeetupAccess(guild, getMeetup(meetup.id)!).catch((error) =>
        console.error("参加者の権限同期に失敗しました", error),
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
      await replyEphemeral(interaction, "オフ会が見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "このオフ会は現在参加を受け付けていません");
      return;
    }
    if (getParticipant(meetup.id, interaction.user.id)?.state !== "INVITED") {
      await replyEphemeral(interaction, "招待が見つかりません");
      return;
    }

    await interaction.deferUpdate();
    setParticipantState(meetup.id, interaction.user.id, "DECLINED");
    await interaction.editReply({
      content: `招待を辞退しました。後から参加申請する場合は /meetup apply meetup:${meetup.id} を実行してください。`,
      embeds: [],
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
      await replyEphemeral(interaction, "オフ会が見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "終了または中止されたオフ会では操作できません");
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
        content: "この招待申請はすでに処理済みです",
        embeds: [],
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
      content: `招待申請を承認しました。${deliveryLabel(delivery)}（対象: <@${request.targetId}>）`,
      embeds: [],
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
      await replyEphemeral(interaction, "オフ会が見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "終了または中止されたオフ会では操作できません");
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
        content: "この招待申請はすでに処理済みです",
        embeds: [],
        components: [],
      });
      return;
    }
    await notifyRequester(interaction, guild, meetup, request, "招待申請は却下されました。");
    await interaction.editReply({
      content: `招待申請を却下しました（対象: <@${request.targetId}>）`,
      embeds: [],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});
