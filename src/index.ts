import { Client, Events, GatewayIntentBits, SlashCommandBuilder, type Guild } from "discord.js";
import { config } from "./config.ts";
import { replyEphemeral, replyError } from "./core/discord.ts";
import { findButton, findModal, findSelectMenu, getSubcommands, runSetups } from "./core/registry.ts";
import { loadFeatures } from "./features/index.ts";

if (!config.token) {
  console.error("DISCORD_TOKEN が設定されていません。.env.example を参考に .env を作成してください。");
  process.exit(1);
}

await loadFeatures();

const meetupCommand = new SlashCommandBuilder()
  .setName("meetupper")
  .setDescription("MeetUpの作成・参加・運営を行います")
  .setDMPermission(false);
for (const entry of getSubcommands()) meetupCommand.addSubcommand(entry.builder);
const commandJson = meetupCommand.toJSON();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerGuildCommands(guild: Guild): Promise<void> {
  await guild.commands.set([commandJson]);
  console.log(`スラッシュコマンド /meetupper を登録しました: ${guild.name} (${guild.id})`);
}

// Register listeners (channel-delete recovery, reminder timer) before the gateway connects.
await runSetups(client);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  // Remove global commands left by older versions; commands are registered per joined guild.
  await readyClient.application?.commands.set([]).catch(() => undefined);
  for (const guild of readyClient.guilds.cache.values()) {
    await registerGuildCommands(guild).catch((error) =>
      console.error(`スラッシュコマンドの登録に失敗しました: ${guild.id}`, error),
    );
  }
});

client.on(Events.GuildCreate, async (guild) => {
  await registerGuildCommands(guild).catch((error) =>
    console.error(`スラッシュコマンドの登録に失敗しました: ${guild.id}`, error),
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "meetupper") return;
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
      if (!routed) {
        await replyEphemeral(interaction, "この操作は現在利用できません。");
        return;
      }
      await routed.handler(interaction, routed.args);
      return;
    }
    if (interaction.isModalSubmit()) {
      const routed = findModal(interaction.customId);
      if (!routed) {
        await replyEphemeral(interaction, "この操作は現在利用できません。");
        return;
      }
      await routed.handler(interaction, routed.args);
      return;
    }
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      const routed = findSelectMenu(interaction.customId);
      if (!routed) {
        await replyEphemeral(interaction, "この操作は現在利用できません。");
        return;
      }
      await routed.handler(interaction, routed.args);
    }
  } catch (error) {
    if (interaction.isRepliable()) await replyError(interaction, error);
  }
});

await client.login(config.token);
