import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ApiClient } from "./client.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { CliError } from "./problems.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const NO_STORE = { "cache-control": "private, no-store" };

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

async function invoke(argv: string[], transport: FakeTransport): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = await testTemp("plan-features-");
  try {
    const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: { XDG_CONFIG_HOME: home } };
    await writeConfigAtomic(
      path.join(home, "screenrig", "config.json"),
      { api_url: "https://api.screenrig.ai", token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" },
      fs,
    );
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const outP = collect(stdout);
    const errP = collect(stderr);
    const runtime: CliRuntime = {
      argv, env: fs.env, stdout, stderr, now: () => new Date("2026-10-30T12:00:00.000Z"), sleep: async () => undefined,
      homedir: fs.homedir, cwd: () => home, fs, transport,
    };
    const code = await run(runtime);
    stdout.end();
    stderr.end();
    return { code, stdout: await outP, stderr: await errP };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** The project problem document the API writes: the error is errors[0], extensions beside it. */
function planProblem(error: Record<string, unknown>): unknown {
  return {
    errors: [{
      status: 402, code: "feature_not_in_plan", type: "https://screenrig.ai/problems/feature-not-in-plan",
      title: "This feature is not in the project's plan", detail: "Video walls are part of Premium. This project is on Standard.",
      feature: "video_walls", plan: "standard", required_plan: "premium", ...error,
    }],
    instance: "urn:screenrig:request:req_plan", request_id: "req_plan",
  };
}

const SERVER_HINT = "This feature is part of a higher plan (required_plan names it); credit does not unlock it, so do not retry. Tell the user which plan includes it and continue without it; screenrig project capabilities lists the features this project has.";

const CAPABILITIES = {
  project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA",
  plan_id: "standard",
  features: { advertiser: true, screens: true },
  feature_revision: 3,
  capabilities: ["media", "signage.pairing"],
  media_video_bytes: 500_000_000,
  plan_features: {
    featuresets: ["founding"],
    features: [
      { id: "video_walls", enabled: true, required_plan: "premium" },
      { id: "reports", enabled: true, required_plan: "premium" },
      { id: "sso", enabled: false, required_plan: "enterprise" },
      { id: "audit_log", enabled: false, required_plan: "enterprise" },
    ],
  },
  limits: { screens: 250, members: 25, video_bytes: 1_000_000_000, event_retention_days: 7 },
};

test("feature_not_in_plan reaches the agent with its fields, the plan and the capabilities command", async () => {
  const transport = new FakeTransport().on("GET", "/api/screens", () => ({
    status: 402, headers: { "content-type": "application/problem+json" }, body: planProblem({}),
  }));
  const result = await invoke(["--json", "screen", "list"], transport);
  assert.equal(result.code, ExitCode.Client, result.stdout);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "feature_not_in_plan");
  assert.equal(error.status, 402);
  assert.equal(error.feature, "video_walls");
  assert.equal(error.plan, "standard");
  assert.equal(error.required_plan, "premium");
  assert.equal(error.next.command, "screenrig project capabilities");
  assert.match(error.hint, /Premium/);
  assert.match(error.hint, /[Cc]redit does not unlock it/);
  assert.equal(transport.calls.length, 1, "a refusal that credit cannot lift is not retried");
  assert.doesNotMatch(result.stdout, /stripe|x402|billing balance|top.?up|\$/i);

  const human = await invoke(["--human", "screen", "list"], transport);
  assert.match(human.stderr, /feature_not_in_plan\/402/);
  assert.match(human.stderr, /^required_plan: premium$/m);
  assert.match(human.stderr, /next: screenrig project capabilities/);
});

test("the server's own hint on feature_not_in_plan is kept and the plan is added", async () => {
  const transport = new FakeTransport().on("GET", "/api/screens", () => ({
    status: 402, headers: { "content-type": "application/problem+json" }, body: planProblem({ hint: SERVER_HINT }),
  }));
  const error = JSON.parse((await invoke(["--json", "screen", "list"], transport)).stdout).error;
  assert.equal(error.hint, `${SERVER_HINT} The Premium plan includes it.`);
  assert.equal(error.next.command, "screenrig project capabilities");
});

test("a plan-limit refusal that carries required_plan names the plan; one that does not is untouched", async () => {
  const limit = (status: number, code: string, extra: Record<string, unknown>) => planProblem({ status, code, hint: "At the limit.", feature: undefined, plan: undefined, required_plan: undefined, ...extra });
  const transport = new FakeTransport()
    .on("GET", "/api/screens", () => ({ status: 413, headers: {}, body: limit(413, "quota_exceeded", { required_plan: "premium" }) }))
    .on("GET", "/api/media", () => ({ status: 409, headers: {}, body: limit(409, "member_limit_reached", { required_plan: "enterprise" }) }))
    .on("GET", "/api/playlists", () => ({ status: 409, headers: {}, body: limit(409, "member_limit_reached", {}) }));
  const screens = JSON.parse((await invoke(["--json", "screen", "list"], transport)).stdout).error;
  assert.equal(screens.code, "quota_exceeded");
  assert.equal(screens.required_plan, "premium");
  assert.match(screens.hint, /^At the limit\. The Premium plan raises this limit/);
  const media = JSON.parse((await invoke(["--json", "media", "list"], transport)).stdout).error;
  assert.equal(media.code, "member_limit_reached");
  assert.match(media.hint, /^At the limit\. The Enterprise plan raises this limit/);
  const playlists = JSON.parse((await invoke(["--json", "playlist", "list"], transport)).stdout).error;
  assert.equal(playlists.hint, "At the limit.");
  assert.equal("required_plan" in playlists, false);
});

test("a refused download gets the same plan guidance", async () => {
  const transport = new FakeTransport().onDownload("GET", "/api/audit", () => ({
    status: 402, headers: { "content-type": "application/problem+json" }, problem: planProblem({ feature: "audit_log", required_plan: "enterprise" }),
  }));
  await assert.rejects(new ApiClient({ transport, token: TOKEN }).download({ method: "GET", path: "/api/audit" }), (error: unknown) => {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.problem.feature, "audit_log");
    assert.equal(error.problem.required_plan, "enterprise");
    assert.match(error.problem.hint ?? "", /Enterprise/);
    assert.equal(error.problem.next?.command, "screenrig project capabilities");
    return true;
  });
});

test("project capabilities passes plan_features and limits through untouched in JSON", async () => {
  const transport = new FakeTransport().on("GET", "/api/project/capabilities", () => ({ status: 200, headers: NO_STORE, body: CAPABILITIES }));
  const result = await invoke(["--json", "project", "capabilities"], transport);
  assert.equal(result.code, ExitCode.Success, result.stdout);
  const data = JSON.parse(result.stdout).data;
  assert.deepEqual(data.plan_features, CAPABILITIES.plan_features);
  assert.deepEqual(data.limits, CAPABILITIES.limits);
  assert.equal(data.plan_id, "standard");
});

test("project capabilities shows the featuresets and which plan features are on and off", async () => {
  const transport = new FakeTransport().on("GET", "/api/project/capabilities", () => ({ status: 200, headers: NO_STORE, body: CAPABILITIES }));
  const result = await invoke(["--human", "project", "capabilities"], transport);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.match(result.stdout, /^plan_id: standard$/m);
  assert.match(result.stdout, /^featuresets: founding$/m);
  assert.match(result.stdout, /^plan_features_on: video_walls, reports$/m);
  assert.match(result.stdout, /^plan_features_off: sso \(enterprise\), audit_log \(enterprise\)$/m);
  assert.match(result.stdout, /^limits: screens=250 members=25 video_bytes=1000000000 event_retention_days=7$/m);
});

test("a limit of 0 reads as none, because the plan has no cap on it", async () => {
  const body = { ...CAPABILITIES, limits: { screens: 250, members: 0 } };
  const transport = new FakeTransport().on("GET", "/api/project/capabilities", () => ({ status: 200, headers: NO_STORE, body }));
  const result = await invoke(["--human", "project", "capabilities"], transport);
  assert.match(result.stdout, /^limits: screens=250 members=none$/m);
});

test("project capabilities from a server without plan fields prints what it always did", async () => {
  const { plan_features: _features, limits: _limits, ...older } = CAPABILITIES;
  const transport = new FakeTransport().on("GET", "/api/project/capabilities", () => ({ status: 200, headers: NO_STORE, body: older }));
  const result = await invoke(["--human", "project", "capabilities"], transport);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.doesNotMatch(result.stdout, /featuresets|plan_features|limits/);
  assert.match(result.stdout, /^features: advertiser=true screens=true$/m);
});

test("a malformed plan_features entry never fails project capabilities", async () => {
  const body = { ...CAPABILITIES, plan_features: { featuresets: "founding", features: [null, { id: 7 }, { id: "sso", enabled: false }, { id: "reports", enabled: true, required_plan: "premium" }] }, limits: "none" };
  const transport = new FakeTransport().on("GET", "/api/project/capabilities", () => ({ status: 200, headers: NO_STORE, body }));
  const result = await invoke(["--human", "project", "capabilities"], transport);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.match(result.stdout, /^featuresets: \(none\)$/m);
  assert.match(result.stdout, /^plan_features_on: reports$/m);
  assert.match(result.stdout, /^plan_features_off: sso$/m);
  assert.doesNotMatch(result.stdout, /^limits:/m);
});
