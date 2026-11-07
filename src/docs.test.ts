import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run } from "./main.js";
import type { CliRuntime } from "./runtime.js";
import { testTemp } from "./test-temp.js";

const PAGE = "https://screenrig.ai/docs/cli";
const SEARCH = {
  results: [
    { url: `${PAGE}#schedule-set`, title: "CLI command reference", section: "schedule set", snippet: "Sets the playlist schedule\nof a screen from a schedule file.   Each entry names a playlist…", score: 14.2 },
    { url: "https://screenrig.ai/docs/schedules", title: "Schedules", section: "", snippet: "", score: 9.5 },
  ],
  corpus_commit: "3f2a9c1",
};
const WHOLE_PAGE = { url: PAGE, title: "CLI command reference", markdown: "# CLI command reference\n\nIntroduction only.\n", truncated: true, sections: ["schedule set", "schedule import"], corpus_commit: "3f2a9c1" };
const ONE_SECTION = { url: `${PAGE}#schedule-set`, title: "CLI command reference", markdown: "### `schedule set`\n\nSets the playlist schedule of a screen.\n", truncated: false, sections: ["Windows"], corpus_commit: "3f2a9c1" };
const NOT_FOUND = { type: "https://screenrig.ai/problems/not-found", title: "Not found", status: 404, code: "not_found", detail: "No documentation page matches that address.", request_id: "req_DOCSNOTFOUND000001" };

interface Seen { path: string; query: Record<string, string>; headers: IncomingHttpHeaders }

/** A stub API on loopback that records every request and answers the two public docs routes. */
async function stubApi(t: TestContext): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });
    const send = (status: number, body: unknown, type = "application/json") => { res.writeHead(status, { "content-type": type }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/docs/search") return send(200, url.searchParams.get("q") === "nothing" ? { results: [], corpus_commit: "3f2a9c1" } : SEARCH);
    if (url.pathname === "/api/docs/page") {
      if (url.searchParams.get("url") === "https://screenrig.ai/docs/missing") return send(404, NOT_FOUND, "application/problem+json");
      if (url.searchParams.has("section")) return send(200, ONE_SECTION);
      // A fragment names the section; the page that answers keeps it in its address.
      return send(200, { ...WHOLE_PAGE, url: url.searchParams.get("url") });
    }
    return send(404, { ...NOT_FOUND, detail: "No such route." }, "application/problem+json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

async function configDir(): Promise<{ dir: string; fs: ConfigFs }> {
  const dir = await testTemp("docs-cfg-");
  return { dir, fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, settings: { XDG_CONFIG_HOME: dir } } };
}

/** Runs the CLI in process over the real HTTP transport. */
async function cli(argv: string[], fs: ConfigFs): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on("data", (chunk) => out.push(Buffer.from(chunk)));
  stderr.on("data", (chunk) => err.push(Buffer.from(chunk)));
  const runtime: CliRuntime = { argv, settings: fs.settings, stdout, stderr, now: () => new Date("2026-11-07T12:00:00Z"), sleep: async () => undefined, homedir: fs.homedir, cwd: () => process.cwd(), fs };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

test("docs search sends the words and limit to the public route and lists title — section, address and snippet", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const result = await cli(["--human", "--api-url", api.origin, "docs", "search", "playlist", "schedule", "--limit", "2"], fs);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.seen.length, 1);
  assert.equal(api.seen[0]!.path, "/api/docs/search");
  assert.deepEqual(api.seen[0]!.query, { q: "playlist schedule", limit: "2" });
  assert.equal(result.stdout, [
    "CLI command reference — schedule set",
    `${PAGE}#schedule-set`,
    "Sets the playlist schedule of a screen from a schedule file. Each entry names a playlist…",
    "",
    "Schedules",
    "https://screenrig.ai/docs/schedules",
    "",
  ].join("\n"));
  const none = await cli(["--human", "--api-url", api.origin, "docs", "search", "nothing"], fs);
  assert.equal(none.code, 0, none.stderr);
  assert.equal(none.stdout, 'No documentation matches "nothing".\n');
  assert.equal(api.seen[1]!.query.limit, undefined);
});

test("docs search --json prints the response in the envelope, and JSON is the default", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  for (const flags of [["--json"], []]) {
    const result = await cli([...flags, "--api-url", api.origin, "docs", "search", "schedule"], fs);
    assert.equal(result.code, 0, result.stderr);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data: unknown; context?: unknown };
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data, SEARCH);
    assert.equal(envelope.context, undefined);
  }
});

test("docs show prints the Markdown, the truncated line and the sections to read next", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const result = await cli(["--human", "--api-url", api.origin, "docs", "show", PAGE], fs);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(api.seen[0]!.path, "/api/docs/page");
  assert.deepEqual(api.seen[0]!.query, { url: PAGE });
  assert.equal(result.stdout, [
    "# CLI command reference",
    "",
    "Introduction only.",
    "",
    `Truncated. Read a section with: screenrig docs show ${PAGE} --section NAME`,
    "",
    "Sections to read next:",
    "- schedule set",
    "- schedule import",
    "",
  ].join("\n"));
});

test("docs show --section reads one section and lists only its own sub-headings", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const result = await cli(["--human", "--api-url", api.origin, "docs", "show", PAGE, "--section", "schedule set"], fs);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(api.seen[0]!.query, { url: PAGE, section: "schedule set" });
  assert.equal(result.stdout, ["### `schedule set`", "", "Sets the playlist schedule of a screen.", "", "Sections to read next:", "- Windows", ""].join("\n"));
  assert.doesNotMatch(result.stdout, /Truncated/);
});

test("a truncated address with a fragment is quoted so the printed command runs as written", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const result = await cli(["--human", "--api-url", api.origin, "docs", "show", `${PAGE}#schedule-set`], fs);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(api.seen[0]!.query, { url: `${PAGE}#schedule-set` });
  assert.match(result.stdout, /^Truncated\. Read a section with: screenrig docs show 'https:\/\/screenrig\.ai\/docs\/cli#schedule-set' --section NAME$/m);
});

test("docs show --json prints the page response in the envelope", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const result = await cli(["--json", "--api-url", api.origin, "docs", "show", PAGE], fs);
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: unknown };
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data, WHOLE_PAGE);
  const section = await cli(["--json", "--api-url", api.origin, "docs", "show", PAGE, "--section", "schedule set"], fs);
  assert.deepEqual((JSON.parse(section.stdout) as { data: unknown }).data, ONE_SECTION);
});

test("the docs commands work before sign-in without a project and send no Authorization header", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  assert.equal((await cli(["--api-url", api.origin, "docs", "search", "schedule"], fs)).code, 0);
  assert.equal((await cli(["--api-url", api.origin, "docs", "show", PAGE], fs)).code, 0);
  assert.equal(api.seen.length, 2);
  for (const request of api.seen) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.query.project, undefined);
  }
});

test("a signed-in installation still sends no credential, uses its configured origin and prints no project context", async (t) => {
  const api = await stubApi(t);
  const { dir, fs } = await configDir();
  const token = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
  await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), {
    api_url: api.origin, token, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
  }, fs);
  const human = await cli(["--human", "docs", "search", "schedule"], fs);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^CLI command reference — schedule set\n/);
  assert.doesNotMatch(human.stdout, /organization:|project:/);
  const json = await cli(["docs", "show", PAGE], fs);
  assert.equal(json.code, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as { context?: unknown }).context, undefined);
  assert.equal(api.seen.length, 2);
  for (const request of api.seen) {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.query.project, undefined);
  }
  assert.equal((human.stdout + json.stdout + human.stderr + json.stderr).includes(token), false);
});

test("a 404 problem reaches the standard error output and exit code", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const missing = "https://screenrig.ai/docs/missing";
  const json = await cli(["--json", "--api-url", api.origin, "docs", "show", missing], fs);
  assert.equal(json.code, ExitCode.NotFound);
  const envelope = JSON.parse(json.stdout) as { ok: boolean; error: { code: string; status: number; detail: string; request_id?: string } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "not_found");
  assert.equal(envelope.error.status, 404);
  assert.equal(envelope.error.detail, NOT_FOUND.detail);
  assert.equal(envelope.error.request_id, NOT_FOUND.request_id);
  const human = await cli(["--human", "--api-url", api.origin, "docs", "show", missing], fs);
  assert.equal(human.code, ExitCode.NotFound);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /^Not found \(not_found\/404\)\nNo documentation page matches that address\./);
});

test("docs search rejects a limit that is not a positive whole number before any request", async (t) => {
  const api = await stubApi(t);
  const { fs } = await configDir();
  const result = await cli(["--api-url", api.origin, "docs", "search", "schedule", "--limit", "many"], fs);
  assert.equal(result.code, ExitCode.Usage);
  assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, "usage_error");
  assert.equal(api.seen.length, 0);
});
