import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { initializePlaylist } from "./playlist-authoring.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";

const SCREEN = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const PLAYLIST = "pl_LOBBY";
const AGENT = "agt_AAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-08-14T17:00:00.000Z");
const NOTE_HEADER = "screenrig-review-note";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; status: number; hint?: string; next?: { command: string; argv: string[] } };
  warnings?: Array<{ code: string; message: string }>;
}
interface Env { fs: ConfigFs; cwd: string; configPath: string; dir: string }

function json(status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}

function privateJson(status: number, body: unknown): TransportResponse {
  return json(status, body, { "cache-control": "private, no-store" });
}

function summary(id: string, kind: "playlist_change" | "screen_change", subject: { type: "playlist" | "screen"; id: string; name: string }, screens = 1) {
  return { id, kind, state: "pending" as const, url: `https://screenrig.ai/dashboard/reviews/${id}`, subject, impact: { screens } };
}

function pending(review: ReturnType<typeof summary>, playlist?: Record<string, unknown>): TransportResponse {
  return json(202, { status: "pending_review", review, ...(playlist ? { playlist } : {}) });
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function enrolled(): Promise<Env> {
  const dir = await testTemp("reviews-");
  const configDir = path.join(dir, "config");
  const cwd = path.join(dir, "cwd");
  await mkdir(cwd, { recursive: true });
  const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
  const configPath = path.join(configDir, "screenrig", "config.json");
  await writeConfigAtomic(configPath, { api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
  const document = initializePlaylist({ name: "Lobby", media: [{ id: "med_IMAGE", primitive: "image", state: "ready" }], width: 1920, height: 1080, durationMs: 8000, fit: "contain" });
  await writeFile(path.join(cwd, "lobby.json"), JSON.stringify(document));
  return { fs, cwd, configPath, dir };
}

async function cli(argv: string[], transport: FakeTransport, env: Env): Promise<{ code: number; stdout: string; stderr: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const runtime: CliRuntime = {
    argv, env: env.fs.env, stdout, stderr, now: () => NOW, sleep: async () => undefined,
    homedir: env.fs.homedir, cwd: () => env.cwd, fs: env.fs, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  const text = await outP;
  const err = await errP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human */ }
  return { code, stdout: text, stderr: err, envelope };
}

function writes(transport: FakeTransport): TransportRequest[] {
  return transport.calls.filter((call) => call.method !== "GET");
}

function assertPending(result: Awaited<ReturnType<typeof cli>>, id: string): void {
  assert.equal(result.code, ExitCode.Success, result.stdout);
  assert.equal(result.envelope.ok, true);
  assert.equal(result.envelope.data.status, "pending_review");
  assert.equal(result.envelope.data.review.id, id);
  assert.deepEqual(result.envelope.data.next.argv, ["reviews", "show", id]);
  assert.equal(result.envelope.data.next.command, `screenrig reviews show ${id}`);
  assert.deepEqual(result.envelope.warnings, [{ code: "pending_review", message: `Waiting for a person to approve: https://screenrig.ai/dashboard/reviews/${id}` }]);
}

test("playlist create and update that wait for review are a success with the review, a warning and next", async () => {
  const env = await enrolled();
  try {
    const playlist = { id: PLAYLIST, revision: 1, name: "Lobby", approved_revision: 0, approval: { state: "pending", review_id: "rvw_CREATE" } };
    const transport = new FakeTransport()
      .on("POST", "/api/playlists", () => pending(summary("rvw_CREATE", "playlist_change", { type: "playlist", id: PLAYLIST, name: "Lobby" }, 0), playlist))
      .on("PUT", `/api/playlists/${PLAYLIST}`, () => pending(summary("rvw_UPDATE", "playlist_change", { type: "playlist", id: PLAYLIST, name: "Lobby" }, 3), playlist));

    const created = await cli(["--json", "playlist", "create", "lobby.json", "--note", "  New lobby loop  "], transport, env);
    assertPending(created, "rvw_CREATE");
    assert.equal(created.envelope.data.playlist.id, PLAYLIST);
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], encodeURIComponent("New lobby loop"));

    const updated = await cli(["--json", "playlist", "update", PLAYLIST, "lobby.json", "--expect-rev", "1"], transport, env);
    assertPending(updated, "rvw_UPDATE");
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], undefined, "no --note sends no header");
    assert.equal(transport.calls.at(-1)!.headers?.["if-match"], "\"1\"");

    const human = await cli(["--human", "playlist", "update", PLAYLIST, "lobby.json", "--note", "Adds the weekend hours"], transport, env);
    assert.equal(human.code, ExitCode.Success, human.stdout);
    assert.match(human.stdout, /Playlist change waiting for review/);
    assert.match(human.stdout, /impact: approving changes 3 screens/);
    assert.match(human.stdout, /url: https:\/\/screenrig\.ai\/dashboard\/reviews\/rvw_UPDATE/);
    assert.match(human.stdout, /next: screenrig reviews show rvw_UPDATE/);
    assert.match(human.stdout, /Nothing changes on glass until a person approves it/);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("--note is checked locally: at most 280 characters and no control characters; it travels percent-encoded as UTF-8", async () => {
  const env = await enrolled();
  try {
    const transport = new FakeTransport()
      .on("POST", "/api/playlists", () => json(201, { id: PLAYLIST, revision: 1, name: "Lobby" }));
    for (const note of ["x".repeat(281), "two\nlines", "   "]) {
      const refused = await cli(["--json", "playlist", "create", "lobby.json", "--note", note], transport, env);
      assert.equal(refused.code, ExitCode.Usage, refused.stdout);
      assert.equal(refused.envelope.error?.code, "usage_error");
    }
    assert.equal(writes(transport).length, 0, "a refused note sends nothing");

    const fits = await cli(["--json", "playlist", "create", "lobby.json", "--note", "é".repeat(280)], transport, env);
    assert.equal(fits.code, ExitCode.Success, fits.stdout);
    assert.equal(fits.envelope.warnings?.length ?? 0, 0, "a write that applies is unchanged");
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], "%C3%A9".repeat(280));

    assert.equal((await cli(["--json", "playlist", "create", "lobby.json", "--note", "Café menu — new prices"], transport, env)).code, ExitCode.Success);
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], "Caf%C3%A9%20menu%20%E2%80%94%20new%20prices");

    const mixed = "Café menu: 50% off, 🍕 & 朝食";
    assert.equal((await cli(["--json", "playlist", "create", "lobby.json", "--note", mixed], transport, env)).code, ExitCode.Success);
    const header = transport.calls.at(-1)!.headers?.[NOTE_HEADER]!;
    assert.equal(header, "Caf%C3%A9%20menu%3A%2050%25%20off%2C%20%F0%9F%8D%95%20%26%20%E6%9C%9D%E9%A3%9F");
    assert.match(header, /^[\x21-\x7e]+$/, "the header value is printable ASCII");
    assert.equal(decodeURIComponent(header), mixed);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("screen assign, schedule and takeover writes send --note and report a review for one screen", async () => {
  const env = await enrolled();
  try {
    const screenReview = (id: string) => summary(id, "screen_change", { type: "screen", id: SCREEN, name: "Lobby" });
    const transport = new FakeTransport()
      .on("GET", `/api/playlists/${PLAYLIST}`, () => json(200, { id: PLAYLIST, revision: 1, name: "Lobby", pages: [] }))
      .on("PATCH", `/api/screens/${SCREEN}`, () => pending(screenReview("rvw_ASSIGN")))
      .on("DELETE", `/api/screens/${SCREEN}/playlist-schedule`, () => pending(screenReview("rvw_SCHEDULE")))
      .on("POST", `/api/screens/${SCREEN}/takeover`, () => pending(screenReview("rvw_TAKEOVER")))
      .on("DELETE", `/api/screens/${SCREEN}/takeover`, () => pending(screenReview("rvw_TAKEOVER_CLEAR")));

    const assigned = await cli(["--json", "screen", "assign", SCREEN, "--playlist-id", PLAYLIST, "--note", "Lobby loop for spring"], transport, env);
    assertPending(assigned, "rvw_ASSIGN");
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], encodeURIComponent("Lobby loop for spring"));
    assert.equal(transport.calls.filter((call) => call.method === "GET" && call.path === `/api/screens/${SCREEN}`).length, 0, "no assignment readback for a proposal");

    const cleared = await cli(["--json", "screen", "schedule", "clear", SCREEN, "--note", "Back to the default"], transport, env);
    assertPending(cleared, "rvw_SCHEDULE");
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], encodeURIComponent("Back to the default"));

    const takeover = await cli(["--json", "screen", "takeover", "set", SCREEN, "--playlist-id", PLAYLIST, "--note", "Fire drill"], transport, env);
    assertPending(takeover, "rvw_TAKEOVER");
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], encodeURIComponent("Fire drill"));

    const ended = await cli(["--json", "screen", "takeover", "clear", SCREEN], transport, env);
    assertPending(ended, "rvw_TAKEOVER_CLEAR");
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("a fleet action that waits for review is one review; a 202 continuation page is still a fleet page", async () => {
  const env = await enrolled();
  try {
    let proposals = true;
    const transport = new FakeTransport()
      .on("POST", "/api/screens/actions", (req) => {
        if (proposals) return pending(summary("rvw_FLEET", "screen_change", { type: "screen", id: SCREEN, name: "tag Lobby" }, 12));
        const after = req.query?.after;
        return after === undefined
          ? json(202, { action: "assign", matched: 1, succeeded: 1, failed: 0, offset: 0, total: 2, next_cursor: "1", results: [{ screen_id: SCREEN, status: "ok" }] })
          : json(200, { action: "assign", matched: 1, succeeded: 1, failed: 0, offset: 1, total: 2, results: [{ screen_id: "scr_BBBBBBBBBBBBBBBBBBBBBBBB", status: "ok" }] });
      });

    const proposed = await cli(["--json", "screen", "assign", "--tag", "Lobby", "--playlist-id", PLAYLIST, "--note", "Spring loop on every lobby"], transport, env);
    assertPending(proposed, "rvw_FLEET");
    assert.equal(proposed.envelope.data.review.impact.screens, 12);
    assert.equal(transport.calls.at(-1)!.headers?.[NOTE_HEADER], encodeURIComponent("Spring loop on every lobby"));
    assert.deepEqual(transport.calls.at(-1)!.body, { selector: { by: "tag", tag: "Lobby" }, action: { type: "assign", playlist_id: PLAYLIST } });

    proposals = false;
    const applied = await cli(["--json", "screen", "assign", "--tag", "Lobby", "--playlist-id", PLAYLIST], transport, env);
    assert.equal(applied.code, ExitCode.Success, applied.stdout);
    assert.equal(applied.envelope.data.status, undefined);
    assert.equal(applied.envelope.data.succeeded, 2);
    assert.equal((applied.envelope.warnings ?? []).some((warning) => warning.code === "pending_review"), false);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("screen publish stops at pending_review with both reviews, reports them on rerun, and verifies once approved", async () => {
  const env = await enrolled();
  try {
    let screen: Record<string, unknown> = { id: SCREEN, revision: 7, online: true };
    const states: Record<string, string> = { rvw_PLAYLIST: "pending", rvw_ASSIGN: "pending" };
    let created = 0;
    const transport = new FakeTransport()
      .on("GET", "/api/project", () => json(200, { id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA" }))
      .on("GET", `/api/screens/${SCREEN}`, () => json(200, screen))
      .on("POST", "/api/playlists", () => {
        created += 1;
        return pending(summary("rvw_PLAYLIST", "playlist_change", { type: "playlist", id: PLAYLIST, name: "Lobby" }, 0),
          { id: PLAYLIST, revision: 1, name: "Lobby", approved_revision: 0, approval: { state: "pending", review_id: "rvw_PLAYLIST" } });
      })
      .on("PATCH", `/api/screens/${SCREEN}`, () => pending(summary("rvw_ASSIGN", "screen_change", { type: "screen", id: SCREEN, name: "Lobby" })))
      .on("GET", /^\/api\/reviews\/rvw_[A-Z]+$/, (req) => {
        const id = req.path.split("/").at(-1)!;
        return json(200, { id, kind: id === "rvw_PLAYLIST" ? "playlist_change" : "screen_change", state: states[id] });
      });

    const first = await cli(["--json", "screen", "publish", SCREEN, "lobby.json", "--note", "Spring menu"], transport, env);
    assert.equal(first.code, ExitCode.Success, first.stdout);
    assert.equal(first.envelope.data.stage, "pending_review");
    assert.equal(first.envelope.data.playlist_id, PLAYLIST);
    assert.equal(first.envelope.data.assignment_verified, false);
    assert.equal(first.envelope.data.playback_verified, false);
    assert.deepEqual(first.envelope.data.reviews.map((review: { id: string }) => review.id), ["rvw_PLAYLIST", "rvw_ASSIGN"]);
    assert.deepEqual(first.envelope.data.next.argv, ["reviews", "show", "rvw_PLAYLIST"]);
    assert.deepEqual(first.envelope.warnings?.map((warning) => warning.code), ["pending_review", "pending_review"]);
    assert.match(first.stderr, /"stage":"pending_review"/);
    for (const call of writes(transport)) assert.equal(call.headers?.[NOTE_HEADER], "Spring%20menu", `${call.method} ${call.path}`);
    const afterAssign = transport.calls.slice(transport.calls.findIndex((call) => call.method === "PATCH") + 1);
    assert.equal(afterAssign.length, 0, "no readback or playback wait for a proposal");

    // While the reviews wait the rerun writes nothing and reports them again.
    const waiting = await cli(["--json", "screen", "publish", SCREEN, "lobby.json", "--note", "Spring menu"], transport, env);
    assert.equal(waiting.envelope.data.stage, "pending_review");
    assert.equal(writes(transport).length, 2);

    // The person approved the playlist and its assignment.
    states.rvw_PLAYLIST = "approved";
    states.rvw_ASSIGN = "approved";
    screen = { id: SCREEN, revision: 8, online: true, playlist_id: PLAYLIST };
    const approved = await cli(["--json", "screen", "publish", SCREEN, "lobby.json", "--no-wait", "--note", "Spring menu"], transport, env);
    assert.equal(approved.code, ExitCode.Success, approved.stdout);
    assert.equal(approved.envelope.data.stage, "assigned");
    assert.equal(approved.envelope.data.assignment_verified, true);
    assert.equal(writes(transport).length, 2);
    assert.equal(created, 1);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("a rejected publish proposal is history: the identical rerun proposes afresh", async () => {
  const env = await enrolled();
  try {
    const states: Record<string, string> = {};
    let created = 0;
    const transport = new FakeTransport()
      .on("GET", "/api/project", () => json(200, { id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA" }))
      .on("GET", `/api/screens/${SCREEN}`, () => json(200, { id: SCREEN, revision: 7 }))
      .on("POST", "/api/playlists", () => {
        created += 1;
        states[`rvw_P${created}`] = "pending";
        return pending(summary(`rvw_P${created}`, "playlist_change", { type: "playlist", id: `${PLAYLIST}${created}`, name: "Lobby" }, 0), { id: `${PLAYLIST}${created}`, revision: 1 });
      })
      .on("PATCH", `/api/screens/${SCREEN}`, () => {
        states[`rvw_S${created}`] = "pending";
        return pending(summary(`rvw_S${created}`, "screen_change", { type: "screen", id: SCREEN, name: "Lobby" }));
      })
      .on("GET", /^\/api\/reviews\//, (req) => json(200, { id: req.path.split("/").at(-1), state: states[req.path.split("/").at(-1)!] }));

    const first = await cli(["--json", "screen", "publish", SCREEN, "lobby.json"], transport, env);
    assert.equal(first.envelope.data.playlist_id, `${PLAYLIST}1`);
    states.rvw_P1 = "rejected";
    const again = await cli(["--json", "screen", "publish", SCREEN, "lobby.json"], transport, env);
    assert.equal(again.code, ExitCode.Success, again.stdout);
    assert.equal(again.envelope.data.stage, "pending_review");
    assert.equal(again.envelope.data.playlist_id, `${PLAYLIST}2`);
    assert.deepEqual(again.envelope.data.reviews.map((review: { id: string }) => review.id), ["rvw_P2", "rvw_S2"]);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("reviews list, show and withdraw", async () => {
  const env = await enrolled();
  try {
    const review = {
      id: "rvw_ONE", kind: "playlist_change", state: "changes_requested", url: "https://screenrig.ai/dashboard/reviews/rvw_ONE",
      subject: { type: "playlist", id: PLAYLIST, name: "Lobby" }, impact: { screens: 2 },
      proposer: { kind: "agent", agent_id: AGENT, agent_name: "Menu agent", person: { user_id: "usr_PERSON", name: "Ada" } },
      note: "Adds the weekend hours", decision_note: "Use the new logo\u001b[31m", decided_at: "2026-08-14T16:00:00Z",
      decided_by: { user_id: "usr_OWNER", name: "Grace" }, created_at: "2026-08-14T15:00:00Z", updated_at: "2026-08-14T16:00:00Z",
      playlist_change: { operation: "update", base_revision: 4, proposed: {}, diff: { name_changed: false, pages_added: ["p3"], pages_removed: [], pages_changed: ["p1", "p2"], soundtrack_changed: false, media_added: [], media_removed: [] } },
    };
    const transport = new FakeTransport()
      .on("GET", "/api/reviews", () => json(200, { items: [review], next_cursor: "c2", pending_count: 3 }))
      .on("GET", "/api/reviews/rvw_ONE", () => json(200, review))
      .on("POST", "/api/reviews/rvw_ONE/withdraw", () => json(200, { review: { ...review, state: "withdrawn" } }));

    const listed = await cli(["--json", "reviews", "list", "--state", "all", "--kind", "playlist_change", "--limit", "10"], transport, env);
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    assert.deepEqual(transport.calls.at(-1)!.query, { state: "all", kind: "playlist_change", limit: "10", cursor: undefined });
    assert.equal(listed.envelope.data.pending_count, 3);
    assert.deepEqual(listed.envelope.data.next.argv, ["reviews", "list", "--state", "all", "--kind", "playlist_change", "--limit", "10", "--cursor", "c2"]);

    const tooMany = await cli(["--json", "reviews", "list", "--limit", "101"], transport, env);
    assert.equal(tooMany.code, ExitCode.Usage);
    const badState = await cli(["--json", "reviews", "list", "--state", "open"], transport, env);
    assert.equal(badState.code, ExitCode.Usage);

    const humanList = await cli(["--human", "reviews", "list"], transport, env);
    assert.match(humanList.stdout, /Reviews \(1; 3 pending\)/);
    assert.match(humanList.stdout, /rvw_ONE {2}playlist_change {2}changes_requested {2}playlist Lobby \(pl_LOBBY\)/);
    assert.match(humanList.stdout, /next: screenrig reviews list --cursor c2/);

    const shown = await cli(["--human", "reviews", "show", "rvw_ONE"], transport, env);
    assert.equal(shown.code, ExitCode.Success, shown.stdout);
    assert.match(shown.stdout, /Review rvw_ONE: Playlist change, changes_requested/);
    assert.match(shown.stdout, /proposed_by: agent Menu agent, for Ada/);
    assert.match(shown.stdout, /decision_note: Use the new logo \[31m/);
    assert.doesNotMatch(shown.stdout, /\u001b/);
    assert.match(shown.stdout, /change: update of revision 4; pages 2 changed, 1 added; soundtrack unchanged/);

    const withdrawn = await cli(["--json", "reviews", "withdraw", "rvw_ONE"], transport, env);
    assert.equal(withdrawn.code, ExitCode.Success, withdrawn.stdout);
    assert.equal(withdrawn.envelope.data.review.state, "withdrawn");
    assert.ok(transport.calls.at(-1)!.headers?.["idempotency-key"]);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("ads reviews request-changes posts the note, and creative show prints each review with its reason", async () => {
  const env = await enrolled();
  try {
    const transport = new FakeTransport()
      .on("POST", "/api/advertising/reviews/arv_ONE/request-changes", () => privateJson(200, { id: "arv_ONE", state: "changes_requested", reason: "Bigger logo" }))
      .on("GET", "/api/advertising/creatives/crv_ONE", () => privateJson(200, {
        id: "crv_ONE", revision: 2, reviews: [
          { id: "arv_ONE", seller_project_id: "prj_SELLER", creative_revision: 1, state: "changes_requested", reason: "Bigger logo", created_at: "2026-08-14T15:00:00Z" },
          { id: "arv_TWO", seller_project_id: "prj_OTHER", creative_revision: 2, campaign_id: "cmp_ONE", state: "approved", created_at: "2026-08-14T16:00:00Z" },
        ],
      }));

    const missing = await cli(["--json", "ads", "reviews", "request-changes", "arv_ONE"], transport, env);
    assert.equal(missing.code, ExitCode.Usage);
    const asked = await cli(["--json", "ads", "reviews", "request-changes", "arv_ONE", "--note", "Bigger logo"], transport, env);
    assert.equal(asked.code, ExitCode.Success, asked.stdout);
    assert.deepEqual(transport.calls.at(-1)!.body, { note: "Bigger logo" });
    assert.equal(asked.envelope.data.state, "changes_requested");

    const shown = await cli(["--human", "ads", "creatives", "show", "crv_ONE"], transport, env);
    assert.equal(shown.code, ExitCode.Success, shown.stdout);
    assert.match(shown.stdout, /review arv_ONE changes_requested seller prj_SELLER revision 1: Bigger logo/);
    assert.match(shown.stdout, /review arv_TWO approved seller prj_OTHER revision 2 campaign cmp_ONE/);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("agent status reports access, effective_access and access_limited_by", async () => {
  const env = await enrolled();
  try {
    const self = (extra: Record<string, unknown>) => ({
      agent: { id: AGENT, name: "Menu agent", agent_type: "cli", capabilities: ["screens"], state: "active", authenticated_requests: 0, metered_credits: 0, created_at: NOW.toISOString() },
      connection_ready: true, ...extra,
    });
    let body = self({ access: "manage", effective_access: "propose", access_limited_by: "project" });
    const transport = new FakeTransport().on("GET", "/api/agents/self", () => privateJson(200, body));

    const limited = await cli(["--json", "agent", "status"], transport, env);
    assert.equal(limited.code, ExitCode.Success, limited.stdout);
    assert.equal(limited.envelope.data.access, "manage");
    assert.equal(limited.envelope.data.effective_access, "propose");
    assert.equal(limited.envelope.data.access_limited_by, "project");
    const human = await cli(["--human", "agent", "status"], transport, env);
    assert.match(human.stdout, /access: Manage/);
    assert.match(human.stdout, /effective_access: Propose \(the project requires review for agent changes\)/);

    body = self({ access: "propose", effective_access: "propose" });
    const plain = await cli(["--json", "agent", "status"], transport, env);
    assert.equal(plain.envelope.data.access, "propose");
    assert.equal(plain.envelope.data.effective_access, "propose");
    assert.equal(plain.envelope.data.access_limited_by, undefined);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("insufficient_access names Manage, or the project or person cap from errors[0].access_limited_by", async () => {
  const env = await enrolled();
  try {
    let limitedBy: string | undefined;
    const transport = new FakeTransport()
      .on("DELETE", `/api/playlists/${PLAYLIST}`, () => ({
        status: 403, headers: { "content-type": "application/problem+json" },
        body: {
          errors: [{
            status: 403, code: "insufficient_access", type: "https://screenrig.ai/problems/insufficient-access", title: "This access level cannot do this",
            detail: limitedBy ? "This credential acts with Propose access here." : "This credential has Propose access.",
            hint: "Read only access changes nothing; Propose access uploads media, writes notes and proposes playlist and screen changes for review, but cannot delete, control screens or spend credit. Ask a person to approve Manage access (screenrig login --access manage), or leave the change to a credential that has it.",
            ...(limitedBy ? { access_limited_by: limitedBy } : {}),
          }],
          instance: `/api/playlists/${PLAYLIST}`, request_id: "req_REFUSED",
        },
      }));

    const own = await cli(["--json", "playlist", "delete", PLAYLIST], transport, env);
    assert.equal(own.code, ExitCode.Auth, own.stdout);
    assert.equal(own.envelope.error?.code, "insufficient_access");
    assert.match(own.envelope.error?.hint ?? "", /Propose access/);
    assert.deepEqual(own.envelope.error?.next?.argv, ["login", "--access", "manage"]);

    limitedBy = "project";
    const project = await cli(["--json", "playlist", "delete", PLAYLIST], transport, env);
    assert.equal(project.code, ExitCode.Auth);
    assert.equal((project.envelope.error as { access_limited_by?: string } | undefined)?.access_limited_by, "project");
    assert.match(project.envelope.error?.hint ?? "", /requires review for agent changes/);
    assert.equal(project.envelope.error?.next, undefined, "a new sign-in does not lift a project cap");

    limitedBy = "person";
    const person = await cli(["--human", "playlist", "delete", PLAYLIST], transport, env);
    assert.equal(person.code, ExitCode.Auth);
    assert.match(person.stdout + person.stderr, /Can approve/);
    assert.match(person.stdout + person.stderr, /access_limited_by: person/);
    assert.doesNotMatch(person.stdout + person.stderr, /next: screenrig login/);

    assert.equal(transport.calls.filter((call) => call.path === "/api/agents/self").length, 0, "the refusal explains itself without a self read");
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("reviews show renders a media review, blockers with their state, and a fleet still applying", async () => {
  const env = await enrolled();
  try {
    const base = { url: "https://screenrig.ai/dashboard/reviews/x", proposer: { kind: "agent", agent_id: AGENT, agent_name: "Menu agent" }, created_at: "2026-08-14T15:00:00Z", updated_at: "2026-08-14T15:00:00Z" };
    const diff = { name_changed: false, pages_added: [], pages_removed: [], pages_changed: [], soundtrack_changed: false, media_added: ["med_POSTER"], media_removed: [] };
    const media = {
      ...base, id: "rvw_MEDIA", kind: "playlist_change", state: "pending", subject: { type: "media", id: "med_POSTER", name: "poster.png" }, impact: { screens: 4 },
      playlist_change: {
        operation: "selector_refresh", base_revision: 7, proposed: { name: "Lobby", pages: [] }, diff,
        media_playlists: [{ id: "pl_LOBBY", name: "Lobby", screens: 3 }, { id: "pl_MENU", name: "Menu", screens: 1 }],
      },
    };
    const upload = {
      ...media, id: "rvw_UPLOAD",
      playlist_change: {
        ...media.playlist_change,
        media_change: { media_id: "med_POSTER", filename: "poster.png", before: null, after: { tags: ["lobby"], folder_id: "fld_A" } },
        media_playlists: [{ id: "pl_LOBBY", name: "Lobby", screens: 3, media_added: ["med_POSTER"], media_removed: [] }],
      },
    };
    const retag = {
      ...base, id: "rvw_RETAG", kind: "playlist_change", state: "pending", subject: { type: "media", id: "med_B", name: "menu.png" }, impact: { screens: 1 },
      playlist_change: {
        operation: "selector_refresh", base_revision: 0, proposed: {}, diff: { ...diff, media_added: ["med_B"], media_removed: ["med_B"] },
        media_change: { media_id: "med_B", filename: "menu.png", before: { tags: ["lobby"], folder_id: "" }, after: { tags: ["cafe"], folder_id: "" } },
        media_playlists: [
          { id: "pl_CAFE", name: "Cafe tags", screens: 0, media_added: ["med_B"], media_removed: [] },
          { id: "pl_LOBBY", name: "Lobby tags", screens: 1, media_added: [], media_removed: ["med_B"] },
        ],
      },
    };
    const move = {
      ...retag, id: "rvw_MOVE",
      playlist_change: { ...retag.playlist_change, media_change: { media_id: "med_B", filename: "menu.png", before: { tags: ["lobby"], folder_id: "fld_A" }, after: { tags: ["lobby"], folder_id: "" } } },
    };
    const screen = {
      ...base, id: "rvw_SCREEN", kind: "screen_change", state: "approved", subject: { type: "screen", id: SCREEN, name: "tag Lobby" }, impact: { screens: 40 },
      blocked_by: ["rvw_PLAYLIST"], blockers: [{ id: "rvw_PLAYLIST", state: "rejected", subject: { type: "playlist", id: PLAYLIST, name: "Lobby" } }],
      screen_change: { action: "assign", screens: { tag: "Lobby", count_at_request: 40 }, request: {}, playlist_ids: [PLAYLIST], result: { matched: 40, succeeded: 12, failed: 0, applying: true } },
    };
    const transport = new FakeTransport()
      .on("GET", "/api/reviews/rvw_MEDIA", () => json(200, media))
      .on("GET", "/api/reviews/rvw_UPLOAD", () => json(200, upload))
      .on("GET", "/api/reviews/rvw_RETAG", () => json(200, retag))
      .on("GET", "/api/reviews/rvw_MOVE", () => json(200, move))
      .on("GET", "/api/reviews/rvw_SCREEN", () => json(200, screen))
      .on("GET", "/api/reviews", () => json(200, { items: [media, retag], next_cursor: null, pending_count: 2 }));

    const shownMedia = await cli(["--human", "reviews", "show", "rvw_MEDIA"], transport, env);
    assert.equal(shownMedia.code, ExitCode.Success, shownMedia.stdout);
    assert.match(shownMedia.stdout, /Review rvw_MEDIA: New media, pending/);
    assert.match(shownMedia.stdout, /subject: media poster\.png \(med_POSTER\)/);
    assert.match(shownMedia.stdout, /\nmedia_playlists:\n {2}Lobby \(pl_LOBBY, 3 screens\)\n {2}Menu \(pl_MENU, 1 screen\)\n/);
    assert.match(shownMedia.stdout, /change: new media for the tag, folder or all selectors of approved playlists/);
    assert.match(shownMedia.stdout, /impact: approving changes 4 screens/);
    assert.doesNotMatch(shownMedia.stdout, /media_change:/);
    const json1 = await cli(["--json", "reviews", "show", "rvw_MEDIA"], transport, env);
    assert.equal(json1.envelope.data.preview, undefined);
    assert.equal(json1.envelope.data.playlist_change.media_playlists.length, 2);

    const shownUpload = await cli(["--human", "reviews", "show", "rvw_UPLOAD"], transport, env);
    assert.match(shownUpload.stdout, /Review rvw_UPLOAD: New media, pending/);
    assert.match(shownUpload.stdout, /media_change: new upload; tags lobby; folder fld_A/);
    assert.match(shownUpload.stdout, /\n {2}Lobby \(pl_LOBBY, 3 screens\): starts playing med_POSTER\n/);

    const shownRetag = await cli(["--human", "reviews", "show", "rvw_RETAG"], transport, env);
    assert.match(shownRetag.stdout, /Review rvw_RETAG: Media change, pending/);
    assert.match(shownRetag.stdout, /change: changed tags or folder of approved media for the tag, folder or all selectors of approved playlists; pages unchanged; soundtrack unchanged; media 1 added, 1 removed/);
    assert.match(shownRetag.stdout, /media_change: tags lobby → cafe; library root unchanged/);
    assert.match(shownRetag.stdout, /\nmedia_playlists:\n {2}Cafe tags \(pl_CAFE, 0 screens\): starts playing med_B\n {2}Lobby tags \(pl_LOBBY, 1 screen\): stops playing med_B\n/);
    assert.match(shownRetag.stdout, /impact: approving changes 1 screen/);
    const json2 = await cli(["--json", "reviews", "show", "rvw_RETAG"], transport, env);
    assert.deepEqual(json2.envelope.data.playlist_change.media_change.before, { tags: ["lobby"], folder_id: "" });
    assert.deepEqual(json2.envelope.data.playlist_change.media_playlists[1].media_removed, ["med_B"]);

    const shownMove = await cli(["--human", "reviews", "show", "rvw_MOVE"], transport, env);
    assert.match(shownMove.stdout, /media_change: tags lobby unchanged; folder fld_A → library root/);

    const listed = await cli(["--human", "reviews", "list"], transport, env);
    assert.match(listed.stdout, /rvw_MEDIA {2}playlist_change {2}pending {2}media poster\.png \(med_POSTER\) {2}2026-08-14T15:00:00Z\n/);
    assert.match(listed.stdout, /rvw_RETAG {2}playlist_change {2}pending {2}media menu\.png \(med_B\) {2}2026-08-14T15:00:00Z {2}tags lobby → cafe; library root unchanged/);

    const shownScreen = await cli(["--human", "reviews", "show", "rvw_SCREEN"], transport, env);
    assert.match(shownScreen.stdout, /blockers: rvw_PLAYLIST rejected \(playlist Lobby \(pl_LOBBY\)\)/);
    assert.doesNotMatch(shownScreen.stdout, /blocked_by:/);
    assert.match(shownScreen.stdout, /result: 40 matched, 12 succeeded, 0 failed; still applying to the rest/);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("a Propose tag change of media waits for review: pending media with warning media_review_pending and next reviews list", async () => {
  const env = await enrolled();
  try {
    const mediaRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, filename: "poster.png", primitive: "image", content_type: "image/png", tags: ["Lobby"], revision: 3, state: "ready", ...extra });
    const transport = new FakeTransport()
      .on("PATCH", "/api/media/med_POSTER", () => json(200, mediaRow("med_POSTER", { review_state: "pending" })))
      .on("PATCH", "/api/media/med_LIVE", () => json(200, mediaRow("med_LIVE")))
      .on("PATCH", "/api/media/med_READ", () => ({
        status: 403, headers: { "content-type": "application/problem+json" },
        body: { errors: [{ status: 403, code: "insufficient_access", type: "https://screenrig.ai/problems/insufficient-access", title: "This access level cannot do this", detail: "This credential has Read only access." }], request_id: "req_READ" },
      }));

    const waiting = await cli(["--json", "media", "update", "med_POSTER", "--tag", "Lobby"], transport, env);
    assert.equal(waiting.code, ExitCode.Success, waiting.stdout);
    assert.equal(waiting.envelope.ok, true);
    assert.equal(waiting.envelope.data.review_state, "pending");
    assert.deepEqual(waiting.envelope.data.next.argv, ["reviews", "list"]);
    assert.equal(waiting.envelope.warnings?.length, 1);
    assert.equal(waiting.envelope.warnings?.[0]?.code, "media_review_pending");
    assert.match(waiting.envelope.warnings?.[0]?.message ?? "", /Waiting for a person to approve this media change/);
    const waitingHuman = await cli(["--human", "media", "update", "med_POSTER", "--tags", "Lobby,Patio"], transport, env);
    assert.match(waitingHuman.stdout, /Replaced tags on media med_POSTER\nreview_state: pending\n/);
    assert.match(waitingHuman.stdout, /Screens keep playing what was approved until a person approves this change\./);
    assert.match(waitingHuman.stdout, /next: screenrig reviews list/);

    const live = await cli(["--json", "media", "update", "med_LIVE", "--clear-tag"], transport, env);
    assert.equal(live.code, ExitCode.Success, live.stdout);
    assert.deepEqual(live.envelope.warnings, []);
    assert.equal(live.envelope.data.next, undefined);
    const liveHuman = await cli(["--human", "media", "update", "med_LIVE", "--clear-tag"], transport, env);
    assert.match(liveHuman.stdout, /\nCleared tags on media med_LIVE\n?$/);
    assert.doesNotMatch(liveHuman.stdout, /review_state|next:/);


    const readOnly = await cli(["--json", "media", "update", "med_READ", "--tag", "Lobby"], transport, env);
    assert.equal(readOnly.code, ExitCode.Auth, readOnly.stdout);
    assert.deepEqual(readOnly.envelope.error?.next?.argv, ["login", "--access", "manage"], "a refusal is about the access level again");
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});

test("previously_rejected_media renders when present and stays quiet when absent", async () => {
  const env = await enrolled();
  try {
    const base = { url: "https://screenrig.ai/dashboard/reviews/x", proposer: { kind: "agent", agent_id: AGENT, agent_name: "Menu agent" }, created_at: "2026-08-14T15:00:00Z", updated_at: "2026-08-14T15:00:00Z", impact: { screens: 1 },
      kind: "playlist_change", state: "pending", subject: { type: "playlist", id: PLAYLIST, name: "Lobby" } };
    const diff = { name_changed: false, pages_added: [], pages_removed: [], pages_changed: ["p1"], soundtrack_changed: false, media_added: ["med_A", "med_B"], media_removed: [] };
    const change = { operation: "update", base_revision: 4, proposed: { name: "Lobby", pages: [] }, diff };
    const transport = new FakeTransport()
      .on("GET", "/api/reviews/rvw_TWO", () => json(200, { ...base, id: "rvw_TWO", playlist_change: { ...change, previously_rejected_media: ["med_A", "med_B"] } }))
      .on("GET", "/api/reviews/rvw_ONE", () => json(200, { ...base, id: "rvw_ONE", playlist_change: { ...change, previously_rejected_media: ["med_A"] } }))
      .on("GET", "/api/reviews/rvw_EMPTY", () => json(200, { ...base, id: "rvw_EMPTY", playlist_change: { ...change, previously_rejected_media: [] } }))
      .on("GET", "/api/reviews/rvw_PLAIN", () => json(200, { ...base, id: "rvw_PLAIN", playlist_change: change }));

    assert.match((await cli(["--human", "reviews", "show", "rvw_TWO"], transport, env)).stdout, /previously_rejected_media: med_A, med_B were rejected before/);
    assert.match((await cli(["--human", "reviews", "show", "rvw_ONE"], transport, env)).stdout, /previously_rejected_media: med_A was rejected before/);
    assert.doesNotMatch((await cli(["--human", "reviews", "show", "rvw_EMPTY"], transport, env)).stdout, /previously_rejected/);
    assert.doesNotMatch((await cli(["--human", "reviews", "show", "rvw_PLAIN"], transport, env)).stdout, /previously_rejected/);
    const shown = await cli(["reviews", "show", "rvw_TWO"], transport, env);
    assert.deepEqual(shown.envelope.data.playlist_change.previously_rejected_media, ["med_A", "med_B"]);
  } finally {
    await rm(env.dir, { recursive: true, force: true });
  }
});
