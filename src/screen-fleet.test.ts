import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { formatEventLine } from "./commands.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";
import { networkError } from "./problems.js";

const A = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "scr_BBBBBBBBBBBBBBBBBBBBBBBB";
const C = "scr_CCCCCCCCCCCCCCCCCCCCCCCC";
const MISSING = "scr_MISSINGAAAAAAAAAAAAAAAAA";
const IMAGE = Uint8Array.from(Buffer.from("PIXELS_MUST_NOT_PRINT", "utf8"));
const IMAGE_SHA256 = createHash("sha256").update(IMAGE).digest("hex");

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number };
  warnings?: Array<{ code: string; message: string }>;
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<{ fs: ConfigFs; cwd: string }> {
  const configDir = await testTemp("fleet-cfg-");
  const cwd = await testTemp("fleet-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" },
    fs,
  );
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: { fs: ConfigFs; cwd: string }): Promise<{ code: number; stdout: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv,
    env: env.fs.env,
    stdout,
    stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir,
    cwd: () => env.cwd,
    fs: env.fs,
    transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, envelope };
}

function problem(status: number, code: string, detail: string): Record<string, unknown> {
  return { type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, status, code, detail };
}

function screen(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, label: id.slice(4, 8), state: "active", revision: 3, public_id: "pub", manifest_revision: 1,
    content_access_generation: 1, online: true, created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z",
    ...extra,
  };
}

/** A small stateful backend: screens, tag filter, PATCH with If-Match, and the fleet actions route. */
function fleetBackend(): { transport: FakeTransport; screens: Map<string, Record<string, any>> } {
  const transport = new FakeTransport();
  const screens = new Map<string, Record<string, any>>([
    [A, screen(A, { tags: ["Lobby"] })],
    [B, screen(B, { tags: ["Lobby", "Floor2"] })],
    [C, screen(C, { tags: ["Lobby"], state: "pairing_pending" })],
  ]);
  transport.on("POST", "/api/v1/screens/actions", (req): TransportResponse => {
    const body = req.body as { selector: any; action: any };
    const ids: string[] = body.selector.by === "ids" ? body.selector.screen_ids
      : [...screens.values()].filter((item) => item.state === "active" && item.tags?.includes(body.selector.tag)).map((item) => item.id);
    const results = ids.map((id) => {
      const current = screens.get(id);
      if (!current) return { screen_id: id, status: "failed", problem: problem(404, "not_found", "Screen not found.") };
      if (body.action.type === "reload") return { screen_id: id, status: "ok", reload: { reload_id: "rld_FLEET0001", expires_at: "2026-08-14T17:10:00.000Z" } };
      if (body.action.type === "toast") return { screen_id: id, status: "ok", toast: { expires_at: "2026-08-14T17:00:10.000Z" } };
      if (body.action.type === "assign") {
        current.playlist_id = body.action.playlist_id;
        current.revision += 1;
        return { screen_id: id, status: "ok", revision: current.revision };
      }
      const stored: string[] = current.tags ?? [];
      current.tags = body.action.type === "set_tags" ? body.action.tags
        : body.action.type === "add_tags" ? [...stored, ...body.action.tags.filter((tag: string) => !stored.includes(tag))]
        : stored.filter((tag) => !body.action.tags.includes(tag));
      current.revision += 1;
      return { screen_id: id, status: "ok", revision: current.revision, tags: current.tags };
    });
    const failed = results.filter((item) => item.status === "failed").length;
    return { status: 200, headers: { "x-request-id": "req_fleetAAAAAAAAAAAAAAAA" }, body: { action: body.action.type, matched: results.length, succeeded: results.length - failed, failed, results } };
  });
  transport.on("GET", "/api/v1/screens", (req) => {
    const tag = req.query?.tag;
    const items = [...screens.values()].filter((item) => tag === undefined || item.tags?.includes(tag));
    return { status: 200, headers: {}, body: { items } };
  });
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+$/, (req): TransportResponse => {
    const current = screens.get(decodeURIComponent(req.path.split("/").pop()!));
    return current ? { status: 200, headers: {}, body: current } : { status: 404, headers: { "content-type": "application/problem+json" }, body: problem(404, "not_found", "Screen not found.") };
  });
  transport.on("PATCH", /^\/api\/v1\/screens\/[^/]+$/, (req): TransportResponse => {
    const current = screens.get(decodeURIComponent(req.path.split("/").pop()!));
    if (!current) return { status: 404, headers: { "content-type": "application/problem+json" }, body: problem(404, "not_found", "Screen not found.") };
    const ifMatch = req.headers?.["if-match"];
    if (ifMatch && ifMatch !== `"${current.revision}"`) {
      return { status: 412, headers: { "content-type": "application/problem+json" }, body: { ...problem(412, "revision_conflict", "The screen revision changed."), current_revision: current.revision } };
    }
    Object.assign(current, req.body as object, { revision: current.revision + 1 });
    return { status: 200, headers: {}, body: current };
  });
  return { transport, screens };
}

const actionCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path === "/api/v1/screens/actions");

test("screen list --tag filters by exact tag and adds a TAGS column", async () => {
  const env = await enrolled();
  const { transport } = fleetBackend();
  const listed = await cli(["--json", "screen", "list", "--tag", "Floor2"], transport, env);
  assert.equal(listed.code, 0, listed.stdout);
  assert.deepEqual(transport.calls.at(-1)?.query, { tag: "Floor2" });
  assert.deepEqual(listed.envelope.data.items.map((item: any) => item.id), [B]);
  assert.deepEqual(listed.envelope.data.items[0].tags, ["Lobby", "Floor2"]);

  const untagged = await cli(["--json", "screen", "list"], transport, env);
  assert.equal(untagged.code, 0);
  assert.deepEqual(transport.calls.at(-1)?.query, {}, "no filter sends no tag parameter");

  const human = await cli(["--human", "screen", "list"], transport, env);
  assert.match(human.stdout, /ID\s+LABEL\s+STATE\s+TAGS/);
  assert.match(human.stdout, new RegExp(`${B}\\s+\\S+\\s+active\\s+Lobby,Floor2`));

  const before = transport.calls.length;
  for (const bad of ["Lobby-1", "x".repeat(33)]) {
    const refused = await cli(["--json", "screen", "list", "--tag", bad], transport, env);
    assert.equal(refused.code, ExitCode.Usage);
    assert.match(refused.envelope.error!.detail, /1 to 32 letters or digits/);
  }
  assert.equal(transport.calls.length, before, "invalid tags never reach the server");
});

test("screen show prints the tag set in human mode and passes tags through in JSON", async () => {
  const env = await enrolled();
  const { transport } = fleetBackend();
  const human = await cli(["--human", "screen", "show", B], transport, env);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^Tags: Lobby, Floor2$/m);
  const json = await cli(["--json", "screen", "show", B], transport, env);
  assert.deepEqual(json.envelope.data.tags, ["Lobby", "Floor2"]);
});

test("screen tag on one screen PATCHes the whole set with the screen's revision semantics", async () => {
  const env = await enrolled();
  const { transport, screens } = fleetBackend();

  const set = await cli(["--json", "screen", "tag", A, "--set", "Lobby,Spring"], transport, env);
  assert.equal(set.code, 0, set.stdout);
  let patch = transport.calls.at(-1)!;
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, `/api/v1/screens/${A}`);
  assert.deepEqual(patch.body, { tags: ["Lobby", "Spring"] });
  assert.equal(patch.headers?.["if-match"], undefined, "--set without --expect-rev is unguarded");
  assert.ok(patch.headers?.["idempotency-key"]);
  assert.equal(set.envelope.data.id, A, "single-screen envelope is the updated screen");
  assert.deepEqual(set.envelope.data.tags, ["Lobby", "Spring"]);

  const guarded = await cli(["--json", "screen", "tag", A, "--set", "Lobby", "--expect-rev", "4"], transport, env);
  assert.equal(guarded.code, 0, guarded.stdout);
  assert.equal(transport.calls.at(-1)!.headers?.["if-match"], '"4"');

  const stale = await cli(["--json", "screen", "tag", A, "--set", "Lobby", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition);
  assert.equal(stale.envelope.error!.code, "revision_conflict");

  const calls = transport.calls.length;
  const added = await cli(["--json", "screen", "tag", A, "--add", "Spring,Lobby"], transport, env);
  assert.equal(added.code, 0, added.stdout);
  const [read, write] = transport.calls.slice(calls);
  assert.equal(read!.method, "GET");
  assert.equal(write!.method, "PATCH");
  assert.deepEqual(write!.body, { tags: ["Lobby", "Spring"] }, "add keeps stored order and skips tags already present");
  assert.equal(write!.headers?.["if-match"], '"5"', "add/remove guard with the revision just read");

  const removed = await cli(["--json", "screen", "tag", A, "--remove", "Lobby"], transport, env);
  assert.equal(removed.code, 0);
  assert.deepEqual(transport.calls.at(-1)!.body, { tags: ["Spring"] });

  const cleared = await cli(["--human", "screen", "tag", A, "--clear"], transport, env);
  assert.equal(cleared.code, 0);
  assert.deepEqual(transport.calls.at(-1)!.body, { tags: [] });
  assert.match(cleared.stdout, /Tagged screen .*\ntags: \(none\)\nrevision: 8/);
  assert.deepEqual(screens.get(A)!.tags, []);
  assert.equal(actionCalls(transport).length, 0, "one screen id never uses the fleet route");
});

test("screen tag --add surfaces a concurrent change as revision_conflict instead of overwriting it", async () => {
  const env = await enrolled();
  const { transport, screens } = fleetBackend();
  // Another writer bumps the revision between this command's read and write.
  const original = transport.calls.length;
  transport.on("GET", `/api/v1/screens/${A}`, () => ({ status: 200, headers: {}, body: { ...screens.get(A)!, revision: 2 } }));
  const routes = (transport as unknown as { routes: Array<{ method: string; path: unknown }> }).routes;
  routes.unshift(routes.pop()!);
  const result = await cli(["--json", "screen", "tag", A, "--add", "Spring"], transport, env);
  assert.equal(result.code, ExitCode.Precondition, result.stdout);
  assert.equal(result.envelope.error!.code, "revision_conflict");
  assert.equal(transport.calls.slice(original).at(-1)!.headers?.["if-match"], '"2"');
  assert.deepEqual(screens.get(A)!.tags, ["Lobby"], "the stored set is unchanged");

  const tooMany = fleetBackend();
  tooMany.screens.get(A)!.tags = Array.from({ length: 16 }, (_, index) => `T${index}`);
  const full = await cli(["--json", "screen", "tag", A, "--add", "Extra"], tooMany.transport, env);
  assert.equal(full.code, ExitCode.Usage);
  assert.match(full.envelope.error!.detail, /at most 16/);
  assert.equal(tooMany.transport.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("screen tag validates modes, tags, and targets before any request", async () => {
  const env = await enrolled();
  const { transport } = fleetBackend();
  const cases: Array<[string[], RegExp]> = [
    [["screen", "tag", A], /exactly one of --set or --add or --remove or --clear/],
    [["screen", "tag", A, "--set", "A", "--add", "B"], /exactly one of/],
    [["screen", "tag", A, "--add", "A", "--clear"], /exactly one of/],
    [["screen", "tag", A, "--set", "Lobby,Lobby"], /more than once/],
    [["screen", "tag", A, "--set", "Lob by"], /comma-separated tags of 1 to 32/],
    [["screen", "tag", A, "--add", "a,,b"], /comma-separated tags/],
    [["screen", "tag", A, "--set", Array.from({ length: 17 }, (_, index) => `T${index}`).join(",")], /at most 16/],
    [["screen", "tag", "--add", "Spring"], /requires <id> or --tag TAG/],
    [["screen", "tag", A, "--tag", "Lobby", "--add", "Spring"], /screen ids or --tag TAG, not both/],
    [["screen", "tag", "--tag", "Lobby", "--add", "Spring", "--expect-rev", "3"], /does not take --expect-rev/],
    [["screen", "tag", A, B, "--clear", "--expect-rev", "3"], /does not take --expect-rev/],
    [["screen", "tag", A, A, "--clear"], /more than once/],
    [["screen", "tag", "--tag", "Lob-by", "--clear"], /--tag must be 1 to 32/],
  ];
  for (const [argv, detail] of cases) {
    const result = await cli(["--json", ...argv], transport, env);
    assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.envelope.error!.code, "usage_error");
    assert.match(result.envelope.error!.detail, detail, argv.join(" "));
  }
  assert.equal(transport.calls.length, 0, "invalid tag commands never reach the server");
});

test("fleet tag edits use one actions request and return per-screen results", async () => {
  const env = await enrolled();
  const { transport, screens } = fleetBackend();
  const result = await cli(["--json", "screen", "tag", "--tag", "Lobby", "--add", "Spring", "--idempotency-key", "idem_fleetAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(result.code, 0, result.stdout);
  const [call] = actionCalls(transport);
  assert.deepEqual(call!.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "add_tags", tags: ["Spring"] } });
  assert.equal(call!.headers?.["idempotency-key"], "idem_fleetAAAAAAAAAAAAAAAA");
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.data.action, "add_tags");
  assert.equal(result.envelope.data.matched, 2, "the tag selector covers active screens only");
  assert.equal(result.envelope.data.succeeded, 2);
  assert.equal(result.envelope.data.failed, 0);
  assert.deepEqual(result.envelope.data.results.map((item: any) => [item.screen_id, item.status]), [[A, "ok"], [B, "ok"]]);
  assert.deepEqual(result.envelope.warnings, []);
  assert.deepEqual(screens.get(B)!.tags, ["Lobby", "Floor2", "Spring"]);
  assert.deepEqual(screens.get(C)!.tags, ["Lobby"], "pairing_pending screens are not selected by tag");

  await cli(["--json", "screen", "tag", A, B, "--remove", "Lobby"], transport, env);
  assert.deepEqual(actionCalls(transport).at(-1)!.body, { selector: { by: "ids", screen_ids: [A, B] }, action: { type: "remove_tags", tags: ["Lobby"] } });
  await cli(["--json", "screen", "tag", A, B, "--set", "Lobby"], transport, env);
  assert.deepEqual((actionCalls(transport).at(-1)!.body as any).action, { type: "set_tags", tags: ["Lobby"] });
  const cleared = await cli(["--human", "screen", "tag", "--tag", "Lobby", "--clear"], transport, env);
  assert.deepEqual((actionCalls(transport).at(-1)!.body as any).action, { type: "set_tags", tags: [] });
  assert.match(cleared.stdout, /^Fleet tag: matched 2, succeeded 2, failed 0$/m);
  assert.match(cleared.stdout, new RegExp(`^${A}  ok  tags \\(none\\)$`, "m"));
});

test("fleet reload partial failure keeps ok true, lists every screen, and exits with the first failure's code", async () => {
  const env = await enrolled();
  const { transport } = fleetBackend();
  const result = await cli(["--json", "screen", "reload", A, MISSING, B], transport, env);
  assert.equal(result.code, ExitCode.NotFound, result.stdout);
  assert.equal(result.envelope.ok, true, "partial success is not a transport error");
  assert.deepEqual(actionCalls(transport)[0]!.body, { selector: { by: "ids", screen_ids: [A, MISSING, B] }, action: { type: "reload" } });
  assert.equal(result.envelope.data.matched, 3);
  assert.equal(result.envelope.data.succeeded, 2);
  assert.equal(result.envelope.data.failed, 1);
  assert.deepEqual(result.envelope.data.results.map((item: any) => item.status), ["ok", "failed", "ok"]);
  assert.equal(result.envelope.data.results[1].problem.code, "not_found");
  assert.equal(result.envelope.data.results[0].reload.reload_id, "rld_FLEET0001");
  assert.deepEqual(result.envelope.warnings!.map((warning) => warning.code), ["fleet_partial_failure"]);
  assert.match(result.envelope.warnings![0]!.message, /1 of 3 screens failed; 2 succeeded/);

  const human = await cli(["--human", "screen", "reload", A, MISSING], transport, env);
  assert.equal(human.code, ExitCode.NotFound);
  assert.match(human.stdout, /^Fleet reload: matched 2, succeeded 1, failed 1$/m);
  assert.match(human.stdout, new RegExp(`^${MISSING}  failed  not_found/404$`, "m"));
  assert.match(human.stdout, /^warning: 1 of 2 screens failed/m);

  const single = await cli(["--json", "screen", "reload", MISSING], transport, env);
  assert.equal(actionCalls(transport).length, 2, "one screen id keeps the single-screen reload route");
  assert.equal(transport.calls.at(-1)!.path, `/api/v1/screens/${MISSING}/reload`);
  assert.equal(single.envelope.ok, false);
});

test("fleet assign and toast send one typed action; toast text rules still apply first", async () => {
  const env = await enrolled();
  const { transport, screens } = fleetBackend();
  const assigned = await cli(["--json", "screen", "assign", "--tag", "Lobby", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(assigned.code, 0, assigned.stdout);
  assert.deepEqual(actionCalls(transport)[0]!.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "assign", playlist_id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA" } });
  assert.equal(assigned.envelope.data.action, "assign");
  assert.equal(screens.get(A)!.playlist_id, "pl_AAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(transport.calls.filter((call) => call.path.startsWith("/api/v1/playlists")).length, 0, "fleet assign leaves the timezone rule to each screen on the server");

  const toast = await cli(["--json", "screen", "toast", A, B, "--text", "Closing soon", "--level", "alert", "--duration-ms", "5000"], transport, env);
  assert.equal(toast.code, 0, toast.stdout);
  assert.deepEqual(actionCalls(transport)[1]!.body, { selector: { by: "ids", screen_ids: [A, B] }, action: { type: "toast", level: "alert", text: "Closing soon", duration_ms: 5000 } });
  assert.equal(toast.envelope.data.results[0].toast.expires_at, "2026-08-14T17:00:10.000Z");

  const before = transport.calls.length;
  for (const [argv, detail] of [
    [["screen", "toast", "--tag", "Lobby", "--text", "x".repeat(121)], /1 to 120 characters/],
    [["screen", "toast", "--text", "Hello"], /requires <id> or --tag TAG/],
    [["screen", "toast"], /requires <id> or --tag TAG, and --text/],
    [["screen", "assign", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA"], /requires <id> or --tag TAG/],
    [["screen", "assign", A, B, "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--expect-rev", "2"], /revision guards are per screen/],
    [["screen", "reload", "--tag", "Lobby", "--expect-rev", "2"], /revision guards are per screen/],
    [["screen", "reload", A, "--tag", "Lobby"], /not both/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, detail, argv.join(" "));
  }
  assert.equal(transport.calls.length, before);
});

test("fleet actions: no match warns, a malformed answer is refused, and an older server is explained", async () => {
  const env = await enrolled();
  const { transport } = fleetBackend();
  const none = await cli(["--json", "screen", "reload", "--tag", "Nowhere"], transport, env);
  assert.equal(none.code, 0, none.stdout);
  assert.equal(none.envelope.data.matched, 0);
  assert.deepEqual(none.envelope.warnings!.map((warning) => warning.code), ["fleet_no_match"]);

  const malformed = new FakeTransport().on("POST", "/api/v1/screens/actions", () => ({
    status: 200, headers: {}, body: { action: "reload", matched: 2, succeeded: 2, failed: 0, results: [{ screen_id: A, status: "ok" }] },
  }));
  const refused = await cli(["--json", "screen", "reload", A, B], malformed, env);
  assert.equal(refused.code, ExitCode.Usage);
  assert.match(refused.envelope.error!.detail, /ScreenActionResult contract/);

  const older = new FakeTransport().on("POST", "/api/v1/screens/actions", () => ({ status: 405, headers: {}, body: "" }));
  const unsupported = await cli(["--json", "screen", "reload", A, B], older, env);
  assert.equal(unsupported.envelope.ok, false);
  assert.match(unsupported.envelope.error!.detail, /does not offer fleet screen actions/);
});

function screenshotBackend(failing: string, inFlight: { now: number; max: number }): FakeTransport {
  const transport = new FakeTransport();
  const captures = new Map<string, string>();
  transport.on("GET", "/api/v1/screens", (req) => ({
    status: 200, headers: {},
    body: { items: [screen(A, { tags: ["Lobby"] }), screen(C, { tags: ["Lobby"], state: "pairing_pending" }), screen(B, { tags: ["Lobby"] }), screen(failing, { tags: ["Lobby"] })].filter((item) => (item.tags as string[]).includes(req.query?.tag ?? "")) },
  }));
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/screenshot$/, async (req): Promise<TransportResponse> => {
    const id = req.path.split("/")[4]!;
    inFlight.now += 1;
    inFlight.max = Math.max(inFlight.max, inFlight.now);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight.now -= 1;
    if (id === failing) return { status: 409, headers: { "content-type": "application/problem+json" }, body: problem(409, "screenshot_unavailable", "Screenshot is not available.") };
    const capture = `shot_${id.slice(4, 20)}`;
    captures.set(id, capture);
    return { status: 202, headers: {}, body: { capture_id: capture, expires_at: "2026-08-14T17:00:30.000Z" } };
  });
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+\/screenshot\/status$/, (req) => ({
    status: 200, headers: {},
    body: { state: "ready", capture_id: captures.get(req.path.split("/")[4]!), bytes: IMAGE.byteLength, sha256: IMAGE_SHA256, width: 480, height: 270 },
  }));
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+\/screenshot$/, () => ({
    status: 200, headers: { "content-type": "image/webp", "content-length": String(IMAGE.byteLength) }, body: IMAGE,
  }));
  return transport;
}

test("screen screenshot --tag fans out client-side with bounded concurrency into a directory", async () => {
  const env = await enrolled();
  const inFlight = { now: 0, max: 0 };
  const transport = screenshotBackend(MISSING, inFlight);
  const result = await cli(["--json", "screen", "screenshot", "--tag", "Lobby", "--output", "shots", "--concurrency", "2"], transport, env);
  assert.equal(result.code, ExitCode.Conflict, result.stdout);
  assert.equal(result.envelope.ok, true);
  assert.equal(transport.calls[0]!.path, "/api/v1/screens");
  assert.deepEqual(transport.calls[0]!.query, { tag: "Lobby" });
  const data = result.envelope.data;
  assert.equal(data.action, "screenshot");
  assert.deepEqual(data.selector, { by: "tag", tag: "Lobby" });
  assert.equal(data.output, path.join(env.cwd, "shots"));
  assert.equal(data.matched, 3, "pairing_pending screens are skipped like the fleet tag selector");
  assert.equal(data.succeeded, 2);
  assert.equal(data.failed, 1);
  assert.deepEqual(data.results.map((item: any) => [item.screen_id, item.status]), [[A, "ok"], [B, "ok"], [MISSING, "failed"]]);
  assert.equal(data.results[0].path, path.join(env.cwd, "shots", `${A}.webp`));
  assert.equal(data.results[0].sha256, IMAGE_SHA256);
  assert.equal(data.results[2].problem.code, "screenshot_unavailable");
  assert.deepEqual(result.envelope.warnings!.map((warning) => warning.code), ["fleet_partial_failure"]);
  assert.ok(inFlight.max <= 2 && inFlight.max >= 1, `in flight ${inFlight.max}`);
  assert.deepEqual((await readdir(path.join(env.cwd, "shots"))).sort(), [`${A}.webp`, `${B}.webp`]);
  assert.deepEqual(new Uint8Array(await readFile(path.join(env.cwd, "shots", `${A}.webp`))), IMAGE);
  assert.ok(!result.stdout.includes("PIXELS_MUST_NOT_PRINT"), "stdout never carries image bytes");

  const human = await cli(["--human", "screen", "screenshot", A, B, "--output", "more"], screenshotBackend(MISSING, { now: 0, max: 0 }), env);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^Fleet screenshot: matched 2, succeeded 2, failed 0$/m);
  assert.match(human.stdout, new RegExp(`^${B}  ok  .*more/${B}\\.webp$`, "m"));
});

test("screen screenshot fan-out validates output, concurrency, and idempotency before capturing", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "taken.webp"), "x");
  const transport = screenshotBackend(MISSING, { now: 0, max: 0 });
  for (const [argv, detail] of [
    [["screen", "screenshot", "--tag", "Lobby", "--output", "taken.webp"], /must be a directory/],
    [["screen", "screenshot", A, B, "--concurrency", "9"], /--concurrency must be a whole number from 1 to 8/],
    [["screen", "screenshot", "--tag", "Lobby", "--idempotency-key", "idem_fleetAAAAAAAAAAAAAAAA"], /does not take --idempotency-key/],
    [["screen", "screenshot"], /requires <id> or --tag TAG/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, detail);
  }
  assert.equal(transport.calls.length, 0);
});

test("screen.online and screen.offline render as compact logfmt lines", () => {
  const online = formatEventLine({
    cursor: "ev1_1", sequence: 1, type: "screen.online", severity: "info", message: "Screen came online",
    resource: { type: "screen", id: A, name: "Lobby" } as never,
    details: { last_online_at: "2026-08-14T16:58:00Z", offline_at: "2026-08-14T16:59:00Z" },
    at: "2026-08-14T17:00:00Z",
  } as never);
  assert.equal(online, `at=2026-08-14T17:00:00Z type=screen.online severity=info resource_type=screen resource_id=${A} last_online_at=2026-08-14T16:58:00Z offline_at=2026-08-14T16:59:00Z`);
  const offline = formatEventLine({
    cursor: "ev1_2", sequence: 2, type: "screen.offline", severity: "warning", message: "Screen went offline",
    resource: { type: "screen", id: A }, details: { last_online_at: "2026-08-14T16:58:00Z" }, at: "2026-08-14T17:01:00Z",
  } as never);
  assert.equal(offline, `at=2026-08-14T17:01:00Z type=screen.offline severity=warning resource_type=screen resource_id=${A} last_online_at=2026-08-14T16:58:00Z`);
});

async function pendingWrites(env: { fs: ConfigFs }): Promise<Record<string, { command?: string; supersede?: string }> | undefined> {
  const config = JSON.parse(await readFile(path.join(env.fs.homedir(), "screenrig", "config.json"), "utf8")) as { pending_writes?: Record<string, { command?: string }> };
  return config.pending_writes;
}

test("a returned fleet answer, including partial failure, completes write recovery", async () => {
  const env = await enrolled();
  const { transport } = fleetBackend();
  const result = await cli(["--json", "screen", "reload", A, MISSING], transport, env);
  assert.equal(result.code, ExitCode.NotFound);
  assert.equal(await pendingWrites(env), undefined, "only an interrupted or ambiguous request keeps its key for a rerun");
});

test("single-screen --add rerun after an ambiguous failure supersedes the obsolete recovery entry", async () => {
  const env = await enrolled();
  const { transport, screens } = fleetBackend();
  let fail = true;
  transport.on("PATCH", `/api/v1/screens/${A}`, (): TransportResponse => {
    // The first write lands on the server, but its answer is lost.
    const current = screens.get(A)!;
    current.tags = [...current.tags, "Spring"];
    current.revision += 1;
    return { status: 503, headers: { "content-type": "application/problem+json" }, body: problem(503, "service_unavailable", "Try again.") };
  });
  const routes = (transport as unknown as { routes: Array<{ method: string; path: unknown; handler: unknown }> }).routes;
  const ambiguous = routes.pop()!;
  const original = routes.find((route) => route.method === "PATCH")!;
  const originalHandler = original.handler as (req: TransportRequest) => TransportResponse;
  original.handler = (req: TransportRequest) => {
    if (fail) { fail = false; return (ambiguous.handler as (req: TransportRequest) => TransportResponse)(req); }
    return originalHandler(req);
  };

  const first = await cli(["--json", "screen", "tag", A, "--add", "Spring"], transport, env);
  assert.equal(first.code, ExitCode.Server, first.stdout);
  const saved = await pendingWrites(env);
  assert.equal(Object.keys(saved ?? {}).length, 1, "the ambiguous write keeps its key");
  assert.equal(Object.values(saved!)[0]!.command, "screen tag", "screen tag is a recorded recovery command");
  assert.match(String(Object.values(saved!)[0]!.supersede), /^[a-f0-9]{64}$/, "only a hash reaches disk");
  assert.ok(!JSON.stringify(saved).includes("Spring"), "no payload reaches the ledger");

  const rerun = await cli(["--json", "screen", "tag", A, "--add", "Spring"], transport, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  assert.equal(transport.calls.at(-1)!.headers?.["if-match"], '"4"', "the rerun reads the newer revision");
  assert.deepEqual(rerun.envelope.data.tags, ["Lobby", "Spring"]);
  assert.equal(await pendingWrites(env), undefined, "the obsolete entry is superseded, not orphaned");
});

test("screen screenshot fan-out keeps each capture's own exit code and stops on unexpected failures", async () => {
  const env = await enrolled();
  const network = screenshotBackend(B, { now: 0, max: 0 });
  const routes = (network as unknown as { routes: Array<{ method: string; path: RegExp | string; handler: (req: TransportRequest) => unknown }> }).routes;
  const post = routes.find((route) => route.method === "POST")!;
  const postHandler = post.handler;
  post.handler = (req) => {
    if (req.path.includes(B)) throw networkError("connection reset");
    return postHandler(req);
  };
  const netResult = await cli(["--json", "screen", "screenshot", A, B, "--output", "net"], network, env);
  assert.equal(netResult.code, ExitCode.Network, "a network failure keeps exit 10 rather than a status-derived code");
  assert.equal(netResult.envelope.data.results[1].status, "failed");
  assert.equal(netResult.envelope.data.results[1].exit_code, undefined, "exit codes are not serialized");

  const broken = screenshotBackend(B, { now: 0, max: 0 });
  const brokenPost = (broken as unknown as { routes: Array<{ method: string; handler: (req: TransportRequest) => unknown }> }).routes.find((route) => route.method === "POST")!;
  const brokenHandler = brokenPost.handler;
  brokenPost.handler = (req) => {
    if (req.path.includes(A)) throw new TypeError("boom");
    return brokenHandler(req);
  };
  const fatal = await cli(["--json", "screen", "screenshot", A, C, "--output", "fatal", "--concurrency", "1"], broken, env);
  assert.equal(fatal.code, ExitCode.Unexpected, fatal.stdout);
  assert.equal(fatal.envelope.ok, true);
  assert.deepEqual(fatal.envelope.data.results.map((item: any) => [item.screen_id, item.status, item.problem?.code]), [[A, "failed", "unexpected_error"], [C, "failed", "not_attempted"]]);
  assert.equal(fatal.envelope.data.failed, 2);
  assert.equal(broken.calls.filter((call) => call.path.includes(C)).length, 0, "no new capture starts after an unexpected failure");
});

test("screen screenshot caps --tag at 500 screens and validates ids before any request", async () => {
  const env = await enrolled();
  const many = new FakeTransport().on("GET", "/api/v1/screens", () => ({
    status: 200, headers: {},
    body: { items: Array.from({ length: 501 }, (_, index) => screen(`scr_${String(index).padStart(24, "A")}`, { tags: ["Lobby"] })) },
  }));
  const capped = await cli(["--json", "screen", "screenshot", "--tag", "Lobby", "--output", "cap"], many, env);
  assert.equal(capped.code, ExitCode.Usage, capped.stdout);
  assert.match(capped.envelope.error!.detail, /matches 501 active screens; screen screenshot captures at most 500/);
  assert.equal(many.calls.length, 1, "only the list request was sent");

  const ids = new FakeTransport();
  const invalid = await cli(["--json", "screen", "screenshot", A, "not-a-screen", "--output", "ids"], ids, env);
  assert.equal(invalid.code, ExitCode.Usage);
  assert.match(invalid.envelope.error!.detail, /takes screen ids/);
  assert.equal(ids.calls.length, 0);
});
