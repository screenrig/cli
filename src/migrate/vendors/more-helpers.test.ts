import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../../problems.js";
import { createVendorHttp } from "../http.js";
import type { LocalFiles } from "../local-files.js";
import type { SourceCatalog, VendorAdapter, VendorHttp, VendorSession } from "../types.js";

/** Shared by the ScreenCloud, Screenly, Anthias and OptiSigns tests. It holds no tests itself. */
export const FIXTURES = fileURLToPath(new URL("../../../fixtures/migrate/", import.meta.url));
export const NOW = new Date("2026-10-28T10:00:00.000Z");

export async function fixture<T = unknown>(vendor: string, name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURES, vendor, `${name}.json`), "utf8")) as T;
}

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

export interface Router {
  fetch: typeof fetch;
  requests: Recorded[];
}

/** A fetch that records every request and answers with `handler`. */
export function router(handler: (request: Recorded) => Response | Promise<Response>): Router {
  const requests: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetch: impl, requests };
}

export function httpFor(adapter: Pick<VendorAdapter, "id" | "name" | "credentials">, fetchImpl: typeof fetch, sleeps: number[] = []): VendorHttp {
  return createVendorHttp({
    vendor: adapter.id,
    name: adapter.name,
    credentialNames: adapter.credentials.map((credential) => credential.env),
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => NOW.getTime(),
    random: () => 1,
  });
}

export interface OpenOptions {
  url?: string;
  region?: string;
  timezone?: string;
  files?: LocalFiles;
  credentials?: Record<string, string>;
}

export function open(adapter: VendorAdapter, fetchImpl: typeof fetch, options: OpenOptions = {}): Promise<VendorSession> {
  return adapter.open({
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
    ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
    credentials: options.credentials ?? {},
    http: httpFor(adapter, fetchImpl),
    ...(options.files ? { files: options.files } : {}),
    now: () => NOW,
  });
}

export async function scan(adapter: VendorAdapter, fetchImpl: typeof fetch, options: OpenOptions = {}): Promise<SourceCatalog> {
  return (await open(adapter, fetchImpl, options)).scan();
}

/** The problem code of a CliError a promise rejects with. */
export async function problemOf(promise: Promise<unknown>): Promise<{ code: string; detail: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return { code: error.problem.code, detail: error.problem.detail };
    throw error;
  }
  throw new Error("expected a CliError, but nothing was thrown");
}

/** A deterministic body of `size` bytes, so a download can be compared byte for byte. */
export function bytesOf(size: number, seed = 7): Buffer {
  const buffer = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buffer[index] = state >>> 16;
  }
  return buffer;
}
