import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { editablePlaylist, targetDimensions } from "./playlist-authoring.js";
import { run, processRuntime } from "./main.js";
import { commandHelp } from "./help.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";
import type { TransportRequest, TransportResponse } from "./transport/types.js";
import { wallCanvas, wallOutputs } from "./screen-wall.js";

const SCREEN = "scr_WALLAAAAAAAAAAAAAAAAAAA";

interface Result { code: number; stdout: string; stderr: string; body: any }

async function fixture(prefix: string) {
  const dir = await testTemp(prefix);
  const config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token",
  }), { mode: 0o600 });
  const invoke = async (transport: FakeTransport, argv: string[]): Promise<Result> => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const chunks: Buffer[] = [], errors: Buffer[] = [];
    stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stderr.on("data", (chunk) => errors.push(Buffer.from(chunk)));
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], env: {}, cwd: () => dir, transport, stdout, stderr });
    const text = Buffer.concat(chunks).toString("utf8");
    let body: any;
    try { body = JSON.parse(text); } catch { /* human output */ }
    return { code, stdout: text, stderr: Buffer.concat(errors).toString("utf8"), body };
  };
  return { dir, invoke, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A screen route that answers every PATCH with the wall it was given (null clears it). */
function wallTransport(patches: TransportRequest[]): FakeTransport {
  return new FakeTransport().on("PATCH", `/api/screens/${SCREEN}`, (request): TransportResponse => {
    patches.push(request);
    const { wall } = request.body as { wall?: unknown };
    return { status: 200, headers: {}, body: { id: SCREEN, label: "Wall", revision: 5, ...(wall ? { wall } : {}) } };
  });
}

test("screen wall set patches only the wall and carries the revision", async (t) => {
  const { invoke, cleanup } = await fixture("wall-set-"); t.after(cleanup);
  const patches: TransportRequest[] = [];
  const transport = wallTransport(patches);
  const result = await invoke(transport, ["--json", "screen", "wall", "set", SCREEN, "--outputs", "HDMI-A-1,HDMI-A-2,DP-1", "--arrangement", "column", "--rotation", "90", "--expect-rev", "4"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.method, "PATCH");
  assert.deepEqual(patches[0]!.body, { wall: { outputs: ["HDMI-A-1", "HDMI-A-2", "DP-1"], arrangement: "column", rotation: 90 } });
  assert.equal(patches[0]!.headers?.["if-match"], '"4"');
  assert.deepEqual(result.body.data.wall, { outputs: ["HDMI-A-1", "HDMI-A-2", "DP-1"], arrangement: "column", rotation: 90 });
  assert.equal(result.body.data.revision, 5);
});

test("screen wall set without --rotation or --expect-rev sends neither", async (t) => {
  const { invoke, cleanup } = await fixture("wall-set-min-"); t.after(cleanup);
  const patches: TransportRequest[] = [];
  const result = await invoke(wallTransport(patches), ["--json", "screen", "wall", "set", SCREEN, "--outputs", " DP-1 , DP-2 ", "--arrangement", "row"]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(patches[0]!.body, { wall: { outputs: ["DP-1", "DP-2"], arrangement: "row" } });
  assert.equal(patches[0]!.headers?.["if-match"], undefined);
  for (const rotation of ["0", "180", "270"]) {
    assert.equal((await invoke(wallTransport(patches), ["--json", "screen", "wall", "set", SCREEN, "--outputs", "A,B", "--arrangement", "row", "--rotation", rotation])).code, 0);
    assert.equal((patches.at(-1)!.body as { wall: { rotation: number } }).wall.rotation, Number(rotation));
  }
});

test("screen wall set says what it set in human output", async (t) => {
  const { invoke, cleanup } = await fixture("wall-set-human-"); t.after(cleanup);
  const result = await invoke(wallTransport([]), ["--human", "screen", "wall", "set", SCREEN, "--outputs", "DP-1,DP-2", "--arrangement", "row", "--rotation", "270"]);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, new RegExp(`Set video wall on ${SCREEN}: DP-1, DP-2 \\(row, rotation 270\\)`));
  assert.match(result.stdout, /20 seconds/);
  assert.match(result.stdout, /revision: 5/);
  const grid = await invoke(wallTransport([]), ["--human", "screen", "wall", "set", SCREEN, "--outputs", "A,B,C,D", "--arrangement", "grid", "--columns", "2"]);
  assert.equal(grid.code, 0, grid.stdout);
  assert.match(grid.stdout, new RegExp(`Set video wall on ${SCREEN}: A, B, C, D \\(grid, 2 columns, rotation 0\\)`));
});

test("screen wall set sends a grid's columns and up to twelve outputs", async (t) => {
  const { invoke, cleanup } = await fixture("wall-set-grid-"); t.after(cleanup);
  const patches: TransportRequest[] = [];
  const outputs = Array.from({ length: 12 }, (_, index) => `DP-${index + 1}`);
  const result = await invoke(wallTransport(patches), ["--json", "screen", "wall", "set", SCREEN, "--outputs", outputs.join(","), "--arrangement", "grid", "--columns", "4", "--rotation", "90"]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(patches[0]!.body, { wall: { outputs, arrangement: "grid", columns: 4, rotation: 90 } });
  assert.deepEqual(result.body.data.wall, { outputs, arrangement: "grid", columns: 4, rotation: 90 });
  // The server decides where columns belong: it is sent as given beside a row, and answers the problem.
  const row = await invoke(new FakeTransport().on("PATCH", `/api/screens/${SCREEN}`, (request): TransportResponse => {
    patches.push(request);
    return {
      status: 400, headers: { "content-type": "application/problem+json" },
      body: { type: "https://screenrig.ai/problems/invalid-request", title: "Invalid request", status: 400, code: "invalid_request", detail: "wall.columns is only for arrangement grid" },
    };
  }), ["--json", "screen", "wall", "set", SCREEN, "--outputs", "A,B", "--arrangement", "row", "--columns", "2"]);
  assert.deepEqual(patches.at(-1)!.body, { wall: { outputs: ["A", "B"], arrangement: "row", columns: 2 } });
  assert.equal(row.body.error.code, "invalid_request");
});

test("screen wall clear patches wall null", async (t) => {
  const { invoke, cleanup } = await fixture("wall-clear-"); t.after(cleanup);
  const patches: TransportRequest[] = [];
  const transport = wallTransport(patches);
  const result = await invoke(transport, ["--json", "screen", "wall", "clear", SCREEN, "--expect-rev", "5"]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(patches[0]!.body, { wall: null });
  assert.equal(patches[0]!.headers?.["if-match"], '"5"');
  assert.equal(result.body.data.wall, undefined);
  const human = await invoke(wallTransport(patches), ["--human", "screen", "wall", "clear", SCREEN]);
  assert.equal(human.code, 0, human.stdout);
  assert.match(human.stdout, new RegExp(`Cleared the video wall on ${SCREEN}`));
  assert.deepEqual(patches.at(-1)!.body, { wall: null });
  assert.equal(patches.at(-1)!.headers?.["if-match"], undefined);
});

test("screen wall validation errors are usage errors that send nothing", async (t) => {
  const { invoke, cleanup } = await fixture("wall-usage-"); t.after(cleanup);
  const patches: TransportRequest[] = [];
  const transport = wallTransport(patches);
  const cases: Array<[string[], RegExp]> = [
    [["set", SCREEN, "--outputs", "HDMI-A-1", "--arrangement", "row"], /--outputs takes 2 to 12 comma-separated output names/],
    [["set", SCREEN, "--outputs", "A,B,C,D,E,F,G,H,I,J,K,L,M", "--arrangement", "row"], /--outputs takes 2 to 12 comma-separated output names/],
    [["set", SCREEN, "--outputs", "A,A", "--arrangement", "row"], /--outputs lists an output more than once/],
    [["set", SCREEN, "--outputs", "A,B C", "--arrangement", "row"], /1 to 64 letters, digits, dots, underscores or dashes/],
    [["set", SCREEN, "--outputs", "A,", "--arrangement", "row"], /1 to 64 letters, digits, dots, underscores or dashes/],
    [["set", SCREEN, "--outputs", `A,${"x".repeat(65)}`, "--arrangement", "row"], /1 to 64 letters, digits, dots, underscores or dashes/],
    [["set", SCREEN, "--outputs", "A,B", "--arrangement", "diagonal"], /--arrangement must be row, column, or grid/],
    [["set", SCREEN, "--outputs", "A,B,C,D", "--arrangement", "grid", "--columns", "two"], /--columns requires a nonnegative whole number/],
    [["set", SCREEN, "--outputs", "A,B,C,D", "--arrangement", "grid", "--columns", "0"], /--columns must be greater than zero/],
    [["set", SCREEN, "--outputs", "A,B", "--arrangement", "row", "--rotation", "45"], /--rotation must be 0, 90, 180, or 270/],
    [["set", SCREEN, "--arrangement", "row"], /screen wall set requires .*--outputs/],
    [["set", SCREEN, "--outputs", "A,B"], /screen wall set requires .*--arrangement/],
    [["set", "--outputs", "A,B", "--arrangement", "row"], /screen wall set requires <id>/],
    [["clear"], /screen wall clear requires <id>/],
  ];
  for (const [argv, detail] of cases) {
    const result = await invoke(transport, ["--json", "screen", "wall", ...argv]);
    assert.equal(result.code, 2, `${argv.join(" ")}: ${result.stdout}`);
    assert.equal(result.body.error.code, "usage_error", argv.join(" "));
    assert.match(result.body.error.detail, detail, argv.join(" "));
  }
  assert.equal(patches.length, 0);
  assert.equal(transport.calls.length, 0);
});

test("wall_unsupported tells the agent to check the Player's host capabilities", async (t) => {
  const { invoke, cleanup } = await fixture("wall-unsupported-"); t.after(cleanup);
  const transport = new FakeTransport().on("PATCH", `/api/screens/${SCREEN}`, () => ({
    status: 409, headers: { "content-type": "application/problem+json" },
    body: { type: "https://screenrig.ai/problems/wall-unsupported", title: "Wall unsupported", status: 409, code: "wall_unsupported", detail: "The screen's Player did not declare display.wall." },
  }));
  const result = await invoke(transport, ["--json", "screen", "wall", "set", SCREEN, "--outputs", "A,B", "--arrangement", "row"]);
  assert.equal(result.code, 5, result.stdout);
  assert.equal(result.body.error.code, "wall_unsupported");
  assert.match(result.body.error.detail, /Linux Player's kiosk install \(cage and wlr-randr\) or the Windows Player/);
  assert.equal(result.body.error.next.command, `screenrig screen show ${SCREEN}`);
});

test("screen wall help states the contract and carries examples", () => {
  const set = commandHelp(["screen", "wall", "set"], true);
  assert.deepEqual(set.options.filter((option) => option.required).map((option) => option.name).sort(), ["--arrangement", "--outputs"]);
  assert.ok(set.examples.every((example: string) => example.startsWith("screenrig screen wall set ")));
  assert.equal(set.examples.length, 3);
  assert.ok(set.options.some((option) => option.name === "--columns" && !option.required));
  const text = set.notes.join("\n");
  for (const phrase of [/observation\.surfaces/, /two to twelve/, /left to right then top to bottom/, /rows of --columns displays/, /fill a rectangle of the wall/, /90 and 270 are portrait/, /wlr-randr/, /Windows Player/, /wall_unsupported/, /20 seconds/, /playlist init --screen-id/]) assert.match(text, phrase);
  assert.deepEqual(commandHelp(["screen", "wall", "clear"], true).examples, [`screenrig screen wall clear scr_SCREEN`, `screenrig screen wall clear scr_SCREEN --expect-rev 5`]);
});

test("wallOutputs and wallCanvas follow ScreenWall", () => {
  assert.deepEqual(wallOutputs("HDMI-A-1,DP-1.2,eDP_1"), ["HDMI-A-1", "DP-1.2", "eDP_1"]);
  assert.equal(wallCanvas(undefined), undefined);
  assert.equal(wallCanvas({ id: "scr_X" }), undefined);
  assert.equal(wallCanvas({ wall: null }), undefined);
  // A row is n tiles wide, a column n tiles high; 90 and 270 turn the tile portrait.
  assert.deepEqual(wallCanvas({ wall: { outputs: ["a", "b"], arrangement: "row" } }), { width: 3840, height: 1080, format: { displays: 2, arrangement: "row", orientation: "landscape" } });
  assert.deepEqual(wallCanvas({ wall: { outputs: ["a", "b", "c"], arrangement: "row", rotation: 0 } }), { width: 5760, height: 1080, format: { displays: 3, arrangement: "row", orientation: "landscape" } });
  assert.deepEqual(wallCanvas({ wall: { outputs: ["a", "b"], arrangement: "column", rotation: 180 } }), { width: 1920, height: 2160, format: { displays: 2, arrangement: "column", orientation: "landscape" } });
  assert.deepEqual(wallCanvas({ wall: { outputs: ["a", "b"], arrangement: "column", rotation: 90 } }), { width: 1080, height: 3840, format: { displays: 2, arrangement: "column", orientation: "portrait" } });
  assert.deepEqual(wallCanvas({ wall: { outputs: ["a", "b", "c"], arrangement: "row", rotation: 270 } }), { width: 3240, height: 1920, format: { displays: 3, arrangement: "row", orientation: "portrait" } });
  assert.throws(() => wallCanvas({ wall: { outputs: ["a"], arrangement: "row" } }), /invalid video wall/);
  assert.throws(() => wallCanvas({ wall: { outputs: ["a", "b"], arrangement: "diagonal" } }), /invalid video wall/);
});

test("wallCanvas lays out up to twelve tiles: C columns by displays / C rows, columns only for a grid", () => {
  const names = (count: number) => Array.from({ length: count }, (_, index) => `o${index + 1}`);
  // 12 landscape displays in a row are 12 tiles wide; the 4 x 3 grid is the spec's 7680 x 3240.
  assert.deepEqual(wallCanvas({ wall: { outputs: names(12), arrangement: "row" } }), { width: 23040, height: 1080, format: { displays: 12, arrangement: "row", orientation: "landscape" } });
  assert.deepEqual(wallCanvas({ wall: { outputs: names(12), arrangement: "column", rotation: 90 } }), { width: 1080, height: 23040, format: { displays: 12, arrangement: "column", orientation: "portrait" } });
  assert.deepEqual(wallCanvas({ wall: { outputs: names(12), arrangement: "grid", columns: 4 } }), { width: 7680, height: 3240, format: { displays: 12, arrangement: "grid", orientation: "landscape", columns: 4 } });
  assert.deepEqual(wallCanvas({ wall: { outputs: names(4), arrangement: "grid", columns: 2, rotation: 0 } }), { width: 3840, height: 2160, format: { displays: 4, arrangement: "grid", orientation: "landscape", columns: 2 } });
  assert.deepEqual(wallCanvas({ wall: { outputs: names(6), arrangement: "grid", columns: 2, rotation: 270 } }), { width: 2160, height: 5760, format: { displays: 6, arrangement: "grid", orientation: "portrait", columns: 2 } });
  assert.deepEqual(wallCanvas({ wall: { outputs: names(6), arrangement: "grid", columns: 3 } }), { width: 5760, height: 2160, format: { displays: 6, arrangement: "grid", orientation: "landscape", columns: 3 } });
  // A row or column never carries columns into the format.
  assert.equal(Object.hasOwn(wallCanvas({ wall: { outputs: names(3), arrangement: "row", columns: 3 } })!.format, "columns"), false);
  assert.throws(() => wallCanvas({ wall: { outputs: names(13), arrangement: "row" } }), /invalid video wall/);
  // A grid holds whole rows: columns is required, at least 2, and divides the displays into at least 2 rows.
  for (const columns of [undefined, 1, 3, 4, 4.5, 6, 12]) {
    assert.throws(() => wallCanvas({ wall: { outputs: names(4), arrangement: "grid", ...(columns === undefined ? {} : { columns }) } }), /invalid video wall/, `columns ${columns}`);
  }
});

test("targetDimensions: a wall beats the reported surfaces, explicit dimensions beat the wall", () => {
  const surfaces = [{ id: "HDMI-A-1", width: 1920, height: 1080 }, { id: "HDMI-A-2", width: 1920, height: 1080 }];
  const screen = { observation: { surfaces }, wall: { outputs: ["HDMI-A-1", "HDMI-A-2"], arrangement: "row" } };
  assert.deepEqual(targetDimensions(screen), { width: 3840, height: 1080, format: { displays: 2, arrangement: "row", orientation: "landscape" } });
  assert.deepEqual(targetDimensions(screen, 1920, 1080), { width: 1920, height: 1080 });
  // Several surfaces without a wall stay ambiguous.
  assert.throws(() => targetDimensions({ observation: { surfaces } }), /unknown or ambiguous/);
});

test("playlist init on a wall screen writes the wall canvas and its format", async (t) => {
  const { dir, invoke, cleanup } = await fixture("wall-init-"); t.after(cleanup);
  let wall: unknown = { outputs: ["HDMI-A-1", "HDMI-A-2", "HDMI-A-3"], arrangement: "row", rotation: 0 };
  const transport = new FakeTransport().on("GET", `/api/screens/${SCREEN}`, () => ({
    status: 200, headers: {}, body: {
      id: SCREEN, revision: 7, ...(wall ? { wall } : {}),
      observation: { observed_at: "2026-10-22T10:00:00Z", surfaces: ["HDMI-A-1", "HDMI-A-2", "HDMI-A-3"].map((id) => ({ id, width: 1920, height: 1080, pixel_ratio: 1, presentation: "output" })) },
    },
  }));
  const prepare = (output: string, ...extra: string[]) =>
    invoke(transport, ["--json", "playlist", "init", "rel_TEST", "https://example.com/board", "--name", "Wall", "--screen-id", SCREEN, "--output", output, ...extra]);
  const read = async (output: string) => JSON.parse(await readFile(path.join(dir, output), "utf8"));

  const row = await prepare("row.json");
  assert.equal(row.code, 0, row.stdout);
  const rowDocument = await read("row.json");
  assert.deepEqual(rowDocument.format, { displays: 3, arrangement: "row", orientation: "landscape" });
  for (const page of rowDocument.pages) {
    assert.deepEqual([page.canvas.width, page.canvas.height], [5760, 1080]);
    assert.deepEqual(page.primitives[0].rect, { x: 0, y: 0, width: 5760, height: 1080 });
  }
  assert.deepEqual(Object.keys(rowDocument), ["name", "format", "pages"]);
  assert.deepEqual([row.body.data.width, row.body.data.height], [5760, 1080]);
  assert.deepEqual(row.body.data.format, rowDocument.format);
  assert.equal(row.body.data.screen_revision, 7);
  assert.deepEqual(row.body.warnings, []);

  wall = { outputs: ["DP-1", "DP-2"], arrangement: "column", rotation: 90 };
  const column = await prepare("column.json");
  assert.equal(column.code, 0, column.stdout);
  const columnDocument = await read("column.json");
  assert.deepEqual(columnDocument.format, { displays: 2, arrangement: "column", orientation: "portrait" });
  assert.deepEqual([columnDocument.pages[0].canvas.width, columnDocument.pages[0].canvas.height], [1080, 3840]);

  wall = { outputs: Array.from({ length: 12 }, (_, index) => `DP-${index + 1}`), arrangement: "grid", columns: 4, rotation: 0 };
  const grid = await prepare("grid.json");
  assert.equal(grid.code, 0, grid.stdout);
  const gridDocument = await read("grid.json");
  assert.deepEqual(gridDocument.format, { displays: 12, arrangement: "grid", orientation: "landscape", columns: 4 });
  assert.deepEqual([gridDocument.pages[0].canvas.width, gridDocument.pages[0].canvas.height], [7680, 3240]);
  assert.deepEqual(gridDocument.pages[0].primitives[0].rect, { x: 0, y: 0, width: 7680, height: 3240 });
  assert.deepEqual([grid.body.data.width, grid.body.data.height], [7680, 3240]);
  assert.deepEqual(grid.body.data.format, gridDocument.format);

  // Explicit dimensions make an ordinary playlist the displays mirror.
  const explicit = await prepare("explicit.json", "--target-width", "1920", "--target-height", "1080");
  assert.equal(explicit.code, 0, explicit.stdout);
  const explicitDocument = await read("explicit.json");
  assert.equal(explicitDocument.format, undefined);
  assert.deepEqual([explicitDocument.pages[0].canvas.width, explicitDocument.pages[0].canvas.height], [1920, 1080]);
  assert.equal(explicit.body.data.format, undefined);

  // No wall: three reported surfaces are still ambiguous, and nothing is written.
  wall = undefined;
  const ambiguous = await prepare("ambiguous.json");
  assert.equal(ambiguous.code, 2, ambiguous.stdout);
  assert.match(ambiguous.body.error.detail, /unknown or ambiguous/);
  await assert.rejects(readFile(path.join(dir, "ambiguous.json")));
  assert.equal(transport.calls.some((call) => call.method !== "GET"), false);
});

test("a wall playlist passes format through create, update, patch and an editable read", async (t) => {
  const { dir, invoke, cleanup } = await fixture("wall-playlist-"); t.after(cleanup);
  const format = { displays: 2, arrangement: "row", orientation: "landscape" };
  const page = {
    id: "page_1", canvas: { width: 3840, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 },
    primitives: [{ id: "board", primitive: "iframe", src: "https://example.com/board", title: "Board", rect: { x: 0, y: 0, width: 3840, height: 1080 }, layer: 0, content_fit: "fill" }],
  };
  await writeFile(path.join(dir, "wall.json"), JSON.stringify({ name: "Wall", format, pages: [page] }));
  const writes: TransportRequest[] = [];
  const answer = (request: TransportRequest): TransportResponse => {
    writes.push(request);
    return { status: 200, headers: {}, body: { id: "pl_WALL", revision: 2, name: "Wall", format, pages: [] } };
  };
  const transport = new FakeTransport()
    .on("POST", "/api/playlists", answer)
    .on("PUT", "/api/playlists/pl_WALL", answer)
    .on("PATCH", "/api/playlists/pl_WALL", answer);
  assert.equal((await invoke(transport, ["--json", "playlist", "create", "wall.json"])).code, 0);
  assert.equal((await invoke(transport, ["--json", "playlist", "update", "pl_WALL", "wall.json"])).code, 0);
  assert.deepEqual(writes.map((request) => (request.body as { format?: unknown }).format), [format, format]);

  await writeFile(path.join(dir, "format.json"), JSON.stringify({ format }));
  assert.equal((await invoke(transport, ["--json", "playlist", "patch", "pl_WALL", "format.json"])).code, 0);
  assert.deepEqual(writes.at(-1)!.body, { format });
  await writeFile(path.join(dir, "clear.json"), JSON.stringify({ format: null }));
  assert.equal((await invoke(transport, ["--json", "playlist", "patch", "pl_WALL", "clear.json"])).code, 0);
  assert.deepEqual(writes.at(-1)!.body, { format: null });
  await writeFile(path.join(dir, "bad.json"), JSON.stringify({ format: "wide" }));
  const bad = await invoke(transport, ["--json", "playlist", "patch", "pl_WALL", "bad.json"]);
  assert.equal(bad.code, 2, bad.stdout);
  assert.match(bad.body.error.detail, /format must be a video wall format object or null/);

  // A mismatched canvas is caught locally from the schema's semantics.
  const wrong = { name: "Wall", format, pages: [{ ...page, canvas: { ...page.canvas, width: 1920 } }] };
  await writeFile(path.join(dir, "wrong.json"), JSON.stringify(wrong));
  const mismatch = await invoke(transport, ["--json", "playlist", "validate", "wrong.json"]);
  assert.equal(mismatch.code, 2, mismatch.stdout);
  assert.deepEqual(mismatch.body.error.errors, [{ path: "/pages/0/canvas", message: "must be 3840 x 1080 canvas units, the canvas of 2 landscape displays in a row" }]);

  // A grid format carries its columns, and its canvas is columns by rows of tiles.
  const gridFormat = { displays: 12, arrangement: "grid", orientation: "landscape", columns: 4 };
  const gridPage = { ...page, canvas: { ...page.canvas, width: 7680, height: 3240 }, primitives: [{ ...page.primitives[0], rect: { x: 0, y: 0, width: 7680, height: 3240 } }] };
  await writeFile(path.join(dir, "grid.json"), JSON.stringify({ name: "Wall", format: gridFormat, pages: [gridPage] }));
  assert.equal((await invoke(transport, ["--json", "playlist", "validate", "grid.json"])).code, 0);
  await writeFile(path.join(dir, "grid-wrong.json"), JSON.stringify({ name: "Wall", format: gridFormat, pages: [{ ...gridPage, canvas: { ...gridPage.canvas, width: 23040, height: 1080 } }] }));
  const gridMismatch = await invoke(transport, ["--json", "playlist", "validate", "grid-wrong.json"]);
  assert.equal(gridMismatch.code, 2, gridMismatch.stdout);
  assert.deepEqual(gridMismatch.body.error.errors.map((error: { path: string }) => error.path), ["/pages/0/canvas"]);
  assert.match(gridMismatch.body.error.errors[0].message, /must be 7680 x 3240 canvas units, the canvas of 12 landscape displays in a 4-column grid/);
  // displays names tiles that fill a rectangle of the grid.
  const placed = (displays: number[]) => ({ name: "Wall", format: gridFormat, pages: [{ ...gridPage, primitives: [{ ...gridPage.primitives[0], displays, rect: undefined }] }] });
  await writeFile(path.join(dir, "rect.json"), JSON.stringify(placed([1, 2, 5, 6])));
  assert.equal((await invoke(transport, ["--json", "playlist", "validate", "rect.json"])).code, 0);
  await writeFile(path.join(dir, "notrect.json"), JSON.stringify(placed([1, 2, 5])));
  const notRect = await invoke(transport, ["--json", "playlist", "validate", "notrect.json"]);
  assert.equal(notRect.code, 2, notRect.stdout);
  assert.match(notRect.body.error.errors[0].message, /must be ascending display numbers that fill a rectangle of the wall/);

  // Reading it back for an edit keeps the format, or the next PUT would drop the wall.
  const read = editablePlaylist({ id: "pl_WALL", revision: 2, name: "Wall", format, pages: [page] });
  assert.deepEqual(read.format, format);
  assert.deepEqual(Object.keys(read), ["name", "format", "pages"]);
  assert.equal(Object.hasOwn(editablePlaylist({ id: "pl_X", revision: 1, name: "Plain", format: null, pages: [page] }), "format"), false);
});
