import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    if (/^\/api\/v1\/media\/[^/]+\/content$/.test(url.pathname) && req.method === "GET") {
      // The memory backend never sees the signed PUT bytes; serve the captured
      // upload back so `media download` can verify length and SHA-256.
      if (!signedUploadBytes) {
        res.writeHead(404, { "content-type": "application/problem+json" });
        res.end(JSON.stringify({ code: "not_found", status: 404, detail: "No media bytes uploaded yet." }));
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(signedUploadBytes.byteLength),
        "content-disposition": `attachment; filename="${url.pathname.split("/").at(-2)}.png"`,
        "cache-control": "private, no-store",
      });
      res.end(signedUploadBytes);
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
    const csv = (response.headers["content-type"] ?? "").startsWith("text/csv");
    res.end(response.body === undefined ? "" : csv ? String(response.body) : JSON.stringify(response.body));
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
    "ffmpeg", "ffprobe", "encoder_libx265", "encoder_libx264", "encoder_libwebp", "cwebp", "filter_hdr_tonemap",
  ]);
  const runDoctor = async () => {
    const result = await invoke(["doctor"]);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data?: { status?: string; checks?: Array<{ name: string; status: string; detail: string }> };
    };
    assert.equal(envelope.ok, true, result.stdout);
    const checks = envelope.data?.checks ?? [];
    assert.ok(checks.length > 0, result.stdout);
    for (const check of checks) {
      if (TOOLCHAIN_CHECKS.has(check.name)) continue;
      assert.notEqual(check.status, "fail", `doctor check ${check.name} failed: ${check.detail}`);
    }
    const byName = new Map(checks.map((check) => [check.name, check]));
    // Host-dependent, but never skipped on a host that has ffmpeg: `cwebp` is
    // only the fallback for a build without libwebp, so an ffmpeg that carries
    // the encoder must not leave doctor failing over a binary it never runs.
    if (byName.get("encoder_libwebp")?.status === "pass") {
      const cwebp = byName.get("cwebp");
      assert.notEqual(cwebp?.status, "fail", `cwebp is optional beside libwebp: ${cwebp?.detail}`);
    }
    if (!checks.some((check) => check.status === "fail")) {
      assert.equal(envelope.data?.status !== "fail", true, result.stdout);
      assert.equal(result.code, 0, `doctor with no failing check must exit 0: ${result.stdout}`);
    }
  };

  try {
    await run("--api-url", apiUrl, "agent", "enroll", "--email", "smoke@example.com");
    const pairing = await run("--api-url", apiUrl, "screen", "pair", "abc234", "--label", "Pairing smoke");
    const pairingData = pairing.data as { public_url?: string; screen?: { id?: string } };
    assert.equal(pairingData.screen?.id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
    assert.equal(pairingData.public_url, "https://play.screenrig.ai/s/scr_public_pairing");
    await run("agent", "status");
    await runDoctor();
    await run("app", "pack", app);
    // This is the documented "web app on a screen" path: upload the directory,
    // take the release id from the publication operation result, and pin that
    // release in an application primitive. The release id is the only handle a
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
    // primitive, `content_fit: "fill"`, and a `max_ms` backstop for an app that
    // never calls nextPage().
    await writeFile(playlist, JSON.stringify({
      name: "Smoke application page",
      pages: [
        {
          id: "board",
          canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
          transition: { type: "crossfade", duration_ms: 200 },
          advance: { mode: "application", max_ms: 60000 },
          primitives: [
            {
              id: "board",
              primitive: "application",
              release_id: releaseId,
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
          advance: { mode: "duration", after_ms: 8000 },
          visibility: {
            enabled: true,
            windows: [{ days: ["fri", "sat"], start: "18:00", end: "02:00" }],
          },
          primitives: [
            {
              id: "after-hours",
              primitive: "application",
              release_id: releaseId,
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
    await run("playlist", "update", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", playlist, "--expect-rev", "1");
    const commentsSet = await run(
      "comment",
      "set",
      "screen",
      "scr_PAIRINGAAAAAAAAAAAAAAAA",
      "--json-value",
      "{\"note\":\"lobby\"}",
    );
    assert.deepEqual((commentsSet.data as { comments?: unknown }).comments, { note: "lobby" });
    const commentsShown = await run("comment", "show", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    assert.deepEqual((commentsShown.data as { comments?: unknown }).comments, { note: "lobby" });
    await run(
      "comment",
      "set",
      "playlist",
      "pl_AAAAAAAAAAAAAAAAAAAAAAAA",
      "--page",
      "board",
      "--json-value",
      "{\"slot\":\"hero\"}",
    );
    await run("comment", "show", "playlist", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--page", "board");
    await run("comment", "delete", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    const commentsCleared = await run("comment", "show", "screen", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    assert.equal((commentsCleared.data as { comments?: unknown }).comments, null);
    await run("screen", "list");
    await run("screen", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    // The playlist schedules a page, and a schedule is a civil rule, so the
    // screen needs a zone before it can carry the playlist. Setting it first is
    // what lets the assignment below through.
    const zoned = await run("screen", "set-timezone", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--timezone", "America/Los_Angeles", "--expect-rev", "1");
    assert.equal((zoned.data as { timezone?: string }).timezone, "America/Los_Angeles");
    await run("screen", "update", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--expect-rev", "1");
    // `screen assign` is the last step of the documented application flow.
    const assigned = await run("screen", "assign", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--expect-rev", "2");
    assert.equal((assigned.data as { playlist_id?: string }).playlist_id, "pl_AAAAAAAAAAAAAAAAAAAAAAAA");
    const toast = await run(
      "screen",
      "toast",
      "scr_PAIRINGAAAAAAAAAAAAAAAA",
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
    const shown = await run("media", "show", mediaId);
    assert.equal((shown.data as { source_filename?: string }).source_filename, "pixel.png");
    const downloadPath = path.join(temp, "downloaded.png");
    const downloaded = await run("media", "download", mediaId, "--output", downloadPath);
    assert.equal((downloaded.data as { path?: string }).path, downloadPath);
    assert.deepEqual(await readFile(downloadPath), mediaBytes);
    assert.doesNotMatch(JSON.stringify(downloaded), /\u0089PNG|iVBOR/, "download envelope must not carry pixels");
    await run("media", "list", "--tag", "lobby", "--primitive", "image");
    await run("media", "update", mediaId, "--tag", "lobby2", "--expect-rev", "1");
    await run("playback", "list", "--screen-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--day", "2026-08-14");
    const aggregatesPath = path.join(temp, "aggregates.csv");
    const aggregates = await run("playback", "list", "--format", "csv", "--output", aggregatesPath);
    assert.equal((aggregates.data as { rows?: number }).rows, 1);
    assert.match(await readFile(aggregatesPath, "utf8"), /^screen_id,media_id,filename,/);
    const playsPage = await run("playback", "plays", "--from", "2026-08-14T00:00:00Z", "--to", "2026-08-15T00:00:00Z", "--limit", "2");
    const playsData = playsPage.data as { items?: unknown[]; next_cursor?: string | null };
    assert.equal(playsData.items?.length, 2);
    assert.match(String(playsData.next_cursor), /^pc_/);
    const allPlays = await run("playback", "plays", "--from", "2026-08-14T00:00:00Z", "--to", "2026-08-15T00:00:00Z", "--all");
    assert.equal((allPlays.data as { items?: unknown[] }).items?.length, 5);
    const playsPath = path.join(temp, "plays.csv");
    const playsCsv = await run("playback", "plays", "--from", "2026-08-14T00:00:00Z", "--to", "2026-08-15T00:00:00Z", "--tag", "Lobby", "--format", "csv", "--output", playsPath);
    const playsCsvData = playsCsv.data as { rows?: number; sha256?: string; path?: string };
    assert.equal(playsCsvData.rows, 1);
    assert.equal(playsCsvData.path, playsPath);
    assert.match(String(playsCsvData.sha256), /^[a-f0-9]{64}$/);
    assert.match(await readFile(playsPath, "utf8"), /^screen_id,playlist_id,page_id,primitive_id,media_id,primitive,started_at,received_at\r\n/);
    const playsStdout = await invoke(["playback", "plays", "--from", "2026-08-14T00:00:00Z", "--to", "2026-08-15T00:00:00Z", "--format", "csv", "--output", "-"]);
    assert.equal(playsStdout.code, 0, playsStdout.stderr);
    assert.equal(playsStdout.stdout.split("\r\n").filter(Boolean).length, 6, "--output - writes only the CSV to stdout");
    await run("kv", "set", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", "{\"message\":\"hello\"}");
    await run("kv", "get", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA");
    await run("kv", "list", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA");
    await run("kv", "set", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--json-value", "{\"message\":\"updated\"}", "--expect-rev", "1");
    const bug = await run("feedback", "bug", "Smoke bug", "--body", "Recorded by the localhost smoke.", "--command", "media upload");
    assert.equal((bug.data as { kind?: string }).kind, "bug");
    await run("feedback", "feature", "Smoke feature", "--body", "Recorded by the localhost smoke.");
    const feedbackList = await run("feedback", "list");
    assert.deepEqual(
      ((feedbackList.data as { items?: Array<{ kind?: string }> }).items ?? []).map((item) => item.kind).sort(),
      ["bug", "feature"],
    );
    // Webhooks: the secret appears once in data.secret, never in config.
    const hook = await run("webhooks", "create", "--url", "https://hooks.example.com/screenrig", "--event-types", "screen.*", "--description", "Smoke");
    const hookData = hook.data as { id?: string; secret?: string };
    assert.match(String(hookData.secret), /^whsec_/);
    const hookId = String(hookData.id);
    const hookConfig = await readFile(path.join(temp, "config", "screenrig", "config.json"), "utf8");
    assert.doesNotMatch(hookConfig, /whsec_/, "the webhook secret must never be persisted");
    const hooks = await run("webhooks", "list");
    assert.equal(((hooks.data as { items?: Array<{ secret?: string }> }).items ?? [])[0]?.secret, undefined);
    await run("webhooks", "show", hookId);
    await run("webhooks", "update", hookId, "--event-types", "screen.offline,playlist.*", "--expect-rev", "1");
    const hookTest = await run("webhooks", "test", hookId);
    assert.equal((hookTest.data as { event_type?: string }).event_type, "webhook.test");
    await run("webhooks", "deliveries", hookId, "--limit", "10");
    const rotated = await run("webhooks", "rotate-secret", hookId);
    assert.notEqual((rotated.data as { secret?: string }).secret, hookData.secret);
    const rejected = await invoke(["webhooks", "create", "--url", "https://hooks.example.com:8080/x", "--event-types", "screen.*"]);
    assert.equal(rejected.code, 8, `webhook_url_rejected must exit 8: ${rejected.stdout}`);
    assert.match(rejected.stdout, /url port must be 443 \(the default\) or 8443/);
    await run("webhooks", "delete", hookId, "--expect-rev", "3");
    await run("events", "list", "--after", "ev1_0");
    await run("events", "follow", "--after", "ev1_0", "--timeout", "200");
    await run("operations", "wait", "op_AAAAAAAAAAAAAAAAAAAAAAAA", "--poll-ms", "1");
    await run("operations", "cancel", "op_MEDIAAAAAAAAAAAAAAAAAAAAA");
    await run("kv", "delete", "greeting", "--application-id", "app_AAAAAAAAAAAAAAAAAAAAAAAA", "--expect-rev", "2");
    await run("media", "delete", mediaId, "--expect-rev", "2");
    await run("screen", "rotate-public-id", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--expect-rev", "2");
    const archived = await run("screen", "archive", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--expect-rev", "3");
    assert.equal((archived.data as { state?: string }).state, "archived");
    const listed = await run("screen", "list");
    assert.equal(((listed.data as { items?: unknown[] }).items ?? []).length, 0);
    const archivedList = await run("screen", "list", "--state", "archived");
    assert.equal(((archivedList.data as { items?: Array<{ id?: string }> }).items ?? [])[0]?.id, "scr_PAIRINGAAAAAAAAAAAAAAAA");
    assert.equal(((archivedList.data as { items?: Array<{ archive_reason?: string }> }).items ?? [])[0]?.archive_reason, "project");
    await run("screen", "unarchive", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--expect-rev", "4");
    const reloaded = await run("screen", "reload", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--expect-rev", "5");
    assert.match(String((reloaded.data as { reload_id?: string }).reload_id ?? ""), /^[A-Za-z0-9_-]{8,64}$/);
    const tagged = await run("screen", "tag", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--set", "Lobby", "--expect-rev", "5");
    assert.deepEqual((tagged.data as { tags?: string[] }).tags, ["Lobby"]);
    const byTag = await run("screen", "list", "--tag", "Lobby");
    assert.equal(((byTag.data as { items?: unknown[] }).items ?? []).length, 1);
    const fleetReload = await run("screen", "reload", "--tag", "Lobby");
    assert.equal((fleetReload.data as { matched?: number; succeeded?: number }).succeeded, 1);
    const fleetTag = await run("screen", "tag", "--tag", "Lobby", "--add", "Spring");
    assert.deepEqual((fleetTag.data as { results?: Array<{ tags?: string[] }> }).results?.[0]?.tags, ["Lobby", "Spring"]);
    // Playlist schedules and takeover: the server picks the effective playlist.
    const dayparts = path.join(temp, "dayparts.json");
    await writeFile(dayparts, JSON.stringify({ entries: [
      { id: "lunch", playlist_id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "11:00", end: "15:00" }] },
    ] }));
    const scheduled = await run("screen", "schedule", "set", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--file", dayparts);
    assert.equal((scheduled.data as { effective_playlist?: { source?: string } }).effective_playlist?.source, "schedule");
    const scheduleView = await run("screen", "schedule", "show", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    assert.equal(((scheduleView.data as { entries?: unknown[] }).entries ?? []).length, 1);
    const fleetSchedule = await run("screen", "schedule", "set", "--tag", "Lobby", "--file", dayparts);
    assert.equal((fleetSchedule.data as { succeeded?: number }).succeeded, 1);
    const takenOver = await run("screen", "takeover", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--for", "30m", "--reason", "Smoke");
    assert.equal((takenOver.data as { effective_playlist?: { source?: string } }).effective_playlist?.source, "takeover");
    const inUse = await invoke(["playlist", "delete", "pl_AAAAAAAAAAAAAAAAAAAAAAAA"]);
    assert.equal(inUse.code, 5, `a playlist a takeover holds must be in use: ${inUse.stdout}`);
    await run("screen", "takeover", "--tag", "Lobby", "--playlist-id", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--until", "none");
    await run("screen", "takeover", "clear", "--tag", "Lobby");
    await run("screen", "takeover", "clear", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    const fleetClear = await run("screen", "schedule", "clear", "--tag", "Lobby");
    assert.equal((fleetClear.data as { action?: string; succeeded?: number }).succeeded, 1);
    await run("screen", "schedule", "clear", "scr_PAIRINGAAAAAAAAAAAAAAAA");
    // Reboot and display power on a seeded active screen whose Player declares reboot.
    backend.putScreen!({
      id: "scr_DISPLAYAAAAAAAAAAAAAAAA", public_id: "pub_display", label: "Display", state: "active", online: true, revision: 1,
      manifest_revision: 1, content_access_generation: 1, timezone: "America/Los_Angeles", tags: ["Hall"],
      host: { platform: "android", capabilities: ["reboot", "display_power.cec"] },
      created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z",
    } as unknown as Parameters<NonNullable<typeof backend.putScreen>>[0]);
    const rebooted = await run("screen", "reboot", "scr_DISPLAYAAAAAAAAAAAAAAAA");
    assert.match(String((rebooted.data as { reboot_id?: string }).reboot_id), /^rbt_/);
    const unconfirmed = await invoke(["screen", "reboot", "--tag", "Hall"]);
    assert.equal(unconfirmed.code, 2, "a fleet reboot needs --yes");
    await run("screen", "reboot", "--tag", "Hall", "--yes");
    const dark = await run("screen", "display", "scr_DISPLAYAAAAAAAAAAAAAAAA", "--power", "off", "--for", "1h");
    assert.equal((dark.data as { display?: { requested?: string } }).display?.requested, "off");
    await run("screen", "display", "--tag", "Hall", "--power", "on");
    const undone = await run("screen", "display", "clear", "scr_DISPLAYAAAAAAAAAAAAAAAA");
    assert.equal((undone.data as { display?: unknown }).display, undefined);
    await run("screen", "display", "--tag", "Hall", "--power", "off");
    await run("screen", "display", "clear", "--tag", "Hall");
    const hours = path.join(temp, "hours.json");
    await writeFile(hours, JSON.stringify({ enabled: true, windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "07:00", end: "19:00" }] }));
    await run("screen", "display-schedule", "set", "scr_DISPLAYAAAAAAAAAAAAAAAA", "--file", hours);
    const displayView = await run("screen", "display-schedule", "show", "scr_DISPLAYAAAAAAAAAAAAAAAA");
    assert.equal((displayView.data as { display_schedule?: { windows?: unknown[] } }).display_schedule?.windows?.length, 1);
    await run("screen", "display-schedule", "set", "--tag", "Hall", "--file", hours);
    await run("screen", "display-schedule", "clear", "--tag", "Hall");
    await run("screen", "display-schedule", "clear", "scr_DISPLAYAAAAAAAAAAAAAAAA");
    const deleted = await invoke(["screen", "delete", "scr_PAIRINGAAAAAAAAAAAAAAAA", "--expect-rev", "5"]);
    assert.equal(deleted.code, 5, `screen delete must surface screen_archive_required: ${deleted.stderr || deleted.stdout}`);
    assert.equal((JSON.parse(deleted.stdout) as { error?: { code?: string } }).error?.code, "screen_archive_required");
    await run("playlist", "delete", "pl_AAAAAAAAAAAAAAAAAAAAAAAA", "--expect-rev", "2");
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
