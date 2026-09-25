import { executeCommand } from "./program.js";
import { applyCreditsLowToSuccess, observedCreditsRemaining } from "./credits.js";
import { errorEnvelope, type Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { LOG_SINK_DEGRADED_CODE, logSinkDegradedWarning } from "./log/logger.js";
import { CliError, makeProblem, renderProblem } from "./problems.js";
import { redactText } from "./redact.js";
import type { CliRuntime } from "./runtime.js";
import { processRuntime } from "./runtime.js";

function appendLogSinkWarning(warnings: Warning[], dropped: number): Warning[] {
  const warning = logSinkDegradedWarning(dropped);
  if (!warning || warnings.some((item) => item.code === LOG_SINK_DEGRADED_CODE)) {
    return warnings;
  }
  return [...warnings, warning];
}

function applyLogSinkToSuccess<T extends { envelope: { warnings: Warning[] }; human: string }>(result: T, dropped: number): T {
  const warnings = appendLogSinkWarning(result.envelope.warnings, dropped);
  if (warnings === result.envelope.warnings) {
    return result;
  }
  const warning = warnings[warnings.length - 1];
  const line = warning ? `warning: ${warning.message}` : "";
  const human = !result.human || !line || result.human.includes(line) ? result.human : `${result.human}\n${line}`;
  return { ...result, envelope: { ...result.envelope, warnings }, human };
}

/** Resolve only once the stream has accepted and flushed this write; reject on any stream error. */
function confirmedWrite(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => reject(error);
    stream.once("error", onError);
    try {
      stream.write(text, (error?: Error | null) => {
        stream.removeListener("error", onError);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      stream.removeListener("error", onError);
      reject(error);
    }
  });
}

export async function run(runtime: CliRuntime = processRuntime()): Promise<number> {
  // Only switches before the end-of-options marker select presentation.
  const end = runtime.argv.indexOf("--");
  const options = end < 0 ? runtime.argv : runtime.argv.slice(0, end);
  const explicitJson = options.includes("--json");
  const json = explicitJson || !options.includes("--human");
  try {
    const dispatched = applyCreditsLowToSuccess(await executeCommand(runtime.argv, runtime), observedCreditsRemaining(runtime));
    runtime.logger?.endRun();
    const result = applyLogSinkToSuccess(dispatched, runtime.logger?.droppedLines() ?? 0);
    if (result.output === "stream") {
      return result.exitCode;
    }
    const text = json && (result.output !== "help" || explicitJson)
      ? `${JSON.stringify(result.envelope)}\n`
      : result.human ? `${result.human}\n` : "";
    if (result.afterOutput) {
      // The answer carries something only a replay can return (a webhook
      // signing secret). Keep the saved write key unless stdout accepted it.
      try {
        await confirmedWrite(runtime.stdout, text);
      } catch {
        try {
          runtime.stderr.write("error: the answer could not be written to stdout. The saved write key is kept; rerun the identical command within 24 hours to receive the same answer again.\n");
        } catch {
          // stderr may be gone too; the exit code still reports the failure.
        }
        return ExitCode.Unexpected;
      }
      try {
        await result.afterOutput();
      } catch {
        // A lingering key is safe: a rerun replays the same answer. See recovery list.
      }
      return result.exitCode;
    }
    if (text) runtime.stdout.write(text);
    return result.exitCode;
  } catch (err) {
    runtime.logger?.endRun(err);
    const problem =
      err instanceof CliError
        ? err.problem
        : makeProblem(
            "unexpected_error",
            "Unexpected error",
            500,
            redactText(err instanceof Error ? err.message : "unknown error"),
          );
    const exitCode = err instanceof CliError ? err.exitCode : ExitCode.Unexpected;
    const warnings = appendLogSinkWarning(err instanceof CliError ? err.warnings : [], runtime.logger?.droppedLines() ?? 0);
    if (json) {
      runtime.stdout.write(`${JSON.stringify(errorEnvelope(problem, { warnings }))}\n`);
    } else {
      runtime.stderr.write(`${renderProblem(problem)}\n`);
      for (const warning of warnings) {
        runtime.stderr.write(`warning: ${warning.message}\n`);
      }
    }
    return exitCode;
  } finally {
    const logger = runtime.logger;
    if (logger) {
      try {
        await logger.close();
      } catch {
        // Socket close is best-effort after the command envelope is written.
      }
    }
  }
}

export { processRuntime };
export type { CliRuntime } from "./runtime.js";
