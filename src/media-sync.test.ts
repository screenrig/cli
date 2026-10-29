import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { commandHelp } from "./help.js";
import { createMemoryLogger } from "./log/logger.js";
import { run, type CliRuntime } from "./main.js";
import {
  MEDIA_SYNC_ACCOUNT_ID_PATTERN, MEDIA_SYNC_ID_PATTERN, accountLines, accountTableLines, consentLines, designTableLines, mediaSyncClientId, mediaSyncDesign, mediaSyncEvery,
  mediaSyncPages, mediaSyncTenant, mediaSyncUrl, syncLines, syncTableLines,
  type MediaSync, type MediaSyncAccount, type MediaSyncDesign,
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
const CANVA_ACCOUNT = "msa_CANVAAAAAAAAAAAAAAA";
const CANVA_DESIGN = "DAFVztcvd9z";
const CANVA_DESIGN_URL = "https://www.canva.com/design/DAFVztcvd9z/Rm4Kd8/edit";
// The consent link is built in code, with a state that would look like a credential as a literal.
const CONSENT_STATE = `${"Zq3".repeat(8)}-state`;
const CONSENT_LINK = `https://www.canva.com/api/oauth/authorize?response_type=code&client_id=OC-test&state=${CONSENT_STATE}&code_challenge_method=s256`;

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
  const configDir = await testTemp("media-sync-cfg-");
  const cwd = await testTemp("media-sync-cwd-");
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

function canvaAccount(overrides: Partial<MediaSyncAccount> = {}): MediaSyncAccount {
  return account({
    id: CANVA_ACCOUNT, kind: "canva", name: "Marketing Canva", config: { canva_user_id: "U7Qa2Lunch0001", team_id: "T3Brand000002", display_name: "Ada Signage" },
    secret: { set: true, hint: "" }, ...overrides,
  });
}

function canvaSync(overrides: Partial<MediaSync> = {}): MediaSync {
  return sync({
    provider: "canva", account_id: CANVA_ACCOUNT, name: "Lunch menu",
    source: { web_url: "https://www.canva.com/design/DAFVztcvd9z/Rm4Kd8/view", design_id: CANVA_DESIGN, title: "Lunch menu", pages: [1, 3], format: "png", page_count: 3, design_updated_at: "2026-10-28T16:00:00Z" },
    ...overrides,
  });
}

const DESIGNS: MediaSyncDesign[] = [
  { id: CANVA_DESIGN, title: "Lunch menu", updated_at: "2026-10-28T16:00:00Z", page_count: 3, view_url: "https://www.canva.com/design/DAFVztcvd9z/Rm4Kd8/view" },
  { id: "DAFSummer002", title: "Summer sale", updated_at: "2026-10-01T09:00:00Z" },
];

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
      if (body.kind === "canva") {
        return json(201, { ...canvaAccount({ name: body.name, state: "pending_consent", secret: { set: false, hint: "" }, config: {} }), authorize_url: CONSENT_LINK, authorize_expires_at: "2026-10-28T17:15:00Z" }, { etag: '"1"' });
      }
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
      if (body.provider === "canva") {
        return json(201, canvaSync({ name: body.name ?? "Lunch menu", folder_id: body.folder_id ?? FOLDER, every_s: body.every ?? 900 }), { etag: '"1"' });
      }
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
    .on("POST", `/api/media-syncs/${SYNC}/run`, () => json(202, sync({ next_run_at: "2026-10-28T17:00:00Z" })))
    .on("POST", `/api/media-sync-accounts/${CANVA_ACCOUNT}/connect`, () => json(200, { ...canvaAccount({ state: "reconnect_required" }), authorize_url: CONSENT_LINK, authorize_expires_at: "2026-10-28T17:15:00Z" }))
    .on("GET", `/api/media-sync-accounts/${CANVA_ACCOUNT}/designs`, (req) => req.query?.continuation === "NEXT"
      ? json(200, { items: [DESIGNS[1]], continuation: null })
      : json(200, { items: DESIGNS, continuation: "NEXT" }));
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
  assert.match(list.stdout, new RegExp(`^${ACCOUNT}\\s+Contoso\\s+${TENANT.replaceAll(".", "\\.")}\\s+…Wxyz\\s+never$`, "m"));
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
  assert.match(list.stdout, new RegExp(`^${SYNC}\\s+Lobby Signs\\s+${FOLDER}\\s+15m\\s+active\\s+partial$`, "m"));

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
  assert.ok(add.examples.every((text) => text.includes("--secret-file")), "the example reads the secret from a file");
  assert.ok(add.options.some((option: { flags?: string; name?: string }) => (option.flags ?? option.name ?? "").includes("--secret-file")));
});

test("the Canva parsers read designs, pages and keep out what is not a design", () => {
  assert.equal(mediaSyncDesign(CANVA_DESIGN), CANVA_DESIGN);
  assert.equal(mediaSyncDesign(`  ${CANVA_DESIGN_URL} `), CANVA_DESIGN_URL);
  assert.equal(mediaSyncDesign("https://canva.com/design/DAFVztcvd9z/view"), "https://canva.com/design/DAFVztcvd9z/view");
  for (const bad of ["", "ab", "DAF abc", "http://www.canva.com/design/DAFVztcvd9z/x/edit", "https://canva.link/AbCd", "https://www.canva.com.evil.example/design/DAFVztcvd9z/x/edit",
    "https://www.canva.com/templates/DAFVztcvd9z", "https://user@www.canva.com/design/DAFVztcvd9z/x/edit", FOLDER_URL]) {
    assert.throws(() => mediaSyncDesign(bad), /--design takes a Canva design id/, bad);
  }
  assert.equal(mediaSyncPages("1"), "1");
  assert.equal(mediaSyncPages("1,3-5"), "1,3,4,5");
  assert.equal(mediaSyncPages("5, 3 ,3,4-5"), "3,4,5");
  for (const bad of ["", "0", "3-1", "a", "1,,2", "-2", "1-2000", "1.5", "1;2"]) assert.throws(() => mediaSyncPages(bad), /--pages/, bad);
});

test("account add canva prints the consent link for a person and never opens a browser", async () => {
  const env = await enrolled();
  const transport = backend();
  const json_ = await cli(["--json", "media", "sync", "account", "add", "canva", "--name", "Marketing Canva"], transport, env);
  assert.equal(json_.code, 0, json_.stdout + json_.stderr);
  const call = lastCall(transport);
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/media-sync-accounts");
  assert.deepEqual(call.body, { kind: "canva", name: "Marketing Canva" });
  assert.equal(json_.envelope.data.authorize_url, CONSENT_LINK);
  assert.equal(json_.envelope.data.state, "pending_consent");
  assert.deepEqual(json_.envelope.data.secret, { set: false, hint: "" });

  const human = await cli(["--human", "media", "sync", "account", "add", "canva", "--name", "Marketing Canva"], transport, env);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^Created media sync account msa_/m);
  assert.match(human.stdout, /^canva account: not connected yet$/m);
  assert.match(human.stdout, /Open this link in a browser signed in to Canva/);
  assert.match(human.stdout, new RegExp(`screenrig media sync account show ${CANVA_ACCOUNT}`));
  assert.match(human.stdout, new RegExp(`^link: ${CONSENT_LINK.replaceAll("?", "\\?")}$`, "m"));
  assert.match(human.stdout, /works once, until 2026-10-28T17:15:00Z/);
  // No browser was opened and no other request than the create was made.
  assert.equal(syncCalls(transport).filter((c) => c.method === "POST").length, 2);
  assert.equal((await cli(["--json", "media", "sync", "account", "add", "canva"], transport, env)).code, 2, "a name is required");
  assert.equal((await cli(["--json", "media", "sync", "account", "add", "canva", "--name", "x", "--secret-file", "s.txt"], transport, env)).code, 2, "a Canva account takes no secret");
});

test("account connect makes a new link, designs lists what the connection sees", async () => {
  const env = await enrolled();
  const transport = backend();
  const connect = await cli(["--human", "media", "sync", "account", "connect", CANVA_ACCOUNT], transport, env);
  assert.equal(connect.code, 0, connect.stdout + connect.stderr);
  assert.equal(lastCall(transport).method, "POST");
  assert.equal(lastCall(transport).path, `/api/media-sync-accounts/${CANVA_ACCOUNT}/connect`);
  assert.match(connect.stdout, /^New connect link for media sync account msa_/m);
  assert.match(connect.stdout, /^state: reconnect_required$/m);
  assert.match(connect.stdout, new RegExp(`^link: ${CONSENT_LINK.replaceAll("?", "\\?")}$`, "m"));
  assert.equal((await cli(["--json", "media", "sync", "account", "connect", "nope"], transport, env)).code, 2);

  const first = await cli(["--human", "media", "sync", "account", "designs", CANVA_ACCOUNT, "--query", "menu"], transport, env);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(lastCall(transport).query, { query: "menu" });
  assert.match(first.stdout, /^Canva designs \(2\), most recently changed first$/m);
  assert.match(first.stdout, new RegExp(`^${CANVA_DESIGN}\\s+Lunch menu\\s+3\\s+2026-10-28T16:00:00Z$`, "m"));
  assert.match(first.stdout, /^DAFSummer002\s+Summer sale\s+-\s+2026-10-01T09:00:00Z$/m);
  assert.match(first.stdout, /^More: screenrig media sync account designs msa_CANVAAAAAAAAAAAAAAA --query "menu" --continuation NEXT$/m);
  assert.match(first.stdout, new RegExp(`^Next: screenrig media sync create canva --account-id ${CANVA_ACCOUNT} --design ${CANVA_DESIGN}$`, "m"));
  const next = await cli(["--json", "media", "sync", "account", "designs", CANVA_ACCOUNT, "--continuation", "NEXT"], transport, env);
  assert.deepEqual(lastCall(transport).query, { continuation: "NEXT" });
  assert.equal(next.envelope.data.continuation, null);
  assert.equal(next.envelope.data.items.length, 1);
});

test("sync create canva sends the design, pages, format and cadence", async () => {
  const env = await enrolled();
  const transport = backend();
  const created = await cli(["--json", "media", "sync", "create", "canva", "--account-id", CANVA_ACCOUNT, "--design", CANVA_DESIGN_URL, "--pages", "1,3-5", "--format", "mp4", "--folder-id", FOLDER, "--every", "1h", "--name", "Menu loop"], transport, env);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const call = lastCall(transport);
  assert.equal(call.path, "/api/media-syncs");
  assert.deepEqual(call.body, { provider: "canva", account_id: CANVA_ACCOUNT, design: CANVA_DESIGN_URL, pages: [1, 3, 4, 5], format: "mp4", folder_id: FOLDER, every: 3600, name: "Menu loop" });
  assert.ok(call.headers?.["Idempotency-Key"] ?? call.headers?.["idempotency-key"]);

  const minimal = await cli(["--human", "media", "sync", "create", "canva", "--account-id", CANVA_ACCOUNT, "--design", CANVA_DESIGN], transport, env);
  assert.equal(minimal.code, 0, minimal.stdout + minimal.stderr);
  assert.deepEqual(lastCall(transport).body, { provider: "canva", account_id: CANVA_ACCOUNT, design: CANVA_DESIGN }, "the server defaults the format to png");
  assert.match(minimal.stdout, /^Created media sync msy_/m);
  assert.match(minimal.stdout, new RegExp(`^design: ${CANVA_DESIGN} \\(Lunch menu\\)$`, "m"));
  assert.match(minimal.stdout, /^export: one image per page, pages 1,3$/m);
  assert.match(minimal.stdout, /^exported design time: 2026-10-28T16:00:00Z$/m);
  assert.match(minimal.stdout, /\{"by": "folder", "folder_id": "mfd_/, "the next step is the folder selector");

  for (const [args, pattern] of [
    [["--account-id", ACCOUNT], /requires --account-id and --design|--design/],
    [["--design", CANVA_DESIGN], /--account-id/],
    [["--account-id", "acc_1", "--design", CANVA_DESIGN], /msa_/],
    [["--account-id", ACCOUNT, "--design", "https://example.com/design/DAFVztcvd9z/x"], /--design takes a Canva design id/],
    [["--account-id", ACCOUNT, "--design", CANVA_DESIGN, "--pages", "0"], /--pages/],
    [["--account-id", ACCOUNT, "--design", CANVA_DESIGN, "--format", "pdf"], /png|mp4/],
    [["--account-id", ACCOUNT, "--design", CANVA_DESIGN, "--every", "1m"], /--every takes a duration/],
  ] as Array<[string[], RegExp]>) {
    const before = syncCalls(transport).length;
    const result = await cli(["--json", "media", "sync", "create", "canva", ...args], transport, env);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
    assert.match(result.envelope.error?.detail ?? result.stderr, pattern);
    assert.equal(syncCalls(transport).length, before, "a refused command sends nothing");
  }
});

test("sync run --force asks for a forced export", async () => {
  const env = await enrolled();
  const transport = backend();
  const plain = await cli(["--json", "media", "sync", "run", SYNC], transport, env);
  assert.equal(plain.code, 0);
  assert.equal(lastCall(transport).query?.force, undefined);
  const forced = await cli(["--human", "media", "sync", "run", SYNC, "--force"], transport, env);
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  assert.equal(lastCall(transport).path, `/api/media-syncs/${SYNC}/run`);
  assert.deepEqual(lastCall(transport).query, { force: "true" });
  assert.match(forced.stdout, /exports the design even if Canva reports it unchanged/);
});

test("Canva problems name the next command", async () => {
  const env = await enrolled();
  const transport = memoryBackend({ now: () => NOW })
    .on("GET", `/api/media-sync-accounts/${CANVA_ACCOUNT}/designs`, () => problem(409, "canva_reconnect_required", "Canva no longer honors this account's connection."))
    .on("POST", "/api/media-sync-accounts", () => problem(409, "canva_not_configured", "Canva is not configured on this screenRIG server."))
    .on("POST", "/api/media-syncs", () => problem(409, "media_sync_source_refused", "Canva cannot find that design, or this account cannot see it."));
  const lapsed = await cli(["--json", "media", "sync", "account", "designs", CANVA_ACCOUNT], transport, env);
  assert.equal(lapsed.code, 5);
  assert.equal(lapsed.envelope.error?.code, "canva_reconnect_required");
  assert.equal(lapsed.envelope.error?.next?.command, `screenrig media sync account connect ${CANVA_ACCOUNT}`);
  const dark = await cli(["--json", "media", "sync", "account", "add", "canva", "--name", "Canva"], transport, env);
  assert.equal(dark.code, 5);
  assert.equal(dark.envelope.error?.code, "canva_not_configured");
  const refused = await cli(["--json", "media", "sync", "create", "canva", "--account-id", CANVA_ACCOUNT, "--design", CANVA_DESIGN], transport, env);
  assert.equal(refused.code, 5);
  assert.equal(refused.envelope.error?.next?.command, `screenrig media sync account test ${CANVA_ACCOUNT}`);
  assert.match(refused.envelope.error?.next?.reason ?? "", /Canva: the design's address/);
});

test("the renderers show a Canva connection and its sync", () => {
  assert.ok(accountLines(canvaAccount()).includes("canva account: Ada Signage (user U7Qa2Lunch0001, team T3Brand000002)"));
  assert.ok(accountLines(canvaAccount({ secret: { set: false, hint: "" }, config: {}, state: "pending_consent" })).includes("canva account: not connected yet"));
  assert.ok(!accountLines(canvaAccount()).some((line) => line.startsWith("tenant:") || line.startsWith("secret:")));
  const table = accountTableLines([account(), canvaAccount(), canvaAccount({ secret: { set: false, hint: "" }, config: {} })]);
  assert.ok(table.some((line) => /Marketing Canva\s+canva: Ada Signage\s+connected\s+never/.test(line)));
  assert.ok(table.some((line) => /not connected/.test(line)));
  assert.deepEqual(consentLines(canvaAccount()), [], "a read of the account has no link");
  assert.ok(consentLines({ ...canvaAccount(), authorize_url: CONSENT_LINK }).includes(`link: ${CONSENT_LINK}`));
  assert.deepEqual(designTableLines([]), ["No designs"]);
  assert.ok(designTableLines(DESIGNS).some((line) => line.includes("Summer sale")));
  const lines = syncLines(canvaSync({ source: { ...canvaSync().source, format: "mp4", pages: [] } }));
  assert.ok(lines.includes("export: one video, every page"));
  assert.ok(lines.includes("source: https://www.canva.com/design/DAFVztcvd9z/Rm4Kd8/view"));
});

test("Canva stays out of discovery until the platform has a Canva Connect integration (ENG-6435)", () => {
  const group = commandHelp(["media", "sync"]);
  assert.doesNotMatch(group.notes.join("\n"), /Canva/);
  assert.ok(!(commandHelp(["media", "sync"], true).allCommands ?? []).some((path) => /canva|connect|designs/.test(path)));
  assert.ok(commandHelp(["media", "sync", "run"]).options.every((option) => option.name !== "--force"));
  // The hidden commands still run and keep their own help, so unhiding is the flags alone.
  for (const [words, example] of [
    [["media", "sync", "account", "add", "canva"], "screenrig media sync account add canva"],
    [["media", "sync", "account", "connect"], "screenrig media sync account connect"],
    [["media", "sync", "account", "designs"], "screenrig media sync account designs"],
    [["media", "sync", "create", "canva"], "screenrig media sync create canva"],
  ] as Array<[string[], string]>) {
    const help = commandHelp(words);
    assert.ok(help.examples.length > 0, words.join(" "));
    assert.ok(help.examples.every((text) => text.startsWith(example)), words.join(" "));
  }
  assert.match(commandHelp(["media", "sync", "account", "add", "canva"]).notes.join("\n"), /authorize_url/);
});
