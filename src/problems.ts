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
    ...(extras?.display ? { display: extras.display } : {}),
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

/** Keep only the documented display context; missing freshness is not a current report. */
export function reportedDisplayOf(value: unknown): NormalizedProblem["display"] {
  const display = asRecord(value);
  const reportedAt = asString(display?.reported_at);
  if (!reportedAt || !Number.isFinite(Date.parse(reportedAt)) || typeof display?.stale !== "boolean") return undefined;
  const power = display.power === "on" || display.power === "off" || display.power === "standby" || display.power === "unknown" ? display.power : undefined;
  return {
    ...(power ? { power } : {}),
    ...(typeof display.connected === "boolean" ? { connected: display.connected } : {}),
    reported_at: reportedAt,
    stale: display.stale,
  };
}

function asArgv(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    return undefined;
  }
  return value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2048)
    ? (value as string[])
    : undefined;
}

const NEXT_COMMAND_MAX_CHARS = 2048;

/**
 * The words of a command line made only of literal words, or undefined when a
 * shell would interpret any of it: lists, pipes, redirects, substitutions,
 * expansions, globs, comments, escapes of control characters. Quotes group
 * words (single quotes literally, double quotes without `$`, backtick or
 * backslash), the way `shellQuote` writes them.
 */
export function literalCommandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: string | undefined;
  const chars = Array.from(command);
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      return undefined;
    }
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "$" || ch === "`" || ch === "\\" || ch === "!") return undefined;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === " ") {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
    } else if (ch === "\\") {
      // Only an escaped quote (the middle of the '\'' that shellQuote writes for an embedded quote) is literal.
      const escaped = chars[i + 1];
      if (escaped !== "'") return undefined;
      current += escaped;
      inWord = true;
      i += 1;
    } else if (/^[A-Za-z0-9_./:=@%+,-]$/.test(ch)) {
      current += ch;
      inWord = true;
    } else {
      return undefined;
    }
  }
  if (quote !== undefined) {
    return undefined;
  }
  if (inWord) {
    words.push(current);
  }
  return words;
}

/**
 * A server `next` is a command for the agent to run, so it is accepted only
 * as a plain `screenrig` command line: literal words, the executable named
 * `screenrig`, and `argv` (the words after the executable) matching the text.
 * Anything else is dropped, and the caller falls back to the CLI's own guidance.
 */
function asNext(value: unknown): ProblemNext | undefined {
  const rec = asRecord(value);
  if (!rec) {
    return undefined;
  }
  const command = asString(rec.command);
  const reason = asString(rec.reason);
  if (!command || !reason || command.length > NEXT_COMMAND_MAX_CHARS) {
    return undefined;
  }
  const words = literalCommandWords(command);
  if (!words || words[0] !== "screenrig") {
    return undefined;
  }
  const argv = asArgv(rec.argv);
  if (!argv) {
    return { command, reason };
  }
  const rest = words.slice(1);
  return argv.length === rest.length && argv.every((word, index) => word === rest[index]) ? { command, reason, argv } : undefined;
}

/**
 * The flat view of a problem document. The API puts the error itself in
 * `errors[0]` (status, code, type, title, detail, hint, and current_revision,
 * next, or retryable where they apply) and keeps only document members
 * (action, instance, request_id, server_time, trace_id) at the top level. The
 * runtime routes and operation errors carry every member at the top level.
 * Either way the result reads the same; errors[] entries that name a request
 * field stay in `errors` as `{field, detail}`.
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

/** The scope an outside_upload_scope answer names: lists of ids, kept only when they are. */
function uploadScopeOf(value: unknown): NormalizedProblem["upload_scope"] {
  const scope = asRecord(value);
  const ids = (list: unknown): string[] | undefined => Array.isArray(list) && list.every((id) => typeof id === "string") ? list as string[] : undefined;
  const playlists = ids(scope?.playlist_ids), folders = ids(scope?.folder_ids);
  if (!playlists || !folders) return undefined;
  const access = scope?.access === "propose" || scope?.access === "manage" ? scope.access : undefined;
  return { playlist_ids: playlists, folder_ids: folders, ...(access ? { access } : {}) };
}

/** A ScreenScope in an answer (an outside_screen_scope problem, the agent's status): two lists of ids, or undefined when it is not one. */
export function screenScopeOf(value: unknown): NormalizedProblem["screen_scope"] {
  const scope = asRecord(value);
  const ids = (list: unknown): string[] | undefined => Array.isArray(list) && list.every((id) => typeof id === "string") ? list as string[] : undefined;
  const folders = ids(scope?.folder_ids), screens = ids(scope?.screen_ids);
  return folders && screens ? { folder_ids: folders, screen_ids: screens } : undefined;
}

/** "folders sfd_A, sfd_B; screens scr_X": a scope for a line of output. */
export function screenScopeText(scope: { folder_ids: string[]; screen_ids: string[] }): string {
  return `folders ${scope.folder_ids.join(", ") || "none"}; screens ${scope.screen_ids.join(", ") || "none"}`;
}

/** A plan or feature id in an answer (premium, video_walls): a short lowercase identifier, or undefined. */
function planIdOf(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : undefined;
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
  const hint = code === "project_required" ? "Select a project with project use ID or --project-id ID, then retry." : asString(rec?.hint) ?? (foreign ? foreignBodyHint(status) : undefined);
  const retryable = typeof rec?.retryable === "boolean" ? rec.retryable : undefined;
  const traceId = asString(rec?.trace_id);
  const limitedBy = rec?.access_limited_by === "project" || rec?.access_limited_by === "person" ? rec.access_limited_by : undefined;
  const uploadScope = uploadScopeOf(rec?.upload_scope);
  const screenScope = screenScopeOf(rec?.screen_scope);
  const display = code === "screenshot_unavailable" ? reportedDisplayOf(rec?.display) : undefined;
  const feature = planIdOf(rec?.feature), plan = planIdOf(rec?.plan), requiredPlan = planIdOf(rec?.required_plan);
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
    ...(limitedBy ? { access_limited_by: limitedBy } : {}),
    ...(uploadScope ? { upload_scope: uploadScope } : {}),
    ...(screenScope ? { screen_scope: screenScope } : {}),
    ...(display ? { display } : {}),
    ...(feature ? { feature } : {}),
    ...(plan ? { plan } : {}),
    ...(requiredPlan ? { required_plan: requiredPlan } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    errors,
    // A valid server next action wins over local guidance; asNext drops any that is not a plain screenrig command.
    next: code === "project_required" ? { command: "screenrig project list", reason: "Select a project with project use ID or --project-id ID, then retry." } : asNext(rec?.next) ?? (missingCapability ? {
      command: "screenrig login",
      reason: `This sign-in lacks the ${missingCapability} capability. Sign in again and ask the person approving it in the dashboard to grant ${missingCapability}.`,
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
  const rec = asRecord(entry);
  if (!rec) {
    return undefined;
  }
  const field = asString(rec.field);
  const message = asString(rec.detail);
  const code = asString(rec.code);
  const suffix = code && message ? ` (${code})` : "";
  if (field && message) {
    return `${field}: ${message}${suffix}`;
  }
  return message ? `${message}${suffix}` : field;
}

export function renderProblem(problem: NormalizedProblem): string {
  // A dropped connection or a client timeout has no HTTP status to show.
  const local = problem.code === "transport_error" || problem.code === "timeout";
  const lines = [`${problem.title} (${problem.code}${local ? "" : `/${problem.status}`})`, problem.detail];
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
  if (problem.access_limited_by) {
    lines.push(`access_limited_by: ${problem.access_limited_by}`);
  }
  if (problem.upload_scope) {
    lines.push(`upload_scope: folders ${problem.upload_scope.folder_ids.join(", ") || "none"}; playlists ${problem.upload_scope.playlist_ids.join(", ") || "none"}`);
  }
  if (problem.screen_scope) {
    lines.push(`screen_scope: ${screenScopeText(problem.screen_scope)}`);
  }
  if (problem.feature) {
    lines.push(`feature: ${problem.feature}`);
  }
  if (problem.plan) {
    lines.push(`plan: ${problem.plan}`);
  }
  if (problem.required_plan) {
    lines.push(`required_plan: ${problem.required_plan}`);
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

/**
 * Local guidance for a problem the server sends without a `hint` or `next`: a
 * failed operation's error carries no hint, and no server route names a next
 * action for these codes. Each member is filled only when the server left it
 * empty; server guidance always wins.
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
 * `Retry-After` on every rate-limited response, so fold it into the detail
 * instead of discarding the header.
 */
export function withRetryAfter(problem: NormalizedProblem, retryAfterSeconds: number | undefined): NormalizedProblem {
  if (retryAfterSeconds === undefined) return problem;
  // A 503 may also name its wait; keep it for callers that retry on their own.
  if (problem.status === 503) return { ...problem, retry_after_seconds: retryAfterSeconds };
  if (problem.status !== 429) {
    return problem;
  }
  const detail = problem.detail.includes("Retry-After")
    ? problem.detail
    : `${problem.detail} Retry-After is ${retryAfterSeconds} seconds.`;
  // detail is the server's and names the limit that tripped; add the wait.
  return { ...problem, detail, retry_after_seconds: retryAfterSeconds };
}

/**
 * quota_exceeded (413) is the plan's storage limit, on every plan: an upload
 * that would take the organization past it is refused and nothing stored is
 * touched. Retrying is refused the same way, so say what frees room, unless the
 * server already supplied its own guidance.
 */
export function withQuotaGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (problem.code !== "quota_exceeded") {
    return problem;
  }
  return withGuidance(problem, {
    hint: "Storage is full: this upload would take the organization past its plan's storage limit, and the same upload is refused the same way. Stored content keeps playing. Stop uploading, delete media or applications that are no longer used (screenrig media list, then screenrig media delete ID), or tell the user a larger plan has more storage.",
    next: {
      command: "screenrig billing usage",
      reason: "Shows the bytes stored against the plan's storage limit.",
    },
  });
}

/**
 * A direct campaign goal larger than the availability estimate is refused with
 * goal_overbooked. Point at the estimate, and at the draft's overbook flag for
 * a deliberate booking, unless the server already supplied its own guidance.
 */
export function withOverbookingGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (problem.code !== "goal_overbooked") {
    return problem;
  }
  return withGuidance(problem, {
    next: {
      command: "screenrig ads direct availability --help",
      reason: "Shows how to estimate the plays still available: the query document takes the draft's targeting, dayparts, flight_start and flight_end.",
    },
  });
}

/**
 * outside_screen_scope names the way back in its hint; add the command that
 * shows the agent's own scope unless the server already supplied a next action.
 */
export function withScreenScopeGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (problem.code !== "outside_screen_scope") return problem;
  return withGuidance(problem, {
    next: {
      command: "screenrig agent status",
      reason: "Shows screen_scope, the folders and screens this agent is limited to, and person_screen_scope, its responsible person's; the agent acts on what both allow. Only the project owner widens a scope, in the dashboard.",
    },
  });
}

/** The 402 codes an older server may still send. */
const PAYMENT_CODES = new Set(["payment_required", "insufficient_credits"]);

/**
 * A 402 is a refusal that repeating does not change. Say so, and leave the rest
 * to the server's own words; no pay command exists to point at.
 */
export function withPaymentGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (!PAYMENT_CODES.has(problem.code)) {
    return problem;
  }
  return withGuidance(problem, {
    hint: "The server refused this request and repeating it is refused the same way. Stop retrying it, tell the user, and continue the task by other means where you can.",
  });
}

/** The policy name of the organization's hourly request cap in RateLimit-Policy and RateLimit. */
export const ORG_REQUEST_POLICY = "api-request-org";

/**
 * A 429 from the organization's hourly request cap is a wait, not a failure: it
 * clears when Retry-After ends, and looping on it only spends the next window.
 * The response names the cap in its RateLimit-Policy; every other 429 (a
 * shorter limit on one route) keeps the server's own words.
 */
export function withRateLimitGuidance(problem: NormalizedProblem, headers: Record<string, string>): NormalizedProblem {
  if (problem.code !== "rate_limited" || !`${headers["ratelimit-policy"] ?? ""} ${headers["ratelimit"] ?? ""}`.includes(`"${ORG_REQUEST_POLICY}"`)) {
    return problem;
  }
  const wait = typeof problem.retry_after_seconds === "number" ? `${problem.retry_after_seconds} seconds` : "the time Retry-After names";
  return withGuidance(problem, {
    hint: `A request limit was reached; nothing is charged and screens keep playing. Wait ${wait}, then run the same command once; do not retry in a loop. screenrig billing usage shows the organization's requests an hour. A listen stream (screenrig events follow) and media upload-batch use far fewer requests than polling lists and uploading one file at a time.`,
    next: {
      command: "screenrig billing usage",
      reason: "Shows the agent requests an hour the organization may make and the storage limit.",
    },
  });
}

/** A plan id as the plan is named to a person: plus is Plus, premium Premium, education Education. */
function planTitle(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Plan guidance. feature_not_in_plan is a 402 that only a larger plan lifts:
 * the feature belongs to the plan `required_plan` names, retrying is refused the same way, and the task goes on
 * without it. member_limit_reached and project_limit_reached that carry
 * `required_plan` also name the plan that has room. Server guidance is kept;
 * the plan is added to a hint that does not already name it.
 */
export function withPlanGuidance(problem: NormalizedProblem): NormalizedProblem {
  const plan = problem.required_plan ? planTitle(problem.required_plan) : undefined;
  let guided = problem;
  if (problem.code === "feature_not_in_plan") {
    guided = withGuidance(problem, {
      next: {
        command: "screenrig project capabilities",
        reason: "Lists the features this project's plan has and which plan includes each one, so you can tell the user what the refused feature needs.",
      },
    });
    if (plan && guided.hint && !guided.hint.includes(plan)) {
      guided = { ...guided, hint: `${guided.hint} The ${plan} plan includes it.` };
    }
    return guided;
  }
  if ((problem.code === "member_limit_reached" || problem.code === "project_limit_reached") && plan && problem.hint && !problem.hint.includes(plan)) {
    return { ...problem, hint: `${problem.hint} The ${plan} plan raises this limit; tell the user if more is needed.` };
  }
  return guided;
}

/**
 * The fallback hint for a problem that reached the output boundary without
 * one: CLI-originated errors, the codes a failed operation reports (its error
 * has no hint member), and the 401 and 5xx bodies of a foreign proxy. The
 * server hints every other code. Server hints are never replaced.
 */
const DEFAULT_HINTS: Record<string, string> = {
  usage_error: "Fix the argument or input named in detail and run the command again. Add --help to the command to see its arguments, accepted values, and an example.",
  not_enrolled: "This installation has no active agent credential. Run the next command, then run the original command again.",
  unauthenticated: "This installation has no active agent credential. Run the next command, then run the original command again.",
  config_error: "Fix the configuration named in detail, or add --config with a different private config file. screenrig doctor checks the configuration without sending requests.",
  file_error: "Check that the target directory exists, is writable, and has free space, or choose a different output path, then run the command again.",
  unexpected_response: "The API answered with something the CLI cannot use, often a proxy or gateway page. Check --api-url with screenrig doctor and retry; if it keeps happening, report the request_id with screenrig feedback bug.",
  transport_error: "The CLI could not reach the API. Check network connectivity and the configured API with screenrig doctor, then run the command again.",
  timeout: "The request did not finish in time. Reads are safe to rerun, optionally with a larger --timeout. A write may already have happened: inspect the resource before changing it again.",
  unexpected_error: "The CLI hit an internal error. Run the command again; if it keeps happening, report the command (without secrets) with screenrig feedback bug.",
  operation_failed: "The server finished the operation with an error. Read detail, fix the input it names, and start the command again; screenrig operations show OPERATION_ID shows the stored result.",
  invalid_request: "The server rejected the request as invalid. Read detail and errors[] for the field to change, fix it, and send the request again; the unchanged request is refused the same way.",
  unauthorized: "The stored credential was not accepted, so this installation's project is gone. Clear it with screenrig agent disconnect --yes, then create a new project with screenrig agent enroll --email ADDRESS --organization NAME. Use screenrig login only when the user asked to join an existing project.",
  capability_required: "This project does not have the capability this command needs. Do not retry; tell the user, who can change the project's purpose in the dashboard.",
  capability_unavailable: "The project's capabilities could not be read, so the write was not attempted. Retry shortly; screenrig project capabilities checks them directly.",
  not_found: "Nothing with that id exists in this project. Check the id with the matching list command (for example screenrig screen list) and use an id from its output.",
  resource_conflict: "The resource is not in a state that allows this change. Inspect it with its show command, then retry only once its state allows the change.",
  quota_exceeded: "The project is at a limit. Free space or use a smaller input, then retry.",
  not_ready: "The resource is still being prepared. Wait a few seconds and retry, or follow its operation with screenrig operations wait OPERATION_ID.",
  internal_error: "The server failed while handling the request. If retryable is true, wait a moment and retry; otherwise report the request_id with screenrig feedback bug.",
  dependency_unavailable: "A service the API depends on is unavailable. Wait a minute and retry the same command.",
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
