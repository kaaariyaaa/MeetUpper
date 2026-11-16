import { PermissionFlagsBits, SlashCommandSubcommandBuilder } from "discord.js";
import { deferEphemeral, ensureLayout, replyEphemeral, replyError } from "../core/discord.ts";
import { subcommand } from "../core/registry.ts";

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("init")
    .setDescription("サーバーへ MeetUp カテゴリ・募集フォーラム・招待チャンネルを作成します（管理者のみ）"),
  async (interaction) => {
    if (!interaction.guild) {
      await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await replyEphemeral(interaction, "このコマンドはサーバー管理者のみ実行できます。");
      return;
    }

    await deferEphemeral(interaction);
    try {
      const layout = await ensureLayout(interaction.guild);
      await replyEphemeral(
        interaction,
        [
          "MeetUpper のセットアップが完了しました。",
          `カテゴリ: ${layout.category.name}`,
          `募集フォーラム: <#${layout.forum.id}>`,
          `招待チャンネル: <#${layout.inviteChannel.id}>`,
          "既に存在する場合は再利用し、権限・並び順を整えています。",
        ].join("\n"),
      );
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);
