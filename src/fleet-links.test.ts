import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { fleetLinkExpiresAt, fleetLinkLines, fleetLinkUrlProblem } from "./fleet-links.js";
import { createMemoryLogger } from "./log/logger.js";
import type { OperationLogger } from "./log/types.js";
import { run, type CliRuntime } from "./main.js";
import { networkError } from "./problems.js";
import { redactText } from "./redact.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
import type { TransportRequest } from "./transport/types.js";

const MISSING = "flk_MISSINGAAAAAAAAA";
const SECRET = "srfl_" + "A".repeat(43);
const SAFE_URL = `https://play.screenrig.ai/player/#fleet=${SECRET}`;

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string }; errors?: unknown[] };
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
  const configDir = await testTemp("fleet-links-cfg-");
  const cwd = await testTemp("fleet-links-cwd-");
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  return { fs, cwd, configPath };
}

async function cli(argv: string[], transport: FakeTransport, env: Env, logger?: OperationLogger, extra: Partial<CliRuntime> = {}): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
    ...(logger ? { logger } : {}),
    ...extra,
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

const linkCalls = (transport: FakeTransport): TransportRequest[] => transport.calls.filter((call) => call.path.startsWith("/api/fleet-links"));

async function seedPlaylist(transport: FakeTransport): Promise<string> {
  const response = await transport.request({ method: "POST", path: "/api/playlists", body: { name: "Lobby", pages: [] } });
  return (response.body as { id: string }).id;
}

async function create(transport: FakeTransport, env: Env, ...extra: string[]) {
  const created = await cli(["--json", "fleet-links", "create", "--name", "Lobby displays", ...extra], transport, env);
  assert.equal(created.code, 0, created.stdout);
  return created.envelope.data as { id: string; url: string; revision: number };
}

function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "flk_FIXEDAAAAAAAAAAA", label: "Lobby displays", enabled: true, tags: ["Lobby"], screens_created: 3, revision: 1,
    created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z", url: SAFE_URL, ...overrides,
  };
}

test("fleet-links create sends the link, returns its url, and keeps the url out of config and logs", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const playlistId = await seedPlaylist(transport);
  const { logger, events } = createMemoryLogger({ command: ["fleet-links", "create"] });
  const created = await cli(["--json", "fleet-links", "create", "--name", "  Lobby displays ", "--tag", "Lobby", "--tag", "Floor2,North",
    "--playlist-id", playlistId, "--max-screens", "25"], transport, env, logger);
  assert.equal(created.code, 0, created.stdout);
  const call = linkCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/fleet-links");
  assert.deepEqual(call.body, { label: "Lobby displays", tags: ["Lobby", "Floor2", "North"], playlist_id: playlistId, max_screens: 25 });
  assert.ok(call.headers?.["idempotency-key"], "create always sends an Idempotency-Key");
  assert.match(created.envelope.data.id, /^flk_/);
  assert.match(created.envelope.data.url, /^https:\/\/play\.screenrig\.ai\/player\/#fleet=srfl_/);
  assert.deepEqual(created.envelope.warnings ?? [], []);

  const config = await readFile(env.configPath, "utf8");
  assert.doesNotMatch(config, /srfl_|#fleet=/, "the url never reaches config");
  assert.doesNotMatch(config, /pending_writes/, "a completed create clears its recovery entry");
  const logged = JSON.stringify(events);
  assert.ok(events.length > 0, "the operation log recorded the request");
  assert.doesNotMatch(logged, /srfl_|#fleet=|play\.screenrig\.ai\/player/, "the url never reaches the operation log");

  const disabled = await cli(["--json", "fleet-links", "create", "--name", "Pilot", "--disabled"], transport, env);
  assert.equal(disabled.code, 0, disabled.stdout);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { label: "Pilot", enabled: false });
  assert.equal(disabled.envelope.data.enabled, false);

  const human = await cli(["--human", "fleet-links", "create", "--name", "Kiosks", "--max-screens", "12"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Created fleet link flk_\S+$/m);
  assert.match(human.stdout, /^label: Kiosks$/m);
  assert.match(human.stdout, /^screens_created: 0\nmax_screens: 12$/m);
  assert.match(human.stdout, /^Sensitive fleet link URL \(every device that opens it becomes a screen in this project; give it only to your device manager\)\nurl: https:\/\/play\.screenrig\.ai\/player\/#fleet=srfl_\S{43}$/m);
});

test("fleet-links create validates every input before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const cases: Array<[string[], RegExp]> = [
    [[], /--name/],
    [["--name", "   "], /1 to 80 characters/],
    [["--name", "x".repeat(81)], /1 to 80 characters/],
    [["--name", "Lobby\u0007"], /without controls/],
    [["--name", "Lobby", "--tag", "Lobby floor"], /1 to 32 letters or digits/],
    [["--name", "Lobby", "--tag", "Lobby", "--tag", "Lobby"], /more than once/],
    [["--name", "Lobby", "--tag", Array.from({ length: 17 }, (_, index) => `t${index}`).join(",")], /at most 16/],
    [["--name", "Lobby", "--playlist-id", "scr_AAAAAAAAAAAAAAAAAAAAAAAA"], /playlist id/],
    [["--name", "Lobby", "--max-screens", "0"], /1 to 10000/],
    [["--name", "Lobby", "--max-screens", "10001"], /1 to 10000/],
    [["--name", "Lobby", "--max-screens", "2.5"], /1 to 10000/],
    [["--name", "Lobby", "--name", "Other"], /only once/],
  ];
  for (const [args, message] of cases) {
    const refused = await cli(["--json", "fleet-links", "create", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, args.join(" "));
  }
  assert.equal(linkCalls(transport).length, 0, "invalid input never reaches the server");
});

test("an unknown playlist and the fleet link limit are definite refusals with guidance and no saved key", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const unknown = await cli(["--json", "fleet-links", "create", "--name", "Lobby", "--playlist-id", "pl_UNKNOWNAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(unknown.code, ExitCode.Client, unknown.stdout);
  assert.equal(unknown.envelope.error!.code, "invalid_request");
  assert.equal(unknown.envelope.error!.next!.command, "screenrig playlist list");
  assert.equal(unknown.envelope.warnings, undefined);

  const limited = new FakeTransport().on("POST", "/api/fleet-links", () => ({
    status: 409, headers: { "content-type": "application/problem+json" },
    body: { status: 409, code: "fleet_link_limit_reached", title: "Project has the maximum fleet links", detail: "The project has the maximum of 50 fleet links." },
  }));
  const refused = await cli(["--json", "fleet-links", "create", "--name", "Lobby"], limited, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error!.code, "fleet_link_limit_reached");
  assert.match(refused.envelope.error!.detail, /maximum of 50 fleet links\. Nothing was created\./);
  assert.equal(refused.envelope.error!.next!.command, "screenrig fleet-links list");
  assert.match(refused.envelope.error!.next!.reason, /screenrig fleet-links delete ID/);
  assert.equal(refused.envelope.warnings, undefined);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes/);
});

test("the memory backend refuses a 51st fleet link", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  for (let index = 0; index < 50; index += 1) {
    const response = await transport.request({ method: "POST", path: "/api/fleet-links", body: { label: `Link ${index}` } });
    assert.equal(response.status, 201);
  }
  const refused = await cli(["--json", "fleet-links", "create", "--name", "One more"], transport, env);
  assert.equal(refused.code, ExitCode.Conflict, refused.stdout);
  assert.equal(refused.envelope.error!.code, "fleet_link_limit_reached");
});

test("an ambiguous create reruns with the saved key and gets the same link back", async () => {
  const env = await enrolled();
  const backend = memoryBackend();
  let lose = true;
  const original = backend.request.bind(backend);
  backend.request = async (req) => {
    const response = await original(req);
    if (lose && req.method === "POST" && req.path === "/api/fleet-links") {
      lose = false;
      throw networkError("connection reset after the request was sent");
    }
    return response;
  };
  const argv = ["--json", "fleet-links", "create", "--name", "Lobby displays", "--tag", "Lobby"];
  const lost = await cli(argv, backend, env);
  assert.equal(lost.code, ExitCode.Network, lost.stdout);
  assert.ok(lost.envelope.warnings?.some((warning) => warning.code === "write_recovery_saved"));
  const pending = await readFile(env.configPath, "utf8");
  assert.match(pending, /pending_writes/);
  assert.doesNotMatch(pending, /srfl_|Lobby displays/, "the ledger holds no request or response content");

  const rerun = await cli(argv, backend, env);
  assert.equal(rerun.code, 0, rerun.stdout);
  const posts = linkCalls(backend).filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.headers?.["idempotency-key"], posts[0]!.headers?.["idempotency-key"], "the rerun reuses the saved key");
  const listed = await cli(["--json", "fleet-links", "list"], backend, env);
  assert.equal(listed.envelope.data.items.length, 1, "the replay did not create a second link");
  assert.equal(listed.envelope.data.items[0].id, rerun.envelope.data.id);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /pending_writes|srfl_/);

  const reused = await cli(["--json", "--idempotency-key", "fleet-key-0001", "fleet-links", "create", "--name", "First"], backend, env);
  assert.equal(reused.code, 0, reused.stdout);
  const mismatch = await cli(["--json", "--idempotency-key", "fleet-key-0001", "fleet-links", "create", "--name", "Second"], backend, env);
  assert.equal(mismatch.code, ExitCode.Conflict, mismatch.stdout);
  assert.equal(mismatch.envelope.error!.code, "idempotency_mismatch");
});

test("fleet-links list returns url in JSON and never prints it in the human table", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const empty = await cli(["--human", "fleet-links", "list"], transport, env);
  assert.match(empty.stdout, /^Fleet links \(0\)\nNo fleet links$/m);
  const first = await create(transport, env, "--tag", "Lobby,Floor2", "--max-screens", "25");
  const second = await create(transport, env);
  const listed = await cli(["fleet-links", "list"], transport, env);
  assert.equal(listed.code, 0);
  assert.deepEqual(listed.envelope.data.items.map((item: { id: string }) => item.id), [first.id, second.id]);
  assert.equal(listed.envelope.data.items[0].url, first.url, "JSON keeps url as the server returned it");
  const human = await cli(["--human", "fleet-links", "list"], transport, env);
  assert.match(human.stdout, /^ID\s+LABEL\s+ENABLED\s+SCREENS\s+TAGS\s+LAST_USED$/m);
  assert.match(human.stdout, new RegExp(`^${first.id}\\s+Lobby displays\\s+true\\s+0/25\\s+Lobby,Floor2$`, "m"));
  assert.match(human.stdout, new RegExp(`^${second.id}\\s+Lobby displays\\s+true\\s+0$`, "m"));
  assert.doesNotMatch(human.stdout, /srfl_|#fleet=|https:/, "the human list never prints a url");
});

test("fleet-links show prints the url under a sensitive label, or says why it is absent", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id, url } = await create(transport, env, "--tag", "Lobby");
  const shown = await cli(["--json", "fleet-links", "show", id], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(linkCalls(transport).at(-1)!.path, `/api/fleet-links/${id}`);
  assert.equal(shown.envelope.data.url, url);
  assert.equal(shown.envelope.data.revision, 1);
  const human = await cli(["--human", "fleet-links", "show", id], transport, env);
  assert.match(human.stdout, /^Fleet link\nid: flk_/m);
  assert.match(human.stdout, /^tags: Lobby$/m);
  assert.match(human.stdout, /^screens_created: 0$/m);
  assert.match(human.stdout, new RegExp(`^Sensitive fleet link URL .*\\nurl: ${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));

  const absent = new FakeTransport().on("GET", "/api/fleet-links/flk_FIXEDAAAAAAAAAAA", () => ({ status: 200, headers: {}, body: link({ url: undefined }) }));
  const noUrl = await cli(["--human", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], absent, env);
  assert.equal(noUrl.code, 0, noUrl.stderr);
  assert.match(noUrl.stdout, /^URL: not returned\.$/m);
  assert.doesNotMatch(noUrl.stdout, /^url:/m);

  const missing = await cli(["--json", "fleet-links", "show", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
  assert.equal(missing.envelope.error!.next!.command, "screenrig fleet-links list");
  const before = transport.calls.length;
  const malformed = await cli(["--json", "fleet-links", "show", "whk_AAAAAAAAAAAAAAAAAAAA"], transport, env);
  assert.equal(malformed.code, ExitCode.Usage);
  assert.equal(malformed.envelope.error!.next!.command, "screenrig fleet-links list");
  assert.equal(transport.calls.length, before, "a malformed id is refused locally");
});

const MANAGED_MANIFEST = {
  schema: "screenrig.android/v1",
  managed: { package: "ai.screenrig.player.managed", path: "/android/managed/screenrig-managed-26.10.12.apk", signer_sha256: "ab".repeat(32) },
};

function manifestFetch(body: unknown, status = 200): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch & { urls: string[] };
  impl.urls = urls;
  return impl;
}

const linkShown = (overrides: Record<string, unknown> = {}): FakeTransport =>
  new FakeTransport().on("GET", "/api/fleet-links/flk_FIXEDAAAAAAAAAAA", () => ({ status: 200, headers: {}, body: link(overrides) }));

test("fleet-links show --android-provisioning prints the dashboard's QR payload for the link", async () => {
  const env = await enrolled();
  const site = manifestFetch(MANAGED_MANIFEST);
  const shown = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], linkShown(), env, undefined, { siteFetch: site });
  assert.equal(shown.code, 0, shown.stdout);
  assert.deepEqual(site.urls, ["https://screenrig.ai/android/manifest.json"]);
  assert.equal(shown.envelope.data.id, "flk_FIXEDAAAAAAAAAAA");
  assert.deepEqual(shown.envelope.data.provisioning, {
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "ai.screenrig.player.managed/ai.screenrig.player.managed.ScreenRigDeviceAdminReceiver",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": "https://screenrig.ai/android/managed/screenrig-managed-26.10.12.apk",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
    "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
    "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": { fleet_link: SECRET },
  });
  assert.equal(shown.envelope.data.url, undefined, "the link's own URL is not repeated beside the payload");

  const human = await cli(["--human", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], linkShown(), env, undefined, { siteFetch: manifestFetch(MANAGED_MANIFEST) });
  assert.equal(human.code, 0, human.stderr);
  const lines = human.stdout.trimEnd().split("\n");
  const title = lines.indexOf("Android device owner provisioning for fleet link flk_FIXEDAAAAAAAAAAA");
  assert.ok(title >= 0, human.stdout);
  assert.match(lines[title + 1]!, /^Sensitive: this JSON carries the fleet link secret/);
  assert.deepEqual(JSON.parse(lines.at(-1)!), shown.envelope.data.provisioning, "the last line is the payload, ready to encode");
});

test("fleet-links show --android-provisioning refuses without a secret or a build, and says why", async () => {
  const env = await enrolled();
  const site = manifestFetch(MANAGED_MANIFEST);

  const readOnly = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], linkShown({ url: "", url_redacted: true }), env, undefined, { siteFetch: site });
  assert.equal(readOnly.code, ExitCode.Auth);
  assert.equal(readOnly.envelope.error!.code, "fleet_link_secret_unavailable");
  assert.match(readOnly.envelope.error!.detail, /Read only credential/);
  assert.equal(readOnly.envelope.error!.next!.command, "screenrig login --access manage");

  const unsafe = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], linkShown({ url: `http://play.screenrig.ai/player/#fleet=${SECRET}` }), env, undefined, { siteFetch: site });
  assert.equal(unsafe.envelope.error!.code, "fleet_link_secret_unavailable");
  assert.doesNotMatch(unsafe.stdout + unsafe.stderr, /srfl_A/, "a refused link's secret is not echoed");
  assert.deepEqual(site.urls, [], "no site request before the link yields a secret");

  const none = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], linkShown(), env, undefined, { siteFetch: manifestFetch({ schema: "screenrig.android/v1", player: { package: "ai.screenrig.player" } }) });
  assert.equal(none.code, ExitCode.NotFound);
  assert.equal(none.envelope.error!.code, "android_device_owner_build_unavailable");
  assert.match(none.envelope.error!.detail, /lists no Android build for device owner setup/);
  assert.doesNotMatch(none.stdout + none.stderr, /srfl_A/);

  const down = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], linkShown(), env, undefined, { siteFetch: manifestFetch({}, 503) });
  assert.equal(down.envelope.error!.code, "unexpected_response");
});

test("fleet-links show --android-provisioning needs a ScreenRig API origin and is off by default", async () => {
  const env = await enrolled();
  const config = JSON.parse(await readFile(env.configPath, "utf8")) as Record<string, unknown>;
  await writeConfigAtomic(env.configPath, { ...config, api_url: "https://api.example.com" }, env.fs);
  const transport = linkShown();
  const foreign = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA", "--android-provisioning"], transport, env, undefined, { siteFetch: manifestFetch(MANAGED_MANIFEST) });
  assert.equal(foreign.code, ExitCode.Usage);
  assert.equal(foreign.envelope.error!.code, "usage_error");
  assert.equal(transport.calls.length, 0, "refused before any request");

  const plain = await enrolled();
  const site = manifestFetch(MANAGED_MANIFEST);
  const shown = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], linkShown(), plain, undefined, { siteFetch: site });
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(shown.envelope.data.provisioning, undefined);
  assert.deepEqual(site.urls, []);
});

test("an unsafe returned url is withheld with a warning instead of printed", async () => {
  const env = await enrolled();
  const unsafe: Array<[string, RegExp]> = [
    [`http://play.screenrig.ai/player/#fleet=${SECRET}`, /not HTTPS/],
    [`https://play.screenrig.ai/player/?fleet=${SECRET}`, /query/],
    [`https://play.screenrig.ai/s/abc#fleet=${SECRET}`, /\/player\//],
    [`https://play.screenrig.ai/player/#fleet=${SECRET}x`, /#fleet= fragment/],
    [`https://play.screenrig.ai/player/#token=${SECRET}`, /#fleet= fragment/],
    [`https://user:pw@play.screenrig.ai/player/#fleet=${SECRET}`, /credentials/],
    ["not a url", /valid URL/],
  ];
  for (const [url, reason] of unsafe) {
    const transport = new FakeTransport()
      .on("GET", "/api/fleet-links/flk_FIXEDAAAAAAAAAAA", () => ({ status: 200, headers: {}, body: link({ url }) }))
      .on("GET", "/api/fleet-links", () => ({ status: 200, headers: {}, body: { items: [link({ url }), link({ id: "flk_SAFEAAAAAAAAAAAA" })] } }));
    const shown = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], transport, env);
    assert.equal(shown.code, 0, shown.stdout);
    assert.equal(shown.envelope.data.url, undefined, url);
    assert.equal(shown.envelope.data.id, "flk_FIXEDAAAAAAAAAAA");
    assert.deepEqual(shown.envelope.warnings?.map((warning) => warning.code), ["fleet_link_url_withheld"]);
    assert.match(shown.envelope.warnings![0]!.message, reason, url);
    assert.ok(!shown.stdout.includes(url), "the unsafe url is not printed");
    const human = await cli(["--human", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], transport, env);
    assert.ok(!human.stdout.includes(url));
    assert.match(human.stdout, /^URL: withheld, see the warning\.$/m);
    const listed = await cli(["--json", "fleet-links", "list"], transport, env);
    assert.equal(listed.envelope.data.items[0].url, undefined);
    assert.equal(listed.envelope.data.items[1].url, SAFE_URL, "a safe url in the same list is kept");
    assert.match(listed.envelope.warnings![0]!.message, /flk_FIXEDAAAAAAAAAAA/);
  }
  assert.equal(fleetLinkUrlProblem(SAFE_URL), undefined);
  assert.equal(fleetLinkUrlProblem(`http://play.screenrig.localhost:18880/player/#fleet=${SECRET}`), undefined);
  assert.equal(fleetLinkUrlProblem(`http://localhost:5173/player/#fleet=${SECRET}`), undefined);
});

test("a Read only credential's redacted url is reported as withheld, never printed as the link", async () => {
  const env = await enrolled();
  const redacted = link({ url: "", url_redacted: true });
  const transport = new FakeTransport()
    .on("GET", "/api/fleet-links/flk_FIXEDAAAAAAAAAAA", () => ({ status: 200, headers: {}, body: redacted }))
    .on("GET", "/api/fleet-links", () => ({ status: 200, headers: {}, body: { items: [redacted, link({ id: "flk_OTHERAAAAAAAAAAA", url: "", url_redacted: true })] } }));

  const shown = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], transport, env);
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(shown.envelope.data.url, "", "JSON keeps the redacted url as the server returned it");
  assert.equal(shown.envelope.data.url_redacted, true);
  assert.deepEqual(shown.envelope.warnings ?? [], [], "a redacted url is not a safety failure");
  const human = await cli(["--human", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^URL: withheld from a Read only credential\. A Manage sign-in \(screenrig login --access manage\) receives it\.$/m);
  assert.doesNotMatch(human.stdout, /^url:/m, "no empty url line");
  assert.doesNotMatch(human.stdout, /Sensitive fleet link URL|warning:/);

  const listed = await cli(["--json", "fleet-links", "list"], transport, env);
  assert.equal(listed.code, 0, listed.stdout);
  assert.deepEqual(listed.envelope.data.items.map((item: { url: string; url_redacted: boolean }) => [item.url, item.url_redacted]), [["", true], ["", true]]);
  assert.deepEqual(listed.envelope.warnings ?? [], []);
  const table = await cli(["--human", "fleet-links", "list"], transport, env);
  assert.match(table.stdout, /^URLs: withheld from a Read only credential\. With a Manage sign-in \(screenrig login --access manage\), fleet-links show prints one\.$/m);
  assert.equal(table.stdout.match(/withheld from a Read only credential/g)?.length, 1, "the list says it once");
  const manage = await cli(["--human", "fleet-links", "list"], new FakeTransport().on("GET", "/api/fleet-links", () => ({ status: 200, headers: {}, body: { items: [link()] } })), env);
  assert.doesNotMatch(manage.stdout, /withheld/);

  for (const [body, reason] of [
    [link({ url: SAFE_URL, url_redacted: true }), /url_redacted is true but url is not empty/],
    [link({ url: "" }), /not a valid URL/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    const odd = new FakeTransport().on("GET", "/api/fleet-links/flk_FIXEDAAAAAAAAAAA", () => ({ status: 200, headers: {}, body }));
    const answer = await cli(["--json", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], odd, env);
    assert.equal(answer.envelope.data.url, undefined);
    assert.equal(answer.envelope.warnings?.[0]?.code, "fleet_link_url_withheld");
    assert.match(answer.envelope.warnings![0]!.message, reason);
    const text = await cli(["--human", "fleet-links", "show", "flk_FIXEDAAAAAAAAAAA"], odd, env);
    assert.doesNotMatch(text.stdout, /^url:/m);
    assert.ok(!text.stdout.includes(SAFE_URL));
    assert.match(text.stdout, /^URL: withheld, see the warning\.$/m);
  }
});

test("fleet-links update sends only supplied fields, null clears, and the revision guard", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const playlistId = await seedPlaylist(transport);
  const { id } = await create(transport, env, "--tag", "Lobby", "--playlist-id", playlistId, "--max-screens", "10");

  const renamed = await cli(["--json", "fleet-links", "update", id, "--name", "Front of house", "--tag", "North", "--tag", "South", "--expect-rev", "1"], transport, env);
  assert.equal(renamed.code, 0, renamed.stdout);
  let call = linkCalls(transport).at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { label: "Front of house", tags: ["North", "South"] });
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.equal(renamed.envelope.data.revision, 2);

  const cleared = await cli(["--json", "fleet-links", "update", id, "--disable", "--clear-tags", "--clear-playlist", "--clear-max-screens"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  call = linkCalls(transport).at(-1)!;
  assert.deepEqual(call.body, { enabled: false, tags: [], playlist_id: null, max_screens: null });
  assert.equal(call.headers?.["if-match"], undefined, "no --expect-rev sends no If-Match");
  assert.equal(cleared.envelope.data.enabled, false);
  assert.equal(cleared.envelope.data.playlist_id, undefined);
  assert.equal(cleared.envelope.data.max_screens, undefined);

  const enabled = await cli(["--human", "fleet-links", "update", id, "--enable", "--playlist-id", playlistId, "--max-screens", "40"], transport, env);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { enabled: true, playlist_id: playlistId, max_screens: 40 });
  assert.match(enabled.stdout, new RegExp(`^Updated fleet link ${id}\\. Screens it already created are unchanged\\.$`, "m"));
  assert.match(enabled.stdout, /^enabled: true$/m);
  assert.doesNotMatch(enabled.stdout, /srfl_|#fleet=/, "update does not print the url");

  const stale = await cli(["--json", "fleet-links", "update", id, "--disable", "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition, stale.stdout);
  assert.equal(stale.envelope.error!.code, "revision_conflict");
  assert.equal(stale.envelope.error!.next!.command, `screenrig fleet-links show ${id}`);

  const before = transport.calls.length;
  for (const [args, message] of [
    [[], /at least one of --name or --enable/],
    [["--enable", "--disable"], /--enable cannot be used with --disable/],
    [["--tag", "Lobby", "--clear-tags"], /--clear-tags cannot be used with --tag|--tag cannot be used with --clear-tags/],
    [["--playlist-id", playlistId, "--clear-playlist"], /--clear-playlist cannot be used with --playlist-id|--playlist-id cannot be used with --clear-playlist/],
    [["--max-screens", "5", "--clear-max-screens"], /--clear-max-screens cannot be used with --max-screens|--max-screens cannot be used with --clear-max-screens/],
    [["--max-screens", "0"], /1 to 10000/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "fleet-links", "update", id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(transport.calls.length, before);
});

test("--expires-at takes an RFC 3339 time with seconds and a zone and sends the UTC instant it names", () => {
  assert.equal(fleetLinkExpiresAt("2026-12-31T23:59:59Z"), "2026-12-31T23:59:59Z");
  assert.equal(fleetLinkExpiresAt("2026-12-31T18:59:59-05:00"), "2026-12-31T23:59:59Z");
  assert.equal(fleetLinkExpiresAt("2027-01-01T08:00:00+09:00"), "2026-12-31T23:00:00Z");
  assert.equal(fleetLinkExpiresAt("2026-12-31T23:59:59.5+00:00"), "2026-12-31T23:59:59.500Z");
  assert.equal(fleetLinkExpiresAt("2020-01-01T00:00:00Z"), "2020-01-01T00:00:00Z", "a time already past is allowed");
  for (const value of ["2026-12-31", "2026-12-31T23:59:59", "2026-12-31T23:59Z", "2026-12-31 23:59:59Z", "2026-02-30T00:00:00Z",
    "2026-12-31T24:00:00Z", "2026-12-31T23:59:59+24:00", "2026-12-31T23:59:59z", "tomorrow", "1788307199", "none"]) {
    assert.throws(() => fleetLinkExpiresAt(value), /--expires-at takes an RFC 3339 time with seconds and a zone/, value);
  }
});

test("fleet-links create --expires-at sends the UTC instant, and the link prints it", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "fleet-links", "create", "--name", "Trade show", "--expires-at", "2026-12-31T18:59:59-05:00"], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { label: "Trade show", expires_at: "2026-12-31T23:59:59Z" });
  assert.equal(created.envelope.data.expires_at, "2026-12-31T23:59:59Z");

  const human = await cli(["--human", "fleet-links", "create", "--name", "Kiosks", "--max-screens", "12", "--expires-at", "2026-12-31T23:59:59Z"], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^screens_created: 0\nmax_screens: 12\nexpires_at: 2026-12-31T23:59:59Z$/m);
  assert.doesNotMatch(human.stdout, /expired/);

  const plain = await cli(["--json", "fleet-links", "create", "--name", "No expiry"], transport, env);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { label: "No expiry" }, "no --expires-at sends no expires_at");
  assert.equal(plain.envelope.data.expires_at, undefined);
  const plainHuman = await cli(["--human", "fleet-links", "create", "--name", "Still none"], transport, env);
  assert.doesNotMatch(plainHuman.stdout, /expires_at/);
});

test("fleet-links create refuses an --expires-at that is not an RFC 3339 time with a zone, before any request", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const cases: Array<[string, RegExp]> = [
    ["2026-12-31", /RFC 3339 time with seconds and a zone/],
    ["2026-12-31T23:59:59", /RFC 3339 time with seconds and a zone/],
    ["2026-02-30T00:00:00Z", /RFC 3339 time with seconds and a zone/],
    ["tomorrow", /RFC 3339 time with seconds and a zone/],
    ["", /--expires-at requires a value/],
  ];
  for (const [value, message] of cases) {
    const refused = await cli(["--json", "fleet-links", "create", "--name", "Lobby", "--expires-at", value], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${value}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message, value);
  }
  const twice = await cli(["--json", "fleet-links", "create", "--name", "Lobby", "--expires-at", "2026-12-31T23:59:59Z", "--expires-at", "2027-01-31T23:59:59Z"], transport, env);
  assert.equal(twice.code, ExitCode.Usage);
  assert.match(twice.envelope.error!.detail, /only once/);
  assert.equal(linkCalls(transport).length, 0, "invalid input never reaches the server");
});

test("fleet-links update sets, moves and clears the expiry", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await create(transport, env, "--tag", "Lobby");

  const set = await cli(["--json", "fleet-links", "update", id, "--expires-at", "2027-03-01T09:30:00+01:00", "--expect-rev", "1"], transport, env);
  assert.equal(set.code, 0, set.stdout);
  let call = linkCalls(transport).at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.deepEqual(call.body, { expires_at: "2027-03-01T08:30:00Z" });
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.equal(set.envelope.data.expires_at, "2027-03-01T08:30:00Z");

  const moved = await cli(["--human", "fleet-links", "update", id, "--name", "Lobby displays", "--expires-at", "2027-04-01T00:00:00Z"], transport, env);
  assert.equal(moved.code, 0, moved.stderr);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { label: "Lobby displays", expires_at: "2027-04-01T00:00:00Z" });
  assert.match(moved.stdout, /^expires_at: 2027-04-01T00:00:00Z$/m);
  assert.doesNotMatch(moved.stdout, /srfl_|#fleet=/, "update does not print the url");

  const cleared = await cli(["--json", "fleet-links", "update", id, "--clear-expires-at"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  call = linkCalls(transport).at(-1)!;
  assert.deepEqual(call.body, { expires_at: null });
  assert.equal(call.headers?.["if-match"], undefined, "no --expect-rev sends no If-Match");
  assert.equal(cleared.envelope.data.expires_at, undefined);
  const shown = await cli(["--human", "fleet-links", "show", id], transport, env);
  assert.doesNotMatch(shown.stdout, /expires_at/, "a link without an expiry prints none");

  const together = await cli(["--json", "fleet-links", "update", id, "--disable", "--clear-expires-at", "--clear-max-screens"], transport, env);
  assert.equal(together.code, 0, together.stdout);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { enabled: false, max_screens: null, expires_at: null });

  const before = transport.calls.length;
  for (const [args, message] of [
    [["--expires-at", "2027-04-01T00:00:00Z", "--clear-expires-at"], /--clear-expires-at cannot be used with --expires-at|--expires-at cannot be used with --clear-expires-at/],
    [["--expires-at", "2027-04-01"], /RFC 3339 time with seconds and a zone/],
    [["--expires-at", "2027-04-01T00:00:00"], /RFC 3339 time with seconds and a zone/],
    [["--expires-at", "2027-04-01T00:00:00Z", "--expires-at", "2027-05-01T00:00:00Z"], /only once/],
    [[], /at least one of --name or --enable or --disable or --tag or --clear-tags or --field or --clear-fields or --playlist-id or --clear-playlist or --max-screens or --clear-max-screens or --expires-at or --clear-expires-at/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "fleet-links", "update", id, ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(transport.calls.length, before, "refused input never reaches the server");
});

test("fleet-links list and show print expires_at and mark a link that has passed it", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const never = await create(transport, env);
  const later = await create(transport, env, "--expires-at", "2026-12-31T23:59:59Z");
  const past = await create(transport, env, "--expires-at", "2026-08-01T00:00:00Z");
  const now = await create(transport, env, "--expires-at", "2026-08-14T17:00:00Z");

  const table = await cli(["--human", "fleet-links", "list"], transport, env);
  assert.match(table.stdout, /^ID\s+LABEL\s+ENABLED\s+SCREENS\s+EXPIRES\s+TAGS\s+LAST_USED$/m);
  assert.match(table.stdout, new RegExp(`^${never.id}\\s+Lobby displays\\s+true\\s+0$`, "m"), "a link that never expires has an empty cell");
  assert.match(table.stdout, new RegExp(`^${later.id}\\s+Lobby displays\\s+true\\s+0\\s+2026-12-31T23:59:59Z$`, "m"));
  assert.match(table.stdout, new RegExp(`^${past.id}\\s+Lobby displays\\s+true\\s+0\\s+2026-08-01T00:00:00Z \\(expired\\)$`, "m"));
  assert.match(table.stdout, new RegExp(`^${now.id}\\s+Lobby displays\\s+true\\s+0\\s+2026-08-14T17:00:00Z \\(expired\\)$`, "m"), "a link expires at its expires_at");
  assert.equal(table.stdout.match(/\(expired\)/g)?.length, 2);

  const listed = await cli(["--json", "fleet-links", "list"], transport, env);
  assert.deepEqual(listed.envelope.data.items.map((item: { expires_at?: string }) => item.expires_at),
    [undefined, "2026-12-31T23:59:59Z", "2026-08-01T00:00:00Z", "2026-08-14T17:00:00Z"], "JSON keeps expires_at as the server returned it");
  assert.doesNotMatch(listed.stdout, /expired/, "JSON adds no derived field");

  const expired = await cli(["--human", "fleet-links", "show", past.id], transport, env);
  assert.match(expired.stdout, /^expires_at: 2026-08-01T00:00:00Z \(expired\)$/m);
  const upcoming = await cli(["--human", "fleet-links", "show", later.id], transport, env);
  assert.match(upcoming.stdout, /^expires_at: 2026-12-31T23:59:59Z$/m);
  const never_ = await cli(["--human", "fleet-links", "show", never.id], transport, env);
  assert.doesNotMatch(never_.stdout, /expires_at/);
  const rotated = await cli(["--human", "fleet-links", "rotate", past.id], transport, env);
  assert.match(rotated.stdout, /^expires_at: 2026-08-01T00:00:00Z \(expired\)$/m);

  const plain = new FakeTransport().on("GET", "/api/fleet-links", () => ({ status: 200, headers: {}, body: { items: [link()] } }));
  const noExpiry = await cli(["--human", "fleet-links", "list"], plain, env);
  assert.match(noExpiry.stdout, /^ID\s+LABEL\s+ENABLED\s+SCREENS\s+TAGS\s+LAST_USED$/m, "no EXPIRES column while no link has an expiry");
  const odd = new FakeTransport().on("GET", "/api/fleet-links", () => ({ status: 200, headers: {}, body: { items: [link({ expires_at: "soon" })] } }));
  const unreadable = await cli(["--human", "fleet-links", "list"], odd, env);
  assert.match(unreadable.stdout, /\s+soon\s/, "an unreadable expires_at prints as returned, unmarked");
  assert.doesNotMatch(unreadable.stdout, /expired/);
});

test("fleet-links help names --expires-at and --clear-expires-at, and update counts both as a change", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  // The help wraps long descriptions; compare the text with its line breaks and indentation collapsed.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const createHelp = flat((await cli(["fleet-links", "create", "--help"], transport, env)).stdout);
  assert.ok(createHelp.includes("--expires-at <TIME> Stop creating and recovering screens at this RFC 3339 time with a zone, such as 2026-12-31T23:59:59Z (default: never) --disabled"), createHelp);
  const updateHelp = flat((await cli(["fleet-links", "update", "--help"], transport, env)).stdout);
  assert.ok(updateHelp.includes("--expires-at <TIME> Stop creating and recovering screens at this RFC 3339 time with a zone, such as 2026-12-31T23:59:59Z --clear-expires-at Remove the expiry; the link never expires --expect-rev"), updateHelp);
  assert.match(updateHelp, /Provide at least one of .* or --expires-at or --clear-expires-at\./);

  const structured = await cli(["--json", "fleet-links", "update", "--help"], transport, env);
  const options = (structured.envelope.data.options as Array<{ name: string; conflicts?: string[] }>).filter((option) => option.name.includes("expires-at"));
  assert.deepEqual(options.map((option) => [option.name, option.conflicts]), [["--expires-at", ["--clear-expires-at"]], ["--clear-expires-at", ["--expires-at"]]]);
  assert.equal(transport.calls.length, 0, "help makes no request");
});

test("fleet-links rotate replaces the url and prints the new one", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const first = await create(transport, env);
  const rotated = await cli(["--json", "fleet-links", "rotate", first.id, "--expect-rev", "1"], transport, env);
  assert.equal(rotated.code, 0, rotated.stdout);
  const call = linkCalls(transport).at(-1)!;
  assert.equal(call.method, "POST");
  assert.equal(call.path, `/api/fleet-links/${first.id}/rotate`);
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.match(rotated.envelope.data.url, /#fleet=srfl_/);
  assert.notEqual(rotated.envelope.data.url, first.url);
  assert.equal(rotated.envelope.data.revision, 2);
  assert.doesNotMatch(await readFile(env.configPath, "utf8"), /srfl_|pending_writes/);
  const human = await cli(["--human", "fleet-links", "rotate", first.id], transport, env);
  assert.match(human.stdout, new RegExp(`^Rotated fleet link ${first.id}\\. The old URL stopped working; screens it already created keep playing\\.`, "m"));
  assert.match(human.stdout, /^url: https:\/\/play\.screenrig\.ai\/player\/#fleet=srfl_/m);
  const stale = await cli(["--json", "fleet-links", "rotate", first.id, "--expect-rev", "1"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition);
  const missing = await cli(["--json", "fleet-links", "rotate", MISSING], transport, env);
  assert.equal(missing.code, ExitCode.NotFound);
});

test("fleet-links delete returns a deletion envelope and honors --expect-rev", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const { id } = await create(transport, env);
  const stale = await cli(["--json", "fleet-links", "delete", id, "--expect-rev", "7"], transport, env);
  assert.equal(stale.code, ExitCode.Precondition);
  assert.equal(stale.envelope.error!.next!.command, `screenrig fleet-links show ${id}`);
  const deleted = await cli(["--json", "fleet-links", "delete", id, "--expect-rev", "1"], transport, env);
  assert.equal(deleted.code, 0, deleted.stdout);
  const call = linkCalls(transport).at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.headers?.["if-match"], '"1"');
  assert.ok(call.headers?.["idempotency-key"]);
  assert.deepEqual(deleted.envelope.data, { id, deleted: true });
  const gone = await cli(["--json", "fleet-links", "delete", id], transport, env);
  assert.equal(gone.code, ExitCode.NotFound);
  assert.equal(gone.envelope.error!.next!.command, "screenrig fleet-links list");
  const { id: other } = await create(transport, env);
  const human = await cli(["--human", "fleet-links", "delete", other], transport, env);
  assert.match(human.stdout, new RegExp(`^Deleted fleet link ${other}\\. Its URL stopped working; screens it created stay, with their playlists and tags\\.$`, "m"));
});

test("screen show names the fleet link that created the screen", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const screen: Screen = {
    id: "scr_FLEETAAAAAAAAAAAAAAAAAAA", label: "LOBBY-07", public_id: "pub_FLEET", state: "active", revision: 1, manifest_revision: 1,
    content_access_generation: 1, online: false, created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z",
    tags: ["Lobby"], fleet_link_id: "flk_FIXEDAAAAAAAAAAA",
  };
  transport.putScreen!(screen);
  const human = await cli(["--human", "screen", "show", screen.id], transport, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Tags: Lobby\nCreated by fleet link: flk_FIXEDAAAAAAAAAAA$/m);
  const json = await cli(["--json", "screen", "show", screen.id], transport, env);
  assert.equal(json.envelope.data.fleet_link_id, "flk_FIXEDAAAAAAAAAAA");
  transport.putScreen!({ ...screen, fleet_link_id: undefined });
  const plain = await cli(["--human", "screen", "show", screen.id], transport, env);
  assert.doesNotMatch(plain.stdout, /Created by fleet link/);
});

test("redaction masks fleet link secrets and #fleet= fragments in free text", () => {
  assert.equal(redactText(`open ${SAFE_URL} now`), "open https://play.screenrig.ai/player/#fleet=*** now");
  assert.equal(redactText(`secret ${SECRET} end`), "secret srfl_*** end");
});

test("fleet-links create and update preset the fields every new screen starts with", async () => {
  const env = await enrolled();
  const transport = memoryBackend();
  const created = await cli(["--json", "fleet-links", "create", "--name", "Stores", "--field", "region=north", "--field", "chain= Acme Foods "], transport, env);
  assert.equal(created.code, 0, created.stdout);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { label: "Stores", fields: { region: "north", chain: "Acme Foods" } });
  const id = created.envelope.data.id as string;

  const replaced = await cli(["--json", "fleet-links", "update", id, "--field", "region=south"], transport, env);
  assert.equal(replaced.code, 0, replaced.stdout);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { fields: { region: "south" } });
  const cleared = await cli(["--json", "fleet-links", "update", id, "--clear-fields"], transport, env);
  assert.equal(cleared.code, 0, cleared.stdout);
  assert.deepEqual(linkCalls(transport).at(-1)!.body, { fields: null });

  const before = transport.calls.length;
  for (const [args, message] of [
    [["create", "--name", "Bad", "--field", "Region=north"], /lower case letters, digits or underscores/],
    [["create", "--name", "Bad", "--field", "region"], /NAME=VALUE/],
    [["create", "--name", "Bad", "--field", "region=a", "--field", "region=b"], /more than once/],
    [["update", id, "--field", "region=a", "--clear-fields"], /--clear-fields cannot be used with --field|--field cannot be used with --clear-fields/],
  ] as Array<[string[], RegExp]>) {
    const refused = await cli(["--json", "fleet-links", ...args], transport, env);
    assert.equal(refused.code, ExitCode.Usage, `${args.join(" ")}: ${refused.stdout}`);
    assert.match(refused.envelope.error!.detail, message);
  }
  assert.equal(transport.calls.length, before, "invalid input never reaches the server");
});

test("a fleet link's preset fields print as one line", () => {
  const link = { id: "flk_1", label: "Stores", enabled: true, tags: [], fields: { region: "north", chain: "Acme" }, screens_created: 0, revision: 1 } as unknown as Parameters<typeof fleetLinkLines>[0];
  assert.ok(fleetLinkLines(link, new Date(0)).includes("fields: region=north, chain=Acme"));
  assert.ok(!fleetLinkLines({ ...link!, fields: undefined }, new Date(0)).some((line) => line.startsWith("fields:")));
});
