import { ExitCode, exitCodeForStatus } from "./exit-codes.js";
import type { NormalizedProblem, ProblemNext } from "./envelope.js";
import { redactText, redactValue } from "./redact.js";

const PROBLEM_BASE = "https://screenrig.ai/problems";

export class CliError extends Error {
  readonly problem: NormalizedProblem;
  readonly exitCode: ExitCode;

  constructor(problem: NormalizedProblem, exitCode?: ExitCode) {
    super(problem.detail || problem.title);
    this.name = "CliError";
    this.problem = problem;
    this.exitCode = exitCode ?? exitCodeForStatus(problem.status);
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
  return { command, reason };
}

export function normalizeProblem(
  input: unknown,
  fallback: { status?: number; request_id?: string; bodyText?: string } = {},
): NormalizedProblem {
  const rec = asRecord(redactValue(input));
  const status = asNumber(rec?.status) ?? fallback.status ?? 500;
  const code =
    asString(rec?.code) ??
    (status === 401 ? "unauthorized" : status >= 500 ? "internal_error" : "http_error");
  const title = asString(rec?.title) ?? "Request failed";
  const detail =
    asString(rec?.detail) ??
    (fallback.bodyText ? redactText(fallback.bodyText).slice(0, 300) : title);
  const errors = Array.isArray(rec?.errors) ? rec.errors : [];
  return {
    type: asString(rec?.type) ?? problemType(code),
    title,
    status,
    detail,
    instance: asString(rec?.instance),
    code,
    request_id: asString(rec?.request_id) ?? fallback.request_id,
    operation_id: asString(rec?.operation_id),
    current_revision: asNumber(rec?.current_revision),
    errors,
    next: asNext(rec?.next),
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
  if (field && message) {
    return `${field}: ${message}`;
  }
  return message ?? field ?? JSON.stringify(rec);
}

export function renderProblem(problem: NormalizedProblem): string {
  const lines = [`${problem.title} (${problem.code}/${problem.status})`, problem.detail];
  for (const entry of problem.errors) {
    const rendered = renderProblemError(entry);
    if (rendered) {
      lines.push(`- ${rendered}`);
    }
  }
  if (problem.request_id) {
    lines.push(`request_id: ${problem.request_id}`);
  }
  if (problem.operation_id) {
    lines.push(`operation_id: ${problem.operation_id}`);
  }
  if (typeof problem.current_revision === "number") {
    lines.push(`current_revision: ${problem.current_revision}`);
  }
  if (typeof problem.retry_after_seconds === "number") {
    lines.push(`retry_after_seconds: ${problem.retry_after_seconds}`);
  }
  if (problem.next) {
    lines.push(`next: ${problem.next.command}`);
    lines.push(`      ${problem.next.reason}`);
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
 * A bare 429 tells an agent nothing actionable. The server declares
 * `Retry-After` on every rate-limited response, so fold it into the detail and
 * the next-action guidance instead of discarding the header.
 */
export function withRetryAfter(problem: NormalizedProblem, retryAfterSeconds: number | undefined): NormalizedProblem {
  if (problem.status !== 429 || retryAfterSeconds === undefined) {
    return problem;
  }
  const interval = describeRetryInterval(retryAfterSeconds);
  const detail = problem.detail.includes("Retry-After")
    ? problem.detail
    : `${problem.detail} Retry-After is ${retryAfterSeconds} seconds.`;
  return {
    ...problem,
    detail,
    retry_after_seconds: retryAfterSeconds,
    next: problem.next ?? {
      command: "retry the same command",
      reason: `The account rate limit is in effect. Wait ${interval} before retrying.`,
    },
  };
}

/**
 * A custom storage ceiling, when present, is checked before the 1 GiB
 * transport bound, so `quota_exceeded` is still the limit a user meets on that
 * path. Point at the command that reports used_bytes and content_limit_bytes,
 * unless the server already supplied its own guidance.
 */
export function withQuotaGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (problem.code !== "quota_exceeded" || problem.next) {
    return problem;
  }
  return {
    ...problem,
    next: {
      command: "screenrig --json account show",
      reason: "Read used_bytes and content_limit_bytes, then free space or upload a smaller file.",
    },
  };
}

/**
 * Remaining prepaid credit of zero rejects costly operations with
 * `payment_required`. Point at account show for credit_remaining_mcr. Do not
 * invent a pay command; v1 does not collect money here.
 */
export function withPaymentGuidance(problem: NormalizedProblem): NormalizedProblem {
  if (problem.code !== "payment_required" || problem.next) {
    return problem;
  }
  return {
    ...problem,
    next: {
      command: "screenrig --json account show",
      reason: "Read credit_remaining_mcr. Remaining prepaid credit of zero rejects costly operations.",
    },
  };
}

export function usageError(detail: string, next?: ProblemNext): CliError {
  return new CliError(
    makeProblem("usage_error", "Invalid command usage", 400, detail, {
      next,
    }),
    ExitCode.Usage,
  );
}

export function configError(detail: string, next?: ProblemNext): CliError {
  return new CliError(
    makeProblem("config_error", "Configuration error", 400, detail, { next }),
    ExitCode.Config,
  );
}

export function networkError(detail: string, request_id?: string): CliError {
  return new CliError(
    makeProblem("transport_error", "Network error", 503, detail, { request_id }),
    ExitCode.Network,
  );
}

export function timeoutError(detail: string, request_id?: string): CliError {
  return new CliError(
    makeProblem("timeout", "Timed out", 408, detail, { request_id }),
    ExitCode.Timeout,
  );
}
