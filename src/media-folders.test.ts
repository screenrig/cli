import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { commandHelp } from "./help.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const FOLDER = "mfd_AAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "mfd_BBBBBBBBBBBBBBBBBBBBBBBB";
const FILE = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
const FILE_2 = "med_BBBBBBBBBBBBBBBBBBBBBBBB";

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

async function withRuntime(argv: string[], transport: FakeTransport, configDir: string): Promise<{ code: number; stdout: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike = realFs(configDir);
  const runtime: CliRuntime = {
    argv, env: fsLike.env, stdout, stderr,
    now: () => new Date("2026-10-21T17:00:00.000Z"), sleep: async () => undefined,
    homedir: fsLike.homedir, cwd: () => configDir, fs: fsLike, transport,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  await errP;
  return { code, stdout: await outP };
}

async function enrolled(configDir: string): Promise<void> {
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" },
    realFs(configDir),
  );
}

const folder = (id: string, name: string, parent: string | null) => ({ id, name, parent_id: parent, revision: 1, created_at: "2026-10-21T17:00:00Z", updated_at: "2026-10-21T17:00:00Z" });
const json = (status: number, body: unknown) => ({ status, headers: { "content-type": "application/json", etag: '"1"' }, body });

test("media folder commands are in help", () => {
  for (const name of ["list", "show", "create", "update", "delete"]) {
    assert.match(commandHelp(["media", "folder", name]).synopsis[0]!, new RegExp(`media folder ${name}`));
  }
  assert.match(commandHelp(["media", "move"]).synopsis[0]!, /media move/);
});

test("media folder create, list, show, update and delete call the folder routes", async () => {
  const configDir = await testTemp("media-folders-");
  await enrolled(configDir);
  const transport = new FakeTransport()
    .on("GET", "/api/media-folders", () => json(200, { items: [folder(FOLDER, "Menus", null)] }))
    .on("POST", "/api/media-folders", (req) => json(201, folder(FOLDER, (req.body as { name: string }).name, (req.body as { parent_id?: string }).parent_id ?? null)))
    .on("GET", `/api/media-folders/${FOLDER}`, () => json(200, folder(FOLDER, "Menus", null)))
    .on("PATCH", `/api/media-folders/${FOLDER}`, () => json(200, folder(FOLDER, "Archive", null)))
    .on("DELETE", `/api/media-folders/${FOLDER}`, () => ({ status: 204, headers: {}, body: undefined }));
  try {
    const listed = await withRuntime(["--json", "media", "folder", "list"], transport, configDir);
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    assert.equal((JSON.parse(listed.stdout) as { data: { items: Array<{ id: string }> } }).data.items[0]?.id, FOLDER);

    const shown = await withRuntime(["--json", "media", "folder", "show", FOLDER], transport, configDir);
    assert.equal(shown.code, ExitCode.Success, shown.stdout);

    const root = await withRuntime(["--json", "media", "folder", "create", "--name", "Menus"], transport, configDir);
    assert.equal(root.code, ExitCode.Success, root.stdout);
    assert.deepEqual(transport.calls.filter((call) => call.method === "POST").at(-1)?.body, { name: "Menus" });

    const nested = await withRuntime(["--json", "media", "folder", "create", "--name", "Lunch", "--parent", OTHER], transport, configDir);
    assert.equal(nested.code, ExitCode.Success, nested.stdout);
    const created = transport.calls.filter((call) => call.method === "POST").at(-1);
    assert.deepEqual(created?.body, { name: "Lunch", parent_id: OTHER });
    assert.ok(created?.headers?.["idempotency-key"]);

    const renamed = await withRuntime(["--json", "media", "folder", "update", FOLDER, "--name", "Archive", "--expect-rev", "1"], transport, configDir);
    assert.equal(renamed.code, ExitCode.Success, renamed.stdout);
    let patch = transport.calls.filter((call) => call.method === "PATCH").at(-1);
    assert.deepEqual(patch?.body, { name: "Archive" });
    assert.equal(patch?.headers?.["if-match"], '"1"');

    const moved = await withRuntime(["--json", "media", "folder", "update", FOLDER, "--parent", OTHER], transport, configDir);
    assert.equal(moved.code, ExitCode.Success, moved.stdout);
    patch = transport.calls.filter((call) => call.method === "PATCH").at(-1);
    assert.deepEqual(patch?.body, { parent_id: OTHER });

    const toRoot = await withRuntime(["--json", "media", "folder", "update", FOLDER, "--root"], transport, configDir);
    assert.equal(toRoot.code, ExitCode.Success, toRoot.stdout);
    patch = transport.calls.filter((call) => call.method === "PATCH").at(-1);
    assert.deepEqual(patch?.body, { parent_id: null });

    const deleted = await withRuntime(["--json", "media", "folder", "delete", FOLDER, "--expect-rev", "2"], transport, configDir);
    assert.equal(deleted.code, ExitCode.Success, deleted.stdout);
    assert.equal(transport.calls.filter((call) => call.method === "DELETE").at(-1)?.headers?.["if-match"], '"2"');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media folder commands refuse a bad id or an empty update before any request", async () => {
  const configDir = await testTemp("media-folders-usage-");
  await enrolled(configDir);
  const transport = new FakeTransport();
  try {
    for (const argv of [
      ["media", "folder", "show", "Menus"],
      ["media", "folder", "delete", FILE],
      ["media", "folder", "create", "--name", "Lunch", "--parent", "Menus"],
      ["media", "folder", "update", FOLDER],
      ["media", "folder", "update", FOLDER, "--parent", OTHER, "--root"],
      ["media", "folder", "create"],
    ]) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media move sends files and folders to a folder or the library root", async () => {
  const configDir = await testTemp("media-move-");
  await enrolled(configDir);
  const transport = new FakeTransport().on("POST", "/api/media/move", () => json(200, { media: 2, folders: 1 }));
  try {
    const into = await withRuntime(["--json", "media", "move", FILE, FILE_2, OTHER, "--folder", FOLDER], transport, configDir);
    assert.equal(into.code, ExitCode.Success, into.stdout);
    const call = transport.calls.at(-1);
    assert.deepEqual(call?.body, { folder_id: FOLDER, media_ids: [FILE, FILE_2], folder_ids: [OTHER] });
    assert.ok(call?.headers?.["idempotency-key"]);
    assert.deepEqual((JSON.parse(into.stdout) as { data: unknown }).data, { media: 2, folders: 1 });

    const toRoot = await withRuntime(["--json", "media", "move", FILE, "--root"], transport, configDir);
    assert.equal(toRoot.code, ExitCode.Success, toRoot.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { folder_id: null, media_ids: [FILE] });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media move refuses a missing destination, both destinations and unknown ids before any request", async () => {
  const configDir = await testTemp("media-move-usage-");
  await enrolled(configDir);
  const transport = new FakeTransport();
  try {
    for (const argv of [
      ["media", "move", FILE],
      ["media", "move", FILE, "--folder", FOLDER, "--root"],
      ["media", "move", "poster.png", "--folder", FOLDER],
      ["media", "move", FILE, "--folder", "Menus"],
    ]) {
      const result = await withRuntime(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

const mediaRow = (id: string, folderId?: string) => ({
  id, filename: `${id}.png`, source_filename: `${id}.png`, primitive: "image", content_type: "image/png", operation_id: "op_EARLIER",
  sha256: "0".repeat(64), bytes: 4, revision: 1, state: "ready", created_at: "2026-10-21T17:00:00Z", updated_at: "2026-10-21T17:00:00Z",
  ...(folderId ? { folder_id: folderId } : {}),
});

test("media list --folder sends the folder to the API and refuses a malformed id", async () => {
  const configDir = await testTemp("media-list-folder-");
  await enrolled(configDir);
  const transport = new FakeTransport().on("GET", "/api/media", (req) => json(200, {
    items: req.query?.folder === FOLDER ? [mediaRow(FILE, FOLDER)] : req.query?.folder === "root" ? [mediaRow(FILE_2)] : [mediaRow(FILE, FOLDER), mediaRow(FILE_2)],
    next_cursor: null,
  }));
  try {
    const list = async (...folder: string[]) => {
      const result = await withRuntime(["--json", "media", "list", ...folder], transport, configDir);
      assert.equal(result.code, ExitCode.Success, result.stdout);
      return (JSON.parse(result.stdout) as { data: { items: Array<{ id: string }> } }).data.items.map((item) => item.id);
    };
    assert.deepEqual(await list("--folder", FOLDER), [FILE]);
    assert.equal(transport.calls.at(-1)?.query?.folder, FOLDER);
    assert.deepEqual(await list("--folder", "root"), [FILE_2]);
    assert.equal(transport.calls.at(-1)?.query?.folder, "root");
    assert.equal((await list()).length, 2);
    assert.equal(transport.calls.at(-1)?.query?.folder, undefined);
    transport.calls.length = 0;
    const bad = await withRuntime(["--json", "media", "list", "--folder", "Menus"], transport, configDir);
    assert.equal(bad.code, ExitCode.Usage, bad.stdout);
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media upload --folder checks the folder first and moves the ready upload into it", async () => {
  const configDir = await testTemp("media-upload-folder-");
  await enrolled(configDir);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const file = path.join(configDir, "menu.png");
  await writeFile(file, bytes);
  const earlier = { ...mediaRow(FILE), filename: "menu.png", source_filename: "menu.png", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  const transport = new FakeTransport()
    .on("GET", `/api/media-folders/${FOLDER}`, () => json(200, folder(FOLDER, "Menus", null)))
    .on("GET", "/api/media", () => json(200, { items: [earlier], next_cursor: null }))
    .on("GET", "/api/operations/op_EARLIER", () => json(200, { id: "op_EARLIER", kind: "media.upload", state: "succeeded", created_at: earlier.created_at, updated_at: earlier.updated_at, result: { media_id: FILE } }))
    .on("POST", "/api/media/move", () => json(200, { media: 1, folders: 0 }));
  try {
    const uploaded = await withRuntime(["--json", "media", "upload", file, "--no-transcode", "--folder", FOLDER], transport, configDir);
    assert.equal(uploaded.code, ExitCode.Success, uploaded.stdout);
    const data = (JSON.parse(uploaded.stdout) as { data: { media_id: string; folder_id: string } }).data;
    assert.equal(data.media_id, FILE);
    assert.equal(data.folder_id, FOLDER);
    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    assert.ok(paths.indexOf(`GET /api/media-folders/${FOLDER}`) < paths.indexOf("GET /api/media"), "the folder is checked before any upload work");
    assert.deepEqual(transport.calls.find((call) => call.path === "/api/media/move")?.body, { folder_id: FOLDER, media_ids: [FILE] });

    transport.calls.length = 0;
    const noWait = await withRuntime(["--json", "media", "upload", file, "--no-transcode", "--no-wait", "--folder", FOLDER], transport, configDir);
    assert.equal(noWait.code, ExitCode.Usage, noWait.stdout);
    const malformed = await withRuntime(["--json", "media", "upload", file, "--no-transcode", "--folder", "Menus"], transport, configDir);
    assert.equal(malformed.code, ExitCode.Usage, malformed.stdout);
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("media upload --folder stops before any upload when the folder does not exist", async () => {
  const configDir = await testTemp("media-upload-folder-missing-");
  await enrolled(configDir);
  const file = path.join(configDir, "menu.png");
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const transport = new FakeTransport().on("GET", `/api/media-folders/${FOLDER}`, () => json(404, { type: "about:blank", title: "Not found", status: 404, code: "not_found", detail: "media folder not found" }));
  try {
    const result = await withRuntime(["--json", "media", "upload", file, "--no-transcode", "--folder", FOLDER], transport, configDir);
    assert.notEqual(result.code, ExitCode.Success, result.stdout);
    assert.equal(transport.calls.some((call) => call.path === "/api/media/uploads" || call.path === "/api/media/move"), false);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
