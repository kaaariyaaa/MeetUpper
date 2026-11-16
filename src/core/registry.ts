import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  SlashCommandSubcommandBuilder,
} from "discord.js";

export type SubcommandExecute = (interaction: ChatInputCommandInteraction) => Promise<unknown>;
export type ButtonExecute = (interaction: ButtonInteraction, args: string[]) => Promise<unknown>;
export type ModalExecute = (interaction: ModalSubmitInteraction, args: string[]) => Promise<unknown>;
export type Setup = (client: Client) => void | Promise<void>;

interface SubcommandEntry {
  name: string;
  builder: SlashCommandSubcommandBuilder;
  execute: SubcommandExecute;
}

interface RoutedHandler<T> {
  pattern: RegExp;
  execute: T;
}

const subcommands = new Map<string, SubcommandEntry>();
const buttonHandlers: RoutedHandler<ButtonExecute>[] = [];
const modalHandlers: RoutedHandler<ModalExecute>[] = [];
const setups: Setup[] = [];

export function subcommand(builder: SlashCommandSubcommandBuilder, execute: SubcommandExecute): void {
  if (subcommands.has(builder.name)) throw new Error(`Duplicate subcommand: ${builder.name}`);
  subcommands.set(builder.name, { name: builder.name, builder, execute });
}

export function button(pattern: RegExp, execute: ButtonExecute): void {
  buttonHandlers.push({ pattern, execute });
}

export function modal(pattern: RegExp, execute: ModalExecute): void {
  modalHandlers.push({ pattern, execute });
}

export function setup(fn: Setup): void {
  setups.push(fn);
}

export function getSubcommands(): SubcommandEntry[] {
  return [...subcommands.values()];
}

export function findButton(customId: string):
  | { handler: ButtonExecute; args: string[] }
  | undefined {
  for (const entry of buttonHandlers) {
    const match = customId.match(entry.pattern);
    if (match) return { handler: entry.execute, args: match.slice(1) };
  }
  return undefined;
}

export function findModal(customId: string):
  | { handler: ModalExecute; args: string[] }
  | undefined {
  for (const entry of modalHandlers) {
    const match = customId.match(entry.pattern);
    if (match) return { handler: entry.execute, args: match.slice(1) };
  }
  return undefined;
}

export async function runSetups(client: Client): Promise<void> {
  for (const fn of setups) await fn(client);
}
