import { randomUUID } from "node:crypto";
import path from "node:path";
import { CliError, configError } from "../problems.js";
import { isSensitiveKey, isSensitiveValue, redactText, redactValue } from "../redact.js";
import type { SignedRawPut } from "../runtime.js";
import type { RunProcess } from "../runtime.js";
import type { Transport, TransportStream } from "../transport/types.js";
import { httpResourceId, httpTag, localTag } from "./tag.js";
import type {
  HttpSpan,
  LocalSpan,
  LogEvent,
  LogFields,
  LogSink,
  OperationLogger,
  StartHttpInit,
  StartLocalInit,
} from "./types.js";
import { LOG_EVENT_VERSION } from "./types.js";

const SUMMARY_LIMIT = 8_192;

type LogParamValue = string | number | boolean;

const LOCAL_PARAM_KEYS = new Set([
  "width",
  "height",
  "encoder",
  "file_count",
  "exit_code",
  "state",
  "capture_id",
  "operation_id",
]);

function isLogParamValue(value: unknown): value is LogParamValue {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
}

function keepParam(key: string, value: LogParamValue): boolean {
  if (isSensitiveKey(key)) {
    return false;
  }
  if (typeof value === "string" && (value.length === 0 || isSensitiveValue(value))) {
    return false;
  }
  return true;
}

function takeParams(source: Record<string, unknown> | undefined, keys?: ReadonlySet<string>): Record<string, LogParamValue> {
  const out: Record<string, LogParamValue> = {};
  if (!source) {
    return out;
  }
  for (const [key, value] of Object.entries(source)) {
    if (keys && !keys.has(key)) {
      continue;
    }
    if (!isLogParamValue(value) || !keepParam(key, value)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function asParamRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function compactParams(explicit?: unknown, fields?: LogFields): Record<string, LogParamValue> | undefined {
  const out: Record<string, LogParamValue> = {
    ...takeParams(asParamRecord(explicit)),
    ...takeParams(asParamRecord(fields?.params)),
    ...takeParams(fields, LOCAL_PARAM_KEYS),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function omitResourceFields(fields?: LogFields): LogFields | undefined {
  if (!fields) {
    return undefined;
  }
  const { id: _id, params: _params, ...rest } = fields;
  return rest;
}

function resourceId(explicit?: string, fields?: LogFields): string | undefined {
  if (typeof explicit === "string" && explicit.length > 0 && !isSensitiveValue(explicit)) {
    return explicit;
  }
  if (!fields) {
    return undefined;
  }
  for (const key of ["capture_id", "operation_id"] as const) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0 && !isSensitiveValue(value)) {
      return value;
    }
  }
  return undefined;
}

export function commandWords(positionals: string[]): string[] {
  return positionals.slice(0, 2).filter((word) => word.length > 0);
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(err: unknown): string {
  if (err instanceof CliError) {
    return redactText(err.problem.detail || err.problem.title);
  }
  if (typeof err === "string") {
    return redactText(err);
  }
  if (err instanceof Error) {
    return redactText(err.message);
  }
  return "unknown error";
}

function errorProblem(err: unknown): LogEvent["problem"] | undefined {
  if (err instanceof CliError) {
    return {
      code: err.problem.code,
      detail: redactText(err.problem.detail),
      message: redactText(err.problem.title),
    };
  }
  return undefined;
}

function summarizeJson(value: unknown): unknown {
  const redacted = redactValue(value);
  let encoded: string;
  try {
    encoded = JSON.stringify(redacted);
  } catch {
    return { omitted: "unserializable" };
  }
  if (encoded.length <= SUMMARY_LIMIT) {
    return redacted;
  }
  return {
    truncated: true,
    byte_length: Buffer.byteLength(encoded, "utf8"),
  };
}

export function requestSummary(body: unknown, contentType?: string): { content_type?: string; byte_length?: number; request?: unknown } {
  if (body === undefined) {
    return contentType ? { content_type: contentType } : {};
  }
  if (body instanceof Uint8Array) {
    return { content_type: contentType ?? "application/octet-stream", byte_length: body.byteLength };
  }
  if (typeof body === "string") {
    return {
      content_type: contentType ?? "text/plain",
      byte_length: Buffer.byteLength(body, "utf8"),
      request: summarizeJson(redactText(body).slice(0, SUMMARY_LIMIT)),
    };
  }
  return {
    content_type: contentType ?? "application/json",
    request: summarizeJson(body),
  };
}

export function responseSummary(body: unknown, binary: boolean, contentType?: string): { content_type?: string; byte_length?: number; response?: unknown } {
  if (binary || body instanceof Uint8Array) {
    const bytes = body instanceof Uint8Array ? body.byteLength : undefined;
    return { content_type: contentType, byte_length: bytes };
  }
  if (body === undefined) {
    return contentType ? { content_type: contentType } : {};
  }
  return { content_type: contentType, response: summarizeJson(body) };
}

function serializeEvent(event: LogEvent): string {
  const redacted = redactValue(event) as LogEvent;
  const line = JSON.stringify(redacted);
  return redactText(line);
}

class SpanStack {
  private readonly ids: string[] = [];

  parent(): string | undefined {
    return this.ids[this.ids.length - 1];
  }

  push(id: string): string | undefined {
    const parent = this.parent();
    this.ids.push(id);
    return parent;
  }

  pop(id: string): void {
    const index = this.ids.lastIndexOf(id);
    if (index >= 0) {
      this.ids.splice(index, 1);
    }
  }
}

class BaseLogger implements OperationLogger {
  readonly enabled: boolean;
  readonly runId: string;
  command: string[];
  private readonly now: () => Date;
  private readonly sink: LogSink;
  private readonly stack = new SpanStack();
  private runSpan: LocalSpan | undefined;
  private closed = false;
  private sinkError: CliError | undefined;

  constructor(options: { enabled: boolean; command: string[]; now: () => Date; sink: LogSink; runId?: string }) {
    this.enabled = options.enabled;
    this.runId = options.runId ?? randomUUID();
    this.command = options.command;
    this.now = options.now;
    this.sink = options.sink;
  }

  setCommand(command: string[]): void {
    this.command = command;
  }

  emit(event: Omit<LogEvent, "v" | "ts" | "event_id" | "run_id" | "command"> & Partial<Pick<LogEvent, "command">>): void {
    if (!this.enabled || this.closed) {
      return;
    }
    if (this.sinkError) {
      throw this.sinkError;
    }
    const full = {
      ...event,
      v: LOG_EVENT_VERSION,
      ts: isoNow(this.now),
      event_id: randomUUID(),
      run_id: this.runId,
      command: event.command ?? this.command,
    } as LogEvent;
    const line = serializeEvent(full);
    try {
      this.sink.writeLine(line);
    } catch (err) {
      this.sinkError = configError(
        `Failed to write operation log: ${errorMessage(err)}. The consumer must already be listening on log_socket.`,
      );
      throw this.sinkError;
    }
  }

  startHttp(init: StartHttpInit): HttpSpan {
    const correlationId = randomUUID();
    const parent = this.stack.push(correlationId);
    const started = this.now().getTime();
    const tag = httpTag(init.method, init.path);
    const id = resourceId(init.id) ?? httpResourceId(init.path);
    const params = compactParams(init.params);
    this.emit({
      kind: "http",
      phase: "request",
      op: init.op,
      tag,
      correlation_id: correlationId,
      ...(parent ? { parent_correlation_id: parent } : {}),
      method: init.method,
      path: init.path,
      ...(init.query_keys && init.query_keys.length > 0 ? { query_keys: init.query_keys } : {}),
      ...(init.request_id ? { request_id: init.request_id } : {}),
      ...(init.content_type ? { content_type: init.content_type } : {}),
      ...(init.byte_length !== undefined ? { byte_length: init.byte_length } : {}),
      ...(init.request !== undefined ? { request: init.request } : {}),
      ...(id ? { id } : {}),
      ...(params ? { params } : {}),
    });
    let closed = false;
    const close = (phase: "response" | "error", fields?: LogFields) => {
      if (closed) {
        return;
      }
      closed = true;
      this.stack.pop(correlationId);
      const closeParams = compactParams(params, fields) ?? params;
      this.emit({
        kind: "http",
        phase,
        op: init.op,
        correlation_id: correlationId,
        ...(parent ? { parent_correlation_id: parent } : {}),
        method: init.method,
        path: init.path,
        duration_ms: Math.max(0, this.now().getTime() - started),
        ...(init.request_id ? { request_id: init.request_id } : {}),
        ...(omitResourceFields(fields) ?? {}),
        tag,
        ...(id ? { id } : {}),
        ...(closeParams ? { params: closeParams } : {}),
      });
    };
    return {
      correlationId,
      get closed() {
        return closed;
      },
      response: (status, fields) => close("response", { status, ...(fields ?? {}) }),
      error: (err, fields) =>
        close("error", {
          message: errorMessage(err),
          ...(errorProblem(err) ? { problem: errorProblem(err) } : {}),
          ...(err instanceof CliError ? { status: err.problem.status } : {}),
          ...(fields ?? {}),
        }),
    };
  }

  startLocal(init: StartLocalInit): LocalSpan {
    const correlationId = randomUUID();
    const parent = this.stack.push(correlationId);
    const started = this.now().getTime();
    const { op, message, id: initId, params: initParams, ...rest } = init;
    const tag = localTag(op);
    const id = resourceId(typeof initId === "string" ? initId : undefined, rest);
    const params = compactParams(initParams, rest);
    this.emit({
      kind: "local",
      phase: "start",
      op,
      correlation_id: correlationId,
      ...(parent ? { parent_correlation_id: parent } : {}),
      ...(message ? { message } : {}),
      ...rest,
      tag,
      ...(id ? { id } : {}),
      ...(params ? { params } : {}),
    });
    let closed = false;
    const close = (phase: "finish" | "error", fields?: LogFields) => {
      if (closed) {
        return;
      }
      closed = true;
      this.stack.pop(correlationId);
      const closeId = resourceId(id, fields);
      const closeParams = compactParams(params, fields);
      this.emit({
        kind: "local",
        phase,
        op,
        correlation_id: correlationId,
        ...(parent ? { parent_correlation_id: parent } : {}),
        duration_ms: Math.max(0, this.now().getTime() - started),
        ...(omitResourceFields(fields) ?? {}),
        tag,
        ...(closeId ? { id: closeId } : {}),
        ...(closeParams ? { params: closeParams } : {}),
      });
    };
    return {
      correlationId,
      get closed() {
        return closed;
      },
      progress: (fields) => {
        if (closed) {
          return;
        }
        const progressId = resourceId(id, fields);
        const progressParams = compactParams(params, fields);
        this.emit({
          kind: "local",
          phase: "progress",
          op,
          correlation_id: correlationId,
          ...(parent ? { parent_correlation_id: parent } : {}),
          ...(omitResourceFields(fields) ?? {}),
          tag,
          ...(progressId ? { id: progressId } : {}),
          ...(progressParams ? { params: progressParams } : {}),
        });
      },
      finish: (fields) => close("finish", fields),
      error: (err, fields) =>
        close("error", {
          message: errorMessage(err),
          ...(errorProblem(err) ? { problem: errorProblem(err) } : {}),
          ...(fields ?? {}),
        }),
    };
  }

  async withLocal<T>(init: StartLocalInit, fn: (span: LocalSpan) => Promise<T>): Promise<T> {
    const span = this.startLocal(init);
    try {
      const result = await fn(span);
      if (!span.closed) {
        span.finish();
      }
      return result;
    } catch (err) {
      if (!span.closed) {
        span.error(err);
      }
      throw err;
    }
  }

  beginRun(): void {
    if (!this.enabled || this.runSpan) {
      return;
    }
    this.runSpan = this.startLocal({
      op: "cli.run",
      message: this.command.length > 0 ? this.command.join(" ") : "screenrig",
    });
  }

  endRun(err?: unknown): void {
    if (!this.runSpan || this.runSpan.closed) {
      return;
    }
    if (err !== undefined) {
      this.runSpan.error(err);
    } else {
      this.runSpan.finish();
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.sink.close();
  }
}

const silentSink: LogSink = {
  writeLine() {},
  async close() {},
};

export const noopLogger: OperationLogger = new BaseLogger({
  enabled: false,
  command: [],
  now: () => new Date(),
  sink: silentSink,
});

export function loggerOf(runtime: { logger?: OperationLogger }): OperationLogger {
  return runtime.logger ?? noopLogger;
}

export function createMemoryLogger(options: { command?: string[]; now?: () => Date } = {}): {
  logger: OperationLogger;
  events: LogEvent[];
} {
  const events: LogEvent[] = [];
  const sink: LogSink = {
    writeLine(line) {
      events.push(JSON.parse(line) as LogEvent);
    },
    async close() {},
  };
  const logger = new BaseLogger({
    enabled: true,
    command: options.command ?? [],
    now: options.now ?? (() => new Date()),
    sink,
  });
  return { logger, events };
}

export function createSinkLogger(options: {
  sink: LogSink;
  command?: string[];
  now?: () => Date;
  runId?: string;
}): OperationLogger {
  return new BaseLogger({
    enabled: true,
    command: options.command ?? [],
    now: options.now ?? (() => new Date()),
    sink: options.sink,
    runId: options.runId,
  });
}

export function queryKeys(query?: Record<string, string | undefined>): string[] | undefined {
  if (!query) {
    return undefined;
  }
  const keys = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key]) => key);
  return keys.length > 0 ? keys : undefined;
}

export function loggingRunProcess(run: RunProcess, logger: OperationLogger): RunProcess {
  if (!logger.enabled) {
    return run;
  }
  return async (request) => {
    const commandName = path.basename(request.command) || request.command;
    return logger.withLocal(
      {
        op: "process.spawn",
        message: commandName,
        command_name: commandName,
        args: request.args.map((arg) => redactText(arg)),
      },
      async (span) => {
        const result = await run(request);
        if (result.spawnError || result.timedOut || (result.code !== 0 && result.code !== null)) {
          span.error(result.spawnError ?? `exit ${result.code ?? "unknown"}`, {
            exit_code: result.code,
            timed_out: result.timedOut,
            stderr_tail: redactText(result.stderrTail).slice(-800),
          });
          return result;
        }
        span.finish({ exit_code: result.code });
        return result;
      },
    );
  };
}

export function loggingTransport(transport: Transport, logger: OperationLogger): Transport {
  if (!logger.enabled) {
    return transport;
  }
  return {
    request: (req) => transport.request(req),
    download: (req) => transport.download(req),
    stream: async (req) => {
      const keys = queryKeys(req.query);
      const span = logger.startLocal({
        op: "sse.connect",
        message: `SSE ${req.method} ${req.path}`,
        method: req.method,
        path: req.path,
        ...(keys ? { query_keys: keys } : {}),
      });
      let stream: TransportStream;
      try {
        stream = await transport.stream(req);
      } catch (err) {
        span.error(err);
        throw err;
      }
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of stream) {
              const eventMatch = /^event:\s*(\S+)/m.exec(chunk);
              if (eventMatch?.[1]) {
                span.progress({ event_type: eventMatch[1] });
              }
              yield chunk;
            }
            span.finish();
          } catch (err) {
            span.error(err);
            throw err;
          }
        },
      };
    },
  };
}

export function loggingSignedRawPut(put: SignedRawPut, logger: OperationLogger): SignedRawPut {
  if (!logger.enabled) {
    return put;
  }
  return async (request) => {
    const byteLength = request.body instanceof Uint8Array ? request.body.byteLength : undefined;
    return logger.withLocal(
      {
        op: "media.signed_put",
        message: "PUT signed media object",
        method: "PUT",
        ...(byteLength !== undefined ? { byte_length: byteLength } : {}),
      },
      async (span) => {
        try {
          const response = await put(request);
          if (response.status < 200 || response.status >= 300) {
            span.error(`HTTP ${response.status}`, { status: response.status });
            return response;
          }
          span.finish({ status: response.status, ...(byteLength !== undefined ? { byte_length: byteLength } : {}) });
          return response;
        } catch (err) {
          span.error(err);
          throw err;
        }
      },
    );
  };
}
