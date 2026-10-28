import { open, rm, type FileHandle } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ProblemNext } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem } from "../problems.js";
import { USER_AGENT } from "../user-agent.js";
import type { VendorClient, VendorClientOptions, VendorHttp, VendorRequestInit, VendorRequestLog, VendorResponse } from "./types.js";

/** Attempts after the first: 429, 503 and network errors are tried this many more times. */
export const VENDOR_RETRIES = 5;
/** A Retry-After longer than this is not waited for. */
export const VENDOR_RETRY_AFTER_MAX_S = 120;
export const VENDOR_BACKOFF_CAP_MS = 30_000;
const MAX_REDIRECTS = 5;
/** How long a request may wait for the answer's headers. The body has its own idle limit. */
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a body may go without a byte before the transfer is dropped. */
const IDLE_TIMEOUT_MS = 60_000;

export interface VendorHttpOptions {
  /** Adapter id, for the operation log. */
  vendor: string;
  /** Adapter name, for messages. */
  name: string;
  /** Environment variable names the adapter reads, named when the vendor refuses the credential. */
  credentialNames: readonly string[];
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Epoch milliseconds. */
  now: () => number;
  random?: () => number;
  log?: (request: VendorRequestLog) => void;
  /** Milliseconds to wait for a response's headers (default 60 s). */
  requestTimeoutMs?: number;
  /** Milliseconds a body may stay silent before it is dropped (default 60 s). */
  idleTimeoutMs?: number;
}

function problem(code: string, title: string, status: number, detail: string, exit: ExitCode, hint?: string, next?: ProblemNext): CliError {
  return new CliError(makeProblem(code, title, status, detail, hint || next ? { ...(hint ? { hint } : {}), ...(next ? { next } : {}) } : undefined), exit);
}

export function vendorRefused(name: string, status: number, credentialNames: readonly string[]): CliError {
  const names = credentialNames.length ? credentialNames.join(" and ") : "the credential";
  return problem("vendor_refused", "Vendor refused the credential", status,
    `${name} refused the request (HTTP ${status}). Check ${names}, and that the key is allowed to read.`, ExitCode.Auth,
    `Nothing was sent to screenRIG. Make or fix a read-only key at ${name}, put it where ${names} is read, and run the same command again.`);
}

export function vendorNotFound(name: string, what: string): CliError {
  return problem("vendor_not_found", "Vendor address not found", 404,
    `${name} answered 404 for ${what}. The --url is usually the cause: it must be the address of the ${name} service itself.`, ExitCode.NotFound,
    "Check --url (scheme, host and any path prefix) and run the same command again.");
}

export function vendorRateLimited(name: string, detail: string): CliError {
  return problem("vendor_rate_limited", "Vendor rate limit", 429, `${name} is rate limiting this key: ${detail}`, ExitCode.RateLimited,
    "Run the same command again later; reruns continue where this one stopped.");
}

export function vendorUnavailable(name: string, detail: string, status: number): CliError {
  return problem("vendor_unavailable", "Vendor unavailable", status, `${name} could not be reached or kept failing: ${detail}`,
    status >= 500 ? ExitCode.Server : ExitCode.Network, "Check the vendor's status and your network, then run the same command again; reruns continue where this one stopped.");
}

/** A file address the vendor listed no longer serves its file, and the host that answered was sent no credential. */
export function vendorFileGone(name: string, vendor: string, status: number): CliError {
  return problem("vendor_file_gone", "Vendor file address no longer works", 410,
    `A file address ${name} listed answered HTTP ${status} from a host that was sent no key: the address has expired or is protected, and the key is not the cause. Run migrate scan again to refresh the file addresses, then run the same apply again.`, ExitCode.Client,
    "A file that still fails after a new scan can be supplied with --files.",
    { command: `screenrig migrate scan --from ${vendor}`, reason: "Reads the account again, with the same options and --dir, which refreshes the file addresses." });
}

/** A file download that went silent: only that file is dropped. */
export function vendorFileStalled(name: string): CliError {
  return problem("vendor_file_stalled", "Vendor file download stalled", 408,
    `${name} stopped sending a file, so that download was dropped.`, ExitCode.Timeout,
    "Run the same apply again: the file is downloaded from the start.");
}

export function vendorBadResponse(name: string, detail: string): CliError {
  return problem("vendor_bad_response", "Vendor sent an unusable answer", 502, `${name} sent an answer this CLI cannot use: ${detail}`, ExitCode.Server,
    "The vendor's API may have changed. Run the scan again; if it keeps happening, report it with screenrig feedback bug and say which vendor.");
}

/** Seconds from a Retry-After header: whole seconds, or an HTTP date. */
export function retryAfterSeconds(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - nowMs) / 1000)) : undefined;
}

/** Equal jitter: at least half the exponential delay, capped at 30 seconds. */
export function backoffMs(attempt: number, random: () => number): number {
  const exp = Math.min(VENDOR_BACKOFF_CAP_MS, 1000 * 2 ** attempt);
  return Math.floor(exp * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function sameOrigin(a: URL, b: URL): boolean {
  return a.origin === b.origin;
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) result[name.toLowerCase()] = value;
  return result;
}

function headerObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name.toLowerCase()] = value;
  });
  return result;
}

/**
 * The system error code in a fetch failure's cause chain (ENOTFOUND, ECONNREFUSED,
 * DEPTH_ZERO_SELF_SIGNED_CERT): a short fixed word, never a message or an address.
 */
function causeCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return code;
    current = current.cause;
  }
  return undefined;
}

export function createVendorHttp(options: VendorHttpOptions): VendorHttp {
  const random = options.random ?? Math.random;
  return {
    client(clientOptions: VendorClientOptions): VendorClient {
      return new Client(options, clientOptions, random);
    },
  };
}

class Client implements VendorClient {
  readonly origin: string;
  private readonly base: string;
  private auth: Record<string, string>;
  private readonly slots: number[] = [];

  constructor(
    private readonly http: VendorHttpOptions,
    private readonly options: VendorClientOptions,
    private readonly random: () => number,
  ) {
    let parsed: URL;
    try {
      parsed = new URL(options.base);
    } catch {
      throw problem("usage_error", "Invalid command usage", 400, `${http.name} needs a full address starting with http:// or https://.`, ExitCode.Usage);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw problem("usage_error", "Invalid command usage", 400, `${http.name} needs an address starting with http:// or https://.`, ExitCode.Usage);
    }
    this.origin = parsed.origin;
    this.base = options.base.replace(/\/+$/, "");
    this.auth = lowerKeys(options.auth);
  }

  setAuth(headers: Record<string, string> | undefined): void {
    this.auth = lowerKeys(headers);
  }

  /** An API path under the base. A path that resolves to another origin is refused. */
  private resolve(path: string): URL {
    const absolute = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(path);
    let url: URL;
    try {
      url = new URL(absolute ? path : `${this.base}${path === "" ? "" : path.startsWith("/") ? path : `/${path}`}`, this.base);
    } catch {
      throw vendorBadResponse(this.http.name, "a request path could not be read as an address");
    }
    if (url.origin !== this.origin) throw vendorBadResponse(this.http.name, "a request path resolved to another origin, so it was not sent");
    return url;
  }

  /** Waits for a free slot in the sliding window shared by every request of this client. */
  private async acquire(): Promise<void> {
    const rate = this.options.rate;
    if (!rate) return;
    const now = this.http.now();
    while (this.slots.length > 0 && this.slots[0]! <= now - rate.perMs) this.slots.shift();
    const at = this.slots.length >= rate.requests ? Math.max(now, this.slots[this.slots.length - rate.requests]! + rate.perMs) : now;
    this.slots.push(at);
    if (at > now) await this.http.sleep(at - now);
  }

  private async once(url: URL, method: string, headers: Record<string, string>, body: string | undefined): Promise<Response> {
    await this.acquire();
    const started = this.http.now();
    // The request limit runs only until the headers arrive: a body that is still flowing is never cut off by it.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.http.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.http.fetch(url.toString(), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal: controller.signal,
      });
      this.http.log?.({ vendor: this.http.vendor, method, status: response.status, ms: this.http.now() - started });
      return response;
    } catch (error) {
      const cause = timedOut ? "REQUEST_TIMEOUT" : causeCode(error);
      this.http.log?.({ vendor: this.http.vendor, method, status: 0, ms: this.http.now() - started, ...(cause ? { cause } : {}) });
      throw new NetworkFailure(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One hop: retried on 429, 503 and network errors; every other status comes back as it is. */
  private async hop(url: URL, method: string, headers: Record<string, string>, body: string | undefined): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response | undefined;
      try {
        response = await this.once(url, method, headers, body);
      } catch (error) {
        if (!(error instanceof NetworkFailure)) throw error;
        if (attempt >= VENDOR_RETRIES) throw vendorUnavailable(this.http.name, `the connection failed or timed out${error.code ? ` (${error.code})` : ""}`, 0);
        await this.http.sleep(backoffMs(attempt, this.random));
        continue;
      }
      if (response.status !== 429 && response.status !== 503) return response;
      const seconds = retryAfterSeconds(response.headers.get("retry-after"), this.http.now());
      await response.body?.cancel().catch(() => undefined);
      if (seconds !== undefined && seconds > VENDOR_RETRY_AFTER_MAX_S) {
        throw vendorRateLimited(this.http.name, `it asked to wait ${seconds} seconds, which is more than this command waits.`);
      }
      if (attempt >= VENDOR_RETRIES) {
        if (response.status === 429) throw vendorRateLimited(this.http.name, "it still answered 429 after several tries.");
        throw vendorUnavailable(this.http.name, "it still answered 503 after several tries", 503);
      }
      await this.http.sleep(seconds !== undefined ? seconds * 1000 : backoffMs(attempt, this.random));
    }
  }

  /**
   * Follows redirects by hand: the credential goes only to the base origin. Returns the
   * final answer and the address it came from.
   */
  private async perform(start: URL, init: VendorRequestInit): Promise<{ response: Response; url: URL }> {
    let url = start;
    let method = (init.method ?? "GET").toUpperCase();
    let body: string | undefined = init.form !== undefined ? new URLSearchParams(init.form).toString()
      : init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const content: Record<string, string> = init.form !== undefined ? { "content-type": "application/x-www-form-urlencoded" }
      : init.body !== undefined ? { "content-type": "application/json" } : {};
    for (let redirects = 0; ; redirects += 1) {
      const headers: Record<string, string> = {
        "user-agent": USER_AGENT,
        accept: "application/json",
        ...(body === undefined ? {} : content),
        ...lowerKeys(init.headers),
        ...(url.origin === this.origin ? this.auth : {}),
      };
      const response = await this.hop(url, method, headers, body);
      const location = response.headers.get("location");
      if (!REDIRECTS.has(response.status) || !location) return { response, url };
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= MAX_REDIRECTS) throw vendorBadResponse(this.http.name, "it redirected more than 5 times");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw vendorBadResponse(this.http.name, "it redirected to an address that cannot be read");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") throw vendorBadResponse(this.http.name, "it redirected to an address that is not http or https");
      if (response.status !== 307 && response.status !== 308 && method !== "GET" && method !== "HEAD") {
        method = "GET";
        body = undefined;
      } else if (body !== undefined && !sameOrigin(next, url)) {
        // A 307 or 308 repeats the body, which can hold the client secret: it goes only where the credential goes.
        throw vendorBadResponse(this.http.name, "it redirected a request with a body to another address, so the request was not repeated there");
      }
      url = next;
    }
  }

  private fail(status: number, what: string): CliError {
    const { name, credentialNames } = this.http;
    if (status === 401 || status === 403) return vendorRefused(name, status, credentialNames);
    if (status === 404) return vendorNotFound(name, what);
    if (status === 429) return vendorRateLimited(name, "it answered 429.");
    if (status >= 500) return vendorUnavailable(name, `it answered HTTP ${status}`, status);
    return vendorBadResponse(name, `it answered HTTP ${status} for ${what}`);
  }

  async response<T = unknown>(path: string, init: VendorRequestInit = {}): Promise<VendorResponse<T>> {
    const url = this.resolve(path);
    if (init.query) {
      for (const [name, value] of Object.entries(init.query)) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
    }
    const what = `${(init.method ?? "GET").toUpperCase()} ${/^([a-z][a-z0-9+.-]*:)?\/\//i.test(path) ? url.pathname : path.split("?")[0]}`;
    const { response } = await this.perform(url, init);
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      throw this.fail(response.status, what);
    }
    const text = await this.readText(response);
    let parsed: unknown;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw vendorBadResponse(this.http.name, `it answered ${what} with a body that is not JSON`);
      }
    }
    return { status: response.status, headers: headerObject(response.headers), body: parsed as T };
  }

  /** A whole small body, dropped if it goes silent for the idle limit. */
  private async readText(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const idleMs = this.http.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    let text = "";
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silent = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NetworkFailure("IDLE_TIMEOUT")), idleMs);
        timer.unref?.();
      });
      try {
        const next = await Promise.race([reader.read(), silent]);
        if (next.done) return text + decoder.decode();
        text += decoder.decode(next.value, { stream: true });
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        const code = error instanceof NetworkFailure ? error.code : causeCode(error);
        throw vendorUnavailable(this.http.name, `an answer stopped arriving${code ? ` (${code})` : ""}`, 0);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async json<T = unknown>(path: string, init: VendorRequestInit = {}): Promise<T> {
    return (await this.response<T>(path, init)).body;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const answer = await this.json<{ data?: T; errors?: Array<{ extensions?: { code?: unknown } }> } | undefined>("", { method: "POST", body: { query, variables } });
    if (answer && Array.isArray(answer.errors) && answer.errors.length > 0) {
      // Messages are the vendor's own words and can echo what was sent: only a short code is kept.
      const codes = [...new Set(answer.errors.map((error) => error.extensions?.code).filter((code): code is string => typeof code === "string" && /^[A-Za-z_]{3,40}$/.test(code)))];
      if (codes.some((code) => /^(UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN)$/i.test(code))) {
        throw vendorRefused(this.http.name, 401, this.http.credentialNames);
      }
      throw vendorBadResponse(this.http.name, `its GraphQL answer carried ${answer.errors.length} error${answer.errors.length === 1 ? "" : "s"}${codes.length ? ` (${codes.join(", ")})` : ""}`);
    }
    if (!answer || answer.data === undefined || answer.data === null) throw vendorBadResponse(this.http.name, "its GraphQL answer has no data");
    return answer.data;
  }

  async download(url: string, destination: string): Promise<{ bytes: number }> {
    let target: URL;
    try {
      // A path is under the base like any API path; a full address may be anywhere and then carries no credential.
      target = /^([a-z][a-z0-9+.-]*:)?\/\//i.test(url) ? new URL(url) : this.resolve(url);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw vendorBadResponse(this.http.name, "a file address could not be read");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") throw vendorBadResponse(this.http.name, "a file address is not http or https");
    const { response, url: answered } = await this.perform(target, { headers: { accept: "*/*" } });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      // The host that answered was sent no credential, so its refusal says the address is stale, not that the key is wrong.
      if (answered.origin !== this.origin && (response.status === 401 || response.status === 403 || response.status === 410)) {
        throw vendorFileGone(this.http.name, this.http.vendor, response.status);
      }
      throw this.fail(response.status, "a file download");
    }
    if (!response.body) throw vendorBadResponse(this.http.name, "a file download had no body");
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), this.http.idleTimeoutMs ?? IDLE_TIMEOUT_MS);
      timer.unref?.();
    };
    let bytes = 0;
    const source = Readable.fromWeb(response.body as never);
    let handle: FileHandle;
    try {
      handle = await open(destination, "wx", 0o600);
    } catch (error) {
      source.destroy();
      throw error;
    }
    arm();
    try {
      await pipeline(
        source,
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            arm();
            callback(null, chunk);
          },
        }),
        handle.createWriteStream(),
        { signal: idle.signal },
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(destination, { force: true });
      if (error instanceof CliError) throw error;
      if (idle.signal.aborted) throw vendorFileStalled(this.http.name);
      const code = causeCode(error);
      throw vendorUnavailable(this.http.name, `a file download stopped before it finished${code ? ` (${code})` : ""}`, 0);
    } finally {
      clearTimeout(timer);
    }
    return { bytes };
  }
}

class NetworkFailure extends Error {
  constructor(readonly code?: string) {
    super("network failure");
  }
}

/**
 * A whole offset-paged listing. A listing ends on an empty page, a short page, the
 * reported total, or a page that adds no ids not already seen. There is no cap on
 * the number of items.
 */
export async function offsetPages<T>(
  fetchPage: (start: number, length: number) => Promise<{ items: T[]; total?: number }>,
  options: { pageSize?: number; id?: (item: T) => string } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? 100;
  const id = options.id ?? ((item: T) => String((item as { id?: unknown } | undefined)?.id ?? JSON.stringify(item)));
  const seen = new Set<string>();
  const all: T[] = [];
  for (let start = 0; ;) {
    const page = await fetchPage(start, pageSize);
    let added = 0;
    for (const item of page.items) {
      const key = id(item);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(item);
      added += 1;
    }
    start += page.items.length;
    if (page.items.length === 0 || added === 0 || page.items.length < pageSize) return all;
    if (page.total !== undefined && start >= page.total) return all;
  }
}

/**
 * A whole GraphQL connection listing. `pick` reads the connection out of the
 * query's `data`; the query takes `$after` and reads `pageInfo`. It ends when no
 * page follows, or when the cursor does not move.
 */
export async function cursorPages<T>(
  client: VendorClient,
  query: string,
  pick: (data: never) => { items: T[]; hasNextPage: boolean; endCursor?: string | null },
  variables: Record<string, unknown> = {},
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const page = pick((await client.graphql(query, { ...variables, after })) as never);
    all.push(...page.items);
    if (!page.hasNextPage || !page.endCursor || seen.has(page.endCursor)) return all;
    seen.add(page.endCursor);
    after = page.endCursor;
  }
}
