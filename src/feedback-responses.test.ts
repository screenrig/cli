import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

const FIXED = {
  id: "fb_AAAAAAAAAAAAAAAAAAAAAAAA",
  kind: "bug",
  title: "Pairing fails",
  body: "The pair command returns not_found.",
  created_at: "2026-10-16T09:00:00.000Z",
  status: "fixed",
  responses: [
    { id: "fbr_AAAAAAAAAAAAAAAAAAAAAAAA", text: "Reproduced.", status: "planned", created_at: "2026-10-16T10:00:00.000Z" },
    { id: "fbr_BBBBBBBBBBBBBBBBBBBBBBBB", text: "Fixed in the next release.\nThanks for the report.", status: "fixed", fixed_in: "26.10.93", created_at: "2026-10-16T11:00:00.000Z" },
  ],
};
const OPEN = { id: "fb_BBBBBBBBBBBBBBBBBBBBBBBB", kind: "feature", title: "Dark mode", body: "Add a dark theme.", created_at: "2026-10-15T09:00:00.000Z", status: "open" };

async function feedbackList(argv: string[], bugs: unknown[], features: unknown[]) {
  return feedbackRun(argv, new FakeTransport()
    .on("GET", "/api/feedback/bugs", () => ({ status: 200, headers: {}, body: { items: bugs } }))
    .on("GET", "/api/feedback/features", () => ({ status: 200, headers: {}, body: { items: features } })));
}

async function feedbackRun(argv: string[], transport: FakeTransport) {
  const configDir = await testTemp("feedback-responses-");
  try {
    const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => configDir, env: { XDG_CONFIG_HOME: configDir } };
    await writeConfigAtomic(path.join(configDir, "screenrig", "config.json"), { api_url: "https://api.screenrig.ai", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr" }, fs);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = collect(stdout);
    const err = collect(stderr);
    const runtime: CliRuntime = { argv, env: fs.env, stdout, stderr, now: () => new Date("2026-10-16T12:00:00.000Z"), sleep: async () => undefined, homedir: fs.homedir, cwd: () => configDir, fs, transport };
    const code = await run(runtime);
    stdout.end();
    stderr.end();
    const text = await out;
    await err;
    return { code, stdout: text };
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

test("feedback list carries status and the staff responses in the envelope", async () => {
  const result = await feedbackList(["--json", "feedback", "list"], [FIXED], [OPEN]);
  assert.equal(result.code, 0, result.stdout);
  const envelope = JSON.parse(result.stdout) as { ok: boolean; data: { items: Array<{ id: string; status: string; responses?: Array<{ id: string; text: string; status: string; fixed_in?: string }> }> } };
  assert.equal(envelope.ok, true);
  const [bug, feature] = envelope.data.items;
  assert.equal(bug?.id, FIXED.id);
  assert.equal(bug?.status, "fixed");
  assert.deepEqual(bug?.responses?.map((response) => response.status), ["planned", "fixed"]);
  assert.equal(bug?.responses?.[1]?.fixed_in, "26.10.93");
  assert.equal(bug?.responses?.[1]?.text, "Fixed in the next release.\nThanks for the report.");
  assert.equal(feature?.status, "open");
  assert.equal(feature?.responses, undefined);
});

test("feedback show reads the complete thread and identifies legacy staff and agent replies", async () => {
  const item = { ...FIXED, status: "open", responses: [...FIXED.responses, { id: "fbr_agent", text: "Still reproduces.", status: "open", author: "agent", created_at: "2026-10-16T12:00:00.000Z" }] };
  const transport = new FakeTransport().on("GET", `/api/feedback/${FIXED.id}`, () => ({ status: 200, headers: {}, body: item }));
  const result = await feedbackRun(["--human", "feedback", "show", FIXED.id], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /Staff.*planned/);
  assert.match(result.stdout, /Agent.*open/);
  assert.match(result.stdout, /Reproduced\./);
  assert.match(result.stdout, /Still reproduces\./);
  assert.equal(transport.calls.length, 1);
});

test("feedback reply sends only text under an idempotency key and returns the updated thread", async () => {
  const transport = new FakeTransport().on("POST", `/api/feedback/${FIXED.id}/responses`, (req) => {
    assert.deepEqual(req.body, { text: "Still reproduces." });
    assert.ok(req.headers?.["idempotency-key"]);
    return { status: 201, headers: {}, body: { ...FIXED, status: "open" } };
  });
  const result = await feedbackRun(["--json", "feedback", "reply", FIXED.id, "--body", "Still reproduces."], transport);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).data.status, "open");
  assert.equal(transport.calls.length, 1);
});

test("feedback reply validates text and ID before making a request", async () => {
  for (const argv of [
    ["feedback", "reply", FIXED.id, "--body", " "],
    ["feedback", "reply", FIXED.id, "--body", "x".repeat(2001)],
    ["feedback", "reply", "prj_other", "--body", "yes"],
    ["feedback", "reply", FIXED.id],
  ]) {
    const transport = new FakeTransport();
    const result = await feedbackRun(["--json", ...argv], transport);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(transport.calls.length, 0);
  }
});

test("feedback list shows the status and the latest reply on one line", async () => {
  const result = await feedbackList(["--human", "feedback", "list"], [FIXED], [OPEN]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /fb_AAAAAAAAAAAAAAAAAAAAAAAA\s+fixed\s+Pairing fails/);
  assert.match(result.stdout, /\n {4}fixed in 26\.10\.93: Fixed in the next release\. Thanks for the report\./);
  assert.match(result.stdout, /fb_BBBBBBBBBBBBBBBBBBBBBBBB\s+open\s+Dark mode/);
  assert.ok(!result.stdout.includes("Reproduced."), "only the latest reply is summarized");
});

test("feedback list reads a submission without status as open", async () => {
  const { status: _status, ...legacy } = OPEN;
  const result = await feedbackList(["--human", "feedback", "list", "--kind", "feature"], [], [legacy]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /fb_BBBBBBBBBBBBBBBBBBBBBBBB\s+open\s+Dark mode/);
});
