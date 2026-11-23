import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { writeConfigAtomic } from "./config.js";
import { commandHelp } from "./help-tree.js";
import { run } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const APP = "app_AAAAAAAAAAAAAAAAAAAAAAAA";
const OLD = "rel_OLDAAAAAAAAAAAAAAAAAAAA";
const AT = "2026-11-23T10:00:00.000Z";

const problem = (status: number, code: string, detail: string) => ({
  status, headers: { "content-type": "application/problem+json" },
  body: { type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, status, detail, code },
});

async function harness(t: TestContext) {
  const dir = await testTemp("app-releases-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, settings: { XDG_CONFIG_HOME: dir } };
  await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  return async (argv: string[], transport: FakeTransport) => {
    let output = "";
    const code = await run({
      argv, settings: fs.settings, fs, homedir: fs.homedir, cwd: () => dir, transport,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
      now: () => new Date(AT), sleep: async () => undefined,
    });
    return { code, output, envelope: output.trim().startsWith("{") ? JSON.parse(output) : undefined };
  };
}

const RELEASES = [
  { id: "rel_NEW", state: "ready", latest: true, created_at: "2026-11-20T10:00:00Z", ready_at: "2026-11-20T10:01:00Z", operation_id: "op_1", archive_sha256: "a".repeat(64), compressed_bytes: 100, expanded_bytes: 300, placements: 1, agent: { agent_id: "agt_1", name: "Lobby agent", agent_type: "claude" } },
  { id: OLD, state: "ready", latest: false, created_at: "2026-11-10T10:00:00Z", operation_id: "op_0", archive_sha256: "b".repeat(64), compressed_bytes: 90, placements: 2, expires_at: "2026-12-20T10:01:00Z", actor: { user_id: "usr_1", display_name: "Ana" } },
  { id: "rel_BAD", state: "failed", latest: false, created_at: "2026-11-09T10:00:00Z", operation_id: "op_b", error_code: "extraction_failed", archive_sha256: "c".repeat(64), compressed_bytes: 80, placements: 0 },
];

test("app releases follows next_cursor to the end, or reads one page with --limit and --cursor", async (t) => {
  const invoke = await harness(t);
  const queries: unknown[] = [];
  const transport = new FakeTransport().on("GET", `/api/applications/${APP}/releases`, (request) => {
    queries.push(request.query ?? {});
    const cursor = request.query?.cursor;
    return { status: 200, headers: {}, body: cursor === "rlc1_2_x"
      ? { items: RELEASES.slice(2), next_cursor: null }
      : cursor === "rlc1_1_x" ? { items: RELEASES.slice(1, 2), next_cursor: "rlc1_2_x" }
      : { items: RELEASES.slice(0, 1), next_cursor: "rlc1_1_x" } };
  });
  const all = await invoke(["--json", "app", "releases", APP], transport);
  assert.equal(all.code, 0, all.output);
  assert.deepEqual(all.envelope!.data.items.map((item: { id: string }) => item.id), ["rel_NEW", OLD, "rel_BAD"]);
  assert.equal(all.envelope!.data.next_cursor, null);
  assert.deepEqual(queries, [{}, { cursor: "rlc1_1_x" }, { cursor: "rlc1_2_x" }]);
  queries.length = 0;
  const page = await invoke(["--json", "app", "releases", APP, "--limit", "1", "--cursor", "rlc1_1_x"], transport);
  assert.equal(page.code, 0, page.output);
  assert.deepEqual(queries, [{ limit: "1", cursor: "rlc1_1_x" }]);
  assert.equal(page.envelope!.data.next_cursor, "rlc1_2_x");
  const human = await invoke(["--human", "app", "releases", APP, "--limit", "1"], transport);
  assert.equal(human.code, 0, human.output);
  assert.match(human.output, new RegExp(`^Application ${APP} releases \\(1\\)$`, "m"));
  assert.match(human.output, /^rel_NEW\s+ready \(latest\)\s+1\s+300\s+Lobby agent\s+2026-11-20T10:00:00Z$/m);
  assert.match(human.output, new RegExp(`^next: screenrig app releases ${APP} --cursor rlc1_1_x$`, "m"));
  const old = await invoke(["--human", "app", "releases", APP, "--cursor", "rlc1_1_x"], transport);
  assert.match(old.output, /^rel_OLD\S+\s+ready\s+2\s+90\s+Ana\s+2026-11-10T10:00:00Z\s+2026-12-20T10:01:00Z$/m);
  const bad = await invoke(["--human", "app", "releases", APP, "--cursor", "rlc1_2_x"], transport);
  assert.match(bad.output, /^rel_BAD\s+failed extraction_failed\s+0\s+80\s+-\s+2026-11-09T10:00:00Z$/m);
});

test("app releases refuses a limit outside 1 to 100 before any request", async (t) => {
  const invoke = await harness(t);
  const transport = new FakeTransport();
  const answer = await invoke(["--json", "app", "releases", APP, "--limit", "101"], transport);
  assert.equal(answer.code, 2, answer.output);
  assert.equal(transport.calls.length, 0);
});

const PREVIEW = {
  release_id: OLD, dry_run: true, already: 1, screens: 3,
  playlists: [
    { playlist_id: "pl_ONE", playlist_name: "Lobby", placements: 1, screen_count: 2, outcome: "would_change" },
    { playlist_id: "pl_TWO", playlist_name: "Cafe", placements: 2, screen_count: 1, outcome: "would_change" },
  ],
};

test("app use-release previews by default: dry_run true, no idempotency key, and the apply command as next", async (t) => {
  const invoke = await harness(t);
  const transport = new FakeTransport().on("POST", `/api/applications/${APP}/releases/${OLD}/use`, () => ({ status: 200, headers: {}, body: PREVIEW }));
  const answer = await invoke(["--json", "app", "use-release", APP, OLD], transport);
  assert.equal(answer.code, 0, answer.output);
  const call = transport.calls[0]!;
  assert.deepEqual(call.body, { dry_run: true });
  assert.equal(call.headers?.["idempotency-key"], undefined);
  assert.equal(answer.envelope!.data.dry_run, true);
  assert.equal(answer.envelope!.data.next.command, `screenrig app use-release ${APP} ${OLD} --apply`);
  const human = await invoke(["--human", "app", "use-release", APP, OLD], transport);
  assert.match(human.output, new RegExp(`^Preview: ${OLD} would replace the release of ${APP} in 2 playlists \\(3 screens\\)$`, "m"));
  assert.match(human.output, /^pl_ONE\s+Lobby\s+1\s+2\s+would_change$/m);
  assert.match(human.output, new RegExp(`^next: screenrig app use-release ${APP} ${OLD} --apply$`, "m"));
});

test("app use-release --apply writes with an idempotency key and reports refused playlists with exit 0", async (t) => {
  const invoke = await harness(t);
  const applied = {
    release_id: OLD, dry_run: false, already: 0, screens: 3,
    playlists: [
      { playlist_id: "pl_ONE", playlist_name: "Lobby", placements: 1, screen_count: 2, outcome: "applied", revision: 8 },
      { playlist_id: "pl_TWO", playlist_name: "Cafe", placements: 2, screen_count: 1, outcome: "refused", problem: { code: "pending_review", detail: "The playlist waits for approval." } },
      { playlist_id: "pl_SAME", playlist_name: "Bar", placements: 0, screen_count: 0, outcome: "unchanged" },
    ],
  };
  const transport = new FakeTransport().on("POST", `/api/applications/${APP}/releases/${OLD}/use`, () => ({ status: 200, headers: {}, body: applied }));
  const answer = await invoke(["--json", "app", "use-release", APP, OLD, "--apply"], transport);
  assert.equal(answer.code, 0, answer.output);
  const call = transport.calls[0]!;
  assert.deepEqual(call.body, { dry_run: false });
  assert.match(call.headers?.["idempotency-key"] ?? "", /^[A-Za-z0-9_-]{16,}$/);
  assert.deepEqual(answer.envelope!.data.playlists.map((playlist: { outcome: string }) => playlist.outcome), ["applied", "refused", "unchanged"]);
  assert.equal(answer.envelope!.warnings[0].code, "playlists_refused");
  assert.match(answer.envelope!.warnings[0].message, /pl_TWO/);
  assert.equal(answer.envelope!.data.next.command, `screenrig app use-release ${APP} ${OLD} --apply`);
  const human = await invoke(["--human", "app", "use-release", APP, OLD, "--apply"], transport);
  assert.equal(human.code, 0, human.output);
  assert.match(human.output, new RegExp(`^${APP} moved to ${OLD}: 1 applied, 1 unchanged, 1 refused \\(3 screens\\)$`, "m"));
  assert.match(human.output, /^pl_ONE\s+Lobby\s+1\s+2\s+applied \(revision 8\)$/m);
  assert.doesNotMatch(human.output, /^pl_SAME/m);
  assert.match(human.output, /^refused pl_TWO: pending_review: The playlist waits for approval\.$/m);
});

test("app use-release --apply with every playlist moved has no next and no warning", async (t) => {
  const invoke = await harness(t);
  const transport = new FakeTransport().on("POST", `/api/applications/${APP}/releases/${OLD}/use`, () => ({ status: 200, headers: {}, body: {
    release_id: OLD, dry_run: false, already: 0, screens: 1,
    playlists: [{ playlist_id: "pl_ONE", playlist_name: "Lobby", placements: 1, screen_count: 1, outcome: "applied", revision: 2 }],
  } }));
  const answer = await invoke(["--json", "app", "use-release", APP, OLD, "--apply"], transport);
  assert.equal(answer.code, 0, answer.output);
  assert.equal(answer.envelope!.data.next, undefined);
  assert.deepEqual(answer.envelope!.warnings ?? [], []);
});

test("app use-release exits non-zero on problems: not ready, other application, proposing credential", async (t) => {
  const invoke = await harness(t);
  for (const [status, code, exit] of [[409, "resource_conflict", 5], [404, "not_found", 4], [403, "forbidden", 3]] as const) {
    const transport = new FakeTransport().on("POST", `/api/applications/${APP}/releases/${OLD}/use`, () => problem(status, code, "Refused."));
    const answer = await invoke(["--json", "app", "use-release", APP, OLD, "--apply"], transport);
    assert.equal(answer.code, exit, answer.output);
    assert.equal(answer.envelope!.error.code, code);
  }
});

test("app releases and app use-release name their usage in help", () => {
  assert.match(commandHelp(["app", "releases"]).usage, /app releases \[options\] <id>|app releases <id>/);
  const use = commandHelp(["app", "use-release"]);
  assert.match(use.usage, /<id> <release_id>/);
  assert.match(use.usage, /--apply/);
});
