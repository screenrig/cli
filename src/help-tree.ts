// Help for the whole command tree, every bundle and its guidance loaded. The
// CLI renders help from the tree of each invocation (program.ts).
import { ALL_COMMAND_REGISTRARS } from "./cli-commands/all.js";
import { registerGuidance } from "./cli-commands/register-guidance.js";
import { createCommandTree, findCommand } from "./command-tree.js";
import { describeHelp, type HelpDocument } from "./help.js";
import { usageError } from "./problems.js";

export function commandHelp(path: readonly string[] = [], all = false): HelpDocument {
  const root = createCommandTree([], undefined, ALL_COMMAND_REGISTRARS).root;
  registerGuidance(root);
  const command = findCommand(root, path);
  if (!command) throw usageError("Unknown help topic.");
  return describeHelp(command, all);
}
