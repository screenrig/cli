import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import {
  biClientId, biPage, biRefreshSeconds, biReportId, biRotateSeconds, biTenantId, biWorkspaceId, connectionLines, connectionTableLines, publicLinkKind,
  viewLines, viewTableLines, type BiConnection, type BiView,
} from "./bi.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help-tree.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-10-28T17:00:00.000Z");
// A client secret built in code, so no literal here looks like a credential.
const SECRET = `Sn7~${"q".repeat(30)}-x9`;
const TENANT = "11111111-2222-4333-8444-555555555555";
const APP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WORKSPACE = "f089354e-8366-4e18-aea3-4cb4a3a50b48";
const REPORT = "5b218778-e7a5-4d73-8187-f10824047715";
const CONN = "bic_POWERBICONNECTIONAA";
const VIEW = "biv_POWERBIVIEWAAAAAAAAA";

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
  const configDir = await testTemp("bipbi-cfg-");
  const cwd = await testTemp("bipbi-cwd-");
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
    id: CONN, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "powerbi", name: "Power BI", config: { tenant_id: TENANT, client_id: APP },
    embed_origin: "https://bi-0123456789abcdef0123.apps.screenrig.ai", secret: { set: true, hint: "x9" }, last_test: null, revision: 1,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

function view(overrides: Partial<BiView> = {}): BiView {
  return {
    id: VIEW, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", connection_id: CONN, kind: "powerbi", name: "Sales",
    target: { workspace_id: WORKSPACE, report_id: REPORT, pages: ["Overview", "Detail"] }, refresh_s: 300, rotate_s: 30, fit: "contain", revision: 1,
    status: { last_ok_at: null, last_error: null }, embed_url: `https://bi-0123456789abcdef0123.apps.screenrig.ai/v/${VIEW}`,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

function backend(): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  transport
    .on("POST", "/api/bi-connections", (req) => {
      const body = req.body as { name: string; kind: string; config: { tenant_id: string; client_id: string } };
      return json(201, connection({ name: body.name, config: body.config }));
    })
    .on("PATCH", `/api/bi-connections/${CONN}`, () => json(200, connection({ revision: 2 })))
    .on("GET", `/api/bi-connections/${CONN}/browse`, (req) => req.query?.workspace
      ? json(200, { workspace: { id: String(req.query.workspace) }, items: [{ id: REPORT, name: "Sales", embed_url: "https://app.powerbi.com/reportEmbed?reportId=1" }, { id: "7a1e55c8-0d2f-4f0b-9a38-3c4a2f1c6d10", name: "Support queue" }], next_cursor: null })
      : json(200, { items: [{ id: WORKSPACE, name: "Lobby screens" }], next_cursor: null }))
    .on("POST", "/api/bi-views", (req) => json(201, view({ target: (req.body as { target?: BiView["target"] }).target ?? view().target })))
    .on("GET", `/api/bi-views/${VIEW}`, () => json(200, view()))
    .on("PATCH", `/api/bi-views/${VIEW}`, () => json(200, view({ revision: 2 })));
  return transport;
}

test("the Power BI parsers read ids, tenants, pages and cadences", () => {
  assert.equal(biTenantId(TENANT), TENANT);
  assert.equal(biTenantId(" Contoso.OnMicrosoft.com "), "Contoso.OnMicrosoft.com");
  for (const bad of ["common", "organizations", "consumers", "", "contoso", "a b.com", "a/b.com", "https://contoso.com"]) assert.throws(() => biTenantId(bad), /--tenant-id takes/, bad);
  assert.equal(biClientId(APP), APP);
  assert.throws(() => biClientId("my app"), /--client-id takes/);
  assert.equal(biWorkspaceId(WORKSPACE), WORKSPACE);
  assert.throws(() => biWorkspaceId("lobby"), /--workspace takes/);
  assert.equal(biReportId(REPORT), REPORT);
  assert.throws(() => biReportId(`${REPORT}x`), /--report takes/);
  assert.deepEqual(JSON.parse(biPage("Overview")), ["Overview"]);
  assert.deepEqual(JSON.parse(biPage(" Detail ", biPage("Overview"))), ["Overview", "Detail"]);
  for (const bad of ["", "  ", "x".repeat(201), "a\u0000b"]) assert.throws(() => biPage(bad), /--page takes/);
  assert.equal(biRotateSeconds("30s"), 30);
  assert.equal(biRotateSeconds("1h"), 3600);
  assert.equal(biRotateSeconds("90"), 90);
  assert.equal(biRotateSeconds("0"), 0);
  assert.equal(biRotateSeconds("off"), 0);
  for (const bad of ["9s", "61m", "soon", ""]) assert.throws(() => biRotateSeconds(bad), /--rotate takes/, bad);
  assert.equal(biRefreshSeconds("0"), 0);
  assert.equal(biRefreshSeconds("off"), 0);
  assert.equal(publicLinkKind("https://app.powerbi.com/view?r=abc"), "powerbi");
  assert.equal(publicLinkKind("https://msit.powerbi.com/view?r=abc"), "powerbi");
  assert.equal(publicLinkKind("https://grafana.example.com/public-dashboards/abc"), "grafana");
  assert.equal(publicLinkKind("https://notpowerbi.com/view?r=abc"), "grafana");
  assert.equal(publicLinkKind("not a url"), "grafana");
});

test("connection create powerbi reads the secret from a file or stdin and never prints it", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "secret.txt"), `${SECRET}\n`);
  const transport = backend();
  const result = await cli(["--json", "bi", "connection", "create", "powerbi", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "secret.txt"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(lastCall(transport).body, { name: "Power BI", kind: "powerbi", config: { tenant_id: TENANT, client_id: APP }, secret: SECRET });
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), "the output holds the secret");
  assert.equal(result.envelope.data.config.tenant_id, TENANT);

  const piped = await cli(["--human", "bi", "connection", "create", "powerbi", "--tenant-id", "contoso.onmicrosoft.com", "--client-id", APP, "--secret-file", "-", "--name", "Contoso"], backend(), env,
    { stdin: Readable.from([Buffer.from(`${SECRET}\n`)]), isStdinTty: () => false });
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  assert.ok(!piped.stdout.includes(SECRET));
  assert.match(piped.stdout, /^kind: powerbi$/m);
  assert.match(piped.stdout, /^tenant: contoso\.onmicrosoft\.com$/m);
  assert.match(piped.stdout, /^secret: set \(ends x9\)$/m);
  assert.match(piped.stdout, /Next: screenrig bi connection test bic_/);

  const before = biCalls(transport).length;
  for (const [args, pattern] of [
    [["--client-id", APP, "--secret-file", "secret.txt"], /requires --tenant-id|--tenant-id/],
    [["--tenant-id", TENANT, "--secret-file", "secret.txt"], /requires --client-id|--client-id/],
    [["--tenant-id", TENANT, "--client-id", APP], /requires --secret-file|--secret-file/],
    [["--tenant-id", "common", "--client-id", APP, "--secret-file", "secret.txt"], /--tenant-id takes/],
    [["--tenant-id", TENANT, "--client-id", "my-app", "--secret-file", "secret.txt"], /--client-id takes/],
    [["--tenant-id", TENANT, "--client-id", APP, "--secret", SECRET], /unknown option|requires --secret-file/],
    [["--tenant-id", TENANT, "--client-id", APP, "--secret-file", "missing.txt"], /does not exist/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "connection", "create", "powerbi", ...args], transport, env);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, args.join(" "));
    assert.ok(!refused.stdout.includes(SECRET) && !refused.stderr.includes(SECRET));
  }
  await writeFile(path.join(env.cwd, "two.txt"), "two words\n");
  const spaced = await cli(["--json", "bi", "connection", "create", "powerbi", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "two.txt"], transport, env);
  assert.equal(spaced.code, 2);
  assert.match(spaced.envelope.error?.detail ?? "", /must hold only the client secret/);
  assert.equal(biCalls(transport).length, before, "refused commands send nothing");
});

test("connection update takes a secret file, a tenant and an app, and one secret source", async () => {
  const env = await enrolled();
  await writeFile(path.join(env.cwd, "new-secret.txt"), `${SECRET}\n`);
  const transport = backend();
  const result = await cli(["--json", "bi", "connection", "update", CONN, "--secret-file", "new-secret.txt", "--tenant-id", "contoso.com", "--client-id", APP, "--expect-rev", "1"], transport, env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { config: { tenant_id: "contoso.com", client_id: APP }, secret: SECRET });
  assert.ok(!result.stdout.includes(SECRET));
  const both = await cli(["--json", "bi", "connection", "update", CONN, "--secret-file", "new-secret.txt", "--token-file", "new-secret.txt"], transport, env);
  assert.equal(both.code, 2);
  assert.match(both.envelope.error?.detail ?? both.stderr, /cannot be used with/);
});

test("connection browse lists workspaces, then a workspace's reports", async () => {
  const env = await enrolled();
  const transport = backend();
  const workspaces = await cli(["--human", "bi", "connection", "browse", CONN], transport, env);
  assert.equal(workspaces.code, 0, workspaces.stdout + workspaces.stderr);
  assert.match(workspaces.stdout, /Workspaces \(1\)/);
  assert.match(workspaces.stdout, new RegExp(`${WORKSPACE}\\s+Lobby screens`));
  assert.match(workspaces.stdout, /Next: screenrig bi connection browse bic_POWERBICONNECTIONAA --workspace WORKSPACE/);

  const reports = await cli(["--json", "bi", "connection", "browse", CONN, "--workspace", WORKSPACE, "--query", "sales"], transport, env);
  assert.equal(reports.code, 0, reports.stdout + reports.stderr);
  const call = lastCall(transport);
  assert.deepEqual(call.query, { query: "sales", workspace: WORKSPACE });
  assert.equal(reports.envelope.data.workspace.id, WORKSPACE);
  assert.equal(reports.envelope.data.items.length, 2);
  const human = await cli(["--human", "bi", "connection", "browse", CONN, "--workspace", WORKSPACE], transport, env);
  assert.match(human.stdout, new RegExp(`Reports in workspace ${WORKSPACE} \\(2\\)`));
  assert.match(human.stdout, new RegExp(`${REPORT}\\s+Sales`));
  assert.match(human.stdout, new RegExp(`Next: screenrig bi view create --connection-id ${CONN} --workspace ${WORKSPACE} --report REPORT`));

  const mixed = await cli(["--json", "bi", "connection", "browse", CONN, "--workspace", WORKSPACE, "--dashboard", "abc"], transport, env);
  assert.equal(mixed.code, 2);
  const bad = await cli(["--json", "bi", "connection", "browse", CONN, "--workspace", "lobby"], transport, env);
  assert.equal(bad.code, 2);
  assert.match(bad.envelope.error?.detail ?? bad.stderr, /--workspace takes/);
});

test("view create builds a Power BI target from ids, pages and a cadence", async () => {
  const env = await enrolled();
  const transport = backend();
  const rotating = await cli(["--json", "bi", "view", "create", "--connection-id", CONN, "--workspace", WORKSPACE, "--report", REPORT, "--page", "Overview", "--page", "Detail",
    "--rotate", "30s", "--refresh", "0", "--name", "Sales rotation"], transport, env);
  assert.equal(rotating.code, 0, rotating.stdout + rotating.stderr);
  assert.deepEqual(lastCall(transport).body, {
    connection_id: CONN, name: "Sales rotation", refresh_s: 0, rotate_s: 30,
    target: { workspace_id: WORKSPACE, report_id: REPORT, pages: ["Overview", "Detail"] },
  });

  const every = await cli(["--json", "bi", "view", "create", "--connection-id", CONN, "--workspace", WORKSPACE, "--report", REPORT, "--all-pages", "--rotate", "1m"], transport, env);
  assert.equal(every.code, 0, every.stdout + every.stderr);
  assert.deepEqual(lastCall(transport).body, { connection_id: CONN, name: "Power BI report", rotate_s: 60, target: { workspace_id: WORKSPACE, report_id: REPORT, rotate_all_pages: true } });

  const address = `https://app.powerbi.com/groups/${WORKSPACE}/reports/${REPORT}/ReportSection2`;
  const byUrl = await cli(["--human", "bi", "view", "create", "--connection-id", CONN, "--url", address, "--refresh", "5m"], transport, env);
  assert.equal(byUrl.code, 0, byUrl.stdout + byUrl.stderr);
  assert.deepEqual(lastCall(transport).body, { connection_id: CONN, name: "Power BI report", url: address, refresh_s: 300 });
  assert.match(byUrl.stdout, /^Put this URL in an iframe primitive \(content_fit fill\)\.$/m);
  assert.doesNotMatch(byUrl.stdout, /^fit:/m);

  const link = "https://app.powerbi.com/view?r=eyJrIjoiYWJjIn0";
  const published = await cli(["--json", "bi", "view", "create", "--public-url", link], transport, env);
  assert.equal(published.code, 0, published.stdout + published.stderr);
  assert.deepEqual(lastCall(transport).body, { kind: "powerbi", name: "Power BI public report", target: { public_url: link } });
  const grafana = await cli(["--json", "bi", "view", "create", "--public-url", "https://g.example.com/public-dashboards/x"], transport, env);
  assert.deepEqual(lastCall(transport).body, { kind: "grafana", name: "Grafana public dashboard", target: { public_url: "https://g.example.com/public-dashboards/x" } });
  assert.equal(grafana.code, 0);

  const calls = biCalls(transport).length;
  for (const [args, pattern] of [
    [["--connection-id", CONN, "--workspace", WORKSPACE], /--workspace and --report/],
    [["--connection-id", CONN, "--report", REPORT], /Provide exactly one of|--workspace and --report/],
    [["--connection-id", CONN, "--url", address, "--page", "Overview"], /the target comes from the address/],
    [["--connection-id", CONN, "--url", address, "--workspace", WORKSPACE, "--report", REPORT], /cannot be used with/],
    [["--connection-id", CONN, "--dashboard", "abc", "--workspace", WORKSPACE, "--report", REPORT], /cannot be used with/],
    [["--public-url", link, "--page", "Overview"], /needs no connection/],
    [["--connection-id", CONN, "--workspace", "lobby", "--report", REPORT], /--workspace takes/],
    [["--connection-id", CONN, "--workspace", WORKSPACE, "--report", REPORT, "--rotate", "5s"], /--rotate takes/],
    [["--connection-id", CONN, "--workspace", WORKSPACE, "--report", REPORT, "--page"], /argument missing|requires a value/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "view", "create", ...args], transport, env);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, args.join(" "));
  }
  assert.equal(biCalls(transport).length, calls, "refused commands send nothing");
});

test("view update replaces pages, keeps the workspace for a new report and sets the cadence", async () => {
  const env = await enrolled();
  const transport = backend();
  const pages = await cli(["--json", "bi", "view", "update", VIEW, "--page", "Summary", "--page", "Detail", "--rotate", "45s"], transport, env);
  assert.equal(pages.code, 0, pages.stdout + pages.stderr);
  assert.deepEqual(lastCall(transport).body, { rotate_s: 45, target: { workspace_id: WORKSPACE, report_id: REPORT, pages: ["Summary", "Detail"] } });

  const other = "7a1e55c8-0d2f-4f0b-9a38-3c4a2f1c6d10";
  const report = await cli(["--json", "bi", "view", "update", VIEW, "--report", other, "--rotate", "0"], transport, env);
  assert.equal(report.code, 0, report.stdout + report.stderr);
  assert.deepEqual(lastCall(transport).body, { rotate_s: 0, target: { workspace_id: WORKSPACE, report_id: other } });

  const all = await cli(["--json", "bi", "view", "update", VIEW, "--all-pages", "--rotate", "20s"], transport, env);
  assert.equal(all.code, 0, all.stdout + all.stderr);
  assert.deepEqual(lastCall(transport).body, { rotate_s: 20, target: { workspace_id: WORKSPACE, report_id: REPORT, rotate_all_pages: true } });

  const cadence = await cli(["--json", "bi", "view", "update", VIEW, "--refresh", "0"], transport, env);
  assert.deepEqual(lastCall(transport).body, { refresh_s: 0 });
  assert.equal(cadence.code, 0);

  const moved = await cli(["--json", "bi", "view", "update", VIEW, "--workspace", "3c2b1a09-8f7e-4d6c-b5a4-0f1e2d3c4b5a", "--report", other], transport, env);
  assert.equal(moved.code, 0, moved.stdout + moved.stderr);
  assert.deepEqual(lastCall(transport).body, { target: { workspace_id: "3c2b1a09-8f7e-4d6c-b5a4-0f1e2d3c4b5a", report_id: other } });
});

test("the human lines show a Power BI connection and view, and never a secret", () => {
  const lines = connectionLines(connection({ last_test: { at: "2026-10-28T16:30:00Z", ok: true, checks: [{ name: "token", ok: true }, { name: "workspaces", ok: true, detail: "The app can see 1 workspace." }] } }));
  assert.ok(lines.includes(`tenant: ${TENANT}`) && lines.includes(`app (client id): ${APP}`) && lines.includes("kind: powerbi"));
  assert.ok(!lines.some((line) => line.startsWith("url:") || line.startsWith("org:")));
  assert.ok(lines.some((line) => /ok workspaces: The app can see 1 workspace\./.test(line)));
  assert.ok(!lines.join("\n").includes(SECRET));
  assert.match(connectionTableLines([connection()]).join("\n"), new RegExp(`${CONN}\\s+powerbi\\s+Power BI\\s+${TENANT}`));

  const shown = viewLines(view());
  assert.ok(shown.includes(`shows: report ${REPORT}, workspace ${WORKSPACE}, pages Overview, Detail, each 30s`));
  assert.ok(shown.includes("refresh: every 300s"));
  assert.ok(!shown.some((line) => line.startsWith("fit:")));
  assert.ok(viewLines(view({ refresh_s: 0, rotate_s: 0, target: { workspace_id: WORKSPACE, report_id: REPORT, rotate_all_pages: true } })).includes("refresh: never"));
  assert.match(viewLines(view({ connection_id: undefined, target: { public_url: "https://app.powerbi.com/view?r=abc" }, rotate_s: 0 })).join("\n"), /connection: \(public link\)/);
  assert.match(viewTableLines([view({ refresh_s: 0 })]).join("\n"), /never/);
});

test("the Power BI help names the tenant setting, the role, the capacity and the secret rule", () => {
  const create = commandHelp(["bi", "connection", "create", "powerbi"]);
  const notes = create.notes.join("\n");
  assert.match(notes, /never an argument/);
  assert.match(notes, /Service principals can call Fabric public APIs/);
  assert.match(notes, /Member or Admin/);
  assert.match(notes, /capacity/);
  assert.match(notes, /secret VALUE, not the secret ID/);
  assert.ok(create.options.some((option) => option.name === "--secret-file") && create.options.some((option) => option.name === "--tenant-id"));
  assert.doesNotMatch(JSON.stringify(create), /localhost|prj_|screenrig\.ai\/internal/);
  const viewCreate = commandHelp(["bi", "view", "create"]);
  assert.match(viewCreate.notes.join("\n"), /Publish to web/);
  assert.match(viewCreate.notes.join("\n"), /--rotate/);
  assert.ok(viewCreate.options.some((option) => option.name === "--workspace") && viewCreate.options.some((option) => option.name === "--page"));
});
