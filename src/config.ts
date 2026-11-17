export const config = {
  token: process.env.DISCORD_TOKEN ?? "",
  timeZone: process.env.DEFAULT_TIMEZONE ?? "Asia/Tokyo",
  dbPath: process.env.DB_PATH ?? "data/meetupper.db",
  categoryName: "MeetUp",
  forumName: "meetup募集",
  /** Former forum name; the layout lookup accepts it and renames the channel on the next init. */
  legacyForumName: "オフ会募集",
  inviteName: "招待",} as const;
