import assert from "node:assert/strict";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { Screen } from "./adapters/protocol.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { fleetLinkUrlProblem } from "./fleet-links.js";
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

async function cli(argv: string[], transport: FakeTransport, env: Env, logger?: OperationLogger): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
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
