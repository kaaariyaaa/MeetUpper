import { config } from "../config.ts";

/** Parses "YYYY-MM-DD HH:mm", "YYYY/MM/DD HH:mm", date-only, or ISO 8601 with offset. */
export function parseDateTime(input: string, timeZone = config.timeZone): number | null {
  const text = input.trim();
  if (!text) return null;

  const explicit = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text);
  if (explicit) {
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : t;
  }

  const m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!m) {
    const t = Date.parse(text);
    return Number.isNaN(t) ? null : t;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? "0");
  const minute = Number(m[5] ?? "0");
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  return zonedToUtc(year, month, day, hour, minute, timeZone);
}

function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(timeZone, new Date(guess));
  const second = guess - offsetMs(timeZone, new Date(first));
  return second;
}

function offsetMs(timeZone: string, at: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Discord timestamp, rendered in each user's local time. */
export function discordTimestamp(epochMs: number, style: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "F"): string {
  return `<t:${Math.floor(epochMs / 1000)}:${style}>`;
}

/** "YYYY-MM-DD HH:mm" in the given timezone (used for stored/displayed plain text). */
export function formatInZone(epochMs: number, timeZone = config.timeZone): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(epochMs)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
