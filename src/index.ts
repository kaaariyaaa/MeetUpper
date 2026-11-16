import { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.ts";
import { ensureLayout, replyError } from "./core/discord.ts";
import { findButton, findModal, getSubcommands, runSetups } from "./core/registry.ts";
import { loadFeatures } from "./features/index.ts";

if (!config.token) {
  console.error("DISCORD_TOKEN が設定されていません。.env.example を参考に .env を作成してください。");
  process.exit(1);
}

await loadFeatures();

const meetupCommand = new SlashCommandBuilder()
  .setName("meetup")
  .setDescription("オフ会の作成・参加・運営を行います")
  .setDMPermission(false);
for (const entry of getSubcommands()) meetupCommand.addSubcommand(entry.builder);
const commandJson = meetupCommand.toJSON();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  try {
    const rest = new REST().setToken(config.token);
    const route = config.guildId
      ? Routes.applicationGuildCommands(readyClient.user.id, config.guildId)
      : Routes.applicationCommands(readyClient.user.id);
    await rest.put(route, { body: [commandJson] });
    console.log(`スラッシュコマンド /meetup を登録しました (${config.guildId ? "guild" : "global"})`);
  } catch (error) {
    console.error("スラッシュコマンドの登録に失敗しました", error);
  }

  for (const guild of readyClient.guilds.cache.values()) {
    await ensureLayout(guild).catch((error) => console.error(`レイアウト初期化失敗: ${guild.id}`, error));
  }
  await runSetups(readyClient);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "meetup") return;
      const name = interaction.options.getSubcommand(false);
      const entry = name ? getSubcommands().find((item) => item.name === name) : undefined;
      if (!entry) {
        await replyError(interaction, new Error("不明なサブコマンドです"));
        return;
      }
      await entry.execute(interaction);
      return;
    }
    if (interaction.isButton()) {
      const routed = findButton(interaction.customId);
      if (!routed) return;
      await routed.handler(interaction, routed.args);
      return;
    }
    if (interaction.isModalSubmit()) {
      const routed = findModal(interaction.customId);
      if (!routed) return;
      await routed.handler(interaction, routed.args);
    }
  } catch (error) {
    if (interaction.isRepliable()) await replyError(interaction, error);
  }
});

await client.login(config.token);
