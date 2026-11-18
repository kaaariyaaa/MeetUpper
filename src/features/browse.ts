import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandSubcommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { deferEphemeral, meetupFromInteraction, replyEphemeral, replyError } from "../core/discord.ts";
import { canManage, getMeetup, getParticipant, listMeetups, listParticipants } from "../core/meetup.ts";
import { button, selectMenu, subcommand } from "../core/registry.ts";
import type { Meetup, ParticipantState } from "../core/types.ts";
import {
  createUiSession,
  getUiSession,
  meetupSelectRow,
  pageRow,
  selectedNumber,
  type UiSession,
} from "../core/ui.ts";
import { meetupEmbed } from "../core/views.ts";
import { applicationDenial } from "./apply.ts";

const SESSION_EXPIRED = "画面の有効期限が切れました。コマンドを開き直してください。";
const NO_PERMISSION = "このMeetUpを表示する権限がありません。";
const PAGE_SIZE = 25;
const MEMBERS_PAGE_SIZE = 10;

export type BrowseFilter = "recruiting" | "joined" | "managing";

export interface BrowseState {
  filter: BrowseFilter;
  page: number;
}

export interface BrowsePanel {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

type BrowseSession = UiSession<BrowseState>;

const FILTER_LABELS: Record<BrowseFilter, string> = {
  recruiting: "募集中",
  joined: "参加中",
  managing: "管理中",
};

/** Private MeetUps are only visible to the host side and to people who were invited or applied. */
export function canViewMeetup(meetup: Meetup, userId: string): boolean {
  if (meetup.mode === "PUBLIC") return true;
  if (canManage(meetup, userId)) return true;
  const state = getParticipant(meetup.id, userId)?.state;
  return state !== undefined && state !== "REJECTED" && state !== "KICKED";
}

export function meetupsForFilter(guildId: string, userId: string, filter: BrowseFilter): Meetup[] {
  return listMeetups(guildId).filter((meetup) => {
    if (!canViewMeetup(meetup, userId)) return false;
    if (filter === "managing") return canManage(meetup, userId);
    if (filter === "joined") return getParticipant(meetup.id, userId)?.state === "APPROVED";
    return true;
  });
}

function linkButton(customId: string, label: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Secondary);
}

function dangerButton(customId: string, label: string): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Danger);
}

/** Discord allows at most five buttons per action row. */
function chunkButtons(buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...buttons.slice(index, index + 5)),
    );
  }
  return rows;
}

function filterRow(session: BrowseSession): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`browse:filter:${session.id}`)
    .setPlaceholder("表示を切り替え")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      (Object.keys(FILTER_LABELS) as BrowseFilter[]).map((filter) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(FILTER_LABELS[filter])
          .setValue(filter)
          .setDefault(filter === session.data.filter),
      ),
    );
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(select);
}

function paginate<T>(items: T[], page: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { items: items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE), page: current, pages };
}

function dashboardPayload(session: BrowseSession, userId: string): BrowsePanel {
  const matches = meetupsForFilter(session.guildId, userId, session.data.filter);
  const { items, page, pages } = paginate(matches, session.data.page);
  session.data.page = page;

  const embed = new EmbedBuilder()
    .setTitle("MeetUpダッシュボード")
    .setColor(0x5865f2)
    .setDescription(
      [
        `表示: **${FILTER_LABELS[session.data.filter]}**（${matches.length}件）`,
        items.length === 0 ? "該当するMeetUpはありません。" : "MeetUpを選ぶと詳細を表示します。",
        pages > 1 ? `ページ ${page + 1}/${pages}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    );

  const components: BrowsePanel["components"] = [filterRow(session)];
  if (items.length > 0) {
    components.push(
      meetupSelectRow(
        `browse:pick:${session.id}`,
        items.map((meetup) => ({ meetup })),
      ),
    );
  }
  components.push(
    pageRow(
      `browse:prev:${session.id}`,
      `browse:next:${session.id}`,
      page,
      pages,
      `browse:close:${session.id}`,
    ),
  );
  return { embeds: [embed], components };
}

export function meetupDetailEmbed(meetup: Meetup, userId: string): EmbedBuilder {
  const manager = canManage(meetup, userId);
  const approved = getParticipant(meetup.id, userId)?.state === "APPROVED";
  return meetupEmbed(meetup, { includeMeetingPlace: manager || approved }).setFooter({
    text: `MeetUp ID: ${meetup.id}`,
  });
}

/** Only actions this actor can actually perform are rendered. */
export function meetupDetailComponents(
  meetup: Meetup,
  userId: string,
  backSessionId?: string,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const manager = canManage(meetup, userId);
  const active = meetup.state === "ACTIVE";
  const actions: ButtonBuilder[] = [];

  if (active && applicationDenial(meetup, userId) === null) {
    actions.push(
      new ButtonBuilder()
        .setCustomId(`apply:start:${meetup.id}`)
        .setLabel(meetup.approvalMode === "DIRECT" ? "参加する" : "参加申請")
        .setStyle(ButtonStyle.Primary),
    );
  }

  if (manager) {
    actions.push(linkButton(`browse:members:${meetup.id}`, "参加者"));
    if (active) {
      actions.unshift(
        linkButton(`people:invite-open:${meetup.id}`, "招待"),
      );
      actions.push(
        linkButton(`edit:open:${meetup.id}`, "編集"),
        linkButton(`ops:info-open:${meetup.id}`, "集合情報"),
        linkButton(`reminder:open:${meetup.id}`, "リマインダー"),
      );
    }
    if (meetup.state !== "ARCHIVED") actions.push(linkButton(`ops:archive-open:${meetup.id}`, "アーカイブ"));
    if (active) actions.push(dangerButton(`ops:cancel-open:${meetup.id}`, "中止"));
  } else if (active && getParticipant(meetup.id, userId)?.state === "APPROVED") {
    actions.push(dangerButton(`ops:leave-open:${meetup.id}`, "キャンセル"));
  }

  const rows = chunkButtons(actions);
  if (backSessionId) {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        linkButton(`browse:list:${backSessionId}`, "一覧に戻る"),
      ),
    );
  }
  return rows;
}

function detailPayload(meetup: Meetup, userId: string, backSessionId?: string): BrowsePanel {
  return {
    embeds: [meetupDetailEmbed(meetup, userId)],
    components: meetupDetailComponents(meetup, userId, backSessionId),
  };
}

const PARTICIPANT_STATE_ORDER: ParticipantState[] = [
  "APPROVED",
  "APPLIED",
  "INVITED",
  "DECLINED",
  "REJECTED",
  "CANCELLED",
  "KICKED",
];

export function membersPanel(
  meetup: Meetup,
  page: number,
): { embed: EmbedBuilder; page: number; pages: number } {
  const entries = PARTICIPANT_STATE_ORDER.flatMap((state) => listParticipants(meetup.id, [state]));
  const pages = Math.max(1, Math.ceil(entries.length / MEMBERS_PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const shown = entries.slice(current * MEMBERS_PAGE_SIZE, (current + 1) * MEMBERS_PAGE_SIZE);

  const counts = new Map<ParticipantState, number>();
  for (const participant of entries) {
    counts.set(participant.state, (counts.get(participant.state) ?? 0) + 1);
  }
  const groups = new Map<ParticipantState, string[]>();
  for (const participant of shown) {
    const members = groups.get(participant.state) ?? [];
    members.push(`<@${participant.userId}>`);
    groups.set(participant.state, members);
  }

  const description = [
    `確定 ${counts.get("APPROVED") ?? 0}人 / 申請中 ${counts.get("APPLIED") ?? 0}人 / 招待中 ${counts.get("INVITED") ?? 0}人`,
    shown.length === 0
      ? "参加者はいません。"
      : [...groups.entries()]
          .map(
            ([state, members]) =>
              `**${state}** (${counts.get(state) ?? members.length})\n${members.join("\n")}`,
          )
          .join("\n\n"),
  ].join("\n\n");

  const embed = new EmbedBuilder()
    .setTitle(`参加者一覧: ${meetup.name}`)
    .setColor(meetup.state === "ACTIVE" ? 0x2ecc71 : meetup.state === "ARCHIVED" ? 0x95a5a6 : 0xe74c3c)
    .setDescription(description.slice(0, 4000))
    .setFooter({ text: `ページ ${current + 1}/${pages} / MeetUp ID: ${meetup.id}` });
  return { embed, page: current, pages };
}

function membersPayload(meetup: Meetup, page: number): BrowsePanel {
  const panel = membersPanel(meetup, page);
  const controls = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`browse:members-page:${meetup.id}:${panel.page - 1}`)
      .setLabel("前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(panel.page <= 0),
    new ButtonBuilder()
      .setCustomId(`browse:members-page:${meetup.id}:${panel.page + 1}`)
      .setLabel("次へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(panel.page + 1 >= panel.pages),
    linkButton(`browse:show:${meetup.id}`, "戻る"),
  );
  return { embeds: [panel.embed], components: [controls] };
}

function membersPickerPayload(guildId: string, userId: string, sessionId: string): BrowsePanel {
  const meetups = listMeetups(guildId)
    .filter((meetup) => canManage(meetup, userId))
    .slice(0, PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setTitle("参加者一覧")
    .setColor(0x5865f2)
    .setDescription(
      meetups.length === 0
        ? "参加者一覧を表示できるMeetUpはありません。"
        : "参加者を確認するMeetUpを選択してください。",
    );
  const components: BrowsePanel["components"] = [];
  if (meetups.length > 0) {
    components.push(
      meetupSelectRow(
        `browse:members-pick:${sessionId}`,
        meetups.map((meetup) => ({ meetup })),
      ),
    );
  }
  return { embeds: [embed], components };
}

function newBrowseSession(ownerId: string, guildId: string): BrowseSession {
  return createUiSession<BrowseState>({
    ownerId,
    guildId,
    data: { filter: "recruiting", page: 0 },
  });
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("list")
    .setDescription("MeetUpのダッシュボードを開きます"),
  async (interaction) => {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await replyEphemeral(interaction, "サーバー内でのみ使用できます。");
        return;
      }
      await deferEphemeral(interaction);
      const session = newBrowseSession(interaction.user.id, guild.id);
      await replyEphemeral(interaction, dashboardPayload(session, interaction.user.id));
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("show")
    .setDescription("MeetUpの詳細を表示します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル・募集スレッド内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await replyEphemeral(interaction, "サーバー内でのみ使用できます。");
        return;
      }
      await deferEphemeral(interaction);

      const id = interaction.options.getInteger("meetup");
      const meetup = id === null ? meetupFromInteraction(interaction) : getMeetup(id);
      if (id !== null && (!meetup || meetup.guildId !== guild.id)) {
        await replyEphemeral(interaction, "MeetUpが見つかりません。");
        return;
      }
      if (!meetup || meetup.guildId !== guild.id) {
        const session = newBrowseSession(interaction.user.id, guild.id);
        await replyEphemeral(interaction, dashboardPayload(session, interaction.user.id));
        return;
      }
      if (!canViewMeetup(meetup, interaction.user.id)) {
        await replyEphemeral(interaction, NO_PERMISSION);
        return;
      }
      const session = newBrowseSession(interaction.user.id, guild.id);
      await replyEphemeral(interaction, detailPayload(meetup, interaction.user.id, session.id));
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("members")
    .setDescription("MeetUpの参加者一覧を表示します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("MeetUp ID（専用チャンネル内なら省略可）").setMinValue(1),
    ),
  async (interaction) => {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await replyEphemeral(interaction, "サーバー内でのみ使用できます。");
        return;
      }
      await deferEphemeral(interaction);

      const id = interaction.options.getInteger("meetup");
      const meetup = id === null ? meetupFromInteraction(interaction) : getMeetup(id);
      if (id !== null && (!meetup || meetup.guildId !== guild.id)) {
        await replyEphemeral(interaction, "MeetUpが見つかりません。");
        return;
      }
      if (!meetup || meetup.guildId !== guild.id) {
        const session = createUiSession<null>({
          ownerId: interaction.user.id,
          guildId: guild.id,
          data: null,
        });
        await replyEphemeral(
          interaction,
          membersPickerPayload(guild.id, interaction.user.id, session.id),
        );
        return;
      }
      if (!canManage(meetup, interaction.user.id)) {
        await replyEphemeral(interaction, "主催者または共同主催者のみ参加者一覧を表示できます。");
        return;
      }
      await replyEphemeral(interaction, membersPayload(meetup, 0));
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

/* --- dashboard components --- */

selectMenu(/^browse:filter:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<BrowseState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    const value = interaction.values[0];
    if (value !== "recruiting" && value !== "joined" && value !== "managing") {
      await replyEphemeral(interaction, "無効な操作です。");
      return;
    }
    session.data.filter = value;
    session.data.page = 0;
    await interaction.update(dashboardPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

selectMenu(/^browse:pick:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<BrowseState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    const meetupId = selectedNumber(interaction);
    const meetup = meetupId === null ? null : getMeetup(meetupId);
    if (!meetup || meetup.guildId !== session.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (!canViewMeetup(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, NO_PERMISSION);
      return;
    }
    await interaction.update(detailPayload(meetup, interaction.user.id, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:prev:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<BrowseState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    session.data.page = Math.max(0, session.data.page - 1);
    await interaction.update(dashboardPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:next:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<BrowseState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    session.data.page += 1;
    await interaction.update(dashboardPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:list:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<BrowseState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    await interaction.update(dashboardPayload(session, interaction.user.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:close:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<BrowseState>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription("閉じました。")],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

/* --- detail cross-link --- */

button(/^browse:show:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0]));
    if (!meetup || meetup.guildId !== interaction.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (!canViewMeetup(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, NO_PERMISSION);
      return;
    }
    const session = newBrowseSession(interaction.user.id, meetup.guildId);
    await interaction.update(detailPayload(meetup, interaction.user.id, session.id));
  } catch (error) {
    await replyError(interaction, error);
  }
});

/* --- members --- */

selectMenu(/^browse:members-pick:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<null>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }
    const meetupId = selectedNumber(interaction);
    const meetup = meetupId === null ? null : getMeetup(meetupId);
    if (!meetup || meetup.guildId !== session.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ参加者一覧を表示できます。");
      return;
    }
    await interaction.update(membersPayload(meetup, 0));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:members:(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0]));
    if (!meetup || meetup.guildId !== interaction.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ参加者一覧を表示できます。");
      return;
    }
    await interaction.update(membersPayload(meetup, 0));
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^browse:members-page:(\d+):(\d+)$/, async (interaction, args) => {
  try {
    const meetup = getMeetup(Number(args[0]));
    if (!meetup || meetup.guildId !== interaction.guildId) {
      await replyEphemeral(interaction, "MeetUpが見つかりません。");
      return;
    }
    if (!canManage(meetup, interaction.user.id)) {
      await replyEphemeral(interaction, "主催者または共同主催者のみ参加者一覧を表示できます。");
      return;
    }
    const page = Number(args[1]);
    await interaction.update(membersPayload(meetup, Number.isFinite(page) ? page : 0));
  } catch (error) {
    await replyError(interaction, error);
  }
});
