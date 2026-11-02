import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { CONNECTION_ID_PATTERN, CONNECTION_REFERENCE_PATTERN, connectionIdOption } from "./connection-ids.js";
import { connectionId, connectionLines, connectionTableLines, type Connection } from "./connections.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help-tree.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-11-01T17:00:00.000Z");
const PCN = "pcn_CONNECTIONAAAAAAAA";
const TENANT = "11111111-2222-4333-8444-555555555555";
const APP = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
// Built in code, so no literal here looks like a credential.
const CLIENT_SECRET = `Sn7~${"q".repeat(30)}-x9`;
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${"M".repeat(64)}\n-----END PRIVATE KEY-----\n`;
const CONSENT_URL = `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=${APP}&state=cs1.2.${"P".repeat(40)}.${"m".repeat(20)}`;

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
  const configDir = await testTemp("connections-cfg-");
  const cwd = await testTemp("connections-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, settings: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA",
    organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, extra: Partial<CliRuntime> = {}): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const code = await run({
    argv, settings: env.fs.settings, stdout, stderr, now: () => NOW, sleep: async () => undefined,
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
const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({ status, headers: { "content-type": "application/problem+json" }, body: { status, code, title: detail, detail } });

function connection(over: Partial<Connection> = {}): Connection {
  return {
    id: PCN, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", provider: "microsoft", mode: "own_app", name: "Microsoft 365", status: "ready", last_error: null,
    config: { tenant_id: TENANT, client_id: APP }, secret: { set: true, hint: "x9" }, last_test: null, revision: 1,
    created_at: "2026-11-01T16:00:00Z", updated_at: "2026-11-01T16:00:00Z", ...over,
  };
}

/** The connection routes of the API, scripted: each write is recorded with the connection it answers. */
function backend(): { transport: FakeTransport; calls: TransportRequest[] } {
  const transport = new FakeTransport();
  const calls: TransportRequest[] = [];
  const record = (req: TransportRequest) => { calls.push(req); };
  transport
    .on("GET", "/api/connections", (req) => {
      record(req);
      return req.query?.after === "page2"
        ? json(200, { items: [connection({ id: "pcn_SECONDAAAAAAAAAAAA", provider: "google", name: "Venue calendars", config: { service_account: "rooms@project.iam.gserviceaccount.com" }, secret: { set: true, hint: "rooms@project.iam.gserviceaccount.com" } })], next_cursor: null })
        : json(200, { items: [connection(), connection({ id: "pcn_PENDINGAAAAAAAAAAA", mode: "screenrig_app", name: "Contoso rooms", status: "pending_consent", config: {}, secret: { set: false, hint: "" } })], next_cursor: "page2" });
    })
    .on("POST", "/api/connections", (req) => {
      record(req);
      const body = req.body as { provider: "microsoft" | "google"; mode: "own_app" | "screenrig_app"; name: string; config?: Connection["config"]; secret?: string };
      if (body.mode === "screenrig_app") {
        return json(201, connection({ provider: body.provider, mode: "screenrig_app", name: body.name, status: "pending_consent", config: {}, secret: { set: false, hint: "" }, consent_url: body.provider === "microsoft" ? CONSENT_URL : "https://accounts.google.com/o/oauth2/v2/auth?state=consent", consent_expires_at: "2026-11-02T17:00:00Z" }));
      }
      return json(201, connection({ provider: body.provider, name: body.name, config: body.provider === "microsoft" ? body.config ?? {} : { service_account: "rooms@project.iam.gserviceaccount.com" } }));
    })
    .on("GET", `/api/connections/${PCN}`, (req) => { record(req); return json(200, connection({ last_test: { at: "2026-11-01T16:30:00Z", ok: true, checks: [{ name: "credentials", ok: true, detail: "Microsoft issued an app token for the tenant." }, { name: "permissions", ok: true, warn: true, detail: "The token carries Sites.Selected only." }] } })); })
    .on("GET", "/api/connections/pcn_PENDINGAAAAAAAAAAA", (req) => { record(req); return json(200, connection({ id: "pcn_PENDINGAAAAAAAAAAA", mode: "screenrig_app", status: "pending_consent", config: {}, secret: { set: false, hint: "" } })); })
    .on("PATCH", `/api/connections/${PCN}`, (req) => { record(req); return json(200, connection({ revision: 2, ...((req.body as { name?: string }).name ? { name: (req.body as { name: string }).name } : {}) })); })
    .on("DELETE", `/api/connections/${PCN}`, (req) => { record(req); return { status: 204, headers: {}, body: undefined }; })
    .on("POST", `/api/connections/${PCN}/test`, (req) => { record(req); return json(200, { at: "2026-11-01T17:00:00Z", ok: false, checks: [{ name: "credentials", ok: false, detail: "Microsoft refused the app: AADSTS7000215." }] }); })
    .on("POST", `/api/connections/${PCN}/connect`, (req) => { record(req); return json(200, connection({ mode: "screenrig_app", status: "pending_consent", config: {}, secret: { set: false, hint: "" }, consent_url: CONSENT_URL, consent_expires_at: "2026-11-02T17:00:00Z" })); });
  return { transport, calls };
}

test("a connection id is pcn_ and a consumer's reference is 4 to 64 characters of it", () => {
  assert.match(PCN, CONNECTION_ID_PATTERN);
  assert.match(`stage_${PCN}`, CONNECTION_ID_PATTERN);
  assert.doesNotMatch("bic_CONNECTION", CONNECTION_ID_PATTERN);
  assert.doesNotMatch("pcn_", CONNECTION_ID_PATTERN);
  assert.match("pcn_abcd", CONNECTION_REFERENCE_PATTERN);
  assert.doesNotMatch("pcn_abc", CONNECTION_REFERENCE_PATTERN);
  assert.doesNotMatch(`pcn_${"a".repeat(65)}`, CONNECTION_REFERENCE_PATTERN);
  assert.equal(connectionIdOption(PCN), PCN);
  assert.throws(() => connectionIdOption("bic_CONNECTION"), /--connection-id takes a connection id \(pcn_…\)/);
  assert.equal(connectionId(PCN, "show"), PCN);
  assert.throws(() => connectionId(undefined, "show"), /requires <id>/);
  assert.throws(() => connectionId("crd_X", "show"), /A connection id looks like pcn_/);
});

test("connection list reads every page and prints the table; show prints status, last error and last test", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const json1 = await cli(["--json", "connection", "list"], transport, env);
  assert.equal(json1.code, 0, json1.stdout);
  assert.deepEqual(json1.envelope.data.items.map((item: Connection) => item.id), [PCN, "pcn_PENDINGAAAAAAAAAAA", "pcn_SECONDAAAAAAAAAAAA"], "both pages");
  assert.equal(json1.envelope.data.next_cursor, null);
  assert.equal(calls[1]!.query?.after, "page2");
  const human = await cli(["--human", "connection", "list"], transport, env);
  assert.match(human.stdout, /^Connections \(3\)$/m);
  assert.match(human.stdout, /^ID\s+PROVIDER\s+MODE\s+NAME\s+STATUS\s+TENANT OR ACCOUNT\s+TEST$/m);
  assert.match(human.stdout, new RegExp(`^${PCN}\\s+microsoft\\s+own_app\\s+Microsoft 365\\s+ready\\s+${TENANT}\\s+never$`, "m"));
  assert.match(human.stdout, /^pcn_PENDINGAAAAAAAAAAA\s+microsoft\s+screenrig_app\s+Contoso rooms\s+pending_consent\s+-\s+never$/m);
  assert.deepEqual(connectionTableLines([]), ["No connections"]);

  const shown = await cli(["--human", "connection", "show", PCN], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  for (const expected of [`id: ${PCN}`, "provider: microsoft", "mode: own_app (your own application)", "status: ready", `tenant: ${TENANT}`, `app (client id): ${APP}`, "secret: set (x9)",
    "last test: ok at 2026-11-01T16:30:00Z", "  ok credentials: Microsoft issued an app token for the tenant.", "  warning permissions: The token carries Sites.Selected only.", "revision: 1"]) {
    assert.ok(shown.stdout.includes(expected), `${expected}\n${shown.stdout}`);
  }
  const pending = await cli(["--human", "connection", "show", "pcn_PENDINGAAAAAAAAAAA"], transport, env);
  assert.match(pending.stdout, /^status: pending_consent$/m);
  assert.match(pending.stdout, /No one has consented yet\. screenrig connection connect pcn_PENDINGAAAAAAAAAAA makes a consent link/);
  assert.ok(!pending.stdout.includes("consent_url"), "a read never carries a link");
  assert.equal((await cli(["--json", "connection", "show", "crd_X"], transport, env)).envelope.error?.code, "usage_error");
  const failing = connectionLines(connection({ status: "error", last_error: { code: "consent_revoked", message: "The tenant removed screenRIG's application.", at: "2026-11-01T16:50:00Z" } }));
  assert.ok(failing.includes("error: consent_revoked: The tenant removed screenRIG's application. (2026-11-01T16:50:00Z)"));
  const google = connectionLines(connection({ provider: "google", mode: "screenrig_app", config: { account: "ops@example.com" }, secret: { set: false, hint: "" } }));
  assert.ok(google.some((line) => line.startsWith("account: ops@example.com (a calendar source reads the calendars this account can see)")));
  assert.ok(!google.some((line) => line.startsWith("secret:")), "a screenrig_app connection holds no secret");
});

test("connection create microsoft own_app sends the tenant, the app and the secret read from a file or stdin, and keeps the secret out of output, logs and config", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "secret.txt"), `${CLIENT_SECRET}\n`);
  const { logger, events } = createMemoryLogger({ command: ["connection", "create", "microsoft"] });
  const created = await cli(["--json", "connection", "create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "secret.txt"], transport, env, { logger });
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const call = calls.at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/connections");
  assert.deepEqual(call.body, { provider: "microsoft", mode: "own_app", name: "Microsoft 365", config: { tenant_id: TENANT, client_id: APP }, secret: CLIENT_SECRET });
  assert.match(call.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/, "a create is an idempotent write");
  assert.equal(created.envelope.data.secret.set, true);
  assert.deepEqual(created.envelope.warnings ?? [], [], "an own_app connection makes no consent link");
  assert.ok(!(created.stdout + created.stderr).includes(CLIENT_SECRET));
  assert.doesNotMatch(JSON.stringify(events), new RegExp(CLIENT_SECRET), "the secret never reaches the operation log");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), new RegExp(CLIENT_SECRET), "or the saved config");

  const piped = await cli(["--human", "connection", "create", "microsoft", "--mode", "own_app", "--tenant-id", "contoso.onmicrosoft.com", "--client-id", APP, "--secret-file", "-", "--name", "Contoso"], transport, env, stdin(`${CLIENT_SECRET}\n`));
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  assert.deepEqual(calls.at(-1)!.body, { provider: "microsoft", mode: "own_app", name: "Contoso", config: { tenant_id: "contoso.onmicrosoft.com", client_id: APP }, secret: CLIENT_SECRET });
  assert.match(piped.stdout, /^Created connection pcn_\S+$/m);
  assert.match(piped.stdout, /^secret: set \(x9\)$/m);
  assert.match(piped.stdout, /^Next: screenrig connection test pcn_/m);
  assert.ok(!piped.stdout.includes(CLIENT_SECRET));
});

test("connection create screenrig_app sends no config or secret and prints the consent link for the person who completes it", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const { logger, events } = createMemoryLogger({ command: ["connection", "create", "microsoft"] });
  const created = await cli(["--json", "connection", "create", "microsoft", "--mode", "screenrig_app", "--name", "Contoso rooms"], transport, env, { logger });
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual(calls.at(-1)!.body, { provider: "microsoft", mode: "screenrig_app", name: "Contoso rooms" });
  assert.equal(created.envelope.data.consent_url, CONSENT_URL);
  assert.equal(created.envelope.data.consent_expires_at, "2026-11-02T17:00:00Z");
  assert.deepEqual(created.envelope.warnings?.map((warning) => warning.code), ["connection_consent_link"]);
  assert.match(created.envelope.warnings![0]!.message, /Send it|send it to the Microsoft 365 administrator/i);
  assert.match(created.envelope.warnings![0]!.message, /screenrig connection connect pcn_\S+ makes a new link/);
  assert.doesNotMatch(created.envelope.warnings![0]!.message, /cs1\./, "the warning never repeats the link");
  assert.doesNotMatch(JSON.stringify(events), /cs1\.2\.|adminconsent/, "the consent link never reaches the operation log");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /cs1\.2\./, "or the saved config");

  const human = await cli(["--human", "connection", "create", "microsoft", "--mode", "screenrig_app"], transport, env);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^name: Microsoft 365$/m);
  assert.match(human.stdout, /^status: pending_consent$/m);
  assert.match(human.stdout, /^tenant: - \(set when the administrator has consented\)$/m);
  assert.match(human.stdout, /Consent link, for the Microsoft 365 administrator, who consents to screenRIG's application for the tenant/);
  assert.match(human.stdout, /Send it to that person only: it is the credential of one consent, and works once until 2026-11-02T17:00:00Z\./);
  assert.ok(human.stdout.includes(`consent_url: ${CONSENT_URL}`), "the link is printed for the operator to open");
  assert.match(human.stdout, /screenrig connection show pcn_\S+ reads its status and last_error/);
  assert.doesNotMatch(human.stdout, /^Next: screenrig connection test/m);

  const google = await cli(["--human", "connection", "create", "google", "--mode", "screenrig_app", "--name", "Venue calendars"], transport, env);
  assert.deepEqual(calls.at(-1)!.body, { provider: "google", mode: "screenrig_app", name: "Venue calendars" });
  assert.match(google.stdout, /Consent link, for the holder of the Google account, who signs in and grants read-only access to the calendars the account can see\./);
  assert.match(google.stdout, /consent_url: https:\/\/accounts\.google\.com\//);
});

test("connection create google sends the service account key whole, on one line", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const key = { type: "service_account", project_id: "project", private_key_id: "abc123", private_key: PRIVATE_KEY, client_email: "rooms@project.iam.gserviceaccount.com", client_id: "123", token_uri: "https://oauth2.googleapis.com/token" };
  await writeFile(path.join(env.cwd, "key.json"), JSON.stringify(key, null, 2));
  const { logger, events } = createMemoryLogger({ command: ["connection", "create", "google"] });
  const created = await cli(["--json", "connection", "create", "google", "--mode", "own_app", "--service-account-key-file", "key.json"], transport, env, { logger });
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const body = calls.at(-1)!.body as { provider: string; mode: string; name: string; secret: string };
  assert.deepEqual({ ...body, secret: undefined }, { provider: "google", mode: "own_app", name: "Google Calendar", secret: undefined });
  assert.ok(!body.secret.includes("\n") && !body.secret.includes("  "), "compacted to one line");
  assert.deepEqual(JSON.parse(body.secret), key, "the key is sent whole");
  assert.doesNotMatch(created.stdout + created.stderr + JSON.stringify(events), /BEGIN PRIVATE KEY|MMMMMMMM/, "the key never reaches the output or the log");
  const human = await cli(["--human", "connection", "create", "google", "--mode", "own_app", "--service-account-key-file", "-", "--name", "Rooms"], transport, env, stdin(JSON.stringify(key)));
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, /^service account: rooms@project\.iam\.gserviceaccount\.com$/m);
  assert.doesNotMatch(human.stdout, /BEGIN PRIVATE KEY/);

  const before = calls.length;
  await writeFile(path.join(env.cwd, "not-a-key.json"), JSON.stringify({ type: "authorized_user", client_id: "x" }));
  await writeFile(path.join(env.cwd, "pem.txt"), PRIVATE_KEY);
  for (const file of ["not-a-key.json", "pem.txt"]) {
    const refused = await cli(["--json", "connection", "create", "google", "--mode", "own_app", "--service-account-key-file", file], transport, env);
    assert.equal(refused.code, ExitCode.Usage, file);
    assert.match(refused.envelope.error?.detail ?? "", /must be the service account's JSON key file/);
    assert.doesNotMatch(refused.stdout + refused.stderr, /BEGIN PRIVATE KEY/);
  }
  assert.equal(calls.length, before, "refused keys send nothing");
});

test("connection create refuses a mode that does not fit its flags before any request", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "secret.txt"), `${CLIENT_SECRET}\n`);
  await writeFile(path.join(env.cwd, "spaced.txt"), "two words\n");
  await writeFile(path.join(env.cwd, "key.json"), JSON.stringify({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: PRIVATE_KEY }));
  for (const [argv, pattern] of [
    [["create", "microsoft"], /--mode/],
    [["create", "microsoft", "--mode", "own_app"], /--mode own_app needs --tenant-id, --client-id and --secret-file/],
    [["create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", APP], /--tenant-id, --client-id and --secret-file|--secret-file/],
    [["create", "microsoft", "--mode", "own_app", "--tenant-id", "common", "--client-id", APP, "--secret-file", "secret.txt"], /--tenant-id takes/],
    [["create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", "my-app", "--secret-file", "secret.txt"], /--client-id takes/],
    [["create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "spaced.txt"], /must hold only the client secret's Value/],
    [["create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "missing.txt"], /does not exist/],
    [["create", "microsoft", "--mode", "screenrig_app", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "secret.txt"], /screenrig_app uses screenRIG's own application/],
    [["create", "microsoft", "--mode", "ad_hoc"], /--mode|ad_hoc/],
    [["create", "microsoft", "--mode", "own_app", "--secret", CLIENT_SECRET], /does not accept --secret|unknown option/],
    [["create", "google", "--mode", "own_app"], /--mode own_app needs --service-account-key-file/],
    [["create", "google", "--mode", "screenrig_app", "--service-account-key-file", "key.json"], /screenrig_app uses screenRIG's own application/],
    [["create", "google", "--mode", "own_app", "--service-account-key-file", "key.json", "--name", ""], /--name|requires a value/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "connection", ...argv], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
    assert.ok(!(refused.stdout + refused.stderr).includes(CLIENT_SECRET));
  }
  assert.equal(calls.length, 0, "nothing was sent");
});

test("connection update renames or changes the credentials, guarded by --expect-rev", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  await writeFile(path.join(env.cwd, "new-secret.txt"), `${CLIENT_SECRET}\n`);
  const renamed = await cli(["--json", "connection", "update", PCN, "--name", "Contoso rooms", "--expect-rev", "1"], transport, env);
  assert.equal(renamed.code, 0, renamed.stdout);
  assert.deepEqual(calls.at(-1)!.body, { name: "Contoso rooms" });
  assert.equal(calls.at(-1)!.headers?.["if-match"], '"1"');
  assert.match(calls.at(-1)!.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{8,}/);
  const secret = await cli(["--human", "connection", "update", PCN, "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "new-secret.txt"], transport, env);
  assert.equal(secret.code, 0, secret.stdout);
  assert.deepEqual(calls.at(-1)!.body, { config: { tenant_id: TENANT, client_id: APP }, secret: CLIENT_SECRET });
  assert.match(secret.stdout, /^Updated connection pcn_/m);
  assert.ok(!secret.stdout.includes(CLIENT_SECRET));
  const key = JSON.stringify({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: PRIVATE_KEY });
  const google = await cli(["--json", "connection", "update", PCN, "--service-account-key-file", "-"], transport, env, stdin(key));
  assert.equal(google.code, 0, google.stdout);
  assert.deepEqual(JSON.parse((calls.at(-1)!.body as { secret: string }).secret), JSON.parse(key));
  const none = await cli(["--json", "connection", "update", PCN], transport, env);
  assert.equal(none.code, ExitCode.Usage);
  assert.match(none.envelope.error?.detail ?? "", /requires --name, --tenant-id, --client-id, --secret-file or --service-account-key-file|Provide at least one of/);
  const stdinTwice = await cli(["--json", "connection", "update", PCN, "--secret-file", "-", "--service-account-key-file", "-"], transport, env, stdin("x"));
  assert.equal(stdinTwice.code, ExitCode.Usage);
  assert.match(stdinTwice.envelope.error?.detail ?? "", /cannot both read stdin/);
});

test("connection test prints each check, and connect prints a new consent link", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const tested = await cli(["--human", "connection", "test", PCN], transport, env);
  assert.equal(tested.code, 0, "a failed check is a result, not a failure");
  assert.match(tested.stdout, new RegExp(`^Connection ${PCN}: failed$`, "m"));
  assert.match(tested.stdout, /^ {2}failed credentials: Microsoft refused the app: AADSTS7000215\.$/m);
  assert.equal(calls.at(-1)!.path, `/api/connections/${PCN}/test`);
  assert.equal((await cli(["--json", "connection", "test", PCN], transport, env)).envelope.data.ok, false);

  const connect = await cli(["--json", "connection", "connect", PCN], transport, env);
  assert.equal(connect.code, 0, connect.stdout);
  assert.equal(calls.at(-1)!.path, `/api/connections/${PCN}/connect`);
  assert.equal(calls.at(-1)!.method, "POST");
  assert.equal(connect.envelope.data.consent_url, CONSENT_URL);
  assert.deepEqual(connect.envelope.warnings?.map((warning) => warning.code), ["connection_consent_link"]);
  const human = await cli(["--human", "connection", "connect", PCN], transport, env);
  assert.match(human.stdout, /^Made a new consent link for connection pcn_\S+\. Any earlier link no longer works;/m);
  assert.ok(human.stdout.includes(`consent_url: ${CONSENT_URL}`));
});

test("connection delete says it does not end the vendor's side", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  const removed = await cli(["--json", "connection", "delete", PCN, "--expect-rev", "1"], transport, env);
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual(removed.envelope.data, { id: PCN, deleted: true });
  assert.equal(calls.at(-1)!.headers?.["if-match"], '"1"');
  const human = await cli(["--human", "connection", "delete", PCN], transport, env);
  assert.match(human.stdout, /^Deleted connection pcn_\S+\. This does not end the vendor's side: a Microsoft 365 tenant keeps screenRIG's application until its administrator removes it, and a Google account keeps its grant until its holder revokes it\.$/m);
});

test("connection problems carry the next step", async () => {
  const env = await enrolled();
  const transport = new FakeTransport()
    .on("POST", "/api/connections", (req) => (req.body as { mode: string }).mode === "screenrig_app"
      ? problem(409, "connection_app_not_configured", "This server has no screenRIG application for Microsoft.")
      : problem(409, "connection_limit_reached", "The organization has the maximum of 50 connections."))
    .on("DELETE", `/api/connections/${PCN}`, () => problem(409, "resource_conflict", "A data source reads through this connection."))
    .on("PATCH", `/api/connections/${PCN}`, () => ({ status: 412, headers: { "content-type": "application/problem+json" }, body: { status: 412, code: "revision_conflict", title: "Revision", detail: "The connection changed.", current_revision: 4 } }));
  const notConfigured = await cli(["--json", "connection", "create", "microsoft", "--mode", "screenrig_app"], transport, env);
  assert.equal(notConfigured.code, 5);
  assert.equal(notConfigured.envelope.error?.code, "connection_app_not_configured");
  assert.equal(notConfigured.envelope.error?.next?.command, "screenrig connection create --help");
  assert.match(notConfigured.envelope.error?.next?.reason ?? "", /own_app connection .* works/);
  await writeFile(path.join(env.cwd, "secret.txt"), `${CLIENT_SECRET}\n`);
  const limit = await cli(["--json", "connection", "create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "secret.txt"], transport, env);
  assert.equal(limit.envelope.error?.code, "connection_limit_reached");
  assert.equal(limit.envelope.error?.next?.command, "screenrig connection list");
  const used = await cli(["--json", "connection", "delete", PCN], transport, env);
  assert.equal(used.code, 5);
  assert.equal(used.envelope.error?.next?.command, "screenrig source list");
  assert.match(used.envelope.error?.next?.reason ?? "", /bi connection list|media sync account list/);
  const stale = await cli(["--json", "connection", "update", PCN, "--name", "x", "--expect-rev", "3"], transport, env);
  assert.equal(stale.code, 6);
  assert.equal(stale.envelope.error?.next?.command, `screenrig connection show ${PCN}`);
  const gone = await cli(["--json", "connection", "show", PCN], transport, env);
  assert.equal(gone.code, 4);
  assert.equal(gone.envelope.error?.next?.command, "screenrig connection list");
});

test("an ambiguous connection create reruns with the saved key and holds no secret or link on disk", async () => {
  const env = await enrolled();
  const { transport, calls } = backend();
  let lose = true;
  const original = transport.request.bind(transport);
  transport.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/connections") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  await writeFile(path.join(env.cwd, "secret.txt"), `${CLIENT_SECRET}\n`);
  const argv = ["--json", "connection", "create", "microsoft", "--mode", "own_app", "--tenant-id", TENANT, "--client-id", APP, "--secret-file", "secret.txt"];
  const lost = await cli(argv, transport, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/, "the key is saved for the rerun");
  assert.match(pending, /connection create/, "recovery list can name the command");
  assert.doesNotMatch(pending, new RegExp(`${CLIENT_SECRET}|${TENANT}`), "the ledger holds no request content");
  const rerun = await cli(argv, transport, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = calls.filter((call) => call.method === "POST" && call.path === "/api/connections");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"], "the rerun reuses the saved key");
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});

test("connection help names the modes, the consent link and a working example for every command", () => {
  const group = commandHelp(["connection"]);
  for (const text of ["own_app", "screenrig_app", "consent", "pcn_", "source create --connection-id", "bi connection create powerbi --connection-id", "media sync account add microsoft365 --connection-id", "50 connections"]) {
    assert.ok(group.usage.includes(text), text);
  }
  for (const leaf of ["list", "show", "update", "test", "connect", "delete"]) {
    const help = commandHelp(["connection", leaf]);
    assert.ok(help.examples.length > 0, leaf);
    assert.ok(help.examples.every((example) => example.startsWith(`screenrig connection ${leaf}`)), leaf);
  }
  for (const provider of ["microsoft", "google"]) {
    const help = commandHelp(["connection", "create", provider]);
    assert.deepEqual(help.options.find((option) => option.name === "--mode")!.choices, ["own_app", "screenrig_app"]);
    assert.equal(help.options.find((option) => option.name === "--mode")!.required, true);
    assert.ok(help.examples.length >= 2 && help.examples.some((example) => example.includes("screenrig_app")), provider);
    assert.match(help.notes.join("\n"), /consent_url/);
    assert.match(help.notes.join("\n"), /connection_app_not_configured/);
  }
  const microsoft = commandHelp(["connection", "create", "microsoft"]);
  assert.match(microsoft.options.find((option) => option.name === "--secret-file")!.description, /never an argument/);
  assert.ok(microsoft.relationships.some((group) => group.kind === "together" && group.options.join() === "--tenant-id,--client-id,--secret-file"));
  assert.match(commandHelp(["connection", "create", "google"]).options.find((option) => option.name === "--service-account-key-file")!.description, /never an argument/);
  assert.match(commandHelp(["connection", "connect"]).notes.join("\n"), /replaces any earlier link/);
  assert.match(commandHelp(["connection", "delete"]).notes.join("\n"), /does not end the vendor's side/);
  assert.ok(commandHelp(["connection", "update"]).relationships.some((group) => group.kind === "atLeastOne"));
});
