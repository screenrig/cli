import type { CommandHandler } from "../commands.js";

export type CommandActionBinder = (handler: CommandHandler) => (...args: unknown[]) => void | Promise<void>;
