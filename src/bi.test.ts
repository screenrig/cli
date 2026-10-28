import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import {
  biDashboardUid, biRefreshSeconds, biTime, biVar, BI_CONNECTION_ID_PATTERN, BI_VIEW_ID_PATTERN, connectionLines, connectionTableLines, viewLines, viewTableLines,
  type BiConnection, type BiView,
} from "./bi.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-10-28T17:00:00.000Z");
// A Grafana-shaped token built in code, so no literal here looks like a credential.
const TOKEN = `glsa_${"x".repeat(24)}_0a1b2c3d`;
const CONN = "bic_CONNECTIONAAAAAAAAAA";
const VIEW = "biv_VIEWAAAAAAAAAAAAAAAA";
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from("fake image bytes")]);

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; hint?: string; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
}
interface Env { fs: ConfigFs; cwd: string; configPath: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("bi-cfg-");
  const cwd = await testTemp("bi-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, extra: Partial<CliRuntime> = {}): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport, ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

const biCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => /^\/api\/bi-(?:connections|views)(?:\/|$)/.test(call.path));
const lastCall = (transport: FakeTransport): TransportRequest => biCalls(transport).at(-1)!;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({ status, headers: { "content-type": "application/problem+json" }, body: { type: `https://screenrig.ai/problems/${code}`, title: code, status, code, detail } });

function connection(overrides: Partial<BiConnection> = {}): BiConnection {
  return {
    id: CONN, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "grafana", name: "Ops Grafana", config: { url: "https://grafana.example.com/grafana", org_id: 1 },
    embed_origin: "https://bi-0123456789abcdef0123.apps.screenrig.ai", secret: { set: true, hint: "2c3d" }, last_test: null, revision: 1,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

function view(overrides: Partial<BiView> = {}): BiView {
  return {
    id: VIEW, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", connection_id: CONN, kind: "grafana", name: "Lobby wall",
    target: { dashboard_uid: "abc123", theme: "dark" }, refresh_s: 300, fit: "contain", revision: 1,
    status: { last_ok_at: null, last_error: null }, embed_url: `https://bi-0123456789abcdef0123.apps.screenrig.ai/v/${VIEW}`,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

/** A BI backend of one connection and one view. Writes echo what a server would answer. */
function backend(options: { publicView?: boolean } = {}): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  let currentView = options.publicView ? view({ connection_id: undefined, target: { public_url: "https://g.example.com/p/x" } }) : view();
  transport
    .on("GET", "/api/bi-connections", () => json(200, { items: [connection()], next_cursor: null }))
    .on("POST", "/api/bi-connections", (req) => {
      const body = req.body as { name: string; config: { url: string; org_id?: number } };
      return json(201, connection({ name: body.name, config: { url: body.config.url, org_id: body.config.org_id ?? 1 } }));
    })
    .on("GET", `/api/bi-connections/${CONN}`, () => json(200, connection({ last_test: { at: "2026-10-28T16:30:00Z", ok: true, checks: [{ name: "token", ok: true }, { name: "image_renderer", ok: true, warn: true, detail: "Grafana lists no Image Renderer plugin." }] } })))
    .on("PATCH", `/api/bi-connections/${CONN}`, (req) => json(200, connection({ revision: 2, ...(req.body as { name?: string }).name ? { name: (req.body as { name: string }).name } : {} })))
    .on("DELETE", `/api/bi-connections/${CONN}`, () => ({ status: 204, headers: {}, body: undefined }))
    .on("POST", `/api/bi-connections/${CONN}/test`, () => json(200, { at: "2026-10-28T17:00:00Z", ok: false, checks: [{ name: "token", ok: false, detail: "Grafana refused the service-account token." }] }))
    .on("GET", `/api/bi-connections/${CONN}/browse`, (req) => req.query?.dashboard
      ? json(200, { dashboard: { uid: "abc123", title: "Lobby" }, items: [{ id: 1, title: "CPU", type: "timeseries" }], next_cursor: null })
      : req.query?.cursor === "2"
        ? json(200, { items: [{ uid: "def456", title: "Sales", folder: "" }], next_cursor: null })
        : json(200, { items: [{ uid: "abc123", title: "Lobby", folder: "Ops" }], next_cursor: "2" }))
    .on("GET", "/api/bi-views", () => json(200, { items: [currentView], next_cursor: null }))
    .on("POST", "/api/bi-views", (req) => {
      const body = req.body as Record<string, any>;
      currentView = view({ name: body.name, refresh_s: body.refresh_s ?? 300, fit: body.fit ?? "contain", ...(body.connection_id ? {} : { connection_id: undefined }), target: body.target ?? { dashboard_uid: "abc123", theme: "dark" } });
      return json(201, currentView);
    })
    .on("GET", `/api/bi-views/${VIEW}`, () => json(200, currentView))
    .on("PATCH", `/api/bi-views/${VIEW}`, (req) => {
      const body = req.body as Record<string, any>;
      currentView = view({ ...currentView, ...(body.name ? { name: body.name } : {}), ...(body.target ? { target: body.target } : {}), revision: currentView.revision + 1 });
      return json(200, currentView);
    })
    .on("DELETE", `/api/bi-views/${VIEW}`, () => ({ status: 204, headers: {}, body: undefined }))
    .on("POST", `/api/bi-views/${VIEW}/test`, () => json(200, { at: "2026-10-28T17:00:00Z", ok: true, checks: [{ name: "render", ok: true, detail: "Grafana drew a 1920x1080 image of 18 bytes in 0.3 seconds." }], width: 1920, height: 1080, bytes: 18 }))
    .onDownload("GET", `/api/bi-views/${VIEW}/image`, () => ({ status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) }, body: Readable.from([PNG]) as never }));
  return transport;
}

test("the parsers read cadences, variables and ids", () => {
  assert.equal(biRefreshSeconds("30s"), 30);
  assert.equal(biRefreshSeconds("5m"), 300);
  assert.equal(biRefreshSeconds("1h30m"), 5400);
  assert.equal(biRefreshSeconds("24h"), 86_400);
  assert.equal(biRefreshSeconds("90"), 90);
  assert.equal(biRefreshSeconds("0"), 0);
  for (const bad of ["29s", "25h", "soon", "", "1w"]) assert.throws(() => biRefreshSeconds(bad), /--refresh takes a cadence/, bad);
  assert.deepEqual(JSON.parse(biVar("host=web1")), { "var-host": "web1" });
  assert.deepEqual(JSON.parse(biVar("var-env=prod", biVar("host=web1"))), { "var-host": "web1", "var-env": "prod" });
  assert.deepEqual(JSON.parse(biVar("note=a=b")), { "var-note": "a=b" });
  assert.deepEqual(JSON.parse(biVar("empty=")), { "var-empty": "" });
  for (const bad of ["host", "=x", "bad name=1", `host=${"v".repeat(201)}`]) assert.throws(() => biVar(bad), /--var takes|at most 200/, bad);
  assert.equal(biTime("now-6h"), "now-6h");
  assert.throws(() => biTime("now 6h"), /Grafana time/);
  assert.equal(biDashboardUid("abc_123-x.y"), "abc_123-x.y");
  assert.throws(() => biDashboardUid("has space"), /dashboard uid/);
  assert.match(CONN, BI_CONNECTION_ID_PATTERN);
  assert.match(`stage_${VIEW}`, BI_VIEW_ID_PATTERN);
  assert.doesNotMatch(CONN, BI_VIEW_ID_PATTERN);
});

test("connection create reads the token from a file or stdin and never prints it", async () => {
  const env = await enrolled();
  const transport = backend();
  await writeFile(path.join(env.cwd, "token.txt"), `${TOKEN}\n`);
  const result = await cli(["--json", "bi", "connection", "create", "grafana", "--url", "https://grafana.example.com/grafana", "--token-file", "token.txt", "--org-id", "2"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/bi-connections");
  assert.deepEqual(call.body, { name: "grafana.example.com", kind: "grafana", config: { url: "https://grafana.example.com/grafana", org_id: 2 }, secret: TOKEN });
  assert.ok(call.headers?.["Idempotency-Key"] ?? call.headers?.["idempotency-key"], "a write carries an idempotency key");
  assert.equal(result.envelope.data.secret.hint, "2c3d");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN));

  const human = await cli(["--human", "bi", "connection", "create", "grafana", "--url", "https://grafana.example.com", "--token-file", "-", "--name", "Ops Grafana"], transport, env,
    { stdin: Readable.from([Buffer.from(`${TOKEN}\n`)]), isStdinTty: () => false });
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.equal((lastCall(transport).body as { secret: string }).secret, TOKEN);
  assert.match(human.stdout, /^Created connection bic_/m);
  assert.match(human.stdout, /^secret: set \(ends 2c3d\)$/m);
  assert.match(human.stdout, /Next: screenrig bi connection test/);
  assert.doesNotMatch(human.stdout + human.stderr, new RegExp(TOKEN));
});

test("connection create refuses a missing, empty or malformed token and a token on the command line", async () => {
  const env = await enrolled();
  const transport = backend();
  await writeFile(path.join(env.cwd, "empty.txt"), "\n");
  await writeFile(path.join(env.cwd, "two.txt"), "one two\n");
  const base = ["--json", "bi", "connection", "create", "grafana", "--url", "https://grafana.example.com"];
  for (const [args, pattern] of [
    [[...base], /--token-file/],
    [[...base, "--token-file", "empty.txt"], /holds no token/],
    [[...base, "--token-file", "two.txt"], /only the token/],
    [[...base, "--token-file", "missing.txt"], /does not exist/],
    [[...base, "--token-file", "empty.txt", "--secret", TOKEN], /does not accept --secret/],
    [["--json", "bi", "connection", "create", "grafana", "--url", "ftp://x", "--token-file", "empty.txt"], /address/],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(args, transport, env);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? result.stderr, pattern);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN));
  }
  assert.equal(biCalls(transport).length, 0, "nothing was sent");
});

test("connection list, show, test, browse, update and delete", async () => {
  const env = await enrolled();
  const transport = backend();
  const list = await cli(["--human", "bi", "connection", "list"], transport, env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^Connections \(1\)$/m);
  assert.match(list.stdout, new RegExp(`^${CONN}\\s+grafana\\s+Ops Grafana\\s+https://grafana.example.com/grafana\\s+never$`, "m"));

  const show = await cli(["--human", "bi", "connection", "show", CONN], transport, env);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /^embed origin: https:\/\/bi-0123456789abcdef0123\.apps\.screenrig\.ai$/m);
  assert.match(show.stdout, /^last test: ok at 2026-10-28T16:30:00Z$/m);
  assert.match(show.stdout, /^  warning image_renderer: Grafana lists no Image Renderer plugin\.$/m);

  const test_ = await cli(["--human", "bi", "connection", "test", CONN], transport, env);
  assert.equal(test_.code, 0, test_.stderr);
  assert.match(test_.stdout, new RegExp(`^Connection ${CONN}: failed$`, "m"));
  assert.match(test_.stdout, /^  failed token: Grafana refused the service-account token\.$/m);
  assert.equal((await cli(["--json", "bi", "connection", "test", CONN], transport, env)).envelope.data.ok, false);

  const browse = await cli(["--json", "bi", "connection", "browse", CONN, "--query", "lob"], transport, env);
  assert.equal(browse.code, 0, browse.stdout);
  assert.deepEqual(browse.envelope.data.items.map((item: { uid: string }) => item.uid), ["abc123", "def456"], "every page is read");
  const panels = await cli(["--human", "bi", "connection", "browse", CONN, "--dashboard", "abc123"], transport, env);
  assert.match(panels.stdout, /^Panels of Lobby \(1\)$/m);
  assert.match(panels.stdout, /^1\s+timeseries\s+CPU$/m);

  const tokenFile = path.join(env.cwd, "new.txt");
  await writeFile(tokenFile, `${TOKEN}\n`);
  const update = await cli(["--json", "bi", "connection", "update", CONN, "--name", "Renamed", "--url", "https://grafana.example.com", "--token-file", tokenFile, "--expect-rev", "1"], transport, env);
  assert.equal(update.code, 0, update.stdout);
  const patch = lastCall(transport);
  assert.equal(patch.method, "PATCH");
  assert.deepEqual(patch.body, { name: "Renamed", config: { url: "https://grafana.example.com" }, secret: TOKEN });
  assert.equal(patch.headers?.["if-match"], '"1"');
  assert.equal((await cli(["--json", "bi", "connection", "update", CONN], transport, env)).code, 2);

  // The stored secret goes only to the address it was saved for: another origin needs the secret again.
  const callsBefore = biCalls(transport).length;
  for (const away of ["https://other.example.com/grafana", "http://grafana.example.com/grafana", "https://grafana.example.com:3000/grafana"]) {
    const refused = await cli(["--json", "bi", "connection", "update", CONN, "--url", away], transport, env);
    assert.equal(refused.code, 2, away);
    assert.match(refused.stderr + refused.stdout, /needs the secret again.*--token-file FILE.*--secret-file FILE/s, away);
  }
  assert.ok(biCalls(transport).slice(callsBefore).every((call) => call.method === "GET"), "a refused update sends no PATCH");
  const samePlace = await cli(["--json", "bi", "connection", "update", CONN, "--url", "https://GRAFANA.example.com/other"], transport, env);
  assert.equal(samePlace.code, 0, samePlace.stdout);
  assert.deepEqual(lastCall(transport).body, { config: { url: "https://GRAFANA.example.com/other" } });

  const removed = await cli(["--json", "bi", "connection", "delete", CONN], transport, env);
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual(removed.envelope.data, { id: CONN, deleted: true });
  assert.equal(lastCall(transport).method, "DELETE");
  assert.equal((await cli(["--json", "bi", "connection", "show", "nope"], transport, env)).code, 2);
});

test("bi problems name the next command", async () => {
  const env = await enrolled();
  const transport = backend()
    .on("POST", "/api/bi-connections/bic_REFUSEDAAAAAAAAAAAAA/test", () => problem(409, "bi_upstream_refused", "Grafana refused the service-account token."))
    .on("POST", "/api/bi-connections/bic_DOWNAAAAAAAAAAAAAAAA/test", () => problem(500, "bi_upstream_unavailable", "Grafana did not answer in time."))
    .on("DELETE", "/api/bi-connections/bic_USEDAAAAAAAAAAAAAAAA", () => problem(409, "resource_conflict", "The connection is used by views: biv_X."))
    .on("GET", "/api/bi-views/biv_GONEAAAAAAAAAAAAAAAA", () => problem(404, "not_found", "The view was not found in this project."));
  const refused = await cli(["--json", "bi", "connection", "test", "bic_REFUSEDAAAAAAAAAAAAA"], transport, env);
  assert.equal(refused.code, 5);
  assert.equal(refused.envelope.error?.code, "bi_upstream_refused");
  assert.equal(refused.envelope.error?.next?.command, "screenrig bi connection test bic_REFUSEDAAAAAAAAAAAAA");
  const down = await cli(["--json", "bi", "connection", "test", "bic_DOWNAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(down.code, 9);
  assert.equal(down.envelope.error?.code, "bi_upstream_unavailable");
  assert.match(down.envelope.error?.next?.reason ?? "", /Image Renderer/);
  const used = await cli(["--json", "bi", "connection", "delete", "bic_USEDAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(used.code, 5);
  assert.equal(used.envelope.error?.next?.command, "screenrig bi view list");
  const gone = await cli(["--json", "bi", "view", "show", "biv_GONEAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(gone.code, 4);
  assert.equal(gone.envelope.error?.next?.command, "screenrig bi view list");
});

test("view create from a dashboard address sends the url and the embed_url comes back with its iframe hint", async () => {
  const env = await enrolled();
  const transport = backend();
  const address = "https://grafana.example.com/grafana/d/abc123/lobby?orgId=1&viewPanel=4";
  const result = await cli(["--human", "bi", "view", "create", "--connection-id", CONN, "--url", address, "--refresh", "5m", "--fit", "cover"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lastCall(transport).body, { connection_id: CONN, name: "Grafana abc123", url: address, refresh_s: 300, fit: "cover" });
  assert.match(result.stdout, /^embed_url: https:\/\/bi-0123456789abcdef0123\.apps\.screenrig\.ai\/v\/biv_/m);
  assert.match(result.stdout, /^Put this URL in an iframe primitive \(content_fit fill\)\.$/m);
  assert.match(result.stdout, /Next: screenrig bi view test biv_/);
});

test("view create from flags builds the target, repeats --var and checks the combinations", async () => {
  const env = await enrolled();
  const transport = backend();
  const result = await cli(["--json", "bi", "view", "create", "--connection-id", CONN, "--dashboard", "abc123", "--panel", "4", "--from", "now-6h", "--to", "now",
    "--var", "host=web1", "--var", "var-env=prod", "--theme", "light", "--timezone", "utc", "--name", "Web CPU", "--refresh", "90s"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lastCall(transport).body, {
    connection_id: CONN, name: "Web CPU", refresh_s: 90,
    target: { dashboard_uid: "abc123", panel_id: 4, from: "now-6h", to: "now", vars: { "var-host": "web1", "var-env": "prod" }, theme: "light", timezone: "utc" },
  });
  const calls = biCalls(transport).length;
  for (const [args, pattern] of [
    [["--connection-id", CONN], /Provide exactly one of/],
    [["--connection-id", CONN, "--url", "https://g.example.com/d/a/b", "--dashboard", "abc"], /cannot be used with/],
    [["--connection-id", CONN, "--url", "https://g.example.com/d/a/b", "--theme", "dark"], /the target comes from the address/],
    [["--dashboard", "abc123"], /requires --connection-id/],
    [["--connection-id", CONN, "--public-url", "https://g.example.com/public-dashboards/x"], /cannot be used with/],
    [["--public-url", "https://g.example.com/public-dashboards/x", "--theme", "dark"], /needs no connection/],
    [["--connection-id", CONN, "--dashboard", "abc", "--refresh", "10s"], /--refresh takes a cadence/],
    [["--connection-id", CONN, "--dashboard", "abc", "--fit", "stretch"], /--fit must be contain, cover, or fill/],
    [["--connection-id", CONN, "--dashboard", "abc", "--var", "host"], /--var takes NAME=VALUE/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "view", "create", ...args], transport, env);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, args.join(" "));
  }
  assert.equal(biCalls(transport).length, calls, "refused commands send nothing");
});

test("view create of a public link needs no connection", async () => {
  const env = await enrolled();
  const transport = backend();
  const result = await cli(["--json", "bi", "view", "create", "--public-url", "https://grafana.example.com/public-dashboards/abc"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lastCall(transport).body, { kind: "grafana", name: "Grafana public dashboard", target: { public_url: "https://grafana.example.com/public-dashboards/abc" } });
});

test("view update merges target flags into the current target and replaces it for --dashboard, --url and --public-url", async () => {
  const env = await enrolled();
  const transport = backend();
  const merged = await cli(["--json", "bi", "view", "update", VIEW, "--theme", "light", "--var", "host=web2", "--expect-rev", "1"], transport, env);
  assert.equal(merged.code, 0, merged.stdout + merged.stderr);
  const calls = biCalls(transport);
  assert.equal(calls.at(-2)!.method, "GET", "the current target is read first");
  assert.deepEqual(calls.at(-1)!.body, { target: { dashboard_uid: "abc123", theme: "light", vars: { "var-host": "web2" } } });
  assert.equal(calls.at(-1)!.headers?.["if-match"], '"1"');

  const replaced = await cli(["--json", "bi", "view", "update", VIEW, "--dashboard", "def456", "--panel", "2"], transport, env);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.equal(biCalls(transport).at(-1)!.method, "PATCH", "no read: --dashboard starts a new target");
  assert.deepEqual(lastCall(transport).body, { target: { dashboard_uid: "def456", panel_id: 2 } });

  const byUrl = await cli(["--json", "bi", "view", "update", VIEW, "--url", "https://g.example.com/d/zz/x", "--name", "Renamed", "--fit", "fill", "--refresh", "1m"], transport, env);
  assert.equal(byUrl.code, 0, byUrl.stdout);
  assert.deepEqual(lastCall(transport).body, { name: "Renamed", refresh_s: 60, fit: "fill", url: "https://g.example.com/d/zz/x" });
  for (const args of [[VIEW], [VIEW, "--url", "https://g.example.com/d/zz/x", "--theme", "dark"], [VIEW, "--public-url", "https://g.example.com/p", "--dashboard", "x"]]) {
    assert.equal((await cli(["--json", "bi", "view", "update", ...args], transport, env)).code, 2, args.join(" "));
  }
});

test("view update of a public link refuses a dashboard flag", async () => {
  const env = await enrolled();
  const transport = backend({ publicView: true });
  const result = await cli(["--json", "bi", "view", "update", VIEW, "--theme", "light"], transport, env);
  assert.equal(result.code, 2);
  assert.match(result.envelope.error?.detail ?? "", /shows a public link/);
});

test("view list, show and delete", async () => {
  const env = await enrolled();
  const transport = backend();
  const list = await cli(["--human", "bi", "view", "list"], transport, env);
  assert.match(list.stdout, /^Views \(1\)$/m);
  assert.match(list.stdout, new RegExp(`^${VIEW}\\s+Lobby wall\\s+dashboard abc123, dark\\s+300s\\s+new$`, "m"));
  const show = await cli(["--human", "bi", "view", "show", VIEW], transport, env);
  assert.match(show.stdout, /^shows: dashboard abc123, dark$/m);
  assert.match(show.stdout, /^status: not shown yet$/m);
  const removed = await cli(["--human", "bi", "view", "delete", VIEW, "--expect-rev", "1"], transport, env);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /answers not_found until its playlist changes/);
  assert.equal(lastCall(transport).headers?.["if-match"], '"1"');
});

test("view test runs the checks, or saves the render", async () => {
  const env = await enrolled();
  const transport = backend();
  const checks = await cli(["--human", "bi", "view", "test", VIEW], transport, env);
  assert.equal(checks.code, 0, checks.stderr);
  assert.match(checks.stdout, new RegExp(`^View ${VIEW}: ok$`, "m"));
  assert.match(checks.stdout, /^  ok render: Grafana drew a 1920x1080 image/m);

  const saved = await cli(["--json", "bi", "view", "test", VIEW, "--output", "shots/lobby.png", "--width", "1280", "--height", "720"], transport, env);
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  const call = lastCall(transport);
  assert.equal(call.path, `/api/bi-views/${VIEW}/image`);
  assert.deepEqual(call.query, { width: "1280", height: "720" });
  const file = path.join(env.cwd, "shots", "lobby.png");
  assert.deepEqual(await readFile(file), PNG);
  assert.deepEqual(saved.envelope.data, { id: VIEW, file, bytes: PNG.length, width: 1280, height: 720 });

  const sized = await cli(["--json", "bi", "view", "test", VIEW, "--width", "1280"], transport, env);
  assert.equal(sized.code, 2);
  assert.match(sized.envelope.error?.detail ?? "", /--output/);
});

test("the human lines show the view and connection facts and never a secret", () => {
  const lines = viewLines(view({ status: { last_ok_at: null, last_error: { at: "2026-10-28T16:00:00Z", code: "bi_upstream_unavailable", detail: "Grafana did not answer in time." } }, embed_url: null }));
  assert.ok(lines.includes("status: bi_upstream_unavailable (Grafana did not answer in time.)"));
  assert.ok(lines.includes("embed_url: (none: this server has no embed host)"));
  assert.deepEqual(viewTableLines([]), ["No views"]);
  assert.deepEqual(connectionTableLines([]), ["No connections"]);
  const shown = connectionLines(connection({ secret: { set: false, hint: "" } }));
  assert.ok(shown.includes("secret: not set"));
  assert.doesNotMatch(JSON.stringify(connectionLines(connection())), new RegExp(TOKEN));
});

test("the help names the renderer, the secret rule and carries examples that run", async () => {
  const create = commandHelp(["bi", "connection", "create", "grafana"]);
  assert.match(create.notes.join("\n"), /never an argument/);
  assert.match(create.notes.join("\n"), /Grafana Image Renderer/);
  assert.ok(create.options.some((option) => option.name === "--token-file"));
  const viewCreate = commandHelp(["bi", "view", "create"]);
  assert.match(viewCreate.notes.join("\n"), /embed_url/);
  assert.match(viewCreate.notes.join("\n"), /iframe primitive/);
  assert.match(viewCreate.notes.join("\n"), /allow_embedding/);

  const env = await enrolled();
  await writeFile(path.join(env.cwd, "token.txt"), `${TOKEN}\n`);
  await writeFile(path.join(env.cwd, "new-token.txt"), `${TOKEN}\n`);
  await writeFile(path.join(env.cwd, "secret.txt"), `${TOKEN}\n`);
  await writeFile(path.join(env.cwd, "new-secret.txt"), `${TOKEN}\n`);
  const leaves = [
    ["bi", "connection", "create", "grafana"], ["bi", "connection", "create", "powerbi"], ["bi", "connection", "create", "tableau"], ["bi", "connection", "list"], ["bi", "connection", "show"], ["bi", "connection", "test"], ["bi", "connection", "update"],
    ["bi", "connection", "browse"], ["bi", "connection", "delete"], ["bi", "view", "create"], ["bi", "view", "list"], ["bi", "view", "show"], ["bi", "view", "update"],
    ["bi", "view", "test"], ["bi", "view", "delete"],
  ];
  for (const leaf of leaves) {
    const help = commandHelp(leaf);
    assert.ok(help.examples.length > 0, leaf.join(" "));
    for (const example of help.examples) {
      const words = [...example.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!);
      assert.deepEqual(words.slice(0, leaf.length + 1), ["screenrig", ...leaf], example);
      const argv = words.slice(1).map((word) => word.replace("bic_CONNECTION", CONN).replace("biv_VIEW", VIEW));
      const result = await cli(["--json", ...argv], backend(), env, { stdin: Readable.from([Buffer.from(`${TOKEN}\n`)]), isStdinTty: () => false });
      assert.equal(result.code, 0, `${example}: ${result.stdout}${result.stderr}`);
    }
  }
});
