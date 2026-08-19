import { parseArgv } from "./argv.js";
import { dispatch } from "./commands.js";
import { applyCreditsLowToSuccess, observedCreditsRemaining } from "./credits.js";
import { errorEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, makeProblem, renderProblem } from "./problems.js";
import { redactText } from "./redact.js";
import type { CliRuntime } from "./runtime.js";
import { processRuntime } from "./runtime.js";

export async function run(runtime: CliRuntime = processRuntime()): Promise<number> {
  const json = runtime.argv.includes("--json");
  try {
    const args = parseArgv(runtime.argv);
    const result = applyCreditsLowToSuccess(await dispatch(args, runtime), observedCreditsRemaining(runtime));
    if (json || args.flags.json === true) {
      if (result.human) {
        runtime.stdout.write(`${JSON.stringify(result.envelope)}\n`);
      }
    } else if (result.human) {
      runtime.stdout.write(`${result.human}\n`);
    }
    return result.exitCode;
  } catch (err) {
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
    const warnings = err instanceof CliError ? err.warnings : [];
    if (json) {
      runtime.stdout.write(`${JSON.stringify(errorEnvelope(problem, { warnings }))}\n`);
    } else {
      runtime.stderr.write(`${renderProblem(problem)}\n`);
      for (const warning of warnings) {
        runtime.stderr.write(`warning: ${warning.message}\n`);
      }
    }
    return exitCode;
  }
}

export { processRuntime };
export type { CliRuntime } from "./runtime.js";
