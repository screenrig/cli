import type { Command } from "commander";
import type { CommandActionBinder } from "./types.js";
import type { CommandHandler } from "../commands.js";
import { resolveConfig } from "../config.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { manageWriteRecovery } from "../write-recovery.js";

const guidance = "Inspect the remote outcome before reconciling. Reconcile removes local retry protection only; it does not retry, cancel, or undo the remote write. A subsequent invocation can create a new write.";

function handler(action: "list" | "show" | "reconcile"): CommandHandler {
  return async (args, runtime) => {
    const resolved = await resolveConfig({ flags: args.flags, fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir } });
    const entries = await manageWriteRecovery(resolved, runtime, action, args.positionals[2]);
    const data = action === "list" ? { entries, guidance }
      : action === "show" ? { entry: entries[0], guidance }
      : { entry: entries[0], reconciled: true, remote_changed: false, guidance };
    return {
      envelope: successEnvelope(data), exitCode: ExitCode.Success,
      human: [action === "reconcile" ? "Recovery entry reconciled locally" : "Pending write recovery",
        ...entries.map(entry => `${entry.id} | ${entry.command ?? "unknown command (legacy entry)"} | ${entry.created_at} | ${entry.replay_status}`),
        ...(entries.length ? [] : ["No pending writes"]), guidance].join("\n"),
    };
  };
}

export function registerRecoveryCommands(root: Command, bind: CommandActionBinder): void {
  const recovery = root.command("recovery").description("Inspect and reconcile local ordinary-write recovery state");
  recovery.command("list").description("List safe recovery metadata without sending requests")
    .action(bind(handler("list")));
  recovery.command("show").description("Inspect one pending write; legacy entries have no command metadata")
    .argument("<id>", "Recovery identifier from recovery list")
    .action(bind(handler("show")));
  recovery.command("reconcile").description("Remove local retry protection after verifying the remote outcome; does not undo the write")
    .argument("<id>", "Recovery identifier from recovery list")
    .action(bind(handler("reconcile")));
}
