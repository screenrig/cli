// Command handlers for the browser commands, loaded on demand.
import { apexHost } from "../apex-origin.js";
import { type BrowserLinkClaim, type BrowserLinkClaimRequest } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { resolveConfig } from "../config.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { isPlayerScreenPath } from "../provisioning-url.js";
import { browserHandoffUrl, browserSetupRetryState, clearBrowserSetupRetryState, normalizeBrowserSetupCode } from "../browser-setup.js";
import { clientFor, commandHandler, humanLines, requirePrivateNoStore, type CommandResult } from "../commands.js";


export const handleBrowserSetup = commandHandler(browserSetupCommand);

export async function browserSetupCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const rawCode = flagString(args.flags, "code");
  if (!rawCode) throw usageError("browser setup requires --code CODE.");
  const code = normalizeBrowserSetupCode(rawCode);
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const retryRuntime = {
    fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
    now: runtime.now,
    sleep: runtime.sleep,
  };
  const retry = await browserSetupRetryState({
    resolved,
    runtime: retryRuntime,
    code: code.canonical,
    ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
  });
  const request: BrowserLinkClaimRequest = { code: code.canonical };
  const response = await client.call({
    method: "POST",
    path: "/api/project/browser-links/claim",
    idempotent: true,
    idempotencyKey: retry.idempotency_key,
    body: request,
  }).catch(async (error: unknown) => {
    if (error instanceof CliError && (
      (error.problem.status === 404 && error.problem.code === "handoff_code_invalid") ||
      (error.problem.status === 410 && error.problem.code === "handoff_code_expired")
    )) {
      // These refusals create no screen. Uncertain outcomes still need the saved exact retry.
      await clearBrowserSetupRetryState(resolved, retryRuntime, retry.idempotency_key);
    }
    throw error;
  });
  requirePrivateNoStore(response.headers, "Browser setup claim response");
  const claim = response.body as BrowserLinkClaim;
  const screen = claim.screen;
  if (!claim.session_id || claim.status !== "claimed" || !screen?.id || !screen.public_id || screen.state !== "pairing_pending" || !screen.public_url) {
    throw unexpectedResponseError("Browser setup response does not match the generated BrowserLinkClaim contract.", client.requestId,
      "The server may have claimed the code. Run screenrig screen list to find the screen before claiming again.");
  }
  // The claim is done whatever the URL check says: report it, and withhold only an unsafe URL.
  const withheld = playerPublicUrlProblem(resolved.apiUrl, screen.public_url, screen.public_id);
  const opened = flagBool(args.flags, "open")
    ? await (runtime.openUrl?.(browserHandoffUrl(resolved.apiUrl, code.display)) ?? Promise.resolve(false))
    : undefined;
  await clearBrowserSetupRetryState(resolved, retryRuntime, retry.idempotency_key);
  const playerPublicUrl = withheld ? undefined : new URL(screen.public_url).href;
  const data = {
    code: code.display,
    status: claim.status,
    screen_id: screen.id,
    ...(playerPublicUrl ? { player_public_url: playerPublicUrl } : { url_withheld: withheld }),
    ...(opened !== undefined ? { opened } : {}),
  };
  const warnings = withheld ? [{ code: "player_url_withheld", message: `The browser setup was claimed, but its Player public URL is not shown: ${withheld}` }] : [];
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: humanLines("Browser setup claimed", [
      ["code", code.display],
      ["status", claim.status],
      ["screen_id", screen.id],
      ["player_public_url", playerPublicUrl],
      ["url_withheld", withheld],
      ...(opened !== undefined ? [["opened", opened ? "true" : "false"] as [string, string]] : []),
    ]),
  };
}

/** Why a claimed screen's Player public URL is not safe to show, or undefined when it is. */
export function playerPublicUrlProblem(apiUrl: string, value: string, publicId: string): string | undefined {
  const api = new URL(apiUrl);
  const apex = apexHost(api.hostname);
  let url: URL;
  try { url = new URL(value); } catch { return "public_url is not a valid URL."; }
  if (!apex || url.origin !== `https://play.${apex}${api.port ? `:${api.port}` : ""}`) return "public_url is not this API's Player origin.";
  if (url.username || url.password || url.hash || url.search) return "public_url carries credentials, a query or a fragment.";
  if (!isPlayerScreenPath(url.pathname, publicId)) return "public_url does not name this screen's Player path (/s/PUBLIC_ID).";
  return undefined;
}
