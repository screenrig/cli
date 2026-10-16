import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import type { ScreenRigConfig } from "./config.js";
import { processRuntime, run } from "./main.js";
import { initializePlaylist } from "./playlist-authoring.js";
import { fakeSessionJwt, FakeTransport } from "./transport/fake.js";

const A = "prj_AAAAAAAAAAAAAAAAAAAAAAAA", B = "prj_BBBBBBBBBBBBBBBBBBBBBBBB";
const organization = { id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", name: "Example organization" };
const project = (id: string, name = "Screens") => ({ id, name, organization_id: organization.id, organization_name: organization.name });
const subset = (...ids: string[]) => fakeSessionJwt({ exp: 4102444800, scope: "access:manage identity", projects: Object.fromEntries(ids.map(id => [id, ["content", "playlists", "screens"]])) });

async function fixture(t: TestContext, config: Partial<ScreenRigConfig>, target = A) {
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ api_url: "https://api.screenrig.ai", ...config }), { mode: 0o600 });
  await writeFile(path.join(directory, "playlist.json"), JSON.stringify(initializePlaylist({ name: "Lobby", media: [{ id: "med_IMAGE", primitive: "image", state: "ready" }], width: 1920, height: 1080, durationMs: 8000, fit: "contain" })));
  let assigned = false;
  const transport = new FakeTransport()
    .on("GET", "/api/screens/scr_TEST", () => ({ status: 200, headers: {}, body: { id: "scr_TEST", revision: assigned ? 2 : 1, ...(assigned ? { playlist_id: "pl_TEST" } : {}) } }))
    .on("POST", `/api/projects/${target}/playlists`, () => ({ status: 201, headers: {}, body: { id: "pl_TEST", revision: 1 } }))
    .on("PATCH", "/api/screens/scr_TEST", () => { assigned = true; return { status: 200, headers: {}, body: { id: "scr_TEST", revision: 2, playlist_id: "pl_TEST" } }; });
  async function invoke(...argv: string[]) {
    let stdout = "", stderr = "";
    const code = await run({ ...processRuntime(), argv: ["--config", configPath, ...argv], env: {}, cwd: () => directory, transport,
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    });
    return { code, stdout, stderr };
  }
  const publish = (...extra: string[]) => invoke("screen", "publish", "scr_TEST", "playlist.json", "--no-wait", "--no-progress", ...extra);
  return { transport, invoke, publish, saved: async () => JSON.parse(await readFile(configPath, "utf8")) as ScreenRigConfig };
}

for (const selection of ["implicit", "saved", "explicit"] as const) {
  test(`${selection} project-scoped publish fetches, caches and attaches the target context`, async t => {
    const target = selection === "implicit" ? A : B;
    const f = await fixture(t, { token: selection === "implicit" ? subset(A) : subset(A, B),
      ...(selection === "saved" ? { project_id: B } : selection === "explicit" ? { project_id: A, project_name: "Other", organization_id: organization.id, organization_name: "Other organization" } : {}) }, target);
    f.transport.on("GET", `/api/projects/${target}/project`, () => ({ status: 200, headers: {}, body: project(target) }));
    const result = await f.publish(...(selection === "explicit" ? ["--project-id", B] : []));
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(JSON.parse(result.stdout).context, { project: { id: target, name: "Screens" }, organization });
    assert.equal(result.stderr, "");
    assert.equal(f.transport.calls[0]?.path, `/api/projects/${target}/project`);
    assert.ok(f.transport.calls.some(call => call.path === `/api/projects/${target}/playlists`));
    const saved = await f.saved();
    assert.equal(saved.projects?.[target]?.organization_name, organization.name);
    assert.equal(saved.project_id, selection === "explicit" ? A : target);
    if (selection === "explicit") assert.equal(saved.project_name, "Other");
    const human = await f.publish("--human", ...(selection === "explicit" ? ["--project-id", B] : []));
    assert.equal(human.code, 0, human.stdout);
    assert.ok(human.stdout.startsWith(`organization: Example organization\nproject: Screens (${target})\nPublished and assigned\n`));
    // The publish itself reads project identity; the cached context needs no extra read.
    assert.equal(f.transport.calls.filter(call => call.path === `/api/projects/${target}/project`).length, 3);
  });
}

test("an unselected multi-project collection and project directory have no result context", async t => {
  const token = subset(A, B);
  const f = await fixture(t, { token, identity_token: token, oauth: { issuer: "https://api.screenrig.ai", client_id: "screenrig-cli", refresh_token: "test-only-refresh-token", identity: true } });
  f.transport.on("GET", "/api/screens", request => {
    assert.equal(request.query?.project, undefined);
    return { status: 200, headers: {}, body: { items: [], next_cursor: null } };
  });
  f.transport.on("GET", "/api/projects", () => ({ status: 200, headers: {}, body: { projects: [A, B].map(id => ({ project: project(id), organization })) } }));
  for (const command of [["screen", "list"], ["project", "list"]]) {
    const result = await f.invoke(...command);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).context, undefined);
  }
  assert.deepEqual(f.transport.calls.map(call => call.path), ["/api/screens", "/api/projects"]);
});

for (const mismatch of [false, true]) {
  test(`project-scoped context refuses ${mismatch ? "a different project" : "a missing organization"} before publishing`, async t => {
    const f = await fixture(t, { token: subset(A) });
    f.transport.on("GET", `/api/projects/${A}/project`, () => ({ status: 200, headers: {}, body: mismatch ? project(B) : { id: A, name: "Screens" } }));
    const result = await f.publish();
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout).error.code, "config_error");
    assert.deepEqual(f.transport.calls.map(call => call.path), [`/api/projects/${A}/project`]);
    assert.equal((await f.saved()).projects, undefined);
  });
}

test("legacy credentials retain their flat routes and exact human publish output", async t => {
  const f = await fixture(t, { token: "test-only-legacy-token" });
  f.transport.on("GET", "/api/project", () => ({ status: 200, headers: {}, body: project(A) }));
  f.transport.on("POST", "/api/playlists", () => ({ status: 201, headers: {}, body: { id: "pl_TEST", revision: 1 } }));
  const result = await f.publish("--human");
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stdout, `organization: Example organization\nproject: Screens (${A})\nPublished and assigned\nplaylist_id: pl_TEST\nscreen_id: scr_TEST\nstage: assigned\nwaited: 0 ms\n`);
  assert.equal(result.stderr, "");
  assert.ok(f.transport.calls.every(call => !call.path.startsWith("/api/projects/")));
});

test("project-scoped remote playlist preparation resolves context before reading the screen", async t => {
  const f = await fixture(t, { token: subset(A) });
  f.transport.on("GET", `/api/projects/${A}/project`, () => ({ status: 200, headers: {}, body: project(A) }));
  const result = await f.invoke("playlist", "init", "https://example.com", "--screen-id", "scr_TEST", "--name", "Lobby", "--output", "prepared.json", "--target-width", "1920", "--target-height", "1080");
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).context, { project: { id: A, name: "Screens" }, organization });
  assert.deepEqual(f.transport.calls.map(call => call.path), [`/api/projects/${A}/project`, "/api/screens/scr_TEST"]);
});
