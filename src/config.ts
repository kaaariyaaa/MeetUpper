export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
  applicationId: process.env.DISCORD_APPLICATION_ID ?? "",
  guildId: process.env.DISCORD_GUILD_ID || undefined,
  timeZone: process.env.DEFAULT_TIMEZONE ?? "Asia/Tokyo",
  dbPath: process.env.DB_PATH ?? "data/meetupper.db",
  categoryName: "MeetUp",
  forumName: "オフ会募集",
  inviteName: "招待",
  /** Reminder offsets relative to the event start, in seconds. */
  reminderOffsets: [
    { kind: "1d", seconds: 24 * 60 * 60 },
    { kind: "3h", seconds: 3 * 60 * 60 },
    { kind: "30m", seconds: 30 * 60 },
  ],
} as const;
