import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { config } from "../config.ts";
import { countApproved, listCohosts, listParticipants } from "./meetup.ts";
import { discordTimestamp } from "./time.ts";
import type { Meetup, Participant } from "./types.ts";

/** Capacity 0 means no limit. */
export function capacityLabel(capacity: number): string {
  return capacity > 0 ? `${capacity}人` : "定員なし";
}

const MODE_LABEL = { PUBLIC: "Public", PRIVATE: "Private" } as const;
const APPROVAL_LABEL = { DIRECT: "直参加", HOST: "主催者承認", VOTE: "参加者投票" } as const;
const STATE_LABEL = { ACTIVE: "ACTIVE", ARCHIVED: "ARCHIVED", CANCELLED: "CANCELLED" } as const;

export function meetupEmbed(meetup: Meetup, options: { includeMeetingPlace?: boolean } = {}): EmbedBuilder {
  const approved = countApproved(meetup.id);
  const cohosts = listCohosts(meetup.id);
  const embed = new EmbedBuilder()
    .setTitle(meetup.name)
    .setColor(meetup.state === "ACTIVE" ? 0x2ecc71 : meetup.state === "ARCHIVED" ? 0x95a5a6 : 0xe74c3c)
    .setDescription(meetup.description || "説明はありません。")
    .addFields(
      {
        name: "日時",
        value: meetup.startAt === null ? "未定" : discordTimestamp(meetup.startAt),
        inline: true,
      },
      { name: "定員", value: `${capacityLabel(meetup.capacity)}（確定 ${approved}人）`, inline: true },
      { name: "公開モード", value: MODE_LABEL[meetup.mode], inline: true },
      { name: "承認方式", value: approvalLabel(meetup), inline: true },
      { name: "状態", value: STATE_LABEL[meetup.state], inline: true },
      { name: "主催者", value: `<@${meetup.hostId}>`, inline: true },
    );

  if (meetup.meetingAt) {
    embed.addFields({ name: "集合時間", value: discordTimestamp(meetup.meetingAt), inline: true });
  }
  if (options.includeMeetingPlace && meetup.meetingPlace) {
    embed.addFields({ name: "集合場所", value: meetup.meetingPlace, inline: false });
  }
  if (cohosts.length > 0) {
    embed.addFields({ name: "共同主催者", value: cohosts.map((id) => `<@${id}>`).join(" "), inline: false });
  }
  return embed;
}

function approvalLabel(meetup: Meetup): string {
  if (meetup.approvalMode === "VOTE") {
    return `${APPROVAL_LABEL.VOTE}（必要票数 ${meetup.requiredVotes}）`;
  }
  return APPROVAL_LABEL[meetup.approvalMode];
}

/** Recruitment post button; the label follows whether joining needs approval. */
export function applyButtonRow(meetup: Meetup): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`apply:start:${meetup.id}`)
      .setLabel(meetup.approvalMode === "DIRECT" ? "参加する" : "参加申請")
      .setStyle(ButtonStyle.Primary),
  );
}

/** Embed for the public forum post and scheduled event: no exact meeting place. */
export function publicEmbed(meetup: Meetup): EmbedBuilder {
  return meetupEmbed(meetup);
}

export function participantLine(participant: Participant): string {
  return `<@${participant.userId}> (${participant.state})`;
}

export function participantsSummary(meetupId: number): string {
  const groups: Record<string, Participant[]> = {
    APPROVED: [],
    APPLIED: [],
    INVITED: [],
    DECLINED: [],
    REJECTED: [],
    CANCELLED: [],
    KICKED: [],
  };
  for (const participant of listParticipants(meetupId)) groups[participant.state]?.push(participant);
  const lines: string[] = [];
  for (const [state, members] of Object.entries(groups)) {
    if (members.length === 0) continue;
    lines.push(`**${state}** (${members.length}): ${members.map((m) => `<@${m.userId}>`).join(", ")}`);
  }
  return lines.join("\n") || "参加者はいません。";
}

export function dateTimeHint(): string {
  return `日時は \`${config.timeZone}\` の \`YYYY-MM-DD HH:mm\` 形式で指定してください。`;
}
