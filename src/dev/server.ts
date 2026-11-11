import http from "node:http";
import { harnessCsp, releaseCsp } from "./csp.js";
import { appOrigin, parseHostHeader, playerOrigin, PLAYER_HOST } from "./origins.js";
import { harnessCss, harnessHtml, harnessScript } from "./page.js";
import { lookupFile } from "./release.js";
import { CommandError, type DevSession, type ServerEvent } from "./session.js";

const MAX_BODY_BYTES = 256 * 1024;
const HEARTBEAT_MS = 15_000;

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new BodyError(413, "The request body is over 256 KiB.")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new BodyError(400, "The request body is not JSON.")); }
    });
    request.on("error", reject);
  });
}

function send(response: http.ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}, head = false): void {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  response.writeHead(status, { "content-type": type, "content-length": bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
  response.end(head ? undefined : bytes);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value));
}

/**
 * The one local server: the application's release on its own host and the
 * harness page on the Player host, routed by the Host header and bound to
 * loopback only. A request for any other host is refused, which also closes
 * the door on DNS rebinding.
 */
export function createDevServer(session: DevSession): http.Server {
  const { port, releaseHost } = session.options;
  const player = playerOrigin(port);
  const app = appOrigin(releaseHost, port);

  function harness(request: http.IncomingMessage, response: http.ServerResponse, path: string): void {
    const head = request.method === "HEAD";
    if (request.method === "POST") { void post(request, response, path); return; }
    if (request.method !== "GET" && !head) { send(response, 405, "text/plain; charset=utf-8", "Method not allowed.\n", { allow: "GET, HEAD, POST" }); return; }
    const security = { "content-security-policy": harnessCsp(app) };
    switch (path) {
      case "/":
      case "/index.html": send(response, 200, "text/html; charset=utf-8", harnessHtml(), security, head); return;
      case "/_dev/harness.js": send(response, 200, "text/javascript; charset=utf-8", harnessScript(), security, head); return;
      case "/_dev/harness.css": send(response, 200, "text/css; charset=utf-8", harnessCss(), security, head); return;
      case "/_dev/state": sendJson(response, 200, session.snapshot()); return;
      case "/_dev/log": sendJson(response, 200, session.log); return;
      case "/_dev/kv": void session.kvView().then((view) => sendJson(response, 200, view), () => sendJson(response, 500, { ok: false, error: "The stored values could not be read." })); return;
      case "/_dev/events": stream(request, response); return;
      case "/favicon.ico": response.writeHead(204).end(); return;
      default: send(response, 404, "text/plain; charset=utf-8", "Not found.\n");
    }
  }

  function stream(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    response.write("retry: 1000\n\n");
    const write = (event: ServerEvent): void => { response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`); };
    session.clients.add(write);
    write({ event: "state", data: { ...session.snapshot(), log: session.log } });
    const beat = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
    beat.unref();
    request.on("close", () => { clearInterval(beat); session.clients.delete(write); });
  }

  async function post(request: http.IncomingMessage, response: http.ServerResponse, path: string): Promise<void> {
    // Only the harness page itself may drive the session: a page the application
    // opens (or any other site) cannot post here from another origin.
    if (request.headers.origin !== player || (request.headers["sec-fetch-site"] !== undefined && request.headers["sec-fetch-site"] !== "same-origin")) {
      sendJson(response, 403, { ok: false, error: "Only the harness page may send commands." });
      return;
    }
    if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { ok: false, error: "Send JSON." });
      return;
    }
    try {
      const body = await readBody(request);
      if (path === "/_dev/message") {
        const message = body as { data?: unknown; origin?: unknown };
        if (typeof message !== "object" || message === null || typeof message.origin !== "string") throw new BodyError(400, "A relayed message names its origin.");
        await session.fromApp(message.data, message.origin);
        sendJson(response, 200, { ok: true });
      } else if (path === "/_dev/command") {
        sendJson(response, 200, { ok: true, result: await session.command(body) });
      } else {
        sendJson(response, 404, { ok: false, error: "Not found." });
      }
    } catch (error) {
      if (error instanceof BodyError) sendJson(response, error.status, { ok: false, error: error.message });
      else if (error instanceof CommandError) sendJson(response, 400, { ok: false, error: error.message });
      else sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function release(request: http.IncomingMessage, response: http.ServerResponse, rawUrl: string): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed.\n", { allow: "GET, HEAD" });
      return;
    }
    const head = request.method === "HEAD";
    const built = session.release;
    if (!built) {
      const refusal = session.refusal;
      send(response, 503, "text/plain; charset=utf-8", `The application directory was refused: ${refusal?.detail ?? "it has not been built yet"}\n`, {}, head);
      return;
    }
    const file = lookupFile(built, new URL(rawUrl, "http://dev.invalid").pathname);
    if (!file) { send(response, 404, "text/plain; charset=utf-8", "Release asset was not found.\n", { "content-security-policy": releaseCsp(player) }, head); return; }
    send(response, 200, file.type, file.data, { etag: file.etag, "content-security-policy": releaseCsp(player) }, head);
  }

  return http.createServer((request, response) => {
    const host = parseHostHeader(request.headers.host);
    const rawUrl = request.url ?? "/";
    if (!host || host.port !== String(port) || rawUrl.startsWith("//")) {
      send(response, 421, "text/plain; charset=utf-8", `Open ${player}/ in a browser: the harness answers only its own hosts.\n`);
      return;
    }
    if (host.hostname === PLAYER_HOST) harness(request, response, new URL(rawUrl, "http://dev.invalid").pathname);
    else if (host.hostname === releaseHost) release(request, response, rawUrl);
    else send(response, 421, "text/plain; charset=utf-8", `Open ${player}/ in a browser: the harness answers only its own hosts.\n`);
  });
}
