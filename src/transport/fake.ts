import { createHash } from "node:crypto";
import type {
  Account,
  AccountEvent,
  Capabilities,
  FeedbackKind,
  FeedbackSubmission,
  FeedbackWrite,
  KVEntry,
  KVSummary,
  KVWrite,
  MediaCommit,
  MediaUploadDeclaration,
  Operation,
  Screen,
} from "../adapters/protocol.js";
import type { Transport, TransportRequest, TransportResponse, TransportStream } from "./types.js";

export interface FakeRoute {
  method: string;
  path: string | RegExp;
  handler: (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;
}

function matchPath(route: string | RegExp, path: string): boolean {
  if (typeof route === "string") {
    return route === path;
  }
  return route.test(path);
}

export type FakeStreamOutcome = { chunks: string[]; error?: Error } | Error;

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  private readonly routes: FakeRoute[] = [];
  private readonly streamChunks: string[] = [];
  private readonly streamQueue: FakeStreamOutcome[] = [];
  /** Test hook: awaited after pushed chunks so callers can observe incremental writes. */
  afterStreamChunks?: (req: TransportRequest) => Promise<void>;
  /** Repeating stream hook. Takes precedence over the one-shot queue. */
  streamHandler?: (req: TransportRequest) => Promise<TransportStream>;
  /** Test hook: merged onto every `request` response (not SSE stream frames). */
  extraResponseHeaders?: Record<string, string>;

  on(method: string, path: string | RegExp, handler: FakeRoute["handler"]): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  pushStream(chunk: string): this {
    this.streamChunks.push(chunk);
    return this;
  }

  queueStream(outcome: FakeStreamOutcome): this {
    this.streamQueue.push(outcome);
    return this;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push(req);
    const route = this.routes.find((item) => item.method === req.method && matchPath(item.path, req.path));
    if (!route) {
      return this.withExtraHeaders({
        status: 404,
        headers: { "content-type": "application/problem+json" },
        body: {
          type: "https://screenrig.ai/problems/not-found",
          title: "Not found",
          status: 404,
          detail: `No fake route for ${req.method} ${req.path}`,
          code: "not_found",
        },
      });
    }
    return this.withExtraHeaders(await route.handler(req));
  }

  private withExtraHeaders(response: TransportResponse): TransportResponse {
    if (!this.extraResponseHeaders) {
      return response;
    }
    return { ...response, headers: { ...response.headers, ...this.extraResponseHeaders } };
  }

  async stream(req: TransportRequest): Promise<TransportStream> {
    this.calls.push(req);
    if (this.streamHandler) {
      return this.streamHandler(req);
    }
    if (this.streamQueue.length > 0) {
      const next = this.streamQueue.shift()!;
      if (next instanceof Error) {
        throw next;
      }
      const chunks = next.chunks;
      const error = next.error;
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            yield chunk;
          }
          if (error) {
            throw error;
          }
        },
      };
    }
    const chunks = [...this.streamChunks];
    const after = this.afterStreamChunks;
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
        if (after) await after(req);
        await waitForAbort(req.signal);
      },
    };
  }
}

export function memoryBackend(): FakeTransport {
  const transport = new FakeTransport();
  const operations = new Map<string, Operation>();
  const events: AccountEvent[] = [];
  let account: Account = {
    content_limit_bytes: 0,
    created_at: "2026-08-14T17:00:00.000Z",
    credit_remaining: 0,
    id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA",
    reserved_bytes: 0,
    revision: 1,
    screen_count: 0,
    screen_limit: 100,
    status: "active",
    updated_at: "2026-08-14T17:00:00.000Z",
    used_bytes: 0,
  };
  const applications = new Map<string, Record<string, unknown>>();
  const playlists = new Map<string, Record<string, unknown>>();
  const screens = new Map<string, Screen>();
  const media = new Map<string, Record<string, unknown>>();
  const kv = new Map<string, KVEntry>();

  transport.on("GET", "/.health", () => ({ status: 200, headers: {}, body: { status: "alive" } }));
  transport.on("GET", "/.ready", () => ({ status: 200, headers: {}, body: { status: "ready", degraded: [] } }));
  transport.on("GET", "/.version", () => ({ status: 200, headers: {}, body: { version: "0.2.0", commit: "localhost-mock", api_version: "0.2.0", protocol_version: "1" } }));

  transport.on("GET", "/api/v1/capabilities", () => ({
    status: 200,
    headers: { "x-request-id": "req_AAAAAAAAAAAAAAAAAAAAAAAA" },
    body: {
      account_content_bytes: 0,
      api_version: "0.2.0",
      application_compressed_bytes: 104857600,
      application_expanded_bytes: 262144000,
      application_file_bytes: 33554432,
      application_file_count: 5000,
      application_path_bytes: 255,
      application_path_depth: 16,
      features: { feedback: true },
      media_image_bytes: 20971520,
      playlist_max_items_per_page: 24,
      playlist_max_media_per_selector: 32,
      playlist_max_pages: 100,
      protocol_version: "1",
      screens_per_account: 100,
      transition_max_duration_ms: 60000,
    } satisfies Capabilities,
  }));

  transport.on("POST", "/api/v1/enrollments", (req) => ({
    status: 201,
    headers: {
      "cache-control": "private, no-store",
      "x-request-id": req.headers?.["x-request-id"] ?? "req_enroll",
    },
    body: {
      account,
      token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_id: "iss_AAAAAAAAAAAAAAAAAAAAAAAA",
      issuance_expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));

  transport.on("POST", "/api/v1/screens/pair", (req) => {
    const input = req.body as { code?: string; label?: string } | undefined;
    const label = input?.label ?? "Screen";
    const item: Screen = {
      content_access_generation: 1,
      created_at: "2026-08-14T17:00:00.000Z",
      id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
      public_id: "scr_public_pairing",
      label,
      online: false,
      revision: 1,
      manifest_revision: 1,
      state: "pairing_pending",
      updated_at: "2026-08-14T17:00:00.000Z",
    };
    screens.set(item.id, item);
    return {
      status: 201,
      headers: {
        "cache-control": "private, no-store",
        "x-request-id": req.headers?.["x-request-id"] ?? "req_pairing",
      },
      body: {
        screen: item,
        public_url: "https://play.screenrig.ai/s/scr_public_pairing",
      },
    };
  });

  transport.on("POST", "/api/v1/screens/provision", (req) => {
    const label = (req.body as { label?: string } | undefined)?.label ?? "Browser screen";
    const item: Screen = {
      content_access_generation: 1,
      created_at: "2026-08-15T17:00:00.000Z",
      id: "scr_PROVISIONAAAAAAAAAAAAAA",
      public_id: "browser-provisioned-screen",
      label,
      online: false,
      revision: 1,
      manifest_revision: 1,
      state: "pairing_pending",
      updated_at: "2026-08-15T17:00:00.000Z",
    };
    screens.set(item.id, item);
    return {
      status: 201,
      headers: { "cache-control": "private, no-store", "x-request-id": req.headers?.["x-request-id"] ?? "req_provision" },
      body: {
        screen: item,
        public_url: "https://play.screenrig.ai/s/browser-provisioned-screen",
        provisioning_url: `https://play.screenrig.ai/s/browser-provisioned-screen#provision=${"P".repeat(43)}`,
        expires_at: "2026-08-15T17:10:00.000Z",
      },
    };
  });

  transport.on("POST", "/api/v1/account/browser-links/claim", (req) => ({
    status: 201,
    headers: { "cache-control": "private, no-store", "x-request-id": req.headers?.["x-request-id"] ?? "req_browser_link" },
    body: {
      session_id: "blink_AAAAAAAAAAAAAAAAAAAAAAAA",
      status: "claimed",
      screen: {
        id: "scr_BROWSERLINKAAAAAAAAAAAAA",
        public_id: "browser-link-screen",
        state: "pairing_pending",
        public_url: "https://play.screenrig.ai/s/browser-link-screen",
      },
    },
  }));

  transport.on("POST", "/api/v1/account/dashboard-links", (req) => ({
    status: 201,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-request-id": req.headers?.["x-request-id"] ?? "req_dashboard_link" },
    body: {
      url: `https://dashboard.screenrig.ai/#link=${"D".repeat(43)}`,
      expires_at: "2026-08-14T17:10:00.000Z",
    },
  }));

  transport.on("GET", "/api/v1/account", (req) => ({
    status: 200,
    headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_account" },
    body: account,
  }));

  const playbackItems = [
    {
      screen_id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
      media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA",
      filename: "lobby-loop.mp4",
      day: "2026-08-14",
      play_count: 3,
      last_page_id: "clip",
      last_manifest_revision: "1",
      first_started_at: "2026-08-14T17:00:00.000Z",
      last_started_at: "2026-08-14T17:04:00.000Z",
    },
  ];
  transport.on("GET", "/api/v1/playback", (req) => {
    const screenId = req.query?.screen_id;
    const mediaId = req.query?.media_id;
    const day = req.query?.day;
    const items = playbackItems.filter((item) => {
      if (screenId && item.screen_id !== screenId) return false;
      if (mediaId && item.media_id !== mediaId) return false;
      if (day && item.day !== day) return false;
      return true;
    });
    return {
      status: 200,
      headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_playback" },
      body: { items },
    };
  });

  transport.on("GET", /^\/api\/v1\/operations\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop() ?? "op_unknown";
    const existing = operations.get(id) ?? {
      id,
      kind: "application.upload",
      state: "succeeded" as const,
      request_id: req.headers?.["x-request-id"],
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
    };
    operations.set(id, existing);
    return {
      status: 200,
      headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_op" },
      body: existing,
    };
  });
  transport.on("POST", /^\/api\/v1\/operations\/[^/]+\/cancel$/, (req) => {
    const id = req.path.split("/").at(-2) ?? "op_unknown";
    const current = operations.get(id);
    const operation: Operation = {
      ...(current ?? {
        id,
        kind: "media.upload",
        created_at: "2026-08-14T17:00:00.000Z",
      }),
      state: "cancelled",
      updated_at: "2026-08-14T17:00:01.000Z",
    };
    operations.set(id, operation);
    return { status: 200, headers: {}, body: operation };
  });

  transport.on("GET", "/api/v1/events", (req) => {
    const after = req.query?.after;
    const items = after ? events.filter((event) => event.cursor > after) : events;
    return {
      status: 200,
      headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_events" },
      body: { items, next_cursor: items.at(-1)?.cursor ?? after ?? "" },
    };
  });

  transport.on("POST", "/api/v1/applications", (req) => {
    const id = "app_AAAAAAAAAAAAAAAAAAAAAAAA";
    const releaseId = "rel_AAAAAAAAAAAAAAAAAAAAAAAA";
    const operationId = "op_AAAAAAAAAAAAAAAAAAAAAAAA";
    // An application carries no state of its own. Publish state lives on the
    // operation and the release, and latest_ready_release appears only once a
    // publish reaches ready.
    applications.set(id, {
      id,
      name: req.headers?.["screenrig-application-name"] ?? "uploaded-application",
      revision: 1,
      latest_ready_release: releaseId,
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
    });
    operations.set(operationId, {
      id: operationId,
      kind: "application.upload",
      state: "succeeded",
      request_id: req.headers?.["x-request-id"],
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
      // A published application release reports both identifiers here. An
      // application id cannot be placed in a playlist; the release id can, so
      // the operation result is where the placement's release_id comes from.
      result: { application_id: id, release_id: releaseId },
    });
    return {
      status: 202,
      headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_app" },
      body: { id, release_id: releaseId, operation_id: operationId },
    };
  });

  transport.on("GET", "/api/v1/applications", (req) => ({
    status: 200,
    headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_apps" },
    body: { items: [...applications.values()] },
  }));

  transport.on("GET", /^\/api\/v1\/applications\/[^/]+$/, (req) => ({
    status: 200,
    headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_app_get" },
    body: applications.get(req.path.split("/").pop() ?? "") ?? {
      id: req.path.split("/").pop(),
      name: "application",
      revision: 1,
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:00.000Z",
    },
  }));

  transport.on("POST", "/api/v1/playlists", (req) => {
    const item = { ...(req.body as object), id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA", revision: 1 };
    playlists.set(String(item.id), item);
    return { status: 201, headers: {}, body: item };
  });
  transport.on("GET", "/api/v1/playlists", () => ({ status: 200, headers: {}, body: { items: [...playlists.values()] } }));
  transport.on("GET", /^\/api\/v1\/playlists\/[^/]+$/, (req) => ({ status: 200, headers: {}, body: playlists.get(req.path.split("/").pop() ?? "") }));
  transport.on("PUT", /^\/api\/v1\/playlists\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop() ?? "";
    const item = { ...(req.body as object), id, revision: 2 };
    playlists.set(id, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("DELETE", /^\/api\/v1\/playlists\/[^/]+$/, (req) => {
    playlists.delete(req.path.split("/").pop() ?? "");
    return { status: 204, headers: {}, body: undefined };
  });

  const notFound = (detail: string): TransportResponse => ({
    status: 404,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/not-found",
      title: "Not found",
      status: 404,
      detail,
      code: "not_found",
    },
  });
  const invalidComments = (): TransportResponse => ({
    status: 400,
    headers: { "content-type": "application/problem+json" },
    body: {
      type: "https://screenrig.ai/problems/invalid-request",
      title: "Invalid request",
      status: 400,
      detail: "comments must be a JSON object",
      code: "invalid_request",
    },
  });
  const commentsFromBody = (body: unknown): Record<string, unknown> | undefined => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const comments = (body as { comments?: unknown }).comments;
    if (!comments || typeof comments !== "object" || Array.isArray(comments)) return undefined;
    const compact = JSON.stringify(comments);
    if (Buffer.byteLength(compact, "utf8") > 1024) return undefined;
    return comments as Record<string, unknown>;
  };
  const playlistPage = (playlist: Record<string, unknown> | undefined, pageId: string): Record<string, unknown> | undefined => {
    const pages = playlist?.pages;
    if (!Array.isArray(pages)) return undefined;
    return pages.find((page): page is Record<string, unknown> => (
      Boolean(page) && typeof page === "object" && !Array.isArray(page) && page.id === pageId
    ));
  };

  transport.on("GET", /^\/api\/v1\/comment\/playlist\/[^/]+\/page\/[^/]+$/, (req) => {
    const parts = req.path.split("/");
    const playlist = playlists.get(decodeURIComponent(parts[5] ?? ""));
    const page = playlistPage(playlist, decodeURIComponent(parts[7] ?? ""));
    if (!playlist || !page) return notFound("Playlist page not found");
    return { status: 200, headers: {}, body: { comments: page.comments ?? null } };
  });
  transport.on("PUT", /^\/api\/v1\/comment\/playlist\/[^/]+\/page\/[^/]+$/, (req) => {
    const parts = req.path.split("/");
    const playlist = playlists.get(decodeURIComponent(parts[5] ?? ""));
    const page = playlistPage(playlist, decodeURIComponent(parts[7] ?? ""));
    const comments = commentsFromBody(req.body);
    if (!playlist || !page) return notFound("Playlist page not found");
    if (!comments) return invalidComments();
    page.comments = comments;
    return { status: 200, headers: {}, body: { comments } };
  });
  transport.on("DELETE", /^\/api\/v1\/comment\/playlist\/[^/]+\/page\/[^/]+$/, (req) => {
    const parts = req.path.split("/");
    const playlist = playlists.get(decodeURIComponent(parts[5] ?? ""));
    const page = playlistPage(playlist, decodeURIComponent(parts[7] ?? ""));
    if (!playlist || !page) return notFound("Playlist page not found");
    delete page.comments;
    return { status: 204, headers: {}, body: undefined };
  });
  transport.on("GET", /^\/api\/v1\/comment\/playlist\/[^/]+$/, (req) => {
    const playlist = playlists.get(decodeURIComponent(req.path.split("/").pop() ?? ""));
    if (!playlist) return notFound("Playlist not found");
    return { status: 200, headers: {}, body: { comments: playlist.comments ?? null } };
  });
  transport.on("PUT", /^\/api\/v1\/comment\/playlist\/[^/]+$/, (req) => {
    const playlist = playlists.get(decodeURIComponent(req.path.split("/").pop() ?? ""));
    const comments = commentsFromBody(req.body);
    if (!playlist) return notFound("Playlist not found");
    if (!comments) return invalidComments();
    playlist.comments = comments;
    return { status: 200, headers: {}, body: { comments } };
  });
  transport.on("DELETE", /^\/api\/v1\/comment\/playlist\/[^/]+$/, (req) => {
    const playlist = playlists.get(decodeURIComponent(req.path.split("/").pop() ?? ""));
    if (!playlist) return notFound("Playlist not found");
    delete playlist.comments;
    return { status: 204, headers: {}, body: undefined };
  });
  transport.on("GET", /^\/api\/v1\/comment\/screen\/[^/]+$/, (req) => {
    const screen = screens.get(decodeURIComponent(req.path.split("/").pop() ?? ""));
    if (!screen) return notFound("Screen not found");
    return { status: 200, headers: {}, body: { comments: screen.comments ?? null } };
  });
  transport.on("PUT", /^\/api\/v1\/comment\/screen\/[^/]+$/, (req) => {
    const screen = screens.get(decodeURIComponent(req.path.split("/").pop() ?? ""));
    const comments = commentsFromBody(req.body);
    if (!screen) return notFound("Screen not found");
    if (!comments) return invalidComments();
    screen.comments = comments;
    return { status: 200, headers: {}, body: { comments } };
  });
  transport.on("DELETE", /^\/api\/v1\/comment\/screen\/[^/]+$/, (req) => {
    const screen = screens.get(decodeURIComponent(req.path.split("/").pop() ?? ""));
    if (!screen) return notFound("Screen not found");
    delete screen.comments;
    return { status: 204, headers: {}, body: undefined };
  });

  transport.on("GET", "/api/v1/screens", (req) => {
    const archivedOnly = req.query?.state === "archived";
    const items = [...screens.values()].filter((screen) => (
      archivedOnly ? screen.state === "archived" : screen.state !== "archived"
    ));
    return { status: 200, headers: {}, body: { items } };
  });
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+$/, (req) => ({ status: 200, headers: {}, body: screens.get(req.path.split("/").pop() ?? "") }));
  transport.on("PATCH", /^\/api\/v1\/screens\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop() ?? "";
    const body = req.body as { name?: string; playlist_id?: string; timezone?: string };
    const item = {
      ...(screens.get(id) ?? {
        id,
        public_id: "scr_public",
        label: "Screen",
        manifest_revision: 1,
        content_access_generation: 1,
        created_at: "2026-08-14T17:00:00.000Z",
        online: false,
        state: "pairing_pending" as const,
        updated_at: "2026-08-14T17:00:00.000Z",
      }),
      ...(body.name ? { label: body.name } : {}),
      ...(body.playlist_id ? { playlist_id: body.playlist_id } : {}),
      // A screen has no timezone until one is set, and a patch never clears it.
      ...(body.timezone ? { timezone: body.timezone } : {}),
      revision: 2,
    };
    screens.set(id, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/public-id\/rotate$/, (req) => {
    const id = req.path.split("/")[4] ?? "";
    const current = screens.get(id) as Screen;
    const item: Screen = {
      ...current,
      public_id: "scr_public_rotated",
      revision: current.revision + 1,
      content_access_generation: current.content_access_generation + 1,
      updated_at: "2026-08-14T17:00:01.000Z",
    };
    screens.set(id, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/archive$/, (req) => {
    const id = req.path.split("/")[4] ?? "";
    const current = screens.get(id) as Screen;
    const item: Screen = {
      ...current,
      state: "archived",
      revision: current.revision + 1,
      content_access_generation: current.content_access_generation + 1,
      updated_at: "2026-08-14T17:00:03.000Z",
    };
    screens.set(id, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/unarchive$/, (req) => {
    const id = req.path.split("/")[4] ?? "";
    const current = screens.get(id) as Screen;
    const item: Screen = {
      ...current,
      state: "active",
      revision: current.revision + 1,
      content_access_generation: current.content_access_generation + 1,
      updated_at: "2026-08-14T17:00:04.000Z",
    };
    screens.set(id, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/toast$/, (req) => {
    const body = (req.body ?? {}) as { duration_ms?: number };
    const durationMs = body.duration_ms ?? 10_000;
    return {
      status: 202,
      headers: {
        "cache-control": "no-store",
        "x-request-id": req.headers?.["x-request-id"] ?? "req_toast",
      },
      body: {
        expires_at: new Date(Date.parse("2026-08-14T17:00:00.000Z") + durationMs).toISOString(),
      },
    };
  });
  const screenshotBytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
  const screenshotSha256 = createHash("sha256").update(screenshotBytes).digest("hex");
  const screenshotCaptureId = "shot_AAAAAAAAAAAAAAAA";
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/screenshot$/, (req) => ({
    status: 202,
    headers: {
      "cache-control": "no-store",
      "x-request-id": req.headers?.["x-request-id"] ?? "req_screenshot",
    },
    body: {
      capture_id: screenshotCaptureId,
      expires_at: "2026-08-14T17:00:30.000Z",
    },
  }));
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+\/screenshot\/status$/, () => ({
    status: 200,
    headers: { "cache-control": "no-store" },
    body: {
      state: "ready",
      capture_id: screenshotCaptureId,
      bytes: screenshotBytes.byteLength,
      sha256: screenshotSha256,
      width: 480,
      height: 270,
    },
  }));
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+\/screenshot$/, () => ({
    status: 200,
    headers: {
      "content-type": "image/webp",
      "content-length": String(screenshotBytes.byteLength),
      "cache-control": "private, no-store",
    },
    body: screenshotBytes,
  }));
  transport.on("DELETE", /^\/api\/v1\/screens\/[^/]+$/, (req) => ({
    status: 409,
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": req.headers?.["x-request-id"] ?? "req_delete",
    },
    body: {
      type: "https://screenrig.ai/problems/screen-archive-required",
      title: "Archive the screen instead of deleting or unbinding it",
      status: 409,
      detail: "Archive the screen instead of deleting it.",
      code: "screen_archive_required",
    },
  }));

  transport.on("GET", "/api/v1/media", (req) => {
    const tag = req.query?.tag;
    const kind = req.query?.kind;
    const items = [...media.values()].filter((item) => {
      const record = item as { tag?: string; kind?: string; declaration?: unknown };
      if (record.declaration) return false;
      if (tag && record.tag !== tag) return false;
      if (kind && record.kind !== kind) return false;
      return true;
    });
    return { status: 200, headers: {}, body: { items } };
  });
  transport.on("POST", "/api/v1/media/uploads", (req) => {
    const declaration = req.body as MediaUploadDeclaration;
    const operation: Operation = {
      id: "op_MEDIAAAAAAAAAAAAAAAAAAAAA",
      kind: "media.upload",
      state: "queued",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:00.000Z",
    };
    operations.set(operation.id, operation);
    media.set("upload_MEDIAAAAAAAAAAAAAAAAAA", { declaration });
    return {
      status: 201,
      headers: { "cache-control": "private, no-store" },
      body: {
        id: "upload_MEDIAAAAAAAAAAAAAAAAAA",
        operation,
        upload_url: "https://storage.example.invalid/signed/private-upload",
        method: "PUT",
        headers: {
          "content-type": declaration.content_type,
          "content-length": String(declaration.bytes),
          "x-amz-meta-screenrig-sha256": declaration.sha256,
        },
        expires_at: "2099-08-14T17:05:00.000Z",
      },
    };
  });
  transport.on("POST", /^\/api\/v1\/media\/uploads\/[^/]+\/commit$/, (req) => {
    const uploadId = req.path.split("/").at(-2) ?? "";
    const stored = media.get(uploadId) as { declaration: MediaUploadDeclaration };
    const commit = req.body as MediaCommit;
    const id = "med_AAAAAAAAAAAAAAAAAAAAAAAA";
    const operationId = "op_MEDIAAAAAAAAAAAAAAAAAAAAA";
    const item = {
      id,
      filename: stored.declaration.filename,
      kind: commit.content_type.startsWith("image/") ? "image" : "video",
      content_type: commit.content_type,
      operation_id: operationId,
      sha256: commit.sha256,
      bytes: commit.bytes,
      ...(stored.declaration.tag ? { tag: stored.declaration.tag } : {}),
      revision: 1,
      state: "ready",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
    };
    media.delete(uploadId);
    media.set(id, item);
    const operation: Operation = {
      id: operationId,
      kind: "media.upload",
      state: "succeeded",
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
      result: { media_id: id },
    };
    operations.set(operationId, operation);
    return { status: 202, headers: {}, body: operation };
  });
  transport.on("GET", /^\/api\/v1\/media\/[^/]+$/, (req) => ({
    status: 200,
    headers: { etag: '"1"' },
    body: media.get(req.path.split("/").pop() ?? ""),
  }));
  transport.on("PATCH", /^\/api\/v1\/media\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop() ?? "";
    const current = (media.get(id) ?? { id, revision: 1 }) as Record<string, unknown>;
    const patch = (req.body ?? {}) as { tag?: string | null };
    const item: Record<string, unknown> = { ...current, revision: Number(current.revision ?? 1) + 1 };
    if (patch.tag === null) {
      delete item.tag;
    } else if (typeof patch.tag === "string") {
      item.tag = patch.tag;
    }
    media.set(id, item);
    return { status: 200, headers: { etag: `"${item.revision}"` }, body: item };
  });
  transport.on("DELETE", /^\/api\/v1\/media\/[^/]+$/, (req) => {
    media.delete(req.path.split("/").pop() ?? "");
    return { status: 204, headers: {}, body: undefined };
  });
  transport.on("GET", /^\/api\/v1\/applications\/[^/]+\/kv$/, (req) => {
    const applicationId = req.path.split("/")[4] ?? "";
    const items: KVSummary[] = [...kv.values()]
      .filter((entry) => entry.application_id === applicationId)
      .map(({ value_base64: _value, ...summary }) => summary);
    return { status: 200, headers: {}, body: { items } };
  });
  transport.on("GET", /^\/api\/v1\/applications\/[^/]+\/kv\/[^/]+$/, (req): TransportResponse => {
    const parts = req.path.split("/");
    const storageKey = `${parts[4]}:${decodeURIComponent(parts[6] ?? "")}`;
    const entry = kv.get(storageKey);
    if (entry) return { status: 200, headers: {}, body: entry };
    return {
      status: 404,
      headers: { "content-type": "application/problem+json" },
      body: { type: "https://screenrig.ai/problems/not-found", title: "Not found", status: 404, detail: "K/V key not found", code: "not_found" },
    };
  });
  transport.on("PUT", /^\/api\/v1\/applications\/[^/]+\/kv\/[^/]+$/, (req): TransportResponse => {
    const parts = req.path.split("/");
    const applicationId = parts[4] ?? "";
    const key = decodeURIComponent(parts[6] ?? "");
    const storageKey = `${applicationId}:${key}`;
    const previous = kv.get(storageKey);
    const ifMatch = req.headers?.["if-match"];
    if (previous && ifMatch !== `"${previous.revision}"`) {
      return {
        status: 412,
        headers: { "content-type": "application/problem+json" },
        body: {
          type: "https://screenrig.ai/problems/revision-conflict",
          title: "Resource revision does not match",
          status: 412,
          detail: "K/V entry changed after it was read.",
          code: "revision_conflict",
          current_revision: previous.revision,
        },
      };
    }
    const body = req.body as KVWrite;
    const bytes = Buffer.from(body.value_base64, "base64");
    const item: KVEntry = {
      application_id: applicationId,
      key,
      value_base64: bytes.toString("base64"),
      content_type: body.content_type,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      revision: (previous?.revision ?? 0) + 1,
    };
    kv.set(storageKey, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("DELETE", /^\/api\/v1\/applications\/[^/]+\/kv\/[^/]+$/, (req) => {
    const parts = req.path.split("/");
    kv.delete(`${parts[4]}:${decodeURIComponent(parts[6] ?? "")}`);
    return { status: 204, headers: {}, body: undefined };
  });

  // Feedback: account-scoped, immutable, and keyed by route rather than body.
  let feedbackSequence = 0;
  const submitFeedback = (kind: FeedbackKind) => (req: { body?: unknown }) => {
    const write = (req.body ?? {}) as FeedbackWrite;
    feedbackSequence += 1;
    const submission: FeedbackSubmission = {
      id: `fb_${String(feedbackSequence).padStart(24, "A")}`,
      kind,
      title: write.title,
      body: write.body,
      ...(write.context ? { context: write.context } : {}),
      created_at: `2026-08-16T09:0${feedbackSequence % 10}:00.000Z`,
    };
    feedback.get(kind)?.unshift(submission);
    return { status: 201, headers: {}, body: submission as unknown as Record<string, unknown> };
  };
  const feedback = new Map<FeedbackKind, FeedbackSubmission[]>([
    ["bug", []],
    ["feature", []],
  ]);
  transport.on("POST", "/api/v1/feedback/bugs", submitFeedback("bug"));
  transport.on("POST", "/api/v1/feedback/features", submitFeedback("feature"));
  transport.on("GET", "/api/v1/feedback/bugs", () => ({
    status: 200,
    headers: {},
    body: { items: feedback.get("bug") ?? [] },
  }));
  transport.on("GET", "/api/v1/feedback/features", () => ({
    status: 200,
    headers: {},
    body: { items: feedback.get("feature") ?? [] },
  }));

  return transport;
}
