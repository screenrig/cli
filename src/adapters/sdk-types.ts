import { readAsset } from "../assets.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem } from "../problems.js";

/** The declaration file `app types` writes: the types of `window.screenrig`. */
export const SDK_TYPES_FILE = "screenrig.d.ts";

/**
 * The declaration file packaged beside the browser runtime it describes, so the
 * types always match the runtime `app pack` and `app upload` inject.
 */
export function readSdkTypes(): Buffer {
  try {
    return readAsset("screenrig.d.ts");
  } catch {
    throw new CliError(
      makeProblem("sdk_types_missing", "SDK types unavailable", 500, "The packaged SDK declaration file is missing at assets/screenrig.d.ts; reinstall the ScreenRig CLI from a verified release.", {
        hint: "Nothing was written.",
      }),
      ExitCode.Unexpected,
    );
  }
}
