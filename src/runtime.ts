import { spawn } from "node:child_process";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Readable, type Writable } from "node:stream";
import type { Transport } from "./transport/types.js";
import type { ConfigFs } from "./config.js";
import type { OperationLogger } from "./log/types.js";
import { openExternalUrl, openLocalPath, type OpenPath, type OpenUrl } from "./open-url.js";

export interface CliRuntime {
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
}

export interface SignedRawPutRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: Uint8Array | AsyncIterable<Uint8Array>;
  credentials: "omit";
  redirect: "error";
}

export interface SignedRawPutResponse {
  status: number;
  bodyText?: string;
}

export type SignedRawPut = (request: SignedRawPutRequest) => Promise<SignedRawPutResponse>;

export interface RunProcessRequest {
  command: string;
  args: string[];
  /** Receives each complete stdout line. When set, stdout is streamed instead of captured. */
  onStdoutLine?: (line: string) => void;
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
}

export type RunProcess = (request: RunProcessRequest) => Promise<RunProcessResult>;

const STDERR_TAIL_LIMIT = 8192;

export function spawnRunProcess(): RunProcess {
  return (request) =>
    new Promise<RunProcessResult>((resolve) => {
      let child;
      try {
        child = spawn(request.command, request.args, {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
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

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (!streaming) {
          stdout += chunk;
          return;
        }
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          request.onStdoutLine?.(pending.slice(0, newline).replace(/\r$/, ""));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });

      const settle = (result: RunProcessResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (streaming && pending.length > 0) {
          request.onStdoutLine?.(pending.replace(/\r$/, ""));
          pending = "";
        }
        resolve(result);
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

export function fetchSignedRawPut(fetchImpl: typeof fetch = fetch): SignedRawPut {
  return async (request) => {
    const streaming = !(request.body instanceof Uint8Array);
    const body: Buffer | Readable = request.body instanceof Uint8Array
      ? Buffer.from(request.body)
      : Readable.from(request.body);
    const init = {
      method: request.method,
      headers: request.headers,
      body,
      credentials: request.credentials,
      redirect: request.redirect,
      ...(streaming ? { duplex: "half" } : {}),
    } as RequestInit;
    const response = await fetchImpl(request.url, init);
    return { status: response.status, bodyText: await response.text() };
  };
}

export function processRuntime(): CliRuntime {
  return {
    argv: process.argv.slice(2),
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
