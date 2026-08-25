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

export interface ApiClientOptions {
  transport: Transport;
  token?: string;
  requestId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** When set, authenticated remaining credits are observed for the envelope warning. */
  creditsOwner?: object;
  logger?: OperationLogger;
}

export class ApiClient {
  readonly requestId: string;
  readonly idempotencyKey: string;
  private readonly token?: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly creditsOwner?: object;
  private readonly logger: OperationLogger;

  constructor(options: ApiClientOptions) {
    this.transport = options.transport;
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

  async call(req: Omit<TransportRequest, "headers"> & { headers?: Record<string, string>; idempotent?: boolean; idempotencyKey?: string }): Promise<TransportResponse> {
    const { idempotent, idempotencyKey, ...transportRequest } = req;
    if (idempotencyKey !== undefined && !isValidIdempotencyKey(idempotencyKey)) {
      throw usageError("Invalid per-request idempotency key.");
    }
    const headers = this.headers(idempotent === true, req.headers, idempotencyKey);
    const extraType = req.headers?.["content-type"];
    const summary = requestSummary(req.body, extraType);
    const keys = queryKeys(req.query);
    const span = this.logger.startHttp({
      op: `${req.method} ${req.path}`,
      method: req.method,
      path: req.path,
      message: `${req.method} ${req.path}`,
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
        ...responseSummary(req.binary ? undefined : response.body, req.binary === true, response.headers["content-type"]),
      });
      throw wrapped;
    }
    span.response(response.status, {
      request_id: requestId,
      ...responseSummary(response.body, req.binary === true, response.headers["content-type"]),
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
      message: `${req.method} ${req.path}`,
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

  async getOperation(id: string): Promise<Operation> {
    const response = await this.call({ method: "GET", path: `/api/v1/operations/${id}` });
    return response.body as Operation;
  }

  async waitForOperation(
    id: string,
    options: { timeoutMs: number; pollMs: number; sleep: (ms: number) => Promise<void> },
  ): Promise<Operation> {
    return this.logger.withLocal({ op: "operations.wait", message: `wait for ${id}`, operation_id: id }, async (span) => {
      const deadline = Date.now() + options.timeoutMs;
      while (true) {
        const operation = await this.getOperation(id);
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
        if (Date.now() >= deadline) {
          const err = timeoutError(`Timed out waiting for operation ${id}`, this.requestId);
          span.error(err);
          throw err;
        }
        await options.sleep(options.pollMs);
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
