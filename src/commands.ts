import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  limitsFromCapabilities,
  type AccountEvent,
  type Capabilities,
  type CLIEnrollment,
  type CLIEnrollmentRequest,
  type EventPage,
  type FeedbackContext,
  type FeedbackKind,
  type FeedbackList,
  type FeedbackSubmission,
  type FeedbackWrite,
  type KVEntry,
  type Operation,
  type OperationAccepted,
  type PairScreen,
  type PairingClaim,
  type BrowserLinkClaim,
  type BrowserLinkClaimRequest,
  type ProvisionScreen,
  type ScreenProvisioning,
} from "./adapters/protocol.js";
import { SDK_PROTOCOL_VERSION } from "./adapters/sdk-injection.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./argv.js";
import { ApiClient, requireToken } from "./client.js";
import {
  resolveConfig,
  describeToken,
  readConfigFile,
  withConfigLock,
  writeConfigAtomic,
} from "./config.js";
import { ensureCredential } from "./enrollment.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, configError, usageError } from "./problems.js";
import { packDirectory } from "./pack/index.js";
import type { CliRuntime } from "./runtime.js";
import { FetchTransport } from "./transport/http.js";
import type { Transport } from "./transport/types.js";
import { parseSse } from "./sse.js";
import { kvWriteFromArgs } from "./kv-write.js";
import { quotedRevision } from "./if-match.js";
import { lowInformationFilenameWarning } from "./media-filename.js";
import {
  deriveCommitIdempotencyKey,
  performSignedMediaPut,
  prepareMediaUpload,
  validateMediaUploadSession,
} from "./media-upload.js";
import { fetchSignedRawPut } from "./runtime.js";
import type { MediaUploadSession } from "./adapters/protocol.js";
import { newIdempotencyKey } from "./ids.js";
import { clearProvisionRetryState, provisionRetryState } from "./provisioning-state.js";
import { validateProvisioningUrls } from "./provisioning-url.js";
import {
  browserHandoffUrl,
  browserSetupRetryState,
  clearBrowserSetupRetryState,
  normalizeBrowserSetupCode,
} from "./browser-setup.js";
import { redactText } from "./redact.js";
import { ffmpegLookup, resolveFfmpegToolchain } from "./media/ffmpeg.js";
import { createProgressReporter, silentProgressReporter, type ProgressReporter } from "./media/progress.js";
import {
  DEFAULT_CODEC,
  DEFAULT_MAX_FPS,
  DEFAULT_WEBP_QUALITY,
  MAX_EDGE,
  transcodeForUpload,
  type TranscodeCodec,
  type TranscodeOptions,
  type TranscodeResult,
} from "./media/transcode.js";

export const CLI_VERSION = "0.1.0";

export const USAGE = `screenrig — ScreenRig localhost v1 control-plane CLI

Usage:
  screenrig [--json] [--api-url URL] [--config PATH]
            [--request-id ID] [--idempotency-key KEY] [--timeout MS]
            <command> [args]

Commands:
  account show
  auth status
  auth revoke --yes
  app pack <directory> [--output FILE]
  app upload <directory>
  app list
  app show <id>
  media upload <file> [--content-type TYPE] [--no-wait]
                      [--no-transcode] [--codec h264|hevc] [--max-fps N]
                      [--max-edge PIXELS] [--webp-quality 1-100] [--no-progress]
  media show <id>
  media list
  media delete <id> --if-match REVISION
  playlist create <file>
  playlist update <id> <file> --if-match REVISION
  playlist show <id>
  playlist list
  playlist delete <id> --if-match REVISION
  screen pair CODE [--label LABEL]
  screen provision (--open | --print-url) [--label LABEL]
  browser setup --code CODE [--open]
  screen update <id> [--name NAME] [--playlist-id ID] --if-match REVISION
  screen list
  screen show <id>
  screen assign <id> --playlist-id ID --if-match REVISION
  screen delete <id> --if-match REVISION
  screen rotate-public-id <id> --if-match REVISION
  screen revoke-credential <id> --if-match REVISION
  kv get --application-id ID <key>
  kv set --application-id ID <key> --json-value JSON [--if-match REVISION]
  kv set --application-id ID <key> --file FILE --content-type TYPE
  kv set --application-id ID <key> --value-base64 BASE64 --content-type TYPE
  kv delete --application-id ID <key> --if-match REVISION
  kv list --application-id ID
  operations get <id>
  operations wait <id>
  operations cancel <id>
  events list [--after CURSOR]
  events follow [--after CURSOR]
  feedback bug <title> (--body TEXT | --body-file FILE)
                       [--command "GROUP ACTION"] [--no-context]
  feedback feature <title> (--body TEXT | --body-file FILE)
                       [--command "GROUP ACTION"] [--no-context]
  feedback list [--kind bug|feature]
  doctor [--repair-config]
  version
`;

export interface CommandResult {
  envelope: ReturnType<typeof successEnvelope<unknown>>;
  exitCode: ExitCode;
  human: string;
}

function transportFor(runtime: CliRuntime, apiUrl: string, token?: string): Transport {
  return runtime.transport ?? new FetchTransport(apiUrl, token);
}

function clientFor(runtime: CliRuntime, args: ParsedArgs, apiUrl: string, token?: string): ApiClient {
  return new ApiClient({
    transport: transportFor(runtime, apiUrl, token),
    token,
    requestId: flagString(args.flags, "request-id"),
    idempotencyKey: flagString(args.flags, "idempotency-key"),
    timeoutMs: flagNumber(args.flags, "timeout"),
  });
}

function jsonBody(response: { body: unknown; headers: Record<string, string> }, requestId: string, extra?: Record<string, unknown>) {
  const body = (response.body ?? {}) as Record<string, unknown>;
  return successEnvelope(
    extra ? { ...body, ...extra } : body,
    {
      request_id: (body.request_id as string | undefined) ?? response.headers["x-request-id"] ?? requestId,
      operation_id: body.operation_id as string | undefined,
    },
  );
}

function humanLines(title: string, fields: Array<[string, string | undefined]>): string {
  const lines = [title];
  for (const [key, value] of fields) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

export async function dispatch(args: ParsedArgs, runtime: CliRuntime): Promise<CommandResult> {
  const group = args.positionals[0];
  const action = args.positionals[1];
  if (!group || flagBool(args.flags, "help") || group === "help") {
    return {
      envelope: successEnvelope({ usage: USAGE }),
      exitCode: ExitCode.Success,
      human: USAGE,
    };
  }
  if (flagBool(args.flags, "version") || group === "version") {
    return {
      envelope: successEnvelope({ version: CLI_VERSION, protocol_adapter: "screenrig.cli.adapter/0" }),
      exitCode: ExitCode.Success,
      human: `screenrig ${CLI_VERSION}`,
    };
  }

  const repair = flagBool(args.flags, "repair-config");
  let resolved = await resolveConfig({ flags: args.flags, fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }, repair });

  if (group === "doctor") {
    return doctor(args, runtime, resolved);
  }
  if (group === "app" && action === "pack") {
    return appPack(args, runtime);
  }
  if (group === "auth" && action === "revoke") {
    return authRevoke(args, runtime, resolved);
  }
  if (isAuthenticatedCommand(group, action)) {
    resolved = await enrollForCommand(args, runtime, resolved);
  }
  if (group === "account" && action === "show") {
    return accountShow(args, runtime, resolved);
  }
  if (group === "auth" && (action === "status" || action === undefined)) {
    return accountShow(args, runtime, resolved);
  }
  if (group === "app" && action === "upload") {
    return appUpload(args, runtime, resolved);
  }
  if (group === "app" && action === "list") {
    return simpleGet(args, runtime, resolved, "/api/v1/applications", "Applications");
  }
  if (group === "app" && action === "show") {
    const id = args.positionals[2];
    if (!id) throw usageError("app show requires an application id.");
    return simpleGet(args, runtime, resolved, `/api/v1/applications/${id}`, "Application");
  }
  if (group === "media") {
    return mediaCommand(args, runtime, resolved, action);
  }
  if (group === "playlist") {
    return playlistCommand(args, runtime, resolved, action);
  }
  if (group === "screen") {
    return screenCommand(args, runtime, resolved, action);
  }
  if (group === "browser" && action === "setup") {
    return browserSetupCommand(args, runtime, resolved);
  }
  if (group === "kv") {
    return kvCommand(args, runtime, resolved, action);
  }
  if (group === "operations" && action === "get") {
    return operationsGet(args, runtime, resolved);
  }
  if (group === "operations" && action === "wait") {
    return operationsWait(args, runtime, resolved);
  }
  if (group === "operations" && action === "cancel") {
    return operationsCancel(args, runtime, resolved);
  }
  if (group === "events" && action === "list") {
    return eventsList(args, runtime, resolved);
  }
  if (group === "events" && action === "follow") {
    return eventsFollow(args, runtime, resolved);
  }
  if (group === "feedback") {
    return feedbackCommand(args, runtime, resolved, action);
  }
  throw usageError(`Unknown command: ${args.positionals.join(" ")}`, {
    command: "screenrig --help",
    reason: "List implemented commands.",
  });
}

async function authRevoke(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  if (args.positionals.length !== 2) {
    throw usageError("auth revoke does not accept positional arguments.");
  }
  if (!flagBool(args.flags, "yes")) {
    throw usageError(
      "auth revoke requires --yes. The account, screens, and content will remain, but this anonymous account credential cannot be recovered; a later enrollment creates a separate account.",
      {
        command: "screenrig auth revoke --yes",
        reason: "Run only after explicitly accepting permanent loss of CLI access to the current anonymous account.",
      },
    );
  }
  if (!resolved.token) {
    throw usageError("No stored ScreenRig account credential exists; nothing was changed.");
  }

  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  const requestedTimeout = flagNumber(args.flags, "timeout");
  const lockStaleMs = Math.max(60_000, (requestedTimeout && requestedTimeout > 0 ? requestedTimeout : 30_000) + 30_000);
  const result = await withConfigLock(
    resolved.configPath,
    fsLike,
    { sleep: runtime.sleep, now: () => runtime.now().getTime(), staleMs: lockStaleMs },
    async () => {
      const current = await readConfigFile(resolved.configPath, fsLike);
      if (!current?.token || current.token !== resolved.token) {
        throw configError(
          "The stored ScreenRig credential changed before revocation; nothing was sent or removed.",
          {
            command: "screenrig auth revoke --yes",
            reason: "Re-read the current private config and explicitly retry the revocation.",
          },
        );
      }
      const client = clientFor(runtime, args, resolved.apiUrl, current.token);
      let response;
      try {
        response = await client.call({
          method: "POST",
          path: "/api/v1/account/credential/revoke",
        });
      } catch (err) {
        if (err instanceof CliError) {
          throw new CliError({
            ...err.problem,
            next: {
              command: "screenrig auth revoke --yes",
              reason: "Local credential state was retained. Retrying the exact revocation is safe after an ambiguous response.",
            },
          }, err.exitCode);
        }
        throw err;
      }
      if (response.status !== 204 || response.body !== undefined) {
        throw configError(
          "The revocation endpoint did not return the required empty 204 response; local credential state was retained.",
          {
            command: "screenrig auth revoke --yes",
            reason: "Retry after the service contract is healthy; exact revocation replays are safe.",
          },
        );
      }
      if (response.headers["cache-control"] !== "private, no-store") {
        throw configError(
          "The revocation endpoint did not return the required private, no-store cache policy; local credential state was retained.",
        );
      }
      try {
        await writeConfigAtomic(resolved.configPath, {
          api_url: current.api_url,
          updated_at: runtime.now().toISOString(),
        }, fsLike);
      } catch (err) {
        throw configError(
          `The server revoked the account credential, but atomic local cleanup failed: ${redactText(err instanceof Error ? err.message : "unknown filesystem error")}. The retained local credential no longer authorizes account operations.`,
          {
            command: "screenrig auth revoke --yes",
            reason: "Retrying with the retained exact credential safely completes local cleanup.",
          },
        );
      }
      return { requestId: client.requestId };
    },
  );

  const data = {
    revoked: true,
    local_credential_removed: true,
    account_preserved: true,
    screens_preserved: true,
    recoverable: false,
  };
  return {
    envelope: successEnvelope(data, { request_id: result.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Account credential revoked", [
      ["local_credential", "removed"],
      ["account_and_screens", "preserved"],
      ["recovery", "unavailable; the next account-scoped command enrolls a separate account"],
      ["request_id", result.requestId],
    ]),
  };
}

function isAuthenticatedCommand(group: string, action: string | undefined): boolean {
  const actions: Record<string, ReadonlySet<string | undefined>> = {
    account: new Set(["show"]),
    auth: new Set([undefined, "status"]),
    app: new Set(["upload", "list", "show"]),
    media: new Set(["upload", "show", "list", "delete"]),
    playlist: new Set(["create", "update", "show", "get", "list", "delete"]),
    screen: new Set(["pair", "provision", "update", "list", "show", "assign", "delete", "rotate-public-id", "revoke-credential"]),
    browser: new Set(["setup"]),
    kv: new Set(["get", "set", "delete", "list"]),
    operations: new Set(["get", "wait", "cancel"]),
    events: new Set(["list", "follow"]),
    feedback: new Set(["bug", "feature", "list"]),
  };
  return actions[group]?.has(action) ?? false;
}

async function browserSetupCommand(
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
    path: "/api/v1/account/browser-links/claim",
    idempotent: true,
    idempotencyKey: retry.idempotency_key,
    body: request,
  });
  requirePrivateNoStore(response.headers, "Browser setup claim response");
  const claim = response.body as BrowserLinkClaim;
  const screen = claim.screen;
  if (!hasExactKeys(claim, ["session_id", "status", "screen"])
    || !hasExactKeys(screen, ["id", "public_id", "state", "public_url"])
    || !claim.session_id || claim.status !== "claimed" || !screen.id || !screen.public_id || screen.state !== "pairing_pending") {
    throw usageError("Browser setup response does not match the generated BrowserLinkClaim contract.");
  }
  const apiUrl = new URL(resolved.apiUrl);
  const expectedPlayerHost = apiUrl.hostname === "api.screenrig.localhost" ? "play.screenrig.localhost" : "play.screenrig.ai";
  const expectedPlayerOrigin = `https://${expectedPlayerHost}${apiUrl.port ? `:${apiUrl.port}` : ""}`;
  const publicUrl = new URL(screen.public_url);
  if (publicUrl.origin !== expectedPlayerOrigin || publicUrl.username || publicUrl.password
    || publicUrl.hash || publicUrl.search || publicUrl.pathname !== `/s/${screen.public_id}`) {
    throw usageError("Browser setup response did not contain a safe fragment-free Player public URL.");
  }
  const opened = flagBool(args.flags, "open")
    ? await (runtime.openUrl?.(browserHandoffUrl(resolved.apiUrl, code.display)) ?? Promise.resolve(false))
    : undefined;
  await clearBrowserSetupRetryState(resolved, retryRuntime, retry.idempotency_key);
  const data = {
    code: code.display,
    status: claim.status,
    player_public_url: publicUrl.href,
    ...(opened !== undefined ? { opened } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Browser setup claimed", [
      ["code", code.display],
      ["status", claim.status],
      ["player_public_url", publicUrl.href],
      ...(opened !== undefined ? [["opened", opened ? "true" : "false"] as [string, string]] : []),
    ]),
  };
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requirePrivateNoStore(headers: Record<string, string>, context: string): void {
  if (headers["cache-control"] !== "private, no-store") {
    throw usageError(`${context} did not return the required private, no-store cache policy.`);
  }
}

async function enrollForCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  return ensureCredential({
    resolved,
    runtime: {
      fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
      now: runtime.now,
      sleep: runtime.sleep,
    },
    enroll: async (state) => {
      const client = clientFor(runtime, args, resolved.apiUrl);
      const request: CLIEnrollmentRequest = { client_id: state.clientId };
      const response = await client.call({
        method: "POST",
        path: "/api/v1/enrollments",
        idempotent: true,
        idempotencyKey: state.idempotencyKey,
        body: request,
      });
      requirePrivateNoStore(response.headers, "Enrollment response");
      const enrollment = response.body as CLIEnrollment;
      if (!enrollment.account?.id || !enrollment.token || !enrollment.issuance_id || !enrollment.issuance_expires_at) {
        throw usageError("Enrollment response does not match the generated CLIEnrollment contract.");
      }
      return {
        token: enrollment.token,
        accountId: enrollment.account.id,
      };
    },
    verify: async (token, accountId) => {
      const client = clientFor(runtime, args, resolved.apiUrl, token);
      const response = await client.call({ method: "GET", path: "/api/v1/account" });
      const account = response.body as { id?: string };
      if (!account.id || (accountId && account.id !== accountId)) {
        throw usageError("Persisted enrollment credential did not verify against its account.");
      }
    },
  });
}

async function accountShow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/v1/account" });
  const envelope = jsonBody(response, client.requestId, { token_lookup: describeToken(token) });
  const account = response.body as { id?: string; revision?: number };
  return {
    envelope,
    exitCode: ExitCode.Success,
    human: humanLines("Account", [
      ["id", account.id],
      ["revision", account.revision !== undefined ? String(account.revision) : undefined],
      ["token", describeToken(token)],
      ["request_id", client.requestId],
    ]),
  };
}

async function appPack(args: ParsedArgs, runtime: CliRuntime): Promise<CommandResult> {
  const dir = args.positionals[2];
  if (!dir) {
    throw usageError("app pack requires a directory.");
  }
  const result = await packDirectory(path.resolve(runtime.cwd(), dir));
  const output = flagString(args.flags, "output");
  if (output) {
    await writeFile(path.resolve(runtime.cwd(), output), result.archive);
  }
  const data = {
    sha256: result.sha256,
    compressed_bytes: result.compressed_bytes,
    expanded_bytes: result.expanded_bytes,
    file_count: result.file_count,
    entries: result.entries,
    sdk_injection: result.sdk_injection,
    output,
  };
  return {
    envelope: successEnvelope(data),
    exitCode: ExitCode.Success,
    human: humanLines("Archive packed", [
      ["sha256", result.sha256],
      ["compressed_bytes", String(result.compressed_bytes)],
      ["expanded_bytes", String(result.expanded_bytes)],
      ["file_count", String(result.file_count)],
      ["sdk_injection", result.sdk_injection.injected ? "yes" : "deferred"],
    ]),
  };
}

async function appUpload(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const dir = args.positionals[2];
  if (!dir) {
    throw usageError("app upload requires a directory.");
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const capabilitiesResponse = await client.call({ method: "GET", path: "/api/v1/capabilities" });
  const packed = await packDirectory(path.resolve(runtime.cwd(), dir), {
    limits: limitsFromCapabilities(capabilitiesResponse.body as Capabilities),
  });
  const response = await client.call({
    method: "POST",
    path: "/api/v1/applications",
    idempotent: true,
    headers: {
      "content-type": "application/gzip",
      "screenrig-archive-sha256": packed.sha256,
      "screenrig-expanded-bytes": String(packed.expanded_bytes),
      "screenrig-file-count": String(packed.file_count),
      "screenrig-sdk-version": SDK_PROTOCOL_VERSION,
    },
    body: packed.archive,
  });
  const body = response.body as OperationAccepted;
  if (!flagBool(args.flags, "no-wait") && body.operation_id) {
    const operation = await client.waitForOperation(body.operation_id, {
      timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
      pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
      sleep: runtime.sleep,
    });
    return {
      envelope: successEnvelope(
        { application: body, operation, pack: { sha256: packed.sha256, file_count: packed.file_count } },
        { request_id: client.requestId, operation_id: operation.id },
      ),
      exitCode: ExitCode.Success,
      human: humanLines("Application uploaded", [
        ["application_id", body.id],
        ["operation_id", operation.id],
        ["state", operation.state],
        ["sha256", packed.sha256],
      ]),
    };
  }
  return {
    envelope: jsonBody(response, client.requestId, { sha256: packed.sha256 }),
    exitCode: ExitCode.Success,
    human: humanLines("Application upload accepted", [
      ["application_id", body.id],
      ["operation_id", body.operation_id],
      ["sha256", packed.sha256],
    ]),
  };
}

async function simpleGet(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  pathName: string,
  title: string,
): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: pathName });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `${title}\n${JSON.stringify(response.body, null, 2)}`,
  };
}

async function mediaCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  if (action === "list") {
    return simpleGet(args, runtime, resolved, "/api/v1/media", "Media");
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  if (action === "show") {
    const id = args.positionals[2];
    if (!id) throw usageError("media show requires an id.");
    return simpleGet(args, runtime, resolved, `/api/v1/media/${id}`, "Media");
  }
  if (action === "delete") {
    const id = args.positionals[2];
    const revision = flagString(args.flags, "if-match");
    if (!id || !revision) throw usageError("media delete requires <id> and --if-match.");
    const response = await client.call({
      method: "DELETE",
      path: `/api/v1/media/${id}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(revision) },
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted media ${id}` };
  }
  if (action === "upload") {
    return mediaUpload(args, runtime, client);
  }
  throw usageError("Unknown media command.");
}

/** Flags that shape the pre-upload transcode. */
export function transcodeOptionsFromArgs(args: ParsedArgs): TranscodeOptions {
  const codecFlag = flagString(args.flags, "codec")?.toLowerCase();
  let codec: TranscodeCodec = DEFAULT_CODEC;
  if (codecFlag !== undefined) {
    if (codecFlag === "hevc" || codecFlag === "h265") {
      codec = "hevc";
    } else if (codecFlag === "h264" || codecFlag === "avc") {
      codec = "h264";
    } else {
      throw usageError("--codec accepts hevc or h264.");
    }
  }

  const maxFps = flagNumber(args.flags, "max-fps") ?? DEFAULT_MAX_FPS;
  if (!(maxFps > 0) || maxFps > 240) {
    throw usageError("--max-fps must be greater than 0 and at most 240.");
  }
  const maxEdge = flagNumber(args.flags, "max-edge") ?? MAX_EDGE;
  if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > MAX_EDGE) {
    throw usageError(`--max-edge must be a whole number between 16 and ${MAX_EDGE}.`);
  }
  const webpQuality = flagNumber(args.flags, "webp-quality") ?? DEFAULT_WEBP_QUALITY;
  if (!Number.isInteger(webpQuality) || webpQuality < 1 || webpQuality > 100) {
    throw usageError("--webp-quality must be a whole number between 1 and 100.");
  }
  return { codec, maxFps, maxEdge, webpQuality };
}

function progressReporterFor(args: ParsedArgs, runtime: CliRuntime): ProgressReporter {
  if (flagBool(args.flags, "no-progress")) {
    return silentProgressReporter();
  }
  const json = flagBool(args.flags, "json");
  return createProgressReporter({
    stderr: runtime.stderr,
    json,
    tty: !json && runtime.isStderrTty?.() === true,
    now: () => runtime.now().getTime(),
  });
}

async function mediaUpload(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const file = args.positionals[2];
  if (!file) throw usageError("media upload requires a file.");
  const sourcePath = path.resolve(runtime.cwd(), file);
  const explicitContentType = flagString(args.flags, "content-type");

  // Validate unconditionally so a typo such as --webp-quality 500 is rejected
  // whether or not transcoding runs. The result is unused under --no-transcode.
  const transcodeOptions = transcodeOptionsFromArgs(args);

  let transcode: TranscodeResult | undefined;
  if (!flagBool(args.flags, "no-transcode")) {
    transcode = await transcodeForUpload({
      runtime,
      filePath: sourcePath,
      explicitContentType,
      options: transcodeOptions,
      reporter: progressReporterFor(args, runtime),
    });
  }

  try {
    const prepared = transcode
      ? await prepareMediaUpload(transcode.filePath, transcode.contentType)
      : await prepareMediaUpload(sourcePath, explicitContentType);
    const declarationResponse = await client.call({
      method: "POST",
      path: "/api/v1/media/uploads",
      idempotent: true,
      body: prepared.declaration,
    });
    if (declarationResponse.headers["cache-control"] !== "private, no-store") {
      throw usageError("Media upload declaration did not return the required private, no-store cache policy.");
    }
    const session = validateMediaUploadSession(declarationResponse.body as MediaUploadSession, runtime.now().getTime());
    await performSignedMediaPut(prepared, session, runtime.signedRawPut ?? fetchSignedRawPut());
    const commitResponse = await client.call({
      method: "POST",
      path: `/api/v1/media/uploads/${session.id}/commit`,
      idempotent: true,
      idempotencyKey: deriveCommitIdempotencyKey(client.idempotencyKey),
      body: prepared.commit,
    });
    let operation = commitResponse.body as Operation;
    if (!flagBool(args.flags, "no-wait")) {
      operation = await client.waitForOperation(operation.id, {
        timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
        pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
        sleep: runtime.sleep,
      });
    }
    const data = {
      operation,
      upload: {
        filename: prepared.declaration.filename,
        content_type: prepared.declaration.content_type,
        bytes: prepared.declaration.bytes,
        sha256: prepared.declaration.sha256,
      },
      transcode: transcode
        ? {
            applied: !transcode.passthrough,
            stage: transcode.stage,
            reason: transcode.reason,
            source_bytes: transcode.sourceBytes,
            output_bytes: transcode.outputBytes,
            width: transcode.width,
            height: transcode.height,
            dimensions_measured: transcode.dimensionsMeasured,
            duration_ms: transcode.durationMs,
          }
        : { applied: false, reason: "--no-transcode uploaded the source bytes unchanged" },
    };
    const warnings = (transcode?.warnings ?? []).map((message) => ({ code: "transcode_warning", message }));
    const filenameWarning = lowInformationFilenameWarning(prepared.declaration.filename);
    if (filenameWarning) warnings.push({ code: "generic_filename", message: filenameWarning });
    return {
      envelope: successEnvelope(data, {
        request_id: client.requestId,
        operation_id: operation.id,
        warnings,
      }),
      exitCode: ExitCode.Success,
      human: humanLines(flagBool(args.flags, "no-wait") ? "Media upload committed" : "Media uploaded", [
        ["operation_id", operation.id],
        ["state", operation.state],
        ["filename", prepared.declaration.filename],
        ["content_type", prepared.declaration.content_type],
        ["transcode", transcode ? `${transcode.reason} in ${transcode.durationMs} ms` : "skipped"],
        ["sha256", prepared.declaration.sha256],
        ...warnings.map((warning): [string, string] => ["warning", warning.message]),
      ]),
    };
  } finally {
    if (transcode?.cleanupDir) {
      await rm(transcode.cleanupDir, { recursive: true, force: true });
    }
  }
}

/**
 * The submission kind comes from the route, never from the request body, so the
 * CLI action selects the path and nothing in the payload can contradict it.
 */
const FEEDBACK_PATHS: Record<FeedbackKind, string> = {
  bug: "/api/v1/feedback/bugs",
  feature: "/api/v1/feedback/features",
};

/**
 * Exactly the contract pattern for `FeedbackContext.command`: up to four
 * lowercase words. It admits no flag, no uppercase, no separator, and no
 * punctuation, so an argument value cannot survive it.
 */
const FEEDBACK_COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}( [a-z][a-z0-9-]{0,31}){0,3}$/;
const FEEDBACK_TITLE_MAX = 120;
const FEEDBACK_BODY_MAX = 4000;

/**
 * Built from the resolved command surface only. Nothing here is derived from
 * raw argv, so no argument value, path, identifier, or credential can reach the
 * server through the diagnostic envelope.
 */
export function feedbackContextFromArgs(
  args: ParsedArgs,
  platform: string,
): FeedbackContext | undefined {
  if (flagBool(args.flags, "no-context")) {
    return undefined;
  }
  const context: FeedbackContext = { cli_version: CLI_VERSION };
  if (/^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/.test(platform)) {
    context.platform = platform;
  }
  // `--command --json` parses as a valueless flag. Fail rather than silently
  // dropping the context the caller asked for.
  if (args.flags.command === true) {
    throw usageError('--command requires a value, such as --command "media upload".');
  }
  // Validated exactly as supplied. Normalizing first would let an uppercase
  // argument value such as "screen pair ABC234" be lowercased into a shape the
  // pattern accepts, which is precisely the leak the closed envelope prevents.
  const command = flagString(args.flags, "command")?.trim();
  if (command !== undefined) {
    if (!FEEDBACK_COMMAND_PATTERN.test(command)) {
      throw usageError(
        "--command accepts a command path only, as up to four lowercase words such as " +
          '"media upload". Option flags, identifiers, file paths, and argument values are rejected ' +
          "by the server and must not be placed here.",
      );
    }
    context.command = command;
  }
  return context;
}

async function readFeedbackBody(args: ParsedArgs, runtime: CliRuntime): Promise<string> {
  const inline = flagString(args.flags, "body");
  const file = flagString(args.flags, "body-file");
  if (inline !== undefined && file !== undefined) {
    throw usageError("Pass either --body or --body-file, not both.");
  }
  if (inline !== undefined) {
    return inline;
  }
  if (file === undefined) {
    throw usageError("feedback requires --body TEXT or --body-file FILE.");
  }
  try {
    return await readFile(path.resolve(runtime.cwd(), file), "utf8");
  } catch (error) {
    throw usageError(`Cannot read --body-file: ${error instanceof Error ? error.message : "read failed"}`);
  }
}

async function feedbackCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  if (action === "list") {
    return feedbackList(args, client);
  }
  if (action !== "bug" && action !== "feature") {
    throw usageError("Unknown feedback command; use feedback bug, feedback feature, or feedback list.");
  }

  const title = args.positionals[2]?.trim();
  if (!title) {
    throw usageError(`feedback ${action} requires a title.`);
  }
  if (title.length > FEEDBACK_TITLE_MAX) {
    throw usageError(`A feedback title is at most ${FEEDBACK_TITLE_MAX} characters.`);
  }
  const body = (await readFeedbackBody(args, runtime)).trim();
  if (!body) {
    throw usageError("A feedback body must not be empty.");
  }
  if (body.length > FEEDBACK_BODY_MAX) {
    throw usageError(`A feedback body is at most ${FEEDBACK_BODY_MAX} characters.`);
  }

  const context = feedbackContextFromArgs(args, `${process.platform}/${process.arch}`);
  const payload: FeedbackWrite = { title, body, ...(context ? { context } : {}) };

  // Submissions are immutable and the server deduplicates an exact retry under
  // the same key for 24 hours, so the ordinary idempotency key is what makes a
  // retry safe rather than duplicating a report.
  const response = await client.call({
    method: "POST",
    path: FEEDBACK_PATHS[action],
    idempotent: true,
    body: payload,
  });
  const submission = response.body as FeedbackSubmission;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(action === "bug" ? "Bug report submitted" : "Feature request submitted", [
      ["id", submission?.id],
      ["kind", submission?.kind],
      ["title", submission?.title],
      ["created_at", submission?.created_at],
      ["note", "Submissions are immutable; send a new one to correct or add detail."],
    ]),
  };
}

async function feedbackList(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const kindFlag = flagString(args.flags, "kind")?.toLowerCase();
  if (kindFlag !== undefined && kindFlag !== "bug" && kindFlag !== "feature") {
    throw usageError("--kind accepts bug or feature.");
  }
  const kinds: FeedbackKind[] = kindFlag ? [kindFlag as FeedbackKind] : ["bug", "feature"];

  const items: FeedbackSubmission[] = [];
  for (const kind of kinds) {
    const response = await client.call({ method: "GET", path: FEEDBACK_PATHS[kind] });
    const page = (response.body ?? {}) as FeedbackList;
    // The route already fixes the kind; keep it on each item so a merged list
    // stays unambiguous even when the server omits it.
    for (const item of page.items ?? []) {
      items.push({ ...item, kind: item.kind ?? kind });
    }
  }
  items.sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0));

  return {
    envelope: successEnvelope({ items }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human:
      items.length === 0
        ? "No feedback submissions"
        : [
            `Feedback submissions (${items.length})`,
            ...items.map((item) => `${item.created_at}  ${item.kind.padEnd(7)}  ${item.id}  ${item.title}`),
          ].join("\n"),
  };
}

async function playlistCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  if (action === "list") return simpleGet(args, runtime, resolved, "/api/v1/playlists", "Playlists");
  if (action === "get" || action === "show") {
    const id = args.positionals[2];
    if (!id) throw usageError("playlist get requires an id.");
    return simpleGet(args, runtime, resolved, `/api/v1/playlists/${id}`, "Playlist");
  }
  if (action === "create" || action === "update") {
    const id = action === "update" ? args.positionals[2] : undefined;
    const file = action === "update" ? args.positionals[3] : args.positionals[2];
    const ifMatch = flagString(args.flags, "if-match");
    if (!file || (action === "update" && (!id || !ifMatch))) {
      throw usageError(`playlist ${action} requires ${action === "update" ? "<id> <file> --if-match" : "<file>"}.`);
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(path.resolve(runtime.cwd(), file), "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw usageError(`Cannot read playlist JSON: ${err instanceof Error ? err.message : "invalid JSON"}`);
    }
    if (typeof parsed.name !== "string" || !Array.isArray(parsed.pages)) {
      throw usageError("Playlist JSON must contain string name and array pages.");
    }
    const extra = Object.keys(parsed).filter((key) => key !== "name" && key !== "pages");
    if (extra.length > 0) {
      throw usageError(`Playlist JSON contains unsupported fields: ${extra.join(", ")}.`);
    }
    const body = { name: parsed.name, pages: parsed.pages };
    const response = await client.call({
      method: action === "create" ? "POST" : "PUT",
      path: action === "create" ? "/api/v1/playlists" : `/api/v1/playlists/${id}`,
      idempotent: true,
      headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
      body,
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Playlist ${action}d.` };
  }
  if (action === "delete") {
    const id = args.positionals[2];
    const ifMatch = flagString(args.flags, "if-match");
    if (!id || !ifMatch) throw usageError("playlist delete requires <id> and --if-match.");
    const response = await client.call({
      method: "DELETE",
      path: `/api/v1/playlists/${id}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(ifMatch) },
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted playlist ${id}` };
  }
  throw usageError("Unknown playlist command.");
}

async function screenCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  if (action === "list") return simpleGet(args, runtime, resolved, "/api/v1/screens", "Screens");
  if (action === "provision") {
    const openMode = flagBool(args.flags, "open");
    const printMode = flagBool(args.flags, "print-url");
    if (openMode === printMode) {
      throw usageError("screen provision requires exactly one of --open or --print-url.");
    }
    const label = flagString(args.flags, "label");
    const enrollmentRuntime = {
      fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
      now: runtime.now,
      sleep: runtime.sleep,
    };
    const retry = await provisionRetryState({
      resolved,
      runtime: enrollmentRuntime,
      ...(label ? { label } : {}),
      ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
    });
    const request: ProvisionScreen = { ...(label ? { label } : {}) };
    let response;
    try {
      response = await client.call({
        method: "POST",
        path: "/api/v1/screens/provision",
        idempotent: true,
        idempotencyKey: retry.idempotency_key,
        body: request,
      });
    } catch (error) {
      if (error instanceof CliError && error.problem.code === "provisioning_expired") {
        await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
      }
      throw error;
    }
    requirePrivateNoStore(response.headers, "Browser provisioning response");
    const provisioned = response.body as ScreenProvisioning;
    if (!provisioned.screen?.id || !provisioned.screen.public_id || !provisioned.expires_at || Number.isNaN(Date.parse(provisioned.expires_at))) {
      throw usageError("Browser provisioning response does not match the generated ScreenProvisioning contract.");
    }
    const urls = validateProvisioningUrls(provisioned);
    const opened = openMode ? await (runtime.openUrl?.(urls.provisioningUrl) ?? Promise.resolve(false)) : false;
    if (printMode || opened) await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
    const data = {
      screen_id: provisioned.screen.id,
      public_url: urls.publicUrl,
      expires_at: provisioned.expires_at,
      ...(openMode ? { opened } : { provisioning_url: urls.provisioningUrl }),
    };
    return {
      envelope: successEnvelope(data, { request_id: client.requestId }),
      exitCode: ExitCode.Success,
      human: humanLines(openMode ? "Browser provisioning" : "Sensitive one-time browser provisioning URL", [
        ["screen_id", provisioned.screen.id],
        ["public_url", urls.publicUrl],
        ["expires_at", provisioned.expires_at],
        ...(openMode ? [["opened", opened ? "true" : "false"] as [string, string]] : [["provisioning_url", urls.provisioningUrl] as [string, string]]),
      ]),
    };
  }
  if (action === "pair") {
    const rawCode = args.positionals[2];
    if (!rawCode) throw usageError("screen pair requires CODE.");
    const code = rawCode.toUpperCase();
    if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code)) {
      throw usageError("screen pair CODE must be six characters from 23456789ABCDEFGHJKMNPQRSTUVWXYZ.");
    }
    const label = flagString(args.flags, "label");
    const request: PairScreen = { code, ...(label ? { label } : {}) };
    const response = await client.call({
      method: "POST",
      path: "/api/v1/screens/pair",
      idempotent: true,
      body: request,
    });
    requirePrivateNoStore(response.headers, "Screen pairing response");
    const claim = response.body as PairingClaim;
    if (!claim.screen?.id || !claim.screen.label || !claim.public_url) {
      throw usageError("Screen pairing response does not match the generated PairingClaim contract.");
    }
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: humanLines("Screen paired", [
        ["code", code],
        ["screen_id", claim.screen.id],
        ["label", claim.screen.label],
        ["state", claim.screen.state],
      ]),
    };
  }
  if (action === "show") {
    const id = args.positionals[2];
    if (!id) throw usageError("screen show requires an id.");
    return simpleGet(args, runtime, resolved, `/api/v1/screens/${id}`, "Screen");
  }
  if (action === "update") {
    const id = args.positionals[2];
    const ifMatch = flagString(args.flags, "if-match");
    const name = flagString(args.flags, "name");
    const playlistId = flagString(args.flags, "playlist-id");
    if (!id || !ifMatch || (!name && !playlistId)) throw usageError("screen update requires <id>, --if-match, and --name or --playlist-id.");
    const body = { ...(name ? { name } : {}), ...(playlistId ? { playlist_id: playlistId } : {}) };
    const response = await client.call({ method: "PATCH", path: `/api/v1/screens/${id}`, idempotent: true, headers: { "if-match": quotedRevision(ifMatch) }, body });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Updated screen ${id}` };
  }
  if (action === "assign") {
    const id = args.positionals[2];
    const playlistId = flagString(args.flags, "playlist-id");
    const ifMatch = flagString(args.flags, "if-match");
    if (!id || !playlistId || !ifMatch) throw usageError("screen assign requires <id> --playlist-id --if-match.");
    const response = await client.call({
      method: "PATCH",
      path: `/api/v1/screens/${id}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(ifMatch) },
      body: { playlist_id: playlistId },
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Assigned playlist ${playlistId} to ${id}` };
  }
  if (action === "delete") {
    const id = args.positionals[2];
    const ifMatch = flagString(args.flags, "if-match");
    if (!id || !ifMatch) throw usageError("screen delete requires <id> and --if-match.");
    const response = await client.call({
      method: "DELETE",
      path: `/api/v1/screens/${id}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(ifMatch) },
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted screen ${id}` };
  }
  if (action === "rotate-public-id" || action === "revoke-credential") {
    const id = args.positionals[2];
    const revision = flagString(args.flags, "if-match");
    if (!id || !revision) throw usageError(`screen ${action} requires <id> and --if-match.`);
    const suffix = action === "rotate-public-id" ? "public-id/rotate" : "credential/revoke";
    const response = await client.call({
      method: "POST",
      path: `/api/v1/screens/${id}/${suffix}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(revision) },
    });
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: action === "rotate-public-id" ? `Rotated public id for ${id}` : `Revoked device credential for ${id}`,
    };
  }
  throw usageError("Unknown screen command.");
}

async function kvCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  const applicationId = flagString(args.flags, "application-id");
  if (!applicationId) throw usageError("kv commands require --application-id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const key = args.positionals[2];
  if (action === "list") {
    return simpleGet(args, runtime, resolved, `/api/v1/applications/${applicationId}/kv`, "K/V");
  }
  if (action === "get") {
    if (!key) throw usageError("kv get requires a key.");
    return simpleGet(args, runtime, resolved, `/api/v1/applications/${applicationId}/kv/${encodeURIComponent(key)}`, "K/V");
  }
  if (action === "set") {
    if (!key) throw usageError("kv set requires a key.");
    const body = await kvWriteFromArgs(args, runtime.cwd());
    const revision = flagString(args.flags, "if-match");
    const response = await client.call({
      method: "PUT",
      path: `/api/v1/applications/${applicationId}/kv/${encodeURIComponent(key)}`,
      idempotent: true,
      headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
      body,
    });
    const entry = response.body as KVEntry;
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: humanLines("K/V value set", [
        ["key", entry.key],
        ["content_type", entry.content_type],
        ["bytes", String(entry.bytes)],
        ["sha256", entry.sha256],
        ["revision", String(entry.revision)],
      ]),
    };
  }
  if (action === "delete") {
    if (!key) throw usageError("kv delete requires a key.");
    const ifMatch = flagString(args.flags, "if-match");
    if (!ifMatch) throw usageError("kv delete requires --if-match.");
    const response = await client.call({
      method: "DELETE",
      path: `/api/v1/applications/${applicationId}/kv/${encodeURIComponent(key)}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(ifMatch) },
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted ${key}` };
  }
  throw usageError("Unknown kv command.");
}

async function operationsGet(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError("operations get requires an id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const operation = await client.getOperation(id);
  return {
    envelope: successEnvelope(operation, { request_id: client.requestId, operation_id: operation.id }),
    exitCode: ExitCode.Success,
    human: humanLines("Operation", [
      ["id", operation.id],
      ["state", operation.state],
      ["kind", operation.kind],
      ["request_id", operation.request_id ?? client.requestId],
    ]),
  };
}

async function operationsWait(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError("operations wait requires an id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const operation = await client.waitForOperation(id, {
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
    sleep: runtime.sleep,
  });
  return {
    envelope: successEnvelope(operation, { request_id: client.requestId, operation_id: operation.id }),
    exitCode: ExitCode.Success,
    human: humanLines("Operation complete", [
      ["id", operation.id],
      ["state", operation.state],
    ]),
  };
}

async function operationsCancel(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError("operations cancel requires an id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "POST", path: `/api/v1/operations/${id}/cancel`, idempotent: true });
  const operation = response.body as Operation;
  return {
    envelope: successEnvelope(operation, { request_id: client.requestId, operation_id: operation.id }),
    exitCode: ExitCode.Success,
    human: humanLines("Operation cancelled", [["id", operation.id], ["state", operation.state]]),
  };
}

async function eventsList(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/v1/events",
    query: {
      after: flagString(args.flags, "after") ?? flagString(args.flags, "cursor"),
    },
  });
  const page = response.body as EventPage;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: (page.items ?? []).map((event) => `${event.at} ${event.type} ${event.message}`).join("\n") || "(no events)",
  };
}

async function eventsFollow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const transport = transportFor(runtime, resolved.apiUrl, token);
  const events: AccountEvent[] = [];
  let buffer = "";
  const controller = new AbortController();
  const timeoutMs = flagNumber(args.flags, "timeout");
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const stream = await transport.stream({
      method: "GET",
      path: "/api/v1/events/stream",
      query: { after: flagString(args.flags, "after") ?? flagString(args.flags, "cursor") },
      headers: { "x-request-id": client.requestId, authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      buffer += chunk;
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.data) {
          try {
            events.push(JSON.parse(event.data) as AccountEvent);
          } catch {
            events.push({
              cursor: event.id ?? "",
              sequence: 0,
              type: event.event ?? "message",
              severity: "info",
              message: event.data,
              at: runtime.now().toISOString(),
            });
          }
        }
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return {
    envelope: successEnvelope({ items: events }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: events.map((event) => `${event.at ?? ""} ${event.type} ${event.message}`).join("\n") || "(stream closed)",
  };
}

async function doctor(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const checks: Array<{ name: string; status: "pass" | "fail"; detail: string }> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 20 ? "pass" : "fail",
    detail: `node ${process.versions.node}`,
  });
  checks.push({
    name: "config_path",
    status: "pass",
    detail: resolved.configPath,
  });
  try {
    const st = await runtime.fs.stat(resolved.configPath);
    const mode = st.mode & 0o777;
    const ok = (mode & 0o077) === 0;
    checks.push({
      name: "config_permissions",
      status: ok ? "pass" : "fail",
      detail: `mode ${mode.toString(8)}`,
    });
  } catch {
    checks.push({ name: "config_permissions", status: "pass", detail: "config file not present" });
  }
  checks.push({
    name: "token",
    status: resolved.token ? "pass" : "fail",
    detail: describeToken(resolved.token),
  });
  checks.push({
    name: "api_url",
    status: resolved.apiUrl.startsWith("https://") || resolved.apiUrl.startsWith("http://127.") || resolved.apiUrl.includes("localhost") ? "pass" : "fail",
    detail: resolved.apiUrl,
  });
  const lookup = ffmpegLookup(runtime.env);
  try {
    const toolchain = await resolveFfmpegToolchain(runtime);
    checks.push({
      name: "ffmpeg",
      status: "pass",
      detail: `${toolchain.ffmpeg} ${toolchain.ffmpegVersion}${lookup.ffmpegFromEnv ? " (SCREENRIG_FFMPEG)" : ""}`,
    });
    checks.push({
      name: "ffprobe",
      status: "pass",
      detail: `${toolchain.ffprobe} ${toolchain.ffprobeVersion}${lookup.ffprobeFromEnv ? " (SCREENRIG_FFPROBE)" : ""}`,
    });
    for (const [name, encoder] of [
      ["encoder_libx265", "libx265"],
      ["encoder_libx264", "libx264"],
      ["encoder_libwebp", "libwebp"],
    ] as const) {
      checks.push({
        name,
        status: toolchain.encoders.has(encoder) ? "pass" : "fail",
        detail: toolchain.encoders.has(encoder) ? `${encoder} available` : `${encoder} missing from this ffmpeg build`,
      });
    }
    const tonemap = toolchain.filters.has("zscale") && toolchain.filters.has("tonemap");
    checks.push({
      name: "filter_hdr_tonemap",
      status: tonemap ? "pass" : "fail",
      detail: tonemap
        ? "zscale and tonemap available"
        : "zscale or tonemap missing; HDR sources convert without tone mapping",
    });
  } catch (err) {
    const detail = err instanceof CliError ? err.problem.detail : err instanceof Error ? redactText(err.message) : "ffmpeg probe failed";
    checks.push({ name: "ffmpeg", status: "fail", detail });
  }

  const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  for (const route of ["/.health", "/.ready", "/.version", "/api/v1/capabilities"] as const) {
    try {
      const response = await client.call({ method: "GET", path: route });
      const name = route === "/api/v1/capabilities" ? "capabilities" : route.slice(2);
      checks.push({ name, status: "pass", detail: `status ${response.status}` });
      if (route === "/api/v1/capabilities") {
        // Probe feedback support from the advertised feature map rather than
        // assuming the routes exist on every deployment.
        const features = ((response.body ?? {}) as Capabilities).features ?? {};
        const supported = features.feedback === true;
        checks.push({
          name: "feedback",
          status: supported ? "pass" : "fail",
          detail: supported
            ? "server advertises feedback support"
            : "server does not advertise feedback support; feedback commands are unavailable",
        });
      }
    } catch (err) {
      const detail = err instanceof CliError ? err.problem.detail : err instanceof Error ? err.message : `${route} failed`;
      const name = route === "/api/v1/capabilities" ? "capabilities" : route.slice(2);
      checks.push({ name, status: "fail", detail });
    }
  }
  const failed = checks.some((check) => check.status === "fail");
  return {
    envelope: successEnvelope({ checks, version: CLI_VERSION }),
    exitCode: failed ? ExitCode.Unexpected : ExitCode.Success,
    human: checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n"),
  };
}

export type { Operation };
