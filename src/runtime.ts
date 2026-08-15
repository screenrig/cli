import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { Writable } from "node:stream";
import type { Transport } from "./transport/types.js";
import type { ConfigFs } from "./config.js";
import { openExternalUrl, type OpenUrl } from "./open-url.js";

export interface CliRuntime {
  argv: string[];
  env: NodeJS.Dict<string>;
  stdout: Writable;
  stderr: Writable;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  homedir: () => string;
  fs: ConfigFs;
  transport?: Transport;
  signedRawPut?: SignedRawPut;
  cwd: () => string;
  openUrl?: OpenUrl;
}

export interface SignedRawPutRequest {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  body: Uint8Array;
  credentials: "omit";
  redirect: "error";
}

export interface SignedRawPutResponse {
  status: number;
  bodyText?: string;
}

export type SignedRawPut = (request: SignedRawPutRequest) => Promise<SignedRawPutResponse>;

export function fetchSignedRawPut(fetchImpl: typeof fetch = fetch): SignedRawPut {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: Buffer.from(request.body),
      credentials: request.credentials,
      redirect: request.redirect,
    });
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
