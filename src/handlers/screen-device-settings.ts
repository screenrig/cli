// Command handlers for screen display-idle, brightness and kiosk-lock, loaded on demand.
import type { ParsedArgs } from "../command-input.js";
import { flagBool, flagString } from "../command-input.js";
import { requireToken } from "../client.js";
import { clientFor, commandHandler, jsonBody, type CommandResult, type ResolvedCommandConfig } from "../commands.js";
import { ExitCode } from "../exit-codes.js";
import { quotedRevision } from "../if-match.js";
import { usageError } from "../problems.js";
import { playlistAnswerWarnings, withoutAnswerWarnings } from "../playlist-warnings.js";
import type { CliRuntime } from "../runtime.js";
import type { Screen, ScreenPatch } from "../adapters/protocol.js";
import { brightnessPatch, displayIdlePatch, displayIdleText, kioskLockPatch } from "../screen-device-settings.js";

/**
 * One ScreenPatch carrying only the device setting asked for: a member left
 * out stays as it is, so the other display member and every other screen
 * field are untouched. The server owns the range and type checks.
 */
async function patchDeviceSetting(
  args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, command: string, patch: ScreenPatch, title: (id: string) => string,
): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError(`${command} requires <id>.`);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const ifMatch = flagString(args.flags, "expect-rev");
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${encodeURIComponent(id)}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
    body: patch,
  });
  const revision = (response.body as Screen | undefined)?.revision;
  const lifted = playlistAnswerWarnings(response.body);
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, client.requestId, undefined, lifted),
    exitCode: ExitCode.Success,
    human: [title(id), ...(revision !== undefined ? [`revision: ${revision}`] : []), ...lifted.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}

export const handleScreenDisplayIdle = commandHandler(async (args, runtime, resolved) => {
  const patch = displayIdlePatch(flagString(args.flags, "after"), flagString(args.flags, "wake"), flagBool(args.flags, "off"));
  const idle = patch.display?.idle;
  return patchDeviceSetting(args, runtime, resolved, "screen display-idle", patch,
    (id) => (idle ? `Set display idle on ${id}: ${displayIdleText(idle)}` : `Turned off display idle on ${id}`));
}, true);

export const handleScreenBrightness = commandHandler(async (args, runtime, resolved) => {
  const patch = brightnessPatch(flagString(args.flags, "mode"));
  return patchDeviceSetting(args, runtime, resolved, "screen brightness", patch, (id) => `Set display brightness on ${id}: ${patch.display?.brightness?.mode}`);
}, true);

export const handleScreenKioskLock = commandHandler(async (args, runtime, resolved) => {
  const patch = kioskLockPatch(flagBool(args.flags, "on"), flagBool(args.flags, "off"));
  return patchDeviceSetting(args, runtime, resolved, "screen kiosk-lock", patch,
    (id) => (patch.kiosk?.lock ? `Locked kiosk on ${id}: the Player pins itself to the screen` : `Released the kiosk lock on ${id}`));
}, true);
