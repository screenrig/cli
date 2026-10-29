import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ScreenFolder } from "./adapters/protocol.js";
import { commandHelp } from "./help.js";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { ExitCode } from "./exit-codes.js";
import { run, type CliRuntime } from "./main.js";
import { projectRequest } from "./project-routing.js";
import { effectivePlaylistText } from "./screen-control.js";
import { folderListLines, folderRows, levelsLines, screenFolderName } from "./screen-folders.js";
import { folderSubtree, screenTarget } from "./screen-fleet.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportResponse } from "./transport/types.js";

const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";
const NORTH = "sfd_NORTHAAAAAAAAAAAAAAAAAA";
const CAFES = "sfd_CAFESAAAAAAAAAAAAAAAAAA";
const PATIO = "sfd_PATIOAAAAAAAAAAAAAAAAAA";
const SOUTH = "sfd_SOUTHAAAAAAAAAAAAAAAAAA";
const A = "scr_AAAAAAAAAAAAAAAAAAAAAAAA";
const B = "scr_BBBBBBBBBBBBBBBBBBBBBBBB";
const C = "scr_CCCCCCCCCCCCCCCCCCCCCCCC";
const PLAYLIST = "pl_AAAAAAAAAAAAAAAAAAAAAAAA";
const CAMPAIGN = "cmp_SPRINGAAAAAAAAAAAA";
const MEDIA_FOLDER = "mfd_AAAAAAAAAAAAAAAAAAAAAAAA";

interface Envelope {
  ok: boolean;
  data?: any;
  error?: { code: string; detail: string; status: number; next?: { command: string; reason: string } };
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

const when = "2026-10-29T17:00:00Z";
const folder = (id: string, name: string, parent: string | null, extra: Record<string, unknown> = {}) => ({ id, name, parent_id: parent, revision: 1, created_at: when, updated_at: when, ...extra });
const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { "content-type": "application/json", etag: '"1"' }, body });
const problem = (status: number, code: string, detail: string): TransportResponse => ({
  status, headers: { "content-type": "application/problem+json" },
  body: { errors: [{ status, code, type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, detail }], request_id: "req_folders" },
});
const screen = (id: string, extra: Record<string, unknown> = {}) => ({
  id, label: id.slice(4, 8), state: "active", revision: 3, public_id: "pub", manifest_revision: 1, content_access_generation: 1, online: true,
  created_at: when, updated_at: when, ...extra,
});

/** North holds Cafes, which holds Patio; South stands alone. The server lists them by name. */
const TREE = [
  folder(CAFES, "Cafes", NORTH, { screens: 5 }),
  folder(NORTH, "North", null, { screens: 2, default_playlist_id: PLAYLIST }),
  folder(PATIO, "Patio", CAFES, { screens: 0 }),
  folder(SOUTH, "South", null, { screens: 1 }),
] as unknown as ScreenFolder[];

test("screen folder and move commands are in help, with the folder selector on every fleet command", () => {
  for (const name of ["list", "show", "create", "update", "delete"]) {
    const help = commandHelp(["screen", "folder", name]);
    assert.match(help.synopsis[0]!, new RegExp(`screen folder ${name}`));
    assert.ok(help.examples.length > 0, name);
  }
  assert.match(commandHelp(["screen", "move"]).synopsis[0]!, /screen move/);
  assert.deepEqual(commandHelp(["screen", "move"]).relationships, [{ kind: "exactlyOne", options: ["--folder", "--root"] }]);
  assert.match(commandHelp(["screen", "move"]).usage, /sfd_ IDs\) into --folder ID, or out of every folder with --root/);
  const update = commandHelp(["screen", "folder", "update"]);
  assert.deepEqual(update.relationships, [{ kind: "atLeastOne", options: ["--name", "--parent", "--root", "--default-playlist-id", "--clear-default"] }]);
  assert.deepEqual(update.options.find((option) => option.name === "--parent")?.conflicts, ["--root"]);
  assert.deepEqual(update.options.find((option) => option.name === "--default-playlist-id")?.conflicts, ["--clear-default"]);
  assert.deepEqual(update.options.find((option) => option.name === "--expect-rev")?.aliases, ["--if-match"]);
  assert.equal(commandHelp(["screen", "folder", "create"]).options.find((option) => option.name === "--name")?.required, true);
  assert.ok(commandHelp(["screen", "list"]).options.some((option) => option.name === "--folder"));
  for (const words of [
    ["assign"], ["reload"], ["toast"], ["screenshot"], ["tag"], ["schedule", "set"], ["schedule", "clear"], ["takeover", "set"], ["takeover", "clear"],
    ["reboot"], ["display", "set"], ["display", "clear"], ["display-schedule", "set"], ["display-schedule", "clear"],
  ]) {
    const option = commandHelp(["screen", ...words]).options.find((item) => item.name === "--folder");
    assert.ok(option, `screen ${words.join(" ")} takes --folder`);
    assert.deepEqual(option.conflicts, ["--tag"], `screen ${words.join(" ")}`);
    assert.match(option.description, /screen folder \(sfd_\.\.\.\) and the folders inside it/);
  }
});

test("screen folder create, list, show, update and delete call the folder routes", async () => {
  const configDir = await enrolled("screen-folders-");
  const transport = new FakeTransport()
    .on("GET", "/api/screen-folders", () => json(200, { items: TREE }))
    .on("POST", "/api/screen-folders", (req) => {
      const body = req.body as { name: string; parent_id?: string; default_playlist_id?: string };
      return json(201, folder(CAFES, body.name, body.parent_id ?? null, body.default_playlist_id ? { default_playlist_id: body.default_playlist_id } : {}));
    })
    .on("GET", `/api/screen-folders/${NORTH}`, () => json(200, folder(NORTH, "North", null, { screens: 2, default_playlist_id: PLAYLIST })))
    .on("PATCH", `/api/screen-folders/${NORTH}`, () => json(200, folder(NORTH, "Northern", null)))
    .on("DELETE", `/api/screen-folders/${NORTH}`, () => ({ status: 204, headers: {}, body: undefined }));
  try {
    const listed = await cli(["--json", "screen", "folder", "list"], transport, configDir);
    assert.equal(listed.code, ExitCode.Success, listed.stdout);
    assert.equal(listed.envelope.data.items.length, 4);
    assert.equal(transport.calls.at(-1)?.path, "/api/screen-folders");

    const shown = await cli(["--human", "screen", "folder", "show", NORTH], transport, configDir);
    assert.equal(shown.code, ExitCode.Success, shown.stdout);
    assert.match(shown.stdout, /^Screen folder$/m);
    assert.match(shown.stdout, new RegExp(`^id: ${NORTH}$`, "m"));
    assert.match(shown.stdout, /^parent_id: \(project root\)$/m);
    assert.match(shown.stdout, new RegExp(`^default_playlist_id: ${PLAYLIST}$`, "m"));
    assert.match(shown.stdout, /^screens: 2$/m);

    const root = await cli(["--json", "screen", "folder", "create", "--name", "  Stores  "], transport, configDir);
    assert.equal(root.code, ExitCode.Success, root.stdout);
    assert.deepEqual(transport.calls.filter((call) => call.method === "POST").at(-1)?.body, { name: "Stores" });

    const nested = await cli(["--json", "screen", "folder", "create", "--name", "Cafes", "--parent", NORTH, "--default-playlist-id", PLAYLIST], transport, configDir);
    assert.equal(nested.code, ExitCode.Success, nested.stdout);
    const created = transport.calls.filter((call) => call.method === "POST").at(-1);
    assert.deepEqual(created?.body, { name: "Cafes", parent_id: NORTH, default_playlist_id: PLAYLIST });
    assert.ok(created?.headers?.["idempotency-key"]);
    assert.equal(nested.envelope.data.id, CAFES);

    const patches: Array<Record<string, unknown>> = [];
    const update = async (...flags: string[]) => {
      const result = await cli(["--json", "screen", "folder", "update", NORTH, ...flags], transport, configDir);
      assert.equal(result.code, ExitCode.Success, `${flags.join(" ")}: ${result.stdout}`);
      const patch = transport.calls.filter((call) => call.method === "PATCH").at(-1)!;
      patches.push(patch.body as Record<string, unknown>);
      return patch;
    };
    const renamed = await update("--name", "Northern", "--expect-rev", "1");
    assert.equal(renamed.headers?.["if-match"], '"1"');
    assert.ok(renamed.headers?.["idempotency-key"]);
    await update("--parent", SOUTH);
    await update("--root");
    await update("--default-playlist-id", PLAYLIST);
    await update("--clear-default");
    await update("--name", "Everything", "--parent", SOUTH, "--default-playlist-id", PLAYLIST);
    assert.deepEqual(patches, [
      { name: "Northern" }, { parent_id: SOUTH }, { parent_id: null }, { default_playlist_id: PLAYLIST }, { default_playlist_id: null },
      { name: "Everything", parent_id: SOUTH, default_playlist_id: PLAYLIST },
    ]);

    const deleted = await cli(["--json", "screen", "folder", "delete", NORTH, "--expect-rev", "2"], transport, configDir);
    assert.equal(deleted.code, ExitCode.Success, deleted.stdout);
    assert.equal(transport.calls.filter((call) => call.method === "DELETE").at(-1)?.headers?.["if-match"], '"2"');
    assert.deepEqual(deleted.envelope.data, { id: NORTH, deleted: true });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen folder commands refuse a bad id, name or empty update before any request", async () => {
  const configDir = await enrolled("screen-folders-usage-");
  const transport = new FakeTransport();
  try {
    for (const argv of [
      ["screen", "folder", "show", "North"],
      ["screen", "folder", "show", MEDIA_FOLDER],
      ["screen", "folder", "delete", A],
      ["screen", "folder", "create"],
      ["screen", "folder", "create", "--name", "   "],
      ["screen", "folder", "create", "--name", ".."],
      ["screen", "folder", "create", "--name", "x".repeat(101)],
      ["screen", "folder", "create", "--name", "Cafes", "--parent", "North"],
      ["screen", "folder", "create", "--name", "Cafes", "--default-playlist-id", A],
      ["screen", "folder", "update", NORTH],
      ["screen", "folder", "update", NORTH, "--expect-rev", "1"],
      ["screen", "folder", "update", NORTH, "--parent", SOUTH, "--root"],
      ["screen", "folder", "update", NORTH, "--default-playlist-id", PLAYLIST, "--clear-default"],
      ["screen", "folder", "update", NORTH, "--default-playlist-id", "nope"],
      ["screen", "folder", "update", NORTH, "--name", "x", "--expect-rev", "zero"],
    ]) {
      const result = await cli(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen folder list prints the tree with paths, ids, screen counts and default playlists", async () => {
  const configDir = await enrolled("screen-folders-tree-");
  const transport = new FakeTransport().on("GET", "/api/screen-folders", () => json(200, { items: TREE }));
  const empty = new FakeTransport().on("GET", "/api/screen-folders", () => json(200, { items: [] }));
  try {
    const human = await cli(["--human", "screen", "folder", "list"], transport, configDir);
    assert.equal(human.code, ExitCode.Success, human.stdout);
    const lines = human.stdout.split("\n");
    assert.equal(lines[0], "Screen folders (4)");
    assert.match(lines[1]!, /^PATH\s+ID\s+SCREENS\s+DEFAULT_PLAYLIST$/);
    assert.deepEqual(lines.slice(2, 6).map((line) => line.trim().split(/\s+/)), [
      ["North", NORTH, "2", PLAYLIST],
      ["North/Cafes", CAFES, "5"],
      ["North/Cafes/Patio", PATIO, "0"],
      ["South", SOUTH, "1"],
    ]);
    const none = await cli(["--human", "screen", "folder", "list"], empty, configDir);
    assert.equal(none.stdout.trim(), "No screen folders");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen folder update prints the levels gained and lost, and the JSON envelope carries them", async () => {
  const configDir = await enrolled("screen-folders-levels-");
  const levels = {
    gained: [{ source: "campaign", id: CAMPAIGN, name: "Spring menu", playlist_id: PLAYLIST, screens: 3 }],
    lost: [{ source: "folder", id: SOUTH, name: "South", playlist_id: PLAYLIST, screens: 1 }],
  };
  const transport = new FakeTransport().on("PATCH", `/api/screen-folders/${CAFES}`, () => json(200, folder(CAFES, "Cafes", SOUTH, { levels })));
  try {
    const human = await cli(["--human", "screen", "folder", "update", CAFES, "--parent", SOUTH], transport, configDir);
    assert.equal(human.code, ExitCode.Success, human.stdout);
    assert.match(human.stdout, new RegExp(`^Updated screen folder ${CAFES}\\.`, "m"));
    assert.match(human.stdout, /^Levels gained:$/m);
    assert.match(human.stdout, new RegExp(`^  campaign ${CAMPAIGN} "Spring menu": playlist ${PLAYLIST}, 3 screens$`, "m"));
    assert.match(human.stdout, /^Levels lost:$/m);
    assert.match(human.stdout, new RegExp(`^  folder ${SOUTH} "South": default playlist ${PLAYLIST}, 1 screen$`, "m"));
    const machine = await cli(["--json", "screen", "folder", "update", CAFES, "--parent", SOUTH], transport, configDir);
    assert.deepEqual(machine.envelope.data.levels, levels);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen folder problems point to the command that fixes them", async () => {
  const configDir = await enrolled("screen-folders-problems-");
  const transport = new FakeTransport()
    .on("GET", `/api/screen-folders/${NORTH}`, () => problem(404, "not_found", "screen folder not found"))
    .on("DELETE", `/api/screen-folders/${CAFES}`, () => problem(409, "resource_conflict", "a campaign audience names this folder"))
    .on("POST", "/api/screen-folders", () => problem(409, "resource_conflict", "a sibling folder has this name"))
    .on("PATCH", `/api/screen-folders/${SOUTH}`, () => problem(412, "revision_conflict", "stale"));
  try {
    const missing = await cli(["--json", "screen", "folder", "show", NORTH], transport, configDir);
    assert.equal(missing.code, ExitCode.NotFound);
    assert.equal(missing.envelope.error?.next?.command, "screenrig screen folder list");
    const refused = await cli(["--json", "screen", "folder", "delete", CAFES], transport, configDir);
    assert.equal(refused.code, ExitCode.Conflict);
    assert.equal(refused.envelope.error?.next?.command, "screenrig campaign list");
    const duplicate = await cli(["--json", "screen", "folder", "create", "--name", "North"], transport, configDir);
    assert.equal(duplicate.code, ExitCode.Conflict);
    assert.equal(duplicate.envelope.error?.next?.command, "screenrig screen folder list");
    const stale = await cli(["--json", "screen", "folder", "update", SOUTH, "--name", "Far", "--expect-rev", "1"], transport, configDir);
    assert.equal(stale.code, ExitCode.Precondition);
    assert.equal(stale.envelope.error?.next?.command, `screenrig screen folder show ${SOUTH}`);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen move sends screens and folders by prefix to a folder or the project root and prints the levels", async () => {
  const configDir = await enrolled("screen-move-");
  const levels = { gained: [{ source: "folder", id: NORTH, name: "North", playlist_id: PLAYLIST, screens: 2 }], lost: [] };
  const transport = new FakeTransport().on("POST", "/api/screens/move", () => json(200, { screens: 2, folders: 1, levels }));
  try {
    const into = await cli(["--json", "screen", "move", A, B, CAFES, "--folder", NORTH], transport, configDir);
    assert.equal(into.code, ExitCode.Success, into.stdout);
    const call = transport.calls.at(-1);
    assert.deepEqual(call?.body, { folder_id: NORTH, screen_ids: [A, B], folder_ids: [CAFES] });
    assert.ok(call?.headers?.["idempotency-key"]);
    assert.deepEqual(into.envelope.data, { screens: 2, folders: 1, levels });

    const toRoot = await cli(["--json", "screen", "move", A, "--root"], transport, configDir);
    assert.equal(toRoot.code, ExitCode.Success, toRoot.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { folder_id: null, screen_ids: [A] });

    const foldersOnly = await cli(["--json", "screen", "move", CAFES, PATIO, "--folder", SOUTH], transport, configDir);
    assert.equal(foldersOnly.code, ExitCode.Success, foldersOnly.stdout);
    assert.deepEqual(transport.calls.at(-1)?.body, { folder_id: SOUTH, folder_ids: [CAFES, PATIO] });

    const human = await cli(["--human", "screen", "move", A, B, CAFES, "--folder", NORTH], transport, configDir);
    assert.match(human.stdout, new RegExp(`^Moved 2 screens and 1 folder into ${NORTH}\\.$`, "m"));
    assert.match(human.stdout, /^Levels gained:$/m);
    assert.match(human.stdout, new RegExp(`^  folder ${NORTH} "North": default playlist ${PLAYLIST}, 2 screens$`, "m"));
    assert.doesNotMatch(human.stdout, /Levels lost/);
    const rootHuman = await cli(["--human", "screen", "move", A, "--root"], new FakeTransport().on("POST", "/api/screens/move", () => json(200, { screens: 0, folders: 0, levels: { gained: [], lost: [] } })), configDir);
    assert.match(rootHuman.stdout, /^Moved 0 screens and 0 folders to the project root\.$/m);
    assert.match(rootHuman.stdout, /^No levels gained or lost/m);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen move refuses a missing or double destination, odd or repeated ids and too many ids before any request", async () => {
  const configDir = await enrolled("screen-move-usage-");
  const transport = new FakeTransport();
  const many = Array.from({ length: 1001 }, (_, index) => `scr_${String(index).padStart(8, "0")}`);
  try {
    for (const argv of [
      ["screen", "move", A],
      ["screen", "move", A, "--folder", NORTH, "--root"],
      ["screen", "move", "--folder", NORTH],
      ["screen", "move", "poster.png", "--folder", NORTH],
      ["screen", "move", MEDIA_FOLDER, "--folder", NORTH],
      ["screen", "move", A, "--folder", "North"],
      ["screen", "move", A, "--folder", MEDIA_FOLDER],
      ["screen", "move", A, A, "--folder", NORTH],
      ["screen", "move", NORTH, "--folder", NORTH],
      ["screen", "move", ...many, "--folder", NORTH],
    ]) {
      const result = await cli(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Usage, `${argv.slice(0, 6).join(" ")}: ${result.stdout}`);
    }
    assert.equal(transport.calls.length, 0);
    const exactly = await cli(["--json", "screen", "move", A], transport, configDir);
    assert.match(exactly.envelope.error?.detail ?? "", /exactly one of --folder or --root/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen list --folder sends the folder, accepts root, refuses a bad id, and adds a FOLDER column", async () => {
  const configDir = await enrolled("screen-list-folder-");
  const transport = new FakeTransport().on("GET", "/api/screens", (req) => json(200, {
    items: req.query?.folder === NORTH ? [screen(A, { folder_id: NORTH })] : req.query?.folder === "root" ? [screen(B)] : [screen(A, { folder_id: NORTH }), screen(B)],
    next_cursor: null,
  }));
  try {
    const list = async (...folder: string[]) => {
      const result = await cli(["--json", "screen", "list", ...folder], transport, configDir);
      assert.equal(result.code, ExitCode.Success, result.stdout);
      return result.envelope.data.items.map((item: { id: string }) => item.id);
    };
    assert.deepEqual(await list("--folder", NORTH), [A]);
    assert.equal(transport.calls.at(-1)?.query?.folder, NORTH);
    assert.deepEqual(await list("--folder", "root"), [B]);
    assert.equal(transport.calls.at(-1)?.query?.folder, "root");
    assert.equal((await list()).length, 2);
    assert.equal(transport.calls.at(-1)?.query?.folder, undefined);

    const human = await cli(["--human", "screen", "list"], transport, configDir);
    assert.match(human.stdout, /^ID\s+LABEL\s+STATE\s+FOLDER$/m);
    assert.match(human.stdout, new RegExp(`^${A}\\s+AAAA\\s+active\\s+${NORTH}$`, "m"));
    const rootOnly = await cli(["--human", "screen", "list", "--folder", "root"], transport, configDir);
    assert.doesNotMatch(rootOnly.stdout, /FOLDER/);

    transport.calls.length = 0;
    for (const bad of ["North", MEDIA_FOLDER, "Root"]) {
      const refused = await cli(["--json", "screen", "list", "--folder", bad], transport, configDir);
      assert.equal(refused.code, ExitCode.Usage, bad);
    }
    assert.equal(transport.calls.length, 0);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("--folder selects a fleet like --tag and is refused with ids, a tag or a malformed id", async () => {
  const configDir = await enrolled("screen-fleet-folder-");
  const transport = new FakeTransport().on("POST", "/api/screens/actions", (req) => {
    const body = req.body as { action: { type: string }; selector: { by: string } };
    return json(200, { action: body.action.type, matched: 2, succeeded: 2, failed: 0, results: [
      { screen_id: A, status: "ok", revision: 4 }, { screen_id: B, status: "ok", revision: 4 },
    ] });
  });
  const actions = () => transport.calls.filter((call) => call.path === "/api/screens/actions");
  try {
    const assigned = await cli(["--json", "screen", "assign", "--folder", NORTH, "--playlist-id", PLAYLIST], transport, configDir);
    assert.equal(assigned.code, ExitCode.Success, assigned.stdout);
    assert.deepEqual(actions().at(-1)?.body, { selector: { by: "folder", folder_id: NORTH }, action: { type: "assign", playlist_id: PLAYLIST } });
    assert.equal(assigned.envelope.data.matched, 2);

    for (const [argv, action] of [
      [["screen", "reload", "--folder", NORTH], { type: "reload" }],
      [["screen", "tag", "--folder", NORTH, "--add", "Spring"], { type: "add_tags", tags: ["Spring"] }],
      [["screen", "toast", "--folder", NORTH, "--text", "Closing soon"], { type: "toast", level: "info", text: "Closing soon" }],
      [["screen", "takeover", "--folder", NORTH, "--playlist-id", PLAYLIST, "--until", "none"], { type: "takeover", playlist_id: PLAYLIST, until: null }],
      [["screen", "takeover", "clear", "--folder", NORTH], { type: "takeover_clear" }],
      [["screen", "display", "--folder", NORTH, "--power", "off"], { type: "display", power: "off" }],
      [["screen", "display", "clear", "--folder", NORTH], { type: "display_clear" }],
      [["screen", "reboot", "--folder", NORTH, "--yes"], { type: "reboot" }],
    ] as Array<[string[], Record<string, unknown>]>) {
      const result = await cli(["--json", ...argv], transport, configDir);
      assert.equal(result.code, ExitCode.Success, `${argv.join(" ")}: ${result.stdout}`);
      const body = actions().at(-1)?.body as { selector: unknown; action: Record<string, unknown> };
      assert.deepEqual(body.selector, { by: "folder", folder_id: NORTH }, argv.join(" "));
      assert.deepEqual(body.action, action, argv.join(" "));
    }

    const reboot = await cli(["--json", "screen", "reboot", "--folder", NORTH], transport, configDir);
    assert.equal(reboot.code, ExitCode.Usage);
    assert.equal(reboot.envelope.error?.next?.command, `screenrig screen reboot --folder ${NORTH} --yes`);

    const before = transport.calls.length;
    for (const [argv, detail] of [
      [["screen", "assign", A, "--folder", NORTH, "--playlist-id", PLAYLIST], /screen ids, --tag TAG or --folder ID; give only one/],
      [["screen", "assign", "--tag", "Lobby", "--folder", NORTH, "--playlist-id", PLAYLIST], /--folder cannot be used with --tag/],
      [["screen", "assign", "--folder", "North", "--playlist-id", PLAYLIST], /--folder must be a screen folder ID \(sfd_/],
      [["screen", "assign", "--folder", MEDIA_FOLDER, "--playlist-id", PLAYLIST], /--folder must be a screen folder ID \(sfd_/],
      [["screen", "assign", "--playlist-id", PLAYLIST], /requires <id>, --tag TAG or --folder ID/],
      [["screen", "toast", "--text", "Hi"], /requires <id>, --tag TAG or --folder ID/],
      [["screen", "toast"], /requires <id>, --tag TAG or --folder ID, and --text/],
      [["screen", "reload", "--folder", NORTH, "--expect-rev", "2"], /does not take --expect-rev/],
    ] as Array<[string[], RegExp]>) {
      const refused = await cli(["--json", ...argv], transport, configDir);
      assert.equal(refused.code, ExitCode.Usage, `${argv.join(" ")}: ${refused.stdout}`);
      assert.match(refused.envelope.error?.detail ?? "", detail, argv.join(" "));
    }
    assert.equal(transport.calls.length, before, "a refused selector sends no request");
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen screenshot --folder captures the active screens of the folder and every folder inside it", async () => {
  const configDir = await enrolled("screen-shot-folder-");
  const image = Uint8Array.from(Buffer.from("PIXELS_MUST_NOT_PRINT", "utf8"));
  const imageSha256 = createHash("sha256").update(image).digest("hex");
  const members = new Map<string, Array<Record<string, unknown>>>([
    [NORTH, [screen(A, { folder_id: NORTH })]],
    [CAFES, [screen(B, { folder_id: CAFES }), screen(C, { folder_id: CAFES, state: "pairing_pending" })]],
    [PATIO, []],
  ]);
  const transport = new FakeTransport()
    .on("GET", `/api/screen-folders/${NORTH}`, () => json(200, folder(NORTH, "North", null)))
    .on("GET", "/api/screen-folders", () => json(200, { items: TREE }))
    .on("GET", "/api/screens", (req) => json(200, { items: members.get(req.query?.folder ?? "") ?? [], next_cursor: null }))
    .on("POST", /^\/api\/screens\/[^/]+\/screenshot$/, () => ({ status: 202, headers: {}, body: { capture_id: "shot_AAAAAAAAAAAAAAAA", expires_at: "2026-10-29T17:00:30.000Z" } }))
    .on("GET", /^\/api\/screens\/[^/]+\/screenshot\/status$/, () => ({ status: 200, headers: {}, body: { state: "ready", capture_id: "shot_AAAAAAAAAAAAAAAA", bytes: image.byteLength, sha256: imageSha256, width: 480, height: 270 } }))
    .on("GET", /^\/api\/screens\/[^/]+\/screenshot$/, () => ({ status: 200, headers: { "content-type": "image/webp", "content-length": String(image.byteLength) }, body: image }));
  try {
    const result = await cli(["--json", "screen", "screenshot", "--folder", NORTH, "--output", "shots"], transport, configDir);
    const data = result.envelope.data;
    assert.deepEqual(data.selector, { by: "folder", folder_id: NORTH });
    assert.equal(data.action, "screenshot");
    assert.deepEqual(data.results.map((item: { screen_id: string }) => item.screen_id), [A, B], "pairing_pending screens are skipped like the fleet selector");
    const reads = transport.calls.filter((call) => call.method === "GET" && (call.path === "/api/screens" || call.path.startsWith("/api/screen-folders")));
    assert.deepEqual(reads.map((call) => call.query?.folder ?? call.path), [`/api/screen-folders/${NORTH}`, "/api/screen-folders", NORTH, CAFES, PATIO]);
    assert.deepEqual(data.results.map((item: { status: string }) => item.status), ["ok", "ok"]);
    assert.equal(new Set(data.results.map((item: { path: string }) => item.path)).size, 2);
    assert.ok(!result.stdout.includes("PIXELS_MUST_NOT_PRINT"));
    assert.equal(transport.calls.some((call) => call.path === "/api/screens/actions"), false);
    assert.deepEqual((await readdir(path.join(configDir, "shots"))).sort(), [`${A}.webp`, `${B}.webp`]);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test("screen show names the folder, and the folder default reads as an effective playlist source", async () => {
  const configDir = await enrolled("screen-show-folder-");
  const transport = new FakeTransport().on("GET", `/api/screens/${A}`, () => json(200, screen(A, {
    folder_id: CAFES, effective_playlist: { id: PLAYLIST, source: "folder", entry_id: NORTH },
  })));
  try {
    const human = await cli(["--human", "screen", "show", A], transport, configDir);
    assert.equal(human.code, ExitCode.Success, human.stdout);
    assert.match(human.stdout, new RegExp(`^Folder: ${CAFES} \\(screen folder show ${CAFES}\\)$`, "m"));
    assert.match(human.stdout, new RegExp(`^Assigned: ${PLAYLIST} \\(folder ${NORTH} default\\)$`, "m"));
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
  assert.equal(effectivePlaylistText({ id: PLAYLIST, source: "folder" }), `${PLAYLIST} (folder default)`);
  assert.equal(effectivePlaylistText({ id: PLAYLIST, source: "folder", entry_id: NORTH, until: "2026-10-29T18:00:00Z" }), `${PLAYLIST} (folder ${NORTH} default, a campaign or schedule changes it until 2026-10-29 18:00 UTC)`);
  assert.equal(effectivePlaylistText({ id: PLAYLIST, source: "default" }), `${PLAYLIST} (default)`);
});

test("folder rows, subtrees, names, levels and project routing", () => {
  assert.deepEqual(folderRows(TREE).map((row) => row.path), ["North", "North/Cafes", "North/Cafes/Patio", "South"]);
  // A folder whose parent is missing from the list is a root; a cycle is still listed.
  assert.deepEqual(folderRows([folder("sfd_ORPHAN", "Orphan", "sfd_GONE")] as unknown as ScreenFolder[]).map((row) => row.path), ["Orphan"]);
  assert.equal(folderRows([folder("sfd_ONE", "One", "sfd_TWO"), folder("sfd_TWO", "Two", "sfd_ONE")] as unknown as ScreenFolder[]).length, 2);
  assert.deepEqual(folderSubtree(TREE, NORTH), [NORTH, CAFES, PATIO]);
  assert.deepEqual(folderSubtree(TREE, PATIO), [PATIO]);
  assert.deepEqual(folderSubtree(TREE, "sfd_ELSEWHERE"), ["sfd_ELSEWHERE"]);
  assert.equal(folderListLines([folder(NORTH, "Bad\u0007Name", null)] as unknown as ScreenFolder[])[2]!.startsWith("Bad Name"), true, "control characters never reach a row");

  assert.equal(screenFolderName("  North  "), "North");
  for (const bad of ["", "  ", ".", "..", "x".repeat(101), "Bad\u0007"]) assert.throws(() => screenFolderName(bad), /1 to 100 characters/, JSON.stringify(bad));
  assert.equal(screenFolderName("é".repeat(100)).length, 100);

  assert.deepEqual(levelsLines(undefined), []);
  assert.deepEqual(levelsLines({ gained: [], lost: [] }), ["No levels gained or lost: no campaign or folder default playlist changed for these screens."]);

  assert.deepEqual(screenTarget({ command: ["screen", "assign"], positionals: ["screen", "assign"], flags: { folder: NORTH } }, "screen assign"), { kind: "fleet", selector: { by: "folder", folder_id: NORTH } });

  const list: { method: "GET"; path: string; query?: Record<string, string | undefined> } = { method: "GET", path: "/api/screen-folders" };
  assert.deepEqual(projectRequest(list, "prj_X").query, { project: "prj_X" });
  assert.equal(projectRequest({ method: "POST", path: "/api/screen-folders" }, "prj_X").path, "/api/projects/prj_X/screen-folders");
  assert.equal(projectRequest({ method: "POST", path: "/api/screens/move" }, "prj_X").path, "/api/projects/prj_X/screens/move");
  assert.equal(projectRequest({ method: "PATCH", path: `/api/screen-folders/${NORTH}` }, "prj_X").path, `/api/screen-folders/${NORTH}`, "instance IDs stay global");
});
