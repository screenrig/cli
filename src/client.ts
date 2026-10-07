import type { WriteRecovery } from "./write-recovery.js";
import { creditsLowWarnings, observeCreditsRemaining, parseCreditsRemainingHeader } from "./credits.js";
import { ExitCode } from "./exit-codes.js";
import { REQUEST_ID_MAX, REQUEST_ID_MIN, isValidIdempotencyKey, isValidRequestId, newIdempotencyKey, newRequestId } from "./ids.js";
import {
  CliError,
  makeProblem,
  bodySnippet,
  normalizeProblem,
  parseRetryAfter,
  problemCodeOf,
  timeoutError,
  unexpectedResponseError,
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
 * receiver token. Support history is private customer correspondence.
 */
function privateBodies(method: string, path: string): boolean {
  return (method === "POST" && path === "/api/invitations") || /^\/api\/(?:webhooks|support)(?:\/|$)/.test(path);
}

/** 409 codes that are a definite refusal rather than possibly in-progress work. */
const DEFINITE_CONFLICT_CODES = new Set(["webhook_limit_reached"]);

/** The error body as text, for a response that is not a problem document. Transports without raw text get the decoded body. */
function errorBodyText(rawText: string | undefined, body: unknown): string {
  if (typeof rawText === "string") return rawText;
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/** A cursor-paged list is read for at most this many pages (each one billed request). */
export const LIST_MAX_PAGES = 50;

/**
 * A transport failure says what went wrong but not what the caller may do
 * about it. Whether rerunning is safe depends on the method and on whether the
 * write kept a saved idempotency key for replay.
 */
function withTransportHint(err: unknown, method: string, keyed: boolean): unknown {
  if (!(err instanceof CliError) || err.problem.hint) return err;
  if (err.problem.code !== "timeout" && err.problem.code !== "transport_error") return err;
  const timeout = err.problem.code === "timeout";
  const reach = timeout
    ? "The API did not answer before --timeout."
    : "The CLI could not reach the API; check network connectivity and the configured API origin (screenrig doctor shows it).";
  const hint = READ_METHODS.has(method)
    ? `${reach} This was a read, so it is safe to run the same command again${timeout ? ", optionally with a larger --timeout" : ""}.`
    : keyed
      ? `${reach} The write may already have happened. Run the identical command again: it reuses the saved idempotency key, so work that already happened is returned, not repeated. screenrig recovery list shows writes still unresolved.`
      : `${reach} The write may already have happened. Inspect the resource with its show or list command before running the command again.`;
  return new CliError({ ...err.problem, hint }, err.exitCode, err.warnings);
}

export interface ApiClientOptions {
  transport: Transport;
  token?: string;
  /** Fixed for this client; identity credentials require an explicit target. */
  projectId?: string;
  /** `--request-id`: the X-Request-ID of the invocation's first HTTP request, and its invocation_id. */
  requestId?: string;
  /** Shares request-id state across every client of one invocation; overrides `requestId`. */
  requestIds?: RequestIds;
  idempotencyKey?: string;
  timeoutMs?: number;
  /** When set, authenticated remaining credits are observed for the envelope warning. */
  creditsOwner?: object;
  logger?: OperationLogger;
  writeRecovery?: WriteRecovery;
}

/**
 * Request ids for one CLI invocation. Every HTTP request gets its own
 * X-Request-ID so server logs never merge requests. A `--request-id` is sent
 * on the first request only and doubles as the invocation id; without one,
 * the invocation id is a fresh id that no request carries. The invocation id
 * appears in the operation log as `invocation_id`.
 */
export class RequestIds {
  readonly invocationId: string;
  private pending?: string;
  private lastId?: string;

  constructor(requested?: string) {
    if (requested !== undefined && !isValidRequestId(requested)) {
      throw usageError(`Invalid --request-id; expected req_ plus ${REQUEST_ID_MIN}-${REQUEST_ID_MAX} letters, digits, _ or -.`);
    }
    this.invocationId = requested ?? newRequestId();
    this.pending = requested;
  }

  /** The id for the next HTTP request. */
  next(): string {
    const id = this.pending ?? newRequestId();
    this.pending = undefined;
    this.lastId = id;
    return id;
  }

  /** The id of the most recent HTTP request, or the invocation id before any request. */
  get last(): string {
    return this.lastId ?? this.invocationId;
  }
}

export class ApiClient {
  readonly requestIds: RequestIds;
  readonly idempotencyKey: string;
  private readonly token?: string;
  private readonly projectId?: string;
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
    this.projectId = options.projectId;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.creditsOwner = options.creditsOwner;
    this.logger = options.logger ?? loggerOf({});
    if (options.idempotencyKey && !isValidIdempotencyKey(options.idempotencyKey)) {
      throw usageError("Invalid --idempotency-key.");
    }
    this.requestIds = options.requestIds ?? new RequestIds(options.requestId);
    this.idempotencyKey = options.idempotencyKey ?? newIdempotencyKey();
  }

  /** The id of the most recent HTTP request; success envelopes report it. */
  get requestId(): string {
    return this.requestIds.last;
  }

  get invocationId(): string {
    return this.requestIds.invocationId;
  }

  /** A fresh X-Request-ID for a request this client does not send itself (SSE). */
  nextRequestId(): string {
    return this.requestIds.next();
  }

  private headers(idempotent: boolean, extra?: Record<string, string>, idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      "x-request-id": this.requestIds.next(),
      ...extra,
    };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
      if (this.projectId) headers["screenrig-project"] = this.projectId;
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
      request_id: headers["x-request-id"],
      invocation_id: this.invocationId,
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
      throw withTransportHint(err, req.method, Boolean(pending));
    }
    // Definite refusals need reconciliation, not automatic replay of a stale key.
    // Keep ambiguous timeouts and conflicts (which can mean work is in progress).
    if (pending && response.status >= 400 && response.status < 500
        && (![408, 409].includes(response.status) || DEFINITE_CONFLICT_CODES.has(problemCodeOf(response.body) ?? ""))) {
      await recovery!.clear(pending);
    }
    const remaining = this.token ? parseCreditsRemainingHeader(response.headers) : undefined;
    const requestId = response.headers["x-request-id"] ?? headers["x-request-id"];
    if (response.status >= 400) {
      const problem = normalizeProblem(response.body, {
        status: response.status,
        request_id: requestId,
        bodyText: errorBodyText(response.rawText, response.body),
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
    if (expectsJsonBody(req, response.status) && (response.body === undefined || typeof response.body === "string")) {
      // A 2xx where the contract names a JSON document must not pass as
      // success with nothing in it: an empty or non-JSON body means the work's
      // outcome is unknown.
      const snippet = typeof response.body === "string" ? bodySnippet(response.body) : undefined;
      const err = unexpectedResponseError(
        snippet
          ? `${req.method} ${req.path} answered HTTP ${response.status} with a body that is not JSON: ${snippet}`
          : `${req.method} ${req.path} answered HTTP ${response.status} with an empty body where a JSON document was expected.`,
        requestId,
        READ_METHODS.has(req.method)
          ? "The answer was empty or not JSON, so nothing can be read from it. Run the same command again; if it keeps happening, report the request_id with screenrig feedback bug."
          : "The server accepted the request but returned nothing usable, so it is unknown whether the change happened. Inspect the resource with its show or list command before retrying, and report the request_id with screenrig feedback bug.",
      );
      span.error(err, { status: response.status, request_id: requestId, content_type: response.headers["content-type"] });
      throw err;
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
      request_id: headers["x-request-id"],
      invocation_id: this.invocationId,
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
    const requestId = response.headers["x-request-id"] ?? headers["x-request-id"];
    const lengthHeader = response.headers["content-length"];
    const parsedLength = lengthHeader !== undefined ? Number(lengthHeader) : undefined;
    const byteLength = parsedLength !== undefined && Number.isFinite(parsedLength) ? parsedLength : undefined;
    if (response.status >= 400) {
      const problem = normalizeProblem(response.problem, {
        status: response.status,
        request_id: requestId,
        bodyText: errorBodyText(response.rawText, response.problem),
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

  /**
   * GET a cursor-paged list (screens, media, playlists, applications) whole.
   * Each further page repeats the query with `after` set to the previous
   * page's next_cursor; null or an absent next_cursor ends the list. The answer
   * is the last page's status and headers with every page's items in order and
   * next_cursor null. A first answer that is not a list document comes back
   * unchanged for the caller to judge, as before paging. A later page that is
   * not a list, or a list still offering pages after LIST_MAX_PAGES, is an
   * error: the caller never receives a truncated list.
   */
  async listAll(path: string, query?: Record<string, string | undefined>): Promise<TransportResponse> {
    const items: unknown[] = [];
    let after: string | undefined;
    for (let page = 1; ; page += 1) {
      const response = await this.call({ method: "GET", path, query: after === undefined ? query : { ...query, after } });
      const body = response.body as { items?: unknown; next_cursor?: unknown } | undefined;
      if (!body || !Array.isArray(body.items)) {
        if (page === 1) return response;
        throw unexpectedResponseError(
          `GET ${path} answered page ${page} without an items array, so the list was not read completely.`,
          this.requestId,
          "Run the same command again; if it keeps happening, report the request_id with screenrig feedback bug.",
        );
      }
      items.push(...body.items);
      const next = body.next_cursor;
      if (typeof next !== "string" || next === "") {
        return { status: response.status, headers: response.headers, body: { ...body, items, next_cursor: null } };
      }
      if (page >= LIST_MAX_PAGES) {
        throw unexpectedResponseError(
          `GET ${path} still offered another page after ${LIST_MAX_PAGES} pages (${items.length} rows), so the list was not read completely.`,
          this.requestId,
          "Narrow the list with a filter where the command has one, or report the request_id with screenrig feedback bug.",
        );
      }
      after = next;
    }
  }

  async getOperation(id: string, timeoutMs?: number): Promise<Operation> {
    const response = await this.call({ method: "GET", path: `/api/operations/${id}`, timeout_ms: timeoutMs });
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
          const err = timeoutError(`Timed out waiting for operation ${id}`, this.requestId,
            `The operation keeps running on the server; only this wait stopped. Run screenrig operations wait ${id} to keep waiting (add --timeout for longer), or screenrig operations show ${id} to check it once.`);
          err.problem.operation_id = id;
          err.problem.next = { command: `screenrig operations wait ${id}`, argv: ["operations", "wait", id], reason: "Resume waiting for the same operation without starting it again." };
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
            if (operation.error === undefined || operation.error === null) {
              problem.detail = `Operation ${operation.id} ended ${operation.state} without an error report.`;
            }
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

/** 2xx answers that must carry a JSON document: not 204/205, not HEAD, not bytes, not an explicit non-JSON read. */
function expectsJsonBody(req: TransportRequest | Omit<TransportRequest, "headers">, status: number): boolean {
  return status >= 200 && status < 300 && status !== 204 && status !== 205
    && req.method !== "HEAD" && req.binary !== true && req.json !== false;
}

export function requireToken(token: string | undefined): string {
  if (!token) {
    throw new CliError(
      makeProblem("unauthenticated", "Credential unavailable", 401, "This installation has no durable agent credential.", {
        next: {
          command: "screenrig agent enroll --email ADDRESS --organization NAME",
          reason: "Enrollment is explicit. Create the first agent, then retry the original command.",
        },
      }),
      ExitCode.Auth,
    );
  }
  return token;
}
