import { SlashCommandSubcommandBuilder, type Client } from "discord.js";
import { deferEphemeral, getMeetupChannel, replyEphemeral, replyError } from "../core/discord.ts";
import { canManage, dueReminders, getMeetup, listParticipants, markReminderSent } from "../core/meetup.ts";
import { setup, subcommand } from "../core/registry.ts";
import { discordTimestamp } from "../core/time.ts";
import type { Meetup, Participant } from "../core/types.ts";

const KIND_LABEL: Record<string, string> = {
  "1d": "明日",
  "3h": "3時間後",
  "30m": "30分後",
};

/** Reminder text in the shared announcement style. The meeting place stays inside the private meetup channel. */
function announcementContent(meetup: Meetup, approved: Participant[], heading: string): string {
  const lines = [`⏰ ${heading}: ${meetup.name}`, `開始: ${discordTimestamp(meetup.startAt)}`];
  if (meetup.meetingAt) lines.push(`集合時間: ${discordTimestamp(meetup.meetingAt)}`);
  if (meetup.meetingPlace) lines.push(`集合場所: ${meetup.meetingPlace}`);
  lines.push(approved.map((participant) => `<@${participant.userId}>`).join(" "));
  return lines.join("\n");
}

async function sendAnnouncement(
  client: Client,
  meetup: Meetup,
  approved: Participant[],
  heading: string,
): Promise<boolean> {
  const guild = client.guilds.cache.get(meetup.guildId);
  if (!guild) return false;
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return false;
  await channel.send({
    content: announcementContent(meetup, approved, heading),
    allowedMentions: { users: approved.map((participant) => participant.userId) },
  });
  return true;
}

let ticking = false;

/** Sends every due reminder exactly once. Skips (without marking) when the guild or channel is not reachable yet. */
export async function tick(client: Client): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const reminder of dueReminders(now)) {
      const meetup = getMeetup(reminder.meetupId);
      if (!meetup || meetup.state !== "ACTIVE") {
        markReminderSent(reminder.meetupId, reminder.kind);
        continue;
      }
      // Never send a reminder for a meetup that already started.
      if (now > meetup.startAt) {
        markReminderSent(reminder.meetupId, reminder.kind);
        continue;
      }
      const guild = client.guilds.cache.get(meetup.guildId);
      if (!guild) continue;
      const channel = await getMeetupChannel(guild, meetup);
      if (!channel) continue;

      const approved = listParticipants(meetup.id, ["APPROVED"]);
      if (approved.length === 0) {
        markReminderSent(meetup.id, reminder.kind);
        continue;
      }

      try {
        await channel.send({
          content: announcementContent(
            meetup,
            approved,
            `${KIND_LABEL[reminder.kind] ?? reminder.kind}に開催です`,
          ),
          allowedMentions: { users: approved.map((participant) => participant.userId) },
        });
        markReminderSent(meetup.id, reminder.kind);
      } catch (error) {
        console.error(`リマインドの送信に失敗しました (meetup=${meetup.id}, kind=${reminder.kind})`, error);
      }
    }
  } catch (error) {
    console.error("リマインダー処理に失敗しました", error);
  } finally {
    ticking = false;
  }
}

setup((client) => {
  void tick(client);
  const timer = setInterval(() => void tick(client), 30_000);
  timer.unref?.();
});

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("remind")
    .setDescription("参加確定者にリマインドを送信します")
    .addIntegerOption((option) =>
      option.setName("meetup").setDescription("オフ会ID").setRequired(true).setMinValue(1),
    ),
  async (interaction) => {
    if (!interaction.guild) {
      await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
      return;
    }
    await deferEphemeral(interaction);
    try {
      const meetupId = interaction.options.getInteger("meetup", true);
      const meetup = getMeetup(meetupId);
      if (!meetup || meetup.guildId !== interaction.guild.id) {
        await replyEphemeral(interaction, "オフ会が見つかりません。");
        return;
      }
      if (!canManage(meetup, interaction.user.id)) {
        await replyEphemeral(interaction, "リマインドを送信する権限がありません。");
        return;
      }
      if (meetup.state !== "ACTIVE") {
        await replyEphemeral(interaction, "ACTIVEのオフ会にのみリマインドを送信できます。");
        return;
      }
      const approved = listParticipants(meetup.id, ["APPROVED"]);
      if (approved.length === 0) {
        await replyEphemeral(interaction, "参加確定者がいません。");
        return;
      }
      const sent = await sendAnnouncement(interaction.client, meetup, approved, "リマインド");
      if (!sent) {
        await replyEphemeral(interaction, "オフ会チャンネルが見つかりません。");
        return;
      }
      await replyEphemeral(interaction, "リマインドを送信しました");
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);
