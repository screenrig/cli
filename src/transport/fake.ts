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

export class FakeTransport implements Transport {
  readonly calls: TransportRequest[] = [];
  private readonly routes: FakeRoute[] = [];
  private readonly streamChunks: string[] = [];

  on(method: string, path: string | RegExp, handler: FakeRoute["handler"]): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  pushStream(chunk: string): this {
    this.streamChunks.push(chunk);
    return this;
  }

  async request(req: TransportRequest): Promise<TransportResponse> {
    this.calls.push(req);
    const route = this.routes.find((item) => item.method === req.method && matchPath(item.path, req.path));
    if (!route) {
      return {
        status: 404,
        headers: { "content-type": "application/problem+json" },
        body: {
          type: "https://screenrig.ai/problems/not-found",
          title: "Not found",
          status: 404,
          detail: `No fake route for ${req.method} ${req.path}`,
          code: "not_found",
        },
      };
    }
    return route.handler(req);
  }

  async stream(req: TransportRequest): Promise<TransportStream> {
    this.calls.push(req);
    const chunks = [...this.streamChunks];
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  }
}

export function memoryBackend(): FakeTransport {
  const transport = new FakeTransport();
  const operations = new Map<string, Operation>();
  const events: AccountEvent[] = [];
  let account: Account = {
    content_limit_bytes: 104857600,
    created_at: "2026-08-14T17:00:00.000Z",
    id: "acc_AAAAAAAAAAAAAAAAAAAAAAAA",
    reserved_bytes: 0,
    revision: 1,
    screen_count: 0,
    screen_limit: 50,
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
      account_content_bytes: 104857600,
      api_version: "0.2.0",
      application_compressed_bytes: 104857600,
      application_expanded_bytes: 262144000,
      application_file_bytes: 33554432,
      application_file_count: 5000,
      application_path_bytes: 255,
      application_path_depth: 16,
      features: { feedback: true },
      playlist_max_items_per_page: 24,
      playlist_max_pages: 100,
      protocol_version: "1",
      screens_per_account: 50,
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

  transport.on("GET", "/api/v1/account", (req) => ({
    status: 200,
    headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_account" },
    body: account,
  }));

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
    const operationId = "op_AAAAAAAAAAAAAAAAAAAAAAAA";
    applications.set(id, { id, name: "uploaded-application", revision: 1, state: "processing" });
    operations.set(operationId, {
      id: operationId,
      kind: "application.upload",
      state: "succeeded",
      request_id: req.headers?.["x-request-id"],
      created_at: "2026-08-14T17:00:00.000Z",
      updated_at: "2026-08-14T17:00:01.000Z",
      result: { application_id: id },
    });
    return { status: 202, headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_app" }, body: { id, operation_id: operationId } };
  });

  transport.on("GET", "/api/v1/applications", (req) => ({
    status: 200,
    headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_apps" },
    body: { items: [...applications.values()] },
  }));

  transport.on("GET", /^\/api\/v1\/applications\/[^/]+$/, (req) => ({
    status: 200,
    headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_app_get" },
    body: applications.get(req.path.split("/").pop() ?? "") ?? { id: req.path.split("/").pop(), name: "application", revision: 1, state: "ready" },
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

  transport.on("GET", "/api/v1/screens", () => ({ status: 200, headers: {}, body: { items: [...screens.values()] } }));
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+$/, (req) => ({ status: 200, headers: {}, body: screens.get(req.path.split("/").pop() ?? "") }));
  transport.on("PATCH", /^\/api\/v1\/screens\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop() ?? "";
    const body = req.body as { name?: string; playlist_id?: string };
    const item = {
      ...(screens.get(id) ?? {
        id,
        public_id: "scr_public",
        label: "Screen",
        manifest_revision: 1,
        content_access_generation: 1,
        created_at: "2026-08-14T17:00:00.000Z",
        state: "pairing_pending" as const,
        updated_at: "2026-08-14T17:00:00.000Z",
      }),
      ...(body.name ? { label: body.name } : {}),
      ...(body.playlist_id ? { playlist_id: body.playlist_id } : {}),
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
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/credential\/revoke$/, (req) => {
    const id = req.path.split("/")[4] ?? "";
    const current = screens.get(id) as Screen;
    const item: Screen = {
      ...current,
      revision: current.revision + 1,
      content_access_generation: current.content_access_generation + 1,
      state: "pairing_pending",
      updated_at: "2026-08-14T17:00:02.000Z",
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
  transport.on("DELETE", /^\/api\/v1\/screens\/[^/]+$/, (req) => {
    screens.delete(req.path.split("/").pop() ?? "");
    return { status: 204, headers: {}, body: undefined };
  });

  transport.on("GET", "/api/v1/media", () => ({ status: 200, headers: {}, body: { items: [...media.values()] } }));
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
