export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
  timeZone: process.env.DEFAULT_TIMEZONE ?? "Asia/Tokyo",
  dbPath: process.env.DB_PATH ?? "data/meetupper.db",
  categoryName: "MeetUp",
  forumName: "meetup募集",
  /** Former forum name; the layout lookup accepts it and renames the channel on the next init. */
  legacyForumName: "オフ会募集",
  inviteName: "招待",
  /** Reminder offsets relative to the event start, in seconds. */
  reminderOffsets: [
    { kind: "1d", seconds: 24 * 60 * 60 },
    { kind: "3h", seconds: 3 * 60 * 60 },
    { kind: "30m", seconds: 30 * 60 },
  ],
} as const;
