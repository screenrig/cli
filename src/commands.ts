import { createHash } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  limitsFromCapabilities,
  TEMPORARY_PROTOCOL_VERSION,
  type Account,
  type AccountEvent,
  type Agent,
  type AgentConnection,
  type AgentConnectionRequest,
  type AgentCredentialCollection,
  type AgentDisconnectRequest,
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
  type MediaTagPatch,
  type Operation,
  type OperationAccepted,
  type PairScreen,
  type PairingClaim,
  type BrowserLinkClaim,
  type BrowserLinkClaimRequest,
  type DashboardLink,
  type ProvisionScreen,
  type Screen,
  type ScreenPatch,
  type ScreenProvisioning,
  type ScreenScreenshotAccepted,
  type ScreenScreenshotStatus,
  type ScreenToastAccepted,
  type ScreenToastLevel,
  type ScreenToastWrite,
} from "./adapters/protocol.js";
import { SDK_PROTOCOL_VERSION } from "./adapters/sdk-injection.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./argv.js";
import { ApiClient, requireToken } from "./client.js";
import {
  preserveLogSocket,
  resolveConfig,
  describeTokenPresence,
  hasToken,
  readConfigFile,
  withConfigLock,
  writeConfigAtomic,
  type ScreenRigConfig,
} from "./config.js";
import { attachOperationLogger, loggerOf, loggingTransport } from "./log/index.js";
import { ensureCredential } from "./enrollment.js";
import {
  headerValue,
  CREDITS_REMAINING_HEADER,
  observeCreditsRemaining,
  parseCreditsInteger,
} from "./credits.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { CliError, configError, makeProblem, notEnrolledError, timeoutError, usageError } from "./problems.js";
import { packDirectory } from "./pack/index.js";
import type { CliRuntime } from "./runtime.js";
import { FetchTransport } from "./transport/http.js";
import type { Transport } from "./transport/types.js";
import { parseSse } from "./sse.js";
import { kvWriteFromArgs } from "./kv-write.js";
import { commentsWriteFromArgs } from "./comments-write.js";
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
import { validateDashboardLink } from "./dashboard-link.js";
import {
  browserHandoffUrl,
  browserSetupRetryState,
  clearBrowserSetupRetryState,
  normalizeBrowserSetupCode,
} from "./browser-setup.js";
import { isSensitiveKey, isSensitiveValue, redactEvent, redactText } from "./redact.js";
import {
  expandPlaylistPages,
  formatTemplateCatalog,
  playlistTemplateCatalog,
} from "./playlist-templates.js";
import { composeCatalog, formatComposeCatalog } from "./compose/catalog.js";
import { composeSpec } from "./compose/compose.js";
import {
  cwebpLookup,
  ffmpegLookup,
  resolveCwebpToolchain,
  resolveFfmpegToolchain,
  type CwebpToolchain,
  type FfmpegToolchain,
} from "./media/ffmpeg.js";
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
import { exportPlaylistBundle, importPlaylistBundle } from "./playlist-bundle.js";
import {
  agentPlatform,
  decryptAgentCredential,
  generateAgentConnectionKey,
  publicAgentConnectionKey,
  validateAgent,
  validateAgentSelfStatus,
  validateAgentConnectionEvent,
  validateAgentConnectionStart,
  type AgentConnectionConfig,
} from "./agent-identity.js";

export const CLI_VERSION = "0.1.0";

export const USAGE = `screenrig — ScreenRig localhost v1 control-plane CLI

Usage:
  screenrig [--json] [--api-url URL] [--config PATH]
            [--request-id ID] [--idempotency-key KEY] [--timeout MS]
            [--beta-key KEY]
            <command> [args]

Configuration (user config JSON, not flags):
  log_socket   optional path to an already-listening Unix socket. The CLI
               connects as a client and writes one NDJSON operation-log
               object per line. Absent or empty keeps current behavior.
               This is a config field only, not a command-line switch.

Commands:
  account show
  agent enroll --email ADDRESS [--name NAME] [--open-dashboard]
  agent connect [--name NAME] [--print-url] [--timeout MS]
  agent status
  agent disconnect --yes [--allow-lockout]
  auth status                         (deprecated alias for agent status)
  auth revoke --yes [--allow-lockout] (deprecated alias for agent disconnect)
  dashboard [--print-url]
  app pack <directory> [--output FILE]
  app upload <directory> [--name NAME] [--no-wait] [--poll-ms MS]
  app list
  app show <id>
  media upload <file> [--content-type TYPE] [--tag TAG] [--no-wait] [--poll-ms MS]
                      [--no-transcode] [--codec h264|hevc] [--max-fps N]
                      [--max-edge PIXELS] [--webp-quality 1-100] [--no-progress]
  media show <id>
  media list [--tag TAG] [--kind image|video]
  media update <id> (--tag TAG | --clear-tag) --if-match REVISION
  media delete <id> --if-match REVISION
  compose catalog
  compose render <file> [--output FILE] [--open]
  playlist templates
  playlist create <file>
  playlist update <id> <file> --if-match REVISION
  playlist export <id> --output DIRECTORY
  playlist import <directory> [--update ID --if-match REVISION]
  playlist show <id>
  playlist list
  playlist delete <id> --if-match REVISION
  screen pair CODE [--label LABEL]
  screen provision (--open | --print-url) [--label LABEL]
  browser setup --code CODE [--open]
  screen update <id> [--name NAME] [--playlist-id ID] [--timezone ZONE]
                     --if-match REVISION
  screen list [--state archived]
  screen show <id>
  screen assign <id> --playlist-id ID --if-match REVISION
  screen set-timezone <id> --timezone ZONE --if-match REVISION
  screen archive <id> --if-match REVISION
  screen unarchive <id> --if-match REVISION
  screen delete <id> --if-match REVISION
  screen rotate-public-id <id> --if-match REVISION
  screen toast <id> --text TEXT [--level info] [--duration-ms MS]
  screen screenshot <id> [--output FILE] [--timeout MS] [--poll-ms MS]
  kv get --application-id ID <key>
  kv set --application-id ID <key> --json-value JSON [--if-match REVISION]
  kv set --application-id ID <key> --file FILE --content-type TYPE [--if-match REVISION]
  kv set --application-id ID <key> --value-base64 BASE64 --content-type TYPE [--if-match REVISION]
  kv delete --application-id ID <key> --if-match REVISION
  kv list --application-id ID
  comment show screen <id>
  comment show playlist <id> [--page PAGE_ID]
  comment set screen <id> (--json-value JSON | --file FILE)
  comment set playlist <id> [--page PAGE_ID] (--json-value JSON | --file FILE)
  comment delete screen <id>
  comment delete playlist <id> [--page PAGE_ID]
  operations get <id>
  operations wait <id> [--timeout MS] [--poll-ms MS]
  operations cancel <id>
  events list [--after CURSOR] [--limit N]
  events follow [--after CURSOR] [--timeout MS]
  playback list [--screen-id ID] [--media-id ID] [--day YYYY-MM-DD]
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

function nonemptyEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function enrollmentEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("agent enroll requires --email ADDRESS for unverified account contact metadata.");
  }
  const parts = email?.split("@");
  const local = parts?.[0] ?? "";
  const domain = parts?.[1] ?? "";
  const localValid = local.length > 0 && local.length <= 64
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local);
  const labels = domain.split(".");
  const domainValid = labels.length >= 2 && labels.every((label) => label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
  if (email.length < 3 || email.length > 254 || parts?.length !== 2 || !localValid || !domainValid) {
    throw usageError("agent enroll --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}

function rethrowCompose(err: unknown): never {
  if (err instanceof CliError) {
    throw err;
  }
  if (err instanceof Error && (err as { code?: string }).code === "usage_error") {
    throw usageError(err.message, {
      command: "screenrig --json compose catalog",
      reason: "Inspect the fail-closed compose catalog, then compose render a spec.",
    });
  }
  throw err;
}

function defaultComposePngPath(specPath: string): string {
  return specPath.toLowerCase().endsWith(".json") ? `${specPath.slice(0, -5)}.png` : `${specPath}.png`;
}

async function composeRender(args: ParsedArgs, runtime: CliRuntime): Promise<CommandResult> {
  const file = args.positionals[2];
  if (!file) {
    throw usageError("compose render requires a spec file.", {
      command: "screenrig --json compose catalog",
      reason: "Inspect the fail-closed compose catalog, then compose render a spec.",
    });
  }
  if (args.positionals.length > 3) {
    throw usageError("compose render accepts one spec file.");
  }
  if (file.includes("\0")) {
    throw usageError("compose render spec path must not contain a NUL byte.");
  }
  requireFlagValue(args, "output", "./still.png");
  const specPath = path.resolve(runtime.cwd(), file);
  const outputFlag = flagString(args.flags, "output");
  if (outputFlag?.includes("\0")) {
    throw usageError("compose render --output must not contain a NUL byte.");
  }
  const output = path.resolve(runtime.cwd(), outputFlag ?? defaultComposePngPath(file));
  if (output.includes("\0")) {
    throw usageError("compose render --output must not contain a NUL byte.");
  }
  const layoutOutput = `${output}.layout.json`;
  let spec: unknown;
  try {
    spec = JSON.parse(await readFile(specPath, "utf8"));
  } catch (err) {
    throw usageError(`Cannot read compose spec: ${err instanceof Error ? err.message : "invalid JSON"}`);
  }
  const logger = loggerOf(runtime);
  let result;
  try {
    result = await logger.withLocal(
      { op: "compose.render", message: `render ${path.basename(specPath)}` },
      async (span) => {
        const rendered = await composeSpec(spec, {
          baseDir: path.dirname(specPath),
          outPath: output,
          layoutOutPath: layoutOutput,
        });
        span.finish({
          output,
          width: rendered.width,
          height: rendered.height,
          truncated: rendered.truncated,
        });
        return rendered;
      },
    );
  } catch (err) {
    rethrowCompose(err);
  }
  const opened = flagBool(args.flags, "open")
    ? await (runtime.openPath?.(output) ?? Promise.resolve(false))
    : undefined;
  const data = {
    output,
    layout_output: layoutOutput,
    width: result.width,
    height: result.height,
    font_family: result.font_family,
    space: result.space,
    ramp: result.ramp,
    ramp_root: result.ramp_root,
    ramp_at_1080: result.ramp_at_1080,
    truncated: result.truncated,
    ...(opened !== undefined ? { opened } : {}),
  };
  return {
    envelope: successEnvelope(data),
    exitCode: ExitCode.Success,
    human: humanLines("Composed still", [
      ["output", output],
      ["layout_output", layoutOutput],
      ["width", String(result.width)],
      ["height", String(result.height)],
      ["font_family", result.font_family],
      ["truncated", result.truncated ? "true" : "false"],
      ...(opened !== undefined ? [["opened", opened ? "true" : "false"] as [string, string]] : []),
    ]),
  };
}

function transportFor(runtime: CliRuntime, apiUrl: string, token?: string): Transport {
  const base = runtime.transport ?? new FetchTransport(apiUrl, token);
  return loggingTransport(base, loggerOf(runtime));
}

function clientFor(runtime: CliRuntime, args: ParsedArgs, apiUrl: string, token?: string): ApiClient {
  return new ApiClient({
    transport: transportFor(runtime, apiUrl, token),
    token,
    requestId: flagString(args.flags, "request-id"),
    idempotencyKey: flagString(args.flags, "idempotency-key"),
    timeoutMs: flagNumber(args.flags, "timeout"),
    creditsOwner: runtime,
    logger: loggerOf(runtime),
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
      envelope: successEnvelope({ version: CLI_VERSION, protocol_adapter: TEMPORARY_PROTOCOL_VERSION }),
      exitCode: ExitCode.Success,
      human: `screenrig ${CLI_VERSION}`,
    };
  }

  const repair = flagBool(args.flags, "repair-config");
  let resolved = await resolveConfig({ flags: args.flags, fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }, repair });
  await attachOperationLogger(runtime, args, resolved);

  if (group === "compose" && action === "catalog") {
    if (args.positionals.length > 2) {
      throw usageError("compose catalog does not accept positional arguments.");
    }
    return loggerOf(runtime).withLocal({ op: "compose.catalog", message: "compose catalog" }, async () => {
      const catalog = composeCatalog();
      return {
        envelope: successEnvelope(catalog),
        exitCode: ExitCode.Success,
        human: formatComposeCatalog(catalog),
      };
    });
  }
  if (group === "compose" && action === "render") {
    return composeRender(args, runtime);
  }
  if (group === "playlist" && action === "templates") {
    if (args.positionals.length > 2) {
      throw usageError("playlist templates does not accept positional arguments.");
    }
    const catalog = playlistTemplateCatalog();
    return {
      envelope: successEnvelope(catalog),
      exitCode: ExitCode.Success,
      human: formatTemplateCatalog(catalog),
    };
  }
  if (group === "compose") {
    throw usageError("Unknown compose command. Use compose catalog or compose render.", {
      command: "screenrig --json compose catalog",
      reason: "List the fail-closed compose catalog.",
    });
  }

  if (group === "doctor") {
    return doctor(args, runtime, resolved);
  }
  if (group === "app" && action === "pack") {
    return appPack(args, runtime);
  }
  if (group === "agent" && action === "status") {
    return agentStatus(args, runtime, resolved);
  }
  if (group === "auth" && (action === "status" || action === undefined)) {
    return agentStatus(args, runtime, resolved, true);
  }
  if (group === "agent" && action === "connect") {
    return loggerOf(runtime).withLocal({ op: "agent.connect", message: "agent connect" }, () =>
      agentConnect(args, runtime, resolved),
    );
  }
  if (group === "agent" && action === "enroll") {
    return loggerOf(runtime).withLocal({ op: "agent.enroll", message: "agent enroll" }, () =>
      agentEnroll(args, runtime, resolved),
    );
  }
  if (group === "agent" && action === "disconnect") {
    return agentDisconnect(args, runtime, resolved, false);
  }
  if (group === "auth" && action === "revoke") {
    return agentDisconnect(args, runtime, resolved, true);
  }
  if (isAuthenticatedCommand(group, action) && !resolved.token) {
    if (resolved.agentConnection) {
      throw notEnrolledError("This installation has a pending agent connection and no active credential.", {
        command: "screenrig agent connect",
        reason: "Resume the passkey-approved connection before running account commands.",
      });
    }
    if (resolved.lastAgent) {
      throw notEnrolledError("This installation is disconnected and cannot run account commands.", {
        command: "screenrig agent connect",
        reason: "Connect a new independently revocable agent through dashboard passkey approval.",
      });
    }
    throw notEnrolledError("This installation is not enrolled. Enrollment is an explicit step and is never a side effect of another command.", {
      command: resolved.enrollment?.email
        ? "screenrig agent enroll"
        : "screenrig agent enroll --email ADDRESS",
      reason: resolved.enrollment?.email
        ? "Resume the exact pending enrollment before running pairing or another account command."
        : "Create the first agent with unverified contact metadata, then retry the original command.",
    });
  }
  if (group === "account" && action === "show") {
    return accountShow(args, runtime, resolved);
  }
  if (group === "dashboard") {
    return dashboardCommand(args, runtime, resolved);
  }
  if (group === "app" && action === "upload") {
    return loggerOf(runtime).withLocal({ op: "app.upload", message: "app upload" }, () =>
      appUpload(args, runtime, resolved),
    );
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
  if (group === "comment") {
    return commentCommand(args, runtime, resolved, action);
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
    return loggerOf(runtime).withLocal({ op: "events.follow", message: "events follow" }, () =>
      eventsFollow(args, runtime, resolved),
    );
  }
  if (group === "playback" && action === "list") {
    return playbackList(args, runtime, resolved);
  }
  if (group === "feedback") {
    return feedbackCommand(args, runtime, resolved, action);
  }
  if (group === "agent" || group === "auth") {
    throw usageError("Unknown agent command. Use agent enroll, connect, status, or disconnect.", {
      command: "screenrig --help",
      reason: "List implemented agent identity commands and deprecated auth aliases.",
    });
  }
  throw usageError(`Unknown command: ${args.positionals.join(" ")}`, {
    command: "screenrig --help",
    reason: "List implemented commands.",
  });
}

function deprecatedWarning(command: "status" | "disconnect") {
  return {
    code: "deprecated_command",
    message: `The auth command is deprecated. Use screenrig agent ${command}.`,
  };
}

function safeAgentSummary(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    agent_type: agent.agent_type,
    state: agent.state,
    ...(agent.platform ? { platform: agent.platform } : {}),
    ...(agent.version ? { version: agent.version } : {}),
    ...(agent.connected_at ? { connected_at: agent.connected_at } : {}),
    ...(agent.last_used_at ? { last_used_at: agent.last_used_at } : {}),
    ...(agent.revoked_at ? { revoked_at: agent.revoked_at } : {}),
    authenticated_requests: agent.authenticated_requests,
    metered_credits: agent.metered_credits,
  };
}

async function agentStatus(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  deprecated = false,
): Promise<CommandResult> {
  if (args.positionals.length > 2) {
    throw usageError(`${deprecated ? "auth" : "agent"} status does not accept positional arguments.`);
  }
  const warnings = deprecated ? [deprecatedWarning("status")] : [];
  if (resolved.agentConnection) {
    const connection = resolved.agentConnection;
    const data = {
      status: "connecting",
      phase: resolved.token && connection.pending_agent_id ? "activating" : connection.connection_id ? "approval" : "starting",
      ...(connection.connection_id ? { connection_id: connection.connection_id } : {}),
      ...(connection.expires_at ? { expires_at: connection.expires_at } : {}),
    };
    return {
      envelope: successEnvelope(data, { warnings }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent connection", [
        ["status", "connecting"],
        ["phase", data.phase],
        ["connection_id", connection.connection_id],
        ["expires_at", connection.expires_at],
        ...(deprecated ? [["deprecated", "use screenrig agent status"] as [string, string]] : []),
      ]),
    };
  }
  if (!resolved.token) {
    const local = resolved.lastAgent;
    const status = local ? "disconnected" : "not_enrolled";
    return {
      envelope: successEnvelope({ status, ...(local ? { agent: local } : {}) }, { warnings }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", status],
        ["id", local?.id],
        ["name", local?.name],
        ...(deprecated ? [["deprecated", "use screenrig agent status"] as [string, string]] : []),
      ]),
    };
  }

  const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  try {
    const response = await client.call({ method: "GET", path: "/api/v1/agents/self" });
    requirePrivateNoStore(response.headers, "Agent status response");
    const self = validateAgentSelfStatus(response.body);
    const agent = self.agent;
    const status = agent.state === "active" ? "active" : agent.state === "revoked" ? "disconnected" : "connecting";
    return {
      envelope: successEnvelope({ status, connection_ready: self.connection_ready, agent: safeAgentSummary(agent) }, { request_id: client.requestId, warnings }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", status],
        ["id", agent.id],
        ["name", agent.name],
        ["agent_type", agent.agent_type],
        ["platform", agent.platform],
        ["version", agent.version],
        ["connection_ready", self.connection_ready ? "true" : "false"],
        ["last_used_at", agent.last_used_at],
        ...(deprecated ? [["deprecated", "use screenrig agent status"] as [string, string]] : []),
      ]),
    };
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.code !== "unauthorized") throw err;
    return {
      envelope: successEnvelope({ status: "disconnected", credential_accepted: false, local_cleanup_required: true }, { warnings }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", "disconnected"],
        ["credential_accepted", "false"],
        ["next", "run screenrig agent disconnect --yes to complete local cleanup before reconnecting"],
        ...(deprecated ? [["deprecated", "use screenrig agent status"] as [string, string]] : []),
      ]),
    };
  }
}

async function openDashboardForEnrolledAgent(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<boolean> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "POST", path: "/api/v1/account/dashboard-links", idempotent: true });
  requirePrivateNoStore(response.headers, "Dashboard link response");
  const link = validateDashboardLink(response.body as DashboardLink, resolved.apiUrl);
  return runtime.openUrl?.(link.url) ?? false;
}

async function agentEnroll(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  if (args.positionals.length !== 2) throw usageError("agent enroll does not accept positional arguments.");
  requireFlagValue(args, "name", "Office MacBook Codex");
  const name = flagString(args.flags, "name");
  if (name && name.length > 80) throw usageError("agent enroll --name is at most 80 characters.");
  if (resolved.agentConnection) {
    throw usageError("A different agent connection is already pending in this config.", {
      command: "screenrig agent connect",
      reason: "Resume the pending connection before creating a new account.",
    });
  }
  const enrolled = await enrollForCommand(args, runtime, resolved, {
    ...(name ? { name } : {}),
    explicit: true,
  });
  const token = requireToken(enrolled.token);
  const client = clientFor(runtime, args, enrolled.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/v1/agents/self" });
  requirePrivateNoStore(response.headers, "Agent enrollment verification response");
  const self = validateAgentSelfStatus(response.body, "active");
  const agent = self.agent;
  const dashboardOpened = flagBool(args.flags, "open-dashboard")
    ? await openDashboardForEnrolledAgent(args, runtime, enrolled)
    : undefined;
  return {
    envelope: successEnvelope({
      status: "active",
      connection_ready: self.connection_ready,
      agent: safeAgentSummary(agent),
      ...(dashboardOpened !== undefined ? { dashboard_opened: dashboardOpened } : {}),
    }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent enrolled", [
      ["status", "active"],
      ["id", agent.id],
      ["name", agent.name],
      ["connection_ready", self.connection_ready ? "true" : "false"],
      ...(dashboardOpened !== undefined ? [["dashboard_opened", dashboardOpened ? "true" : "false"] as [string, string]] : []),
      ...(dashboardOpened === false ? [["next", "run screenrig dashboard to open or print a fresh link"] as [string, string]] : []),
    ]),
  };
}

function emitAgentApprovalUrl(args: ParsedArgs, runtime: CliRuntime, approvalUrl: string): void {
  if (flagBool(args.flags, "json")) {
    runtime.stderr.write(`${JSON.stringify({ type: "agent_connection_approval", approval_url: approvalUrl })}\n`);
    return;
  }
  runtime.stderr.write(`approval_url: ${approvalUrl}\n`);
}

async function currentAgentConnectionConfig(
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  runtime: CliRuntime,
): Promise<ScreenRigConfig | undefined> {
  return readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
}

async function startOrResumeAgentConnection(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  requestedName: string | undefined,
): Promise<AgentConnectionConfig> {
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  return withConfigLock(
    resolved.configPath,
    fsLike,
    { sleep: runtime.sleep, now: () => runtime.now().getTime() },
    async () => {
      let current = await readConfigFile(resolved.configPath, fsLike);
      if (current?.token && !current.agent_connection) {
        throw usageError("This config already contains an agent credential.", {
          command: "screenrig agent status",
          reason: "Use another private config path to connect a separate installation.",
        });
      }
      if (current?.agent_connection?.expires_at
        && Date.parse(current.agent_connection.expires_at) <= runtime.now().getTime()) {
        const { agent_connection: _expired, token: _pending, agent_id: _agent, ...rest } = current;
        current = rest;
      }
      let pending = current?.agent_connection;
      if (pending?.name && requestedName && pending.name !== requestedName) {
        throw usageError("The pending agent connection has a different --name. Resume it without changing the name.");
      }
      if (!pending) {
        pending = { private_jwk: generateAgentConnectionKey(), ...(requestedName ? { name: requestedName } : {}) };
        await writeConfigAtomic(resolved.configPath, {
          ...(current ?? {}),
          api_url: resolved.apiUrl,
          agent_connection: pending,
          updated_at: runtime.now().toISOString(),
        }, fsLike);
      }
      publicAgentConnectionKey(pending.private_jwk);
      if (pending.connection_id && pending.connection_token && pending.approval_url && pending.expires_at) {
        const checked = validateAgentConnectionStart({
          connection_id: pending.connection_id,
          connection_token: pending.connection_token,
          approval_url: pending.approval_url,
          expires_at: pending.expires_at,
        }, resolved.apiUrl);
        return { ...pending, approval_url: checked.approval_url };
      }

      const client = clientFor(runtime, args, resolved.apiUrl);
      const request: AgentConnectionRequest = {
        ...(pending.name ? { name: pending.name } : {}),
        agent_type: "cli",
        platform: agentPlatform(),
        version: CLI_VERSION,
        recipient_public_key: publicAgentConnectionKey(pending.private_jwk),
      };
      const response = await client.call({ method: "POST", path: "/api/v1/agent-connections", body: request });
      requirePrivateNoStore(response.headers, "Agent connection start response");
      if (response.headers["referrer-policy"] !== "no-referrer") {
        throw configError("Agent connection start response did not return Referrer-Policy: no-referrer.");
      }
      const start = validateAgentConnectionStart(response.body, resolved.apiUrl);
      const complete: AgentConnectionConfig = {
        ...pending,
        connection_id: start.connection_id,
        connection_token: start.connection_token,
        approval_url: start.approval_url,
        expires_at: start.expires_at,
      };
      const latest = await readConfigFile(resolved.configPath, fsLike);
      await writeConfigAtomic(resolved.configPath, {
        ...(latest ?? {}),
        api_url: resolved.apiUrl,
        agent_connection: complete,
        updated_at: runtime.now().toISOString(),
      }, fsLike);
      return complete;
    },
  );
}

async function waitForAgentConnectionApproval(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  connection: AgentConnectionConfig,
  timeoutMs: number,
): Promise<AgentConnection> {
  if (!connection.connection_id || !connection.connection_token) throw configError("Pending agent connection authority is incomplete.");
  const transport = transportFor(runtime, resolved.apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let buffer = "";
  let latest: AgentConnection | undefined;
  try {
    const stream = await transport.stream({
      method: "GET",
      path: `/api/v1/agent-connections/${connection.connection_id}/events`,
      headers: {
        authorization: `ScreenRig-Agent-Connect ${connection.connection_token}`,
        "x-request-id": clientFor(runtime, args, resolved.apiUrl).requestId,
      },
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) {
        throw configError("Agent connection SSE exceeded the bounded status buffer.");
      }
      const parsed = parseSse(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.event !== "agent.connection" || !event.data) {
          if (event.event || event.data) throw configError("Agent connection SSE emitted an unexpected event.");
          continue;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(event.data) as unknown;
        } catch {
          throw configError("Agent connection SSE emitted invalid JSON.");
        }
        latest = validateAgentConnectionEvent(decoded, connection.connection_id);
        if (latest.status !== "pending") return latest;
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw timeoutError("Timed out waiting for dashboard approval. Retry agent connect to resume the same request.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (latest?.status === "pending" || !latest) {
    throw timeoutError("Agent connection stream ended before approval. Retry agent connect to resume the same request.");
  }
  return latest;
}

async function clearAgentConnection(
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  connectionId: string,
  clearPendingToken: boolean,
): Promise<void> {
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (current?.agent_connection?.connection_id !== connectionId) return;
    const { agent_connection: _connection, ...rest } = current;
    if (clearPendingToken && current.agent_connection.pending_agent_id) {
      const { token: _token, agent_id: _agent, ...withoutPending } = rest;
      await writeConfigAtomic(resolved.configPath, { ...withoutPending, updated_at: runtime.now().toISOString() }, fsLike);
      return;
    }
    await writeConfigAtomic(resolved.configPath, { ...rest, updated_at: runtime.now().toISOString() }, fsLike);
  });
}

async function clearDefinitivePendingAgentFailure(
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  connection: AgentConnectionConfig,
  err: CliError,
  detail: string,
): Promise<never> {
  if (!connection.connection_id) throw err;
  await clearAgentConnection(runtime, resolved, connection.connection_id, true);
  throw new CliError({
    ...err.problem,
    detail,
    next: {
      command: "screenrig agent connect",
      reason: "The unusable pending bearer, private connection key, and transient connection state were removed. Start a fresh passkey approval.",
    },
  }, err.exitCode, err.warnings);
}

async function activateCollectedAgent(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  connection: AgentConnectionConfig,
  pendingToken: string,
  agentId: string,
): Promise<{ agent: Agent; requestId: string }> {
  if (!connection.connection_id) throw configError("Pending agent connection identifier is unavailable.");
  const client = clientFor(runtime, args, resolved.apiUrl, pendingToken);
  const verifyActiveAgent = async (): Promise<Agent> => {
    const verification = await client.call({ method: "GET", path: "/api/v1/agents/self" });
    requirePrivateNoStore(verification.headers, "Agent verification response");
    const verified = validateAgentSelfStatus(verification.body, "active").agent;
    if (verified.id !== agentId) throw configError("Persisted agent credential did not verify against its agent.");
    return verified;
  };

  let activation;
  try {
    activation = await client.call({ method: "POST", path: "/api/v1/agents/self/activate" });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (err.problem.code === "agent_connection_invalid") {
      try {
        const verified = await verifyActiveAgent();
        await clearAgentConnection(runtime, resolved, connection.connection_id, false);
        return { agent: verified, requestId: client.requestId };
      } catch (verificationError) {
        if (verificationError instanceof CliError && verificationError.problem.code === "unauthorized") {
          return clearDefinitivePendingAgentFailure(
            runtime,
            resolved,
            connection,
            verificationError,
            "The pending agent credential was rejected or revoked after the activation connection was cleaned up.",
          );
        }
        throw verificationError;
      }
    }
    if (err.problem.code === "unauthorized") {
      return clearDefinitivePendingAgentFailure(
        runtime,
        resolved,
        connection,
        err,
        "The pending agent credential was cryptographically rejected or revoked before activation.",
      );
    }
    if (err.problem.code === "agent_connection_cancelled" || err.problem.code === "agent_connection_expired") {
      return clearDefinitivePendingAgentFailure(
        runtime,
        resolved,
        connection,
        err,
        err.problem.code === "agent_connection_cancelled"
          ? "The pending agent connection was cancelled before activation."
          : "The pending agent connection expired before activation.",
      );
    }
    throw err;
  }
  requirePrivateNoStore(activation.headers, "Agent activation response");
  const active = validateAgent(activation.body, "active");
  if (active.id !== agentId) throw configError("Activated agent does not match the collected credential.");
  let verified: Agent;
  try {
    verified = await verifyActiveAgent();
  } catch (err) {
    if (err instanceof CliError && err.problem.code === "unauthorized") {
      return clearDefinitivePendingAgentFailure(
        runtime,
        resolved,
        connection,
        err,
        "The collected agent credential was revoked before post-activation verification.",
      );
    }
    throw err;
  }
  await clearAgentConnection(runtime, resolved, connection.connection_id, false);
  return { agent: verified, requestId: client.requestId };
}

async function agentConnect(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  if (args.positionals.length !== 2) throw usageError("agent connect does not accept positional arguments.");
  requireFlagValue(args, "name", "Office MacBook Codex");
  requireFlagValue(args, "timeout", "600000");
  const name = flagString(args.flags, "name");
  if (name && name.length > 80) throw usageError("agent connect --name is at most 80 characters.");
  const requestedTimeout = flagNumber(args.flags, "timeout");
  if (flagString(args.flags, "timeout") !== undefined && requestedTimeout === undefined) {
    throw usageError("agent connect --timeout must be an integer from 1 to 600000 milliseconds.");
  }
  if (requestedTimeout !== undefined && (!Number.isInteger(requestedTimeout) || requestedTimeout <= 0 || requestedTimeout > 600_000)) {
    throw usageError("agent connect --timeout must be an integer from 1 to 600000 milliseconds.");
  }
  let current = await currentAgentConnectionConfig(resolved, runtime);
  let connection: AgentConnectionConfig;
  if (current?.token && current.agent_connection?.pending_agent_id) {
    const pending = current.agent_connection;
    publicAgentConnectionKey(pending.private_jwk);
    if (!pending.connection_id || !pending.connection_token || !pending.approval_url || !pending.expires_at) {
      throw configError("Persisted pending agent activation state is incomplete.");
    }
    const checked = validateAgentConnectionStart({
      connection_id: pending.connection_id,
      connection_token: pending.connection_token,
      approval_url: pending.approval_url,
      expires_at: pending.expires_at,
    }, resolved.apiUrl);
    connection = { ...pending, approval_url: checked.approval_url };
  } else {
    connection = await startOrResumeAgentConnection(args, runtime, resolved, name);
    current = await currentAgentConnectionConfig(resolved, runtime);
  }
  let pendingToken = current?.token;
  let pendingAgentId = connection.pending_agent_id;

  let opened = false;
  let printed = false;
  if (!(pendingToken && pendingAgentId)) {
    if (!connection.approval_url || !connection.connection_id || !connection.connection_token) {
      throw configError("Pending agent connection is incomplete.");
    }
    if (flagBool(args.flags, "print-url")) {
      emitAgentApprovalUrl(args, runtime, connection.approval_url);
      printed = true;
    } else {
      opened = await (runtime.openUrl?.(connection.approval_url) ?? Promise.resolve(false));
      if (!opened) {
        emitAgentApprovalUrl(args, runtime, connection.approval_url);
        printed = true;
      }
    }
    const expiresIn = Date.parse(connection.expires_at ?? "") - runtime.now().getTime();
    const timeoutMs = Math.max(1, Math.min(requestedTimeout ?? 600_000, Number.isFinite(expiresIn) ? expiresIn : 600_000));
    let status: AgentConnection;
    try {
      status = await waitForAgentConnectionApproval(args, runtime, resolved, connection, timeoutMs);
    } catch (err) {
      if (err instanceof CliError && err.problem.code === "agent_connection_cancelled") {
        return clearDefinitivePendingAgentFailure(
          runtime,
          resolved,
          connection,
          err,
          "The pending agent connection was cancelled while waiting for dashboard approval.",
        );
      }
      throw err;
    }
    if (status.status === "denied" || status.status === "expired" || status.status === "cancelled") {
      await clearAgentConnection(runtime, resolved, connection.connection_id, true);
      const code = status.status === "denied"
        ? "agent_connection_denied"
        : status.status === "cancelled"
          ? "agent_connection_cancelled"
          : "agent_connection_expired";
      const detail = status.status === "denied"
        ? "The dashboard user denied this agent connection."
        : status.status === "cancelled"
          ? "The pending agent connection was cancelled and its local private state was removed."
          : "The agent connection expired before approval.";
      throw new CliError(makeProblem(code, "Agent connection did not complete", status.status === "denied" ? 403 : 410, detail, {
        next: {
          command: "screenrig agent connect",
          reason: "Start a fresh passkey approval when another agent should be connected.",
        },
      }));
    }
    if (status.status === "connected") {
      throw configError("The server reports this connection as connected, but no durable local agent credential exists.");
    }
    if (status.status !== "approved") throw configError("Agent connection did not reach an approved state.");

    const collector = clientFor(runtime, args, resolved.apiUrl);
    let collectedResponse;
    try {
      collectedResponse = await collector.call({
        method: "POST",
        path: `/api/v1/agent-connections/${connection.connection_id}/credential`,
        headers: { authorization: `ScreenRig-Agent-Connect ${connection.connection_token}` },
      });
    } catch (err) {
      if (err instanceof CliError && ["agent_connection_cancelled", "agent_connection_expired", "agent_connection_invalid"].includes(err.problem.code)) {
        return clearDefinitivePendingAgentFailure(
          runtime,
          resolved,
          connection,
          err,
          err.problem.code === "agent_connection_cancelled"
            ? "The approved pending agent was cancelled before its credential could be collected."
            : "The pending connection can no longer deliver an agent credential.",
        );
      }
      throw err;
    }
    requirePrivateNoStore(collectedResponse.headers, "Agent credential collection response");
    const collected = collectedResponse.body as AgentCredentialCollection;
    const decrypted = decryptAgentCredential(collected, connection);
    pendingToken = decrypted.token;
    pendingAgentId = decrypted.agentId;
    const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
    await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
      current = await readConfigFile(resolved.configPath, fsLike);
      if (!current?.agent_connection || current.agent_connection.connection_id !== connection.connection_id) {
        throw configError("Pending agent connection changed before credential persistence.");
      }
      connection = { ...current.agent_connection, pending_agent_id: decrypted.agentId };
      await writeConfigAtomic(resolved.configPath, {
        ...current,
        api_url: current.api_url || resolved.apiUrl,
        token: decrypted.token,
        agent_id: decrypted.agentId,
        agent_connection: connection,
        updated_at: runtime.now().toISOString(),
      }, fsLike);
    });
  }

  if (!pendingToken || !pendingAgentId) throw configError("Pending agent credential is unavailable for activation.");
  let activated: { agent: Agent; requestId: string };
  activated = await activateCollectedAgent(args, runtime, resolved, connection, pendingToken, pendingAgentId);
  const agent = activated.agent;
  return {
    envelope: successEnvelope({
      status: "active",
      agent: safeAgentSummary(agent),
      connection_id: connection.connection_id,
      opened,
      approval_url_printed: printed,
    }, { request_id: activated.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent connected", [
      ["status", "active"],
      ["id", agent.id],
      ["name", agent.name],
      ["opened", opened ? "true" : "false"],
      ["approval_url_printed", printed ? "true" : "false"],
    ]),
  };
}

async function agentDisconnect(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  deprecated: boolean,
): Promise<CommandResult> {
  const invokedName = deprecated ? "auth revoke" : "agent disconnect";
  const warnings = deprecated ? [deprecatedWarning("disconnect")] : [];
  if (args.positionals.length !== 2) throw usageError(`${invokedName} does not accept positional arguments.`);
  if (!flagBool(args.flags, "yes")) {
    throw usageError(`${invokedName} requires --yes. It revokes only this agent and preserves the account, screens, content, and other agents.${deprecated ? " This command is deprecated; use screenrig agent disconnect." : ""}`, {
      command: "screenrig agent disconnect --yes",
      reason: "Run only after explicitly accepting revocation of this installation.",
    });
  }
  if (!resolved.token) throw usageError("No stored ScreenRig agent credential exists; nothing was changed.");
  if (resolved.agentConnection) throw usageError("Finish or let the pending agent connection expire before disconnecting it.");
  const token = resolved.token;
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  let agent: Agent | undefined;
  try {
    const current = await client.call({ method: "GET", path: "/api/v1/agents/self" });
    requirePrivateNoStore(current.headers, "Agent status response");
    agent = validateAgentSelfStatus(current.body).agent;
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.code !== "unauthorized") throw err;
  }
  const request: AgentDisconnectRequest = flagBool(args.flags, "allow-lockout") ? { allow_last_agent: true } : {};
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: deprecated ? "/api/v1/account/credential/revoke" : "/api/v1/agents/self/disconnect",
      ...(request.allow_last_agent ? { body: request } : {}),
    });
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError({
        ...err.problem,
        next: err.problem.code === "agent_lockout_risk"
          ? {
              command: "screenrig agent disconnect --yes --allow-lockout",
              reason: "Use only after confirming a registered dashboard passkey or explicitly accepting loss of this account.",
            }
          : {
              command: "screenrig agent disconnect --yes",
              reason: "Local credential state was retained. Retrying the exact disconnect is safe after an ambiguous response.",
            },
      }, err.exitCode);
    }
    throw err;
  }
  if (response.status !== 204 || response.body !== undefined) {
    throw configError("The agent disconnect endpoint did not return the required empty 204 response; local credential state was retained.");
  }
  requirePrivateNoStore(response.headers, "Agent disconnect response");

  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  try {
    await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
      const current = await readConfigFile(resolved.configPath, fsLike);
      if (!current?.token || current.token !== token) {
        throw configError("The stored agent credential changed before local disconnect cleanup.");
      }
      const lastAgent = agent ? {
        id: agent.id,
        name: agent.name,
        agent_type: agent.agent_type,
        state: "revoked" as const,
        revoked_at: runtime.now().toISOString(),
      } : current.last_agent;
      await writeConfigAtomic(resolved.configPath, preserveLogSocket(current, {
        api_url: current.api_url,
        ...(lastAgent ? { last_agent: lastAgent } : {}),
        updated_at: runtime.now().toISOString(),
      }), fsLike);
    });
  } catch (err) {
    throw configError(
      `The server disconnected this agent, but atomic local cleanup failed: ${redactText(err instanceof Error ? err.message : "unknown filesystem error")}. The retained credential no longer authorizes account operations.`,
      {
        command: "screenrig agent disconnect --yes",
        reason: "Retrying with the retained exact credential safely completes local cleanup.",
      },
    );
  }
  return {
    envelope: successEnvelope({
      status: "disconnected",
      local_credential_removed: true,
      account_preserved: true,
      screens_preserved: true,
      other_agents_preserved: true,
    }, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent disconnected", [
      ["local_credential", "removed"],
      ["account_screens_and_other_agents", "preserved"],
      ["reconnect", "run screenrig agent connect and approve with an existing dashboard passkey"],
      ...(deprecated ? [["deprecated", "use screenrig agent disconnect --yes"] as [string, string]] : []),
    ]),
  };
}

function isAuthenticatedCommand(group: string, action: string | undefined): boolean {
  const actions: Record<string, ReadonlySet<string | undefined>> = {
    account: new Set(["show"]),
    dashboard: new Set([undefined]),
    app: new Set(["upload", "list", "show"]),
    media: new Set(["upload", "show", "list", "delete", "update"]),
    playlist: new Set(["create", "update", "export", "import", "show", "get", "list", "delete"]),
    screen: new Set(["pair", "provision", "update", "list", "show", "assign", "set-timezone", "archive", "unarchive", "delete", "rotate-public-id", "toast", "screenshot"]),
    browser: new Set(["setup"]),
    kv: new Set(["get", "set", "delete", "list"]),
    comment: new Set(["show", "set", "delete"]),
    operations: new Set(["get", "wait", "cancel"]),
    events: new Set(["list", "follow"]),
    playback: new Set(["list"]),
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
  if (!claim.session_id || claim.status !== "claimed" || !screen?.id || !screen.public_id || screen.state !== "pairing_pending" || !screen.public_url) {
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

/**
 * Mints one single-use account dashboard link and hands it to the browser.
 *
 * The token rides the URL fragment, which no server sees, no access log
 * records, and no `Referer` header carries, so the whole URL is a credential.
 * The default path opens it and keeps it out of stdout entirely. The URL
 * reaches stdout as exactly one line in two cases: the opener could not start a
 * browser, or the operator asked for it with `--print-url` because the shell is
 * not on the machine with the browser. It is never written to a file, never
 * persisted in the config, and never repeated in a later command.
 */
async function dashboardCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  if (args.positionals.length > 1) {
    throw usageError("dashboard does not accept positional arguments.", {
      command: "screenrig dashboard",
      reason: "Mint one single-use dashboard link for the enrolled account and open it.",
    });
  }
  const printMode = flagBool(args.flags, "print-url");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "POST",
    path: "/api/v1/account/dashboard-links",
    idempotent: true,
  });
  requirePrivateNoStore(response.headers, "Dashboard link response");
  const link = validateDashboardLink(response.body as DashboardLink, resolved.apiUrl);
  const opened = printMode ? false : await (runtime.openUrl?.(link.url) ?? Promise.resolve(false));
  // Falling back is the only reason to print an unasked-for URL: the link
  // expires in ten minutes, and a link nobody can reach is worse than one line
  // of sensitive output the operator already chose to produce.
  const printed = printMode || !opened;
  const data = {
    expires_at: link.expiresAt,
    single_use: true,
    ...(printed ? { url: link.url } : {}),
    ...(printMode ? {} : { opened }),
  };
  const title = printMode
    ? "Single-use dashboard link"
    : opened
      ? "Dashboard link opened"
      : "Single-use dashboard link; no browser could be opened";
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(title, [
      ...(printed ? [["url", link.url] as [string, string]] : []),
      ["expires_at", link.expiresAt],
      ["validity", "single use, ten minutes from mint"],
      ["reissue", "run screenrig dashboard again for a fresh link"],
      ...(printMode ? [] : [["opened", opened ? "true" : "false"] as [string, string]]),
    ]),
  };
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
  options: { name?: string; explicit?: boolean } = {},
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  if (resolved.agentConnection) {
    throw configError("An agent connection is pending in this config.", {
      command: "screenrig agent connect",
      reason: "Resume and activate that agent credential before running account commands.",
    });
  }
  const suppliedEmail = flagString(args.flags, "email");
  const persistedEmail = resolved.enrollment?.email;
  if (persistedEmail && suppliedEmail !== undefined && enrollmentEmail(suppliedEmail) !== persistedEmail) {
    throw usageError("The pending enrollment is bound to a different contact email. Resume it without changing --email.");
  }
  const email = resolved.token && !resolved.enrollment
    ? undefined
    : persistedEmail ?? enrollmentEmail(suppliedEmail);
  try {
    return await ensureCredential({
      resolved,
      enrollmentEmail: email,
      runtime: {
        fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
        now: runtime.now,
        sleep: runtime.sleep,
      },
      enroll: async (state) => {
        const client = clientFor(runtime, args, resolved.apiUrl);
        const betaKey = flagString(args.flags, "beta-key") ?? nonemptyEnv(runtime.env.SCREENRIG_BETA_KEY);
        const request: CLIEnrollmentRequest = {
          client_id: state.clientId,
          email: state.email,
          ...(betaKey !== undefined ? { beta_key: betaKey } : {}),
          ...(options.name ? { name: options.name } : {}),
          ...(options.explicit ? { agent_type: "cli", platform: agentPlatform(), version: CLI_VERSION } : {}),
        };
        let response;
        try {
          response = await client.call({
            method: "POST",
            path: "/api/v1/enrollments",
            idempotent: true,
            idempotencyKey: state.idempotencyKey,
            body: request,
          });
        } catch (err) {
          if (err instanceof CliError && err.problem.code === "email_conflict") {
            throw new CliError({
              ...err.problem,
              title: "Contact email is already enrolled",
              detail: "That contact email belongs to another account. It cannot attach this installation or recover access.",
              errors: [],
              next: {
                command: "screenrig agent connect",
                reason: "Attach this installation to the existing account with dashboard passkey approval. Never retry enrollment with another address.",
              },
            }, err.exitCode, err.warnings);
          }
          throw err;
        }
        requirePrivateNoStore(response.headers, "Enrollment response");
        const enrollment = response.body as CLIEnrollment;
        const agent = validateAgent(enrollment.agent, "active");
        if (!enrollment.account?.id || enrollment.connection_ready !== false || !enrollment.token
          || !enrollment.issuance_id || !enrollment.issuance_expires_at) {
          throw usageError("Enrollment response does not match the generated CLIEnrollment contract.");
        }
        return {
          token: enrollment.token,
          accountId: enrollment.account.id,
          agentId: agent.id,
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
  } catch (err) {
    if (err instanceof CliError && err.problem.code === "email_conflict" && email) {
      const configFs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
      await withConfigLock(
        resolved.configPath,
        configFs,
        { sleep: runtime.sleep, now: () => runtime.now().getTime() },
        async () => {
          const current = await readConfigFile(resolved.configPath, configFs);
          if (!current?.token && current?.enrollment?.email === email) {
            const { enrollment: _enrollment, ...safeConfig } = current;
            await writeConfigAtomic(resolved.configPath, {
              ...safeConfig,
              updated_at: runtime.now().toISOString(),
            }, configFs);
          }
        },
      );
    }
    throw err;
  }
}

async function accountShow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/v1/account" });
  // Presence only. The lookup segment of a credential identifies the live
  // token, so no part of the stored value is reported on stdout.
  const envelope = jsonBody(response, client.requestId, { token_present: hasToken(token) });
  const account = response.body as Account;
  if (headerValue(response.headers, CREDITS_REMAINING_HEADER) === undefined) {
    observeCreditsRemaining(runtime, parseCreditsInteger(account.credit_remaining));
  }
  return {
    envelope,
    exitCode: ExitCode.Success,
    human: humanLines("Account", [
      ["id", account.id],
      ["revision", account.revision !== undefined ? String(account.revision) : undefined],
      ["credit_remaining", account.credit_remaining !== undefined ? String(account.credit_remaining) : undefined],
      ["token", describeTokenPresence(token)],
      ["request_id", client.requestId],
    ]),
  };
}

async function appPack(args: ParsedArgs, runtime: CliRuntime): Promise<CommandResult> {
  const dir = args.positionals[2];
  if (!dir) {
    throw usageError("app pack requires a directory.");
  }
  const result = await packDirectory(path.resolve(runtime.cwd(), dir), { logger: loggerOf(runtime) });
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
    logger: loggerOf(runtime),
  });
  const name = applicationNameFromArgs(args);
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
      ...(name ? { "screenrig-application-name": name } : {}),
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
        // The release id is the only handle a playlist placement accepts, so
        // report it here rather than making the caller read the operation
        // result to find it.
        ["release_id", body.release_id],
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
      ["release_id", body.release_id],
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
  query?: Record<string, string | undefined>,
): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: pathName, query });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `${title}\n${JSON.stringify(response.body, null, 2)}`,
  };
}

const MEDIA_TAG_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const APPLICATION_NAME_MAX = 120;
const PLAYBACK_DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function requireFlagValue(args: ParsedArgs, name: string, example: string): void {
  if (args.flags[name] === true) {
    throw usageError(`--${name} requires a value, such as --${name} ${example}.`);
  }
}

function mediaTagFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "tag", "lobby");
  const tag = flagString(args.flags, "tag");
  if (tag === undefined) {
    return undefined;
  }
  if (!MEDIA_TAG_PATTERN.test(tag)) {
    throw usageError("--tag must be 1 to 32 letters or digits.");
  }
  return tag;
}

function applicationNameFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "name", "Lobby board");
  const name = flagString(args.flags, "name");
  if (name === undefined) {
    return undefined;
  }
  if (name.length > APPLICATION_NAME_MAX || /[\r\n]/.test(name)) {
    throw usageError("--name must be at most 120 characters and must not contain a line break.");
  }
  return name;
}

function mediaKindFromArgs(args: ParsedArgs): "image" | "video" | undefined {
  requireFlagValue(args, "kind", "image");
  const kind = flagString(args.flags, "kind");
  if (kind === undefined) {
    return undefined;
  }
  if (kind !== "image" && kind !== "video") {
    throw usageError("--kind must be image or video.");
  }
  return kind;
}

function screenListStateFromArgs(args: ParsedArgs): "archived" | undefined {
  requireFlagValue(args, "state", "archived");
  const state = flagString(args.flags, "state");
  if (state === undefined) {
    return undefined;
  }
  if (state !== "archived") {
    throw usageError("--state must be archived.");
  }
  return state;
}

async function mediaCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  if (action === "list") {
    return simpleGet(args, runtime, resolved, "/api/v1/media", "Media", {
      tag: mediaTagFromArgs(args),
      kind: mediaKindFromArgs(args),
    });
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  if (action === "show") {
    const id = args.positionals[2];
    if (!id) throw usageError("media show requires an id.");
    return simpleGet(args, runtime, resolved, `/api/v1/media/${id}`, "Media");
  }
  if (action === "update") {
    return mediaUpdate(args, client);
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
    return loggerOf(runtime).withLocal({ op: "media.upload", message: "media upload" }, () =>
      mediaUpload(args, runtime, client),
    );
  }
  throw usageError("Unknown media command.");
}

async function mediaUpdate(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  const revision = flagString(args.flags, "if-match");
  const clearTag = flagBool(args.flags, "clear-tag");
  const tag = mediaTagFromArgs(args);
  if (!id || !revision) {
    throw usageError("media update requires <id>, --if-match, and --tag TAG or --clear-tag.");
  }
  if (clearTag === Boolean(tag)) {
    throw usageError("media update requires exactly one of --tag TAG or --clear-tag.");
  }
  const body: MediaTagPatch = { tag: clearTag ? null : tag ?? null };
  const response = await client.call({
    method: "PATCH",
    path: `/api/v1/media/${id}`,
    idempotent: true,
    headers: { "if-match": quotedRevision(revision) },
    body,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: clearTag ? `Cleared tag on media ${id}` : `Set tag ${tag} on media ${id}`,
  };
}

async function playbackList(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  requireFlagValue(args, "screen-id", "scr_01");
  requireFlagValue(args, "media-id", "med_01");
  requireFlagValue(args, "day", "2026-08-14");
  const screenId = flagString(args.flags, "screen-id");
  const mediaId = flagString(args.flags, "media-id");
  const day = flagString(args.flags, "day");
  if (screenId !== undefined && !screenId.startsWith("scr_")) {
    throw usageError("--screen-id must start with scr_.");
  }
  if (mediaId !== undefined && !mediaId.startsWith("med_")) {
    throw usageError("--media-id must start with med_.");
  }
  if (day !== undefined && !PLAYBACK_DAY_PATTERN.test(day)) {
    throw usageError("--day must be a UTC calendar day as YYYY-MM-DD.");
  }
  return simpleGet(args, runtime, resolved, "/api/v1/playback", "Playback", {
    screen_id: screenId,
    media_id: mediaId,
    day,
  });
}

function readyMediaId(operation: Operation): string | undefined {
  const mediaId = operation.result?.media_id;
  return typeof mediaId === "string" && mediaId.length > 0 ? mediaId : undefined;
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
    const tag = mediaTagFromArgs(args);
    if (tag !== undefined) {
      prepared.declaration.tag = tag;
    }
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
    const mediaId = readyMediaId(operation);
    const data = {
      ...(mediaId ? { media_id: mediaId, id: mediaId } : {}),
      operation,
      upload: {
        filename: prepared.declaration.filename,
        content_type: prepared.declaration.content_type,
        bytes: prepared.declaration.bytes,
        sha256: prepared.declaration.sha256,
        ...(prepared.declaration.tag ? { tag: prepared.declaration.tag } : {}),
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
        ["media_id", mediaId],
        ["operation_id", operation.id],
        ["state", operation.state],
        ["filename", prepared.declaration.filename],
        ["content_type", prepared.declaration.content_type],
        ["tag", prepared.declaration.tag],
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

const TOAST_LEVELS = new Set<ScreenToastLevel>(["error", "alert", "info"]);
const TOAST_DEFAULT_LEVEL: ScreenToastLevel = "info";
const TOAST_TEXT_MAX = 120;
const TOAST_MAX_LINES = 3;
const TOAST_DURATION_MIN = 2000;
const TOAST_DURATION_MAX = 60000;

const SCREEN_ID_PATTERN = /^scr_[A-Za-z0-9_-]+$/;
const PLAYLIST_PAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCREENSHOT_DEFAULT_WAIT_MS = 35_000;
const SCREENSHOT_DEFAULT_POLL_MS = 500;

function isScreenToastLevel(value: string): value is ScreenToastLevel {
  return TOAST_LEVELS.has(value as ScreenToastLevel);
}

function trimToastText(value: string): string {
  return value.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
}

function toastTextHasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function toastLineCount(value: string): number {
  if (value === "") {
    return 0;
  }
  return value.split("\n").length;
}

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
  if (action === "export") {
    requireFlagValue(args, "output", "./playlist-bundle");
    const id = args.positionals[2];
    const output = flagString(args.flags, "output");
    if (!id || !output || args.positionals.length !== 3) {
      throw usageError("playlist export requires <id> --output <directory>.");
    }
    const result = await exportPlaylistBundle({ playlistId: id, outputDirectory: path.resolve(runtime.cwd(), output), client });
    return {
      envelope: successEnvelope(result, { request_id: client.requestId }),
      exitCode: ExitCode.Success,
      human: humanLines("Playlist exported", [
        ["playlist_id", result.playlist_id],
        ["directory", result.directory],
        ["media_count", String(result.media_count)],
        ["media_bytes", String(result.media_bytes)],
      ]),
    };
  }
  if (action === "import") {
    requireFlagValue(args, "update", "pl_01");
    requireFlagValue(args, "if-match", "1");
    const directory = args.positionals[2];
    if (!directory || args.positionals.length !== 3) throw usageError("playlist import requires one <directory>.");
    const updateId = flagString(args.flags, "update");
    const ifMatch = flagString(args.flags, "if-match");
    const result = await importPlaylistBundle({
      directory: path.resolve(runtime.cwd(), directory),
      client,
      runtime,
      updateId,
      ifMatch,
      timeoutMs: flagNumber(args.flags, "timeout"),
      pollMs: flagNumber(args.flags, "poll-ms"),
      beforePlaylistWrite: async (playlist, targetId) => {
        if (targetId) await assertAssignedScreensHaveZone(client, targetId, playlist.pages);
      },
    });
    return {
      envelope: successEnvelope(result, { request_id: client.requestId }),
      exitCode: ExitCode.Success,
      human: humanLines(`Playlist ${result.mode === "create" ? "imported" : "updated from bundle"}`, [
        ["source_playlist_id", result.source_playlist_id],
        ["directory", result.directory],
        ["media_reused", String(result.media.reused)],
        ["media_uploaded", String(result.media.uploaded)],
      ]),
    };
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
    const pages = expandPlaylistPages(parsed.pages);
    const body = { name: parsed.name, pages };
    // A create has no assigned screen yet, so there is nothing to check. An
    // update can add a schedule to a playlist screens are already running.
    if (action === "update" && id) {
      await assertAssignedScreensHaveZone(client, id, pages);
    }
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

/**
 * A page schedule is civil, so it means nothing without a zone to read it in.
 * The server carries that zone on the screen and refuses assignment, playlist
 * update, and manifest resolution while a scheduled playlist points at a screen
 * that has none.
 *
 * Presence of the `visibility` key is the whole test, exactly as the server
 * counts it. A page that sets `enabled: false` still counts as scheduled.
 */
function usesPageVisibility(playlist: unknown): boolean {
  const pages = (playlist as { pages?: unknown } | undefined)?.pages;
  if (!Array.isArray(pages)) {
    return false;
  }
  return pages.some((page) => typeof page === "object" && page !== null && "visibility" in page);
}

function scheduleZoneError(screenId: string): CliError {
  return usageError(
    `Screen ${screenId} has no timezone, and the playlist schedules pages with visibility. Page visibility rules are civil times, so the screen needs an IANA zone before it can run them.`,
    {
      command: `screenrig --json screen set-timezone ${screenId} --timezone America/Los_Angeles --if-match REVISION`,
      reason: "Set the screen timezone first, then assign the playlist. Read the current revision from screen show.",
    },
  );
}

/**
 * Refuse a scheduled playlist locally before the PATCH goes out. The server
 * rejects the same pair, but it answers about a body the operator did not
 * write; naming the screen and the fixing command here is the difference
 * between a clear message and an opaque rejection.
 */
async function assertScheduledPlaylistHasZone(client: ApiClient, screenId: string, playlistId: string): Promise<void> {
  const playlist = await client.call({ method: "GET", path: `/api/v1/playlists/${playlistId}` });
  if (!usesPageVisibility(playlist.body)) {
    return;
  }
  const screen = await client.call({ method: "GET", path: `/api/v1/screens/${screenId}` });
  if ((screen.body as Screen | undefined)?.timezone) {
    return;
  }
  throw scheduleZoneError(screenId);
}

/**
 * The same rule reached from the playlist side. Adding visibility to a playlist
 * that screens already run breaks their manifests, so check every screen the
 * playlist is assigned to rather than waiting for rematerialize to refuse.
 */
async function assertAssignedScreensHaveZone(client: ApiClient, playlistId: string, pages: unknown): Promise<void> {
  if (!usesPageVisibility({ pages })) {
    return;
  }
  const response = await client.call({ method: "GET", path: "/api/v1/screens" });
  const items = (response.body as { items?: Screen[] } | undefined)?.items;
  if (!Array.isArray(items)) {
    return;
  }
  const unzoned = items.find((screen) => screen?.playlist_id === playlistId && !screen?.timezone);
  if (unzoned) {
    throw scheduleZoneError(unzoned.id);
  }
}

async function screenCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  if (action === "revoke-credential") {
    throw usageError("screen revoke-credential is retired. Archive the screen instead.", {
      command: "screenrig --json screen archive <id> --if-match REVISION",
      reason: "Archive hides the screen. It does not unbind the player. There is no account unbind.",
    });
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  if (action === "list") {
    return simpleGet(args, runtime, resolved, "/api/v1/screens", "Screens", {
      state: screenListStateFromArgs(args),
    });
  }
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
    const timezone = flagString(args.flags, "timezone");
    if (!id || !ifMatch || (!name && !playlistId && !timezone)) {
      throw usageError("screen update requires <id>, --if-match, and --name, --playlist-id, or --timezone.");
    }
    // A patch that sets both a playlist and a timezone satisfies the schedule
    // rule in one request, so only check when the patch leaves the screen
    // without one.
    if (playlistId && !timezone) {
      await assertScheduledPlaylistHasZone(client, id, playlistId);
    }
    const body: ScreenPatch = {
      ...(name ? { name } : {}),
      ...(playlistId ? { playlist_id: playlistId } : {}),
      ...(timezone ? { timezone } : {}),
    };
    const response = await client.call({ method: "PATCH", path: `/api/v1/screens/${id}`, idempotent: true, headers: { "if-match": quotedRevision(ifMatch) }, body });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Updated screen ${id}` };
  }
  if (action === "assign") {
    const id = args.positionals[2];
    const playlistId = flagString(args.flags, "playlist-id");
    const ifMatch = flagString(args.flags, "if-match");
    if (!id || !playlistId || !ifMatch) throw usageError("screen assign requires <id> --playlist-id --if-match.");
    await assertScheduledPlaylistHasZone(client, id, playlistId);
    const body: ScreenPatch = { playlist_id: playlistId };
    const response = await client.call({
      method: "PATCH",
      path: `/api/v1/screens/${id}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(ifMatch) },
      body,
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Assigned playlist ${playlistId} to ${id}` };
  }
  if (action === "set-timezone") {
    const id = args.positionals[2];
    const timezone = flagString(args.flags, "timezone");
    const ifMatch = flagString(args.flags, "if-match");
    if (!id || !timezone || !ifMatch) throw usageError("screen set-timezone requires <id> --timezone --if-match.");
    // The zone database belongs to the server, which validates the identifier
    // against it. Sending the value unchanged keeps one authority for what a
    // real zone is, so the CLI never carries a list that can go stale.
    const body: ScreenPatch = { timezone };
    const response = await client.call({
      method: "PATCH",
      path: `/api/v1/screens/${id}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(ifMatch) },
      body,
    });
    return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Set timezone ${timezone} on ${id}` };
  }
  if (action === "archive" || action === "unarchive") {
    const id = args.positionals[2];
    const revision = flagString(args.flags, "if-match");
    if (!id || !revision) throw usageError(`screen ${action} requires <id> and --if-match.`);
    const response = await client.call({
      method: "POST",
      path: `/api/v1/screens/${id}/${action}`,
      idempotent: true,
      headers: { "if-match": quotedRevision(revision) },
    });
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: action === "archive" ? `Archived screen ${id}` : `Unarchived screen ${id}`,
    };
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
  if (action === "rotate-public-id") {
    const id = args.positionals[2];
    const revision = flagString(args.flags, "if-match");
    if (!id || !revision) throw usageError("screen rotate-public-id requires <id> and --if-match.");
    const response = await client.call({
      method: "POST",
      path: `/api/v1/screens/${id}/public-id/rotate`,
      idempotent: true,
      headers: { "if-match": quotedRevision(revision) },
    });
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: `Rotated public id for ${id}`,
    };
  }
  if (action === "toast") {
    return screenToast(args, client);
  }
  if (action === "screenshot") {
    return loggerOf(runtime).withLocal({ op: "screenshot.capture", message: "screen screenshot" }, () =>
      screenScreenshot(args, runtime, client),
    );
  }
  throw usageError("Unknown screen command.");
}

async function screenToast(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  if (args.flags.level === true) {
    throw usageError("--level requires a value, such as --level info.");
  }
  if (args.flags.text === true) {
    throw usageError("--text requires a value.");
  }
  if (args.flags["duration-ms"] === true) {
    throw usageError("--duration-ms requires a value.");
  }
  const rawLevel = flagString(args.flags, "level");
  const rawText = flagString(args.flags, "text");
  if (!id || rawText === undefined) {
    throw usageError("screen toast requires <id> and --text TEXT.");
  }
  const level = rawLevel ?? TOAST_DEFAULT_LEVEL;
  if (!isScreenToastLevel(level)) {
    throw usageError("--level must be error, alert, or info. Agent toasts use --level info.");
  }
  const text = trimToastText(rawText);
  const textLength = [...text].length;
  if (
    textLength < 1
    || textLength > TOAST_TEXT_MAX
    || toastTextHasDisallowedControl(text)
    || toastLineCount(text) > TOAST_MAX_LINES
  ) {
    throw usageError(
      "Toast text must be 1 to 120 characters, use only line feed as a line break, and have at most three lines.",
    );
  }
  const body: ScreenToastWrite = { level, text };
  if (args.flags["duration-ms"] !== undefined) {
    const durationMs = flagNumber(args.flags, "duration-ms");
    if (
      durationMs === undefined
      || !Number.isInteger(durationMs)
      || durationMs < TOAST_DURATION_MIN
      || durationMs > TOAST_DURATION_MAX
    ) {
      throw usageError("--duration-ms must be an integer between 2000 and 60000.");
    }
    body.duration_ms = durationMs;
  }
  const response = await client.call({
    method: "POST",
    path: `/api/v1/screens/${id}/toast`,
    idempotent: true,
    body,
  });
  const accepted = (response.body ?? {}) as ScreenToastAccepted;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Toast accepted", [
      ["screen_id", id],
      ["level", level],
      ["expires_at", accepted.expires_at],
    ]),
  };
}

function isScreenId(value: string): boolean {
  return SCREEN_ID_PATTERN.test(value);
}

function screenshotUnavailable(requestId: string): CliError {
  return new CliError(
    makeProblem("screenshot_unavailable", "Screenshot is not available", 409, "Screenshot is not available.", {
      request_id: requestId,
    }),
  );
}

async function resolveScreenshotOutput(cwd: string, id: string, flags: ParsedArgs["flags"]): Promise<string> {
  if (flags.output === true) {
    throw usageError("--output requires a file path.");
  }
  const specified = flagString(flags, "output");
  const relative = specified ?? `./${id}.webp`;
  if (relative.endsWith("/") || relative.endsWith("\\")) {
    throw usageError("--output must be a file path, not a directory.");
  }
  const outputPath = path.resolve(cwd, relative);
  try {
    const existing = await stat(outputPath);
    if (existing.isDirectory()) {
      throw usageError("--output must be a file path, not a directory.");
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw usageError("--output must be a file path, not a directory.");
    }
  }
  return outputPath;
}

async function screenScreenshot(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id || !isScreenId(id)) {
    throw usageError("screen screenshot requires <id>.");
  }
  const outputPath = await resolveScreenshotOutput(runtime.cwd(), id, args.flags);
  const timeoutMs = flagNumber(args.flags, "timeout") ?? SCREENSHOT_DEFAULT_WAIT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw usageError("--timeout must be a non-negative number of milliseconds.");
  }
  if (args.flags["poll-ms"] !== undefined) {
    const pollMs = flagNumber(args.flags, "poll-ms");
    if (pollMs === undefined || !Number.isInteger(pollMs) || pollMs < 1) {
      throw usageError("--poll-ms must be a positive integer.");
    }
  }
  const pollMs = flagNumber(args.flags, "poll-ms") ?? SCREENSHOT_DEFAULT_POLL_MS;

  const acceptedResponse = await client.call({
    method: "POST",
    path: `/api/v1/screens/${id}/screenshot`,
    idempotent: true,
  });
  const accepted = (acceptedResponse.body ?? {}) as ScreenScreenshotAccepted;
  const captureId = accepted.capture_id;
  if (typeof captureId !== "string" || captureId.length === 0) {
    throw new CliError(
      makeProblem("invalid_request", "Request is invalid", 400, "Screenshot request did not return a capture_id.", {
        request_id: client.requestId,
      }),
    );
  }

  const deadline = Date.now() + timeoutMs;
  let status: ScreenScreenshotStatus | undefined;
  await loggerOf(runtime).withLocal(
    { op: "screenshot.wait", message: `wait for screenshot ${id}` },
    async (span) => {
      while (true) {
        const statusResponse = await client.call({
          method: "GET",
          path: `/api/v1/screens/${id}/screenshot/status`,
        });
        status = (statusResponse.body ?? {}) as ScreenScreenshotStatus;
        const currentId = status.capture_id;
        span.progress({ capture_id: currentId, state: status.state });
        if (typeof currentId === "string" && currentId.length > 0 && currentId !== captureId) {
          throw new CliError(
            makeProblem(
              "resource_conflict",
              "Resource state conflicts with the request",
              409,
              "A later screenshot request replaced this one.",
              { request_id: client.requestId },
            ),
          );
        }
        if (status.state === "ready" && currentId === captureId) {
          span.finish({ capture_id: captureId, state: status.state });
          return;
        }
        if (status.state === "timed_out" && currentId === captureId) {
          throw screenshotUnavailable(client.requestId);
        }
        if (Date.now() >= deadline) {
          throw screenshotUnavailable(client.requestId);
        }
        await runtime.sleep(pollMs);
      }
    },
  );

  const download = await client.call({
    method: "GET",
    path: `/api/v1/screens/${id}/screenshot`,
    query: { capture_id: captureId },
    headers: { accept: "image/webp" },
    binary: true,
  });
  const bytes = download.body;
  const contentType = download.headers["content-type"] ?? "";
  const digest = bytes instanceof Uint8Array ? createHash("sha256").update(bytes).digest("hex") : "";
  const reportedLength = download.headers["content-length"];
  const parsedLength = reportedLength !== undefined ? Number(reportedLength) : undefined;
  const lengthMatches =
    bytes instanceof Uint8Array
    && typeof status?.bytes === "number"
    && bytes.byteLength === status.bytes
    && (parsedLength === undefined || !Number.isFinite(parsedLength) || parsedLength === bytes.byteLength);
  const digestMatches = typeof status?.sha256 === "string" && status.sha256 === digest;
  const typeMatches = contentType.toLowerCase().startsWith("image/webp");
  if (
    !(bytes instanceof Uint8Array)
    || !typeMatches
    || !lengthMatches
    || !digestMatches
    || typeof status?.width !== "number"
    || typeof status.height !== "number"
  ) {
    throw new CliError(
      makeProblem(
        "invalid_request",
        "Request is invalid",
        400,
        "Screenshot download did not match the ready status metadata.",
        { request_id: client.requestId },
      ),
    );
  }

  const tempPath = `${outputPath}.${process.pid}.part`;
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, outputPath);
  } catch {
    await rm(tempPath, { force: true });
    throw usageError("Cannot write screenshot to the output path.");
  }

  const data = {
    screen_id: id,
    capture_id: captureId,
    path: outputPath,
    bytes: bytes.byteLength,
    sha256: digest,
    width: status.width,
    height: status.height,
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Screenshot saved", [
      ["screen_id", data.screen_id],
      ["capture_id", data.capture_id],
      ["path", data.path],
      ["bytes", String(data.bytes)],
      ["sha256", data.sha256],
      ["width", String(data.width)],
      ["height", String(data.height)],
    ]),
  };
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

function commentPath(target: "screen" | "playlist", id: string, pageId: string | undefined): string {
  if (target === "screen") {
    return `/api/v1/comment/screen/${encodeURIComponent(id)}`;
  }
  if (pageId) {
    return `/api/v1/comment/playlist/${encodeURIComponent(id)}/page/${encodeURIComponent(pageId)}`;
  }
  return `/api/v1/comment/playlist/${encodeURIComponent(id)}`;
}

async function commentCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  action: string | undefined,
): Promise<CommandResult> {
  if (action !== "show" && action !== "set" && action !== "delete") {
    throw usageError("Unknown comment command.");
  }
  const target = args.positionals[2];
  const id = args.positionals[3];
  if (target !== "screen" && target !== "playlist") {
    throw usageError("comment commands require screen <id> or playlist <id>.");
  }
  if (!id || (target === "screen" && !isScreenId(id))) {
    throw usageError(`comment ${action} ${target} requires <id>.`);
  }
  if (args.positionals.length > 4) {
    throw usageError(`comment ${action} ${target} does not accept extra arguments.`);
  }
  if (Object.hasOwn(args.flags, "if-match")) {
    throw usageError("comment commands do not take --if-match; last write wins and does not bump revision.");
  }
  requireFlagValue(args, "page", "poster");
  const pageId = flagString(args.flags, "page");
  if (target === "screen" && pageId !== undefined) {
    throw usageError("comment screen commands do not take --page; use comment playlist <id> --page PAGE_ID.");
  }
  if (pageId !== undefined && !PLAYLIST_PAGE_ID_PATTERN.test(pageId)) {
    throw usageError("--page must be a playlist page id: a letter, then up to 63 letters, digits, underscores, or hyphens.");
  }
  const pathName = commentPath(target, id, pageId);
  if (action === "show") {
    return simpleGet(args, runtime, resolved, pathName, "Comments");
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  if (action === "set") {
    const body = await commentsWriteFromArgs(args, runtime.cwd());
    const response = await client.call({
      method: "PUT",
      path: pathName,
      idempotent: true,
      body,
    });
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: humanLines("Comments set", [
        [target, id],
        ["page", pageId],
      ]),
    };
  }
  const response = await client.call({
    method: "DELETE",
    path: pathName,
    idempotent: true,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: pageId
      ? `Deleted comments on playlist ${id} page ${pageId}`
      : `Deleted comments on ${target} ${id}`,
  };
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

const CANNED_EVENT_MESSAGES = new Set([
  "Application emitted an event",
  "Runtime reported a bounded condition",
  "Player reported runtime status",
  "Screen screenshot requested",
  "Screen screenshot ready",
  "Screen screenshot failed",
  "Screenshot requested",
  "Screenshot ready",
  "Screenshot failed",
  "Stream cursor advanced",
  "Stream replay state is no longer retained",
]);

const SILENT_EVENT_TYPES = new Set(["application.event", "runtime.reported"]);

function isEventScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatLogfmtValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (!/[\s="]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function pushLogfmtField(parts: string[], key: string, value: unknown): boolean {
  if (!isEventScalar(value)) return false;
  if (isSensitiveKey(key)) return false;
  if (typeof value === "string") {
    if (value.length === 0 || isSensitiveValue(value)) return false;
  }
  parts.push(`${key}=${formatLogfmtValue(value)}`);
  return true;
}

/** One logfmt line per event. Undefined when there is nothing to print. */
export function formatEventLine(event: AccountEvent): string | undefined {
  const parts: string[] = [];
  const hasAt = pushLogfmtField(parts, "at", event.at);
  const hasType = pushLogfmtField(parts, "type", event.type);
  pushLogfmtField(parts, "severity", event.severity);

  let payload = 0;
  const resource = event.resource;
  if (resource) {
    if (pushLogfmtField(parts, "resource_type", resource.type)) payload += 1;
    if (pushLogfmtField(parts, "resource_id", resource.id)) payload += 1;
  }

  const details = event.details ?? {};
  const used = new Set<string>();
  for (const key of ["code", "placement_id"]) {
    if (!pushLogfmtField(parts, key, details[key])) continue;
    used.add(key);
    payload += 1;
  }
  for (const key of Object.keys(details).sort()) {
    if (used.has(key)) continue;
    if (pushLogfmtField(parts, key, details[key])) payload += 1;
  }

  const message = event.message ?? "";
  const detailCode = details.code;
  const canned = CANNED_EVENT_MESSAGES.has(message);
  const duplicate = message === event.type || (typeof detailCode === "string" && message === detailCode);
  if (message && !canned && !duplicate && pushLogfmtField(parts, "message", message)) {
    payload += 1;
  }

  if (!hasAt && !hasType) return undefined;
  if (SILENT_EVENT_TYPES.has(event.type) && payload === 0) return undefined;
  return parts.join(" ");
}

function formatEventLines(events: AccountEvent[]): string {
  return events
    .map((event) => formatEventLine(event))
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function eventsList(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/v1/events",
    query: {
      after: flagString(args.flags, "after") ?? flagString(args.flags, "cursor"),
      limit: flagString(args.flags, "limit"),
    },
  });
  const page = response.body as EventPage;
  const items = page.items ?? [];
  const human = formatEventLines(items);
  const safePage = redactEvent({ ...page, items });
  return {
    envelope: jsonBody({ ...response, body: safePage }, client.requestId),
    exitCode: ExitCode.Success,
    // main.ts writes JSON only when human is truthy; a space is a silent JSON gate.
    human: human || (args.flags.json === true ? " " : ""),
  };
}

/** First reconnect wait after a disconnect. Tests inject `runtime.sleep`. */
export const EVENT_STREAM_BACKOFF_MS = 250;
export const EVENT_STREAM_BACKOFF_CAP_MS = 15_000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 401/403/404 and other non-transient 4xx. 408/429/5xx/network retry. */
function isHardFollowError(err: unknown): boolean {
  if (!(err instanceof CliError)) {
    return false;
  }
  if (err.problem.code === "transport_error") {
    return false;
  }
  const status = err.problem.status;
  if (status === 408 || status === 429 || status >= 500 || status < 400) {
    return false;
  }
  return true;
}

async function sleepWhileOpen(
  ms: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function eventsFollow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const transport = transportFor(runtime, resolved.apiUrl, token);
  const json = args.flags.json === true;
  let printed = 0;
  let after = flagString(args.flags, "after") ?? flagString(args.flags, "cursor");
  let delayMs = EVENT_STREAM_BACKOFF_MS;
  const controller = new AbortController();
  const timeoutMs = flagNumber(args.flags, "timeout");
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const emit = (event: AccountEvent): void => {
    if (json) {
      printed += 1;
      runtime.stdout.write(`${JSON.stringify(successEnvelope(redactEvent(event), { request_id: client.requestId }))}\n`);
      return;
    }
    const line = formatEventLine(event);
    if (!line) return;
    printed += 1;
    runtime.stdout.write(`${line}\n`);
  };
  try {
    while (!controller.signal.aborted) {
      let buffer = "";
      let connected = false;
      try {
        const stream = await transport.stream({
          method: "GET",
          path: "/api/v1/events/stream",
          query: { after },
          headers: { "x-request-id": client.requestId, authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        connected = true;
        for await (const chunk of stream) {
          buffer += chunk;
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            if (event.id) {
              after = event.id;
            }
            if (!event.data) continue;
            try {
              emit(JSON.parse(event.data) as AccountEvent);
            } catch {
              // Unstructured frames are not event data.
            }
          }
          if (controller.signal.aborted) {
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          break;
        }
        if (isHardFollowError(err)) {
          throw err;
        }
      }
      if (controller.signal.aborted) {
        break;
      }
      await sleepWhileOpen(delayMs, controller.signal, runtime.sleep);
      if (controller.signal.aborted) {
        break;
      }
      delayMs = connected
        ? EVENT_STREAM_BACKOFF_MS
        : Math.min(delayMs * 2, EVENT_STREAM_BACKOFF_CAP_MS);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (printed === 0 && json) {
    runtime.stdout.write(`${JSON.stringify(successEnvelope({ items: [] }, { request_id: client.requestId }))}\n`);
  }
  return {
    envelope: successEnvelope({ items: [] }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: "",
  };
}

/**
 * `pass` is present and usable and `fail` is a defect the operator has to fix.
 * `warn` is an optional piece the CLI has a documented path without, so it is
 * reported without moving the exit code: a host that is missing nothing
 * required exits 0.
 */
type DoctorStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

function probeFailureDetail(err: unknown, fallback: string): string {
  if (err instanceof CliError) {
    return err.problem.detail;
  }
  return err instanceof Error ? redactText(err.message) : fallback;
}

async function doctor(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const checks: DoctorCheck[] = [];
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
    status: hasToken(resolved.token) ? "pass" : "fail",
    detail: describeTokenPresence(resolved.token),
  });
  checks.push({
    name: "api_url",
    status: resolved.apiUrl.startsWith("https://") || resolved.apiUrl.startsWith("http://127.") || resolved.apiUrl.includes("localhost") ? "pass" : "fail",
    detail: resolved.apiUrl,
  });
  checks.push({
    name: "log_socket",
    status: "pass",
    detail: resolved.logSocket ?? "(none)",
  });
  const lookup = ffmpegLookup(runtime.env);
  const webpLookup = cwebpLookup(runtime.env);
  let toolchain: FfmpegToolchain | undefined;
  let toolchainDetail: string | undefined;
  try {
    toolchain = await resolveFfmpegToolchain(runtime);
  } catch (err) {
    toolchainDetail = probeFailureDetail(err, "ffmpeg probe failed");
  }
  let cwebp: CwebpToolchain | undefined;
  let cwebpDetail: string | undefined;
  try {
    cwebp = await resolveCwebpToolchain(runtime);
  } catch (err) {
    cwebpDetail = probeFailureDetail(err, "cwebp probe failed");
  }
  // WebP stills have two independent encoders: ffmpeg's libwebp, and the
  // `cwebp` binary the image planner falls back to. Neither is required on its
  // own, so each is a warning while the other is usable, and the pair fails
  // only when the CLI has no way to produce WebP at all. `undefined` means the
  // ffmpeg probe never answered, which the ffmpeg check already reports.
  const libwebp = toolchain?.encoders.has("libwebp");
  const webpEncodable = libwebp === true || cwebp !== undefined;

  if (toolchain) {
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
    const encoders = toolchain.encoders;
    checks.push({
      name: "encoder_libx264",
      status: encoders.has("libx264") ? "pass" : "fail",
      detail: encoders.has("libx264")
        ? "libx264 available"
        : "libx264 missing from this ffmpeg build; the default video profile cannot encode",
    });
    checks.push({
      name: "encoder_libx265",
      status: encoders.has("libx265") ? "pass" : "warn",
      detail: encoders.has("libx265")
        ? "libx265 available"
        : "libx265 missing from this ffmpeg build; --codec hevc is unavailable",
    });
    checks.push({
      name: "encoder_libwebp",
      status: encoders.has("libwebp") ? "pass" : webpEncodable ? "warn" : "fail",
      detail: encoders.has("libwebp")
        ? "libwebp available"
        : "libwebp missing from this ffmpeg build; animation cannot be encoded",
    });
    const tonemap = toolchain.filters.has("zscale") && toolchain.filters.has("tonemap");
    checks.push({
      name: "filter_hdr_tonemap",
      status: tonemap ? "pass" : "warn",
      detail: tonemap
        ? "zscale and tonemap available"
        : "zscale or tonemap missing; HDR sources convert without tone mapping",
    });
  } else {
    checks.push({ name: "ffmpeg", status: "fail", detail: toolchainDetail ?? "ffmpeg probe failed" });
  }

  if (cwebp) {
    checks.push({
      name: "cwebp",
      status: "pass",
      detail: `${cwebp.cwebp} ${cwebp.version}${cwebp.fromEnv ? " (SCREENRIG_CWEBP)" : ""}`,
    });
  } else {
    const missing =
      cwebpDetail ?? `${webpLookup.cwebp} not available${webpLookup.cwebpFromEnv ? " (SCREENRIG_CWEBP)" : ""}`;
    if (libwebp === true) {
      checks.push({
        name: "cwebp",
        status: "warn",
        detail: `${missing}; not required because this ffmpeg build has the libwebp encoder`,
      });
    } else if (libwebp === false) {
      checks.push({
        name: "cwebp",
        status: "fail",
        detail:
          `${missing}; this ffmpeg build has no libwebp encoder either, so image transcode cannot produce WebP. ` +
          "Install an ffmpeg built with libwebp, or install cwebp on PATH (or set SCREENRIG_CWEBP).",
      });
    } else {
      checks.push({
        name: "cwebp",
        status: "warn",
        detail: `${missing}; it is the fallback for an ffmpeg build without libwebp, so fix ffmpeg first`,
      });
    }
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
          // An optional server feature, so its absence is not a local defect.
          status: supported ? "pass" : "warn",
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
  const warned = checks.some((check) => check.status === "warn");
  const status: DoctorStatus = failed ? "fail" : warned ? "warn" : "pass";
  return {
    envelope: successEnvelope({ status, checks, version: CLI_VERSION }),
    exitCode: failed ? ExitCode.Unexpected : ExitCode.Success,
    human: checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n"),
  };
}

export type { Operation };
