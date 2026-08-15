import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

interface JsonEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

function smokePlaylist(): Record<string, unknown> {
  return {
    name: "CLI real-server smoke",
    pages: [{
      id: "smoke_page",
      canvas: {
        width: 1920,
        height: 1080,
        viewport_fit: "contain",
        background: "#000000FF",
      },
      transition: { type: "crossfade", duration_ms: 0 },
      advance: { mode: "duration", after_ms: 5000 },
      placements: [{
        id: "smoke_item",
        content: { type: "iframe", src: "https://example.com/", title: "ScreenRig smoke" },
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "fill",
      }],
    }],
  };
}

function requireLocalUrl(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required; this smoke never guesses a server URL`);
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname.endsWith(".localhost");
  if (!local) throw new Error(`${name} must target localhost; refusing ${url.origin}`);
  return url.toString();
}

async function requireStatus(response: Response, expected: number, stage: string): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${stage} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

function responseCookie(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))?.split(";", 1)[0];
}

async function main(): Promise<void> {
  const apiUrl = requireLocalUrl("SCREENRIG_SMOKE_API_URL");
  const playUrl = requireLocalUrl("SCREENRIG_SMOKE_PLAY_URL");
  await mkdir(path.join(packageRoot, ".tmp"), { recursive: true });
  const temp = await mkdtemp(path.join(packageRoot, ".tmp", "server-smoke-"));
  const app = path.join(temp, "app");
  const playlistFile = path.join(temp, "playlist.json");
  const mediaFile = path.join(temp, "pixel.png");
  await mkdir(app);
  await writeFile(path.join(app, "index.html"), "<!doctype html><html><head></head><body>real server smoke</body></html>");
  await writeFile(playlistFile, JSON.stringify(smokePlaylist()));
  const mediaBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await writeFile(mediaFile, mediaBytes);

  const env = { ...process.env, XDG_CONFIG_HOME: path.join(temp, "config"), HOME: temp };
  const run = async (args: string[], allowFailure = false): Promise<JsonEnvelope> => {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(packageRoot, "dist", "bin.js"), "--json", ...args], { cwd: packageRoot, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    if (!allowFailure) assert.equal(result.code, 0, `${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    const envelope = JSON.parse(result.stdout || result.stderr) as JsonEnvelope;
    if (!allowFailure) assert.equal(envelope.ok, true, JSON.stringify(envelope));
    return envelope;
  };

  let playlistId: string | undefined;
  let playlistRevision: number | undefined;
  let screenId: string | undefined;
  let screenRevision: number | undefined;
  let mediaId: string | undefined;
  let mediaRevision: number | undefined;
  let kvRevision: number | undefined;
  let kvBinaryRevision: number | undefined;
  let applicationId: string | undefined;
  try {
    const pairingStartResponse = await fetch(new URL("/runtime/v1/pairing-sessions", playUrl), { method: "POST" });
    await requireStatus(pairingStartResponse, 201, "player pairing session");
    assert.equal(pairingStartResponse.headers.get("cache-control"), "no-store");
    const pairingCookie = responseCookie(pairingStartResponse, "screenrig-local-pairing");
    assert.ok(pairingCookie, "pairing start must issue a localhost HttpOnly cookie");
    const pairingSession = await pairingStartResponse.json() as { code?: string };
    assert.match(pairingSession.code ?? "", /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    const pairing = await run(["--api-url", apiUrl, "screen", "pair", pairingSession.code ?? "", "--label", "CLI pairing smoke"]);
    const pairedScreen = pairing.data?.screen as Record<string, unknown> | undefined;
    screenId = String(pairedScreen?.id ?? "");
    screenRevision = Number(pairedScreen?.revision);
    assert.ok(screenId && Number.isInteger(screenRevision));
    const publicUrl = String(pairing.data?.public_url ?? "");
    assert.match(publicUrl, /^http:\/\/play\.screenrig\.localhost:8088\/s\/[A-Za-z0-9_-]+$/);
    assert.equal(new URL(publicUrl).origin, new URL(playUrl).origin);
    await run(["auth", "status"]);
    await run(["doctor"]);

    const configPath = path.join(temp, "config", "screenrig", "config.json");
    const configMode = (await stat(configPath)).mode & 0o777;
    assert.equal(configMode, 0o600, `isolated CLI config must be mode 0600, received ${configMode.toString(8)}`);
    const config = JSON.parse(await readFile(configPath, "utf8")) as { token: string };
    const controlHeaders = {
      authorization: `Bearer ${config.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": randomBytes(16).toString("base64url"),
    };
    const cancelDeclarationResponse = await fetch(new URL("/api/v1/media/uploads", apiUrl), {
      method: "POST",
      headers: controlHeaders,
      body: JSON.stringify({
        filename: "cancelled.png",
        content_type: "image/png",
        bytes: mediaBytes.length,
        sha256: createHash("sha256").update(mediaBytes).digest("hex"),
      }),
    });
    await requireStatus(cancelDeclarationResponse, 201, "media declaration fixture for operation cancel");
    const cancelDeclaration = await cancelDeclarationResponse.json() as { operation?: { id?: string } };
    assert.ok(cancelDeclaration.operation?.id);
    await run(["operations", "cancel", cancelDeclaration.operation?.id ?? ""]);

    await run(["app", "pack", app]);
    const upload = await run(["app", "upload", app, "--no-wait"]);
    applicationId = String(upload.data?.id ?? "");
    const operationId = String(upload.data?.operation_id ?? "");
    assert.ok(applicationId && operationId, "application upload must return id and operation_id");
    await run(["operations", "wait", operationId, "--timeout", "90000", "--poll-ms", "250"]);
    await run(["app", "show", applicationId]);
    await run(["app", "list"]);

    const playlist = await run(["playlist", "create", playlistFile]);
    playlistId = String(playlist.data?.id ?? "");
    playlistRevision = Number(playlist.data?.revision);
    assert.ok(playlistId && Number.isInteger(playlistRevision));
    await run(["playlist", "show", playlistId]);
    await run(["playlist", "list"]);
    const updatedPlaylist = await run(["playlist", "update", playlistId, playlistFile, "--if-match", String(playlistRevision)]);
    playlistRevision = Number(updatedPlaylist.data?.revision);

    const assignedScreen = await run(["screen", "assign", screenId, "--playlist-id", playlistId, "--if-match", String(screenRevision)]);
    screenRevision = Number(assignedScreen.data?.revision);

    const pairingEventsResponse = await fetch(new URL("/runtime/v1/pairing-events", playUrl), {
      headers: { cookie: pairingCookie },
    });
    await requireStatus(pairingEventsResponse, 200, "pairing SSE");
    const pairingEvents = await pairingEventsResponse.text();
    const claimedData = pairingEvents.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    assert.ok(claimedData, "pairing SSE must include terminal claimed data");
    const claimed = JSON.parse(claimedData) as { type?: string; completion_nonce?: string };
    assert.equal(claimed.type, "pairing.claimed");
    assert.match(claimed.completion_nonce ?? "", /^[A-Za-z0-9_-]{43}$/);
    const completeResponse = await fetch(new URL("/runtime/v1/pairing-sessions/complete", playUrl), {
      method: "POST",
      headers: { cookie: pairingCookie, "content-type": "application/json" },
      body: JSON.stringify({ completion_nonce: claimed.completion_nonce }),
    });
    await requireStatus(completeResponse, 200, "pairing completion");
    assert.equal(completeResponse.headers.get("cache-control"), "no-store");
    const deviceCookie = responseCookie(completeResponse, "screenrig-local-device");
    assert.ok(deviceCookie, "pairing completion must issue a localhost paired-device cookie");
    const deviceSessionResponse = await fetch(new URL("/runtime/v1/device-sessions", playUrl), {
      method: "POST", headers: { cookie: deviceCookie, "content-type": "application/json" }, body: "{}",
    });
    await requireStatus(deviceSessionResponse, 201, "paired runtime session");
    const runtimeCookie = responseCookie(deviceSessionResponse, "screenrig-local-runtime");
    assert.ok(runtimeCookie, "paired device session must issue a localhost runtime cookie");
    const manifestResponse = await fetch(new URL("/runtime/v1/manifest", playUrl), { headers: { cookie: runtimeCookie } });
    await requireStatus(manifestResponse, 200, "runtime manifest");
    const runtimeManifest = await manifestResponse.json() as { schemaVersion?: number };
    assert.equal(runtimeManifest.schemaVersion, 2);

    const shownScreen = await run(["screen", "show", screenId]);
    screenRevision = Number(shownScreen.data?.revision);
    assert.ok(Number.isInteger(screenRevision));
    assert.equal(shownScreen.data?.state, "active");
    await run(["screen", "list"]);

    const mediaUpload = await run(["media", "upload", mediaFile, "--timeout", "90000", "--poll-ms", "250"]);
    const mediaOperation = mediaUpload.data?.operation as { result?: Record<string, unknown> } | undefined;
    mediaId = String(mediaOperation?.result?.media_id ?? "");
    assert.ok(mediaId, "terminal media operation must return media_id");
    const mediaShow = await run(["media", "show", mediaId]);
    mediaRevision = Number(mediaShow.data?.revision);
    assert.ok(Number.isInteger(mediaRevision));
    await run(["media", "list"]);
    const kv = await run(["kv", "set", "smoke", "--application-id", applicationId, "--json-value", "{\"status\":\"ok\"}"]);
    kvRevision = Number(kv.data?.revision);
    assert.ok(Number.isInteger(kvRevision));
    const kvUpdated = await run(["kv", "set", "smoke", "--application-id", applicationId, "--json-value", "{\"status\":\"updated\"}", "--if-match", String(kvRevision)]);
    kvRevision = Number(kvUpdated.data?.revision);
    const staleUpdate = await run(["kv", "set", "smoke", "--application-id", applicationId, "--json-value", "{\"status\":\"stale\"}", "--if-match", "1"], true);
    assert.equal(staleUpdate.ok, false);
    assert.equal(staleUpdate.error?.code, "revision_conflict");
    await run(["kv", "get", "smoke", "--application-id", applicationId]);
    const kvBinary = await run(["kv", "set", "smoke-binary", "--application-id", applicationId, "--file", mediaFile, "--content-type", "image/png"]);
    kvBinaryRevision = Number(kvBinary.data?.revision);
    assert.ok(Number.isInteger(kvBinaryRevision));
    await run(["kv", "get", "smoke-binary", "--application-id", applicationId]);
    await run(["kv", "list", "--application-id", applicationId]);
    const events = await run(["events", "list"]);
    const cursor = String(events.data?.next_cursor ?? "");
    await run(["kv", "delete", "smoke", "--application-id", applicationId, "--if-match", String(kvRevision)]);
    kvRevision = undefined;
    await run(["kv", "delete", "smoke-binary", "--application-id", applicationId, "--if-match", String(kvBinaryRevision)]);
    kvBinaryRevision = undefined;
    const followedEvents = await run(["events", "follow", "--after", cursor, "--timeout", "1500"]);
    const followedItems = followedEvents.data?.items;
    assert.ok(Array.isArray(followedItems) && followedItems.some((event) => (
      typeof event === "object" && event !== null && (event as Record<string, unknown>).type === "kv.deleted"
    )), "events follow must observe a durable kv.deleted event after the supplied cursor");
    let rotated: JsonEnvelope | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const screenBeforeRotation = await run(["screen", "show", screenId]);
      screenRevision = Number(screenBeforeRotation.data?.revision);
      assert.ok(Number.isInteger(screenRevision));
      const candidate = await run(["screen", "rotate-public-id", screenId, "--if-match", String(screenRevision)], true);
      if (candidate.ok) {
        rotated = candidate;
        break;
      }
      assert.equal(candidate.error?.code, "revision_conflict");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(rotated, "screen rotation did not converge after manifest materialization revisions settled");
    screenRevision = Number(rotated.data?.revision);
    const revisionBeforeRevoke = screenRevision;
    const revoked = await run(["screen", "revoke-credential", screenId, "--if-match", String(screenRevision)]);
    screenRevision = Number(revoked.data?.revision);
    assert.equal(screenRevision, revisionBeforeRevoke + 1, "credential revocation must advance the resource revision");

    process.stdout.write(JSON.stringify({
      ok: true,
      api_url: apiUrl,
      play_url: playUrl,
      application_id: applicationId,
      operation_id: operationId,
      playlist_id: playlistId,
      screen_id: screenId,
      media_id: mediaId,
      config_mode: "0600",
      pairing_session_manifest: "active schemaVersion 2",
      credential_revocation: "revision advanced",
      events_cursor_resume: "durable K/V delete observed after listed cursor",
      note: "real Compose API smoke passed; disposable account/application remain because v0.2.0 publishes no delete routes",
    }) + "\n");
  } finally {
    if (applicationId && kvRevision) {
      await run(["kv", "delete", "smoke", "--application-id", applicationId, "--if-match", String(kvRevision)], true).catch(() => undefined);
    }
    if (applicationId && kvBinaryRevision) {
      await run(["kv", "delete", "smoke-binary", "--application-id", applicationId, "--if-match", String(kvBinaryRevision)], true).catch(() => undefined);
    }
    if (mediaId && Number.isInteger(mediaRevision)) {
      await run(["media", "delete", mediaId, "--if-match", String(mediaRevision)], true).catch(() => undefined);
    }
    if (screenId && Number.isInteger(screenRevision)) {
      await run(["screen", "delete", screenId, "--if-match", String(screenRevision)], true).catch(() => undefined);
    }
    if (playlistId && Number.isInteger(playlistRevision)) {
      await run(["playlist", "delete", playlistId, "--if-match", String(playlistRevision)], true).catch(() => undefined);
    }
    await rm(temp, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
