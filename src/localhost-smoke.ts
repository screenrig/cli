import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryBackend } from "./transport/fake.js";
import type { HttpMethod } from "./transport/types.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

async function main(): Promise<void> {
  const backend = memoryBackend().pushStream(
    'id: ev1_1\nevent: message\ndata: {"cursor":"ev1_1","type":"smoke.ready","severity":"info","message":"localhost stream","at":"2026-08-14T17:00:00.000Z"}\n\n',
  );
  let apiUrl = "";
  let signedUploadBytes: Buffer | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[key] = value;
    }
    if (url.pathname === "/api/v1/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const stream = await backend.stream({ method: "GET", path: url.pathname, headers, query: Object.fromEntries(url.searchParams) });
      for await (const chunk of stream) res.write(chunk);
      res.end();
      return;
    }
    if (url.pathname === "/signed-upload" && req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      signedUploadBytes = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    if (raw) {
      try { body = JSON.parse(raw) as unknown; } catch { body = raw; }
    }
    const response = await backend.request({ method: (req.method ?? "GET") as HttpMethod, path: url.pathname, headers, query: Object.fromEntries(url.searchParams), body });
    if (url.pathname === "/api/v1/media/uploads" && response.body && typeof response.body === "object") {
      response.body = { ...(response.body as Record<string, unknown>), upload_url: `${apiUrl}/signed-upload` };
    }
    res.writeHead(response.status, { "content-type": response.body === undefined ? "text/plain" : "application/json", ...response.headers });
    res.end(response.body === undefined ? "" : JSON.stringify(response.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  apiUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(path.join(packageRoot, ".tmp"), { recursive: true });
  const temp = await mkdtemp(path.join(packageRoot, ".tmp", "localhost-smoke-"));
  const app = path.join(temp, "app");
  const playlist = path.join(temp, "playlist.json");
  const media = path.join(temp, "pixel.png");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "index.html"), "<!doctype html><html><head></head><body>smoke</body></html>");
  const mediaBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  await writeFile(media, mediaBytes);

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(temp, "config"), HOME: temp };
  const invoke = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(packageRoot, "dist", "bin.js"), "--json", ...args], { cwd: packageRoot, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  const run = async (...args: string[]) => {
    const result = await invoke(args);
    assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; data?: unknown };
    assert.equal(envelope.ok, true, result.stdout);
    return envelope;
  };

  // `doctor` reports the external ffmpeg toolchain that `media upload` needs.
  // This smoke runs against a mock control plane and must stay independent of
  // whether the host has ffmpeg, so it asserts only the control-plane checks.
  const TOOLCHAIN_CHECKS = new Set([
    "ffmpeg", "ffprobe", "encoder_libx265", "encoder_libx264", "encoder_libwebp", "filter_hdr_tonemap",
  ]);
  const runDoctor = async () => {
    const result = await invoke(["doctor"]);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data?: { checks?: Array<{ name: string; status: string; detail: string }> };
    };
    assert.equal(envelope.ok, true, result.stdout);
    const checks = envelope.data?.checks ?? [];
    assert.ok(checks.length > 0, result.stdout);
    for (const check of checks) {
      if (TOOLCHAIN_CHECKS.has(check.name)) continue;
      assert.equal(check.status, "pass", `doctor check ${check.name} failed: ${check.detail}`);
    }
  };

  try {
    const pairing = await run("--api-url", apiUrl, "screen", "pair", "abc234", "--label", "Pairing smoke");
    const pairingData = pairing.data as { public_url?: string; screen?: { id?: string } };
    assert.equal(pairingData.screen?.id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
    assert.equal(pairingData.public_url, "https://play.screenrig.ai/s/scr_public_pairing");
    await run("auth", "status");
    await runDoctor();
    await run("app", "pack", app);
    // This is the documented "web app on a screen" path: upload the directory,
    // take the release id from the publication operation result, and pin that
    // release in an application placement. The release id is the only handle a
    // playlist accepts; the application id is for `kv` alone.
    const upload = await run("app", "upload", app, "--name", "Smoke board", "--poll-ms", "1");
    const uploadData = upload.data as {
      application?: { id?: string };
      operation?: { state?: string; result?: { release_id?: string } };
    };
    assert.equal(uploadData.operation?.state, "succeeded");
    const releaseId = uploadData.operation?.result?.release_id;
    assert.ok(releaseId, `app upload must report a release id: ${JSON.stringify(upload.data)}`);
    await run("app", "list");
    await run("app", "show", "app_AAAAAAAAAAAAAAAAAAAAAAAA");
    // An application-advance page requires exactly one controller application
    // placement, `content_fit: "fill"`, and a `max_ms` backstop for an app that
    // never calls nextPage().
    await writeFile(playlist, JSON.stringify({
      name: "Smoke application page",
      pages: [
        {
          id: "board",
          canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
          transition: { type: "crossfade", duration_ms: 200 },
          advance: { mode: "application", max_ms: 60000 },
          placements: [
            {
              id: "board",
              content: { type: "application", release_id: releaseId },
              rect: { x: 0, y: 0, width: 1920, height: 1080 },
              layer: 0,
              content_fit: "fill",
              controller: true,
            },
          ],
        },
        // A scheduled page. The board page above carries no visibility field at
        // all, which is what satisfies the always-visible-page rule; a playlist
        // with no such page is rejected. This window ends at or before its
        // start, so it crosses midnight and Friday owns the Saturday morning
        // hours.
        {
          id: "after-hours",
          canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
          transition: { type: "crossfade", duration_ms: 200 },
          advance: { mode: "duration", duration_ms: 8000 },
          visibility: {
            enabled: true,
            windows: [{ days: ["fri", "sat"], start: "18:00", end: "02:00" }],
          },
          placements: [
            {
              id: "after-hours",
              content: { type: "application", release_id: releaseId },
              rect: { x: 0, y: 0, width: 1920, height: 1080 },
              layer: 0,
              content_fit: "fill",
            },
          ],
        },
      ],
    }));
    await run("playlist", "create", playlist);
    await run("playlist", "list");
    await run("playlist", "show", "pl_AAAAAAAAAAAAAAAAAAAAAAAA");
    await run("playlist", "update", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", playlist, "--if-match", "1");
    await run("screen", "list");
    await run("screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    // The playlist schedules a page, and a schedule is a civil rule, so the
    // screen needs a zone before it can carry the playlist. Setting it first is
    // what lets the assignment below through.
    const zoned = await run("screen", "set-timezone", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--timezone", "America/Los_Angeles", "--if-match", "1");
    assert.equal((zoned.data as { timezone?: string }).timezone, "America/Los_Angeles");
    await run("screen", "update", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "1");
    // `screen assign` is the last step of the documented application flow.
    const assigned = await run("screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "2");
    assert.equal((assigned.data as { playlist_id?: string }).playlist_id, "pl_AAAAAAAAAAAAAAAAAAAAAAAA");
    const toast = await run(
      "screen",
      "toast",
      "scr_PAIRINGAAAAAAAAAAAAAAAA",
      "--level",
      "info",
      "--text",
      "Lobby closed",
    );
    assert.ok((toast.data as { expires_at?: string }).expires_at);
    // `pixel.png` is a synthetic 12-byte stand-in, not a decodable image, and this
    // smoke must not require a real ffmpeg on the host. `--no-transcode` keeps the
    // assertion on what this smoke owns: the declare, signed PUT, and commit route
    // carry the source bytes through unchanged. The transcode path is covered by
    // src/media/transcode.test.ts and src/cli.test.ts with a fake process runner.
    const mediaUpload = await run("media", "upload", media, "--no-transcode", "--tag", "lobby", "--poll-ms", "1");
    assert.deepEqual(signedUploadBytes, mediaBytes);
    const mediaOperation = (mediaUpload.data as { operation?: { result?: { media_id?: string } } }).operation;
    const mediaId = mediaOperation?.result?.media_id ?? "med_AAAAAAAAAAAAAAAAAAAAAAAA";
    await run("media", "show", mediaId);
    await run("media", "list", "--tag", "lobby", "--kind", "image");
    await run("media", "update", mediaId, "--tag", "lobby2", "--if-match", "1");
    await run("playback", "list", "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--day", "2026-08-14");
    await run("kv", "set", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", "{\"message\":\"hello\"}");
    await run("kv", "get", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA");
    await run("kv", "list", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA");
    await run("kv", "set", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", "{\"message\":\"updated\"}", "--if-match", "1");
    const bug = await run("feedback", "bug", "Smoke bug", "--body", "Recorded by the localhost smoke.", "--command", "media upload");
    assert.equal((bug.data as { kind?: string }).kind, "bug");
    await run("feedback", "feature", "Smoke feature", "--body", "Recorded by the localhost smoke.");
    const feedbackList = await run("feedback", "list");
    assert.deepEqual(
      ((feedbackList.data as { items?: Array<{ kind?: string }> }).items ?? []).map((item) => item.kind).sort(),
      ["bug", "feature"],
    );
    await run("events", "list", "--after", "ev1_0");
    await run("events", "follow", "--after", "ev1_0", "--timeout", "200");
    await run("operations", "wait", "op_AAAAAAAAAAAAAAAAAAAAAAAA", "--poll-ms", "1");
    await run("operations", "cancel", "op_MEDIAAAAAAAAAAAAAAAAAAAAA");
    await run("kv", "delete", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "2");
    await run("media", "delete", mediaId, "--if-match", "2");
    await run("screen", "rotate-public-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--if-match", "2");
    await run("screen", "revoke-credential", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--if-match", "3");
    await run("screen", "delete", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--if-match", "4");
    await run("playlist", "delete", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--if-match", "2");
    process.stdout.write(`localhost v1 smoke passed: ${apiUrl} (mock-backed control-plane routes)\n`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
