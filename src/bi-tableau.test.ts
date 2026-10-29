import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import {
  biAppClientId, biSecretId, biSite, biTableauAddress, biUsername, biViewPath, connectionLines, connectionTableLines, publicLinkKind,
  viewLines, viewTableLines, type BiConnection, type BiView,
} from "./bi.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-10-28T17:00:00.000Z");
// A connected app's secret value built in code, so no literal here looks like a credential.
const SECRET = `Tw${"q".repeat(41)}=`;
const CLIENT = "11111111-2222-4333-8444-555555555555";
const SECRET_ID = "66666666-7777-4888-8999-000000000000";
const CONN = "bic_TABLEAUCONNECTIONAA";
const VIEW = "biv_TABLEAUVIEWAAAAAAAA";
const ORIGIN = "https://bi-0123456789abcdef0123.apps.screenrig.ai";

interface Envelope { ok: boolean; data?: any; error?: { code: string; detail: string; status: number } }
interface Env { fs: ConfigFs; cwd: string }

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const configDir = await testTemp("bitbl-cfg-");
  const cwd = await testTemp("bitbl-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA",
    organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  return { fs, cwd };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, extra: Partial<CliRuntime> = {}): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const code = await run({
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport, ...extra,
  });
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, stderr: err, envelope };
}

const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body });
const biCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => /^\/api\/bi-(?:connections|views)(?:\/|$)/.test(call.path));
const lastCall = (transport: FakeTransport): TransportRequest => biCalls(transport).at(-1)!;

function connection(overrides: Partial<BiConnection> = {}): BiConnection {
  return {
    id: CONN, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "tableau", name: "Tableau",
    config: { url: "https://10ay.online.tableau.com", site: "lobby", client_id: CLIENT, secret_id: SECRET_ID, username: "screens@example.com" },
    embed_origin: ORIGIN, secret: { set: true, hint: "qqq=" }, last_test: null, revision: 1,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

function view(overrides: Partial<BiView> = {}): BiView {
  return {
    id: VIEW, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", connection_id: CONN, kind: "tableau", name: "Sales",
    target: { view: "Sales/Overview" }, refresh_s: 300, rotate_s: 0, fit: "contain", revision: 1,
    status: { last_ok_at: null, last_error: null }, embed_url: `${ORIGIN}/v/${VIEW}`,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

/** A Tableau BI backend: one connection, one view whose target the tests set, and a browse in two pages. */
function backend(options: { target?: BiView["target"]; rotate_s?: number } = {}): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  let current = view({ target: options.target ?? { view: "Sales/Overview" }, rotate_s: options.rotate_s ?? 0, ...(options.target?.public_url ? { connection_id: undefined } : {}) });
  transport
    .on("POST", "/api/bi-connections", (req) => {
      const body = req.body as { name: string; config: BiConnection["config"] };
      return json(201, connection({ name: body.name, config: body.config }));
    })
    .on("PATCH", `/api/bi-connections/${CONN}`, () => json(200, connection({ revision: 2 })))
    .on("GET", `/api/bi-connections/${CONN}/browse`, (req) => req.query?.cursor === "2"
      ? json(200, { items: [{ path: "Support_Queue/Board", name: "Board" }], next_cursor: null })
      : json(200, { items: [{ path: "Sales/Overview", name: "Overview" }, { path: "Sales/Detail", name: "Detail" }], next_cursor: "2" }))
    .on("POST", "/api/bi-views", (req) => {
      const body = req.body as Record<string, any>;
      current = view({ name: body.name, refresh_s: body.refresh_s ?? 300, rotate_s: body.rotate_s ?? 0, target: body.target ?? current.target });
      return json(201, current);
    })
    .on("GET", `/api/bi-views/${VIEW}`, () => json(200, current))
    .on("PATCH", `/api/bi-views/${VIEW}`, (req) => {
      const body = req.body as Record<string, any>;
      current = view({ ...current, ...(body.target ? { target: body.target } : {}), ...(body.rotate_s !== undefined ? { rotate_s: body.rotate_s } : {}), revision: current.revision + 1 });
      return json(200, current);
    });
  return transport;
}

test("the Tableau parsers read ids, sites, users, views and addresses", () => {
  assert.equal(biAppClientId(` ${CLIENT} `), CLIENT);
  assert.equal(biSecretId(SECRET_ID), SECRET_ID);
  for (const bad of ["", "my app", "a/b", "x".repeat(129)]) {
    assert.throws(() => biAppClientId(bad), /--client-id takes/, bad);
    assert.throws(() => biSecretId(bad), /--secret-id takes/, bad);
  }
  assert.equal(biSite(" lobby "), "lobby");
  assert.equal(biSite(""), "");
  for (const bad of ["a b", "a/b", "x".repeat(256)]) assert.throws(() => biSite(bad), /--site takes/, bad);
  assert.equal(biUsername(" screens@example.com "), "screens@example.com");
  for (const bad of ["", "  ", "a\u0000b", "x".repeat(321)]) assert.throws(() => biUsername(bad), /--username takes/, bad);
  assert.equal(biViewPath("Sales/Overview"), "Sales/Overview");
  assert.equal(biViewPath("Sales%20Plan/Over_view"), "Sales%20Plan/Over_view");
  for (const bad of ["Sales", "Sales/", "/Overview", "a/b/c", "Sales/..", "Sales/Over view", ""]) assert.throws(() => biViewPath(bad), /--view takes/, bad);
  assert.equal(biTableauAddress("https://10ay.online.tableau.com"), "https://10ay.online.tableau.com");
  for (const bad of ["http://tableau.example.com", "tableau.example.com", "https://a b"]) assert.throws(() => biTableauAddress(bad), /--url takes the https address/, bad);
  assert.equal(publicLinkKind("https://public.tableau.com/app/profile/someone/viz/W/S"), "tableau");
  assert.equal(publicLinkKind("https://tableau.example.com/views/W/S"), "grafana");
  assert.equal(publicLinkKind("https://app.powerbi.com/view?r=abc"), "powerbi");
});

test("connection create tableau reads the secret value from a file or stdin and never prints it", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "secret.txt"), `${SECRET}\n`);
  const transport = backend();
  const result = await cli(["--json", "bi", "connection", "create", "tableau", "--url", "https://10ay.online.tableau.com", "--site", "lobby", "--client-id", CLIENT,
    "--secret-id", SECRET_ID, "--username", "screens@example.com", "--secret-file", "secret.txt"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lastCall(transport).body, {
    name: "10ay.online.tableau.com", kind: "tableau", secret: SECRET,
    config: { url: "https://10ay.online.tableau.com", site: "lobby", client_id: CLIENT, secret_id: SECRET_ID, username: "screens@example.com" },
  });
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), "the output holds the secret");
  assert.equal(result.envelope.data.config.site, "lobby");

  // The default site is no site at all; stdin works; the human output names the allowlist and the next step.
  const piped = await cli(["--human", "bi", "connection", "create", "tableau", "--url", "https://tableau.example.com", "--client-id", CLIENT, "--secret-id", SECRET_ID,
    "--username", "wall", "--secret-file", "-", "--name", "Ops Tableau"], transport, env, { stdin: Readable.from([Buffer.from(`${SECRET}\n`)]), isStdinTty: () => false });
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  assert.deepEqual(lastCall(transport).body, {
    name: "Ops Tableau", kind: "tableau", secret: SECRET, config: { url: "https://tableau.example.com", client_id: CLIENT, secret_id: SECRET_ID, username: "wall" },
  });
  assert.ok(!piped.stdout.includes(SECRET));
  assert.match(piped.stdout, /^kind: tableau$/m);
  assert.match(piped.stdout, /^site: \(default site\)$/m);
  assert.match(piped.stdout, /^user: wall$/m);
  assert.match(piped.stdout, new RegExp(`Add ${ORIGIN.replaceAll(".", "\\.")} to the connected app's domain allowlist in Tableau\\.`));
  assert.match(piped.stdout, /Next: screenrig bi connection test bic_/);

  const before = biCalls(transport).length;
  const full = ["--url", "https://10ay.online.tableau.com", "--client-id", CLIENT, "--secret-id", SECRET_ID, "--username", "u", "--secret-file", "secret.txt"];
  const without = (flag: string) => full.flatMap((value, index) => (value === flag || full[index - 1] === flag ? [] : [value]));
  for (const [args, pattern] of [
    [without("--url"), /--url/], [without("--client-id"), /--client-id/], [without("--secret-id"), /--secret-id/],
    [without("--username"), /--username/], [without("--secret-file"), /--secret-file/],
    [["--url", "http://tableau.example.com", ...without("--url")], /--url takes the https address/],
    [[...without("--secret-file"), "--secret", SECRET], /unknown option|requires --secret-file|--secret-file/],
    [[...without("--secret-file"), "--secret-file", "missing.txt"], /does not exist/],
    [["--site", "a b", ...full], /--site takes/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "connection", "create", "tableau", ...args], transport, env);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, args.join(" "));
    assert.ok(!refused.stdout.includes(SECRET) && !refused.stderr.includes(SECRET));
  }
  await writeFile(path.join(env.cwd, "two.txt"), "two words\n");
  const spaced = await cli(["--json", "bi", "connection", "create", "tableau", ...without("--secret-file"), "--secret-file", "two.txt"], transport, env);
  assert.equal(spaced.code, 2);
  assert.match(spaced.envelope.error?.detail ?? "", /must hold only the secret value/);
  assert.equal(biCalls(transport).length, before, "refused commands send nothing");
});

test("connection update sets the site, the app's secret id, the user and a new secret value", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "new-secret.txt"), `${SECRET}\n`);
  const transport = backend();
  const result = await cli(["--json", "bi", "connection", "update", CONN, "--username", "wall@example.com", "--secret-id", SECRET_ID, "--client-id", CLIENT, "--site", "plaza",
    "--secret-file", "new-secret.txt", "--expect-rev", "1"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { config: { client_id: CLIENT, site: "plaza", secret_id: SECRET_ID, username: "wall@example.com" }, secret: SECRET });
  assert.ok(!result.stdout.includes(SECRET));

  // --default-site is Tableau Server's default site: an empty site.
  const empty = await cli(["--json", "bi", "connection", "update", CONN, "--default-site"], transport, env);
  assert.equal(empty.code, 0, empty.stdout + empty.stderr);
  assert.deepEqual(lastCall(transport).body, { config: { site: "" } });
  const none = await cli(["--json", "bi", "connection", "update", CONN], transport, env);
  assert.equal(none.code, 2);
  assert.match(none.envelope.error?.detail ?? none.stderr, /--site, --default-site, --secret-id, --username/);
  const both = await cli(["--json", "bi", "connection", "update", CONN, "--site", "lobby", "--default-site"], transport, env);
  assert.equal(both.code, 2);
  assert.match(both.envelope.error?.detail ?? both.stderr, /cannot be used with/);
});

test("connection browse lists the views the user can see and follows the pages", async () => {
  const env = await enrolled();
  const transport = backend();
  const human = await cli(["--human", "bi", "connection", "browse", CONN, "--query", "sales"], transport, env);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Views \(3\)/);
  assert.match(human.stdout, /Sales\/Overview\s+Overview/);
  assert.match(human.stdout, /Support_Queue\/Board\s+Board/);
  assert.match(human.stdout, new RegExp(`Next: screenrig bi view create --connection-id ${CONN} --view WORKBOOK/VIEW`));
  const calls = biCalls(transport).filter((call) => call.path.endsWith("/browse"));
  assert.deepEqual(calls.map((call) => call.query), [{ query: "sales" }, { query: "sales", cursor: "2" }]);
  const data = await cli(["--json", "bi", "connection", "browse", CONN], transport, env);
  assert.deepEqual(data.envelope.data.items.map((item: { path: string }) => item.path), ["Sales/Overview", "Sales/Detail", "Support_Queue/Board"]);
});

test("view create builds a Tableau target from an address, a path or a public link", async () => {
  const env = await enrolled();
  const transport = backend();
  const address = "https://10ay.online.tableau.com/#/site/lobby/views/Sales/Overview?:iid=1";
  const byUrl = await cli(["--human", "bi", "view", "create", "--connection-id", CONN, "--url", address, "--refresh", "5m"], transport, env);
  assert.equal(byUrl.code, 0, byUrl.stdout + byUrl.stderr);
  assert.deepEqual(lastCall(transport).body, { connection_id: CONN, name: "Tableau Sales/Overview", url: address, refresh_s: 300 });
  assert.match(byUrl.stdout, /^Put this URL in an iframe primitive \(content_fit fill\)\.$/m);
  assert.match(byUrl.stdout, /^shows: view Sales\/Overview$/m);
  assert.doesNotMatch(byUrl.stdout, /^fit:/m);

  const rotating = await cli(["--json", "bi", "view", "create", "--connection-id", CONN, "--view", "Sales/Overview", "--rotate-sheets", "--rotate", "30s", "--refresh", "0", "--name", "Sales sheets"], transport, env);
  assert.equal(rotating.code, 0, rotating.stdout + rotating.stderr);
  assert.deepEqual(lastCall(transport).body, { connection_id: CONN, name: "Sales sheets", refresh_s: 0, rotate_s: 30, target: { view: "Sales/Overview", rotate_sheets: true } });

  // An address beside --rotate-sheets: the address names the view, the target only turns its sheets.
  const both = await cli(["--json", "bi", "view", "create", "--connection-id", CONN, "--url", "Sales/Detail", "--rotate-sheets", "--rotate", "1m"], transport, env);
  assert.equal(both.code, 0, both.stdout + both.stderr);
  assert.deepEqual(lastCall(transport).body, { connection_id: CONN, name: "Tableau Sales/Detail", url: "Sales/Detail", rotate_s: 60, target: { rotate_sheets: true } });

  const link = "https://public.tableau.com/app/profile/someone/viz/RegionalSampleWorkbook/Storms";
  const published = await cli(["--json", "bi", "view", "create", "--public-url", link, "--rotate-sheets", "--rotate", "20s"], transport, env);
  assert.equal(published.code, 0, published.stdout + published.stderr);
  assert.deepEqual(lastCall(transport).body, { kind: "tableau", name: "Tableau Public RegionalSampleWorkbook/Storms", rotate_s: 20, target: { public_url: link, rotate_sheets: true } });
  const plain = await cli(["--json", "bi", "view", "create", "--public-url", link, "--name", "Storms"], transport, env);
  assert.deepEqual(lastCall(transport).body, { kind: "tableau", name: "Storms", target: { public_url: link } });
  assert.equal(plain.code, 0);

  const calls = biCalls(transport).length;
  for (const [args, pattern] of [
    [["--connection-id", CONN, "--view", "Sales"], /--view takes/],
    [["--connection-id", CONN, "--url", address, "--view", "Sales/Overview"], /cannot be used with/],
    [["--connection-id", CONN, "--dashboard", "abc", "--view", "Sales/Overview"], /cannot be used with/],
    [["--connection-id", CONN, "--workspace", "f089354e-8366-4e18-aea3-4cb4a3a50b48", "--view", "Sales/Overview"], /cannot be used with/],
    [["--public-url", link, "--view", "Sales/Overview"], /cannot be used with/],
    [["--public-url", link, "--connection-id", CONN], /cannot be used with/],
    [["--connection-id", CONN, "--view", "Sales/Overview", "--rotate", "5s"], /--rotate takes/],
    [["--connection-id", CONN], /Provide exactly one of/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "view", "create", ...args], transport, env);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, args.join(" "));
  }
  assert.equal(biCalls(transport).length, calls, "refused commands send nothing");
});

test("view update replaces the view, turns the sheets and stops turning them", async () => {
  const env = await enrolled();
  const moved = backend();
  const next = await cli(["--json", "bi", "view", "update", VIEW, "--view", "Sales/Detail"], moved, env);
  assert.equal(next.code, 0, next.stdout + next.stderr);
  assert.deepEqual(lastCall(moved).body, { target: { view: "Sales/Detail" } });

  const turning = await cli(["--json", "bi", "view", "update", VIEW, "--rotate-sheets", "--rotate", "45s"], backend(), env);
  assert.equal(turning.code, 0, turning.stdout + turning.stderr);
  const transport = backend();
  await cli(["--json", "bi", "view", "update", VIEW, "--rotate-sheets", "--rotate", "45s"], transport, env);
  assert.deepEqual(lastCall(transport).body, { rotate_s: 45, target: { view: "Sales/Overview", rotate_sheets: true } });

  // --rotate 0 alone drops rotate_sheets from the current target.
  const rotating = backend({ target: { view: "Sales/Overview", rotate_sheets: true }, rotate_s: 45 });
  const stop = await cli(["--json", "bi", "view", "update", VIEW, "--rotate", "0"], rotating, env);
  assert.equal(stop.code, 0, stop.stdout + stop.stderr);
  assert.deepEqual(lastCall(rotating).body, { rotate_s: 0, target: { view: "Sales/Overview" } });
  // A new view keeps turning the sheets.
  const keep = await cli(["--json", "bi", "view", "update", VIEW, "--view", "Sales/Detail"], backend({ target: { view: "Sales/Overview", rotate_sheets: true }, rotate_s: 45 }), env);
  assert.equal(keep.code, 0);
  const kept = backend({ target: { view: "Sales/Overview", rotate_sheets: true }, rotate_s: 45 });
  await cli(["--json", "bi", "view", "update", VIEW, "--view", "Sales/Detail"], kept, env);
  assert.deepEqual(lastCall(kept).body, { target: { view: "Sales/Detail", rotate_sheets: true } });

  // An address beside --rotate-sheets.
  const byUrl = backend();
  await cli(["--json", "bi", "view", "update", VIEW, "--url", "Sales/Detail", "--rotate-sheets", "--rotate", "30s"], byUrl, env);
  assert.deepEqual(lastCall(byUrl).body, { rotate_s: 30, url: "Sales/Detail", target: { rotate_sheets: true } });

  // A public link takes --public-url or --rotate-sheets, not --view.
  const link = "https://public.tableau.com/views/RegionalSampleWorkbook/Storms";
  const publicView = backend({ target: { public_url: link } });
  const spin = await cli(["--json", "bi", "view", "update", VIEW, "--rotate-sheets", "--rotate", "20s"], publicView, env);
  assert.equal(spin.code, 0, spin.stdout + spin.stderr);
  assert.deepEqual(lastCall(publicView).body, { rotate_s: 20, target: { public_url: link, rotate_sheets: true } });
  const refused = await cli(["--json", "bi", "view", "update", VIEW, "--view", "Sales/Overview"], backend({ target: { public_url: link } }), env);
  assert.equal(refused.code, 2);
  assert.match(refused.envelope.error?.detail ?? "", /public link/);
  const none = await cli(["--json", "bi", "view", "update", VIEW], backend(), env);
  assert.equal(none.code, 2);
  assert.match(none.envelope.error?.detail ?? none.stderr, /--view, --page, --all-pages, --rotate-sheets/);
});

test("the human lines show a Tableau connection and view, and never a secret", () => {
  const lines = connectionLines(connection({ last_test: { at: "2026-10-28T16:30:00Z", ok: true, checks: [{ name: "signin", ok: true, detail: "Tableau accepted the connected app and signed in as screens@example.com." }] } }));
  for (const expected of ["kind: tableau", "url: https://10ay.online.tableau.com", "site: lobby", `app (client id): ${CLIENT}`, `secret id: ${SECRET_ID}`, "user: screens@example.com", `embed origin: ${ORIGIN}`]) {
    assert.ok(lines.includes(expected), expected);
  }
  assert.ok(lines.some((line) => /ok signin: Tableau accepted the connected app/.test(line)));
  assert.ok(!lines.some((line) => line.startsWith("org:") || line.startsWith("tenant:")));
  assert.ok(!lines.join("\n").includes(SECRET));
  assert.ok(connectionLines(connection({ config: { url: "https://tableau.example.com", client_id: CLIENT, secret_id: SECRET_ID, username: "wall" } })).includes("site: (default site)"));
  assert.match(connectionTableLines([connection()]).join("\n"), new RegExp(`${CONN}\\s+tableau\\s+Tableau\\s+https://10ay\\.online\\.tableau\\.com`));

  assert.ok(viewLines(view()).includes("shows: view Sales/Overview"));
  assert.ok(viewLines(view({ target: { view: "Sales/Overview", rotate_sheets: true }, rotate_s: 30 })).includes("shows: view Sales/Overview, every sheet each 30s"));
  assert.ok(viewLines(view({ refresh_s: 0 })).includes("refresh: never"));
  assert.ok(!viewLines(view()).some((line) => line.startsWith("fit:")));
  const publicLines = viewLines(view({ connection_id: undefined, target: { public_url: "https://public.tableau.com/views/W/S" } }));
  assert.ok(publicLines.includes("shows: Tableau Public https://public.tableau.com/views/W/S") && publicLines.includes("connection: (public link)"));
  assert.match(viewTableLines([view({ refresh_s: 0 })]).join("\n"), /view Sales\/Overview.*never/);
});

test("the Tableau help names the connected app, the allowlist, the cookies and the secret rule", () => {
  const create = commandHelp(["bi", "connection", "create", "tableau"]);
  const notes = create.notes.join("\n");
  assert.match(notes, /never an argument/);
  assert.match(notes, /Connected Apps/);
  assert.match(notes, /domain allowlist/);
  assert.match(notes, /embed_origin/);
  assert.match(notes, /secret VALUE, not the secret ID/);
  assert.match(notes, /third-party cookies/);
  assert.match(notes, /2023\.3/);
  assert.match(notes, /sees only|only the views screens show/);
  for (const name of ["--url", "--site", "--client-id", "--secret-id", "--username", "--secret-file"]) assert.ok(create.options.some((option) => option.name === name), name);
  assert.doesNotMatch(JSON.stringify(create), /localhost|prj_|screenrig\.ai\/internal/);
  const viewCreate = commandHelp(["bi", "view", "create"]);
  assert.match(viewCreate.notes.join("\n"), /Embedding API/);
  assert.match(viewCreate.notes.join("\n"), /Tableau Public/);
  assert.ok(viewCreate.options.some((option) => option.name === "--view") && viewCreate.options.some((option) => option.name === "--rotate-sheets"));
  assert.match(commandHelp(["bi", "view", "test"]).notes.join("\n"), /looks the view up/);
  assert.match(commandHelp(["bi", "connection", "browse"]).notes.join("\n"), /Workbook\/View/);
});
