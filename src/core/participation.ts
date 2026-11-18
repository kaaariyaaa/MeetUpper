import { DiscordAPIError, EmbedBuilder, type Client, type Message } from "discord.js";
import { db } from "../db.ts";

export type ParticipationKind = "application" | "invite" | "invite_request";

export interface ParticipationMessage {
  id: number;
  meetupId: number;
  kind: ParticipationKind;
  channelId: string;
  messageId: string;
  createdAt: number;
}

interface ParticipationRow {
  id: number;
  meetup_id: number;
  kind: string;
  channel_id: string;
  message_id: string;
  created_at: number;
}

function toParticipationMessage(row: ParticipationRow): ParticipationMessage {
  return {
    id: row.id,
    meetupId: row.meetup_id,
    kind: row.kind as ParticipationKind,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

export function recordParticipationMessage(
  meetupId: number,
  kind: ParticipationKind,
  channelId: string,
  messageId: string,
  now = Date.now(),
): void {
  db.query(
    `INSERT OR IGNORE INTO participation_messages
       (meetup_id, kind, channel_id, message_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(meetupId, kind, channelId, messageId, now);
}

export function listParticipationMessages(meetupId: number): ParticipationMessage[] {
  return (
    db
      .query("SELECT * FROM participation_messages WHERE meetup_id = ? ORDER BY id ASC")
      .all(meetupId) as ParticipationRow[]
  ).map(toParticipationMessage);
}

export function deleteParticipationMessage(id: number): void {
  db.query("DELETE FROM participation_messages WHERE id = ?").run(id);
}

function isUnknownTarget(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    (error.code === 10003 || error.code === 10008 || error.status === 404)
  );
}

/** Removes participation components from one stored message. Returns true when it can be forgotten. */
export async function closeParticipationMessage(
  client: Client,
  entry: ParticipationMessage,
  notice: string,
): Promise<boolean> {
  let channel;
  try {
    channel = await client.channels.fetch(entry.channelId);
  } catch (error) {
    if (isUnknownTarget(error)) {
      deleteParticipationMessage(entry.id);
      return true;
    }
    console.error(`参加メッセージのチャンネル取得に失敗しました: ${entry.channelId}`, error);
    return false;
  }
  if (!channel || !channel.isTextBased()) {
    deleteParticipationMessage(entry.id);
    return true;
  }

  let message: Message;
  try {
    message = await channel.messages.fetch(entry.messageId);
  } catch (error) {
    if (isUnknownTarget(error)) {
      deleteParticipationMessage(entry.id);
      return true;
    }
    console.error(`参加メッセージの取得に失敗しました: ${entry.messageId}`, error);
    return false;
  }

  try {
    const embeds = message.embeds.map((embed) => EmbedBuilder.from(embed));
    if (embeds[0]) {
      if (!embeds[0].data.fields?.some((field) => field.name === "募集状況")) {
        embeds[0].addFields({ name: "募集状況", value: notice });
      }
      await message.edit({ embeds, components: [] });
    } else {
      const content = message.content ? `${message.content}\n\n${notice}` : notice;
      await message.edit({ content, components: [] });
    }
    deleteParticipationMessage(entry.id);
    return true;
  } catch (error) {
    console.error(`参加メッセージの更新に失敗しました: ${entry.messageId}`, error);
    return false;
  }
}

export async function closeParticipationMessages(
  client: Client,
  meetupId: number,
  notice: string,
): Promise<void> {
  for (const entry of listParticipationMessages(meetupId)) {
    try {
      await closeParticipationMessage(client, entry, notice);
    } catch (error) {
      console.error(`参加メッセージの閉鎖処理に失敗しました: ${entry.id}`, error);
    }
  }
}

/** Retries messages for MeetUps that started, were cancelled or were archived. */
export async function sweepParticipationMessages(client: Client, now = Date.now()): Promise<void> {
  const rows = db
    .query(
      `SELECT pm.* FROM participation_messages pm
       JOIN meetups m ON m.id = pm.meetup_id
       WHERE m.state IN ('CANCELLED', 'ARCHIVED') OR m.start_at <= ?
       ORDER BY pm.id ASC`,
    )
    .all(now) as ParticipationRow[];
  for (const row of rows) {
    try {
      await closeParticipationMessage(client, toParticipationMessage(row), "募集は終了しました");
    } catch (error) {
      console.error(`参加メッセージの再試行に失敗しました: ${row.id}`, error);
    }
  }
}
