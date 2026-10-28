import { spawn } from "node:child_process";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Readable, type Writable } from "node:stream";
import { childEnv } from "./child-env.js";
import type { Transport } from "./transport/types.js";
import type { ConfigFs } from "./config.js";
import type { OperationLogger } from "./log/types.js";
import { redactText } from "./redact.js";
import { USER_AGENT } from "./user-agent.js";
import { openExternalUrl, openLocalPath, type OpenPath, type OpenUrl } from "./open-url.js";

export interface CliRuntime {
  stdin?: AsyncIterable<Uint8Array | string>;
  isStdinTty?: () => boolean;
  argv: string[];
  env: NodeJS.Dict<string>;
  stdout: Writable;
  stderr: Writable;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  homedir: () => string;
  fs: ConfigFs;
  logger?: OperationLogger;
  transport?: Transport;
  signedRawPut?: SignedRawPut;
  cwd: () => string;
  openUrl?: OpenUrl;
  openPath?: OpenPath;
  runProcess?: RunProcess;
  isStderrTty?: () => boolean;
  /** The fetch migrate uses for the vendor it reads; the global fetch when absent. Tests inject a fixture router. */
  vendorFetch?: typeof fetch;
  /** The fetch for files the site serves beside the dashboard (the Android build list); the global fetch when absent. Tests inject a fixture. */
  siteFetch?: typeof fetch;
}

export interface SignedRawPutRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: Uint8Array | AsyncIterable<Uint8Array>;
  credentials: "omit";
  redirect: "error";
  /**
   * Do not start the transfer once its signed upload session has expired.
   * Storage checks the URL when the request starts, so a transfer already
   * sending is never cut off at this time.
   */
  expiresAt?: number;
}

export interface SignedRawPutResponse {
  status: number;
  /** Never read: a storage body can carry signed request material. */
  bodyText?: string;
  /** A refusal's error code from storage (ExpiredRequest, BadDigest, SignatureDoesNotMatch, ...). */
  errorCode?: string;
  /** That refusal's message, redacted and bounded. */
  errorMessage?: string;
}

export type SignedRawPut = (request: SignedRawPutRequest) => Promise<SignedRawPutResponse>;

export interface RunProcessRequest {
  command: string;
  args: string[];
  /** Receives each complete stdout line. When set, stdout is streamed instead of captured. */
  onStdoutLine?: (line: string) => void | boolean;
  /** Stream stderr without retaining it; return false to stop a rejected inspection. */
  onStderrLine?: (line: string) => void | boolean;
  /** Bound pending streamed lines; exceeding this aborts the process. */
  maxLineChars?: number;
  timeoutMs?: number;
}

export interface RunProcessResult {
  /** Null when the child was terminated by a signal or never started cleanly. */
  code: number | null;
  signal: string | null;
  /** Captured stdout, or the empty string when onStdoutLine streamed it. */
  stdout: string;
  /** Bounded tail of stderr, for diagnostics only. */
  stderrTail: string;
  /** Set when the process could not be started at all. */
  spawnError?: string;
  timedOut?: boolean;
  outputTruncated?: boolean;
  stoppedEarly?: boolean;
}

export type RunProcess = (request: RunProcessRequest) => Promise<RunProcessResult>;

const STDERR_TAIL_LIMIT = 8192;

export function spawnRunProcess(env: NodeJS.ProcessEnv = process.env): RunProcess {
  return (request) =>
    new Promise<RunProcessResult>((resolve) => {
      let child;
      try {
        child = spawn(request.command, request.args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: childEnv(env),
        });
      } catch (error) {
        resolve({
          code: null,
          signal: null,
          stdout: "",
          stderrTail: "",
          spawnError: error instanceof Error ? error.message : "spawn failed",
        });
        return;
      }

      const streaming = typeof request.onStdoutLine === "function";
      let stdout = "";
      let pending = "";
      let stderrPending = "";
      let outputTruncated = false;
      let stoppedEarly = false;
      let stderrTail = "";
      let settled = false;
      let timedOut = false;

      const timer =
        request.timeoutMs && request.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, request.timeoutMs)
          : undefined;

      const emit = (line: string, callback: (line: string) => void | boolean) => {
        if (stoppedEarly) return;
        if (request.maxLineChars && line.length > request.maxLineChars) {
          outputTruncated = true;
          stoppedEarly = true;
        } else if (callback(line.replace(/\r$/, "")) === false) {
          stoppedEarly = true;
        }
        if (stoppedEarly) child.kill("SIGKILL");
      };
      const lines = (previous: string, chunk: string, callback: (line: string) => void | boolean): string => {
        if (stoppedEarly) return "";
        const text = previous + chunk;
        let start = 0;
        for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
          emit(text.slice(start, end), callback);
          start = end + 1;
          if (stoppedEarly) return "";
        }
        const rest = text.slice(start);
        if (request.maxLineChars && rest.length > request.maxLineChars) {
          outputTruncated = true;
          stoppedEarly = true;
          child.kill("SIGKILL");
          return "";
        }
        return rest;
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (!streaming) { stdout += chunk; return; }
        pending = lines(pending, chunk, request.onStdoutLine!);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        if (request.onStderrLine) stderrPending = lines(stderrPending, chunk, request.onStderrLine);
        else stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      const settle = (result: RunProcessResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (streaming && pending.length > 0) {
          emit(pending, request.onStdoutLine!);
          pending = "";
        }
        if (request.onStderrLine && stderrPending) emit(stderrPending, request.onStderrLine);
        resolve({ ...result, outputTruncated, stoppedEarly });
      };

      child.on("error", (error) => {
        settle({
          code: null,
          signal: null,
          stdout,
          stderrTail,
          spawnError: error instanceof Error ? error.message : "spawn failed",
        });
      });

      child.on("close", (code, signal) => {
        settle({ code, signal, stdout, stderrTail, timedOut });
      });
    });
}

/**
 * A signed PUT that hands no body bytes to the connection for this long has
 * stalled. On a slow link the connection takes bytes in bursts, each time the
 * operating system has sent about half of what it holds (a few MB), so
 * minutes can pass between them while the upload keeps moving.
 */
export const SIGNED_PUT_IDLE_MS = 10 * 60_000;

/**
 * How long storage may take to answer once the whole body has been handed to
 * the connection. The operating system, and any proxy on the way, may still
 * be sending megabytes they accepted: at a few KB/s that takes many minutes,
 * and none of it can be seen from here.
 */
export const SIGNED_PUT_ANSWER_MS = 30 * 60_000;

type Dispatcher = { dispatch(options: object, handler: object): boolean };

/**
 * Node's fetch gives up on an answer that has not started 300 seconds after
 * the body was handed to the operating system, however much of it is still
 * on its way. A signed PUT has the limits above instead, so it asks for no
 * headers or body timeout of its own. Undefined when this Node keeps no
 * global dispatcher to wrap. `timeouts` exists for its test.
 */
export function signedPutDispatcher(timeouts = { headersTimeout: 0, bodyTimeout: 0 }): Dispatcher | undefined {
  const base = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] as Partial<Dispatcher> | undefined;
  if (typeof base?.dispatch !== "function") return undefined;
  return { dispatch: (options, handler) => base.dispatch!({ ...options, ...timeouts }, handler) };
}

function stalled(code: "UPLOAD_STALLED" | "UPLOAD_UNANSWERED"): Error {
  return Object.assign(new Error(code === "UPLOAD_STALLED" ? "No upload bytes moved." : "Storage did not answer the upload."), { code });
}

/** How much of a refusal's body is read for its error code and message. */
const STORAGE_ERROR_BYTES = 8 * 1024;

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/**
 * The Code and Message of an object store's XML error, and nothing else from
 * it: a signature refusal goes on to quote the signed request. The message is
 * redacted, loses any URL, and is kept short.
 */
export function storageError(text: string): Pick<SignedRawPutResponse, "errorCode" | "errorMessage"> {
  const field = (name: string) => new RegExp(`<${name}>([^<]{1,2000})</${name}>`).exec(text)?.[1]
    ?.replace(/&(lt|gt|amp|quot|apos);/g, (_entity, name: string) => XML_ENTITIES[name] ?? "")
    .replace(/\s+/g, " ").trim();
  const code = field("Code");
  const message = field("Message");
  const cleaned = message === undefined ? "" : redactText(message).replace(/\bhttps?:\/\/\S+/gi, "[url]").replace(/\.$/, "");
  return {
    ...(code && /^[A-Za-z][A-Za-z0-9.]{0,63}$/.test(code) ? { errorCode: code } : {}),
    ...(cleaned ? { errorMessage: cleaned.length > 300 ? `${cleaned.slice(0, 300)}…` : cleaned } : {}),
  };
}

/** The start of a refusal's body, read for `storageError`; a body that cannot be read leaves the status alone. */
async function readStorageError(response: Response): Promise<Pick<SignedRawPutResponse, "errorCode" | "errorMessage">> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < STORAGE_ERROR_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } catch {
    return {};
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return storageError(Buffer.concat(parts).subarray(0, STORAGE_ERROR_BYTES).toString("utf8"));
}

/**
 * One signed PUT. It never starts after `expiresAt`, and it is ended only when
 * it stalls: no body bytes handed over for SIGNED_PUT_IDLE_MS, or no answer
 * SIGNED_PUT_ANSWER_MS after the last one. There is no limit on its total time.
 */
export function fetchSignedRawPut(fetchImpl: typeof fetch = fetch): SignedRawPut {
  return async (request) => {
    const source = request.body;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const arm = (ms: number, code: "UPLOAD_STALLED" | "UPLOAD_UNANSWERED") => {
      clearTimeout(timer);
      if (finished) return;
      // The open connection keeps the process alive; the limit itself never does.
      timer = setTimeout(() => controller.abort(stalled(code)), ms);
      timer.unref?.();
    };
    // Fetch copies BufferSource bodies. Stream views of the held, verified
    // bytes instead, keeping read-ahead bounded without reopening the path.
    const chunks = source instanceof Uint8Array ? (function* () {
      for (let offset = 0; offset < source.byteLength; offset += 256 * 1024) {
        yield source.subarray(offset, Math.min(offset + 256 * 1024, source.byteLength));
      }
    })() : source;
    // The connection takes a chunk only when it can send more, so each one
    // taken is progress.
    const watched = (async function* () {
      for await (const chunk of chunks) {
        arm(SIGNED_PUT_IDLE_MS, "UPLOAD_STALLED");
        yield chunk;
      }
      arm(SIGNED_PUT_ANSWER_MS, "UPLOAD_UNANSWERED");
    })();
    const body = Readable.from(watched, { objectMode: false, highWaterMark: 256 * 1024 });
    try {
      if (request.expiresAt !== undefined && request.expiresAt <= Date.now()) throw new Error("Media upload session expired.");
      arm(SIGNED_PUT_IDLE_MS, "UPLOAD_STALLED");
      const dispatcher = signedPutDispatcher();
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: { "user-agent": USER_AGENT, ...request.headers },
        body,
        credentials: request.credentials,
        redirect: request.redirect,
        signal: controller.signal,
        duplex: "half",
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      // Do not buffer an untrusted, potentially unending storage response or
      // retain its signed diagnostics: a success is its status, a refusal its
      // status, error code and message from the first 8 KiB.
      if (response.status >= 200 && response.status < 300) {
        await response.body?.cancel();
        return { status: response.status };
      }
      arm(SIGNED_PUT_IDLE_MS, "UPLOAD_STALLED");
      return { status: response.status, ...(await readStorageError(response)) };
    } catch (error) {
      // A stall is reported as itself, not as the abort it caused.
      throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
    } finally {
      finished = true;
      clearTimeout(timer);
      body.destroy();
      // Readable.from may not start its input before a rejected fetch. Close a
      // caller-owned stream as well so an unopened wrapper cannot leak its fd.
      if (source instanceof Readable) source.destroy();
    }
  };
}

export function processRuntime(): CliRuntime {
  return {
    argv: process.argv.slice(2),
    stdin: process.stdin,
    isStdinTty: () => process.stdin.isTTY === true,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    homedir,
    cwd: () => process.cwd(),
    signedRawPut: fetchSignedRawPut(),
    openUrl: openExternalUrl,
    openPath: openLocalPath,
    runProcess: spawnRunProcess(),
    isStderrTty: () => process.stderr.isTTY === true,
    fs: {
      mkdir,
      open,
      rename,
      rm,
      chmod,
      stat,
      homedir,
      env: process.env,
    },
  };
}
