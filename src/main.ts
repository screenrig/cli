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

export async function run(runtime: CliRuntime = processRuntime()): Promise<number> {
  const json = runtime.argv.includes("--json");
  try {
    const dispatched = applyCreditsLowToSuccess(await executeCommand(runtime.argv, runtime), observedCreditsRemaining(runtime));
    runtime.logger?.endRun();
    const result = applyLogSinkToSuccess(dispatched, runtime.logger?.droppedLines() ?? 0);
    if (json) {
      if (result.human) {
        runtime.stdout.write(`${JSON.stringify(result.envelope)}\n`);
      }
    } else if (result.human) {
      runtime.stdout.write(`${result.human}\n`);
    }
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
