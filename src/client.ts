import type { Envelope } from "./envelope.js";
import { errorEnvelope, successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { isValidIdempotencyKey, isValidRequestId, newIdempotencyKey, newRequestId } from "./ids.js";
import {
  CliError,
  makeProblem,
  normalizeProblem,
  parseRetryAfter,
  timeoutError,
  usageError,
  withQuotaGuidance,
  withRetryAfter,
} from "./problems.js";
import type { Transport, TransportRequest, TransportResponse } from "./transport/types.js";
import type { Operation } from "./adapters/protocol.js";

export interface ApiClientOptions {
  transport: Transport;
  token?: string;
  requestId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export class ApiClient {
  readonly requestId: string;
  readonly idempotencyKey: string;
  private readonly token?: string;
  private readonly transport: Transport;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.transport = options.transport;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
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
    const response = await this.transport.request({
      ...transportRequest,
      timeout_ms: req.timeout_ms ?? this.timeoutMs,
      headers: this.headers(idempotent === true, req.headers, idempotencyKey),
    });
    if (response.status >= 400) {
      const problem = normalizeProblem(response.body, {
        status: response.status,
        request_id: response.headers["x-request-id"] ?? this.requestId,
        bodyText: typeof response.rawText === "string" ? response.rawText : undefined,
      });
      throw new CliError(
        withQuotaGuidance(
          withRetryAfter(problem, parseRetryAfter(response.headers["retry-after"], Date.now())),
        ),
      );
    }
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
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      const operation = await this.getOperation(id);
      if (operation.state === "succeeded" || operation.state === "failed" || operation.state === "cancelled") {
        if (operation.state !== "succeeded") {
          const problem = normalizeProblem(operation.error, {
            status: 500,
            request_id: operation.request_id ?? this.requestId,
          });
          throw new CliError(
            {
              ...problem,
              operation_id: operation.id,
              request_id: problem.request_id ?? this.requestId,
              code: problem.code === "http_error" ? "operation_failed" : problem.code,
            },
            ExitCode.OperationFailed,
          );
        }
        return operation;
      }
      if (Date.now() >= deadline) {
        throw timeoutError(`Timed out waiting for operation ${id}`, this.requestId);
      }
      await options.sleep(options.pollMs);
    }
  }
}

export function envelopeFromUnknown<T>(data: T, requestId?: string, operationId?: string): Envelope<T> {
  return successEnvelope(data, { request_id: requestId, operation_id: operationId });
}

export function requireToken(token: string | undefined): string {
  if (!token) {
    throw new CliError(
      makeProblem("unauthenticated", "Credential unavailable", 401, "Automatic enrollment did not produce a durable credential.", {
        next: {
          command: "screenrig doctor --json",
          reason: "Inspect the local credential state, then retry the original command.",
        },
      }),
      ExitCode.Auth,
    );
  }
  return token;
}

export { errorEnvelope };
