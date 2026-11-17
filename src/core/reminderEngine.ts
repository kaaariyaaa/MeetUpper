import { EmbedBuilder, type Client } from "discord.js";
import { getMeetupChannel, tryDM } from "./discord.ts";
import { getMeetup, listCohosts, listParticipants } from "./meetup.ts";
import {
  REMINDER_RETRY_DELAYS_MS,
  REMINDER_WINDOW_MS,
  claimSchedule,
  createFailureRecord,
  expireChannelWarnings,
  finishSchedule,
  getFailureBySchedule,
  getReminderSettings,
  listDueSchedules,
  listExpiredSchedules,
  listFailedSchedulesWithoutFailure,
  listPendingChannelWarnings,
  listStaleSending,
  pruneReminderHistory,
  reminderBaseAt,
  remainingMinutes,
  resetSendingToPending,
  scheduleRetry,
  updateFailureDmStatus,
  updateFailureChannelStatus,
} from "./reminders.ts";
import { discordTimestamp } from "./time.ts";
import type { Meetup, ReminderFailure, ReminderSchedule } from "./types.ts";

function reminderRecipients(meetup: Meetup): string[] {
  const ids = [meetup.hostId, ...listCohosts(meetup.id), ...listParticipants(meetup.id, ["APPROVED"]).map((p) => p.userId)];
  return [...new Set(ids)];
}

function isOnlyHost(meetup: Meetup, recipients: string[]): boolean {
  return recipients.filter((id) => id !== meetup.hostId).length === 0;
}

function basisLabel(meetup: Meetup): "集合" | "開催" {
  return meetup.meetingAt !== null ? "集合" : "開催";
}

export function reminderEmbed(meetup: Meetup, schedule: ReminderSchedule, now: number): EmbedBuilder {
  const baseAt = reminderBaseAt(meetup);
  const basis = basisLabel(meetup);
  const embed = new EmbedBuilder()
    .setTitle("⏰ リマインド")
    .setColor(0x5865f2)
    .setDescription(
      `MeetUp「${meetup.name}」の${basis}まで**${remainingMinutes(baseAt, now)}分**です。`,
    )
    .addFields({ name: "開催日時", value: discordTimestamp(meetup.startAt), inline: true });
  if (meetup.meetingAt !== null) {
    embed.addFields({ name: "集合時間", value: discordTimestamp(meetup.meetingAt), inline: true });
  }
  if (meetup.meetingPlace) {
    embed.addFields({ name: "集合場所", value: meetup.meetingPlace, inline: false });
  }
  return embed;
}

function failureEmbed(meetup: Meetup, schedule: ReminderSchedule, failedAt: number, error: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("リマインダー送信失敗")
    .setColor(0xe74c3c)
    .setDescription(`MeetUp「${meetup.name}」の自動リマインダーを送信できませんでした。`)
    .addFields(
      { name: "本来の通知予定時刻", value: discordTimestamp(schedule.scheduledAt), inline: true },
      { name: "失敗確定時刻", value: discordTimestamp(failedAt), inline: true },
      { name: "失敗内容", value: error.slice(0, 1000) || "不明なエラー", inline: false },
    );
}

function channelWarningEmbed(failure: ReminderFailure, meetupName: string, dmFailed: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("リマインダー送信失敗（警告）")
    .setColor(0xe67e22)
    .setDescription(`MeetUp「${meetupName}」の自動リマインダーが最終的に送信できませんでした。`)
    .addFields(
      { name: "本来の通知予定時刻", value: discordTimestamp(failure.scheduledAt), inline: true },
      { name: "失敗確定時刻", value: discordTimestamp(failure.failedAt), inline: true },
      {
        name: "管理者へのDM",
        value: dmFailed > 0 ? `${dmFailed}人へ失敗通知DMを送信できませんでした。` : "送信済み",
      },
      { name: "警告期限", value: discordTimestamp(failure.warningDeadline), inline: true },
    );
}

async function trySendWarning(
  client: Client,
  meetup: Meetup,
  failure: ReminderFailure,
  dmFailed: number,
): Promise<{ sent: boolean; error: string | null }> {
  const guild = client.guilds.cache.get(meetup.guildId);
  if (!guild) return { sent: false, error: "サーバーが見つかりません" };
  const channel = await getMeetupChannel(guild, meetup);
  if (!channel) return { sent: false, error: "MeetUpチャンネルが見つかりません" };
  try {
    await channel.send({ embeds: [channelWarningEmbed(failure, meetup.name, dmFailed)] });
    return { sent: true, error: null };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function notifyFailure(
  client: Client,
  meetup: Meetup,
  schedule: ReminderSchedule,
  reason: string,
  now: number,
): Promise<void> {
  let failure = getFailureBySchedule(schedule.id);
  if (!failure) {
    failure = createFailureRecord({
      meetupId: meetup.id,
      scheduleId: schedule.id,
      scheduledAt: schedule.scheduledAt,
      failedAt: now,
      error: reason,
    });
  } else if (failure.dmStatus !== "PENDING") {
    return;
  }

  const managers = [...new Set([meetup.hostId, ...listCohosts(meetup.id)])];
  const embed = failureEmbed(meetup, schedule, now, reason);
  let dmFailed = 0;
  let dmSent = 0;
  for (const userId of managers) {
    if (await tryDM(client, userId, { embeds: [embed] })) dmSent += 1;
    else dmFailed += 1;
  }
  const dmStatus: "SENT" | "FAILED" | "PARTIAL" =
    dmFailed === 0 ? "SENT" : dmSent === 0 ? "FAILED" : "PARTIAL";
  updateFailureDmStatus(failure.id, dmSent, dmFailed, dmStatus, now);

  if (dmFailed === 0) {
    updateFailureChannelStatus(failure.id, "SKIPPED", null, now);
    return;
  }

  // DMに失敗した管理者がいる場合はチャンネル警告を1件だけ送る。送れなければ24時間保持する。
  const warning = await trySendWarning(client, meetup, failure, dmFailed);
  if (warning.sent) updateFailureChannelStatus(failure.id, "SENT", null, now);
  else updateFailureChannelStatus(failure.id, "PENDING", warning.error, now);
}

async function sendReminder(
  client: Client,
  meetup: Meetup,
  schedule: ReminderSchedule,
  recipients: string[],
  now: number,
): Promise<void> {
  const fresh = getMeetup(meetup.id);
  if (!fresh || fresh.state !== "ACTIVE" || !getReminderSettings(meetup.id).enabled) {
    finishSchedule(schedule.id, "SKIPPED", "送信直前に停止されたため送信しない", null, now);
    return;
  }
  const guild = client.guilds.cache.get(meetup.guildId);
  if (!guild) {
    resetSendingToPending(schedule.id, now);
    return;
  }
  const channel = await getMeetupChannel(guild, meetup);
  const error =
    channel === null
      ? "MeetUpチャンネルが見つかりません"
      : await channel
          .send({
            content: recipients.map((id) => `<@${id}>`).join(" "),
            allowedMentions: { users: recipients },
            embeds: [reminderEmbed(meetup, schedule, now)],
          })
          .then(() => null)
          .catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));

  if (error === null) {
    finishSchedule(schedule.id, "SENT", null, now, now);
    return;
  }

  const attempts = schedule.attempts + 1;
  const delay = REMINDER_RETRY_DELAYS_MS[attempts - 1];
  const baseAt = reminderBaseAt(meetup);
  // Leave a scheduler tick of slack before the 15-minute hard stop.
  const retryWindowEnd = schedule.scheduledAt + REMINDER_WINDOW_MS - 60_000;
  const retryAt =
    delay === undefined ? null : Math.min(now + delay, retryWindowEnd);
  const canRetry =
    retryAt !== null && retryAt > now && retryAt <= retryWindowEnd && now < baseAt;
  if (canRetry && retryAt !== null) {
    scheduleRetry(schedule.id, attempts, retryAt, error, now);
    return;
  }

  finishSchedule(schedule.id, "FAILED", error, null, now);
  await notifyFailure(client, meetup, schedule, error, now);
}

async function processDueMeetup(
  client: Client,
  meetupId: number,
  schedules: ReminderSchedule[],
  now: number,
): Promise<void> {
  const meetup = getMeetup(meetupId);
  if (!meetup) return;
  const settings = getReminderSettings(meetup.id);
  if (meetup.state !== "ACTIVE") {
    for (const schedule of schedules) {
      finishSchedule(schedule.id, "SKIPPED", `MeetUpが${meetup.state}のため送信しない`, null, now);
    }
    return;
  }
  if (!settings.enabled) {
    for (const schedule of schedules) {
      finishSchedule(schedule.id, "SKIPPED", "自動通知がOFFのため送信しない", null, now);
    }
    return;
  }
  if (now >= reminderBaseAt(meetup)) {
    for (const schedule of schedules) {
      finishSchedule(schedule.id, "SKIPPED", "通知基準日時を過ぎたため送信しない", null, now);
    }
    return;
  }

  const recipients = reminderRecipients(meetup);
  if (isOnlyHost(meetup, recipients)) {
    for (const schedule of schedules) {
      finishSchedule(schedule.id, "SKIPPED", "通知対象者が主催者のみのため送信しない", null, now);
    }
    return;
  }

  const due = [...schedules].sort((a, b) => b.scheduledAt - a.scheduledAt || b.id - a.id);
  const newest = due[0];
  if (!newest) return;
  for (const older of due.slice(1)) {
    finishSchedule(older.id, "SKIPPED", "同時に滞留したため新しい通知を優先", null, now);
  }
  if (!claimSchedule(newest.id, now)) return;
  await sendReminder(client, meetup, newest, recipients, now);
}

async function processPendingWarnings(client: Client, now: number): Promise<void> {
  for (const failure of listPendingChannelWarnings(now)) {
    const meetup = getMeetup(failure.meetupId);
    if (!meetup || meetup.state !== "ACTIVE") {
      updateFailureChannelStatus(failure.id, "SKIPPED", "MeetUpがACTIVEではない", now);
      continue;
    }
    const warning = await trySendWarning(client, meetup, failure, failure.dmFailed);
    if (warning.sent) updateFailureChannelStatus(failure.id, "SENT", null, now);
    else updateFailureChannelStatus(failure.id, "PENDING", warning.error, now);
  }
}

let ticking = false;

/** Processes due/retrying reminders, stale sends and pending failure warnings. */
export async function tickReminders(client: Client, now = Date.now()): Promise<void> {
  if (ticking) return;
  if (typeof client.isReady === "function" && !client.isReady()) return;
  ticking = true;
  try {
    pruneReminderHistory(now);
    expireChannelWarnings(now);

    for (const schedule of listStaleSending(now)) {
      const meetup = getMeetup(schedule.meetupId);
      if (meetup && !getReminderSettings(meetup.id).enabled) {
        finishSchedule(schedule.id, "SKIPPED", "自動通知がOFFのため停止", null, now);
        continue;
      }
      const expired =
        !meetup ||
        meetup.state !== "ACTIVE" ||
        now > schedule.scheduledAt + REMINDER_WINDOW_MS ||
        (meetup !== null && now >= reminderBaseAt(meetup));
      if (!expired) {
        resetSendingToPending(schedule.id, now);
        continue;
      }
      if (meetup && meetup.state === "ACTIVE") {
        // Result is unknown, not a confirmed send failure; do not alarm managers.
        finishSchedule(schedule.id, "SKIPPED", "送信結果不明のまま期限切れ", null, now);
      } else {
        finishSchedule(schedule.id, "SKIPPED", "MeetUpがACTIVEではない", null, now);
      }
    }

    for (const schedule of listExpiredSchedules(now)) {
      finishSchedule(schedule.id, "SKIPPED", "通知時刻から15分を超えたため送信しない", null, now);
    }

    // A crash between the FAILED update and the failure record is repaired here.
    for (const schedule of listFailedSchedulesWithoutFailure()) {
      const meetup = getMeetup(schedule.meetupId);
      if (!meetup) continue;
      await notifyFailure(
        client,
        meetup,
        schedule,
        schedule.lastError ?? "送信失敗",
        schedule.updatedAt || now,
      );
    }

    const dueByMeetup = new Map<number, ReminderSchedule[]>();
    for (const schedule of listDueSchedules(now)) {
      const list = dueByMeetup.get(schedule.meetupId) ?? [];
      list.push(schedule);
      dueByMeetup.set(schedule.meetupId, list);
    }
    for (const [meetupId, schedules] of dueByMeetup) {
      await processDueMeetup(client, meetupId, schedules, now);
    }

    await processPendingWarnings(client, now);
  } catch (error) {
    console.error("リマインダー処理に失敗しました", error);
  } finally {
    ticking = false;
  }
}
