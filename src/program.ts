import { CommanderError } from "commander";
import { createCommandTree } from "./command-tree.js";
import { handleVersion, type CommandResult } from "./commands.js";
import { describeHelp } from "./help.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import type { CliRuntime } from "./runtime.js";

/** Run one native Commander action and return its result to the output boundary. */
export async function executeCommand(argv: string[], runtime: CliRuntime): Promise<CommandResult> {
  let result: CommandResult | undefined;
  const tree = createCommandTree(argv, async (handler, args) => {
    result = await handler(args, runtime);
  });
  try {
    await tree.root.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError) || !(tree.helpRequested() || tree.versionRequested())) throw error;
  }
  if (tree.helpRequested()) {
    const help = describeHelp(tree.selected());
    return { envelope: successEnvelope(help), exitCode: ExitCode.Success, human: help.usage, output: "help" };
  }
  if (tree.versionRequested()) return handleVersion({ command: ["version"], positionals: ["version"], flags: {} }, runtime);
  if (!result) throw new Error("Command completed without a result.");
  return result;
}
