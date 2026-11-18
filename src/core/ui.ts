import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  type Interaction,
} from "discord.js";
import { discordTimestamp } from "./time.ts";
import type { Meetup } from "./types.ts";

export const UI_SESSION_TTL_MS = 15 * 60 * 1000;

export interface UiSession<T> {
  id: string;
  ownerId: string;
  guildId: string;
  meetupId: number | null;
  data: T;
  expiresAt: number;
}

const sessions = new Map<string, UiSession<unknown>>();

export function newUiSessionId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 10);
}

function cleanup(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

export function createUiSession<T>(input: {
  ownerId: string;
  guildId: string;
  meetupId?: number | null;
  data: T;
  now?: number;
}): UiSession<T> {
  cleanup();
  const session: UiSession<T> = {
    id: newUiSessionId(),
    ownerId: input.ownerId,
    guildId: input.guildId,
    meetupId: input.meetupId ?? null,
    data: input.data,
    expiresAt: (input.now ?? Date.now()) + UI_SESSION_TTL_MS,
  };
  sessions.set(session.id, session as UiSession<unknown>);
  return session;
}

/** Returns the session when it belongs to this user/guild and is still alive. */
export function getUiSession<T>(
  interaction: Interaction,
  id: string,
  now = Date.now(),
): UiSession<T> | null {
  cleanup(now);
  const session = sessions.get(id) as UiSession<T> | undefined;
  if (!session) return null;
  if (session.ownerId !== interaction.user.id) return null;
  const guildId = interaction.guildId ?? interaction.guild?.id ?? null;
  if (guildId === null || guildId !== session.guildId) return null;
  session.expiresAt = now + UI_SESSION_TTL_MS;
  return session;
}

export function dropUiSession(id: string): void {
  sessions.delete(id);
}

/** Picks the first value of a select menu as a number, or null. */
export function selectedNumber(interaction: { values: readonly string[] }): number | null {
  const value = Number(interaction.values[0]);
  return Number.isFinite(value) ? value : null;
}

export interface MeetupChoice {
  meetup: Meetup;
  description?: string;
}

/** Select menu for up to 25 MeetUps. `customId` should include any session/page data. */
export function meetupSelectRow(
  customId: string,
  choices: MeetupChoice[],
  placeholder = "MeetUpを選択",
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      choices.slice(0, 25).map(({ meetup, description }) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${meetup.name}`.slice(0, 100))
          .setValue(String(meetup.id))
          .setDescription(
            (description ??
              `#${meetup.id} / ${meetup.mode} / ${meetup.state} / ${discordTimestamp(meetup.startAt, "d")}`)
              .slice(0, 100),
          ),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

/** User select menu for inviting/targeting one member. */
export function userSelectRow(
  customId: string,
  placeholder = "メンバーを選択",
): ActionRowBuilder<UserSelectMenuBuilder> {
  const select = new UserSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
}

export function confirmButtons(
  confirmId: string,
  cancelId: string,
  confirmLabel = "実行する",
  cancelLabel = "キャンセル",
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel(cancelLabel).setStyle(ButtonStyle.Secondary),
  );
}

export function pageRow(
  prevId: string,
  nextId: string,
  page: number,
  pages: number,
  closeId?: string,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel("前へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel("次へ")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page + 1 >= Math.max(1, pages)),
  );
  if (closeId) {
    row.addComponents(new ButtonBuilder().setCustomId(closeId).setLabel("閉じる").setStyle(ButtonStyle.Secondary));
  }
  return row;
}

export function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
