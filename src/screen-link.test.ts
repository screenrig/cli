import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import { redactText } from "./redact.js";
import { screenLinkLines, screenLinkSummaryLines, screenLinkUrlProblem } from "./screen-link-format.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const SCREEN = "scr_LOBBYAAAAAAAAAAAA";
const SECRET = "srsl_" + "A".repeat(39) + "AbCd";
const URL_OF = `https://play.screenrig.ai/player/#screen=${SECRET}`;
const NEW_SECRET = "srsl_" + "B".repeat(39) + "WxYz";
const NEW_URL = `https://play.screenrig.ai/player/#screen=${NEW_SECRET}`;

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string } };
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
  const configDir = await testTemp("screen-link-cfg-");
  const cwd = await testTemp("screen-link-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, logger?: ReturnType<typeof createMemoryLogger>["logger"]): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => new Date("2026-10-28T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
    ...(logger ? { logger } : {}),
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

const link = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  url: URL_OF, hint: "AbCd", created_at: "2026-10-27T08:00:00Z", ...overrides,
});
const problem = (status: number, code: string, detail: string) => ({ status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: code, detail } });

test("screen link create sends the write, prints the url under a sensitive label and keeps it out of the log", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", `/api/screens/${SCREEN}/link`, () => ({ status: 200, headers: {}, body: link({ replaced: false }) }));
  const { logger, events } = createMemoryLogger({ command: ["screen", "link", "create"] });
  const created = await cli(["--json", "screen", "link", "create", SCREEN, "--expect-rev", "4"], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = transport.calls.at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/screens/${SCREEN}/link`);
  assert.equal(call.headers?.["if-match"], '"4"');
  assert.ok(call.headers?.["idempotency-key"], "create sends an Idempotency-Key");
  assert.equal(created.envelope.data.url, URL_OF);
  assert.equal(created.envelope.data.replaced, false);
  assert.equal(created.envelope.data.screen_id, SCREEN);
  assert.deepEqual(created.envelope.warnings ?? [], []);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /srsl_/);
  assert.doesNotMatch(JSON.stringify(events), /srsl_AAAA|#screen=/, "the operation log never holds the link");
  const human = await cli(["--human", "screen", "link", "create", SCREEN], transport, env);
  assert.match(human.stdout, /^Created the link of screen scr_LOBBYAAAAAAAAAAAA\./m);
  assert.match(human.stdout, new RegExp(`^Sensitive screen link URL .*open it in one place\\)\\nurl: ${URL_OF.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
});

test("screen link create says when it replaced a link", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", `/api/screens/${SCREEN}/link`, () => ({ status: 200, headers: {}, body: link({ url: NEW_URL, hint: "WxYz", replaced: true }) }));
  const replaced = await cli(["--human", "screen", "link", "create", SCREEN], transport, env);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.match(replaced.stdout, /^Replaced the link of screen scr_LOBBYAAAAAAAAAAAA\. The old URL stopped working at once/m);
  assert.match(replaced.stdout, /^hint: WxYz$/m);
});

test("screen link show prints the url, and a Read only credential gets it withheld", async () => {
  const env = await enrolled();
  const shown = await cli(["--json", "screen", "link", "show", SCREEN], new FakeTransport().on("GET", `/api/screens/${SCREEN}/link`, () => ({ status: 200, headers: {}, body: link({ last_used_at: "2026-10-28T16:00:00Z" }) })), env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(shown.envelope.data.url, URL_OF);
  assert.equal(shown.envelope.data.last_used_at, "2026-10-28T16:00:00Z");
  const redacted = await cli(["--human", "screen", "link", "show", SCREEN], new FakeTransport().on("GET", `/api/screens/${SCREEN}/link`, () => ({ status: 200, headers: {}, body: link({ url: "", url_redacted: true }) })), env);
  assert.equal(redacted.code, 0, redacted.stdout);
  assert.match(redacted.stdout, /^URL: withheld from a Read only credential\./m);
  assert.doesNotMatch(redacted.stdout, /^url:/m);
  const absent = await cli(["--human", "screen", "link", "show", SCREEN], new FakeTransport().on("GET", `/api/screens/${SCREEN}/link`, () => ({ status: 200, headers: {}, body: link({ url: undefined }) })), env);
  assert.match(absent.stdout, /^URL: not returned\.$/m);
});

test("screen link show on a screen without a link names the command that creates one", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("GET", `/api/screens/${SCREEN}/link`, () => problem(404, "screen_link_not_found", "This screen has no link."));
  const missing = await cli(["--json", "screen", "link", "show", SCREEN], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
  assert.equal(missing.envelope.error!.code, "screen_link_not_found");
  assert.equal(missing.envelope.error!.next!.command, `screenrig screen link create ${SCREEN}`);
});

test("screen link create explains a screen that has not paired and one that is archived", async () => {
  const env = await enrolled();
  const pending = await cli(["--json", "screen", "link", "create", SCREEN], new FakeTransport().on("POST", `/api/screens/${SCREEN}/link`, () => problem(409, "resource_conflict", "The screen has no paired Player yet. Pair it once with its code, then create its link.")), env);
  assert.equal(pending.code, ExitCode.Conflict);
  assert.equal(pending.envelope.error!.next!.command, "screenrig screen pair CODE");
  const archived = await cli(["--json", "screen", "link", "create", SCREEN], new FakeTransport().on("POST", `/api/screens/${SCREEN}/link`, () => problem(409, "screen_archived", "The screen is archived.")), env);
  assert.equal(archived.envelope.error!.next!.command, `screenrig screen unarchive ${SCREEN}`);
  const stale = await cli(["--json", "screen", "link", "create", SCREEN, "--expect-rev", "2"], new FakeTransport().on("POST", `/api/screens/${SCREEN}/link`, () => problem(412, "revision_conflict", "The screen changed.")), env);
  assert.equal(stale.code, ExitCode.Precondition);
  assert.equal(stale.envelope.error!.next!.command, `screenrig screen show ${SCREEN}`);
});

test("screen link delete turns the link off, also when there was none", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("DELETE", `/api/screens/${SCREEN}/link`, () => ({ status: 204, headers: {}, body: undefined }));
  const deleted = await cli(["--json", "screen", "link", "delete", SCREEN], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  assert.deepEqual(deleted.envelope.data, { screen_id: SCREEN, deleted: true });
  const call = transport.calls.at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.ok(call.headers?.["idempotency-key"]);
  const human = await cli(["--human", "screen", "link", "delete", SCREEN], transport, env);
  assert.match(human.stdout, /^Turned off the link of screen scr_LOBBYAAAAAAAAAAAA\./m);
});

test("screen link refuses a missing or malformed screen id before any request", async () => {
  const env = await enrolled();
  const transport = new FakeTransport();
  const none = await cli(["--json", "screen", "link", "show"], transport, env);
  assert.equal(none.code, ExitCode.Usage);
  const bad = await cli(["--json", "screen", "link", "show", "/api/project"], transport, env);
  assert.equal(bad.code, ExitCode.Usage);
  assert.equal(bad.envelope.error!.next!.command, "screenrig screen list");
  assert.equal(transport.calls.length, 0);
});

test("an unsafe url is withheld with a warning, never printed", async () => {
  const env = await enrolled();
  for (const unsafe of ["http://play.screenrig.ai/player/#screen=" + SECRET, `https://play.screenrig.ai/player/?x=1#screen=${SECRET}`, `https://play.screenrig.ai/other/#screen=${SECRET}`, `https://play.screenrig.ai/player/#fleet=srfl_${"A".repeat(43)}`, "https://play.screenrig.ai/player/#screen=srsl_short"]) {
    const shown = await cli(["--json", "screen", "link", "show", SCREEN], new FakeTransport().on("GET", `/api/screens/${SCREEN}/link`, () => ({ status: 200, headers: {}, body: link({ url: unsafe }) })), env);
    assert.equal(shown.code, 0, shown.stdout);
    assert.equal(shown.envelope.data.url, undefined, unsafe);
    assert.deepEqual(shown.envelope.warnings?.map((warning) => warning.code), ["screen_link_url_withheld"]);
    assert.ok(!shown.stdout.includes("srsl_"), "the unsafe url is not printed");
  }
  assert.equal(screenLinkUrlProblem(URL_OF), undefined);
});

test("screen show names the link by its last four characters and never its url", () => {
  assert.deepEqual(screenLinkSummaryLines({ hint: "AbCd", created_at: "2026-10-27T08:00:00Z", last_used_at: "2026-10-28T16:00:00Z" }), ["Screen link: on (…AbCd), last opened 2026-10-28T16:00:00Z"]);
  assert.deepEqual(screenLinkSummaryLines({ hint: "AbCd", created_at: "2026-10-27T08:00:00Z" }), ["Screen link: on (…AbCd), last opened never"]);
  assert.deepEqual(screenLinkSummaryLines(undefined), []);
  assert.ok(screenLinkLines(SCREEN, { url: URL_OF, hint: "AbCd", created_at: "2026-10-27T08:00:00Z" }).every((line) => !line.includes("srsl_")));
});

test("a screen link secret is redacted wherever text is logged", () => {
  assert.equal(redactText(`opened ${URL_OF} and ${SECRET}`), "opened https://play.screenrig.ai/player/#screen=*** and srsl_***");
});
