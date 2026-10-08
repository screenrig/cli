import { ExitCode, exitCodeForStatus } from "./exit-codes.js";
import type { NormalizedProblem, ProblemNext, Warning } from "./envelope.js";
import { redactText, redactValue } from "./redact.js";

const PROBLEM_BASE = "https://screenrig.ai/problems";

export class CliError extends Error {
  readonly problem: NormalizedProblem;
  readonly exitCode: ExitCode;
  readonly warnings: Warning[];

  constructor(problem: NormalizedProblem, exitCode?: ExitCode, warnings: Warning[] = []) {
    super(problem.detail || problem.title);
    this.name = "CliError";
    this.problem = problem;
    this.exitCode = exitCode ?? exitCodeForStatus(problem.status);
    this.warnings = warnings;
  }
}

export function problemType(code: string): string {
  return `${PROBLEM_BASE}/${code.replaceAll("_", "-")}`;
}

export function makeProblem(
  code: string,
  title: string,
  status: number,
  detail: string,
  extras?: Partial<NormalizedProblem>,
): NormalizedProblem {
  return {
    type: extras?.type ?? problemType(code),
    title,
    status,
    detail,
    ...(extras?.hint ? { hint: extras.hint } : {}),
    instance: extras?.instance,
    code,
    request_id: extras?.request_id,
    operation_id: extras?.operation_id,
    current_revision: extras?.current_revision,
    errors: extras?.errors ?? [],
    next: extras?.next,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  return value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2048)
    ? (value as string[])
    : undefined;
}

function asNext(value: unknown): ProblemNext | undefined {
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  const command = asString(rec.command);
  const reason = asString(rec.reason);
  if (!command || !reason) {
    return undefined;
  }
  const argv = asArgv(rec.argv);
  return argv ? { command, reason, argv } : { command, reason };
}

/**
 * The flat view of a problem document. The API puts the error itself in
 * `errors[0]` (status, code, type, title, detail, hint, and current_revision,
 * next, or retryable where they apply) and keeps only document members
 * (action, instance, request_id, server_time, trace_id) at the top level. The
 * runtime routes, operation errors, and older servers carry every member at
 * the top level. Either way the result reads the same; errors[] entries that
 * name a request field stay in `errors` as `{field, detail}`.
 */
export function flattenProblemDocument(rec: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!rec || !Array.isArray(rec.errors) || asString(rec.code) !== undefined) {
    return rec;
  }
  const first = asRecord(rec.errors[0]);
  if (!first || !(asString(first.code) || asString(first.detail) || asString(first.title))) {
    return rec;
  }
  const fields = rec.errors
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined && asString(entry.field) !== undefined)
    .map((entry) => (asString(entry.detail) ? { field: entry.field, detail: entry.detail } : { field: entry.field }));
  return { ...rec, ...first, errors: fields };
}

/** The stable problem code of a response body in either problem document shape. */
export function problemCodeOf(body: unknown): string | undefined {
  return asString(flattenProblemDocument(asRecord(body))?.code);
}

/** A problem document names at least its code, title, or detail. Anything else is a foreign body. */
function isProblemDocument(rec: Record<string, unknown> | undefined): rec is Record<string, unknown> {
  return Boolean(rec && (asString(rec.code) || asString(rec.detail) || asString(rec.title)));
}

const BODY_SNIPPET_CHARS = 300;

/** A short, single-line, redacted excerpt of a response body. */
export function bodySnippet(text: string | undefined): string | undefined {
  const flat = text === undefined ? "" : redactText(text).replace(/\s+/g, " ").trim();
  if (!flat) {
    return undefined;
  }
  return flat.length > BODY_SNIPPET_CHARS ? `${flat.slice(0, BODY_SNIPPET_CHARS)}…` : flat;
}

/** Hint for an HTTP error whose body is not a screenRIG problem document (a proxy page, an empty body). */
function foreignBodyHint(status: number): string {
  if (status >= 500 || status === 408 || status === 429) {
    return "Something between the CLI and the API (a proxy, gateway, or load balancer) answered instead of screenRIG. Wait a minute and retry; if it keeps happening, check --api-url with screenrig doctor and report the request_id with screenrig feedback bug.";
  }
  return "The answer did not come from the screenRIG API, so the request was probably not processed. Check --api-url and any proxy with screenrig doctor, then retry; if it keeps happening, report the request_id with screenrig feedback bug.";
}

export function normalizeProblem(
  input: unknown,
  fallback: { status?: number; request_id?: string; bodyText?: string } = {},
): NormalizedProblem {
  const redacted = flattenProblemDocument(asRecord(redactValue(input)));
  const rec = isProblemDocument(redacted) ? redacted : undefined;
  const status = asNumber(rec?.status) ?? fallback.status ?? 500;
  const code =
    asString(rec?.code) ??
    (status === 401 ? "unauthorized" : status >= 500 ? "internal_error" : "http_error");
  // An HTTP answer that is not a problem document (HTML from a proxy, an empty
  // body, unrelated JSON) still reaches the caller: status, request_id and a
  // bounded, redacted excerpt of what actually came back.
  const foreign = !rec && fallback.bodyText !== undefined;
  const snippet = foreign ? bodySnippet(fallback.bodyText) : undefined;
  const title = asString(rec?.title) ?? (foreign ? "Unexpected error response" : "Request failed");
  const detail =
    asString(rec?.detail) ??
    (foreign
      ? snippet
        ? `HTTP ${status} answered with a body that is not a screenRIG problem document: ${snippet}`
        : `HTTP ${status} answered with an empty body.`
      : title);
  const errors = Array.isArray(rec?.errors) ? rec.errors : [];
  const missingCapability = status === 403 && code === "forbidden"
    ? /^This agent credential lacks the (screens|content|playlists|advertising|reports|project) capability\.$/.exec(detail)?.[1]
    : undefined;
  const hint = asString(rec?.hint) ?? (foreign ? foreignBodyHint(status) : undefined);
  const retryable = typeof rec?.retryable === "boolean" ? rec.retryable : undefined;
  const traceId = asString(rec?.trace_id);
  return {
    type: asString(rec?.type) ?? problemType(code),
    title,
    status,
    detail,
    ...(hint ? { hint } : {}),
    instance: asString(rec?.instance),
    code,
    request_id: asString(rec?.request_id) ?? fallback.request_id,
    ...(traceId ? { trace_id: traceId } : {}),
    operation_id: asString(rec?.operation_id),
    current_revision: asNumber(rec?.current_revision),
    ...(retryable !== undefined ? { retryable } : {}),
    errors,
    // The server's own next action always wins over local guidance.
    next: asNext(rec?.next) ?? (missingCapability ? {
      command: `screenrig agent connect --capability ${missingCapability} --config NEW_PRIVATE_CONFIG`,
      reason: `Connect a new agent with the ${missingCapability} capability and approve it in the dashboard. Repeat --capability for every permission needed. Capabilities are immutable; use a separate private config, then disconnect the old agent after verifying the new one.`,
    } : undefined),
  };
}

/**
 * Field-level server guidance, rendered so an agent can act on it. The server
 * rejects rather than redacts text that matches a credential shape, and this is
 * how the operator learns which field to rewrite. Entries are already redacted
 * by `normalizeProblem`.
 */
function renderProblemError(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry.length > 0 ? entry : undefined;
  }
  const rec = asRecord(entry);
  if (!rec) {
    return undefined;
  }
  const field = asString(rec.field) ?? asString(rec.pointer) ?? asString(rec.name);
  const message = asString(rec.detail) ?? asString(rec.message) ?? asString(rec.reason);
  const code = asString(rec.code);
  const suffix = code && message ? ` (${code})` : "";
  if (field && message) {
    return `${field}: ${message}${suffix}`;
  }
  return message ? `${message}${suffix}` : field ?? JSON.stringify(rec);
}

export function renderProblem(problem: NormalizedProblem): string {
  const lines = [`${problem.title} (${problem.code}/${problem.status})`, problem.detail];
  for (const entry of problem.errors) {
    const rendered = renderProblemError(entry);
    if (rendered) {
      lines.push(`- ${rendered}`);
    }
  }
  if (problem.hint) {
    lines.push(`hint: ${problem.hint}`);
  }
  if (problem.request_id) {
    lines.push(`request_id: ${problem.request_id}`);
  }
  if (problem.trace_id) {
    lines.push(`trace_id: ${problem.trace_id}`);
  }
  if (problem.operation_id) {
    lines.push(`operation_id: ${problem.operation_id}`);
  }
  if (typeof problem.current_revision === "number") {
    lines.push(`current_revision: ${problem.current_revision}`);
  }
  if (typeof problem.retryable === "boolean") {
    lines.push(`retryable: ${problem.retryable}`);
  }
  if (typeof problem.retry_after_seconds === "number") {
    lines.push(`retry_after_seconds: ${problem.retry_after_seconds}`);
  }
  if (problem.next) {
    lines.push(`next: ${problem.next.command}`);
    lines.push(`      ${problem.next.reason}`);
    if (problem.next.argv) {
      lines.push(`      argv: ${JSON.stringify(problem.next.argv)}`);
    }
    if (problem.next.after_inspection) {
      lines.push(`      after inspection: ${problem.next.after_inspection.command}`);
      lines.push(`      ${problem.next.after_inspection.reason}`);
    }
  }
  return lines.join("\n");
}

/** `Retry-After` in seconds, per RFC 9110. An HTTP-date form is also accepted. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  if (/^\d+$/.test(text)) {
    const seconds = Number.parseInt(text, 10);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

export function describeRetryInterval(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * Local guidance for an older server that sends no `hint` or `next`. Each
 * member is filled only when the server left it empty; server guidance always
 * wins.
 */
function withGuidance(problem: NormalizedProblem, guidance: { hint?: string; next?: ProblemNext }): NormalizedProblem {
  const hint = problem.hint ?? guidance.hint;
  const next = problem.next ?? guidance.next;
  return {
    ...problem,
    ...(hint ? { hint } : {}),
    ...(next ? { next } : {}),
  };
}

/**
 * A bare 429 tells an agent nothing actionable. The server declares
 * `Retry-After` on every rate-limited response, so fold it into the detail and
 * the next-action guidance instead of discarding the header.
 */
export function withRetryAfter(problem: NormalizedProblem, retryAfterSeconds: number | undefined): NormalizedProblem {
  if (retryAfterSeconds === undefined) return problem;
  // A 503 may also name its wait; keep it for callers that retry on their own.
  if (problem.status === 503) return { ...problem, retry_after_seconds: retryAfterSeconds };
  if (problem.status !== 429) {
    return problem;
  }
  const interval = describeRetryInterval(retryAfterSeconds);
  const detail = problem.detail.includes("Retry-After")
    ? problem.detail
    : `${problem.detail} Retry-After is ${retryAfterSeconds} seconds.`;
  return withGuidance({ ...problem, detail, retry_after_seconds: retryAfterSeconds }, {
    hint: `Wait ${interval}, then run the same command again. Do not retry sooner; each early retry is refused too.`,
    next: {
      command: "retry the same command",
      reason: `The project rate limit is in effect. Wait ${interval} before retrying.`,
    },
  });
}

/**
 * A custom storage ceiling, when present, is checked before the 1 GiB
 * transport bound, so `quota_exceeded` is still the limit a user meets on that
 * path. Point at the command that reports used_bytes and content_limit_bytes,
 * unless the server already supplied its own guidance.
 */
export function withQuotaGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (problem.code !== "quota_exceeded") {
    return problem;
  }
  return withGuidance(problem, {
    hint: "The project is at its storage limit. Delete media or applications that are no longer used (screenrig media list, then screenrig media delete ID), or upload a smaller file, then retry.",
    next: {
      command: "screenrig project show",
      reason: "Read used_bytes and content_limit_bytes, then free space or upload a smaller file.",
    },
  });
}

/** Both 402 codes: prepaid credit is spent, or eligible credit cannot cover this debit. */
const PAYMENT_CODES = new Set(["payment_required", "insufficient_credits"]);

/**
 * A 402 means this operation needs credit the project does not have. Retrying
 * the same billed operation is refused the same way, so tell the agent to stop,
 * tell the user, and carry on by other means. Do not invent a pay command.
 */
export function withPaymentGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (!PAYMENT_CODES.has(problem.code)) {
    return problem;
  }
  return withGuidance(problem, {
    hint: "This operation needs credit the project does not have, so retrying it is refused the same way. Stop retrying it, tell the user it was refused for lack of credit, and continue the task by other means where you can: for an image, create it with your own tools and add it with screenrig media upload.",
    next: {
      command: "screenrig billing balance",
      reason: "Shows remaining, reserved, and available credits so you can tell the user exactly what is left.",
    },
  });
}

/**
 * The fallback hint for a problem that reached the output boundary without
 * one: CLI-originated errors, and answers from a server that sends no hint.
 * Server hints are never replaced.
 */
const DEFAULT_HINTS: Record<string, string> = {
  usage_error: "Fix the argument or input named in detail and run the command again. Add --help to the command to see its arguments, accepted values, and an example.",
  not_enrolled: "This installation has no active agent credential. Run the next command, then run the original command again.",
  unauthenticated: "This installation has no active agent credential. Run the next command, then run the original command again.",
  config_error: "Fix the configuration named in detail, or pass --config with a different private config file. screenrig doctor checks the configuration without sending requests.",
  file_error: "Check that the target directory exists, is writable, and has free space, or choose a different output path, then run the command again.",
  unexpected_response: "The API answered with something the CLI cannot use, often a proxy or gateway page. Check --api-url with screenrig doctor and retry; if it keeps happening, report the request_id with screenrig feedback bug.",
  transport_error: "The CLI could not reach the API. Check network connectivity and the configured API with screenrig doctor, then run the command again.",
  timeout: "The request did not finish in time. Reads are safe to rerun, optionally with a larger --timeout. A write may already have happened: inspect the resource before changing it again.",
  unexpected_error: "The CLI hit an internal error. Run the command again; if it keeps happening, report the command (without secrets) with screenrig feedback bug.",
  operation_failed: "The server finished the operation with an error. Read detail, fix the input it names, and start the command again; screenrig operations show OPERATION_ID shows the stored result.",
  invalid_request: "The server rejected the request as invalid. Read detail and errors[] for the field to change, fix it, and send the request again; the unchanged request is refused the same way.",
  unauthorized: "The stored credential was not accepted, so this installation's project is gone. Clear it with screenrig agent disconnect --yes, then create a new project with screenrig agent enroll --email ADDRESS --organization NAME. Use screenrig agent connect only when the user asked to join an existing project.",
  credential_revoked: "A project member revoked this agent credential. Tell the user; with their approval, screenrig agent connect asks to rejoin that project, or screenrig agent enroll --email ADDRESS --organization NAME creates a new one.",
  forbidden: "This credential is not allowed to do this. Do not retry it unchanged; screenrig agent status lists the granted capabilities.",
  capability_required: "This project does not have the capability this command needs. Do not retry; tell the user, who can change the project's purpose in the dashboard.",
  capability_unavailable: "The project's capabilities could not be read, so the write was not attempted. Retry shortly; screenrig project capabilities checks them directly.",
  not_found: "Nothing with that id exists in this project. Check the id with the matching list command (for example screenrig screen list) and use an id from its output.",
  method_not_allowed: "This CLI sent a request the API does not accept. Update the CLI to the current release, then retry.",
  idempotency_mismatch: "This idempotency key was already used for a different request. Rerun without --idempotency-key, or with a new key; screenrig recovery list shows saved keys from interrupted writes.",
  resource_conflict: "The resource is not in a state that allows this change. Inspect it with its show command, then retry only once its state allows the change.",
  revision_conflict: "The resource changed since you read it. Show it again, reconcile your change with the current state, and retry with --expect-rev set to the new revision.",
  screen_archived: "This screen is archived. Run screenrig screen unarchive ID first if it should be used again.",
  application_in_use: "A playlist still uses this application. Remove it from those playlists, then retry.",
  rate_limited: "Too many requests. Wait before retrying; retry_after_seconds says how long when the server sent it.",
  quota_exceeded: "The project is at a limit. Free space or use a smaller input, then retry.",
  feature_unavailable: "This project cannot use this feature. Do not retry; tell the user.",
  not_ready: "The resource is still being prepared. Wait a few seconds and retry, or follow its operation with screenrig operations wait OPERATION_ID.",
  internal_error: "The server failed while handling the request. If retryable is true, wait a moment and retry; otherwise report the request_id with screenrig feedback bug.",
  dependency_unavailable: "A service the API depends on is unavailable. Wait a minute and retry the same command.",
  dependency_timeout: "A service the API depends on timed out. Wait a minute and retry the same command.",
  server_draining: "The server is restarting. Retry the same command in a few seconds.",
};

function statusHint(problem: NormalizedProblem): string {
  if (problem.status >= 500) {
    return problem.retryable === false
      ? "The server could not complete this request, and repeating it unchanged will not help. Report the request_id with screenrig feedback bug."
      : "The server could not complete this request. Wait a minute and retry the same command; if it keeps failing, report the request_id with screenrig feedback bug.";
  }
  return "The server refused this request; detail says why. Change what it names before trying again, because the unchanged request is refused the same way.";
}

/** Fill `hint` when nothing upstream supplied one. Never replaces an existing hint. */
export function withDefaultHint(problem: NormalizedProblem): NormalizedProblem {
  if (problem.hint) {
    return problem;
  }
  return { ...problem, hint: DEFAULT_HINTS[problem.code] ?? statusHint(problem) };
}

export function usageError(detail: string, next?: ProblemNext, hint?: string): CliError {
  return new CliError(
    makeProblem("usage_error", "Invalid command usage", 400, detail, {
      next,
      hint,
    }),
    ExitCode.Usage,
  );
}

/**
 * This installation holds no usable agent credential. Enrollment is explicit and
 * is never a side effect of another command, so every authenticated command
 * fails with this stable code and a `next.command` an agent can run directly.
 * `not_enrolled` is the same machine token `agent status` reports.
 */
export function notEnrolledError(detail: string, next?: ProblemNext): CliError {
  return new CliError(
    makeProblem("not_enrolled", "Installation is not enrolled", 401, detail, { next }),
    ExitCode.Auth,
  );
}

export function configError(detail: string, next?: ProblemNext, hint?: string): CliError {
  return new CliError(
    makeProblem("config_error", "Configuration error", 400, detail, { next, hint }),
    ExitCode.Config,
  );
}

/** A local output file could not be written (ENOSPC, EACCES, ...). */
export function fileError(detail: string, error?: unknown): CliError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const hint = code === "ENOSPC"
    ? "The disk is full. Free space or choose an output path on another disk, then run the command again."
    : code === "EACCES" || code === "EPERM" || code === "EROFS"
      ? "This process cannot write there. Choose an output path in a directory you can write, then run the command again."
      : code === "ENOENT" || code === "ENOTDIR"
        ? "The target directory does not exist. Create it or choose another output path, then run the command again."
        : undefined;
  return new CliError(
    makeProblem("file_error", "Cannot write the output file", 500, code ? `${detail} (${code})` : detail, { hint }),
    ExitCode.Unexpected,
  );
}

/** A 2xx that is not the representation the contract names (a proxy page, JSON for CSV, an empty body). */
export function unexpectedResponseError(detail: string, request_id?: string, hint?: string): CliError {
  return new CliError(
    makeProblem("unexpected_response", "Unexpected response", 502, detail, { request_id, hint }),
    ExitCode.Unexpected,
  );
}

export function networkError(detail: string, request_id?: string, hint?: string): CliError {
  return new CliError(
    makeProblem("transport_error", "Network error", 503, detail, {
      request_id,
      hint,
      next: { command: "screenrig doctor", reason: "Shows the configured API origin and credential without sending requests, so you can check where the CLI is connecting." },
    }),
    ExitCode.Network,
  );
}

export function timeoutError(detail: string, request_id?: string, hint?: string): CliError {
  return new CliError(
    makeProblem("timeout", "Timed out", 408, detail, { request_id, hint }),
    ExitCode.Timeout,
  );
}
