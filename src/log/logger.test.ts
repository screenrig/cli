import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../client.js";
import { parseArgv } from "../argv.js";
import { USAGE } from "../commands.js";
import { preserveLogSocket, readConfigFile, resolveConfig, writeConfigAtomic, type ConfigFs } from "../config.js";
import { ensureCredential } from "../enrollment.js";
import { ExitCode } from "../exit-codes.js";
import { run, type CliRuntime } from "../main.js";
import { packDirectory } from "../pack/index.js";
import { CliError } from "../problems.js";
import { testTemp } from "../test-temp.js";
import { FakeTransport, memoryBackend } from "../transport/fake.js";
import { createMemoryLogger } from "./logger.js";
import type { LogEvent } from "./types.js";

const fixtures = fileURLToPath(new URL("../../fixtures/pack/ok-app", import.meta.url));

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

function realFs(home: string, env: NodeJS.Dict<string> = { XDG_CONFIG_HOME: home }): ConfigFs {
  return { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env };
}

async function withRuntime(
  argv: string[],
  transport: FakeTransport,
  extra?: Partial<CliRuntime>,
): Promise<{ code: number; stdout: string; stderr: string; configDir: string }> {
  const configDir = extra?.fs ? "" : await testTemp("log-cfg-");
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outP = collect(stdout);
  const errP = collect(stderr);
  const fsLike: ConfigFs = extra?.fs ?? {
    mkdir,
    open,
    rename,
    rm,
    chmod,
    stat,
    homedir: () => configDir,
    env: { XDG_CONFIG_HOME: configDir },
  };
  const runtime: CliRuntime = {
    argv,
    env: fsLike.env,
    stdout,
    stderr,
    now: () => new Date("2026-08-14T17:00:00.000Z"),
    sleep: async () => undefined,
    homedir: fsLike.homedir,
    cwd: () => process.cwd(),
    fs: fsLike,
    transport,
    ...extra,
  };
  const code = await run(runtime);
  stdout.end();
  stderr.end();
  return { code, stdout: await outP, stderr: await errP, configDir };
}

async function listenUnix(socketPath: string): Promise<{ events: LogEvent[]; waitForClient: () => Promise<void>; close: () => Promise<void> }> {
  const events: LogEvent[] = [];
  let clientDone: Promise<void> = Promise.resolve();
  const server = net.createServer((socket) => {
    clientDone = new Promise<void>((resolve) => {
      let buffer = "";
      socket.setEncoding("utf8");
      const finish = () => {
        if (buffer.trim().length > 0) {
          for (const line of buffer.split("\n")) {
            if (line.length > 0) {
              events.push(JSON.parse(line) as LogEvent);
            }
          }
          buffer = "";
        }
        resolve();
      };
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            events.push(JSON.parse(line) as LogEvent);
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("end", finish);
      socket.on("close", finish);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    events,
    waitForClient: () => clientDone,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test("USAGE and argv do not define a log-socket flag", () => {
  assert.doesNotMatch(USAGE, /\[--log-socket/);
  assert.match(USAGE, /log_socket/);
  const parsed = parseArgv(["--log-socket", "/tmp/screenrig.sock", "version"]);
  assert.equal(parsed.flags["log-socket"], true);
  assert.equal(parsed.positionals[0], "/tmp/screenrig.sock");
});

test("HTTP request and response share correlation_id with distinct event_id", async () => {
  const { logger, events } = createMemoryLogger({ command: ["screen", "list"] });
  const transport = new FakeTransport().on("GET", "/api/v1/screens", () => ({
    status: 200,
    headers: { "x-request-id": "req_AAAAAAAAAAAAAAAA", "content-type": "application/json" },
    body: { items: [] },
  }));
  const client = new ApiClient({
    transport,
    token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    logger,
    requestId: "req_AAAAAAAAAAAAAAAA",
  });
  await client.call({ method: "GET", path: "/api/v1/screens" });
  const request = events.find((event) => event.kind === "http" && event.phase === "request");
  const response = events.find((event) => event.kind === "http" && event.phase === "response");
  assert.ok(request);
  assert.ok(response);
  assert.equal(request.v, 1);
  assert.equal(response.v, 1);
  assert.equal(request.correlation_id, response.correlation_id);
  assert.notEqual(request.event_id, response.event_id);
  assert.equal(request.method, "GET");
  assert.equal(request.path, "/api/v1/screens");
  assert.equal(response.status, 200);
  assert.equal(request.op, "GET /api/v1/screens");
  assert.equal(response.request_id, "req_AAAAAAAAAAAAAAAA");
  const serialized = events.map((event) => JSON.stringify(event)).join("\n");
  assert.doesNotMatch(serialized, /sr_live_tokidAAAAAAAAAAAAAAAA_AAAA/);
  assert.doesNotMatch(serialized, /authorization/i);
});

test("HTTP error logs status, problem, and the paired correlation_id", async () => {
  const { logger, events } = createMemoryLogger({ command: ["screen", "show"] });
  const transport = new FakeTransport().on("GET", "/api/v1/screens/scr_missing", () => ({
    status: 404,
    headers: { "content-type": "application/problem+json", "x-request-id": "req_BBBBBBBBBBBBBBBB" },
    body: {
      type: "https://screenrig.ai/problems/not-found",
      title: "Not found",
      status: 404,
      detail: "Screen not found",
      code: "not_found",
    },
  }));
  const client = new ApiClient({ transport, logger, requestId: "req_BBBBBBBBBBBBBBBB" });
  await assert.rejects(() => client.call({ method: "GET", path: "/api/v1/screens/scr_missing" }), CliError);
  const request = events.find((event) => event.kind === "http" && event.phase === "request");
  const errorEvent = events.find((event) => event.kind === "http" && event.phase === "error");
  assert.ok(request);
  assert.ok(errorEvent);
  assert.equal(request.correlation_id, errorEvent.correlation_id);
  assert.equal(errorEvent.status, 404);
  assert.equal((errorEvent.problem as { code?: string } | undefined)?.code, "not_found");
  assert.match(String((errorEvent.problem as { detail?: string } | undefined)?.detail), /Screen not found/);
});

test("redaction strips tokens, authorization, signed URLs, and pixels from serialized lines", () => {
  const { logger, events } = createMemoryLogger({ command: ["media", "upload"] });
  logger.emit({
    kind: "local",
    phase: "start",
    op: "media.signed_put",
    correlation_id: "11111111-1111-4111-8111-111111111111",
    message: "PUT https://storage.example.invalid/private?signature=secret",
    request: {
      authorization: "Bearer sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      upload_url: "https://storage.example.invalid/private?X-Amz-Signature=abc",
      pixels: "data:image/webp;base64,AAAA",
      email: "owner@example.com",
    },
  });
  const line = JSON.stringify(events[0]);
  assert.doesNotMatch(line, /sr_live_tokidAAAAAAAAAAAAAAAA_AAAA/);
  assert.doesNotMatch(line, /Bearer sr_live_/);
  assert.doesNotMatch(line, /X-Amz-Signature=abc/);
  assert.doesNotMatch(line, /data:image\/webp;base64,AAAA/);
  assert.doesNotMatch(line, /owner@example\.com/);
  assert.equal(events[0]?.v, 1);
});

test("pack emits start and finish without archive bytes", async () => {
  const { logger, events } = createMemoryLogger({ command: ["app", "pack"] });
  const packed = await packDirectory(fixtures, { logger });
  assert.ok(packed.compressed_bytes > 0);
  const start = events.find((event) => event.op === "pack.directory" && event.phase === "start");
  const finish = events.find((event) => event.op === "pack.directory" && event.phase === "finish");
  assert.ok(start);
  assert.ok(finish);
  assert.equal(start.correlation_id, finish.correlation_id);
  assert.ok(events.some((event) => event.op === "pack.walk" && event.phase === "start"));
  assert.ok(events.some((event) => event.op === "pack.walk" && event.phase === "finish"));
  assert.ok(events.some((event) => event.op === "pack.archive" && event.phase === "finish"));
  const serialized = events.map((event) => JSON.stringify(event)).join("\n");
  assert.doesNotMatch(serialized, /"archive"/);
  assert.equal(finish.v, 1);
  assert.match(events.map((event) => event.event_id).join("\n"), /^[0-9a-f-]{36}$/m);
});

test("no log_socket leaves commands working without a socket connect", async () => {
  const transport = memoryBackend();
  const home = await testTemp("log-none-");
  const fsLike = realFs(home);
  await writeConfigAtomic(
    path.join(home, "screenrig", "config.json"),
    { api_url: "https://api.screenrig.ai", token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    fsLike,
  );
  const result = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
  assert.equal(result.code, 0, result.stdout);
  await rm(home, { recursive: true, force: true });
});

test("log_socket without a listener fails the command", async () => {
  const transport = memoryBackend();
  const home = await testTemp("log-missing-");
  const socketPath = path.join(home, "screenrig.sock");
  const fsLike = realFs(home);
  await writeConfigAtomic(
    path.join(home, "screenrig", "config.json"),
    {
      api_url: "https://api.screenrig.ai",
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      log_socket: socketPath,
    },
    fsLike,
  );
  const result = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
  assert.equal(result.code, ExitCode.Config, result.stdout);
  const envelope = JSON.parse(result.stdout) as { error: { code: string; detail: string } };
  assert.equal(envelope.error.code, "config_error");
  assert.match(envelope.error.detail, /log_socket|listening/i);
  assert.doesNotMatch(result.stdout, /sr_live_/);
  await rm(home, { recursive: true, force: true });
});

test("log_socket writes one NDJSON object per line with v 1", async () => {
  const home = await testTemp("log-ndjson-");
  const socketPath = path.join(home, "screenrig.sock");
  const listener = await listenUnix(socketPath);
  try {
    const transport = memoryBackend();
    const fsLike = realFs(home);
    await writeConfigAtomic(
      path.join(home, "screenrig", "config.json"),
      {
        api_url: "https://api.screenrig.ai",
        token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        log_socket: socketPath,
      },
      fsLike,
    );
    const resolved = await resolveConfig({ flags: {}, fs: fsLike });
    assert.equal(resolved.logSocket, socketPath);
    const result = await withRuntime(["--json", "screen", "list"], transport, { fs: fsLike });
    assert.equal(result.code, 0, result.stdout);
    await listener.waitForClient();
    assert.ok(listener.events.length >= 2, JSON.stringify(listener.events));
    for (const event of listener.events) {
      assert.equal(event.v, 1);
      assert.match(event.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.deepEqual(event.command, ["screen", "list"]);
    }
    const httpReq = listener.events.find((event) => event.kind === "http" && event.phase === "request");
    const httpRes = listener.events.find((event) => event.kind === "http" && event.phase === "response");
    assert.ok(httpReq);
    assert.ok(httpRes);
    assert.equal(httpReq.correlation_id, httpRes.correlation_id);
    assert.equal(httpRes.status, 200);
    const serialized = listener.events.map((event) => JSON.stringify(event)).join("\n");
    assert.doesNotMatch(serialized, /sr_live_tokidAAAAAAAAAAAAAAAA_AAAA/);
  } finally {
    await listener.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("enrollment rewrite keeps log_socket", async () => {
  const home = await testTemp("log-enroll-");
  const fsLike = realFs(home);
  const configPath = path.join(home, "screenrig", "config.json");
  await writeConfigAtomic(
    configPath,
    { api_url: "https://api.screenrig.ai", log_socket: "/tmp/screenrig.sock" },
    fsLike,
  );
  const resolved = await resolveConfig({ flags: {}, fs: fsLike });
  assert.equal(resolved.logSocket, "/tmp/screenrig.sock");
  await ensureCredential({
    resolved,
    runtime: { fs: fsLike, now: () => new Date("2026-08-14T20:00:00.000Z"), sleep: async () => undefined },
    generateClientId: () => `cli_${"A".repeat(43)}`,
    generateIdempotencyKey: () => "enroll-log-socket-idempotency",
    enrollmentEmail: "Owner@example.com",
    verify: async () => undefined,
    enroll: async () => ({ token: "sr_live_enrollment_secret", accountId: "acc_enrollment" }),
  });
  const stored = await readConfigFile(configPath, fsLike);
  assert.equal(stored?.log_socket, "/tmp/screenrig.sock");
  assert.equal(stored?.token, "sr_live_enrollment_secret");
  await rm(home, { recursive: true, force: true });
});

test("agent connect rewrite keeps log_socket", async () => {
  const home = await testTemp("log-connect-");
  const fsLike = realFs(home);
  const configPath = path.join(home, "screenrig", "config.json");
  await writeConfigAtomic(
    configPath,
    { api_url: "https://api.screenrig.ai", log_socket: "/tmp/screenrig.sock" },
    fsLike,
  );
  const transport = new FakeTransport().on("POST", "/api/v1/agent-connections", () => ({
    status: 500,
    headers: { "content-type": "application/problem+json" },
    body: { status: 500, code: "internal_error", title: "Failed", detail: "boom" },
  }));
  const { logger } = createMemoryLogger({ command: ["agent", "connect"] });
  const result = await withRuntime(["--json", "agent", "connect", "--name", "Office Codex"], transport, {
    fs: fsLike,
    logger,
    openUrl: async () => true,
  });
  assert.notEqual(result.code, 0);
  const stored = await readConfigFile(configPath, fsLike);
  assert.equal(stored?.log_socket, "/tmp/screenrig.sock");
  await rm(home, { recursive: true, force: true });
});

test("preserveLogSocket copies the field onto a sparse rewrite", () => {
  const next = preserveLogSocket(
    { api_url: "https://api.screenrig.ai", log_socket: "/tmp/screenrig.sock", token: "sr_live_secret" },
    { api_url: "https://api.screenrig.ai" },
  );
  assert.equal(next.log_socket, "/tmp/screenrig.sock");
  assert.equal(next.token, undefined);
});
