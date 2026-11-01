import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { biCssSelector, biWaitMs, biWebLoginUrl, readTotpSeed, readWebPassword, readWebSteps, webCookies, webConnectionLines } from "./bi-web.js";
import { connectionLines, connectionTableLines, viewLines, viewTableLines, type BiConnection, type BiView } from "./bi.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-11-01T17:00:00.000Z");
const CONN = "bic_WEBCONNECTIONAAAAAAA";
const VIEW = "biv_WEBVIEWAAAAAAAAAAAAA";
// Built in code, so no literal here looks like a credential.
const PASSWORD = `correct horse ${"b".repeat(8)} staple`;
const TOTP = "JBSWY3DPEHPK3PXP";
const COOKIE_VALUE = `session-${"c".repeat(24)}`;

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; hint?: string; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
}
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
  const configDir = await testTemp("biweb-cfg-");
  const cwd = await testTemp("biweb-cwd-");
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

const stdin = (text: string): Partial<CliRuntime> => ({ stdin: Readable.from([Buffer.from(text)]), isStdinTty: () => false });
const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { "content-type": "application/json" }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({ status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: detail, detail } });

function web(over: Partial<BiConnection> = {}): BiConnection {
  return {
    id: CONN, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "web", name: "Ops dashboard",
    config: { login_mode: "auto", login_url: "https://login.example.com/signin", username: "screens@example.com" },
    embed_origin: "https://bi-0123456789abcdef0123.apps.screenrig.ai", secret: { set: true, hint: "aple" }, totp_secret: { set: true, hint: "" },
    session: { state: "active", cookies: 2, cookies_updated_at: "2026-11-01T16:40:00Z", last_login_at: "2026-11-01T16:00:00Z", login_failures: 0, retry_at: null },
    last_test: null, revision: 1, created_at: "2026-11-01T16:00:00Z", updated_at: "2026-11-01T16:00:00Z", ...over,
  };
}

function view(over: Partial<BiView> = {}): BiView {
  return {
    id: VIEW, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", connection_id: CONN, kind: "web", name: "app.example.com", target: { url: "https://app.example.com/dashboards/42" },
    refresh_s: 300, fit: "contain", revision: 1, status: { last_ok_at: null, last_error: null }, embed_url: `https://bi-0123456789abcdef0123.apps.screenrig.ai/v/${VIEW}`,
    created_at: "2026-11-01T16:00:00Z", updated_at: "2026-11-01T16:00:00Z", ...over,
  };
}

function backend(): { transport: FakeTransport; calls: TransportRequest[] } {
  const transport = new FakeTransport();
  const calls: TransportRequest[] = [];
  const record = (req: TransportRequest) => { calls.push(req); };
  transport
    .on("POST", "/api/bi-connections", (req) => {
      record(req);
      const body = req.body as { name: string; kind: string; config: BiConnection["config"]; secret?: string; totp_secret?: string; cookies?: unknown[] };
      if (body.kind === "powerbi") return json(201, { ...web({ kind: "powerbi", name: body.name, config: body.config }), session: undefined, totp_secret: undefined, secret: { set: false, hint: "" } });
      return json(201, web({ name: body.name, config: body.config, secret: { set: body.secret !== undefined, hint: body.secret ? body.secret.slice(-4) : "" }, totp_secret: { set: body.totp_secret !== undefined, hint: "" },
        session: { state: body.cookies?.length ? "active" : "idle", cookies: body.cookies?.length ?? 0, cookies_updated_at: null, last_login_at: null, login_failures: 0, retry_at: null } }));
    })
    .on("PATCH", `/api/bi-connections/${CONN}`, (req) => { record(req); return json(200, web({ revision: 2 })); })
    .on("GET", `/api/bi-connections/${CONN}`, (req) => { record(req); return json(200, web()); })
    .on("GET", "/api/bi-connections", (req) => { record(req); return json(200, { items: [web(), web({ id: "bic_PBIAAAAAAAAAAAAAAAAAAA", kind: "powerbi", name: "Power BI", config: { connection_id: "pcn_CONNECTION" }, session: undefined })], next_cursor: null }); })
    .on("POST", "/api/bi-views", (req) => {
      record(req);
      const body = req.body as { name: string; url?: string; refresh_s?: number; wait_for?: string; wait_ms?: number; clip?: string };
      return json(201, view({ name: body.name, ...(body.url ? { target: { url: body.url } } : {}), ...(body.wait_for ? { wait_for: body.wait_for } : {}), ...(body.wait_ms ? { wait_ms: body.wait_ms } : {}), ...(body.clip ? { clip: body.clip } : {}) }));
    })
    .on("PATCH", `/api/bi-views/${VIEW}`, (req) => { record(req); return json(200, view({ revision: 2 })); })
    .on("GET", `/api/bi-views/${VIEW}`, (req) => { record(req); return json(200, view()); });
  return { transport, calls };
}

const lastBody = (calls: TransportRequest[]): any => calls.at(-1)!.body;

test("the web parsers read addresses, selectors, waits and the secrets of a sign-in", async () => {
  assert.equal(biWebLoginUrl(" https://login.example.com/signin "), "https://login.example.com/signin");
  for (const bad of ["http://login.example.com", "login.example.com", "https://a b.example.com", "", `https://example.com/${"x".repeat(2048)}`]) assert.throws(() => biWebLoginUrl(bad), /--login-url takes the https address/, bad);
  assert.equal(biCssSelector("--wait-for")(" #dashboard .loaded "), "#dashboard .loaded");
  for (const bad of ["", "   ", "x".repeat(513), "a\nb"]) assert.throws(() => biCssSelector("--clip")(bad), /--clip takes a CSS selector of 1 to 512 characters/, JSON.stringify(bad));
  assert.equal(biWaitMs("0"), "0");
  assert.equal(biWaitMs("10000"), "10000");
  for (const bad of ["10001", "-1", "1.5", "soon", ""]) assert.throws(() => biWaitMs(bad), /--wait-ms takes whole milliseconds from 0 to 10000/, bad);

  const env = await enrolled();
  const runtime = { cwd: () => env.cwd } as unknown as CliRuntime;
  await writeFile(path.join(env.cwd, "password.txt"), `${PASSWORD}\r\n`);
  await writeFile(path.join(env.cwd, "totp.txt"), `${TOTP}\n`);
  await writeFile(path.join(env.cwd, "empty.txt"), "\n");
  await writeFile(path.join(env.cwd, "multi.txt"), "one\ntwo");
  assert.equal(await readWebPassword("password.txt", runtime), PASSWORD, "spaces stay; the line ending goes");
  assert.equal(await readTotpSeed("totp.txt", runtime), TOTP);
  await assert.rejects(readWebPassword("empty.txt", runtime), /holds no password/);
  await assert.rejects(readWebPassword("multi.txt", runtime), /must hold only the password: one line of text/);
  await assert.rejects(readTotpSeed("empty.txt", runtime), /holds no authenticator key/);
  await assert.rejects(readWebPassword("missing.txt", runtime), /does not exist/);

  await writeFile(path.join(env.cwd, "steps.json"), JSON.stringify([{ action: "goto", url: "https://login.example.com" }, { action: "fill", selector: "#u", value: "{{username}}" }, { action: "wait_ms", ms: 500 }]));
  assert.equal((await readWebSteps("steps.json", runtime)).length, 3);
  await writeFile(path.join(env.cwd, "bad-steps.json"), JSON.stringify([{ action: "teleport" }]));
  await assert.rejects(readWebSteps("bad-steps.json", runtime), /--steps\[0\] needs an action: goto, fill, click, press, wait_for, wait_ms/);
  await writeFile(path.join(env.cwd, "no-steps.json"), "[]");
  await assert.rejects(readWebSteps("no-steps.json", runtime), /a JSON array of 1 to 30 steps/);
  await writeFile(path.join(env.cwd, "many-steps.json"), JSON.stringify(Array.from({ length: 31 }, () => ({ action: "click", selector: "a" }))));
  await assert.rejects(readWebSteps("many-steps.json", runtime), /holds 31 steps; a sign-in script has at most 30/);
  await writeFile(path.join(env.cwd, "not-json.json"), "{nope");
  await assert.rejects(readWebSteps("not-json.json", runtime), /--steps must hold valid JSON/);
});

test("a cookie jar from an extension or from Playwright is sent as the members the API takes", () => {
  const extension = [
    { domain: ".example.com", expirationDate: 1893456000.75, hostOnly: false, httpOnly: true, name: "sid", path: "/", sameSite: "no_restriction", secure: true, session: false, storeId: "0", value: COOKIE_VALUE, id: 1 },
    { domain: "app.example.com", name: "theme", value: "dark", path: "/", session: true, hostOnly: true, httpOnly: false, secure: false, sameSite: "unspecified", storeId: "0" },
  ];
  assert.deepEqual(webCookies(extension), [
    { name: "sid", value: COOKIE_VALUE, domain: ".example.com", path: "/", expires: 1893456000, httpOnly: true, secure: true, sameSite: "no_restriction" },
    { name: "theme", value: "dark", domain: "app.example.com", path: "/", httpOnly: false, secure: false, sameSite: "unspecified" },
  ]);
  const playwright = { cookies: [{ name: "a", value: "1", domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" }, { name: "b", value: "", domain: ".example.com", expires: 1893456000 }], origins: [{ origin: "https://example.com", localStorage: [] }] };
  assert.deepEqual(webCookies(playwright), [
    { name: "a", value: "1", domain: "example.com", path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
    { name: "b", value: "", domain: ".example.com", expires: 1893456000 },
  ]);
  assert.throws(() => webCookies({ cookies: "no" }), /must hold a JSON array of cookies, or an object with a cookies array/);
  assert.throws(() => webCookies("sid=abc"), /must hold a JSON array of cookies/);
  assert.throws(() => webCookies([{ name: "x", value: "y" }]), /cookie 0 needs a name, a value and the domain of the site/);
  assert.throws(() => webCookies([null]), /cookie 0 is not an object/);
  assert.throws(() => webCookies(Array.from({ length: 101 }, (_, index) => ({ name: `c${index}`, value: "v", domain: ".example.com" }))), /holds 101 cookies; a jar has at most 100/);
});

test("bi connection create web signs in with a password read from stdin, and keeps every secret out of output, logs and config", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "totp.txt"), `${TOTP}\n`);
  const { logger, events } = createMemoryLogger({ command: ["bi", "connection", "create", "web"] });
  const created = await cli(["--json", "bi", "connection", "create", "web", "--login-mode", "auto", "--login-url", "https://login.example.com/signin", "--username", "screens@example.com", "--password-file", "-", "--totp-file", "totp.txt"],
    transport, env, { ...stdin(`${PASSWORD}\n`), logger });
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const call = calls.at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/bi-connections");
  assert.deepEqual(call.body, {
    name: "login.example.com", kind: "web", config: { login_mode: "auto", login_url: "https://login.example.com/signin", username: "screens@example.com" }, secret: PASSWORD, totp_secret: TOTP,
  });
  assert.match(call.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/, "a create is an idempotent write");
  assert.equal(created.envelope.data.secret.set, true);
  assert.equal(created.envelope.data.totp_secret.set, true);
  const everything = created.stdout + created.stderr + JSON.stringify(events);
  assert.ok(!everything.includes(PASSWORD) && !everything.includes(TOTP), "neither the password nor the authenticator key is printed or logged");

  const human = await cli(["--human", "bi", "connection", "create", "web", "--login-mode", "auto", "--login-url", "https://login.example.com/signin", "--username", "screens@example.com", "--password-file", "-", "--name", "Ops dashboard"], transport, env, stdin(`${PASSWORD}\n`));
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^Created connection bic_\S+$/m);
  assert.match(human.stdout, /^kind: web$/m);
  assert.match(human.stdout, /^login: auto at https:\/\/login\.example\.com\/signin$/m);
  assert.match(human.stdout, /^user: screens@example\.com$/m);
  assert.match(human.stdout, /^authenticator key: not set$/m);
  assert.match(human.stdout, /^session: idle, 0 cookies$/m);
  assert.match(human.stdout, /^password: set \(ends aple\)$/m);
  assert.match(human.stdout, /Next: screenrig bi connection test bic_/);
  assert.ok(!human.stdout.includes(PASSWORD));
});

test("bi connection create web runs a script with steps, or shows pages with the cookies of a jar", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const steps = [{ action: "goto", url: "https://login.example.com/signin" }, { action: "fill", selector: "#user", value: "{{username}}" }, { action: "fill", selector: "#pass", value: "{{password}}" }, { action: "press", value: "Enter" }, { action: "wait_for", selector: ".home" }];
  await writeFile(path.join(env.cwd, "steps.json"), JSON.stringify(steps));
  await writeFile(path.join(env.cwd, "password.txt"), PASSWORD);
  const scripted = await cli(["--json", "bi", "connection", "create", "web", "--login-mode", "steps", "--login-url", "https://login.example.com/signin", "--username", "screens@example.com", "--password-file", "password.txt", "--steps", "steps.json"], transport, env);
  assert.equal(scripted.code, 0, scripted.stdout + scripted.stderr);
  assert.deepEqual(lastBody(calls), { name: "login.example.com", kind: "web", config: { login_mode: "steps", login_url: "https://login.example.com/signin", username: "screens@example.com", steps }, secret: PASSWORD });
  const piped = await cli(["--json", "bi", "connection", "create", "web", "--login-mode", "steps", "--login-url", "https://login.example.com/signin", "--steps", "-"], transport, env, stdin(JSON.stringify(steps)));
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  assert.deepEqual(lastBody(calls).config.steps, steps);
  assert.ok(!("secret" in lastBody(calls)), "a script may hold no password at all");

  await writeFile(path.join(env.cwd, "cookies.json"), JSON.stringify([{ name: "sid", value: COOKIE_VALUE, domain: ".example.com", path: "/", secure: true, httpOnly: true, expirationDate: 1893456000.5, storeId: "0", hostOnly: false }]));
  const { logger, events } = createMemoryLogger({ command: ["bi", "connection", "create", "web"] });
  const jar = await cli(["--json", "bi", "connection", "create", "web", "--login-mode", "none", "--cookies-file", "cookies.json", "--name", "Signed-in jar"], transport, env, { logger });
  assert.equal(jar.code, 0, jar.stdout + jar.stderr);
  assert.deepEqual(lastBody(calls), { name: "Signed-in jar", kind: "web", config: { login_mode: "none" }, cookies: [{ name: "sid", value: COOKIE_VALUE, domain: ".example.com", path: "/", secure: true, httpOnly: true, expires: 1893456000 }] });
  assert.doesNotMatch(jar.stdout + jar.stderr + JSON.stringify(events), new RegExp(COOKIE_VALUE), "the cookies never reach the output or the log");
  assert.equal(jar.envelope.data.session.cookies, 1);
});

test("bi connection create web refuses what the login mode cannot use, before any request", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "password.txt"), PASSWORD);
  await writeFile(path.join(env.cwd, "steps.json"), JSON.stringify([{ action: "click", selector: "a" }]));
  await writeFile(path.join(env.cwd, "cookies.json"), "[]");
  const base = ["--json", "bi", "connection", "create", "web"];
  for (const [argv, pattern] of [
    [[], /--login-mode/],
    [["--login-mode", "magic"], /--login-mode|magic/],
    [["--login-mode", "auto", "--username", "u", "--password-file", "password.txt"], /--login-mode auto needs --login-url/],
    [["--login-mode", "auto", "--login-url", "https://login.example.com", "--password-file", "password.txt"], /needs --username and --password-file/],
    [["--login-mode", "auto", "--login-url", "https://login.example.com", "--username", "u"], /needs --username and --password-file/],
    [["--login-mode", "auto", "--login-url", "https://login.example.com", "--username", "u", "--password-file", "password.txt", "--steps", "steps.json"], /--steps is the script of --login-mode steps/],
    [["--login-mode", "steps", "--login-url", "https://login.example.com"], /--login-mode steps runs a script/],
    [["--login-mode", "steps", "--steps", "steps.json"], /--login-mode steps needs --login-url/],
    [["--login-mode", "none", "--password-file", "password.txt"], /--login-mode none does not sign in, so --password-file would not be used/],
    [["--login-mode", "none", "--login-url", "https://login.example.com", "--username", "u"], /--login-url, --username would not be used/],
    [["--login-mode", "auto", "--login-url", "http://login.example.com", "--username", "u", "--password-file", "password.txt"], /--login-url takes the https address/],
    [["--login-mode", "auto", "--login-url", "https://login.example.com", "--username", "u", "--password-file", "-", "--totp-file", "-"], /cannot both read stdin/],
    [["--login-mode", "none", "--cookies-file", "missing.json"], /does not exist/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli([...base, ...argv], transport, env, stdin(PASSWORD));
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
    assert.ok(!(refused.stdout + refused.stderr).includes(PASSWORD));
  }
  assert.equal(calls.length, 0, "nothing was sent");
});

test("bi connection update changes the sign-in, replaces or clears the password, key and jar, and takes one secret source", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "new-password.txt"), `${PASSWORD}\n`);
  await writeFile(path.join(env.cwd, "totp.txt"), `${TOTP}\n`);
  await writeFile(path.join(env.cwd, "steps.json"), JSON.stringify([{ action: "goto", url: "https://login.example.com" }]));
  await writeFile(path.join(env.cwd, "cookies.json"), JSON.stringify({ cookies: [{ name: "sid", value: COOKIE_VALUE, domain: ".example.com", expires: -1 }] }));
  const update = (...argv: string[]) => cli(["--json", "bi", "connection", "update", CONN, ...argv], transport, env);
  assert.equal((await update("--password-file", "new-password.txt", "--login-url", "https://login2.example.com/signin")).code, 0);
  assert.deepEqual(lastBody(calls), { config: { login_url: "https://login2.example.com/signin" }, secret: PASSWORD });
  assert.equal((await update("--login-mode", "steps", "--steps", "steps.json")).code, 0);
  assert.deepEqual(lastBody(calls), { config: { login_mode: "steps", steps: [{ action: "goto", url: "https://login.example.com" }] } });
  assert.equal((await update("--totp-file", "totp.txt", "--cookies-file", "cookies.json", "--username", "other@example.com")).code, 0);
  assert.deepEqual(lastBody(calls), { config: { username: "other@example.com" }, totp_secret: TOTP, cookies: [{ name: "sid", value: COOKIE_VALUE, domain: ".example.com" }] });
  assert.equal((await update("--clear-password", "--clear-totp", "--clear-cookies")).code, 0);
  assert.deepEqual(lastBody(calls), { secret: "", totp_secret: "", cookies: [] }, "an empty secret, key or jar removes it");
  assert.equal(calls.at(-1)!.headers?.["if-match"], undefined);
  assert.equal((await update("--clear-cookies", "--expect-rev", "3")).code, 0);
  assert.equal(calls.at(-1)!.headers?.["if-match"], '"3"');

  const before = calls.length;
  for (const [argv, pattern] of [
    [[], /bi connection update requires --name/],
    [["--password-file", "new-password.txt", "--clear-password"], /--clear-password|--password-file/],
    [["--password-file", "new-password.txt", "--token-file", "new-password.txt"], /--token-file|--password-file/],
    [["--clear-totp", "--totp-file", "totp.txt"], /--clear-totp|--totp-file/],
    [["--clear-cookies", "--cookies-file", "cookies.json"], /--clear-cookies|--cookies-file/],
    [["--login-url", "http://login.example.com"], /--login-url takes the https address/],
    [["--password-file", "-", "--totp-file", "-"], /cannot both read stdin/],
    [["--login-mode", "ldap"], /--login-mode|ldap/],
  ] as Array<[string[], RegExp]>) {
    const refused = await update(...argv);
    assert.equal(refused.code, ExitCode.Usage, argv.join(" "));
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
  }
  assert.equal(calls.length, before, "refused updates send nothing");
});

test("bi connection create powerbi signs in through a Microsoft connection instead of an app of its own", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const created = await cli(["--human", "bi", "connection", "create", "powerbi", "--connection-id", "pcn_CONNECTION", "--name", "Contoso Power BI"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual(lastBody(calls), { name: "Contoso Power BI", kind: "powerbi", config: { connection_id: "pcn_CONNECTION" } });
  assert.match(created.stdout, /^connection: pcn_CONNECTION \(a Microsoft connection signs in; this one holds no secret\)$/m);
  assert.ok(!/^tenant:/m.test(created.stdout), "no tenant line for a connection");
  const listed = await cli(["--human", "bi", "connection", "list"], transport, env);
  assert.match(listed.stdout, /^bic_PBIAAAAAAAAAAAAAAAAAAA\s+powerbi\s+Power BI\s+pcn_CONNECTION\s+never$/m);
  assert.match(listed.stdout, /^bic_WEBCONNECTIONAAAAAAA\s+web\s+Ops dashboard\s+https:\/\/login\.example\.com\/signin\s+never$/m);

  const before = calls.length;
  for (const [argv, pattern] of [
    [["--connection-id", "pcn_CONNECTION", "--tenant-id", "11111111-2222-4333-8444-555555555555"], /--connection-id|--tenant-id/],
    [["--connection-id", "pcn_CONNECTION", "--client-id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "--secret-file", "x.txt"], /--connection-id|--client-id/],
    [["--connection-id", "bic_CONNECTION"], /--connection-id takes a connection id \(pcn_…\)/],
    [[], /Provide exactly one of --connection-id or --tenant-id/],
    [["--tenant-id", "11111111-2222-4333-8444-555555555555"], /--tenant-id and --client-id and --secret-file together/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "connection", "create", "powerbi", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, argv.join(" "));
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
  }
  assert.equal(calls.length, before, "nothing was sent");
});

test("bi view create and update carry the web page, the wait, the clip and the clears", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const created = await cli(["--human", "bi", "view", "create", "--connection-id", CONN, "--url", "https://app.example.com/dashboards/42", "--refresh", "5m", "--wait-for", "#dashboard.loaded", "--wait-ms", "1500", "--clip", "#chart-grid"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual(lastBody(calls), { connection_id: CONN, name: "app.example.com", url: "https://app.example.com/dashboards/42", refresh_s: 300, wait_for: "#dashboard.loaded", wait_ms: 1500, clip: "#chart-grid" });
  assert.match(created.stdout, /^shows: page https:\/\/app\.example\.com\/dashboards\/42$/m);
  assert.match(created.stdout, /^fit: contain$/m);
  assert.match(created.stdout, /^wait for: #dashboard\.loaded$/m);
  assert.match(created.stdout, /^wait after: 1500 ms$/m);
  assert.match(created.stdout, /^clip: #chart-grid$/m);
  const named = await cli(["--json", "bi", "view", "create", "--connection-id", CONN, "--url", "https://app.example.com/dashboards/42", "--name", "Ops wall", "--fit", "cover"], transport, env);
  assert.deepEqual(lastBody(calls), { connection_id: CONN, name: "Ops wall", url: "https://app.example.com/dashboards/42", fit: "cover" });
  assert.equal(named.code, 0);

  const update = (...argv: string[]) => cli(["--json", "bi", "view", "update", VIEW, ...argv], transport, env);
  assert.equal((await update("--wait-for", "#ready", "--wait-ms", "2000", "--clip", ".grid", "--url", "https://app.example.com/dashboards/43")).code, 0);
  assert.deepEqual(lastBody(calls), { url: "https://app.example.com/dashboards/43", wait_for: "#ready", wait_ms: 2000, clip: ".grid" });
  assert.equal((await update("--clear-wait-for", "--clear-clip", "--wait-ms", "0")).code, 0);
  assert.deepEqual(lastBody(calls), { wait_for: "", wait_ms: 0, clip: "" }, "an empty selector and a wait of 0 remove the setting");
  assert.equal((await update("--clip", "#chart", "--expect-rev", "2")).code, 0);
  assert.deepEqual(lastBody(calls), { clip: "#chart" });

  const before = calls.length;
  for (const [argv, pattern] of [
    [["create", "--connection-id", CONN, "--dashboard", "abc123", "--wait-for", "#x"], /--wait-for apply to a view of a web connection|apply to a view of a web connection/],
    [["create", "--public-url", "https://grafana.example.com/public-dashboards/T", "--clip", "#x"], /apply to a view of a web connection/],
    [["create", "--connection-id", CONN, "--url", "https://app.example.com", "--wait-ms", "20000"], /--wait-ms takes whole milliseconds/],
    [["create", "--connection-id", CONN, "--url", "https://app.example.com", "--wait-for", ""], /requires a value|--wait-for/],
    [["update", VIEW, "--wait-for", "#x", "--clear-wait-for"], /--wait-for|--clear-wait-for/],
    [["update", VIEW, "--clip", "#x", "--clear-clip"], /--clip|--clear-clip/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "bi", "view", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, argv.join(" "));
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
  }
  assert.equal(calls.length, before, "nothing was sent");
});

test("the human lines show a web connection's sign-in and session and a web view's page, and never a secret", () => {
  const lines = connectionLines(web());
  for (const expected of ["kind: web", "login: auto at https://login.example.com/signin", "user: screens@example.com", "authenticator key: set", "password: set (ends aple)"]) assert.ok(lines.includes(expected), expected);
  assert.ok(lines.some((line) => /^session: active, 2 cookies \(updated 2026-11-01T16:40:00Z\), last sign-in 2026-11-01T16:00:00Z$/.test(line)), lines.join("\n"));
  const failing = webConnectionLines(web({ session: { state: "paused", cookies: 0, cookies_updated_at: null, last_login_at: null, login_failures: 3, retry_at: "2026-11-01T18:00:00Z" } }));
  assert.ok(failing.some((line) => line === "session: paused, 0 cookies, 3 refused sign-ins in a row, next sign-in not before 2026-11-01T18:00:00Z"), failing.join("\n"));
  const script = webConnectionLines(web({ config: { login_mode: "steps", login_url: "https://login.example.com", steps: [{ action: "click", selector: "a" }, { action: "wait_ms", ms: 100 }] } }));
  assert.ok(script.includes("steps: 2"));
  assert.deepEqual(connectionTableLines([]), ["No connections"]);
  assert.ok(viewLines(view()).includes("shows: page https://app.example.com/dashboards/42"));
  assert.match(viewTableLines([view()]).at(-1)!, /page https:\/\/app\.example\.com\/dashboards\/42\s+300s\s+new$/);
  assert.doesNotMatch(JSON.stringify(connectionLines(web())), new RegExp(`${PASSWORD}|${TOTP}`));
});

test("a server without the page renderer answers bi_web_unavailable with the way out", async () => {
  const env = await enrolled();
  const transport = new FakeTransport().on("POST", "/api/bi-connections", () => problem(409, "bi_web_unavailable", "Web pages are not available on this server."));
  await writeFile(path.join(env.cwd, "cookies.json"), "[]");
  const refused = await cli(["--json", "bi", "connection", "create", "web", "--login-mode", "none", "--cookies-file", "cookies.json"], transport, env);
  assert.equal(refused.code, 5);
  assert.equal(refused.envelope.error?.code, "bi_web_unavailable");
  assert.equal(refused.envelope.error?.next?.command, "screenrig bi connection list");
  assert.match(refused.envelope.error?.next?.reason ?? "", /no page renderer/);
});

test("bi help names the web connection, its sign-in modes, its secrets and the view flags", () => {
  const group = commandHelp(["bi"]).usage;
  for (const text of ["Web:", "--login-mode auto", "cookie", "--wait-for", "--wait-ms", "--clip", "CAPTCHA"]) assert.ok(group.includes(text), text);
  const create = commandHelp(["bi", "connection", "create", "web"]);
  assert.deepEqual(create.options.find((option) => option.name === "--login-mode")!.choices, ["auto", "steps", "none"]);
  assert.equal(create.options.find((option) => option.name === "--login-mode")!.required, true);
  for (const flag of ["--login-url", "--username", "--password-file", "--totp-file", "--steps", "--cookies-file", "--name"]) assert.ok(create.options.some((option) => option.name === flag), flag);
  for (const flag of ["--password-file", "--totp-file"]) assert.match(create.options.find((option) => option.name === flag)!.description, /never an argument/, flag);
  for (const flag of ["--steps", "--cookies-file"]) assert.match(create.options.find((option) => option.name === flag)!.description, /stdin/, flag);
  assert.ok(create.examples.length >= 4 && create.examples.every((example) => example.startsWith("screenrig bi connection create web")));
  assert.match(create.notes.join("\n"), /bi_web_unavailable/);
  assert.match(create.notes.join("\n"), /\{\{otp\}\}/);
  const update = commandHelp(["bi", "connection", "update"]);
  for (const flag of ["--login-mode", "--login-url", "--password-file", "--clear-password", "--totp-file", "--clear-totp", "--steps", "--cookies-file", "--clear-cookies"]) assert.ok(update.options.some((option) => option.name === flag), flag);
  const viewCreate = commandHelp(["bi", "view", "create"]);
  for (const flag of ["--wait-for", "--wait-ms", "--clip"]) assert.ok(viewCreate.options.some((option) => option.name === flag), flag);
  const viewUpdate = commandHelp(["bi", "view", "update"]);
  for (const flag of ["--wait-for", "--clear-wait-for", "--wait-ms", "--clip", "--clear-clip"]) assert.ok(viewUpdate.options.some((option) => option.name === flag), flag);
  assert.ok(viewUpdate.options.find((option) => option.name === "--clear-wait-for")!.conflicts.includes("--wait-for"));
  const powerbi = commandHelp(["bi", "connection", "create", "powerbi"]);
  assert.ok(powerbi.options.some((option) => option.name === "--connection-id"));
  assert.ok(powerbi.relationships.some((relationship) => relationship.kind === "exactlyOne" && relationship.options.join() === "--connection-id,--tenant-id"));
  assert.ok(powerbi.options.find((option) => option.name === "--tenant-id")!.required === false);
  assert.match(powerbi.notes.join("\n"), /screenrig_app connection is refused/);
});
