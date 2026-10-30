import { Command } from "commander";
import { registerGlobalOptions } from "./globals.js";
import type { CommandActionBinder } from "./types.js";

export type CommandRegistrar = (root: Command, bind: CommandActionBinder) => void;

/** Each bundle registers a group of top-level commands; it loads only when an invocation needs it. */
export const COMMAND_BUNDLES = {
  account: () => import("../bundles/account.js"),
  ads: () => import("../bundles/ads.js"),
  media: () => import("../bundles/media.js"),
  playlists: () => import("../bundles/playlists.js"),
  screens: () => import("../bundles/screens.js"),
  monitoring: () => import("../bundles/monitoring.js"),
  integrations: () => import("../bundles/integrations.js"),
  migrate: () => import("../bundles/migrate.js"),
} satisfies Record<string, () => Promise<{ register: CommandRegistrar }>>;

export type CommandBundle = keyof typeof COMMAND_BUNDLES;

/** Every top-level command and the bundle that registers it, in help order. */
export const TOP_LEVEL_COMMANDS: Record<string, CommandBundle> = {
  project: "account",
  organization: "account",
  invitations: "account",
  ads: "ads",
  billing: "account",
  login: "account",
  logout: "account",
  agent: "account",
  "service-client": "account",
  dashboard: "account",
  app: "media",
  media: "media",
  playlist: "playlists",
  screen: "screens",
  campaign: "ads",
  reviews: "playlists",
  browser: "media",
  "fleet-links": "screens",
  triggers: "monitoring",
  kv: "media",
  cards: "playlists",
  card: "playlists",
  feeds: "playlists",
  source: "media",
  comment: "playlists",
  operations: "monitoring",
  events: "monitoring",
  notes: "account",
  playback: "monitoring",
  webhooks: "integrations",
  notifications: "integrations",
  alerts: "monitoring",
  reports: "integrations",
  bi: "integrations",
  audit: "integrations",
  feedback: "account",
  support: "account",
  doctor: "account",
  version: "account",
  status: "account",
  recovery: "account",
  migrate: "migrate",
  schedule: "playlists",
};

/** Root options that take a value, so their values are not read as a command name. */
function valueOptions(): Set<string> {
  const probe = new Command();
  registerGlobalOptions(probe);
  return new Set(probe.options.filter((option) => option.required || option.optional).map((option) => option.long!));
}

/**
 * The bundles an invocation needs: the one that registers its top-level command,
 * or every bundle for help, a bare invocation and an unknown command.
 */
export function commandBundlesFor(argv: readonly string[]): CommandBundle[] {
  const end = argv.indexOf("--");
  const tokens = end < 0 ? argv : argv.slice(0, end);
  const takesValue = valueOptions();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (takesValue.has(token)) { index += 1; continue; }
    if (token.startsWith("-")) continue;
    const bundle = TOP_LEVEL_COMMANDS[token];
    return bundle ? [bundle] : (Object.keys(COMMAND_BUNDLES) as CommandBundle[]);
  }
  return Object.keys(COMMAND_BUNDLES) as CommandBundle[];
}

export async function loadCommandRegistrars(argv: readonly string[]): Promise<CommandRegistrar[]> {
  return Promise.all(commandBundlesFor(argv).map(async (bundle) => (await COMMAND_BUNDLES[bundle]()).register));
}

export function registerCommands(root: Command, bind: CommandActionBinder, registrars: readonly CommandRegistrar[]): void {
  registerGlobalOptions(root);
  for (const register of registrars) register(root, bind);
  const order = Object.keys(TOP_LEVEL_COMMANDS);
  (root.commands as Command[]).sort((left, right) => order.indexOf(left.name()) - order.indexOf(right.name()));
}
