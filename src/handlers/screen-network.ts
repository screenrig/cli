// Command handlers for screen network set and screen network show, loaded on demand.
import { readWebPassword } from "../bi-web.js";
import { requireToken } from "../client.js";
import { clientFor, commandHandler, humanLines, jsonBody } from "../commands.js";
import { flagBool, flagString } from "../command-input.js";
import { ExitCode } from "../exit-codes.js";
import { quotedRevision } from "../if-match.js";
import { usageError } from "../problems.js";
import { instant } from "../screen-commands.js";
import { latestNetworkCommand, networkChangeText, networkProblem, networkShowLines, networkWrite, wifiPasswordChecked, type NetworkFlags } from "../screen-network.js";
import type { Screen, ScreenNetworkAccepted } from "../adapters/protocol.js";

export const handleScreenNetworkSet = commandHandler(async (args, runtime, resolved) => {
  // positionals are [screen, network, set, ID]: one screen, never a fleet.
  const id = args.positionals[3];
  if (!id) throw usageError("screen network set requires <id>.");
  const file = flagString(args.flags, "password-file");
  const flags: NetworkFlags = {
    wifi: flagString(args.flags, "wifi"),
    hidden: flagBool(args.flags, "hidden"),
    ethernet: flagBool(args.flags, "ethernet"),
    dhcp: flagBool(args.flags, "dhcp"),
    address: flagString(args.flags, "address"),
    gateway: flagString(args.flags, "gateway"),
    dns: flagString(args.flags, "dns"),
    rollbackAfter: flagString(args.flags, "rollback-after"),
    expiresIn: flagString(args.flags, "expires-in"),
  };
  // Everything that can be refused locally is refused before the file or stdin is read.
  networkWrite(flags);
  const body = networkWrite(file === undefined ? flags : { ...flags, secret: wifiPasswordChecked(await readWebPassword(file, runtime), file === "-" ? "stdin" : file) });
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/network`, idempotent: true, body,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw networkProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenNetworkAccepted>;
  if (typeof accepted.command_id !== "string" || !/^cmd_[A-Za-z0-9_-]{8,64}$/.test(accepted.command_id) || accepted.command !== "network"
    || instant(accepted.expires_at) === undefined || (accepted.state !== "queued" && accepted.state !== "sent")) {
    throw usageError("Screen network response does not match the generated ScreenMaintenanceAccepted contract.");
  }
  const rollback = body.rollback_after_s ?? 180;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Network change accepted", [["screen_id", id], ["command_id", accepted.command_id], ["state", accepted.state], ["expires_at", accepted.expires_at], ["change", networkChangeText(body)]]),
      accepted.state === "queued"
        ? `The screen is offline, so the change waits: it is sent when the screen comes online before expires_at. Cancel it with screen command cancel ${id} ${accepted.command_id}.`
        : `The Player applies it now and keeps it only if the screen reaches screenRIG again within ${rollback} s; otherwise it restores its previous settings by itself.`,
      `screen network show ${id} reports the result.`,
    ].join("\n"),
  };
}, true);

export const handleScreenNetworkShow = commandHandler(async (args, runtime, resolved) => {
  // positionals are [screen, network, show, ID].
  const id = args.positionals[3];
  if (!id) throw usageError("screen network show requires <id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` });
  const screen = response.body as Screen | undefined;
  const network = screen?.health?.network ?? null;
  const change = latestNetworkCommand(screen) ?? null;
  return {
    envelope: jsonBody({ ...response, body: { network, change } }, client.requestId),
    exitCode: ExitCode.Success,
    human: networkShowLines(id, network ?? undefined, change ?? undefined).join("\n"),
  };
}, true);
