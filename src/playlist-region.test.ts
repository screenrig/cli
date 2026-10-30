import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { commandHelp } from "./help-tree.js";
import { processRuntime, run } from "./main.js";
import { FakeTransport } from "./transport/fake.js";

async function regionCli(t: TestContext, transport: FakeTransport) {
  const directory = await mkdtemp(path.join(tmpdir(), "playlist-region-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({ api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token" }), { mode: 0o600 });
  return async (argv: string[], input = "") => {
    let output = "";
    const code = await run({ ...processRuntime(), argv: ["--config", config, ...argv], cwd: () => directory, env: {}, transport,
      stdin: Readable.from([input]), isStdinTty: () => false,
      stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    return { code, output };
  };
}

function strip(width: number, height: number, extra: Record<string, unknown> = {}) {
  return {
    name: "Ticker",
    ...extra,
    pages: [{
      id: "headline",
      canvas: { width, height, background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      advance: { mode: "duration", after_ms: 8000 },
      primitives: [{ id: "logo", primitive: "image", selector: { by: "id", media_id: "med_LOGO" }, rect: { x: 0, y: 0, width, height }, layer: 0, content_fit: "contain" }],
    }],
  };
}

function recorder(writes: unknown[]) {
  return new FakeTransport()
    .on("POST", "/api/playlists", request => { writes.push(request.body); return { status: 200, headers: {}, body: { ...(request.body as object), id: "pl_TICKER", revision: 1 } }; })
    .on("PUT", "/api/playlists/pl_TICKER", request => { writes.push(request.body); return { status: 200, headers: {}, body: { ...(request.body as object), id: "pl_TICKER", revision: 2 } }; })
    .on("GET", "/api/playlists/pl_TICKER", () => ({ status: 200, headers: {}, body: { ...strip(1920, 240, { format: { region: "footer", orientation: "landscape" } }), id: "pl_TICKER", revision: 2 } }));
}

test("playlist create and update send a region format from --format-region and --format-orientation", async t => {
  const writes: unknown[] = [];
  const invoke = await regionCli(t, recorder(writes));
  const created = await invoke(["--json", "playlist", "create", "-", "--format-region", "footer", "--format-orientation", "landscape"], JSON.stringify(strip(1920, 240)));
  assert.equal(created.code, 0, created.output);
  assert.deepEqual((writes[0] as { format: unknown }).format, { region: "footer", orientation: "landscape" });
  assert.deepEqual(JSON.parse(created.output).data.format, { region: "footer", orientation: "landscape" });

  const updated = await invoke(["--json", "playlist", "update", "pl_TICKER", "-", "--format-region", "side", "--format-orientation", "portrait"], JSON.stringify(strip(240, 1920, { format: { region: "footer", orientation: "landscape" } })));
  assert.equal(updated.code, 0, updated.output);
  assert.deepEqual((writes[1] as { format: unknown }).format, { region: "side", orientation: "portrait" }, "the flags replace the file's format");

  const shown = await invoke(["--json", "playlist", "show", "pl_TICKER"]);
  assert.deepEqual(JSON.parse(shown.output).data.format, { region: "footer", orientation: "landscape" });
});

test("a strip is checked before anything is written: canvas shape, primitives, soundtrack", async t => {
  const writes: unknown[] = [];
  const invoke = await regionCli(t, recorder(writes));
  const flags = ["--format-region", "header", "--format-orientation", "landscape"];
  const squat = await invoke(["--json", "playlist", "create", "-", ...flags], JSON.stringify(strip(1920, 1080)));
  assert.notEqual(squat.code, 0, squat.output);
  assert.match(squat.output, /header strip's canvas must be wider than tall/);
  const video = strip(1920, 200);
  (video.pages[0]!.primitives[0] as Record<string, unknown>).primitive = "video";
  const withVideo = await invoke(["--json", "playlist", "create", "-", ...flags], JSON.stringify(video));
  assert.notEqual(withVideo.code, 0, withVideo.output);
  const withAudio = await invoke(["--json", "playlist", "create", "-", ...flags], JSON.stringify(strip(1920, 200, { audio: { tracks: [{ id: "bed", media_id: "med_SONG" }] } })));
  assert.notEqual(withAudio.code, 0, withAudio.output);
  assert.deepEqual(writes, []);
});

test("the region flags come as a pair and not with a template or starter", async t => {
  const writes: unknown[] = [];
  const invoke = await regionCli(t, recorder(writes));
  const alone = await invoke(["--json", "playlist", "create", "-", "--format-region", "footer"], JSON.stringify(strip(1920, 240)));
  assert.equal(alone.code, 2, alone.output);
  const orientation = await invoke(["--json", "playlist", "update", "pl_TICKER", "-", "--format-orientation", "landscape"], JSON.stringify(strip(1920, 240)));
  assert.equal(orientation.code, 2, orientation.output);
  const wrong = await invoke(["--json", "playlist", "create", "-", "--format-region", "middle", "--format-orientation", "landscape"], JSON.stringify(strip(1920, 240)));
  assert.equal(wrong.code, 2, wrong.output);
  const starter = await invoke(["--json", "playlist", "create", "--starter", "urgent-notice", "--format-region", "footer", "--format-orientation", "landscape"]);
  assert.equal(starter.code, 2, starter.output);
  assert.deepEqual(writes, []);
});

test("strip help names the flags, the canvas rule and the levels that cover a region", () => {
  for (const name of ["create", "update"]) {
    const help = commandHelp(["playlist", name]);
    assert.deepEqual(help.options.filter(option => option.name.startsWith("--format-")).map(option => option.name), ["--format-region", "--format-orientation"]);
    assert.ok(help.relationships.some(item => item.kind === "together" && item.options.includes("--format-region") && item.options.includes("--format-orientation")));
  }
  const create = commandHelp(["playlist", "create"]);
  assert.match(create.usage, /A strip is a playlist drawn over the page/);
  assert.match(create.usage, /at least twice the short one/);
  assert.match(create.usage, /never a screen's default, a folder default or a takeover/);
  assert.ok(create.examples.some(example => /--format-region footer --format-orientation landscape/.test(example)));
  assert.match(commandHelp(["screen", "schedule", "set"]).usage, /covers header, footer or side/);
  assert.match(commandHelp(["campaign", "screens"]).usage, /region_not_laid_out/);
});
