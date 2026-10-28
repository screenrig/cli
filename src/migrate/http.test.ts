import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CliError } from "../problems.js";
import { testTemp } from "../test-temp.js";
import { createMemoryLogger } from "../log/logger.js";
import type { CliRuntime } from "../runtime.js";
import { vendorHttpFor } from "./cli.js";
import { backoffMs, createVendorHttp, cursorPages, offsetPages, retryAfterSeconds } from "./http.js";
import type { VendorAdapter, VendorClient, VendorClientOptions } from "./types.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  at: number;
  signal?: AbortSignal;
}

function fixture(handler: (call: Call, index: number) => Response | Promise<Response>, options: { random?: () => number; start?: number; requestTimeoutMs?: number; idleTimeoutMs?: number } = {}) {
  let now = options.start ?? 0;
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const logs: unknown[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      at: now,
      ...(init?.signal ? { signal: init.signal } : {}),
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  const http = createVendorHttp({
    vendor: "fixture",
    name: "Fixture CMS",
    credentialNames: ["FIXTURE_ID", "FIXTURE_SECRET"],
    fetch: fetchImpl,
    // Virtual time at a thousandth of real time: concurrent sleepers wake in deadline order, each at its own time.
    sleep: async (ms) => {
      sleeps.push(ms);
      const wake = now + ms;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(ms / 1000)));
      now = Math.max(now, wake);
    },
    now: () => now,
    random: options.random ?? (() => 1),
    log: (entry) => logs.push(entry),
    ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
  });
  return {
    calls,
    sleeps,
    logs,
    client: (clientOptions: Partial<VendorClientOptions> = {}): VendorClient => http.client({ base: "https://cms.example.com/api", auth: { Authorization: "Bearer fixture-token" }, ...clientOptions }),
  };
}

const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

async function failure(work: Promise<unknown>): Promise<CliError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  throw new Error("expected a failure");
}

test("retryAfterSeconds reads whole seconds and HTTP dates", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  assert.equal(retryAfterSeconds("3", now), 3);
  assert.equal(retryAfterSeconds("Wed, 28 Oct 2026 12:00:07 GMT", now), 7);
  assert.equal(retryAfterSeconds("Wed, 28 Oct 2026 11:00:00 GMT", now), 0);
  assert.equal(retryAfterSeconds("soon", now), undefined);
  assert.equal(retryAfterSeconds(null, now), undefined);
});

test("a 429 with Retry-After in seconds is waited for, then the request is sent again", async () => {
  const f = fixture((_call, index) => (index === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } }) : json({ ok: true })));
  assert.deepEqual(await f.client().json("/library"), { ok: true });
  assert.deepEqual(f.sleeps, [3000]);
  assert.equal(f.calls.length, 2);
});

test("Retry-After as an HTTP date is waited for", async () => {
  const start = Date.parse("2026-10-28T12:00:00Z");
  const f = fixture((_call, index) => (index === 0 ? new Response(null, { status: 503, headers: { "retry-after": "Wed, 28 Oct 2026 12:00:07 GMT" } }) : json([])), { start });
  await f.client().json("/library");
  assert.deepEqual(f.sleeps, [7000]);
});

test("a Retry-After over 120 seconds is not waited for: vendor_rate_limited, exit 7", async () => {
  const f = fixture(() => new Response("", { status: 429, headers: { "retry-after": "121" } }));
  const error = await failure(f.client().json("/library"));
  assert.equal(error.problem.code, "vendor_rate_limited");
  assert.equal(error.exitCode, 7);
  assert.deepEqual(f.sleeps, []);
  assert.equal(f.calls.length, 1);
  const edge = fixture((_call, index) => (index === 0 ? new Response("", { status: 429, headers: { "retry-after": "120" } }) : json([])));
  await edge.client().json("/library");
  assert.deepEqual(edge.sleeps, [120_000]);
});

test("429 without Retry-After backs off 1 s times 2 to the attempt with jitter, five times, then gives up", async () => {
  const f = fixture(() => new Response("", { status: 429 }), { random: () => 1 });
  const error = await failure(f.client().json("/library"));
  assert.equal(error.problem.code, "vendor_rate_limited");
  assert.equal(error.exitCode, 7);
  assert.deepEqual(f.sleeps, [1000, 2000, 4000, 8000, 16_000]);
  assert.equal(f.calls.length, 6);
  assert.equal(backoffMs(0, () => 0), 500);
  assert.equal(backoffMs(9, () => 1), 30_000);
});

test("503 and network errors are retried; what is left after the retries is vendor_unavailable", async () => {
  const flaky = fixture((_call, index) => (index < 2 ? new Response("", { status: 503 }) : json({ fine: 1 })));
  assert.deepEqual(await flaky.client().json("/x"), { fine: 1 });
  const down = fixture(() => new Response("", { status: 503 }));
  const stuck = await failure(down.client().json("/x"));
  assert.equal(stuck.problem.code, "vendor_unavailable");
  assert.equal(stuck.exitCode, 9);
  let attempts = 0;
  const offline = fixture(() => {
    attempts += 1;
    throw new TypeError("fetch failed: getaddrinfo ENOTFOUND cms.example.com?token=hidden");
  });
  const lost = await failure(offline.client().json("/x"));
  assert.equal(lost.problem.code, "vendor_unavailable");
  assert.equal(lost.exitCode, 10);
  assert.equal(attempts, 6);
  assert.ok(!JSON.stringify(lost.problem).includes("hidden"), "a network error's own text never reaches the problem");
  let calls = 0;
  const recovering = fixture(() => {
    calls += 1;
    if (calls < 3) throw new TypeError("reset");
    return json({ back: true });
  });
  assert.deepEqual(await recovering.client().json("/x"), { back: true });
});

test("other statuses are not retried and map to the vendor codes", async () => {
  const cases: Array<[number, string, number]> = [[401, "vendor_refused", 3], [403, "vendor_refused", 3], [404, "vendor_not_found", 4], [500, "vendor_unavailable", 9], [502, "vendor_unavailable", 9], [422, "vendor_bad_response", 9]];
  for (const [status, code, exit] of cases) {
    const f = fixture(() => new Response("body", { status }));
    const error = await failure(f.client().json("/x"));
    assert.equal(error.problem.code, code, String(status));
    assert.equal(error.exitCode, exit, String(status));
    assert.equal(f.calls.length, 1, String(status));
  }
  const refused = await failure(fixture(() => new Response("", { status: 401 })).client().json("/x"));
  assert.match(refused.problem.detail, /Check FIXTURE_ID and FIXTURE_SECRET/);
});

test("a sliding window shared by concurrent requests never exceeds the rate", async () => {
  const f = fixture(() => json({}));
  const client = f.client({ rate: { requests: 2, perMs: 1000 } });
  await Promise.all([1, 2, 3, 4, 5].map((n) => client.json(`/n/${n}`)));
  const starts = f.calls.map((call) => call.at).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 0, 1000, 1000, 2000]);
  for (const [index, start] of starts.entries()) {
    assert.ok(starts.filter((other, position) => position <= index && other > start - 1000).length <= 2);
  }
});

test("the credential goes to the base origin only", async () => {
  const f = fixture((call) => {
    if (call.url.endsWith("/hop")) return new Response(null, { status: 302, headers: { location: "https://files.example.net/blob?sig=abc" } });
    if (call.url.endsWith("/same")) return new Response(null, { status: 307, headers: { location: "/api/final" } });
    return json({ url: call.url });
  });
  const client = f.client();
  await client.json("/plain");
  assert.equal(f.calls[0]!.headers.authorization, "Bearer fixture-token");
  await client.json("/hop");
  const crossed = f.calls.at(-1)!;
  assert.equal(crossed.url, "https://files.example.net/blob?sig=abc");
  assert.equal(crossed.headers.authorization, undefined, "dropped when the origin changes");
  await client.json("/same");
  assert.equal(f.calls.at(-1)!.url, "https://cms.example.com/api/final");
  assert.equal(f.calls.at(-1)!.headers.authorization, "Bearer fixture-token", "kept on the same origin");
});

test("a path that resolves to another origin is refused before any request", async () => {
  const f = fixture(() => json({}));
  for (const path of ["https://evil.example.net/x", "//evil.example.net/x", "http://cms.example.com/api"]) {
    const error = await failure(f.client().json(path));
    assert.equal(error.problem.code, "vendor_bad_response", path);
  }
  assert.equal(f.calls.length, 0);
  // A path that merely looks odd stays under the base.
  await f.client().json("/..%2F@evil.example.net");
  assert.ok(f.calls[0]!.url.startsWith("https://cms.example.com/api/"));
});

test("redirects are followed by hand, at most five", async () => {
  let hops = 0;
  const f = fixture(() => {
    hops += 1;
    return new Response(null, { status: 302, headers: { location: `/api/hop${hops}` } });
  });
  const error = await failure(f.client().json("/start"));
  assert.equal(error.problem.code, "vendor_bad_response");
  assert.equal(f.calls.length, 6);
});

test("error details never carry a URL query, a header or a body", async () => {
  const body = "vendor-says: Bearer fixture-token in the body";
  for (const status of [401, 404, 422, 500]) {
    const f = fixture(() => new Response(body, { status, headers: { "set-cookie": "session=hidden-cookie", "x-trace": "hidden-trace" } }));
    const error = await failure(f.client().json("/library?token=hidden-query", { query: { search: "hidden-search" } }));
    const text = JSON.stringify(error.problem);
    for (const secret of ["hidden-query", "hidden-search", "hidden-cookie", "hidden-trace", "fixture-token", "vendor-says"]) {
      assert.ok(!text.includes(secret), `${status}: ${secret}`);
    }
  }
  const notJson = fixture(() => new Response("<html>token=hidden-html</html>", { status: 200 }));
  const error = await failure(notJson.client().json("/x"));
  assert.equal(error.problem.code, "vendor_bad_response");
  assert.ok(!JSON.stringify(error.problem).includes("hidden-html"));
});

test("only the vendor, method, status and time are logged", async () => {
  const f = fixture(() => json({}));
  await f.client().json("/library?token=hidden", { method: "POST", body: { secret: "hidden" } });
  assert.deepEqual(f.logs, [{ vendor: "fixture", method: "POST", status: 200, ms: 0 }]);
});

test("json sends queries, JSON and form bodies, and returns lower-cased headers", async () => {
  const f = fixture(() => json({ rows: [] }, { headers: { "content-type": "application/json", "X-Total-Count": "42" } }));
  const client = f.client();
  const answer = await client.response("/library", { query: { start: 0, length: 100, skip: undefined, flag: true } });
  assert.equal(f.calls[0]!.url, "https://cms.example.com/api/library?start=0&length=100&flag=true");
  assert.equal(answer.headers["x-total-count"], "42");
  await client.json("/playlist", { method: "POST", body: { name: "x" } });
  assert.equal(f.calls[1]!.headers["content-type"], "application/json");
  assert.equal(f.calls[1]!.body, '{"name":"x"}');
  await client.json("/authorize/access_token", { method: "POST", form: { grant_type: "client_credentials", client_id: "fixture-id" } });
  assert.equal(f.calls[2]!.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(f.calls[2]!.body, "grant_type=client_credentials&client_id=fixture-id");
  client.setAuth({ Authorization: "Bearer renewed" });
  await client.json("/library");
  assert.equal(f.calls[3]!.headers.authorization, "Bearer renewed");
  client.setAuth(undefined);
  await client.json("/library");
  assert.equal(f.calls[4]!.headers.authorization, undefined);
});

test("graphql returns data; errors are a refusal or a bad response and never quote the vendor", async () => {
  const ok = fixture(() => json({ data: { allFiles: { nodes: [] } } }));
  assert.deepEqual(await ok.client({ base: "https://graphql.us.example.com/graphql" }).graphql("query { allFiles { nodes { id } } }", { first: 10 }), { allFiles: { nodes: [] } });
  assert.equal(ok.calls[0]!.url, "https://graphql.us.example.com/graphql");
  assert.equal(ok.calls[0]!.method, "POST");
  assert.deepEqual(JSON.parse(ok.calls[0]!.body!), { query: "query { allFiles { nodes { id } } }", variables: { first: 10 } });
  const refused = fixture(() => json({ errors: [{ message: "bad token fixture-token", extensions: { code: "UNAUTHENTICATED" } }] }));
  assert.equal((await failure(refused.client().graphql("query { x }"))).problem.code, "vendor_refused");
  const broken = fixture(() => json({ errors: [{ message: "Cannot query field fixture-token", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }));
  const error = await failure(broken.client().graphql("query { x }"));
  assert.equal(error.problem.code, "vendor_bad_response");
  assert.match(error.problem.detail, /GRAPHQL_VALIDATION_FAILED/);
  assert.ok(!JSON.stringify(error.problem).includes("fixture-token"));
  const empty = fixture(() => json({}));
  assert.equal((await failure(empty.client().graphql("query { x }"))).problem.code, "vendor_bad_response");
});

test("download streams to a new 0600 file, sends the credential only to the base origin and never overwrites", async () => {
  const dir = await testTemp("vendor-download-");
  try {
    const f = fixture(() => new Response(Buffer.from("file bytes"), { status: 200 }));
    const client = f.client();
    const same = path.join(dir, "same.bin");
    assert.deepEqual(await client.download("/library/download/7", same), { bytes: 10 });
    assert.equal((await readFile(same)).toString(), "file bytes");
    assert.equal((await stat(same)).mode & 0o777, 0o600);
    assert.equal(f.calls[0]!.headers.authorization, "Bearer fixture-token");
    await client.download("https://cdn.example.net/blob?sig=1", path.join(dir, "other.bin"));
    assert.equal(f.calls[1]!.headers.authorization, undefined);
    await writeFile(path.join(dir, "taken"), "old");
    await assert.rejects(client.download("/x", path.join(dir, "taken")), { code: "EEXIST" });
    assert.equal((await readFile(path.join(dir, "taken"))).toString(), "old");
    const missing = fixture(() => new Response("nope", { status: 404 }));
    const error = await failure(missing.client().download("/x", path.join(dir, "gone.bin")));
    assert.equal(error.problem.code, "vendor_not_found");
    await assert.rejects(stat(path.join(dir, "gone.bin")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- time limits: the request limit ends with the headers, the idle limit guards the body ----------------------------------

/** A body that sends `chunks` pieces of ten bytes, `gapMs` apart, and dies with the request's signal if that aborts. */
function trickle(chunks: number, gapMs: number, signal?: AbortSignal): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
    async pull(controller) {
      if (sent >= chunks) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      sent += 1;
      controller.enqueue(new TextEncoder().encode("0123456789"));
    },
  });
  return new Response(body, { status: 200 });
}

test("a download that flows for longer than the request limit completes: the limit ends when the headers arrive", async () => {
  const dir = await testTemp("vendor-slow-");
  try {
    // Eight chunks 25 ms apart take about 200 ms, five times the 40 ms request limit.
    const f = fixture((call) => trickle(8, 25, call.signal), { requestTimeoutMs: 40 });
    const target = path.join(dir, "big.bin");
    assert.deepEqual(await f.client().download("/library/download/1", target), { bytes: 80 });
    assert.equal((await readFile(target)).length, 80);
    assert.deepEqual(f.logs, [{ vendor: "fixture", method: "GET", status: 200, ms: 0 }], "one request, answered");
    // A small JSON answer that flows for as long is read whole too.
    const answer = fixture((call) => trickle(4, 25, call.signal), { requestTimeoutMs: 40 });
    const unreadable = await failure(answer.client().json("/x"));
    assert.equal(unreadable.problem.code, "vendor_bad_response", "read to its end (ten digits are not JSON), not cut off by the request limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a request whose headers never arrive is dropped at the request limit, retried, and then vendor_unavailable with the reason", async () => {
  const f = fixture((call) => new Promise<Response>((_resolve, reject) => {
    call.signal!.addEventListener("abort", () => reject(call.signal!.reason), { once: true });
  }), { requestTimeoutMs: 20 });
  const error = await failure(f.client().json("/x"));
  assert.equal(error.problem.code, "vendor_unavailable");
  assert.equal(error.exitCode, 10);
  assert.match(error.problem.detail, /\(REQUEST_TIMEOUT\)/);
  assert.equal(f.calls.length, 6);
});

test("a download that goes silent for the idle limit is vendor_file_stalled, and its file is removed; a silent JSON answer is vendor_unavailable", async () => {
  const dir = await testTemp("vendor-stall-");
  try {
    const silent = (): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("0123456789"));
      },
      pull: () => new Promise<void>(() => undefined),
    }), { status: 200 });
    const f = fixture(silent, { idleTimeoutMs: 30 });
    const error = await failure(f.client().download("/library/download/1", path.join(dir, "gone.bin")));
    assert.equal(error.problem.code, "vendor_file_stalled");
    await assert.rejects(stat(path.join(dir, "gone.bin")), { code: "ENOENT" });
    const answer = fixture(() => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), { status: 200 }), { idleTimeoutMs: 30 });
    const stalled = await failure(answer.client().json("/x"));
    assert.equal(stalled.problem.code, "vendor_unavailable");
    assert.match(stalled.problem.detail, /stopped arriving \(IDLE_TIMEOUT\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- a failed request says why, at the level of a failure ------------------------------------------------------------

test("a request with no answer names the system error in its detail and its log, never a URL", async () => {
  const f = fixture(() => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND cms.example.com"), { code: "ENOTFOUND" }) });
  });
  const error = await failure(f.client().json("/x?token=hidden"));
  assert.equal(error.problem.code, "vendor_unavailable");
  assert.match(error.problem.detail, /the connection failed or timed out \(ENOTFOUND\)/);
  assert.equal(f.logs.length, 6);
  assert.ok(f.logs.every((entry) => JSON.stringify(entry) === JSON.stringify({ vendor: "fixture", method: "GET", status: 0, ms: 0, cause: "ENOTFOUND" })));
  assert.ok(!JSON.stringify([error.problem, f.logs]).match(/example\.com|hidden/), "no address or query in either");
  const tls = fixture(() => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
  });
  assert.match((await failure(tls.client().json("/x"))).problem.detail, /\(DEPTH_ZERO_SELF_SIGNED_CERT\)/);
});

test("the operation log records a request that got no answer or was refused as an error, and an answered one quietly", async () => {
  const { logger, events } = createMemoryLogger();
  let answer: () => Response = () => new Response("{}", { status: 200 });
  const runtime = {
    logger, sleep: async () => undefined, now: () => new Date(0),
    vendorFetch: (async () => {
      const response = answer();
      return response;
    }) as typeof fetch,
  } as unknown as CliRuntime;
  const adapter = { id: "fixture", name: "Fixture CMS", credentials: [] } as unknown as VendorAdapter;
  const client = vendorHttpFor(runtime, adapter).client({ base: "https://cms.example.com/api" });
  await client.json("/ok");
  answer = () => new Response("no", { status: 404 });
  await failure(client.json("/missing"));
  answer = () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }) });
  };
  await failure(client.json("/down"));
  const phases = events.filter((event) => event.op === "migrate.vendor.request" && event.phase !== "start").map((event) => [event.phase, event.params?.status, event.params?.cause]);
  assert.deepEqual(phases.slice(0, 2), [["finish", 200, undefined], ["error", 404, undefined]]);
  assert.ok(phases.slice(2).length === 6 && phases.slice(2).every((row) => row[0] === "error" && row[1] === 0 && row[2] === "ECONNREFUSED"), JSON.stringify(phases));
  assert.ok(!JSON.stringify(events).includes("127.0.0.1"), "no address");
});

// ---- redirects and downloads ----------------------------------------------------------------------------------------

test("a 307 or 308 that would repeat a body at another origin is refused; the same origin repeats it, and a 302 becomes a GET", async () => {
  const cross = fixture((call) => (call.url.endsWith("/authorize") ? new Response(null, { status: 307, headers: { location: "https://other.example.net/token" } }) : json({})));
  const refused = await failure(cross.client().json("/authorize", { method: "POST", form: { grant_type: "client_credentials", client_secret: "fixture-secret" } }));
  assert.equal(refused.problem.code, "vendor_bad_response");
  assert.match(refused.problem.detail, /redirected a request with a body to another address/);
  assert.equal(cross.calls.length, 1, "the secret went nowhere else");
  assert.ok(!JSON.stringify(refused.problem).includes("fixture-secret"));
  const permanent = fixture(() => new Response(null, { status: 308, headers: { location: "http://cms.example.com/api/authorize" } }));
  assert.equal((await failure(permanent.client().json("/authorize", { method: "POST", body: { a: 1 } }))).problem.code, "vendor_bad_response", "http to https is another origin too");
  assert.equal(permanent.calls.length, 1);

  const same = fixture((call, index) => (index === 0 ? new Response(null, { status: 307, headers: { location: "/api/token" } }) : json({ url: call.url })));
  await same.client().json("/authorize", { method: "POST", form: { grant_type: "client_credentials" } });
  assert.equal(same.calls[1]!.method, "POST");
  assert.equal(same.calls[1]!.body, "grant_type=client_credentials");
  const found = fixture((call, index) => (index === 0 ? new Response(null, { status: 302, headers: { location: "https://other.example.net/after" } }) : json({ url: call.url })));
  await found.client().json("/authorize", { method: "POST", form: { client_secret: "fixture-secret" } });
  assert.equal(found.calls[1]!.method, "GET");
  assert.equal(found.calls[1]!.body, undefined, "a 302 drops the body");
});

test("a refusal from a host that was sent no credential is vendor_file_gone; the base origin's refusal is still vendor_refused", async () => {
  const dir = await testTemp("vendor-gone-");
  try {
    for (const status of [401, 403, 410]) {
      const direct = fixture(() => new Response("vendor-body-text", { status }));
      const gone = await failure(direct.client().download("https://cdn.example.net/blob?sig=old", path.join(dir, `a${status}`)));
      assert.equal(gone.problem.code, "vendor_file_gone", String(status));
      assert.equal(gone.problem.status, 410);
      assert.match(gone.problem.detail, /migrate scan again to refresh the file addresses/);
      assert.deepEqual(gone.problem.next?.command, "screenrig migrate scan --from fixture");
      assert.ok(!JSON.stringify(gone.problem).match(/cdn\.example\.net|sig=old|vendor-body-text/), "no address, query or body");
      assert.equal(direct.calls[0]!.headers.authorization, undefined);
      // A listed path that the base redirects to a CDN: the CDN was sent no credential either.
      const viaBase = fixture((call) => (call.url.startsWith("https://cms.example.com/") ? new Response(null, { status: 302, headers: { location: "https://cdn.example.net/blob" } }) : new Response("no", { status })));
      assert.equal((await failure(viaBase.client().download("/library/download/1", path.join(dir, `b${status}`)))).problem.code, "vendor_file_gone", `redirected ${status}`);
    }
    const own = fixture(() => new Response("no", { status: 403 }));
    assert.equal((await failure(own.client().download("/library/download/1", path.join(dir, "own")))).problem.code, "vendor_refused");
    const other = fixture(() => new Response("no", { status: 404 }));
    assert.equal((await failure(other.client().download("https://cdn.example.net/blob", path.join(dir, "nf")))).problem.code, "vendor_not_found");
    await assert.rejects(stat(path.join(dir, "a403")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("offsetPages lists everything: no item cap, and a page of nothing new ends it", async () => {
  const all = Array.from({ length: 1234 }, (_, index) => ({ id: `item-${index}` }));
  const seen: Array<[number, number]> = [];
  const listed = await offsetPages(async (start, length) => {
    seen.push([start, length]);
    return { items: all.slice(start, start + length), total: all.length };
  }, { pageSize: 100 });
  assert.equal(listed.length, 1234);
  assert.equal(seen.length, 13);
  const total = await offsetPages(async (start, length) => ({ items: all.slice(start, start + length), total: 200 }), { pageSize: 100 });
  assert.equal(total.length, 200, "the reported total ends the listing");
  let calls = 0;
  const looping = await offsetPages(async () => {
    calls += 1;
    return { items: all.slice(0, 100) };
  }, { pageSize: 100 });
  assert.equal(looping.length, 100);
  assert.equal(calls, 2, "a repeated page adds no ids and ends it");
  assert.deepEqual(await offsetPages(async () => ({ items: [] })), []);
});

test("cursorPages follows endCursor until no page follows", async () => {
  const pages = [
    { allFiles: { nodes: [{ id: "a" }, { id: "b" }], pageInfo: { hasNextPage: true, endCursor: "c1" } } },
    { allFiles: { nodes: [{ id: "c" }], pageInfo: { hasNextPage: true, endCursor: "c2" } } },
    { allFiles: { nodes: [{ id: "d" }], pageInfo: { hasNextPage: false, endCursor: "c3" } } },
  ];
  const f = fixture((call) => {
    const { variables } = JSON.parse(call.body!) as { variables: { after: string | null } };
    return json({ data: pages[variables.after === null ? 0 : variables.after === "c1" ? 1 : 2] });
  });
  const items = await cursorPages(f.client(), "query($after: String) { allFiles(first: 2, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }", (data: { allFiles: { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string } } }) => ({
    items: data.allFiles.nodes, hasNextPage: data.allFiles.pageInfo.hasNextPage, endCursor: data.allFiles.pageInfo.endCursor,
  }));
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c", "d"]);
  const stuck = fixture(() => json({ data: pages[0] }));
  const same = await cursorPages(stuck.client(), "query($after: String) { x }", (data: typeof pages[0]) => ({ items: data.allFiles.nodes, hasNextPage: true, endCursor: "same" }));
  assert.equal(same.length, 4, "a cursor that does not move ends the listing after the repeat");
});
