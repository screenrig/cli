import type { ParsedArgs } from "../argv.js";
import type { ResolvedConfig } from "../config.js";
import { fetchSignedRawPut, type CliRuntime } from "../runtime.js";
import { commandWords, createSinkLogger, loggingSignedRawPut, noopLogger } from "./logger.js";
import { connectUnixLogSocket } from "./socket.js";
import type { OperationLogger } from "./types.js";

function bindLogger(runtime: CliRuntime, logger: OperationLogger): void {
  runtime.logger = logger;
  runtime.fs = { ...runtime.fs, logger };
  if (logger.enabled) {
    runtime.signedRawPut = loggingSignedRawPut(runtime.signedRawPut ?? fetchSignedRawPut(), logger);
  }
  logger.beginRun();
}

export async function attachOperationLogger(
  runtime: CliRuntime,
  args: ParsedArgs,
  resolved: ResolvedConfig,
): Promise<void> {
  const command = commandWords(args.positionals);
  if (runtime.logger) {
    runtime.logger.setCommand(command);
    bindLogger(runtime, runtime.logger);
    return;
  }
  const socketPath = resolved.logSocket;
  if (!socketPath) {
    runtime.logger = noopLogger;
    return;
  }
  const sink = await connectUnixLogSocket(socketPath);
  const logger = createSinkLogger({
    sink,
    command,
    now: runtime.now,
  });
  bindLogger(runtime, logger);
}
