import type { WriteRecovery } from "./write-recovery.js";
import { creditsLowWarnings, observeCreditsRemaining, parseCreditsRemainingHeader } from "./credits.js";
import { ExitCode } from "./exit-codes.js";
import { isValidIdempotencyKey, isValidRequestId, newIdempotencyKey, newRequestId } from "./ids.js";
import {
  CliError,
  makeProblem,
  normalizeProblem,
  parseRetryAfter,
  timeoutError,
  usageError,
  withPaymentGuidance,
  withQuotaGuidance,
  withRetryAfter,
} from "./problems.js";
import type { Transport, TransportDownloadResponse, TransportRequest, TransportResponse } from "./transport/types.js";
import type { Operation } from "./adapters/protocol.js";
import { loggerOf, queryKeys, requestSummary, responseSummary } from "./log/logger.js";
import type { OperationLogger } from "./log/types.js";

/**
 * Bodies that must not reach the operation log even after redaction: an
 * invitation create can carry a one-time credential URL, a webhook answer can
 * carry its signing secret, and a webhook URL path may itself embed a
 * receiver token.
 */
function privateBodies(method: string, path: string): boolean {
  return (method === "POST" && path === "/api/v1/invitations") || /^\/api\/v1\/webhooks(?:\/|$)/.test(path);
}

/** 409 codes that are a definite refusal rather than possibly in-progress work. */
const DEFINITE_CONFLICT_CODES = new Set(["webhook_limit_reached"]);

function problemCode(body: unknown): string | undefined {
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

export interface ApiClientOptions {
  transport: Transport;
  token?: string;
  requestId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** When set, authenticated remaining credits are observed for the envelope warning. */
  creditsOwner?: object;
  logger?: OperationLogger;
  writeRecovery?: WriteRecovery;
}

export class ApiClient {
  readonly requestId: string;
  readonly idempotencyKey: string;
  private readonly token?: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly creditsOwner?: object;
  private readonly logger: OperationLogger;
  private readonly writeRecovery?: WriteRecovery;
  private readonly requestedKey?: string;

  constructor(options: ApiClientOptions) {
    this.transport = options.transport;
    this.writeRecovery = options.writeRecovery;
    this.requestedKey = options.idempotencyKey;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.creditsOwner = options.creditsOwner;
    this.logger = options.logger ?? loggerOf({});
    if (options.requestId && !isValidRequestId(options.requestId)) {
      throw usageError("Invalid --request-id; expected req_ plus 16+ URL-safe characters.");
    }
    if (options.idempotencyKey && !isValidIdempotencyKey(options.idempotencyKey)) {
      throw usageError("Invalid --idempotency-key.");
    }
    this.requestId = options.requestId ?? newRequestId();
    this.idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  }

  private headers(idempotent: boolean, extra?: Record<string, string>, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "x-request-id": this.requestId,
      ...extra,
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (idempotent) {
      headers["idempotency-key"] = idempotencyKey ?? this.idempotencyKey;
    }
    return headers;
  }

  async call(req: Omit<TransportRequest, "headers"> & { headers?: Record<string, string>; idempotent?: boolean; idempotencyKey?: string; recoverySupersede?: string }): Promise<TransportResponse> {
    const { idempotent, idempotencyKey, recoverySupersede, ...transportRequest } = req;
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      throw usageError("Invalid per-request idempotency key.");
    }
    const recovery = idempotent === true && idempotencyKey === undefined ? this.writeRecovery : undefined;
    const pending = await recovery?.prepare(transportRequest, this.requestedKey, recoverySupersede);
    const headers = this.headers(idempotent === true, req.headers, pending?.key ?? idempotencyKey);
    const extraType = req.headers?.["content-type"];
    const hideBodies = privateBodies(req.method, req.path);
    const summary = hideBodies ? requestSummary(undefined, extraType ?? (req.body === undefined ? undefined : "application/json")) : requestSummary(req.body, extraType);
    const keys = queryKeys(req.query);
    const span = this.logger.startHttp({
      op: `${req.method} ${req.path}`,
      method: req.method,
      path: req.path,
      query_keys: keys,
      request_id: headers["x-request-id"] ?? this.requestId,
      content_type: summary.content_type,
      byte_length: summary.byte_length,
      request: summary.request,
    });
    let response: TransportResponse;
    try {
      response = await this.transport.request({
        ...transportRequest,
        timeout_ms: req.timeout_ms ?? this.timeoutMs,
        headers,
      });
    } catch (err) {
      span.error(err);
      throw err;
    }
    // Definite refusals need reconciliation, not automatic replay of a stale key.
    // Keep ambiguous timeouts and conflicts (which can mean work is in progress).
    if (pending && response.status >= 400 && response.status < 500
        && (![408, 409].includes(response.status) || DEFINITE_CONFLICT_CODES.has(problemCode(response.body) ?? ""))) {
      await recovery!.clear(pending);
    }
    const remaining = this.token ? parseCreditsRemainingHeader(response.headers) : undefined;
    const requestId = response.headers["x-request-id"] ?? this.requestId;
    if (response.status >= 400) {
      const problem = normalizeProblem(response.body, {
        status: response.status,
        request_id: requestId,
        bodyText: typeof response.rawText === "string" ? response.rawText : undefined,
      });
      const wrapped = new CliError(
        withPaymentGuidance(
          withQuotaGuidance(
            withRetryAfter(problem, parseRetryAfter(response.headers["retry-after"], Date.now())),
          ),
        ),
        undefined,
        creditsLowWarnings(remaining),
      );
      span.error(wrapped, {
        status: response.status,
        request_id: requestId,
        problem: { code: wrapped.problem.code, detail: wrapped.problem.detail, message: wrapped.problem.title },
        ...(hideBodies
          ? { content_type: response.headers["content-type"] }
          : responseSummary(req.binary ? undefined : response.body, req.binary === true, response.headers["content-type"])),
      });
      throw wrapped;
    }
    span.response(response.status, {
      request_id: requestId,
      // Never put these bodies in generic logging fields, even before redaction.
      ...(hideBodies
        ? { content_type: response.headers["content-type"] }
        : responseSummary(response.body, req.binary === true, response.headers["content-type"])),
    });
    if (this.creditsOwner) {
      observeCreditsRemaining(this.creditsOwner, remaining);
    }
    return response;
  }

  async download(req: Omit<TransportRequest, "headers"> & { headers?: Record<string, string> }): Promise<TransportDownloadResponse> {
    const headers = this.headers(false, req.headers);
    const keys = queryKeys(req.query);
    const span = this.logger.startHttp({
      op: `${req.method} ${req.path}`,
      method: req.method,
      path: req.path,
      query_keys: keys,
      request_id: headers["x-request-id"] ?? this.requestId,
    });
    let response: TransportDownloadResponse;
    try {
      response = await this.transport.download({
        ...req,
        timeout_ms: req.timeout_ms ?? this.timeoutMs,
        headers,
      });
    } catch (err) {
      span.error(err);
      throw err;
    }
    const remaining = this.token ? parseCreditsRemainingHeader(response.headers) : undefined;
    const requestId = response.headers["x-request-id"] ?? this.requestId;
    const lengthHeader = response.headers["content-length"];
    const parsedLength = lengthHeader !== undefined ? Number(lengthHeader) : undefined;
    const byteLength = parsedLength !== undefined && Number.isFinite(parsedLength) ? parsedLength : undefined;
    if (response.status >= 400) {
      const problem = normalizeProblem(response.problem, {
        status: response.status,
        request_id: requestId,
        bodyText: response.rawText,
      });
      const wrapped = new CliError(
        withPaymentGuidance(
          withQuotaGuidance(
            withRetryAfter(problem, parseRetryAfter(response.headers["retry-after"], Date.now())),
          ),
        ),
        undefined,
        creditsLowWarnings(remaining),
      );
      span.error(wrapped, {
        status: response.status,
        request_id: requestId,
        content_type: response.headers["content-type"],
        ...(byteLength !== undefined ? { byte_length: byteLength } : {}),
        problem: { code: wrapped.problem.code, detail: wrapped.problem.detail, message: wrapped.problem.title },
      });
      throw wrapped;
    }
    span.response(response.status, {
      request_id: requestId,
      content_type: response.headers["content-type"],
      ...(byteLength !== undefined ? { byte_length: byteLength } : {}),
    });
    if (this.creditsOwner) observeCreditsRemaining(this.creditsOwner, remaining);
    return response;
  }

  async getOperation(id: string, timeoutMs?: number): Promise<Operation> {
    const response = await this.call({ method: "GET", path: `/api/v1/operations/${id}`, timeout_ms: timeoutMs });
    return response.body as Operation;
  }

  async waitForOperation(
    id: string,
    options: { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void> },
  ): Promise<Operation> {
    return this.logger.withLocal({ op: "operations.wait", message: `wait for ${id}`, operation_id: id }, async (span) => {
      const deadline = Date.now() + options.timeoutMs;
      const remaining = () => {
        const budget = deadline - Date.now();
        if (budget <= 0) {
          const err = timeoutError(`Timed out waiting for operation ${id}`, this.requestId);
          span.error(err);
          throw err;
        }
        return budget;
      };
      while (true) {
        const operation = await this.getOperation(id, Math.min(this.timeoutMs, remaining()));
        remaining();
        span.progress({ operation_id: operation.id, state: operation.state });
        if (operation.state === "succeeded" || operation.state === "failed" || operation.state === "cancelled") {
          if (operation.state !== "succeeded") {
            const problem = normalizeProblem(operation.error, {
              status: 500,
              request_id: operation.request_id ?? this.requestId,
            });
            const err = new CliError(
              {
                ...problem,
                operation_id: operation.id,
                request_id: problem.request_id ?? this.requestId,
                code: problem.code === "http_error" ? "operation_failed" : problem.code,
              },
              ExitCode.OperationFailed,
            );
            span.error(err, { operation_id: operation.id, state: operation.state });
            throw err;
          }
          span.finish({ operation_id: operation.id, state: operation.state });
          return operation;
        }
        await options.sleep(Math.min(options.pollMs, remaining()));
      }
    });
  }
}

export function requireToken(token: string | undefined): string {
  if (!token) {
    throw new CliError(
      makeProblem("unauthenticated", "Credential unavailable", 401, "This installation has no durable agent credential.", {
        next: {
          command: "screenrig agent enroll --email ADDRESS",
          reason: "Enrollment is explicit. Create the first agent, then retry the original command.",
        },
      }),
      ExitCode.Auth,
    );
  }
  return token;
}
