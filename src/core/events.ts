import {
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  type Guild,
  type GuildScheduledEvent,
} from "discord.js";
import { updateMeetup } from "./meetup.ts";
import type { Meetup } from "./types.ts";

const DEFAULT_EVENT_DURATION_MS = 2 * 60 * 60 * 1000;

export function publicEventDescription(meetup: Meetup): string {
  const intro = meetup.description || "MeetUpを開催します。";
  return `${intro}\n\n参加確定者は専用チャンネルに集合場所・集合時間が共有されます。`.slice(0, 1000);
}

async function createEvent(guild: Guild, meetup: Meetup): Promise<GuildScheduledEvent | null> {
  if (!meetup.eventEnabled || meetup.mode !== "PUBLIC" || meetup.startAt === null) return null;
  try {
    const event = await guild.scheduledEvents.create({
      name: meetup.name.slice(0, 100),
      description: publicEventDescription(meetup),
      scheduledStartTime: new Date(meetup.startAt),
      scheduledEndTime: new Date(meetup.startAt + DEFAULT_EVENT_DURATION_MS),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: "参加確定者に共有します" },
    });
    updateMeetup(meetup.id, { eventId: event.id });
    return event;
  } catch (error) {
    console.error("スケジュールイベントの作成に失敗しました", error);
    return null;
  }
}

/** Creates the linked Discord scheduled event for Public meetups when enabled. */
export async function syncEventCreation(guild: Guild, meetup: Meetup): Promise<GuildScheduledEvent | null> {
  if (meetup.eventId) {
    return guild.scheduledEvents.fetch(meetup.eventId).catch(() => null);
  }
  return createEvent(guild, meetup);
}

export async function cancelEvent(guild: Guild, meetup: Meetup): Promise<void> {
  if (!meetup.eventId) return;
  try {
    const event = await guild.scheduledEvents.fetch(meetup.eventId);
    if (event.status !== GuildScheduledEventStatus.Canceled) {
      // Keep the event visible as cancelled instead of deleting the public record.
      await event.setStatus(GuildScheduledEventStatus.Canceled);
    }
  } catch (error) {
    console.error("スケジュールイベントの中止に失敗しました", error);
    try {
      const event = await guild.scheduledEvents.fetch(meetup.eventId);
      await event.delete();
    } catch {
      // event may already be gone
    }
  }
}

export async function updateEvent(guild: Guild, meetup: Meetup): Promise<void> {
  if (!meetup.eventId || meetup.startAt === null) return;
  try {
    const event = await guild.scheduledEvents.fetch(meetup.eventId);
    await event.edit({
      name: meetup.name.slice(0, 100),
      description: publicEventDescription(meetup),
      scheduledStartTime: new Date(meetup.startAt),
      scheduledEndTime: new Date(meetup.startAt + DEFAULT_EVENT_DURATION_MS),
    });
  } catch {
    // event may already be gone
  }
}
