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

export function renderProblem(problem: NormalizedProblem): string {
  const lines = [`${problem.title} (${problem.code}/${problem.status})`, problem.detail];
  if (problem.request_id) {
    lines.push(`request_id: ${problem.request_id}`);
  }
  if (problem.operation_id) {
    lines.push(`operation_id: ${problem.operation_id}`);
  }
  if (typeof problem.current_revision === "number") {
    lines.push(`current_revision: ${problem.current_revision}`);
  }
  if (problem.next) {
    lines.push(`next: ${problem.next.command}`);
    lines.push(`      ${problem.next.reason}`);
  }
  return lines.join("\n");
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
