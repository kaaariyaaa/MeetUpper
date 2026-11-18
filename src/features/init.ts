import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandSubcommandBuilder,
  type ButtonInteraction,
  type RepliableInteraction,
} from "discord.js";
import {
  ensureLayout,
  isLayoutInitialized,
  replyEphemeral,
  replyError,
} from "../core/discord.ts";
import { button, subcommand } from "../core/registry.ts";
import { confirmButtons, createUiSession, dropUiSession, getUiSession } from "../core/ui.ts";

interface InitSessionData {
  action: "init";
}

const COLOR_PRIMARY = 0x5865f2;
const COLOR_SUCCESS = 0x2ecc71;

function isAdministrator(interaction: RepliableInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function initPanel(sessionId: string) {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle("MeetUpper のセットアップ")
        .setColor(COLOR_PRIMARY)
        .setDescription(
          [
            "MeetUp カテゴリ・meetup募集 フォーラム・招待 チャンネルを作成します。",
            "既に存在する場合は再利用し、権限と並び順を整えます。",
            "実行するには下のボタンを押してください。",
          ].join("\n"),
        ),
    ],
    components: [
      confirmButtons(`ops:init-confirm:${sessionId}`, `ops:init-cancel:${sessionId}`, "実行する", "キャンセル"),
    ],
  };
}

async function openInitPanel(interaction: RepliableInteraction): Promise<void> {
  if (!interaction.guild) {
    await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
    return;
  }
  if (!isAdministrator(interaction)) {
    await replyEphemeral(interaction, "このコマンドはサーバー管理者のみ実行できます。");
    return;
  }
  const session = createUiSession<InitSessionData>({
    ownerId: interaction.user.id,
    guildId: interaction.guildId ?? interaction.guild.id,
    data: { action: "init" },
  });
  await replyEphemeral(interaction, initPanel(session.id));
}

subcommand(
  new SlashCommandSubcommandBuilder()
    .setName("init")
    .setDescription("サーバーへ MeetUp カテゴリ・募集フォーラム・招待チャンネルを作成します（管理者のみ）"),
  async (interaction) => {
    try {
      await openInitPanel(interaction);
    } catch (error) {
      await replyError(interaction, error);
    }
  },
);

button(/^ops:init-open$/, async (interaction) => {
  try {
    await openInitPanel(interaction);
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^ops:init-confirm:([A-Za-z0-9]+)$/, async (interaction: ButtonInteraction, args) => {
  try {
    const session = getUiSession<InitSessionData>(interaction, args[0] ?? "");
    if (!session || session.data.action !== "init") {
      await replyEphemeral(
        interaction,
        "この確認画面は無効か期限切れです。`/meetupper init` を実行し直してください。",
      );
      return;
    }
    if (!interaction.guild) {
      await replyEphemeral(interaction, "このコマンドはサーバー内でのみ使用できます。");
      return;
    }
    if (!isAdministrator(interaction)) {
      await replyEphemeral(interaction, "このコマンドはサーバー管理者のみ実行できます。");
      return;
    }

    // Creating channels can exceed the 3s interaction window; acknowledge first.
    await interaction.deferUpdate();
    const reused = await isLayoutInitialized(interaction.guild);
    const layout = await ensureLayout(interaction.guild);
    dropUiSession(session.id);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(reused ? "セットアップ済みのレイアウト" : "セットアップ完了")
          .setColor(COLOR_SUCCESS)
          .setDescription(
            [
              reused
                ? "既存のMeetUpレイアウトを再利用し、権限と並び順を整えました。"
                : "MeetUpレイアウトを作成しました。",
              `カテゴリ: ${layout.category.name}`,
              `募集フォーラム: <#${layout.forum.id}>`,
              `招待チャンネル: <#${layout.inviteChannel.id}>`,
            ].join("\n"),
          ),
      ],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});

button(/^ops:init-cancel:([A-Za-z0-9]+)$/, async (interaction, args) => {
  try {
    const session = getUiSession<InitSessionData>(interaction, args[0] ?? "");
    if (!session) {
      await replyEphemeral(
        interaction,
        "この確認画面は無効か期限切れです。`/meetupper init` を実行し直してください。",
      );
      return;
    }
    dropUiSession(session.id);
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription("セットアップをキャンセルしました。")],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, error);
  }
});
