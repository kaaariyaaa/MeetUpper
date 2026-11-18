import {
  ActionRowBuilder,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Guild,
  type GuildMember,
  type RepliableInteraction,
  type UserSelectMenuInteraction,
  type UserSelectMenuBuilder,
} from "discord.js";
import {
  deferEphemeral,
  fetchMember,
  meetupFromInteraction,
  messageEmbed,
  replyEphemeral,
  replyError,
  revokeChannelAccess,
  sendToMeetupChannel,
  syncMeetupAccess,
  tryDM,
} from "../core/discord.ts";
import {
  addCohost,
  canManage,
  getMeetup,
  getParticipant,
  isHost,
  listCohosts,
  listMeetups,
  removeCohost,
  setParticipantState,
  updateMeetup,
} from "../core/meetup.ts";
import { button, selectMenu, subcommand } from "../core/registry.ts";
import type { Meetup } from "../core/types.ts";
import {
  confirmButtons,
  createUiSession,
  dropUiSession,
  getUiSession,
  meetupSelectRow,
  selectedNumber,
  userSelectRow,
  type UiSession,
} from "../core/ui.ts";

type PeopleKind = "kick" | "cohost" | "host";

interface PeopleFlowData {
  meetupId: number | null;
  targetId?: string;
}

const EXPIRED_MESSAGE = "この操作は期限切れです。もう一度コマンドからやり直してください。";

function canOperate(kind: PeopleKind, meetup: Meetup, userId: string): boolean {
  return kind === "kick" ? canManage(meetup, userId) : isHost(meetup, userId);
}

function permissionMessage(kind: PeopleKind): string {
  return kind === "kick"
    ? "主催者または共同主催者のみ操作できます"
    : "主催者のみ操作できます";
}

/** Why this participant cannot be kicked, or null when allowed. */
export function kickDenial(meetup: Meetup, targetId: string): string | null {
  if (targetId === meetup.hostId) return "主催者は退出させられません";
  if (listCohosts(meetup.id).includes(targetId)) {
    return "共同主催者は退出させられません。先に共同主催者から外してください";
  }
  if (getParticipant(meetup.id, targetId)?.state !== "APPROVED") {
    return "参加確定している参加者のみ退出させられます";
  }
  return null;
}

/** Why this user cannot become a cohost, or null when allowed. */
export function cohostAddDenial(
  meetup: Meetup,
  actorId: string,
  target: { id: string; bot?: boolean },
  isMember: boolean,
): string | null {
  if (!isMember) return "対象ユーザーがこのサーバーに参加していません";
  if (target.id === meetup.hostId || target.id === actorId) {
    return "主催者は共同主催者にできません";
  }
  if (listCohosts(meetup.id).includes(target.id)) return "すでに共同主催者です";
  if (target.bot) return "Botを共同主催者にすることはできません";
  return null;
}

/** Why this user cannot become the new host, or null when allowed. */
export function hostTargetDenial(
  meetup: Meetup,
  target: { id: string; bot?: boolean },
  isMember: boolean,
): string | null {
  if (target.id === meetup.hostId) return "現在の主催者です。新しい主催者を選択してください";
  if (target.bot) return "Botを主催者にすることはできません";
  if (!isMember) return "対象ユーザーがこのサーバーに参加していません";
  return null;
}

function cohostRemoveRow(
  guild: Guild,
  meetup: Meetup,
  sessionId: string,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const cohosts = listCohosts(meetup.id).slice(0, 25);
  if (cohosts.length === 0) return null;
  const select = new StringSelectMenuBuilder()
    .setCustomId(`people:cohost-remove:${sessionId}`)
    .setPlaceholder("削除する共同主催者を選択")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      cohosts.map((id) => {
        const member = guild.members.cache.get(id);
        return new StringSelectMenuOptionBuilder()
          .setLabel((member?.displayName ?? `ユーザー ${id.slice(-4)}`).slice(0, 100))
          .setValue(id)
          .setDescription(id.slice(0, 100));
      }),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function panelPayload(
  kind: PeopleKind,
  guild: Guild,
  meetup: Meetup,
  sessionId: string,
  notice?: string,
) {
  const prefix = notice ? `${notice}\n\n` : "";
  if (kind === "kick") {
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle("退出させる参加者を選択")
          .setColor(0x5865f2)
          .setDescription(`${prefix}「${meetup.name}」から退出させる参加者を選択してください。`),
      ],
      components: [userSelectRow(`people:kick-target:${sessionId}`)],
    };
  }
  if (kind === "host") {
    return {
      embeds: [
        new EmbedBuilder()
          .setTitle("新しい主催者を選択")
          .setColor(0x5865f2)
          .setDescription(
            `${prefix}「${meetup.name}」の主催者を移譲するメンバーを選択してください。` +
              "移譲するとあなたは主催者ではなくなり、管理権限を失います。",
          ),
      ],
      components: [userSelectRow(`people:host-target:${sessionId}`)],
    };
  }
  const cohosts = listCohosts(meetup.id);
  const components: (
    | ActionRowBuilder<UserSelectMenuBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [userSelectRow(`people:cohost-add:${sessionId}`, "追加する共同主催者を選択")];
  const remove = cohostRemoveRow(guild, meetup, sessionId);
  if (remove) components.push(remove);
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("共同主催者")
        .setColor(0x5865f2)
        .setDescription(
          [
            `${prefix}「${meetup.name}」の共同主催者を追加または削除できます。`,
            cohosts.length > 0
              ? `現在の共同主催者: ${cohosts.map((id) => `<@${id}>`).join(" ")}`
              : "現在、共同主催者は設定されていません。",
          ].join("\n"),
        ),
    ],
    components,
  };
}

function kickConfirmPayload(meetup: Meetup, targetId: string, sessionId: string) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("キックの確認")
        .setColor(0xe74c3c)
        .setDescription(
          `<@${targetId}> を「${meetup.name}」から退出させます。\n` +
            "専用チャンネルの閲覧権限を解除し、参加者へ通知します。この操作は取り消せません。",
        )
        .addFields(
          { name: "対象", value: `<@${targetId}>`, inline: true },
          { name: "MeetUp", value: meetup.name, inline: true },
        ),
    ],
    components: [
      confirmButtons(
        `people:kick-confirm:${sessionId}`,
        `people:kick-cancel:${sessionId}`,
        "キックする",
        "キャンセル",
      ),
    ],
  };
}

function cohostConfirmPayload(meetup: Meetup, targetId: string, sessionId: string) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("共同主催者の追加")
        .setColor(0xf1c40f)
        .setDescription(
          `<@${targetId}> を「${meetup.name}」の共同主催者に追加します。\n` +
            "専用チャンネルへのアクセス権限が付与されます。",
        )
        .addFields(
          { name: "対象", value: `<@${targetId}>`, inline: true },
          { name: "MeetUp", value: meetup.name, inline: true },
        ),
    ],
    components: [
      confirmButtons(
        `people:cohost-confirm:${sessionId}`,
        `people:cohost-cancel:${sessionId}`,
        "追加する",
        "キャンセル",
      ),
    ],
  };
}

function hostConfirmPayload(meetup: Meetup, targetId: string, sessionId: string) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("主催者変更の確認")
        .setColor(0xe74c3c)
        .setDescription(
          `<@${targetId}> に「${meetup.name}」の主催者を移譲します。\n` +
            "あなたは主催者ではなくなり、専用チャンネルの管理権限を失います。",
        )
        .addFields(
          { name: "新しい主催者", value: `<@${targetId}>`, inline: true },
          { name: "MeetUp", value: meetup.name, inline: true },
        ),
    ],
    components: [
      confirmButtons(
        `people:host-confirm:${sessionId}`,
        `people:host-cancel:${sessionId}`,
        "主催者を変更する",
        "キャンセル",
      ),
    ],
  };
}

async function openPanel(
  interaction: RepliableInteraction,
  kind: PeopleKind,
  guild: Guild,
  meetup: Meetup,
): Promise<void> {
  const session = createUiSession<PeopleFlowData>({
    ownerId: interaction.user.id,
    guildId: meetup.guildId,
    meetupId: meetup.id,
    data: { meetupId: meetup.id },
  });
  await replyEphemeral(interaction, panelPayload(kind, guild, meetup, session.id));
}

async function openPicker(
  interaction: RepliableInteraction,
  kind: PeopleKind,
  guild: Guild,
): Promise<void> {
  const choices = listMeetups(guild.id, ["ACTIVE"]).filter((meetup) =>
    canOperate(kind, meetup, interaction.user.id),
  );
  if (choices.length === 0) {
    await replyEphemeral(interaction, "操作できるMeetUpがありません");
    return;
  }
  const session = createUiSession<PeopleFlowData>({
    ownerId: interaction.user.id,
    guildId: guild.id,
    meetupId: null,
    data: { meetupId: null },
  });
  await replyEphemeral(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle("MeetUpを選択")
        .setColor(0x5865f2)
        .setDescription("操作するMeetUpを選択してください。"),
    ],
    components: [
      meetupSelectRow(
        `people:${kind}-meetup:${session.id}`,
        choices.map((meetup) => ({ meetup })),
      ),
    ],
  });
}

function registerCommand(kind: PeopleKind, description: string): void {
  subcommand(
    new SlashCommandSubcommandBuilder()
      .setName(kind)
      .setDescription(description)
      .addIntegerOption((option) =>
        option
          .setName("meetup")
          .setDescription("MeetUp ID（専用チャンネル内なら省略可）")
          .setMinValue(1),
      ),
    async (interaction) => {
      try {
        const guild = interaction.guild;
        if (!guild) {
          await replyEphemeral(interaction, "サーバー内でのみ実行できます");
          return;
        }
        await deferEphemeral(interaction);

        const id = interaction.options.getInteger("meetup");
        const context = id === null ? meetupFromInteraction(interaction) : null;
        const meetup = id !== null ? getMeetup(id) : context;
        if (id !== null && (!meetup || meetup.guildId !== guild.id)) {
          await replyEphemeral(interaction, "MeetUpが見つかりません");
          return;
        }
        if (meetup) {
          if (meetup.guildId !== guild.id) {
            await replyEphemeral(interaction, "MeetUpが見つかりません");
            return;
          }
          if (meetup.state !== "ACTIVE") {
            await replyEphemeral(interaction, "ACTIVE のMeetUpのみ操作できます");
            return;
          }
          if (!canOperate(kind, meetup, interaction.user.id)) {
            await replyEphemeral(interaction, permissionMessage(kind));
            return;
          }
          await openPanel(interaction, kind, guild, meetup);
          return;
        }
        await openPicker(interaction, kind, guild);
      } catch (error) {
        await replyError(interaction, error);
      }
    },
  );
}

registerCommand("kick", "参加確定者をMeetUpから退出させます");
registerCommand("cohost", "共同主催者を追加・削除します");
registerCommand("host", "主催者を変更します");

button(/^people:(kick|cohost|host)-open:(\d+)$/, async (interaction, args) => {
  try {
    const kind = args[0] as PeopleKind | undefined;
    const guild = interaction.guild;
    if (!kind || !guild) {
      await replyEphemeral(interaction, "サーバー内でのみ操作できます");
      return;
    }
    const meetup = getMeetup(Number(args[1] ?? ""));
    if (!meetup || meetup.guildId !== guild.id) {
      await replyEphemeral(interaction, "MeetUpが見つかりません");
      return;
    }
    if (meetup.state !== "ACTIVE") {
      await replyEphemeral(interaction, "ACTIVE のMeetUpのみ操作できます");
      return;
    }
    if (!canOperate(kind, meetup, interaction.user.id)) {
      await replyEphemeral(interaction, permissionMessage(kind));
      return;
    }
    await openPanel(interaction, kind, guild, meetup);
  } catch (error) {
    await replyError(interaction, error);
  }
});

function sessionMeetup(
  interaction: RepliableInteraction,
  session: UiSession<PeopleFlowData>,
  kind: PeopleKind,
): { meetup: Meetup; guild: Guild } | null {
  const guild = interaction.guild;
  const meetup = session.data.meetupId === null ? null : getMeetup(session.data.meetupId);
  if (
    !guild ||
    !meetup ||
    meetup.guildId !== guild.id ||
    meetup.state !== "ACTIVE" ||
    !canOperate(kind, meetup, interaction.user.id)
  ) {
    return null;
  }
  return { meetup, guild };
}

selectMenu(/^people:(kick|cohost|host)-meetup:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const kind = args[0] as PeopleKind | undefined;
    const sessionId = args[1];
    if (!kind || !sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    const meetupId = selectedNumber(interaction);
    const guild = interaction.guild;
    const meetup = meetupId === null ? null : getMeetup(meetupId);
    if (
      !guild ||
      !meetup ||
      meetup.guildId !== guild.id ||
      meetup.state !== "ACTIVE" ||
      !canOperate(kind, meetup, interaction.user.id)
    ) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    session.meetupId = meetup.id;
    session.data = { meetupId: meetup.id };
    await interaction.update(panelPayload(kind, guild, meetup, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^people:kick-target:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    const context = sessionMeetup(interaction, session, "kick");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const target = (interaction as unknown as UserSelectMenuInteraction).users.first();
    if (!target) {
      await replyEphemeral(interaction, "対象のメンバーを選択してください");
      return;
    }
    const denial = kickDenial(context.meetup, target.id);
    if (denial) {
      await interaction.update({
        embeds: [messageEmbed(denial)],
        components: [userSelectRow(`people:kick-target:${session.id}`)],
      });
      return;
    }
    session.data = { meetupId: context.meetup.id, targetId: target.id };
    await interaction.update(kickConfirmPayload(context.meetup, target.id, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^people:kick-confirm:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const context = sessionMeetup(interaction, session, "kick");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const targetId = session.data.targetId;
    if (!targetId) {
      await replyEphemeral(interaction, "退出させる参加者を選択してください");
      return;
    }
    const denial = kickDenial(context.meetup, targetId);
    if (denial) {
      dropUiSession(session.id);
      await interaction.editReply({ embeds: [messageEmbed(denial)], components: [] });
      return;
    }

    dropUiSession(session.id);
    setParticipantState(context.meetup.id, targetId, "KICKED");
    await revokeChannelAccess(context.guild, context.meetup, targetId);
    await sendToMeetupChannel(
      context.guild,
      context.meetup,
      `<@${targetId}> が主催者によりMeetUpから退出させられました。`,
    );
    await tryDM(
      interaction.client,
      targetId,
      `MeetUp「${context.meetup.name}」から退出となりました。`,
    );
    await interaction.editReply({
      embeds: [messageEmbed(`<@${targetId}> を退出させました。`)],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^people:cohost-add:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const context = sessionMeetup(interaction, session, "cohost");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const target = (interaction as unknown as UserSelectMenuInteraction).users.first();
    if (!target) {
      await replyEphemeral(interaction, "対象のメンバーを選択してください");
      return;
    }
    const member = await fetchMember(context.guild, target.id);
    const denial = cohostAddDenial(context.meetup, interaction.user.id, target, member !== null);
    if (denial) {
      await interaction.editReply({
        embeds: [messageEmbed(denial)],
        components: [userSelectRow(`people:cohost-add:${session.id}`, "追加する共同主催者を選択")],
      });
      return;
    }
    session.data = { meetupId: context.meetup.id, targetId: target.id };
    await interaction.editReply(cohostConfirmPayload(context.meetup, target.id, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^people:cohost-confirm:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const context = sessionMeetup(interaction, session, "cohost");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const targetId = session.data.targetId;
    if (!targetId) {
      await replyEphemeral(interaction, "追加する共同主催者を選択してください");
      return;
    }
    const member: GuildMember | null = await fetchMember(context.guild, targetId);
    const denial = cohostAddDenial(
      context.meetup,
      interaction.user.id,
      { id: targetId, bot: member?.user.bot },
      member !== null,
    );
    if (denial) {
      dropUiSession(session.id);
      await interaction.editReply({ embeds: [messageEmbed(denial)], components: [] });
      return;
    }

    dropUiSession(session.id);
    addCohost(context.meetup.id, targetId);
    const updated = getMeetup(context.meetup.id)!;
    await syncMeetupAccess(context.guild, updated);
    await sendToMeetupChannel(
      context.guild,
      updated,
      `共同主催者を追加しました: <@${targetId}>`,
    );
    await interaction.editReply({
      embeds: [messageEmbed(`共同主催者に <@${targetId}> を追加しました。`)],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^people:cohost-remove:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const context = sessionMeetup(interaction, session, "cohost");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const targetId = interaction.values[0];
    if (!targetId || !listCohosts(context.meetup.id).includes(targetId)) {
      await replyEphemeral(interaction, "共同主催者ではありません");
      return;
    }
    removeCohost(context.meetup.id, targetId);
    const updated = getMeetup(context.meetup.id)!;
    await syncMeetupAccess(context.guild, updated);
    await sendToMeetupChannel(
      context.guild,
      updated,
      `共同主催者を削除しました: <@${targetId}>`,
    );
    await interaction.editReply(
      panelPayload(
        "cohost",
        context.guild,
        updated,
        session.id,
        `共同主催者から <@${targetId}> を削除しました。`,
      ),
    );
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^people:host-target:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const context = sessionMeetup(interaction, session, "host");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const target = (interaction as unknown as UserSelectMenuInteraction).users.first();
    if (!target) {
      await replyEphemeral(interaction, "新しい主催者を選択してください");
      return;
    }
    const member = await fetchMember(context.guild, target.id);
    const denial = hostTargetDenial(context.meetup, target, member !== null);
    if (denial) {
      await interaction.editReply({
        embeds: [messageEmbed(denial)],
        components: [userSelectRow(`people:host-target:${session.id}`, "新しい主催者を選択")],
      });
      return;
    }
    session.data = { meetupId: context.meetup.id, targetId: target.id };
    await interaction.editReply(hostConfirmPayload(context.meetup, target.id, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^people:host-confirm:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[0];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    await interaction.deferUpdate();
    const context = sessionMeetup(interaction, session, "host");
    if (!context) {
      await replyEphemeral(interaction, "このMeetUpは操作できません");
      return;
    }
    const targetId = session.data.targetId;
    if (!targetId) {
      await replyEphemeral(interaction, "新しい主催者を選択してください");
      return;
    }
    const member: GuildMember | null = await fetchMember(context.guild, targetId);
    const denial = hostTargetDenial(
      context.meetup,
      { id: targetId, bot: member?.user.bot },
      member !== null,
    );
    if (denial) {
      dropUiSession(session.id);
      await interaction.editReply({ embeds: [messageEmbed(denial)], components: [] });
      return;
    }

    dropUiSession(session.id);
    const previousHostId = context.meetup.hostId;
    updateMeetup(context.meetup.id, { hostId: targetId });
    const updated = getMeetup(context.meetup.id)!;
    await syncMeetupAccess(context.guild, updated);
    await sendToMeetupChannel(
      context.guild,
      updated,
      `主催者を <@${targetId}> に変更しました。\n` +
        `<@${previousHostId}> はこのチャンネルの管理権限を失います。` +
        "サーバー全体の管理者権限を持つ場合は引き続き管理できます。",
    );
    await tryDM(interaction.client, targetId, `MeetUp「${updated.name}」の主催者になりました。`);
    await interaction.editReply({
      embeds: [messageEmbed(`主催者を <@${targetId}> に変更しました`)],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^people:(kick|cohost|host)-cancel:([0-9a-z]+)$/, async (interaction, args) => {
  try {
    const sessionId = args[1];
    if (!sessionId) return;
    const session = getUiSession<PeopleFlowData>(interaction, sessionId);
    if (!session) {
      await replyEphemeral(interaction, EXPIRED_MESSAGE);
      return;
    }
    dropUiSession(session.id);
    await interaction.update({
      embeds: [messageEmbed("操作をキャンセルしました")],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});
