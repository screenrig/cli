import { normalizeRevisionArgs } from "./command-input.js";
import { type Command, CommanderError } from "commander";
import { commandFromArgv, commandPath, createCommandTree } from "./command-tree.js";
import { CliError } from "./problems.js";
import { handleVersion, type CommandResult } from "./commands.js";
import { describeHelp } from "./help.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import type { CliRuntime } from "./runtime.js";

/**
 * A usage error names what is wrong; point it at the help of the command that
 * was actually invoked so the caller can see the accepted arguments and a
 * working example. Guidance already on the problem is kept.
 */
function withUsageHelp(error: unknown, command: Command): unknown {
  if (!(error instanceof CliError) || error.problem.code !== "usage_error") return error;
  if (error.problem.hint && error.problem.next) return error;
  const path = commandPath(command);
  const help = ["screenrig", ...path, "--help"].join(" ");
  return new CliError({
    ...error.problem,
    hint: error.problem.hint ?? `Fix the argument or input named in detail and run the command again. ${help} lists the accepted arguments and values, with an example.`,
    next: error.problem.next ?? { command: help, argv: [...path, "--help"], reason: "Lists this command's arguments, accepted values, and a working example." },
  }, error.exitCode, error.warnings);
}

/** Run one native Commander action and return its result to the output boundary. */
export async function executeCommand(argv: string[], runtime: CliRuntime): Promise<CommandResult> {
  let result: CommandResult | undefined;
  argv = normalizeRevisionArgs(argv);
  const tree = createCommandTree(argv, async (handler, args) => {
    result = await handler(args, runtime);
  });
  try {
    await tree.root.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError) || !(tree.helpRequested() || tree.versionRequested())) {
      throw withUsageHelp(error, tree.selected() !== tree.root ? tree.selected() : commandFromArgv(tree.root, argv));
    }
  }
  if (tree.helpRequested()) {
    const help = describeHelp(tree.selected(), tree.inventoryRequested());
    return { envelope: successEnvelope(help), exitCode: ExitCode.Success, human: help.usage, output: "help" };
  }
  if (tree.versionRequested()) return handleVersion({ command: ["version"], positionals: ["version"], flags: {} }, runtime);
  if (!result) throw new Error("Command completed without a result.");
  return result;
}
