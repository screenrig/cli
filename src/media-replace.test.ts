import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { writeConfigAtomic } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { commandHelp } from "./help.js";
import { run } from "./main.js";
import type { SignedRawPut } from "./runtime.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const MEDIA = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const UPLOAD = "upload_REPLACEAAAAAAAAAAAAAA";
const OPERATION = "op_REPLACEAAAAAAAAAAAAAAAAA";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const AT = "2026-10-29T10:00:00.000Z";

const problem = (status: number, code: string, detail: string) => ({
  status, headers: { "content-type": "application/problem+json" },
  body: { type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, status, detail, code },
});

interface Harness {
  dir: string;
  file: string;
  puts: Array<{ url: string; bytes: number }>;
  invoke(argv: string[], transport: FakeTransport, extra?: string[]): Promise<{ code: number; envelope: Record<string, any>; stderr: string }>;
}

/** An enrolled CLI in a private directory with a one-pixel PNG, and a signed PUT that records what it was given. */
async function harness(t: TestContext): Promise<Harness> {
  const dir = await testTemp("media-replace-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir } };
  await writeConfigAtomic(path.join(dir, "screenrig", "config.json"), {
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization",
    token: "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr",
  }, fs);
  const file = path.join(dir, "menu.png");
  await writeFile(file, PNG);
  const puts: Harness["puts"] = [];
  const signedRawPut: SignedRawPut = async (request) => {
    puts.push({ url: request.url, bytes: (request.body as Uint8Array).length });
    return { status: 200 };
  };
  return {
    dir, file, puts,
    async invoke(argv, transport) {
      let output = "";
      let errors = "";
      const code = await run({
        argv: ["--json", ...argv], env: fs.env, fs, homedir: fs.homedir, cwd: () => dir, transport,
        stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
        stderr: new Writable({ write(chunk, _encoding, done) { errors += chunk; done(); } }),
        now: () => new Date(AT), sleep: async () => undefined, signedRawPut,
      });
      return { code, envelope: JSON.parse(output), stderr: errors };
    },
  };
}

const operation = (state: string, extra: Record<string, unknown> = {}) => ({
  id: OPERATION, kind: "media.upload", state, created_at: AT, updated_at: AT, ...extra,
});

interface FakeOptions {
  primitive?: string;
  /** The operation the replace request starts, as GET /api/operations/ID answers it. */
  finished?: Record<string, unknown>;
  replace?: (request: { headers?: Record<string, string>; body?: unknown }) => { status: number; headers: Record<string, string>; body: unknown };
}

/** The routes `media replace` meets: the media, the declare, the replace, its operation, a review and the cancel. */
function replaceServer(options: FakeOptions = {}): FakeTransport {
  let reads = 0;
  return new FakeTransport()
    .on("GET", `/api/media/${MEDIA}`, () => {
      reads += 1;
      return { status: 200, headers: {}, body: { id: MEDIA, primitive: options.primitive ?? "image", revision: reads === 1 ? 3 : 4, state: "ready" } };
    })
    .on("POST", "/api/media/uploads", (request) => ({
      status: 201,
      headers: { "cache-control": "private, no-store" },
      body: {
        id: UPLOAD, operation: operation("receiving"), upload_url: "https://storage.example.invalid/signed/replace", method: "PUT",
        headers: { "content-type": (request.body as { content_type: string }).content_type }, expires_at: "2099-01-01T00:00:00.000Z",
      },
    }))
    .on("POST", `/api/media/${MEDIA}/replace`, (request) => options.replace?.(request) ?? { status: 202, headers: {}, body: operation("queued") })
    .on("GET", `/api/operations/${OPERATION}`, () => ({ status: 200, headers: {}, body: options.finished ?? operation("succeeded", { result: { media_id: MEDIA, id: MEDIA, version: 2, warnings: [] } }) }))
    .on("POST", `/api/operations/${OPERATION}/cancel`, () => ({ status: 202, headers: {}, body: operation("cancelled") }))
    .on("GET", "/api/reviews/rvw_REPLACEAAAAAAAAAAAAAAAA", () => ({ status: 200, headers: {}, body: { id: "rvw_REPLACEAAAAAAAAAAAAAAAA", url: "https://screenrig.ai/dashboard/reviews/rvw_REPLACEAAAAAAAAAAAAAAAA" } }));
}

const header = (call: { headers?: Record<string, string> }, name: string): string | undefined => call.headers?.[name];

const writes = (transport: FakeTransport) => transport.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

test("media replace declares without a tag or folder, writes the bytes, replaces and waits on the operation", async (t) => {
  const cli = await harness(t);
  const aspect = { code: "aspect_ratio_changed", detail: "The new file is 9:16 and the media was 16:9.", playlists: [{ id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA", name: "Lobby loop" }] };
  const transport = replaceServer({ finished: operation("succeeded", { result: { media_id: MEDIA, id: MEDIA, version: 2, warnings: [aspect] } }) });
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode", "--expect-rev", "3", "--note", "New spring menu"], transport);
  assert.equal(answer.code, 0, JSON.stringify(answer.envelope));
  assert.deepEqual(writes(transport), ["POST /api/media/uploads", `POST /api/media/${MEDIA}/replace`], "no commit: the replace finishes the upload");
  const declare = transport.calls.find((call) => call.path === "/api/media/uploads")!;
  const declared = declare.body as Record<string, unknown>;
  assert.equal(declared.filename, "menu.png");
  assert.equal(declared.content_type, "image/png");
  assert.equal(Object.hasOwn(declared, "tag"), false);
  assert.equal(Object.hasOwn(declared, "folder_id"), false);
  assert.deepEqual(cli.puts, [{ url: "https://storage.example.invalid/signed/replace", bytes: PNG.length }]);
  const replace = transport.calls.find((call) => call.path === `/api/media/${MEDIA}/replace`)!;
  assert.deepEqual(replace.body, { upload_id: UPLOAD, note: "New spring menu" });
  assert.equal(header(replace, "if-match"), '"3"');
  assert.match(header(replace, "idempotency-key") ?? "", /^[A-Za-z0-9_-]{16,}$/);
  assert.notEqual(header(replace, "idempotency-key"), header(declare, "idempotency-key"));
  const data = answer.envelope.data;
  assert.equal(data.media_id, MEDIA);
  assert.equal(data.id, MEDIA);
  assert.equal(data.version, 2);
  assert.equal(data.revision, 4);
  assert.equal(data.operation.state, "succeeded");
  assert.deepEqual(data.warnings, [aspect]);
  assert.equal(data.status, undefined);
  assert.equal(answer.envelope.operation_id, OPERATION);
  const warning = answer.envelope.warnings.find((item: { code: string }) => item.code === "aspect_ratio_changed");
  assert.match(warning.message, /Lobby loop \(pl_AAAAAAAAAAAAAAAAAAAAAAAA\)/);
  assert.match(answer.stderr, /warning: The new file is 9:16 and the media was 16:9\. Playlists: Lobby loop/);
});

test("media replace without a revision sends no If-Match and sends no note", async (t) => {
  const cli = await harness(t);
  const transport = replaceServer();
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode"], transport);
  assert.equal(answer.code, 0, JSON.stringify(answer.envelope));
  const replace = transport.calls.find((call) => call.path === `/api/media/${MEDIA}/replace`)!;
  assert.deepEqual(replace.body, { upload_id: UPLOAD });
  assert.equal(header(replace, "if-match"), undefined);
});

test("media replace under Propose reports the waiting review as a success", async (t) => {
  const cli = await harness(t);
  const transport = replaceServer({ finished: operation("succeeded", { result: { media_id: MEDIA, id: MEDIA, status: "pending_review", review_id: "rvw_REPLACEAAAAAAAAAAAAAAAA", version: 2, warnings: [] } }) });
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode"], transport);
  assert.equal(answer.code, ExitCode.Success, JSON.stringify(answer.envelope));
  const data = answer.envelope.data;
  assert.equal(data.status, "pending_review");
  assert.equal(data.review_id, "rvw_REPLACEAAAAAAAAAAAAAAAA");
  assert.equal(data.version, 2);
  assert.equal(data.revision, undefined, "the media did not change, so no new revision is read");
  assert.deepEqual(data.next.argv, ["reviews", "show", "rvw_REPLACEAAAAAAAAAAAAAAAA"]);
  assert.deepEqual(answer.envelope.warnings.map((warning: { code: string }) => warning.code), ["pending_review"]);
  assert.match(answer.envelope.warnings[0].message, /https:\/\/screenrig\.ai\/dashboard\/reviews\/rvw_REPLACEAAAAAAAAAAAAAAAA/);
});

test("media replace refuses a file of another kind before any transfer", async (t) => {
  const cli = await harness(t);
  const transport = replaceServer({ primitive: "video" });
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode"], transport);
  assert.equal(answer.code, ExitCode.Usage);
  assert.equal(answer.envelope.error.code, "usage_error");
  assert.match(answer.envelope.error.detail, /menu\.png is not a video file, and med_A+ is a video: a replacement must be the same kind of file/);
  assert.deepEqual(writes(transport), [], "nothing was declared");
  assert.deepEqual(cli.puts, []);
  const unknown = await cli.invoke(["media", "replace", "not-an-id", cli.file], replaceServer());
  assert.equal(unknown.code, ExitCode.Usage);
  assert.match(unknown.envelope.error.detail, /takes a media ID \(med_\.\.\.\)/);
});

test("a stale --expect-rev cancels the declared upload and points at media show", async (t) => {
  const cli = await harness(t);
  const transport = replaceServer({ replace: () => problem(412, "revision_conflict", "The media is at revision 5.") });
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode", "--expect-rev", "3"], transport);
  assert.equal(answer.code, ExitCode.Precondition, JSON.stringify(answer.envelope));
  assert.equal(answer.envelope.error.code, "revision_conflict");
  assert.equal(answer.envelope.error.next.command, `screenrig media show ${MEDIA}`);
  assert.equal(answer.envelope.error.hint, `Upload ${OPERATION} was cancelled, so it holds no storage.`);
  assert.deepEqual(writes(transport), ["POST /api/media/uploads", `POST /api/media/${MEDIA}/replace`, `POST /api/operations/${OPERATION}/cancel`]);
});

test("a replacement the server refuses after processing fails the command with its next step", async (t) => {
  const cli = await harness(t);
  const transport = replaceServer({ finished: operation("failed", { error: { code: "resource_conflict", status: 409, detail: "The media already carries these bytes." } }) });
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode"], transport);
  assert.equal(answer.code, ExitCode.OperationFailed, JSON.stringify(answer.envelope));
  assert.equal(answer.envelope.error.code, "resource_conflict");
  assert.match(answer.envelope.error.detail, /already carries these bytes/);
  assert.equal(answer.envelope.error.next.command, `screenrig media versions ${MEDIA}`);
});

test("media replace --no-wait returns the accepted operation without polling", async (t) => {
  const cli = await harness(t);
  const transport = replaceServer();
  const answer = await cli.invoke(["media", "replace", MEDIA, cli.file, "--no-transcode", "--no-wait"], transport);
  assert.equal(answer.code, 0, JSON.stringify(answer.envelope));
  assert.equal(transport.calls.some((call) => call.path === `/api/operations/${OPERATION}`), false);
  const data = answer.envelope.data;
  assert.equal(data.media_id, MEDIA);
  assert.equal(data.operation.state, "queued");
  assert.equal(data.version, undefined);
  assert.equal(data.warnings, undefined);
  assert.equal(answer.envelope.operation_id, OPERATION);
});

const VERSIONS = [
  { number: 3, current: true, filename: "menu.png", content_type: "image/png", sha256: "c".repeat(64), bytes: 300, width: 1080, height: 1920, source: "restore", restored_from: 1, by: { kind: "agent", id: "agt_X", name: "Lobby agent" }, note: "Back", created_at: "2026-10-03T10:00:00Z" },
  { number: 2, current: false, filename: "menu.png", content_type: "image/png", sha256: "b".repeat(64), bytes: 200, source: "replace", by: { kind: "person", name: "Ana" }, created_at: "2026-10-02T10:00:00Z" },
  { number: 1, current: false, filename: "menu.png", content_type: "image/png", sha256: "a".repeat(64), bytes: 100, source: "upload", created_at: "2026-10-01T10:00:00Z" },
];

test("media versions follows next_cursor to the end, or reads one page with --limit and --cursor", async (t) => {
  const cli = await harness(t);
  const queries: unknown[] = [];
  const transport = new FakeTransport().on("GET", `/api/media/${MEDIA}/versions`, (request) => {
    queries.push(request.query ?? {});
    const cursor = request.query?.cursor;
    return { status: 200, headers: {}, body: cursor === "cur_2"
      ? { items: [VERSIONS[2]], next_cursor: null }
      : cursor === "cur_1" ? { items: VERSIONS.slice(1, 2), next_cursor: "cur_2" }
      : { items: VERSIONS.slice(0, 1), next_cursor: "cur_1" } };
  });
  const all = await cli.invoke(["media", "versions", MEDIA], transport);
  assert.equal(all.code, 0, JSON.stringify(all.envelope));
  assert.deepEqual(all.envelope.data.items.map((item: { number: number }) => item.number), [3, 2, 1]);
  assert.equal(all.envelope.data.next_cursor, null);
  assert.deepEqual(queries, [{}, { cursor: "cur_1" }, { cursor: "cur_2" }]);
  queries.length = 0;
  const page = await cli.invoke(["media", "versions", MEDIA, "--limit", "1", "--cursor", "cur_1"], transport);
  assert.equal(page.code, 0, JSON.stringify(page.envelope));
  assert.deepEqual(queries, [{ limit: "1", cursor: "cur_1" }]);
  assert.deepEqual(page.envelope.data.items.map((item: { number: number }) => item.number), [2]);
  assert.equal(page.envelope.data.next_cursor, "cur_2");
  // Human output: one row per version and the command for the next page.
  const human = await (async () => {
    let output = "";
    const code = await run({
      argv: ["--human", "media", "versions", MEDIA, "--limit", "1"], env: { XDG_CONFIG_HOME: cli.dir }, homedir: () => cli.dir, cwd: () => cli.dir, transport,
      fs: { mkdir, open, rename, rm, chmod, stat, homedir: () => cli.dir, env: { XDG_CONFIG_HOME: cli.dir } },
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
      now: () => new Date(AT), sleep: async () => undefined,
    });
    return { code, output };
  })();
  assert.equal(human.code, 0, human.output);
  assert.match(human.output, new RegExp(`^Media ${MEDIA} versions \\(1\\)$`, "m"));
  assert.match(human.output, /^3 \(current\)\s+restore of 1\s+menu\.png\s+300\s+1080x1920\s+Lobby agent \(agent\)\s+2026-10-03T10:00:00Z\s+Back$/m);
  assert.match(human.output, new RegExp(`^next: screenrig media versions ${MEDIA} --cursor cur_1$`, "m"));
});

test("media versions names an unknown media and its next step", async (t) => {
  const cli = await harness(t);
  const transport = new FakeTransport().on("GET", `/api/media/${MEDIA}/versions`, () => problem(404, "not_found", "No such media."));
  const answer = await cli.invoke(["media", "versions", MEDIA], transport);
  assert.equal(answer.code, ExitCode.NotFound);
  assert.equal(answer.envelope.error.next.command, `screenrig media versions ${MEDIA}`);
});

test("media restore puts a version back (200) with the revision guard and note", async (t) => {
  const cli = await harness(t);
  const aspect = { code: "aspect_ratio_changed", detail: "The restored file is 16:9 and the media was 9:16.", playlists: [{ id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA", name: "Lobby loop" }] };
  const transport = new FakeTransport().on("POST", `/api/media/${MEDIA}/versions/2/restore`, () => ({
    status: 200, headers: { etag: '"6"' }, body: { media: { id: MEDIA, primitive: "image", revision: 6 }, warnings: [aspect] },
  }));
  const answer = await cli.invoke(["media", "restore", MEDIA, "--number", "2", "--expect-rev", "5", "--note", "Back to winter"], transport);
  assert.equal(answer.code, 0, JSON.stringify(answer.envelope));
  const call = transport.calls[0]!;
  assert.equal(header(call, "if-match"), '"5"');
  assert.deepEqual(call.body, { note: "Back to winter" });
  assert.match(header(call, "idempotency-key") ?? "", /^[A-Za-z0-9_-]{16,}$/);
  assert.equal(answer.envelope.data.media.revision, 6);
  assert.deepEqual(answer.envelope.data.warnings, [aspect]);
  assert.match(answer.envelope.warnings[0].message, /Lobby loop \(pl_AAAAAAAAAAAAAAAAAAAAAAAA\)/);
  const bare = await cli.invoke(["media", "restore", MEDIA, "--number", "2"], transport);
  assert.equal(bare.code, 0, JSON.stringify(bare.envelope));
  assert.equal(transport.calls[1]!.body, undefined);
  assert.equal(header(transport.calls[1]!, "if-match"), undefined);
  // --version N names the same version; the root's own --version flag does not take it.
  const spelled = await cli.invoke(["media", "restore", MEDIA, "--version", "2"], transport);
  assert.equal(spelled.code, 0, JSON.stringify(spelled.envelope));
  assert.equal(transport.calls[2]!.path, `/api/media/${MEDIA}/versions/2/restore`);
  const equalsForm = await cli.invoke(["media", "restore", MEDIA, "--version=2"], transport);
  assert.equal(equalsForm.code, 0, JSON.stringify(equalsForm.envelope));
});

test("media restore under Propose answers pending_review as a success", async (t) => {
  const cli = await harness(t);
  const review = { id: "rvw_RESTOREAAAAAAAAAAAAAAAA", kind: "playlist_change", state: "pending", url: "https://screenrig.ai/dashboard/reviews/rvw_RESTOREAAAAAAAAAAAAAAAA", subject: { type: "media", id: MEDIA, name: "menu.png" }, impact: { screens: 4 } };
  const transport = new FakeTransport().on("POST", `/api/media/${MEDIA}/versions/2/restore`, () => ({ status: 202, headers: {}, body: { status: "pending_review", review, warnings: [] } }));
  const answer = await cli.invoke(["media", "restore", MEDIA, "--number", "2"], transport);
  assert.equal(answer.code, ExitCode.Success, JSON.stringify(answer.envelope));
  assert.equal(answer.envelope.data.status, "pending_review");
  assert.equal(answer.envelope.data.review.id, review.id);
  assert.deepEqual(answer.envelope.data.next.argv, ["reviews", "show", review.id]);
  assert.equal(answer.envelope.warnings[0].code, "pending_review");
  assert.match(answer.envelope.warnings[0].message, /rvw_RESTOREAAAAAAAAAAAAAAAA/);
});

test("media restore of the current version and of an unknown version name the way forward", async (t) => {
  const cli = await harness(t);
  const transport = new FakeTransport()
    .on("POST", `/api/media/${MEDIA}/versions/3/restore`, () => problem(409, "resource_conflict", "Version 3 is the version in service."))
    .on("POST", `/api/media/${MEDIA}/versions/9/restore`, () => problem(404, "not_found", "Version 9 does not exist."));
  const current = await cli.invoke(["media", "restore", MEDIA, "--number", "3"], transport);
  assert.equal(current.code, ExitCode.Conflict);
  assert.equal(current.envelope.error.next.command, `screenrig media versions ${MEDIA}`);
  const unknown = await cli.invoke(["media", "restore", MEDIA, "--number", "9"], transport);
  assert.equal(unknown.code, ExitCode.NotFound);
  const stale = await cli.invoke(["media", "restore", MEDIA, "--number", "2", "--expect-rev", "1"],
    new FakeTransport().on("POST", `/api/media/${MEDIA}/versions/2/restore`, () => problem(412, "revision_conflict", "Stale.")));
  assert.equal(stale.envelope.error.next.command, `screenrig media show ${MEDIA}`);
});

test("media version delete removes a past version and refuses the current one", async (t) => {
  const cli = await harness(t);
  const transport = new FakeTransport()
    .on("DELETE", `/api/media/${MEDIA}/versions/2`, () => ({ status: 204, headers: {}, body: undefined }))
    .on("DELETE", `/api/media/${MEDIA}/versions/3`, () => problem(409, "resource_conflict", "Version 3 is in service."));
  const done = await cli.invoke(["media", "version", "delete", MEDIA, "--number", "2"], transport);
  assert.equal(done.code, 0, JSON.stringify(done.envelope));
  assert.deepEqual(done.envelope.data, { media_id: MEDIA, version: 2, deleted: true });
  assert.match(header(transport.calls[0]!, "idempotency-key") ?? "", /^[A-Za-z0-9_-]{16,}$/);
  const current = await cli.invoke(["media", "version", "delete", MEDIA, "--number", "3"], transport);
  assert.equal(current.code, ExitCode.Conflict);
  assert.equal(current.envelope.error.next.command, `screenrig media versions ${MEDIA}`);
});

test("restore and version delete reject a missing or malformed --number and a bad media ID before any request", async (t) => {
  const cli = await harness(t);
  const transport = new FakeTransport();
  for (const argv of [
    ["media", "version", "delete", MEDIA],
    ["media", "restore", MEDIA],
    ["media", "version", "delete", MEDIA, "--number", "0"],
    ["media", "restore", MEDIA, "--number", "two"],
    ["media", "restore", "nope", "--number", "2"],
    ["media", "version", "delete", "nope", "--number", "2"],
  ]) {
    const answer = await cli.invoke(argv, transport);
    assert.equal(answer.code, ExitCode.Usage, `${argv.join(" ")}: ${JSON.stringify(answer.envelope)}`);
    assert.equal(answer.envelope.error.code, "usage_error");
  }
  assert.match((await cli.invoke(["media", "version", "delete", MEDIA], transport)).envelope.error.detail, /requires --number/);
  assert.equal(transport.calls.length, 0);
});

test("help for the media version commands states scope, review behaviour and recovery", () => {
  const replace = commandHelp(["media", "replace"]);
  assert.ok(replace.examples.length >= 2 && replace.examples.every((example) => example.startsWith("screenrig media replace med_")));
  for (const name of ["--expect-rev", "--note", "--no-transcode", "--codec", "--max-fps", "--max-edge", "--webp-quality", "--preset", "--no-audio", "--no-progress", "--poll-ms", "--no-wait", "--content-type"]) {
    assert.ok(replace.options.some((option) => option.name === name), name);
  }
  assert.equal(replace.options.some((option) => option.name === "--tag" || option.name === "--folder"), false, "the media keeps its tag and folder");
  const replaceNotes = replace.notes.join("\n");
  for (const phrase of [/same ID|keeps its ID/, /same kind/, /aspect_ratio_changed/, /pending_review/, /revision_conflict/, /media show ID/, /media restore ID --number N/, /--no-wait/]) {
    assert.match(replaceNotes, phrase);
  }
  const versions = commandHelp(["media", "versions"]);
  assert.equal(versions.options.find((option) => option.name === "--cursor")?.type, "value");
  assert.match(versions.notes.join("\n"), /data\.next_cursor is a string[^.]*--cursor/);
  assert.match(versions.notes.join("\n"), /Read only access is enough\./);
  const restore = commandHelp(["media", "restore"]);
  assert.equal(restore.options.find((option) => option.name === "--number")?.required, true);
  assert.match(restore.notes.join("\n"), /pending_review/);
  assert.match(restore.notes.join("\n"), /resource_conflict/);
  const remove = commandHelp(["media", "version", "delete"]);
  assert.equal(remove.options.find((option) => option.name === "--number")?.required, true);
  assert.match(remove.notes.join("\n"), /cannot be restored/);
  assert.match(remove.notes.join("\n"), /Manage access/);
  assert.ok(remove.examples.length > 0);
  assert.deepEqual(commandHelp(["media", "version"]).commands.map((child) => child.name), ["delete"]);
});
