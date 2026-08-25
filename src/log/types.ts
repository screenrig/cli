export const LOG_EVENT_VERSION = 1 as const;

export type LogKind = "http" | "local";
export type HttpPhase = "request" | "response";
export type LocalPhase = "start" | "progress" | "finish" | "error";
export type LogPhase = HttpPhase | LocalPhase;

/** One NDJSON object. Additional redacted fields may be present. */
export interface LogEvent {
  v: typeof LOG_EVENT_VERSION;
  ts: string;
  event_id: string;
  correlation_id: string;
  run_id: string;
  command: string[];
  kind: LogKind;
  phase: LogPhase;
  op: string;
  /** Compact snake_case display key. Prefer this over `message` for HTTP. */
  tag?: string;
  /** Associated resource id (`scr_…`, `pl_…`, `med_…`, application or operation id). Not `event_id` or `correlation_id`. */
  id?: string;
  /** Small scalar extras. Omitted when empty. */
  params?: Record<string, string | number | boolean>;
  duration_ms?: number;
  parent_correlation_id?: string;
  message?: string;
  method?: string;
  path?: string;
  query_keys?: string[];
  status?: number;
  request_id?: string;
  content_type?: string;
  byte_length?: number;
  request?: unknown;
  response?: unknown;
  problem?: { code?: string; detail?: string; message?: string };
  [key: string]: unknown;
}

export interface LogFields {
  [key: string]: unknown;
}

export interface LocalSpan {
  readonly correlationId: string;
  readonly closed: boolean;
  progress(fields?: LogFields): void;
  finish(fields?: LogFields): void;
  error(err: unknown, fields?: LogFields): void;
}

export interface HttpSpan {
  readonly correlationId: string;
  readonly closed: boolean;
  response(status: number, fields?: LogFields): void;
  error(err: unknown, fields?: LogFields): void;
}

export interface StartHttpInit {
  op: string;
  method: string;
  path: string;
  message?: string;
  query_keys?: string[];
  request_id?: string;
  content_type?: string;
  byte_length?: number;
  request?: unknown;
  id?: string;
  params?: Record<string, string | number | boolean>;
}

export interface StartLocalInit {
  op: string;
  message?: string;
  id?: string;
  params?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export interface OperationLogger {
  readonly enabled: boolean;
  readonly runId: string;
  readonly command: string[];
  setCommand(command: string[]): void;
  emit(event: Omit<LogEvent, "v" | "ts" | "event_id" | "run_id" | "command"> & Partial<Pick<LogEvent, "command">>): void;
  startHttp(init: StartHttpInit): HttpSpan;
  startLocal(init: StartLocalInit): LocalSpan;
  withLocal<T>(init: StartLocalInit, fn: (span: LocalSpan) => Promise<T>): Promise<T>;
  beginRun(): void;
  endRun(err?: unknown): void;
  close(): Promise<void>;
}

export interface LogSink {
  writeLine(line: string): void;
  close(): Promise<void>;
}
