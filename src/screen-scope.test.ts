import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help-tree.js";
import { readConfigFile, writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { normalizeProblem, renderProblem, withDefaultHint, withScreenScopeGuidance } from "./problems.js";
import { protectedChangeLines, reviewDetailLines, reviewListLines } from "./reviews.js";
import { campaignLines, campaignTableLines } from "./campaigns.js";
import { folderLines, folderListLines, screenScopeFromArgs } from "./screen-folders.js";
import type { Campaign, Review, ScreenFolder } from "./adapters/protocol.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportResponse } from "./transport/types.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const NORTH = "sfd_NORTHAAAAAAAAAAAAAAAAAA";
const SOUTH = "sfd_SOUTHAAAAAAAAAAAAAAAAAA";
const A = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const CAMPAIGN = "cmp_SPRINGAAAAAAAAAAAA";
const REVIEW = "rvw_PROTECTEDAAAAAAAAAAAA";
const AGENT = "agt_AAAAAAAAAAAAAAAAAAAAAAAA";
const when = "2026-10-29T17:00:00Z";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; hint?: string; screen_scope?: unknown; next?: { command: string; reason: string } };
  warnings?: Array<{ code: string; message: string }>;
}

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

function realFs(home: string): ConfigFs {
  return { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: { XDG_CONFIG_HOME: home } };
}

async function cli(argv: string[], transport: FakeTransport, configDir: string): Promise<{ code: number; stdout: string; envelope: Envelope }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike = realFs(configDir);
  const runtime: CliRuntime = {
    argv, env: fsLike.env, stdout, stderr,
    now: () => new Date("2026-10-29T17:00:00.000Z"), sleep: async () => undefined,
    homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport, signedRawPut: async () => ({ status: 200 }),
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  await errP;
  const text = await outP;
  let envelope: Envelope = { ok: false };
  try { envelope = JSON.parse(text) as Envelope; } catch { /* human output */ }
  return { code, stdout: text, envelope };
}

async function enrolled(prefix: string): Promise<string> {
  const configDir = await testTemp(prefix);
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" },
    realFs(configDir),
  );
  return configDir;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): TransportResponse => ({ status, headers: { "content-type": "application/json", etag: '"1"', ...headers }, body });
const problem = (status: number, code: string, detail: string, extra: Record<string, unknown> = {}): TransportResponse => ({
  status, headers: { "content-type": "application/problem+json" },
  body: { errors: [{ status, code, type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, detail, ...extra }], request_id: "req_scope" },
});
const folder = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, parent_id: null, revision: 1, created_at: when, updated_at: when, ...extra });
const pending = (kind: string, subject: Record<string, unknown>) => json(202, {
  status: "pending_review",
  review: { id: REVIEW, kind, state: "pending", url: `https://screenrig.ai/dashboard/reviews/${REVIEW}`, subject, impact: { screens: 3 } },
});
const campaign = (extra: Record<string, unknown> = {}) => ({
  id: CAMPAIGN, name: "Spring menu", playlist_id: PLAYLIST, audience: { folder: NORTH }, priority: 0, paused: false, reserved: false, revision: 1, created_at: when, updated_at: when, ...extra,
});

test("agent status reports the agent's own scope and its person's", async () => {
  const configDir = await enrolled("scope-status-");
  const self = {
    connection_ready: true, access: "manage", effective_access: "manage",
    agent: { id: AGENT, name: "Floor manager", agent_type: "codex", state: "active", capabilities: ["screens"], authenticated_requests: 1, metered_credits: 0, created_at: when },
    screen_scope: { folder_ids: [NORTH], screen_ids: [A] },
    person_screen_scope: { folder_ids: [NORTH, SOUTH], screen_ids: [] },
  };
  const transport = new FakeTransport().on("GET", "/api/agents/self", () => json(200, self, { "cache-control": "private, no-store" }));
  try {
    const result = await cli(["--json", "agent", "status"], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.deepEqual(result.envelope.data.screen_scope, { folder_ids: [NORTH], screen_ids: [A] });
    assert.deepEqual(result.envelope.data.person_screen_scope, { folder_ids: [NORTH, SOUTH], screen_ids: [] });
    const human = await cli(["--human", "agent", "status"], transport, configDir);
    assert.match(human.stdout, new RegExp(`^screen_scope: folders ${NORTH}; screens ${A}$`, "m"));
    assert.match(human.stdout, new RegExp(`^person_screen_scope: folders ${NORTH}, ${SOUTH}; screens none$`, "m"));
    const whole = new FakeTransport().on("GET", "/api/agents/self", () => json(200, { ...self, screen_scope: undefined, person_screen_scope: undefined }, { "cache-control": "private, no-store" }));
    const unscoped = await cli(["--json", "agent", "status"], whole, configDir);
    assert.equal("screen_scope" in unscoped.envelope.data, false);
    assert.equal("person_screen_scope" in unscoped.envelope.data, false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("outside_screen_scope names the scope and the way back; the other new refusals carry their hints", async () => {
  const configDir = await enrolled("scope-refusal-");
  const scope = { folder_ids: [NORTH], screen_ids: [] };
  const transport = new FakeTransport().on("GET", "/api/screens", () => problem(403, "outside_screen_scope", "Screen scr_X is outside this caller's screens.", { hint: "Ask the project owner to widen the scope.", screen_scope: scope }));
  try {
    const refused = await cli(["--json", "screen", "list"], transport, configDir);
    assert.equal(refused.code, ExitCode.Auth);
    assert.equal(refused.envelope.error?.code, "outside_screen_scope");
    assert.deepEqual(refused.envelope.error?.screen_scope, scope);
    assert.equal(refused.envelope.error?.hint, "Ask the project owner to widen the scope.");
    assert.equal(refused.envelope.error?.next?.command, "screenrig agent status");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
  // A server next action wins over the local one; a review route's refusal carries no screen_scope.
  const own = normalizeProblem({ status: 403, code: "outside_screen_scope", next: { command: "screenrig screen list", reason: "List your screens." } });
  assert.equal(withScreenScopeGuidance(own).next?.command, "screenrig screen list");
  assert.equal(normalizeProblem({ status: 403, code: "outside_screen_scope", screen_scope: { folder_ids: "x" } }).screen_scope, undefined);
  assert.equal(withScreenScopeGuidance(normalizeProblem({ status: 409, code: "protected_target" })).next, undefined);
  // The CLI's own hints name the way back for a server that sends none.
  for (const code of ["outside_screen_scope", "protected_target", "second_approver_required", "reserved_item"]) {
    const hint = withDefaultHint(normalizeProblem({ status: 403, code })).hint ?? "";
    assert.match(hint, /Ask |Propose |owner|approver/, code);
    assert.notEqual(hint, withDefaultHint(normalizeProblem({ status: 403, code: "no_such_code" })).hint, code);
  }
  assert.match(withDefaultHint(normalizeProblem({ status: 409, code: "protected_target" })).hint ?? "", /screen folder update ID --unprotect/);
  assert.match(renderProblem(withScreenScopeGuidance(normalizeProblem({ status: 403, code: "outside_screen_scope", title: "Outside", detail: "d", screen_scope: { folder_ids: [], screen_ids: [A] } }))), new RegExp(`screen_scope: folders none; screens ${A}`));
});

test("screen pair and provision send folder_id, and refuse a malformed folder before any request", async () => {
  const configDir = await enrolled("scope-pair-");
  const screen = { id: A, label: "Lobby", public_id: "pub", state: "pairing_pending", revision: 1, manifest_revision: 1, content_access_generation: 1, online: false, created_at: when, updated_at: when, folder_id: NORTH };
  const transport = new FakeTransport()
    .on("POST", "/api/screens/pair", () => json(201, { public_url: "https://play.screenrig.ai/s/pub", screen }, { "cache-control": "private, no-store" }))
    .on("POST", "/api/screens/provision", () => json(201, {
      screen, public_url: "https://play.screenrig.ai/s/pub", provisioning_url: `https://play.screenrig.ai/s/pub#provision=${"P".repeat(43)}`, expires_at: "2026-10-29T17:10:00.000Z",
    }, { "cache-control": "private, no-store" }));
  try {
    const paired = await cli(["--human", "screen", "pair", "abc234", "--folder", NORTH, "--name", "Lobby"], transport, configDir);
    assert.equal(paired.code, ExitCode.Success, paired.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { code: "ABC234", label: "Lobby", folder_id: NORTH });
    assert.match(paired.stdout, new RegExp(`^folder_id: ${NORTH}$`, "m"));
    const root = await cli(["--json", "screen", "pair", "abc234"], transport, configDir);
    assert.equal(root.code, ExitCode.Success, root.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { code: "ABC234" });

    const provisioned = await cli(["--json", "screen", "provision", "--print-url", "--folder", NORTH], transport, configDir);
    assert.equal(provisioned.code, ExitCode.Success, provisioned.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { folder_id: NORTH });
    assert.equal(provisioned.envelope.data.folder_id, NORTH);
    // The retry state is cleared once the handoff is shown, so another folder starts a new request.
    const stored = await readConfigFile(path.join(configDir, "screenrig", "config.json"), realFs(configDir));
    assert.equal(stored?.screen_provision, undefined);

    const before = transport.calls.length;
    for (const argv of [["screen", "pair", "abc234", "--folder", "North"], ["screen", "provision", "--print-url", "--folder", A]]) {
      const result = await cli(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, before);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("a provisioning retry is bound to its folder as well as its name", async () => {
  const configDir = await enrolled("scope-provision-retry-");
  const transport = new FakeTransport().on("POST", "/api/screens/provision", () => problem(503, "dependency_unavailable", "Try again."));
  try {
    const first = await cli(["--json", "screen", "provision", "--print-url", "--folder", NORTH, "--idempotency-key", "provision-key-north"], transport, configDir);
    assert.notEqual(first.code, ExitCode.Success);
    const stored = await readConfigFile(path.join(configDir, "screenrig", "config.json"), realFs(configDir));
    assert.deepEqual(stored?.screen_provision, { idempotency_key: "provision-key-north", folder_id: NORTH });
    const calls = transport.calls.length;
    const other = await cli(["--json", "screen", "provision", "--print-url", "--folder", SOUTH], transport, configDir);
    assert.equal(other.code, ExitCode.Usage, other.stdout);
    assert.match(other.envelope.error?.detail ?? "", /same --name and --folder/);
    assert.equal(transport.calls.length, calls);
    const again = await cli(["--json", "screen", "provision", "--print-url", "--folder", NORTH], transport, configDir);
    assert.notEqual(again.code, ExitCode.Usage, again.stdout);
    assert.equal(transport.calls.at(-1)?.headers?.["idempotency-key"], "provision-key-north");
    assert.deepEqual(transport.calls.at(-1)?.body, { folder_id: NORTH });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen folder update --protect and --unprotect send protected alone", async () => {
  const configDir = await enrolled("scope-protect-");
  const transport = new FakeTransport().on("PATCH", `/api/screen-folders/${NORTH}`, (req) => {
    const body = req.body as { protected?: boolean };
    return body.protected === false ? pending("protected_change", { type: "screen_folder", id: NORTH, name: "North" }) : json(200, folder(NORTH, "North", { protected: true }));
  });
  try {
    const protect = await cli(["--human", "screen", "folder", "update", NORTH, "--protect"], transport, configDir);
    assert.equal(protect.code, ExitCode.Success, protect.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { protected: true });
    assert.match(protect.stdout, new RegExp(`^Protected screen folder ${NORTH} and every folder inside it\\.$`, "m"));
    assert.match(protect.stdout, /^protected: true/m);

    const unprotect = await cli(["--json", "screen", "folder", "update", NORTH, "--unprotect", "--note", "Menu boards move", "--expect-rev", "1"], transport, configDir);
    assert.equal(unprotect.code, ExitCode.Success, unprotect.stdout);
    const call = transport.calls.at(-1)!;
    assert.deepEqual(call.body, { protected: false });
    assert.equal(call.headers?.["screenrig-review-note"], "Menu%20boards%20move");
    assert.equal(call.headers?.["if-match"], '"1"');
    assert.equal(unprotect.envelope.data.status, "pending_review");
    assert.equal(unprotect.envelope.data.review.kind, "protected_change");
    assert.equal(unprotect.envelope.data.next.command, `screenrig reviews show ${REVIEW}`);
    assert.equal(unprotect.envelope.warnings?.[0]?.code, "pending_review");
    const human = await cli(["--human", "screen", "folder", "update", NORTH, "--unprotect"], transport, configDir);
    assert.match(human.stdout, /^Protected change waiting for review$/m);
    assert.match(human.stdout, new RegExp(`^next: screenrig reviews show ${REVIEW}$`, "m"));
    assert.match(human.stdout, /approver other than the person who proposed it/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("protection flags stand alone and conflict with each other", async () => {
  const configDir = await enrolled("scope-protect-usage-");
  const transport = new FakeTransport();
  try {
    for (const flags of [["--protect", "--unprotect"], ["--protect", "--name", "x"], ["--unprotect", "--parent", SOUTH], ["--protect", "--root"], ["--unprotect", "--clear-default"]]) {
      const result = await cli(["--json", "screen", "folder", "update", NORTH, ...flags], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${flags.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
    const update = commandHelp(["screen", "folder", "update"]);
    assert.ok(update.options.some((option) => option.name === "--protect"));
    assert.ok(update.options.some((option) => option.name === "--unprotect"));
    assert.ok(update.options.some((option) => option.name === "--note"));
    assert.ok(update.examples.some((example) => example.includes("--unprotect")));
    assert.match(update.usage, /approver_required/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("folder create, rename-free changes, delete and move answer a protected review like any review-class write", async () => {
  const configDir = await enrolled("scope-folder-review-");
  const transport = new FakeTransport()
    .on("POST", "/api/screen-folders", () => pending("protected_change", { type: "screen_folder", id: "", name: "Cafes" }))
    .on("PATCH", `/api/screen-folders/${NORTH}`, () => pending("protected_change", { type: "screen_folder", id: NORTH, name: "North" }))
    .on("DELETE", `/api/screen-folders/${NORTH}`, () => pending("protected_change", { type: "screen_folder", id: NORTH, name: "North" }))
    .on("POST", "/api/screens/move", () => pending("protected_change", { type: "screen", id: "", name: "screens moved" }));
  try {
    const argvs = [
      ["screen", "folder", "create", "--name", "Cafes", "--parent", NORTH, "--note", "New wing"],
      ["screen", "folder", "update", NORTH, "--parent", SOUTH],
      ["screen", "folder", "delete", NORTH],
      ["screen", "move", A, "--folder", SOUTH, "--note", "Refit"],
    ];
    for (const argv of argvs) {
      const result = await cli(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Success, `${argv.join(" ")}: ${result.stdout}`);
      assert.equal(result.envelope.data.status, "pending_review", argv.join(" "));
      assert.equal(result.envelope.data.review.id, REVIEW);
    }
    assert.equal(transport.calls[0]?.headers?.["screenrig-review-note"], "New%20wing");
    assert.equal(transport.calls[3]?.headers?.["screenrig-review-note"], "Refit");
    assert.equal(transport.calls[2]?.headers?.["screenrig-review-note"], undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("campaign create, update, pause and delete send reserved and the note, and answer a pending review", async () => {
  const configDir = await enrolled("scope-campaign-");
  const transport = new FakeTransport()
    .on("POST", "/api/campaigns", () => json(201, campaign({ reserved: true })))
    .on("PATCH", `/api/campaigns/${CAMPAIGN}`, () => json(200, campaign()))
    .on("DELETE", `/api/campaigns/${CAMPAIGN}`, () => pending("protected_change", { type: "campaign", id: CAMPAIGN, name: "Spring menu" }));
  try {
    const created = await cli(["--json", "campaign", "create", "--name", "Fire exits", "--playlist-id", PLAYLIST, "--folder", NORTH, "--reserved", "--note", "Fire safety"], transport, configDir);
    assert.equal(created.code, ExitCode.Success, created.stdout);
    const create = transport.calls.at(-1)!;
    assert.deepEqual(create.body, { name: "Fire exits", playlist_id: PLAYLIST, audience: { folder: NORTH }, reserved: true });
    assert.equal(create.headers?.["screenrig-review-note"], "Fire%20safety");
    const plain = await cli(["--json", "campaign", "create", "--name", "Plain", "--playlist-id", PLAYLIST, "--folder", NORTH], transport, configDir);
    assert.equal(plain.code, ExitCode.Success, plain.stdout);
    assert.equal("reserved" in (transport.calls.at(-1)?.body as object), false);

    for (const [flags, expected] of [[["--reserved"], { reserved: true }], [["--no-reserved"], { reserved: false }], [["--name", "Renamed", "--no-reserved"], { name: "Renamed", reserved: false }]] as const) {
      const result = await cli(["--json", "campaign", "update", CAMPAIGN, ...flags], transport, configDir);
      assert.equal(result.code, ExitCode.Success, `${flags.join(" ")}: ${result.stdout}`);
      assert.deepEqual(transport.calls.at(-1)?.body, expected);
    }
    const paused = await cli(["--json", "campaign", "pause", CAMPAIGN, "--note", "Holiday over", "--expect-rev", "2"], transport, configDir);
    assert.equal(paused.code, ExitCode.Success, paused.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { paused: true });
    assert.equal(transport.calls.at(-1)?.headers?.["screenrig-review-note"], "Holiday%20over");
    assert.equal(transport.calls.at(-1)?.headers?.["if-match"], '"2"');

    const deleted = await cli(["--human", "campaign", "delete", CAMPAIGN], transport, configDir);
    assert.equal(deleted.code, ExitCode.Success, deleted.stdout);
    assert.match(deleted.stdout, /^Protected change waiting for review$/m);
    assert.match(deleted.stdout, /subject: campaign Spring menu/);

    const bare = await cli(["--json", "campaign", "update", CAMPAIGN], transport, configDir);
    assert.equal(bare.code, ExitCode.Usage);
    assert.match(bare.envelope.error?.detail ?? "", /--reserved or --no-reserved\./);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("campaign update answers a protected change with its review and a reserved refusal with its hint", async () => {
  const configDir = await enrolled("scope-campaign-refused-");
  let answer: TransportResponse = pending("protected_change", { type: "campaign", id: CAMPAIGN, name: "Spring menu" });
  const transport = new FakeTransport().on("PATCH", `/api/campaigns/${CAMPAIGN}`, () => answer);
  try {
    const held = await cli(["--json", "campaign", "update", CAMPAIGN, "--playlist-id", PLAYLIST], transport, configDir);
    assert.equal(held.code, ExitCode.Success, held.stdout);
    assert.equal(held.envelope.data.status, "pending_review");
    answer = problem(403, "reserved_item", "Campaign cmp_SPRING is reserved.");
    const refused = await cli(["--json", "campaign", "update", CAMPAIGN, "--no-reserved"], transport, configDir);
    assert.equal(refused.code, ExitCode.Auth);
    assert.equal(refused.envelope.error?.code, "reserved_item");
    assert.match(refused.envelope.error?.hint ?? "", /approver/);
    answer = problem(403, "outside_screen_scope", "The audience reaches outside.", { screen_scope: { folder_ids: [NORTH], screen_ids: [] } });
    const outside = await cli(["--json", "campaign", "update", CAMPAIGN, "--all-screens"], transport, configDir);
    assert.equal(outside.envelope.error?.code, "outside_screen_scope");
    assert.deepEqual(outside.envelope.error?.screen_scope, { folder_ids: [NORTH], screen_ids: [] });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("campaign list and show print reserved and editable as returned", async () => {
  const configDir = await enrolled("scope-campaign-read-");
  const items = [campaign({ reserved: true, editable: false }), campaign({ id: "cmp_OTHERAAAAAAAAAAAA", name: "Own", editable: true })];
  const transport = new FakeTransport()
    .on("GET", "/api/campaigns", () => json(200, { items }))
    .on("GET", `/api/campaigns/${CAMPAIGN}`, () => json(200, items[0]));
  try {
    const listed = await cli(["--json", "campaign", "list"], transport, configDir);
    assert.equal(listed.envelope.data.items[0].reserved, true);
    assert.equal(listed.envelope.data.items[0].editable, false);
    const human = await cli(["--human", "campaign", "list"], transport, configDir);
    const header = human.stdout.split("\n")[1]!;
    assert.match(header, /PAUSED\s+RESERVED\s+EDITABLE$/);
    assert.match(human.stdout.split("\n")[2]!, /yes\s+no$/);
    assert.match(human.stdout.split("\n")[3]!, /no\s+yes$/);
    const shown = await cli(["--human", "campaign", "show", CAMPAIGN], transport, configDir);
    assert.match(shown.stdout, /^reserved: true/m);
    assert.match(shown.stdout, /^editable: false \(it reaches screens outside this caller's scope/m);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
  // A project with no reserved campaign and a caller of the whole project keep the old columns.
  const plain = campaignTableLines([campaign() as unknown as Campaign]);
  assert.match(plain[0]!, /PAUSED$/);
  assert.equal(campaignLines(campaign() as unknown as Campaign).some((line) => /^(reserved|editable):/.test(line)), false);
});

const protectedReview = (change: Record<string, unknown>, extra: Record<string, unknown> = {}): Review => ({
  id: REVIEW, kind: "protected_change", state: "pending", subject: { type: "campaign", id: CAMPAIGN, name: "Spring menu" },
  proposer: { kind: "agent", agent_id: AGENT, agent_name: "Floor manager", person: { user_id: "usr_A", name: "Ada" } },
  url: `https://screenrig.ai/dashboard/reviews/${REVIEW}`, created_at: when, updated_at: when, impact: { screens: 4 }, protected: true,
  protected_change: change, ...extra,
}) as unknown as Review;

test("reviews list takes protected_change and reviews show reads each protected subkind", async () => {
  const configDir = await enrolled("scope-reviews-");
  const reviews = [
    protectedReview({ subkind: "campaign_create", campaign: { body: { name: "Fire exits", playlist_id: PLAYLIST, audience: { any: [{ folder: NORTH }, { screen_id: A }] }, reserved: true } } }),
  ];
  const transport = new FakeTransport()
    .on("GET", "/api/reviews", () => json(200, { items: reviews, next_cursor: null, pending_count: 1 }))
    .on("GET", `/api/reviews/${REVIEW}`, () => json(200, reviews[0]));
  try {
    const listed = await cli(["--json", "reviews", "list", "--kind", "protected_change"], transport, configDir);
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    assert.equal(transport.calls.at(-1)?.query?.kind, "protected_change");
    const bad = await cli(["--json", "reviews", "list", "--kind", "nope"], transport, configDir);
    assert.equal(bad.code, ExitCode.Usage);
    const shown = await cli(["--human", "reviews", "show", REVIEW], transport, configDir);
    assert.match(shown.stdout, new RegExp(`^Review ${REVIEW}: Protected change, pending$`, "m"));
    assert.match(shown.stdout, /^subject: campaign Spring menu/m);
    assert.match(shown.stdout, /create a campaign/);
    assert.match(shown.stdout, /name: Fire exits/);
    assert.match(shown.stdout, new RegExp(`audience: folder ${NORTH} or screen ${A}`));
    assert.match(shown.stdout, /also sets: reserved/);
    assert.match(shown.stdout, /a second approver decides this/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("protected_change reviews are legible for every subkind", () => {
  assert.deepEqual(protectedChangeLines({ subkind: "campaign_delete", campaign: { id: CAMPAIGN, base_revision: 3 } }), ["delete a campaign", `campaign: ${CAMPAIGN}`]);
  assert.deepEqual(protectedChangeLines({ subkind: "folder_create", folder: { name: "Cafes", parent_id: NORTH } }), ["create a screen folder", "name: Cafes", `inside: folder ${NORTH}`]);
  assert.deepEqual(protectedChangeLines({ subkind: "folder_create", folder: { name: "Top" } }), ["create a screen folder", "name: Top", "inside: the project root"]);
  assert.deepEqual(protectedChangeLines({ subkind: "folder_update", folder: { id: NORTH, move: true, set_default: true } }), ["change a screen folder", `folder: ${NORTH}`, "moves to: the project root", "default playlist: cleared"]);
  assert.deepEqual(protectedChangeLines({ subkind: "folder_update", folder: { id: NORTH, name: "Northern" } }), ["change a screen folder", `folder: ${NORTH}`, "name: Northern"]);
  assert.deepEqual(protectedChangeLines({ subkind: "folder_delete", folder: { id: NORTH } }), ["delete a screen folder", `folder: ${NORTH}`]);
  assert.deepEqual(protectedChangeLines({ subkind: "folder_unprotect", folder: { id: NORTH } }), ["remove a screen folder's protection", `folder: ${NORTH}`]);
  assert.deepEqual(protectedChangeLines({ subkind: "screens_move", move: { folder_id: "", screen_ids: [A], folder_ids: null } }), ["move screens and screen folders", "into: the project root", `screens: ${A}`, "folders: none"]);
  // Server text reaches a terminal only without control characters.
  assert.deepEqual(protectedChangeLines({ subkind: "campaign_create", campaign: { body: { name: "Hi\u001b[31m" } } }), ["create a campaign", "name: Hi [31m"]);
  const stale = protectedReview({ subkind: "folder_delete", folder: { id: NORTH } }, { state: "stale" });
  assert.match(reviewDetailLines(stale)[0]!, /Protected change, stale/);
});

test("a screen change that reached a protected screen is marked in the list and the detail", () => {
  const screenChange = {
    id: REVIEW, kind: "screen_change", state: "pending", subject: { type: "screen", id: A, name: "Lobby" }, proposer: { kind: "agent", agent_id: AGENT, agent_name: "Floor manager" },
    url: "https://screenrig.ai/dashboard/reviews/x", created_at: when, updated_at: when, impact: { screens: 1 }, protected: true,
    screen_change: { action: "assign", screens: { ids: [A], count_at_request: 1 }, playlist_ids: [PLAYLIST] },
  } as unknown as Review;
  assert.match(reviewListLines({ items: [screenChange], next_cursor: null, pending_count: 1 })[1]!, new RegExp(`${REVIEW}  screen_change  pending  protected  `));
  assert.ok(reviewDetailLines(screenChange).some((line) => line.startsWith("protected: a second approver decides this")));
  assert.equal(reviewDetailLines({ ...screenChange, protected: undefined }).some((line) => line.startsWith("protected:")), false);
});

test("invitations create limits a member to screen folders and screens", async () => {
  const configDir = await enrolled("scope-invite-");
  const transport = new FakeTransport().on("POST", "/api/invitations", (req) => {
    const body = req.body as { screen_scope?: unknown; delivery: "email" | "link" };
    return json(201, { invitations: [{ id: "inv_AAAAAAAAAAAAAAAAAAAAAAAA", kind: "project_member", delivery: body.delivery, status: "queued", ...(body.delivery === "link" ? { url: "https://screenrig.ai/invite#token" } : {}), project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", recipient_email: "manager@example.com", created_at: when, expires_at: "2026-11-05T17:00:00Z", screen_scope: body.screen_scope }] }, { "cache-control": "private, no-store" });
  });
  try {
    const result = await cli(["--json", "invitations", "create", "--email", "manager@example.com", "--screen-folder-id", `${NORTH},${SOUTH}`, "--screen-id", A], transport, configDir);
    assert.equal(result.code, ExitCode.Success, result.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { kind: "project_member", delivery: "email", emails: ["manager@example.com"], screen_scope: { folder_ids: [NORTH, SOUTH], screen_ids: [A] } });
    assert.deepEqual(result.envelope.data.invitations[0].screen_scope, { folder_ids: [NORTH, SOUTH], screen_ids: [A] });
    const link = await cli(["--json", "invitations", "create", "--link", "--screen-folder-id", NORTH], transport, configDir);
    assert.notEqual(link.code, ExitCode.Usage, link.stdout);
    assert.deepEqual((transport.calls.at(-1)?.body as { screen_scope: unknown }).screen_scope, { folder_ids: [NORTH], screen_ids: [] });
    const plain = await cli(["--json", "invitations", "create", "--email", "manager@example.com"], transport, configDir);
    assert.equal("screen_scope" in (transport.calls.at(-1)?.body as object), false, plain.stdout);

    const before = transport.calls.length;
    for (const argv of [
      ["--kind", "uploader", "--email", "d@example.com", "--folder-id", "mfd_AAAAAAAAAAAAAAAAAAAAAAAA", "--screen-folder-id", NORTH],
      ["--kind", "ad-buyer", "--email", "b@example.com", "--slot-id", "ads_AAAA", "--screen-folder-id", NORTH],
      ["--email", "m@example.com", "--screen-folder-id", "North"],
      ["--email", "m@example.com", "--screen-id", "scr_nope!"],
      ["--email", "m@example.com", "--screen-folder-id", `${NORTH},${NORTH}`],
      ["--email", "m@example.com", "--slot-id", "ads_AAAA"],
    ]) {
      const refused = await cli(["--json", "invitations", "create", ...argv], transport, configDir);
      assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
    }
    assert.equal(transport.calls.length, before);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screenScopeFromArgs bounds a scope like the contract", () => {
  assert.deepEqual(screenScopeFromArgs([NORTH], []), { folder_ids: [NORTH], screen_ids: [] });
  assert.throws(() => screenScopeFromArgs([], []), /at least one/);
  assert.throws(() => screenScopeFromArgs(Array.from({ length: 1001 }, (_, i) => `sfd_F${i}`), []), /at most 1000 screen folders and 200 single screens/);
  assert.throws(() => screenScopeFromArgs([], Array.from({ length: 201 }, (_, i) => `scr_S${String(i).padStart(23, "A")}`)), /at most 1000 screen folders and 200 single screens/);
});

test("a protected folder is marked in the folder list and show", () => {
  const items = [folder(NORTH, "North", { protected: true, screens: 2 }), folder(SOUTH, "South", { screens: 1 })] as unknown as ScreenFolder[];
  const lines = folderListLines(items);
  assert.match(lines[1]!, /DEFAULT_PLAYLIST\s+PROTECTED$/);
  assert.match(lines[2]!, /yes$/);
  assert.match(folderListLines([items[1]!])[1]!, /DEFAULT_PLAYLIST$/);
  assert.ok(folderLines(items[0]).some((line) => line.startsWith("protected: true")));
  assert.equal(folderLines(items[1]).some((line) => line.startsWith("protected:")), false);
});

test("help states write scope, waiting and recovery for the scope options", () => {
  const status = commandHelp(["agent", "status"]);
  assert.match(status.usage, /screen_scope/);
  assert.match(status.usage, /the CLI has no command for it/);
  for (const words of [["screen", "pair"], ["screen", "provision"]]) {
    const help = commandHelp(words);
    assert.ok(help.options.some((option) => option.name === "--folder"), words.join(" "));
    assert.ok(help.examples.some((example) => example.includes("--folder sfd_")), words.join(" "));
    assert.match(help.usage, /outside_screen_scope/);
  }
  for (const words of [["campaign", "create"], ["campaign", "update"]]) {
    const help = commandHelp(words);
    assert.ok(help.options.some((option) => option.name === "--reserved"), words.join(" "));
    assert.ok(help.options.some((option) => option.name === "--note"), words.join(" "));
    assert.match(help.usage, /reserved_item/);
    assert.match(help.usage, /editable: false/);
  }
  assert.ok(commandHelp(["campaign", "update"]).options.some((option) => option.name === "--no-reserved"));
  assert.ok(commandHelp(["campaign", "update"]).examples.some((example) => example.includes("--no-reserved")));
  const reviews = commandHelp(["reviews", "list"]);
  assert.deepEqual(reviews.options.find((option) => option.name === "--kind")?.choices, ["playlist_change", "screen_change", "ad_creative", "protected_change"]);
  assert.ok(reviews.examples.some((example) => example.includes("--kind protected_change")));
  assert.match(commandHelp(["reviews"]).usage, /second_approver_required/);
  assert.match(commandHelp(["reviews"]).usage, /protected_target/);
  const invite = commandHelp(["invitations", "create"]);
  assert.ok(invite.options.some((option) => option.name === "--screen-folder-id"));
  assert.ok(invite.examples.some((example) => example.includes("--screen-folder-id")));
  assert.match(invite.usage, /dashboard; the CLI has no command for it/);
  for (const words of [["screen", "folder", "create"], ["screen", "folder", "delete"], ["screen", "move"]]) {
    const help = commandHelp(words);
    assert.ok(help.options.some((option) => option.name === "--note"), words.join(" "));
    assert.match(help.usage, /pending_review/, words.join(" "));
  }
});
