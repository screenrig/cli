import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help-tree.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import {
  MEDIA_SYNC_ACCOUNT_ID_PATTERN, MEDIA_SYNC_ID_PATTERN, accountLines, mediaSyncAppKey, mediaSyncClientId, mediaSyncDriveUrl, mediaSyncDropboxUrl,
  mediaSyncEvery, mediaSyncTenant, mediaSyncUrl, syncLines, syncTableLines,
  type MediaSync, type MediaSyncAccount,
} from "./media-sync.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const NOW = new Date("2026-10-28T17:00:00.000Z");
// An Entra-shaped secret built in code, so no literal here looks like a credential.
const SECRET = `${"q8Z~".repeat(2)}${"x".repeat(26)}Wxyz`;
const ACCOUNT = "msa_ACCOUNTAAAAAAAAAAAA";
const SYNC = "msy_SYNCAAAAAAAAAAAAAAAA";
const FOLDER = "mfd_FOLDER1234567890AAAA";
const TENANT = "contoso.onmicrosoft.com";
const CLIENT = "0b1d2f3a-4c5e-4f60-8a7b-9c0d1e2f3a4b";
const FOLDER_URL = "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Lobby%20Signs";
const SHARING_LINK = "https://contoso.sharepoint.com/:f:/s/Marketing/EabcDEFghiJKL?e=Xy1Zq9";

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

async function enrolled(apiUrl = "https://api.screenrig.ai"): Promise<Env> {
  const configDir = await testTemp("media-sync-cfg-");
  const cwd = await testTemp("media-sync-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: apiUrl, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
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

const syncCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => /^\/api\/media-sync(?:-accounts|s)(?:\/|$)/.test(call.path));
const lastCall = (transport: FakeTransport): TransportRequest => syncCalls(transport).at(-1)!;
const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({ status, headers: { "content-type": "application/problem+json" }, body: { type: `https://screenrig.ai/problems/${code}`, title: code, status, code, detail } });

function account(overrides: Partial<MediaSyncAccount> = {}): MediaSyncAccount {
  return {
    id: ACCOUNT, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "microsoft365", name: "Contoso", config: { tenant_id: TENANT, client_id: CLIENT },
    secret: { set: true, hint: "Wxyz" }, state: "ready", last_test: null, revision: 1, created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

function sync(overrides: Partial<MediaSync> = {}): MediaSync {
  return {
    id: SYNC, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", account_id: ACCOUNT, provider: "sharepoint", name: "Lobby Signs", folder_id: FOLDER, every_s: 900, state: "active",
    source: { web_url: FOLDER_URL, drive_id: "b!TGl2ZURyaXZl", item_id: "01LOBBYSIGNS" }, next_run_at: "2026-10-28T17:00:00Z", last_run: null, revision: 1,
    created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

const RUN = {
  at: "2026-10-28T16:45:00Z", status: "partial", added: 3, updated: 1, removed: 1, pending_delete: 1, skipped_total: 22,
  skipped: [
    { name: "deck.pptx", reason: "unsupported_type", detail: "Show it with a document link instead." },
    { name: "Old", reason: "subfolder" },
  ],
};

/** A media sync backend of one account and one sync; writes echo what a server would answer. */
function backend(): FakeTransport {
  const transport = memoryBackend({ now: () => NOW });
  let current = sync({ last_run: RUN });
  transport
    .on("GET", "/api/media-sync-accounts", (req) => req.query?.cursor === "2"
      ? json(200, { items: [account({ id: "msa_SECONDAAAAAAAAAAAAA", name: "Second" })], next_cursor: null })
      : json(200, { items: [account()], next_cursor: "2" }))
    .on("POST", "/api/media-sync-accounts", (req) => {
      const body = req.body as { kind: string; name: string; config: { tenant_id: string; client_id: string }; secret: string };
      return json(201, account({ name: body.name, config: body.config, secret: { set: true, hint: body.secret.slice(-4) } }), { etag: '"1"' });
    })
    .on("GET", `/api/media-sync-accounts/${ACCOUNT}`, () => json(200, account({ last_test: { at: "2026-10-28T16:30:00Z", ok: true, checks: [
      { name: "credentials", ok: true, detail: "Microsoft issued an app token." },
      { name: "permissions", ok: true, warn: true, detail: "The app holds Sites.Selected." },
    ] } })))
    .on("PATCH", `/api/media-sync-accounts/${ACCOUNT}`, (req) => json(200, account({ revision: 2, ...((req.body as { name?: string }).name ? { name: (req.body as { name: string }).name } : {}) })))
    .on("DELETE", `/api/media-sync-accounts/${ACCOUNT}`, () => ({ status: 204, headers: {}, body: undefined }))
    .on("POST", `/api/media-sync-accounts/${ACCOUNT}/test`, () => json(200, { at: "2026-10-28T17:00:00Z", ok: false, checks: [{ name: "credentials", ok: false, detail: "Microsoft refused the app's credentials: AADSTS7000215: Invalid client secret provided." }] }))
    .on("GET", "/api/media-syncs", () => json(200, { items: [current], next_cursor: null }))
    .on("POST", "/api/media-syncs", (req) => {
      const body = req.body as Record<string, any>;
      current = sync({ name: body.name ?? "Lobby Signs", folder_id: body.folder_id ?? FOLDER, every_s: body.every ?? 900 });
      return json(201, current, { etag: '"1"' });
    })
    .on("GET", `/api/media-syncs/${SYNC}`, () => json(200, current))
    .on("PATCH", `/api/media-syncs/${SYNC}`, (req) => {
      const body = req.body as Record<string, any>;
      current = sync({ ...current, ...(body.name ? { name: body.name } : {}), ...(body.every ? { every_s: body.every } : {}), ...(body.state ? { state: body.state } : {}), revision: current.revision + 1 });
      return json(200, current);
    })
    .on("DELETE", `/api/media-syncs/${SYNC}`, () => ({ status: 204, headers: {}, body: undefined }))
    .on("POST", `/api/media-syncs/${SYNC}/run`, () => json(202, sync({ next_run_at: "2026-10-28T17:00:00Z" })));
  return transport;
}

test("the parsers read cadences, tenants, application ids and addresses", () => {
  assert.equal(mediaSyncEvery("15m"), "900");
  assert.equal(mediaSyncEvery("1h30m"), "5400");
  assert.equal(mediaSyncEvery("24h"), "86400");
  assert.equal(mediaSyncEvery("5m"), "300");
  assert.equal(mediaSyncEvery("900"), "900");
  for (const bad of ["299", "4m59s", "25h", "86401", "0", "soon", "", "1w"]) assert.throws(() => mediaSyncEvery(bad), /--every takes a duration/, bad);
  assert.equal(mediaSyncTenant("Contoso.OnMicrosoft.com"), "Contoso.OnMicrosoft.com");
  assert.equal(mediaSyncTenant("8a1f2b3c-4d5e-4f60-9a7b-0c1d2e3f4a5b"), "8a1f2b3c-4d5e-4f60-9a7b-0c1d2e3f4a5b");
  for (const bad of ["common", "Organizations", "consumers", "not a tenant", "contoso", ""]) assert.throws(() => mediaSyncTenant(bad), /--tenant-id/, bad);
  assert.equal(mediaSyncClientId(CLIENT.toUpperCase()), CLIENT.toUpperCase());
  assert.throws(() => mediaSyncClientId("app-1"), /application \(client\) id/);
  assert.equal(mediaSyncUrl(FOLDER_URL), FOLDER_URL);
  for (const bad of ["http://contoso.sharepoint.com/sites/x", "ftp://x.example.com", "Lobby Signs", "", "https://x.example.com/a\u0007b"]) assert.throws(() => mediaSyncUrl(bad), /--url takes/, bad);
  assert.match(ACCOUNT, MEDIA_SYNC_ACCOUNT_ID_PATTERN);
  assert.match(`stage_${SYNC}`, MEDIA_SYNC_ID_PATTERN);
  assert.doesNotMatch(ACCOUNT, MEDIA_SYNC_ID_PATTERN);
});

test("account add reads the secret from a file or stdin and never prints it", async () => {
  const env = await enrolled();
  const transport = backend();
  await writeFile(path.join(env.cwd, "secret.txt"), `${SECRET}\n`);
  const added = await cli(["--json", "media", "sync", "account", "add", "microsoft365", "--name", "Contoso", "--tenant-id", TENANT, "--client-id", CLIENT, "--secret-file", "secret.txt"], transport, env);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/media-sync-accounts");
  assert.deepEqual(call.body, { kind: "microsoft365", name: "Contoso", config: { tenant_id: TENANT, client_id: CLIENT }, secret: SECRET });
  assert.ok(call.headers?.["Idempotency-Key"] ?? call.headers?.["idempotency-key"], "a write carries an idempotency key");
  assert.deepEqual(added.envelope.data.secret, { set: true, hint: "Wxyz" });
  assert.doesNotMatch(added.stdout + added.stderr, new RegExp(SECRET));

  const human = await cli(["--human", "media", "sync", "account", "add", "microsoft365", "--name", "Contoso", "--tenant-id", TENANT, "--client-id", CLIENT, "--secret-file", "-"], transport, env,
    { stdin: Readable.from([Buffer.from(`${SECRET}\n`)]), isStdinTty: () => false });
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.equal((lastCall(transport).body as { secret: string }).secret, SECRET);
  assert.match(human.stdout, /^Created media sync account msa_/m);
  assert.match(human.stdout, /^secret: set \(ends Wxyz\)$/m);
  assert.match(human.stdout, /Next: screenrig media sync account test/);
  assert.doesNotMatch(human.stdout + human.stderr, new RegExp(SECRET));
});

test("account add refuses a missing, empty or malformed secret and a secret on the command line", async () => {
  const env = await enrolled();
  const transport = backend();
  await writeFile(path.join(env.cwd, "empty.txt"), "\n");
  await writeFile(path.join(env.cwd, "two.txt"), "one two\n");
  const base = ["--json", "media", "sync", "account", "add", "microsoft365", "--name", "Contoso", "--tenant-id", TENANT, "--client-id", CLIENT];
  for (const [args, pattern] of [
    [[...base], /--secret-file/],
    [[...base, "--secret-file", "empty.txt"], /holds no secret/],
    [[...base, "--secret-file", "two.txt"], /only the client secret/],
    [[...base, "--secret-file", "missing.txt"], /does not exist/],
    [[...base, "--secret-file", "empty.txt", "--secret", SECRET], /does not accept --secret|unknown option/i],
    [["--json", "media", "sync", "account", "add", "microsoft365", "--name", "x", "--tenant-id", "common", "--client-id", CLIENT, "--secret-file", "empty.txt"], /--tenant-id/],
    [["--json", "media", "sync", "account", "add", "microsoft365", "--name", "x", "--tenant-id", TENANT, "--client-id", "app-1", "--secret-file", "empty.txt"], /client\) id/],
  ] as Array<[string[], RegExp]>) {
    const result = await cli(args, transport, env);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? result.stderr, pattern);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SECRET));
  }
  assert.equal(syncCalls(transport).length, 0, "nothing was sent");
});

test("the operation log keeps the secret and the sharing link out", async () => {
  const env = await enrolled();
  const transport = backend();
  await writeFile(path.join(env.cwd, "secret.txt"), `${SECRET}\n`);
  // One logger per invocation: a run closes its logger when it ends.
  const addLog = createMemoryLogger({ command: ["media", "sync"] });
  const createLog = createMemoryLogger({ command: ["media", "sync"] });
  const added = await cli(["--json", "media", "sync", "account", "add", "microsoft365", "--name", "Contoso", "--tenant-id", TENANT, "--client-id", CLIENT, "--secret-file", "secret.txt"], transport, env, { logger: addLog.logger });
  const created = await cli(["--json", "media", "sync", "create", "sharepoint", "--account-id", ACCOUNT, "--url", SHARING_LINK], transport, env, { logger: createLog.logger });
  assert.equal(added.code, 0, added.stderr);
  assert.equal(created.code, 0, created.stderr);
  for (const output of [added, created]) assert.doesNotMatch(output.stdout + output.stderr, new RegExp(SECRET));
  assert.doesNotMatch(created.stdout + created.stderr, /EabcDEFghiJKL/, "the sharing link is never echoed");
  for (const { events } of [addLog, createLog]) {
    assert.ok(events.some((event) => (event as { path?: string }).path?.startsWith("/api/media-sync")), "the operation log recorded the request");
  }
  assert.doesNotMatch(JSON.stringify(addLog.events), new RegExp(SECRET), "the client secret never reaches the operation log");
  assert.doesNotMatch(JSON.stringify(createLog.events), /EabcDEFghiJKL|e=Xy1Zq9/, "the sharing link never reaches the operation log");
  assert.doesNotMatch(JSON.stringify(createLog.events), new RegExp(FOLDER_URL.replaceAll(".", "\\.")), "no request body is logged for a media sync");
  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, new RegExp(SECRET), "the secret never reaches config");
});

test("account list, show, test, update and delete", async () => {
  const env = await enrolled();
  const transport = backend();
  const list = await cli(["--human", "media", "sync", "account", "list"], transport, env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^Media sync accounts \(2\)$/m);
  assert.match(list.stdout, /^ID\s+NAME\s+KIND\s+STATE\s+ACCOUNT\s+SECRET\s+TEST$/m);
  assert.match(list.stdout, new RegExp(`^${ACCOUNT}\\s+Contoso\\s+microsoft365\\s+ready\\s+${TENANT.replaceAll(".", "\\.")}\\s+…Wxyz\\s+never$`, "m"));
  assert.match(list.stdout, /msa_SECONDAAAAAAAAAAAAA\s+Second/, "every page is read");

  const show = await cli(["--human", "media", "sync", "account", "show", ACCOUNT], transport, env);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`^tenant: ${TENANT.replaceAll(".", "\\.")}$`, "m"));
  assert.match(show.stdout, /^last test: ok at 2026-10-28T16:30:00Z$/m);
  assert.match(show.stdout, /^  warning permissions: The app holds Sites\.Selected\.$/m);

  const tested = await cli(["--human", "media", "sync", "account", "test", ACCOUNT], transport, env);
  assert.equal(tested.code, 0, tested.stderr);
  assert.match(tested.stdout, new RegExp(`^Media sync account ${ACCOUNT}: failed$`, "m"));
  assert.match(tested.stdout, /AADSTS7000215/);
  assert.equal((await cli(["--json", "media", "sync", "account", "test", ACCOUNT], transport, env)).envelope.data.ok, false);

  const secretFile = path.join(env.cwd, "new.txt");
  await writeFile(secretFile, `${SECRET}\n`);
  const updated = await cli(["--json", "media", "sync", "account", "update", ACCOUNT, "--name", "Renamed", "--client-id", CLIENT, "--secret-file", secretFile, "--expect-rev", "1"], transport, env);
  assert.equal(updated.code, 0, updated.stdout);
  const patch = lastCall(transport);
  assert.equal(patch.method, "PATCH");
  assert.deepEqual(patch.body, { name: "Renamed", config: { client_id: CLIENT }, secret: SECRET });
  assert.equal(patch.headers?.["if-match"], '"1"');
  assert.equal((await cli(["--json", "media", "sync", "account", "update", ACCOUNT], transport, env)).code, 2, "an update must change something");

  const removed = await cli(["--json", "media", "sync", "account", "delete", ACCOUNT], transport, env);
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual(removed.envelope.data, { id: ACCOUNT, deleted: true });
  assert.equal(lastCall(transport).method, "DELETE");
  assert.equal((await cli(["--json", "media", "sync", "account", "show", "nope"], transport, env)).code, 2);
});

test("sync create sends the address as given, a cadence in seconds and the folder", async () => {
  const env = await enrolled();
  const transport = backend();
  const created = await cli(["--json", "media", "sync", "create", "sharepoint", "--account-id", ACCOUNT, "--url", FOLDER_URL, "--folder-id", FOLDER, "--every", "1h", "--name", "Lobby loop"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/media-syncs");
  assert.deepEqual(call.body, { provider: "sharepoint", account_id: ACCOUNT, url: FOLDER_URL, folder_id: FOLDER, every: 3600, name: "Lobby loop" });
  assert.ok(call.headers?.["Idempotency-Key"] ?? call.headers?.["idempotency-key"]);
  assert.equal(created.envelope.data.every_s, 3600);

  const minimal = await cli(["--human", "media", "sync", "create", "sharepoint", "--account-id", ACCOUNT, "--url", SHARING_LINK], transport, env);
  assert.equal(minimal.code, 0, minimal.stdout + minimal.stderr);
  assert.deepEqual(lastCall(transport).body, { provider: "sharepoint", account_id: ACCOUNT, url: SHARING_LINK });
  assert.match(minimal.stdout, /^Created media sync msy_/m);
  assert.match(minimal.stdout, /^media folder: mfd_/m);
  assert.match(minimal.stdout, /\{"by": "folder", "folder_id": "mfd_/, "the next step is the folder selector");

  for (const [args, pattern] of [
    [["--account-id", ACCOUNT], /requires --account-id and --url|--url/],
    [["--url", FOLDER_URL], /--account-id/],
    [["--account-id", "acc_1", "--url", FOLDER_URL], /msa_/],
    [["--account-id", ACCOUNT, "--url", "http://contoso.sharepoint.com/sites/x"], /--url takes/],
    [["--account-id", ACCOUNT, "--url", FOLDER_URL, "--every", "1m"], /--every takes a duration/],
    [["--account-id", ACCOUNT, "--url", FOLDER_URL, "--folder-id", "med_1"], /mfd_/],
  ] as Array<[string[], RegExp]>) {
    const before = syncCalls(transport).length;
    const result = await cli(["--json", "media", "sync", "create", "sharepoint", ...args], transport, env);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? result.stderr, pattern);
    assert.equal(syncCalls(transport).length, before, "a refused command sends nothing");
  }
});

test("sync list, show, update, run and delete", async () => {
  const env = await enrolled();
  const transport = backend();
  const list = await cli(["--human", "media", "sync", "list"], transport, env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^Media syncs \(1\)$/m);
  assert.match(list.stdout, /^ID\s+NAME\s+PROVIDER\s+FOLDER\s+EVERY\s+STATE\s+LAST RUN$/m);
  assert.match(list.stdout, new RegExp(`^${SYNC}\\s+Lobby Signs\\s+sharepoint\\s+${FOLDER}\\s+15m\\s+active\\s+partial$`, "m"));

  const show = await cli(["--human", "media", "sync", "show", SYNC], transport, env);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, new RegExp(`^source: ${FOLDER_URL.replaceAll(".", "\\.")}$`, "m"));
  assert.match(show.stdout, /^last run: partial at 2026-10-28T16:45:00Z \(3 added, 1 replaced, 1 removed, 1 held back\)$/m);
  assert.match(show.stdout, /^  skipped deck\.pptx \(unsupported_type\): Show it with a document link instead\.$/m);
  assert.match(show.stdout, /^  skipped Old \(subfolder\)$/m);
  assert.match(show.stdout, /^  and 20 more skipped$/m);
  assert.match(show.stdout, new RegExp(`\\{"by": "folder", "folder_id": "${FOLDER}"\\}`));

  const paused = await cli(["--json", "media", "sync", "update", SYNC, "--pause", "--every", "6h", "--name", "Lobby", "--expect-rev", "1"], transport, env);
  assert.equal(paused.code, 0, paused.stdout);
  const patch = lastCall(transport);
  assert.equal(patch.method, "PATCH");
  assert.deepEqual(patch.body, { name: "Lobby", every: 21600, state: "paused" });
  assert.equal(patch.headers?.["if-match"], '"1"');
  const resumed = await cli(["--json", "media", "sync", "update", SYNC, "--resume", "--folder-id", FOLDER], transport, env);
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.deepEqual(lastCall(transport).body, { folder_id: FOLDER, state: "active" });
  assert.equal((await cli(["--json", "media", "sync", "update", SYNC], transport, env)).code, 2, "an update must change something");
  assert.equal((await cli(["--json", "media", "sync", "update", SYNC, "--pause", "--resume"], transport, env)).code, 2, "pause and resume conflict");

  const ran = await cli(["--human", "media", "sync", "run", SYNC], transport, env);
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(lastCall(transport).method, "POST");
  assert.equal(lastCall(transport).path, `/api/media-syncs/${SYNC}/run`);
  assert.match(ran.stdout, /due now/);

  const removed = await cli(["--json", "media", "sync", "delete", SYNC], transport, env);
  assert.equal(removed.code, 0, removed.stdout);
  assert.deepEqual(removed.envelope.data, { id: SYNC, deleted: true });
  assert.equal((await cli(["--json", "media", "sync", "show", "nope"], transport, env)).code, 2);
});

test("media sync problems name the next command", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW })
    .on("POST", "/api/media-syncs", () => problem(409, "media_sync_source_refused", "Microsoft Graph refused the app: grant it the site (Sites.Selected) or Files.Read.All, with admin consent."))
    .on("POST", "/api/media-sync-accounts/msa_DOWNAAAAAAAAAAAAAAA/test", () => problem(500, "media_sync_source_unavailable", "Microsoft's sign-in could not be reached."))
    .on("DELETE", "/api/media-sync-accounts/msa_USEDAAAAAAAAAAAAAAA", () => problem(409, "resource_conflict", "The account is used by syncs (msy_X)."))
    .on("GET", "/api/media-syncs/msy_GONEAAAAAAAAAAAAAAA", () => problem(404, "not_found", "The media sync resource was not found in this project."))
    .on("PATCH", `/api/media-syncs/${SYNC}`, () => problem(412, "revision_conflict", "The media sync revision does not match If-Match."));
  const refused = await cli(["--json", "media", "sync", "create", "sharepoint", "--account-id", ACCOUNT, "--url", FOLDER_URL], transport, env);
  assert.equal(refused.code, 5);
  assert.equal(refused.envelope.error?.code, "media_sync_source_refused");
  assert.equal(refused.envelope.error?.next?.command, `screenrig media sync account test ${ACCOUNT}`);
  assert.match(refused.envelope.error?.next?.reason ?? "", /Sites\.Selected/);
  const down = await cli(["--json", "media", "sync", "account", "test", "msa_DOWNAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(down.code, 9);
  assert.equal(down.envelope.error?.code, "media_sync_source_unavailable");
  const used = await cli(["--json", "media", "sync", "account", "delete", "msa_USEDAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(used.code, 5);
  assert.equal(used.envelope.error?.next?.command, "screenrig media sync list");
  const gone = await cli(["--json", "media", "sync", "show", "msy_GONEAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(gone.code, 4);
  assert.equal(gone.envelope.error?.next?.command, "screenrig media sync list");
  const stale = await cli(["--json", "media", "sync", "update", SYNC, "--pause", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, 6);
  assert.equal(stale.envelope.error?.next?.command, `screenrig media sync show ${SYNC}`);
});

test("the renderers show the secret only as its hint and the last run in full", () => {
  const lines = accountLines(account({ secret: { set: false, hint: "" } }));
  assert.ok(lines.includes("secret: not set"));
  assert.ok(accountLines(account()).includes("secret: set (ends Wxyz)"));
  assert.ok(syncLines(sync()).includes("last run: not yet"));
  assert.deepEqual(syncTableLines([]), ["No media syncs"]);
  assert.ok(syncTableLines([sync({ every_s: 300 })]).at(-1)!.includes("5m"));
  assert.ok(syncLines(sync({ last_run: { ...RUN, status: "error", error: { code: "folder_missing", detail: "The media folder was deleted." }, skipped: [], skipped_total: 0 } }))
    .some((line) => line === "  folder_missing: The media folder was deleted."));
});

test("help names the account flow, the secret file and the folder selector", () => {
  const group = commandHelp(["media", "sync"]);
  assert.match(group.notes.join("\n"), /Sites\.Selected/);
  assert.match(group.notes.join("\n"), /folder selector/);
  for (const [words, example] of [
    [["media", "sync", "account", "add", "microsoft365"], "screenrig media sync account add microsoft365"],
    [["media", "sync", "account", "list"], "screenrig media sync account list"],
    [["media", "sync", "account", "update"], "screenrig media sync account update"],
    [["media", "sync", "account", "test"], "screenrig media sync account test"],
    [["media", "sync", "create", "sharepoint"], "screenrig media sync create sharepoint"],
    [["media", "sync", "list"], "screenrig media sync list"],
    [["media", "sync", "update"], "screenrig media sync update"],
    [["media", "sync", "run"], "screenrig media sync run"],
    [["media", "sync", "delete"], "screenrig media sync delete"],
  ] as Array<[string[], string]>) {
    const help = commandHelp(words);
    assert.ok(help.examples.length > 0, words.join(" "));
    assert.ok(help.examples.every((text) => text.startsWith(example)), words.join(" "));
  }
  const add = commandHelp(["media", "sync", "account", "add", "microsoft365"]);
  assert.match(add.notes.join("\n"), /never an argument/);
  assert.ok(add.examples.every((text) => text.includes("--secret-file") || text.includes("--connection-id")), "the example reads the secret from a file, or holds none because a connection signs in");
  assert.ok(add.options.some((option: { flags?: string; name?: string }) => (option.flags ?? option.name ?? "").includes("--secret-file")));
});

test("media sync account add microsoft365 reads through a Microsoft connection instead of an app of its own", async () => {
  const env = await enrolled();
  const bodies: Array<Record<string, any>> = [];
  const transport = new FakeTransport()
    .on("POST", "/api/media-sync-accounts", (req) => {
      bodies.push(req.body as Record<string, any>);
      const body = req.body as { name: string; config: { connection_id?: string } };
      return json(201, account({ name: body.name, config: body.config, secret: { set: false, hint: "" } }), { etag: '"1"' });
    })
    .on("GET", "/api/media-sync-accounts", () => json(200, { items: [account({ config: { connection_id: "pcn_CONNECTION" }, secret: { set: false, hint: "" } }), account({ id: "msa_OWNAAAAAAAAAAAAAAAA" })], next_cursor: null }));
  const created = await cli(["--human", "media", "sync", "account", "add", "microsoft365", "--name", "Contoso", "--connection-id", "pcn_CONNECTION"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual(bodies.at(-1), { kind: "microsoft365", name: "Contoso", config: { connection_id: "pcn_CONNECTION" } }, "no tenant, app or secret: the connection holds them");
  assert.equal(lastCall(transport).headers?.["idempotency-key"] !== undefined, true, "a create is an idempotent write");
  assert.match(created.stdout, /^connection: pcn_CONNECTION \(a Microsoft connection signs in; this account holds no secret\)$/m);
  assert.ok(!/^tenant:|^secret:/m.test(created.stdout), "an account that reads through a connection shows neither tenant nor secret");
  assert.match(created.stdout, /Next: screenrig media sync account test msa_/);

  const own = await cli(["--json", "media", "sync", "account", "add", "microsoft365", "--name", "Contoso", "--tenant-id", TENANT, "--client-id", CLIENT, "--secret-file", "-"], transport, env, { stdin: Readable.from([Buffer.from(`${SECRET}\n`)]), isStdinTty: () => false });
  assert.equal(own.code, 0, own.stdout + own.stderr);
  assert.deepEqual(bodies.at(-1), { kind: "microsoft365", name: "Contoso", config: { tenant_id: TENANT, client_id: CLIENT }, secret: SECRET });

  const listed = await cli(["--human", "media", "sync", "account", "list"], transport, env);
  assert.match(listed.stdout, /^msa_ACCOUNTAAAAAAAAAAAA\s+Contoso\s+microsoft365\s+ready\s+pcn_CONNECTION\s+via connection\s+never$/m);
  assert.match(listed.stdout, /^msa_OWNAAAAAAAAAAAAAAAA\s+Contoso\s+microsoft365\s+ready\s+contoso\.onmicrosoft\.com\s+…Wxyz\s+never$/m);

  const before = bodies.length;
  for (const [argv, pattern] of [
    [["--name", "Contoso", "--connection-id", "pcn_CONNECTION", "--tenant-id", TENANT], /--connection-id|--tenant-id/],
    [["--name", "Contoso", "--connection-id", "pcn_CONNECTION", "--secret-file", "secret.txt"], /--connection-id|--secret-file/],
    [["--name", "Contoso", "--connection-id", "bic_CONNECTION"], /--connection-id takes a connection id \(pcn_…\)/],
    [["--name", "Contoso"], /Provide exactly one of --connection-id or --tenant-id/],
    [["--name", "Contoso", "--tenant-id", TENANT, "--client-id", CLIENT], /--tenant-id and --client-id and --secret-file together/],
    [["--connection-id", "pcn_CONNECTION"], /required option '--name <NAME>' not specified|--name/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "media", "sync", "account", "add", "microsoft365", ...argv], transport, env);
    assert.equal(refused.code, 2, argv.join(" "));
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, argv.join(" "));
  }
  assert.equal(bodies.length, before, "nothing was sent");
  const help = commandHelp(["media", "sync", "account", "add", "microsoft365"]);
  assert.ok(help.options.some((option: { name: string }) => option.name === "--connection-id"));
  assert.ok(help.options.find((option: { name: string }) => option.name === "--tenant-id")!.required === false);
  assert.ok(help.examples.some((example) => example.includes("--connection-id pcn_CONNECTION")));
  assert.match(help.notes.join("\n"), /Microsoft connection of this project, in either mode/);
  assert.match(commandHelp(["media", "sync"]).usage, /Microsoft connection of the project/);
});

// ---- Dropbox and Google Drive

const DROPBOX_ACCOUNT = "msa_DROPBOXAAAAAAAAAAAA";
const DRIVE_ACCOUNT = "msa_DRIVEAAAAAAAAAAAAAA";
const OWN_APP = "APPKEY123456";
const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize?client_id=APPKEY123456&response_type=code&state=STATE1234abcd&code_challenge_method=S256";
const AUTHORIZE_EXPIRES = "2026-10-28T17:15:00Z";
const SCREENRIG_ADDRESS = "drive-sync@screenrig-sync.iam.gserviceaccount.com";
const OWN_ADDRESS = "rooms@project.iam.gserviceaccount.com";
const DRIVE_FOLDER = "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz";
const DRIVE_FOLDER_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
const DROPBOX_FOLDER = "https://www.dropbox.com/home/Marketing/Lobby%20Signs";
// A PEM-shaped key built in code, so no literal here looks like a credential.
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${"M".repeat(64)}\n-----END PRIVATE KEY-----\n`;
const SERVICE_KEY = { type: "service_account", project_id: "project", private_key_id: "abc123", private_key: PRIVATE_KEY, client_email: OWN_ADDRESS, client_id: "123", token_uri: "https://oauth2.googleapis.com/token" };
const KEY_LEAK = /BEGIN PRIVATE KEY|MMMMMMMM|LEAKMARKER/;

const stdinOf = (text: string): Partial<CliRuntime> => ({ stdin: Readable.from([Buffer.from(text)]), isStdinTty: () => false });
const idempotencyKey = (call: TransportRequest): string | undefined => call.headers?.["Idempotency-Key"] ?? call.headers?.["idempotency-key"];

function dropboxAccount(overrides: Partial<MediaSyncAccount> = {}): MediaSyncAccount {
  return {
    id: DROPBOX_ACCOUNT, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "dropbox", name: "Marketing Dropbox", config: {},
    secret: { set: false, hint: "" }, state: "pending_consent", last_test: null, revision: 1, created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

function driveAccount(overrides: Partial<MediaSyncAccount> = {}): MediaSyncAccount {
  return {
    id: DRIVE_ACCOUNT, project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "google_drive", name: "Marketing Drive", config: { service_account_email: SCREENRIG_ADDRESS },
    secret: { set: false, hint: "" }, state: "ready", last_test: null, revision: 1, created_at: "2026-10-28T16:00:00Z", updated_at: "2026-10-28T16:00:00Z", ...overrides,
  };
}

const withLink = (account: MediaSyncAccount): MediaSyncAccount => ({ ...account, authorize_url: AUTHORIZE_URL, authorize_expires_at: AUTHORIZE_EXPIRES });

/** A server of Dropbox and Google Drive accounts and syncs; writes echo what the real one answers. */
function providerBackend(): FakeTransport {
  return new FakeTransport()
    .on("POST", "/api/media-sync-accounts", (req) => {
      const body = req.body as { kind: string; name: string; config?: { app_key?: string }; secret?: string };
      if (body.kind === "dropbox") return json(201, withLink(dropboxAccount({ name: body.name, config: body.config ?? {} })), { etag: '"1"' });
      return json(201, driveAccount({ name: body.name, ...(body.secret ? { config: { service_account_email: OWN_ADDRESS }, secret: { set: true, hint: "c3d4" } } : {}) }), { etag: '"1"' });
    })
    .on("POST", `/api/media-sync-accounts/${DROPBOX_ACCOUNT}/connect`, () => json(200, withLink(dropboxAccount({
      state: "reconnect_required", config: { display_name: "Ada Lovelace", email: "ada@example.com" }, secret: { set: true, hint: "" },
    }))))
    .on("PATCH", `/api/media-sync-accounts/${DRIVE_ACCOUNT}`, (req) => json(200, driveAccount({
      revision: 2, ...((req.body as { secret?: string }).secret ? { config: { service_account_email: OWN_ADDRESS }, secret: { set: true, hint: "e5f6" } } : {}),
    })))
    .on("POST", "/api/media-syncs", (req) => {
      const body = req.body as { provider: string; account_id: string; url: string; folder_id?: string; every?: number; name?: string };
      const dropbox = body.provider === "dropbox";
      return json(201, sync({
        provider: body.provider, account_id: body.account_id, name: body.name ?? "Lobby Signs", folder_id: body.folder_id ?? FOLDER, every_s: body.every ?? 900,
        source: dropbox
          ? { web_url: body.url.startsWith("/") ? `https://www.dropbox.com/home${body.url}` : body.url, item_id: "id:AAAA", path: "/Marketing/Lobby Signs" }
          : { web_url: DRIVE_FOLDER, item_id: DRIVE_FOLDER_ID, shared_by: "member@example.com" },
      }), { etag: '"1"' });
    });
}

test("the parsers read Dropbox app keys and folders and Google Drive folders", () => {
  assert.equal(mediaSyncAppKey(` ${OWN_APP} `), OWN_APP);
  for (const bad of ["", "has space", "x".repeat(65), "with-dash", "ünicode"]) assert.throws(() => mediaSyncAppKey(bad), /--app-key takes the app key of your own Dropbox app/, bad);
  for (const good of [DROPBOX_FOLDER, "https://www.dropbox.com/scl/fo/abc123/def456?rlkey=xyz&dl=0", "/Marketing/Lobby Signs"]) assert.equal(mediaSyncDropboxUrl(good), good);
  for (const bad of ["Marketing", "http://www.dropbox.com/home/x", "", "ftp://x.example.com", "/a\u0007b", "https://x.example.com/a\u0007b"]) {
    assert.throws(() => mediaSyncDropboxUrl(bad), /--url takes the folder's address in Dropbox/, bad);
  }
  for (const good of [DRIVE_FOLDER, DRIVE_FOLDER_ID, "0B_a-Z9"]) assert.equal(mediaSyncDriveUrl(good), good);
  for (const bad of ["My Folder", "http://drive.google.com/drive/folders/1Ab", "", "a/b", "folder\u0007"]) {
    assert.throws(() => mediaSyncDriveUrl(bad), /--url takes the Google Drive folder's address/, bad);
  }
});

test("account add dropbox prints the one-time link and its expiry, and keeps the link out of the operation log", async () => {
  const env = await enrolled();
  const transport = providerBackend();
  const log = createMemoryLogger({ command: ["media", "sync"] });
  const added = await cli(["--json", "media", "sync", "account", "add", "dropbox", "--name", "Marketing Dropbox"], transport, env, { logger: log.logger });
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/media-sync-accounts");
  assert.deepEqual(call.body, { kind: "dropbox", name: "Marketing Dropbox" }, "no app key: the account goes through screenRIG's Dropbox app");
  assert.ok(idempotencyKey(call), "a create is an idempotent write");
  assert.equal(added.envelope.data.authorize_url, AUTHORIZE_URL);
  assert.equal(added.envelope.data.authorize_expires_at, AUTHORIZE_EXPIRES);
  assert.equal(added.envelope.data.state, "pending_consent");
  const warning = added.envelope.warnings?.find((item) => item.code === "media_sync_consent_link");
  assert.match(warning?.message ?? "", /send it to the person who owns the Dropbox account/);
  assert.ok(warning?.message.includes(`before ${AUTHORIZE_EXPIRES}`));
  assert.ok(warning?.message.includes(`screenrig media sync account connect ${DROPBOX_ACCOUNT}`));
  assert.ok(!added.envelope.warnings?.some((item) => item.code === "media_sync_redirect_uri"), "screenRIG's own app needs no redirect URI from the customer");
  assert.doesNotMatch(JSON.stringify(log.events), /oauth2\/authorize|STATE1234abcd/, "the consent link never reaches the operation log");

  const human = await cli(["--human", "media", "sync", "account", "add", "dropbox", "--name", "Marketing Dropbox"], transport, env);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^Created media sync account msa_DROPBOXAAAAAAAAAAAA$/m);
  assert.match(human.stdout, /^kind: dropbox$/m);
  assert.match(human.stdout, /^dropbox account: not connected$/m);
  assert.match(human.stdout, /^app: screenRIG's Dropbox app$/m);
  assert.match(human.stdout, /^state: pending_consent$/m);
  assert.match(human.stdout, /^Connect link, for the person who owns the Dropbox account\. Send it to that person only, or open it yourself if that is you: it is the credential of one consent, and works once until 2026-10-28T17:15:00Z\.$/m);
  assert.ok(human.stdout.includes(`authorize_url: ${AUTHORIZE_URL}`));
  assert.match(human.stdout, /allow screenRIG read-only access to the files in that Dropbox \(files\.metadata\.read, files\.content\.read, account_info\.read\)\. The CLI never opens a browser\./);
  assert.match(human.stdout, /^Then: screenrig media sync create dropbox --account-id msa_DROPBOXAAAAAAAAAAAA --url FOLDER$/m);
  assert.doesNotMatch(human.stdout, /redirect URI/);
});

test("account add dropbox --app-key names the redirect URI of the API origin the CLI uses", async () => {
  const env = await enrolled("https://api.example.test");
  const transport = providerBackend();
  const added = await cli(["--human", "media", "sync", "account", "add", "dropbox", "--name", "Own app", "--app-key", OWN_APP], transport, env);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  assert.deepEqual(lastCall(transport).body, { kind: "dropbox", name: "Own app", config: { app_key: OWN_APP } });
  assert.match(added.stdout, new RegExp(`^app: your own Dropbox app \\(app key ${OWN_APP}\\)$`, "m"));
  assert.ok(added.stdout.includes("must list https://api.example.test/api/dropbox/callback as a redirect URI"));
  const asJson = await cli(["--json", "media", "sync", "account", "add", "dropbox", "--name", "Own app", "--app-key", OWN_APP], transport, env);
  const redirect = asJson.envelope.warnings?.find((item) => item.code === "media_sync_redirect_uri");
  assert.ok(redirect?.message.includes("https://api.example.test/api/dropbox/callback"));
  assert.ok(asJson.envelope.warnings?.some((item) => item.code === "media_sync_consent_link"));
  const silent = new FakeTransport().on("POST", "/api/media-sync-accounts", () => json(201, withLink(dropboxAccount()), { etag: '"1"' }));
  const unechoed = await cli(["--human", "media", "sync", "account", "add", "dropbox", "--name", "Own app", "--app-key", OWN_APP], silent, env);
  assert.equal(unechoed.code, 0, unechoed.stdout + unechoed.stderr);
  assert.ok(unechoed.stdout.includes("must list https://api.example.test/api/dropbox/callback as a redirect URI"), "the instruction follows the --app-key the command named, not only the answer");

  const before = syncCalls(transport).length;
  for (const [args, pattern] of [
    [["--name", "Own app", "--app-key", "not valid!"], /--app-key takes the app key of your own Dropbox app/],
    [["--name", "Own app", "--app-key", "x".repeat(65)], /--app-key takes/],
    [["--app-key", OWN_APP], /required option '--name <NAME>' not specified|--name/],
    [["--name", "Own app", "--key-file", "key.json"], /does not accept --key-file|unknown option/i],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "media", "sync", "account", "add", "dropbox", ...args], transport, env);
    assert.equal(refused.code, 2, args.join(" "));
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, args.join(" "));
  }
  assert.equal(syncCalls(transport).length, before, "nothing was sent");
});

test("account connect makes a new link, and a bad id sends nothing", async () => {
  const env = await enrolled();
  const transport = providerBackend();
  const log = createMemoryLogger({ command: ["media", "sync"] });
  const connected = await cli(["--human", "media", "sync", "account", "connect", DROPBOX_ACCOUNT], transport, env, { logger: log.logger });
  assert.equal(connected.code, 0, connected.stdout + connected.stderr);
  assert.doesNotMatch(JSON.stringify(log.events), /oauth2\/authorize|STATE1234abcd/, "the consent link never reaches the operation log");
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/media-sync-accounts/${DROPBOX_ACCOUNT}/connect`);
  assert.ok(idempotencyKey(call), "a connect is an idempotent write");
  assert.match(connected.stdout, new RegExp(`^New connect link for media sync account ${DROPBOX_ACCOUNT}\\. Any earlier link no longer works; a connected account stays connected until the new consent completes\\.$`, "m"));
  assert.match(connected.stdout, /^dropbox account: Ada Lovelace \(ada@example\.com\)$/m);
  assert.match(connected.stdout, /^state: reconnect_required$/m);
  assert.ok(connected.stdout.includes(`authorize_url: ${AUTHORIZE_URL}`));
  const asJson = await cli(["--json", "media", "sync", "account", "connect", DROPBOX_ACCOUNT], transport, env);
  assert.equal(asJson.envelope.data.authorize_url, AUTHORIZE_URL);
  assert.ok(asJson.envelope.warnings?.some((item) => item.code === "media_sync_consent_link"));

  const before = syncCalls(transport).length;
  const bad = await cli(["--json", "media", "sync", "account", "connect", "nope"], transport, env);
  assert.equal(bad.code, 2);
  assert.match(bad.envelope.error?.detail ?? "", /msa_/);
  assert.equal((await cli(["--json", "media", "sync", "account", "connect"], transport, env)).code, 2, "an id is required");
  assert.equal(syncCalls(transport).length, before, "nothing was sent");
});

test("account add google-drive names the address to share with, screenRIG's or the account's own", async () => {
  const env = await enrolled();
  const transport = providerBackend();
  const log = createMemoryLogger({ command: ["media", "sync"] });
  const shared = await cli(["--json", "media", "sync", "account", "add", "google-drive", "--name", "Marketing Drive"], transport, env, { logger: log.logger });
  assert.equal(shared.code, 0, shared.stdout + shared.stderr);
  assert.deepEqual(lastCall(transport).body, { kind: "google_drive", name: "Marketing Drive" }, "no key: the account reads through screenRIG's service account");
  assert.ok(idempotencyKey(lastCall(transport)));
  assert.equal(shared.envelope.data.config.service_account_email, SCREENRIG_ADDRESS);
  const warning = shared.envelope.warnings?.find((item) => item.code === "media_sync_share_folder");
  assert.ok(warning?.message.includes(`Share the Google Drive folder with ${SCREENRIG_ADDRESS} (Viewer is enough)`));
  assert.match(warning?.message ?? "", /member of this project with a verified email shared it or owns it/);

  const human = await cli(["--human", "media", "sync", "account", "add", "google-drive", "--name", "Marketing Drive"], transport, env);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^kind: google_drive$/m);
  assert.match(human.stdout, new RegExp(`^service account: ${SCREENRIG_ADDRESS.replaceAll(".", "\\.")}$`, "m"));
  assert.match(human.stdout, /^key: none of your own; the account reads through screenRIG's service account$/m);
  assert.match(human.stdout, /^state: ready$/m);
  assert.ok(human.stdout.includes(`Share the Google Drive folder with ${SCREENRIG_ADDRESS} (Viewer is enough).`));
  assert.match(human.stdout, /That is screenRIG's service account: a folder syncs through it only when a member of this project with a verified email shared it or owns it/);
  assert.match(human.stdout, /^Then: screenrig media sync create google-drive --account-id msa_DRIVEAAAAAAAAAAAAAA --url FOLDER$/m);

  await writeFile(path.join(env.cwd, "key.json"), JSON.stringify(SERVICE_KEY, null, 2));
  const own = await cli(["--json", "media", "sync", "account", "add", "google-drive", "--name", "Own Drive", "--key-file", "key.json"], transport, env, { logger: log.logger });
  assert.equal(own.code, 0, own.stdout + own.stderr);
  const body = lastCall(transport).body as { kind: string; name: string; secret: string };
  assert.deepEqual({ ...body, secret: undefined }, { kind: "google_drive", name: "Own Drive", secret: undefined });
  assert.ok(!body.secret.includes("\n") && !body.secret.includes("  "), "the key is sent on one line");
  assert.deepEqual(JSON.parse(body.secret), SERVICE_KEY, "the key is sent whole");
  assert.deepEqual(own.envelope.data.secret, { set: true, hint: "c3d4" });
  assert.equal(own.envelope.data.config.service_account_email, OWN_ADDRESS);
  const ownWarning = own.envelope.warnings?.find((item) => item.code === "media_sync_share_folder");
  assert.ok(ownWarning?.message.includes(OWN_ADDRESS));
  assert.match(ownWarning?.message ?? "", /your own service account/);

  const piped = await cli(["--human", "media", "sync", "account", "add", "google-drive", "--name", "Own Drive", "--key-file", "-"], transport, env, stdinOf(JSON.stringify(SERVICE_KEY)));
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  assert.deepEqual(JSON.parse((lastCall(transport).body as { secret: string }).secret), SERVICE_KEY);
  assert.match(piped.stdout, /^key: your own service account key \(ends c3d4\)$/m);
  assert.ok(piped.stdout.includes(`Share the Google Drive folder with ${OWN_ADDRESS} (Viewer is enough).`));
  assert.match(piped.stdout, /^That is your own service account: a folder shared with it syncs\.$/m);
  for (const output of [shared, human, own, piped]) assert.doesNotMatch(output.stdout + output.stderr, KEY_LEAK, "the key is never printed");
  assert.doesNotMatch(JSON.stringify(log.events), KEY_LEAK, "the key never reaches the operation log");
});

test("account add google-drive refuses a file that is not a service account key, without quoting it", async () => {
  const env = await enrolled();
  const transport = providerBackend();
  await writeFile(path.join(env.cwd, "oauth.json"), JSON.stringify({ type: "authorized_user", client_id: "x", client_secret: "LEAKMARKER" }));
  await writeFile(path.join(env.cwd, "pem.txt"), PRIVATE_KEY);
  await writeFile(path.join(env.cwd, "broken.json"), '{"type": "service_account", "private_key": "LEAKMARKER');
  await writeFile(path.join(env.cwd, "huge.json"), JSON.stringify({ ...SERVICE_KEY, padding: "x".repeat(9000) }));
  const base = ["--json", "media", "sync", "account", "add", "google-drive", "--name", "Marketing Drive", "--key-file"];
  for (const [file, pattern] of [
    ["oauth.json", /must be the service account's JSON key file/],
    ["pem.txt", /must be the service account's JSON key file/],
    ["broken.json", /must be the service account's JSON key file/],
    ["huge.json", /larger than 8192 characters/],
    ["missing.json", /does not exist/],
  ] as Array<[string, RegExp]>) {
    const refused = await cli([...base, file], transport, env);
    assert.equal(refused.code, 2, file);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern, file);
    assert.doesNotMatch(refused.stdout + refused.stderr, KEY_LEAK, `${file} is never quoted`);
  }
  assert.equal(syncCalls(transport).length, 0, "nothing was sent");
  const noName = await cli(["--json", "media", "sync", "account", "add", "google-drive", "--key-file", "pem.txt"], transport, env);
  assert.equal(noName.code, 2);
});

test("account update --key-file replaces a Google Drive account's own key and conflicts with --secret-file", async () => {
  const env = await enrolled();
  const transport = providerBackend();
  await writeFile(path.join(env.cwd, "new-key.json"), JSON.stringify(SERVICE_KEY, null, 2));
  await writeFile(path.join(env.cwd, "secret.txt"), `${SECRET}\n`);
  const updated = await cli(["--human", "media", "sync", "account", "update", DRIVE_ACCOUNT, "--key-file", "new-key.json", "--expect-rev", "1"], transport, env);
  assert.equal(updated.code, 0, updated.stdout + updated.stderr);
  const patch = lastCall(transport);
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, `/api/media-sync-accounts/${DRIVE_ACCOUNT}`);
  assert.deepEqual(JSON.parse((patch.body as { secret: string }).secret), SERVICE_KEY);
  assert.deepEqual(Object.keys(patch.body as object), ["secret"]);
  assert.equal(patch.headers?.["if-match"], '"1"');
  assert.match(updated.stdout, new RegExp(`^Updated media sync account ${DRIVE_ACCOUNT}$`, "m"));
  assert.match(updated.stdout, /^key: your own service account key \(ends e5f6\)$/m);
  assert.doesNotMatch(updated.stdout + updated.stderr, KEY_LEAK);

  const piped = await cli(["--json", "media", "sync", "account", "update", DRIVE_ACCOUNT, "--key-file", "-"], transport, env, stdinOf(JSON.stringify(SERVICE_KEY)));
  assert.equal(piped.code, 0, piped.stdout + piped.stderr);
  const renamed = await cli(["--json", "media", "sync", "account", "update", DRIVE_ACCOUNT, "--name", "Renamed"], transport, env);
  assert.equal(renamed.code, 0, renamed.stdout + renamed.stderr);
  assert.deepEqual(lastCall(transport).body, { name: "Renamed" }, "the existing options keep working beside --key-file");

  const before = syncCalls(transport).length;
  const both = await cli(["--json", "media", "sync", "account", "update", DRIVE_ACCOUNT, "--key-file", "new-key.json", "--secret-file", "secret.txt"], transport, env);
  assert.equal(both.code, 2);
  assert.match(both.envelope.error?.detail ?? both.stderr, /Provide at most one of --secret-file or --key-file/);
  const none = await cli(["--json", "media", "sync", "account", "update", DRIVE_ACCOUNT], transport, env);
  assert.equal(none.code, 2);
  assert.match(none.envelope.error?.detail ?? none.stderr, /--key-file/);
  assert.equal(syncCalls(transport).length, before, "nothing was sent");
});

test("sync create dropbox and google-drive send their provider, address and options", async () => {
  const env = await enrolled();
  const transport = providerBackend();
  const dropbox = await cli(["--json", "media", "sync", "create", "dropbox", "--account-id", DROPBOX_ACCOUNT, "--url", DROPBOX_FOLDER, "--folder-id", FOLDER, "--every", "1h", "--name", "Lobby loop"], transport, env);
  assert.equal(dropbox.code, 0, dropbox.stdout + dropbox.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/media-syncs");
  assert.deepEqual(call.body, { provider: "dropbox", account_id: DROPBOX_ACCOUNT, url: DROPBOX_FOLDER, folder_id: FOLDER, every: 3600, name: "Lobby loop" });
  assert.ok(idempotencyKey(call));
  assert.equal(dropbox.envelope.data.provider, "dropbox");

  const viaPath = await cli(["--human", "media", "sync", "create", "dropbox", "--account-id", DROPBOX_ACCOUNT, "--url", "/Marketing/Lobby Signs"], transport, env);
  assert.equal(viaPath.code, 0, viaPath.stdout + viaPath.stderr);
  assert.deepEqual(lastCall(transport).body, { provider: "dropbox", account_id: DROPBOX_ACCOUNT, url: "/Marketing/Lobby Signs" });
  assert.match(viaPath.stdout, /^provider: dropbox$/m);
  assert.match(viaPath.stdout, /^source: https:\/\/www\.dropbox\.com\/home\/Marketing\/Lobby Signs$/m);
  assert.match(viaPath.stdout, /^path: \/Marketing\/Lobby Signs$/m);
  assert.match(viaPath.stdout, /\{"by": "folder", "folder_id": "mfd_/, "the next step is the folder selector");
  assert.match(viaPath.stdout, /Next: screenrig media sync show msy_/);

  const drive = await cli(["--human", "media", "sync", "create", "google-drive", "--account-id", DRIVE_ACCOUNT, "--url", DRIVE_FOLDER], transport, env);
  assert.equal(drive.code, 0, drive.stdout + drive.stderr);
  assert.deepEqual(lastCall(transport).body, { provider: "google_drive", account_id: DRIVE_ACCOUNT, url: DRIVE_FOLDER }, "the contract's provider is google_drive");
  assert.match(drive.stdout, /^provider: google_drive$/m);
  assert.match(drive.stdout, /^shared by: member@example\.com \(checked on every run\)$/m);
  const byId = await cli(["--json", "media", "sync", "create", "google-drive", "--account-id", DRIVE_ACCOUNT, "--url", DRIVE_FOLDER_ID, "--every", "6h", "--folder-id", FOLDER, "--name", "Drive loop"], transport, env);
  assert.equal(byId.code, 0, byId.stdout + byId.stderr);
  assert.deepEqual(lastCall(transport).body, { provider: "google_drive", account_id: DRIVE_ACCOUNT, url: DRIVE_FOLDER_ID, folder_id: FOLDER, every: 21600, name: "Drive loop" });

  for (const [words, args, pattern] of [
    [["dropbox"], ["--account-id", DROPBOX_ACCOUNT], /--url/],
    [["dropbox"], ["--url", DROPBOX_FOLDER], /--account-id/],
    [["dropbox"], ["--account-id", "acc_1", "--url", DROPBOX_FOLDER], /msa_/],
    [["dropbox"], ["--account-id", DROPBOX_ACCOUNT, "--url", "Marketing"], /--url takes the folder's address in Dropbox/],
    [["dropbox"], ["--account-id", DROPBOX_ACCOUNT, "--url", DROPBOX_FOLDER, "--every", "1m"], /--every takes a duration/],
    [["dropbox"], ["--account-id", DROPBOX_ACCOUNT, "--url", DROPBOX_FOLDER, "--folder-id", "med_1"], /mfd_/],
    [["google-drive"], ["--account-id", DRIVE_ACCOUNT], /--url/],
    [["google-drive"], ["--account-id", DRIVE_ACCOUNT, "--url", "My Folder"], /--url takes the Google Drive folder's address/],
    [["google-drive"], ["--account-id", DRIVE_ACCOUNT, "--url", "http://drive.google.com/drive/folders/1Ab"], /--url takes the Google Drive folder's address/],
  ] as Array<[string[], string[], RegExp]>) {
    const before = syncCalls(transport).length;
    const refused = await cli(["--json", "media", "sync", "create", ...words, ...args], transport, env);
    assert.equal(refused.code, 2, `${words.join(" ")} ${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error?.detail ?? refused.stderr, pattern);
    assert.equal(syncCalls(transport).length, before, "a refused command sends nothing");
  }
  const wire = syncCalls(transport).length;
  const underscore = await cli(["--json", "media", "sync", "create", "google_drive", "--account-id", DRIVE_ACCOUNT, "--url", DRIVE_FOLDER], transport, env);
  assert.equal(underscore.code, 2, "the provider is the command word google-drive; the contract's google_drive is not a second spelling");
  assert.equal(syncCalls(transport).length, wire);
});

test("media sync problems of Dropbox and Google Drive name the next command", async () => {
  const env = await enrolled();
  const transport = new FakeTransport()
    .on("POST", "/api/media-syncs", (req) => {
      const id = (req.body as { account_id: string }).account_id;
      if (id === DROPBOX_ACCOUNT) return problem(409, "dropbox_reconnect_required", "Dropbox no longer honors the account's connection.");
      if (id === DRIVE_ACCOUNT) return problem(403, "media_sync_sharer_not_member", "The folder was not shared by a member of this project.");
      return problem(409, "media_sync_source_refused", "Google Drive could not open the folder.");
    })
    .on("POST", "/api/media-sync-accounts", (req) => (req.body as { kind: string }).kind === "dropbox"
      ? problem(409, "dropbox_not_configured", "This server has no Dropbox app.")
      : problem(409, "google_drive_not_configured", "This server has no Google service account."));
  const reconnect = await cli(["--json", "media", "sync", "create", "dropbox", "--account-id", DROPBOX_ACCOUNT, "--url", DROPBOX_FOLDER], transport, env);
  assert.equal(reconnect.code, 5);
  assert.equal(reconnect.envelope.error?.code, "dropbox_reconnect_required");
  assert.equal(reconnect.envelope.error?.next?.command, `screenrig media sync account connect ${DROPBOX_ACCOUNT}`);
  assert.match(reconnect.envelope.error?.next?.reason ?? "", /person who owns the Dropbox account/);
  const sharer = await cli(["--json", "media", "sync", "create", "google-drive", "--account-id", DRIVE_ACCOUNT, "--url", DRIVE_FOLDER], transport, env);
  assert.equal(sharer.code, 3);
  assert.equal(sharer.envelope.error?.code, "media_sync_sharer_not_member");
  assert.equal(sharer.envelope.error?.next?.command, `screenrig media sync account show ${DRIVE_ACCOUNT}`);
  assert.match(sharer.envelope.error?.next?.reason ?? "", /service_account_email from the Google account of a member of this project whose email is verified/);
  const refused = await cli(["--json", "media", "sync", "create", "google-drive", "--account-id", "msa_OTHERAAAAAAAAAAAAAA", "--url", DRIVE_FOLDER], transport, env);
  assert.equal(refused.code, 5);
  assert.equal(refused.envelope.error?.next?.command, "screenrig media sync account test msa_OTHERAAAAAAAAAAAAAA");
  assert.match(refused.envelope.error?.next?.reason ?? "", /Dropbox: the connected person must be able to open the folder/);
  assert.match(refused.envelope.error?.next?.reason ?? "", /Google Drive: share the folder with the account's service_account_email/);
  const noDropbox = await cli(["--json", "media", "sync", "account", "add", "dropbox", "--name", "Marketing Dropbox"], transport, env);
  assert.equal(noDropbox.code, 5);
  assert.equal(noDropbox.envelope.error?.code, "dropbox_not_configured");
  assert.equal(noDropbox.envelope.error?.next?.command, "screenrig media sync account add dropbox --help");
  assert.match(noDropbox.envelope.error?.next?.reason ?? "", /media sync account add dropbox --name NAME --app-key KEY/);
  const noDrive = await cli(["--json", "media", "sync", "account", "add", "google-drive", "--name", "Marketing Drive"], transport, env);
  assert.equal(noDrive.code, 5);
  assert.equal(noDrive.envelope.error?.code, "google_drive_not_configured");
  assert.equal(noDrive.envelope.error?.next?.command, "screenrig media sync account add google-drive --help");
  assert.match(noDrive.envelope.error?.next?.reason ?? "", /media sync account add google-drive --name NAME --key-file FILE/);
});

test("account and sync lists and shows render every provider", async () => {
  const env = await enrolled();
  const connected = dropboxAccount({ id: "msa_CONNECTEDAAAAAAAAAA", name: "Ops Dropbox", state: "ready", config: { display_name: "Ada Lovelace", email: "ada@example.com", app_key: OWN_APP }, secret: { set: true, hint: "" } });
  const ownDrive = driveAccount({ id: "msa_OWNKEYAAAAAAAAAAAAA", name: "Own Drive", config: { service_account_email: OWN_ADDRESS }, secret: { set: true, hint: "c3d4" } });
  const transport = new FakeTransport()
    .on("GET", "/api/media-sync-accounts", () => json(200, { items: [account(), dropboxAccount(), connected, driveAccount(), ownDrive], next_cursor: null }))
    .on("GET", `/api/media-sync-accounts/${DROPBOX_ACCOUNT}`, () => json(200, dropboxAccount()))
    .on("GET", "/api/media-sync-accounts/msa_CONNECTEDAAAAAAAAAA", () => json(200, connected))
    .on("GET", "/api/media-sync-accounts/msa_LAPSEDAAAAAAAAAAAAA", () => json(200, dropboxAccount({ id: "msa_LAPSEDAAAAAAAAAAAAA", state: "reconnect_required", config: { display_name: "Ada Lovelace" }, secret: { set: true, hint: "" } })))
    .on("GET", `/api/media-sync-accounts/${DRIVE_ACCOUNT}`, () => json(200, driveAccount()))
    .on("GET", "/api/media-sync-accounts/msa_OWNKEYAAAAAAAAAAAAA", () => json(200, ownDrive))
    .on("GET", "/api/media-syncs", () => json(200, { items: [
      sync(),
      sync({ id: "msy_DROPBOXAAAAAAAAAAAAA", provider: "dropbox", name: "Dropbox menus", last_run: RUN, source: { web_url: DROPBOX_FOLDER, item_id: "id:AAAA", path: "/Marketing/Lobby Signs" } }),
      sync({ id: "msy_DRIVEAAAAAAAAAAAAAAA", provider: "google_drive", name: "Drive menus", every_s: 3600, last_run: RUN, source: { web_url: DRIVE_FOLDER, item_id: DRIVE_FOLDER_ID, shared_by: "member@example.com" } }),
    ], next_cursor: null }));

  const list = await cli(["--human", "media", "sync", "account", "list"], transport, env);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^Media sync accounts \(5\)$/m);
  assert.match(list.stdout, /^ID\s+NAME\s+KIND\s+STATE\s+ACCOUNT\s+SECRET\s+TEST$/m);
  assert.match(list.stdout, /^msa_ACCOUNTAAAAAAAAAAAA\s+Contoso\s+microsoft365\s+ready\s+contoso\.onmicrosoft\.com\s+…Wxyz\s+never$/m);
  assert.match(list.stdout, /^msa_DROPBOXAAAAAAAAAAAA\s+Marketing Dropbox\s+dropbox\s+pending_consent\s+\(not connected\)\s+-\s+never$/m);
  assert.match(list.stdout, /^msa_CONNECTEDAAAAAAAAAA\s+Ops Dropbox\s+dropbox\s+ready\s+ada@example\.com\s+-\s+never$/m);
  assert.match(list.stdout, /^msa_DRIVEAAAAAAAAAAAAAA\s+Marketing Drive\s+google_drive\s+ready\s+drive-sync@screenrig-sync\.iam\.gserviceaccount\.com\s+screenRIG's\s+never$/m);
  assert.match(list.stdout, /^msa_OWNKEYAAAAAAAAAAAAA\s+Own Drive\s+google_drive\s+ready\s+rooms@project\.iam\.gserviceaccount\.com\s+…c3d4\s+never$/m);

  const pending = await cli(["--human", "media", "sync", "account", "show", DROPBOX_ACCOUNT], transport, env);
  assert.match(pending.stdout, /^dropbox account: not connected$/m);
  assert.match(pending.stdout, /^app: screenRIG's Dropbox app$/m);
  assert.match(pending.stdout, new RegExp(`^Waiting for the person who owns the Dropbox account to open the link: screenrig media sync account connect ${DROPBOX_ACCOUNT} makes a new link to send them\\.$`, "m"));
  const ready = await cli(["--human", "media", "sync", "account", "show", "msa_CONNECTEDAAAAAAAAAA"], transport, env);
  assert.match(ready.stdout, /^dropbox account: Ada Lovelace \(ada@example\.com\)$/m);
  assert.match(ready.stdout, new RegExp(`^app: your own Dropbox app \\(app key ${OWN_APP}\\)$`, "m"));
  assert.doesNotMatch(ready.stdout, /Waiting for|no longer honors/);
  const lapsed = await cli(["--human", "media", "sync", "account", "show", "msa_LAPSEDAAAAAAAAAAAAA"], transport, env);
  assert.match(lapsed.stdout, /^state: reconnect_required$/m);
  assert.match(lapsed.stdout, /^Dropbox no longer honors the connection: screenrig media sync account connect msa_LAPSEDAAAAAAAAAAAAA makes a new link for the person who owns the Dropbox account to open\.$/m);
  const screenrigDrive = await cli(["--human", "media", "sync", "account", "show", DRIVE_ACCOUNT], transport, env);
  assert.match(screenrigDrive.stdout, /^service account: drive-sync@screenrig-sync\.iam\.gserviceaccount\.com$/m);
  assert.match(screenrigDrive.stdout, /^key: none of your own; the account reads through screenRIG's service account$/m);
  assert.doesNotMatch(screenrigDrive.stdout, /^tenant:|^client:|^secret:/m, "a Drive account shows no Microsoft fields");
  const ownDriveShown = await cli(["--human", "media", "sync", "account", "show", "msa_OWNKEYAAAAAAAAAAAAA"], transport, env);
  assert.match(ownDriveShown.stdout, /^key: your own service account key \(ends c3d4\)$/m);

  const syncs = await cli(["--human", "media", "sync", "list"], transport, env);
  assert.equal(syncs.code, 0, syncs.stderr);
  assert.match(syncs.stdout, /^msy_DROPBOXAAAAAAAAAAAAA\s+Dropbox menus\s+dropbox\s+mfd_FOLDER1234567890AAAA\s+15m\s+active\s+partial$/m);
  assert.match(syncs.stdout, /^msy_DRIVEAAAAAAAAAAAAAAA\s+Drive menus\s+google_drive\s+mfd_FOLDER1234567890AAAA\s+1h\s+active\s+partial$/m);
  assert.deepEqual(accountLines(dropboxAccount()).slice(0, 3), [`id: ${DROPBOX_ACCOUNT}`, "name: Marketing Dropbox", "kind: dropbox"]);
  assert.ok(syncLines(sync({ provider: "dropbox", source: { web_url: DROPBOX_FOLDER, path: "/Marketing" } })).includes("path: /Marketing"));
  assert.ok(!syncLines(sync()).some((line) => line.startsWith("path:") || line.startsWith("shared by:")), "a SharePoint sync shows neither");
});

test("help describes the Dropbox and Google Drive accounts and syncs", () => {
  const group = commandHelp(["media", "sync"]);
  const notes = group.notes.join("\n");
  for (const text of ["SharePoint", "OneDrive for work", "Dropbox", "Google Drive", "--app-key", "--key-file", "account add dropbox", "account add google-drive", "folder selector"]) {
    assert.ok(notes.includes(text), `the Media sync section names ${text}`);
  }
  assert.match(group.usage, /Dropbox or Google Drive folder in step with a media folder/);
  for (const [words, example] of [
    [["media", "sync", "account", "add", "dropbox"], "screenrig media sync account add dropbox"],
    [["media", "sync", "account", "add", "google-drive"], "screenrig media sync account add google-drive"],
    [["media", "sync", "account", "connect"], "screenrig media sync account connect"],
    [["media", "sync", "create", "dropbox"], "screenrig media sync create dropbox"],
    [["media", "sync", "create", "google-drive"], "screenrig media sync create google-drive"],
  ] as Array<[string[], string]>) {
    const help = commandHelp(words);
    assert.ok(help.examples.length > 0, words.join(" "));
    assert.ok(help.examples.every((text) => text.startsWith(example)), words.join(" "));
  }
  const dropbox = commandHelp(["media", "sync", "account", "add", "dropbox"]);
  assert.ok(dropbox.options.some((option: { name: string }) => option.name === "--app-key"));
  assert.ok(dropbox.options.find((option: { name: string }) => option.name === "--name")!.required === true);
  assert.match(dropbox.notes.join("\n"), /\/api\/dropbox\/callback/);
  assert.match(dropbox.notes.join("\n"), /dropbox_not_configured/);
  const drive = commandHelp(["media", "sync", "account", "add", "google-drive"]);
  assert.match(drive.options.find((option: { name: string }) => option.name === "--key-file")!.description, /never an argument/);
  assert.match(drive.notes.join("\n"), /Viewer is enough/);
  assert.match(drive.notes.join("\n"), /google_drive_not_configured/);
  const update = commandHelp(["media", "sync", "account", "update"]);
  assert.ok(update.options.some((option: { name: string }) => option.name === "--key-file"));
  assert.match(update.notes.join("\n"), /Provide at most one of --secret-file or --key-file/);
  assert.ok(update.examples.some((text) => text.includes("--key-file new-key.json")));
  const create = commandHelp(["media", "sync", "create", "dropbox"]);
  assert.deepEqual(create.options.map((option: { name: string }) => option.name).filter((name: string) => ["--account-id", "--url", "--folder-id", "--every", "--name"].includes(name)), ["--account-id", "--url", "--folder-id", "--every", "--name"]);
  assert.match(commandHelp(["media", "sync", "create", "google-drive"]).notes.join("\n"), /media_sync_sharer_not_member/);
});
