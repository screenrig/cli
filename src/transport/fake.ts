import { createHash } from "node:crypto";
import type {
  Project,
  ProjectEvent,
  CLIEnrollmentRequest,
  Invitation,
  InvitationCreate,
  InvitationIssued,
  Agent,
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
import type {
  Transport,
  TransportDownloadResponse,
  TransportRequest,
  TransportResponse,
  TransportStream,
} from "./types.js";

export interface FakeRoute {
  method: string;
  path: string | RegExp;
  handler: (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;
}

export interface FakeDownloadRoute {
  method: string;
  path: string | RegExp;
  handler: (req: TransportRequest) => TransportDownloadResponse | Promise<TransportDownloadResponse>;
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
  private readonly downloadRoutes: FakeDownloadRoute[] = [];
  private readonly streamChunks: string[] = [];
  private readonly streamQueue: FakeStreamOutcome[] = [];
  /** Test hook: awaited after pushed chunks so callers can observe incremental writes. */
  afterStreamChunks?: (req: TransportRequest) => Promise<void>;
  /** Repeating stream hook. Takes precedence over the one-shot queue. */
  streamHandler?: (req: TransportRequest) => Promise<TransportStream>;
  /** memoryBackend hook: remaining playback-export requests before 429. */
  setPlaybackExportBudget?: (value: number) => void;
  /** Test hook: merged onto every `request` response (not SSE stream frames). */
  extraResponseHeaders?: Record<string, string>;

  on(method: string, path: string | RegExp, handler: FakeRoute["handler"]): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  onDownload(method: string, path: string | RegExp, handler: FakeDownloadRoute["handler"]): this {
    this.downloadRoutes.push({ method, path, handler });
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

  async download(req: TransportRequest): Promise<TransportDownloadResponse> {
    this.calls.push(req);
    const route = this.downloadRoutes.find((item) => item.method === req.method && matchPath(item.path, req.path));
    if (!route) {
      return {
        status: 404,
        headers: { "content-type": "application/problem+json" },
        problem: {
          type: "https://screenrig.ai/problems/not-found",
          title: "Not found",
          status: 404,
          detail: `No fake download route for ${req.method} ${req.path}`,
          code: "not_found",
        },
      };
    }
    return route.handler(req);
  }
}

/** `now` drives clock-dependent checks (takeover until); defaults to the real clock. */
export function memoryBackend(options: { now?: () => Date } = {}): FakeTransport {
  const clock = options.now ?? (() => new Date());
  const transport = new FakeTransport();
  const operations = new Map<string, Operation>();
  const events: ProjectEvent[] = [];
  let project: Project = {
    content_limit_bytes: 0,
    created_at: "2026-08-14T17:00:00.000Z",
    credit_remaining: 0,
    email: "owner@example.com",
    email_verified: false,
    feature_revision: 1,
    features: { advertiser: false, screens: true },
    id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "Amber Acorn",
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
  const currentAgent: Agent = {
    id: "agt_AAAAAAAAAAAAAAAAAAAAAAAA",
    name: "ScreenRig CLI",
    agent_type: "cli",
    platform: "test/mock",
    version: "0.1.0",
    state: "active",
    authenticated_requests: 1,
    metered_credits: 0,
    created_at: "2026-08-14T17:00:00.000Z",
    connected_at: "2026-08-14T17:00:00.000Z",
  };
  const invitations = new Map<string, Invitation>();
  const enrollmentReplays = new Map<string, { request: string; response: TransportResponse }>();
  const invitationReplays = new Map<string, { request: string; response: TransportResponse }>();
  let projectSequence = 0;
  let invitationSequence = 0;
  const privateHeaders = { "cache-control": "private, no-store" };
  const problem = (status: number, code: string, detail: string): TransportResponse => ({
    status,
    headers: { ...privateHeaders, "content-type": "application/problem+json" },
    body: { status, code, title: "Request refused", detail },
  });
  const issueInvitation = (
    kind: Invitation["kind"],
    delivery: Invitation["delivery"],
    email?: string,
    advertising?: Invitation["advertising"],
  ): Invitation => {
    const existing = delivery === "email" ? [...invitations.values()].find((item) =>
      item.project_id === project.id && item.kind === kind
      && item.recipient_email?.toLowerCase() === email?.toLowerCase()
      && (item.status === "queued" || item.status === "sent")) : undefined;
    if (existing) return existing;
    const item: Invitation = {
      id: `inv_${String(++invitationSequence).padStart(24, "0")}`,
      project_id: project.id,
      kind,
      delivery,
      status: delivery === "link" ? "issued" : "queued",
      created_at: "2026-08-14T17:00:00.000Z",
      expires_at: delivery === "link" ? "2026-08-15T17:00:00.000Z" : "2026-08-21T17:00:00.000Z",
      ...(email ? { recipient_email: email } : {}),
      ...(advertising ? { advertising } : {}),
    };
    invitations.set(item.id, item);
    return item;
  };

  transport.on("GET", "/.health", () => ({ status: 200, headers: {}, body: { status: "alive" } }));
  transport.on("GET", "/.ready", () => ({ status: 200, headers: {}, body: { status: "ready", degraded: [] } }));
  transport.on("GET", "/.version", () => ({ status: 200, headers: {}, body: { version: "0.2.0", commit: "localhost-mock", api_version: "0.2.0", protocol_version: "1" } }));

  transport.on("GET", "/api/v1/capabilities", () => ({
    status: 200,
    headers: { "x-request-id": "req_AAAAAAAAAAAAAAAAAAAAAAAA" },
    body: {
      project_content_bytes: 0,
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
      screens_per_project: 100,
      transition_max_duration_ms: 60000,
    } satisfies Capabilities,
  }));

  transport.on("POST", "/api/v1/enrollments", (req): TransportResponse => {
    const input = req.body as CLIEnrollmentRequest | undefined;
    const email = input?.email;
    const replayKey = req.headers?.["idempotency-key"];
    const request = JSON.stringify(req.body);
    const replay = replayKey ? enrollmentReplays.get(replayKey) : undefined;
    if (replay) {
      return replay.request === request ? replay.response
        : problem(409, "idempotency_mismatch", "The enrollment request changed.");
    }
    if (typeof email !== "string") {
      return {
        status: 400,
        headers: { "content-type": "application/problem+json" },
        body: { status: 400, code: "invalid_request", title: "Invalid request", detail: "A contact email is required." },
      };
    }
    projectSequence += 1;
    project = {
      ...project,
      id: projectSequence === 1 ? "prj_AAAAAAAAAAAAAAAAAAAAAAAA" : `prj_${String(projectSequence).padStart(24, "0")}`,
      name: input?.project_name ?? `Amber Acorn ${projectSequence}`,
      email,
      features: input?.intent === "advertising"
        ? { advertiser: true, screens: false } : { advertiser: false, screens: true },
      revision: 1,
      feature_revision: 1,
      used_bytes: 0,
      reserved_bytes: 0,
      screen_count: 0,
    };
    const invitation = issueInvitation("project_member", "email", email);
    const response: TransportResponse = {
      status: 201,
      headers: {
        "cache-control": "private, no-store",
        "x-request-id": req.headers?.["x-request-id"] ?? "req_enroll",
      },
      body: {
        project,
        invitation: { id: invitation.id, status: invitation.status, expires_at: invitation.expires_at },
        agent: currentAgent,
        connection_ready: false,
        token: "sr_live_tokidAAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        issuance_id: "iss_AAAAAAAAAAAAAAAAAAAAAAAA",
        issuance_expires_at: "2026-08-14T17:10:00.000Z",
      },
    };
    if (replayKey) enrollmentReplays.set(replayKey, { request, response });
    return response;
  });

  transport.on("GET", "/api/v1/agents/self", () => ({
    status: 200,
    headers: { "cache-control": "private, no-store", "x-request-id": "req_agent_selfAAAAAAAAAAAA" },
    body: { agent: currentAgent, connection_ready: false },
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

  transport.on("POST", "/api/v1/project/browser-links/claim", (req) => ({
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

  transport.on("GET", "/api/v1/project", (req) => ({
    status: 200,
    headers: { ...privateHeaders, etag: `"${project.revision}"`, "x-request-id": req.headers?.["x-request-id"] ?? "req_project" },
    body: project,
  }));
  transport.on("PATCH", "/api/v1/project", (req) => {
    const name = (req.body as { name?: string } | undefined)?.name;
    if (typeof name !== "string" || !name.trim() || [...name.trim()].length > 60) {
      return problem(400, "invalid_request", "A project name of 1 to 60 characters is required.");
    }
    project = { ...project, name: name.trim(), revision: project.revision + 1 };
    return { status: 200, headers: { ...privateHeaders, etag: `"${project.revision}"` }, body: project };
  });
  transport.on("GET", "/api/v1/project/capabilities", () => ({
    status: 200,
    headers: privateHeaders,
    body: {
      project_id: project.id,
      plan_id: "default",
      features: project.features,
      feature_revision: project.feature_revision,
      capabilities: [
        "media", "credits",
        ...(project.features?.screens ? ["signage.pairing", "signage.playlists", "signage.publish"] : []),
        ...(project.features?.advertiser ? ["advertising"] : []),
      ],
    },
  }));
  transport.on("POST", "/api/v1/invitations", (req) => {
    const input = req.body as InvitationCreate | undefined;
    const delivery = input?.delivery ?? "email";
    if (!input || !["project_member", "ad_buyer"].includes(input.kind)
      || (delivery !== "email" && delivery !== "link")
      || (delivery === "link" && (input.kind !== "project_member" || input.emails !== undefined))
      || (delivery === "email" && (!input.emails?.length || input.emails.some((email) => !email.includes("@"))))
      || (input.kind === "ad_buyer" && !input.advertising)
      || (input.kind === "project_member" && input.advertising !== undefined)) {
      return problem(400, "invalid_request", "Invalid invitation request.");
    }
    const replayKey = req.headers?.["idempotency-key"];
    const request = JSON.stringify(req.body);
    const replay = replayKey ? invitationReplays.get(replayKey) : undefined;
    if (replay) return replay.request === request ? replay.response
      : problem(409, "idempotency_mismatch", "The invitation request changed.");
    const issued: InvitationIssued[] = delivery === "link"
      ? [issueInvitation(input.kind, delivery)]
      : input.emails!.map((email) => issueInvitation(input.kind, delivery, email, input.advertising));
    const response: TransportResponse = {
      status: 201,
      headers: privateHeaders,
      body: { invitations: issued.map((item) => {
        if (item.delivery !== "link") return item;
        const link = new URL("/invite", "https://dashboard.screenrig.ai");
        link.hash = `token=${createHash("sha256").update(item.id).digest("base64url")}`;
        return { ...item, url: link.href };
      }) },
    };
    if (replayKey) invitationReplays.set(replayKey, { request, response });
    return response;
  });
  transport.on("GET", "/api/v1/invitations", (req) => ({
    status: 200,
    headers: privateHeaders,
    body: {
      items: [...invitations.values()].filter((item) => item.project_id === project.id
        && (!req.query?.kind || item.kind === req.query.kind)
        && (!req.query?.status || item.status === req.query.status)),
      next_cursor: "",
    },
  }));
  transport.on("POST", /^\/api\/v1\/invitations\/[^/]+\/revoke$/, (req) => {
    const id = req.path.split("/")[4] ?? "";
    const item = invitations.get(id);
    if (!item || item.project_id !== project.id) return problem(404, "not_found", "Invitation not found.");
    if (item.status === "accepted") return problem(409, "invitation_consumed", "The invitation was already accepted.");
    invitations.set(id, { ...item, status: "revoked" });
    return { status: 204, headers: privateHeaders, body: undefined };
  });
  transport.on("POST", "/api/v1/sign-in-resets", () => ({
    status: 202, headers: privateHeaders, body: { status: "accepted" },
  }));

  const aggregateMatches = (item: { screen_id: string; media_id: string; day: string }, req: TransportRequest) => {
    const q = req.query ?? {};
    return (!q.screen_id || item.screen_id === q.screen_id) && (!q.media_id || item.media_id === q.media_id)
      && (!q.day || item.day === q.day) && (!q.day_from || item.day >= q.day_from) && (!q.day_to || item.day <= q.day_to);
  };
  const playbackItems = [
    {
      screen_id: "scr_PAIRINGAAAAAAAAAAAAAAAA",
      media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA",
      filename: "lobby-loop.mp4",
      primitive: "video",
      day: "2026-08-14",
      play_count: 3,
      last_page_id: "clip",
      last_manifest_revision: "1",
      first_started_at: "2026-08-14T17:00:00.000Z",
      last_started_at: "2026-08-14T17:04:00.000Z",
    },
  ];
  transport.on("GET", "/api/v1/playback", (req) => {
    if (req.query?.format === "csv") return aggregatesCsv(req);
    if (req.query?.day && (req.query.day_from || req.query.day_to)) return playbackInvalid(req, "day excludes day_from and day_to");
    const items = playbackItems.filter((item) => aggregateMatches(item, req));
    return {
      status: 200,
      headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_playback" },
      body: { items },
    };
  });

  // Per-play records (GET /api/v1/playback/plays): received_at window, filters,
  // pc_<offset> cursors, and the fixed-header CSV stream.
  const playItems = [0, 1, 2, 3, 4].map((index) => ({
    screen_id: index === 3 ? "scr_LOBBYBBBBBBBBBBBBBBBBBB" : "scr_PAIRINGAAAAAAAAAAAAAAAA",
    playlist_id: "pl_AAAAAAAAAAAAAAAAAAAAAAAA",
    page_id: index % 2 === 0 ? "clip" : "poster",
    media_id: index % 2 === 0 ? "med_AAAAAAAAAAAAAAAAAAAAAAAA" : "med_BBBBBBBBBBBBBBBBBBBBBBBB",
    primitive: index % 2 === 0 ? "video" : "image",
    ...(index === 4 ? { primitive_id: "=hero", started_at: "2026-08-14T16:39:59Z" } : {}),
    received_at: `2026-08-14T16:${String(index * 10).padStart(2, "0")}:00Z`,
    screen_tags: index === 3 ? ["Lobby"] : [],
  }));
  const csvCell = (value: unknown): string => {
    let text = value === undefined || value === null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
  };
  const csvBody = (columns: string[], rows: Array<Record<string, unknown>>): string =>
    [columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].map((line) => `${line}\r\n`).join("");
  // playback-export-project: 30 per window (the fake window never resets).
  let exportBudget = 30;
  const spendExport = (req: TransportRequest): TransportResponse | Record<string, string> => {
    if (exportBudget === 0) {
      return {
        status: 429,
        headers: { "content-type": "application/problem+json", "retry-after": "42", ratelimit: '"playback-export-project";r=0;t=42' },
        body: { type: "https://screenrig.ai/problems/rate_limited", title: "Too many requests", status: 429, detail: "The playback export budget is spent.", code: "rate_limited" },
      };
    }
    exportBudget -= 1;
    return { ratelimit: `"playback-export-project";r=${exportBudget};t=60, "playback-export-ip";r=${exportBudget + 30};t=60`, "x-request-id": req.headers?.["x-request-id"] ?? "req_playback" };
  };
  transport.setPlaybackExportBudget = (value: number) => { exportBudget = value; };
  const csvHeaders = (req: TransportRequest, filename: string) => ({
    "content-type": "text/csv; charset=utf-8; header=present",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
    "x-request-id": req.headers?.["x-request-id"] ?? "req_playback",
  });
  const playbackInvalid = (req: TransportRequest, detail: string): TransportResponse => ({
    status: 400,
    headers: { "content-type": "application/problem+json", "x-request-id": req.headers?.["x-request-id"] ?? "req_playback" },
    body: { type: "https://screenrig.ai/problems/invalid_request", title: "Invalid request", status: 400, detail, code: "invalid_request" },
  });
  const wantsCsv = (req: TransportRequest) => req.query?.format === "csv";
  const playsSelection = (req: TransportRequest): TransportResponse | { rows: typeof playItems; start: number } => {
    const q = req.query ?? {};
    const to = q.to ? Date.parse(q.to) : clock().getTime();
    const from = q.from ? Date.parse(q.from) : to - 86_400_000;
    if (!Number.isFinite(to) || !Number.isFinite(from)) return playbackInvalid(req, "from must be an RFC 3339 date-time");
    if (from >= to) return playbackInvalid(req, "from must be before to");
    if (to - from > 31 * 86_400_000) return playbackInvalid(req, "the range from to to must be at most 31 days");
    if (q.limit !== undefined && wantsCsv(req)) return playbackInvalid(req, "limit is not allowed with CSV; the export streams the whole range");
    if (q.cursor !== undefined && !/^pc_\d+$/.test(q.cursor)) return playbackInvalid(req, "cursor is not a plays cursor");
    const rows = playItems.filter((item) => {
      const at = Date.parse(item.received_at);
      return at >= from && at < to
        && (!q.screen_id || item.screen_id === q.screen_id)
        && (!q.media_id || item.media_id === q.media_id)
        && (!q.tag || item.screen_tags.includes(q.tag));
    });
    return { rows, start: q.cursor ? Number(q.cursor.slice(3)) : 0 };
  };
  const PLAY_COLUMNS = ["screen_id", "playlist_id", "page_id", "primitive_id", "media_id", "primitive", "started_at", "received_at"];
  const AGGREGATE_COLUMNS = ["screen_id", "media_id", "filename", "primitive", "day", "play_count", "last_page_id", "last_manifest_revision", "first_started_at", "last_started_at"];
  const playsCsv = (req: TransportRequest): TransportResponse => {
    const selected = playsSelection(req);
    if ("status" in selected) return selected;
    const budget = spendExport(req);
    if ("status" in budget) return budget as TransportResponse;
    return { status: 200, headers: { ...csvHeaders(req, "playback-plays.csv"), ...budget }, body: csvBody(PLAY_COLUMNS, selected.rows.slice(selected.start)) };
  };
  const bytesOf = (response: TransportResponse) => {
    const bytes = new TextEncoder().encode(String(response.body));
    return {
      async *[Symbol.asyncIterator]() {
        // Split so record boundaries fall inside chunks.
        for (let offset = 0; offset < bytes.byteLength; offset += 7) yield bytes.subarray(offset, offset + 7);
      },
    };
  };
  const asDownload = (response: TransportResponse): TransportDownloadResponse => response.status >= 400
    ? { status: response.status, headers: response.headers, problem: response.body }
    : { status: response.status, headers: response.headers, body: bytesOf(response) };
  transport.on("GET", "/api/v1/playback/plays", (req) => {
    if (wantsCsv(req)) return playsCsv(req);
    const selected = playsSelection(req);
    if ("status" in selected) return selected;
    const limit = req.query?.limit === undefined ? 200 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return playbackInvalid(req, "limit must be between 1 and 1000");
    const budget = spendExport(req);
    if ("status" in budget) return budget as TransportResponse;
    const items = selected.rows.slice(selected.start, selected.start + limit).map(({ screen_tags: _tags, ...play }) => play);
    const end = selected.start + items.length;
    return {
      status: 200,
      headers: { "cache-control": "no-store", ...budget },
      body: { items, next_cursor: end < selected.rows.length ? `pc_${end}` : null },
    };
  });
  transport.onDownload("GET", "/api/v1/playback/plays", (req) => asDownload(playsCsv(req)));
  const aggregatesCsv = (req: TransportRequest): TransportResponse => {
    const budget = spendExport(req);
    if ("status" in budget) return budget as TransportResponse;
    return {
      status: 200,
      headers: { ...csvHeaders(req, "playback-aggregates.csv"), ...budget },
      body: csvBody(AGGREGATE_COLUMNS, playbackItems.filter((item) => aggregateMatches(item, req))),
    };
  };
  transport.onDownload("GET", "/api/v1/playback", (req) => asDownload(aggregatesCsv(req)));

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

  transport.on("GET", "/api/v1/events", (req): TransportResponse => {
    const after = req.query?.after;
    // Contract: limit defaults to 50 and accepts 1..200; anything else is 400
    // invalid_request naming the field. No silent capping.
    const rawLimit = req.query?.limit;
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return {
        status: 400,
        headers: { "content-type": "application/problem+json", "x-request-id": req.headers?.["x-request-id"] ?? "req_events" },
        body: {
          type: "https://screenrig.ai/problems/invalid-request",
          title: "Request is invalid",
          status: 400,
          detail: "limit must be an integer from 1 to 200.",
          code: "invalid_request",
          errors: [{ field: "limit", message: "must be an integer from 1 to 200" }],
        },
      };
    }
    const remaining = after ? events.filter((event) => event.cursor > after) : events;
    const items = remaining.slice(0, limit);
    // next_cursor is the last returned cursor while more exist, and null at the end.
    const nextCursor = remaining.length > items.length ? items.at(-1)?.cursor ?? null : null;
    return {
      status: 200,
      headers: { "x-request-id": req.headers?.["x-request-id"] ?? "req_events" },
      body: { items, next_cursor: nextCursor },
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
      // the operation result is where the application primitive's release_id comes from.
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
  transport.on("DELETE", /^\/api\/v1\/playlists\/[^/]+$/, (req): TransportResponse => {
    const playlistId = req.path.split("/").pop() ?? "";
    // Only schedule and takeover references are modelled as "in use" here.
    const inUse = [...screens.values()].some((screen) => screen.state !== "archived"
      && (screen.takeover?.playlist_id === playlistId || (screen.playlist_schedule?.entries ?? []).some((entry) => entry.playlist_id === playlistId)));
    if (inUse) {
      return { status: 409, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/resource-conflict", title: "Resource state conflicts with the request", status: 409, code: "resource_conflict", detail: "playlist is assigned to a screen or referenced by a screen playlist schedule or takeover" } };
    }
    playlists.delete(playlistId);
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

  // Playlist schedules and takeover, simplified: the first schedule entry is
  // treated as matching now. Precedence is takeover, schedule, default.
  type Control =
    | { kind: "schedule"; entries: Array<Record<string, unknown>> }
    | { kind: "schedule_clear" }
    | { kind: "takeover"; playlist_id: string; until?: string | null; reason?: string }
    | { kind: "takeover_clear" };
  const controlProblem = (status: number, code: string, detail: string) => ({ type: `https://screenrig.ai/problems/${code.replaceAll("_", "-")}`, title: code, status, code, detail });
  const resolveEffective = (screen: Screen): Screen => {
    const { effective_playlist: _old, ...rest } = screen;
    const takeover = screen.takeover;
    const entry = screen.playlist_schedule?.entries?.[0];
    const effective = takeover
      ? { id: takeover.playlist_id, source: "takeover" as const, ...(takeover.until ? { until: takeover.until } : {}) }
      : entry ? { id: entry.playlist_id, source: "schedule" as const, entry_id: entry.id }
      : screen.playlist_id ? { id: screen.playlist_id, source: "default" as const } : undefined;
    return effective ? { ...rest, effective_playlist: effective } : rest;
  };
  const applyControl = (screen: Screen, change: Control): { screen: Screen } | { problem: ReturnType<typeof controlProblem> } => {
    if (screen.state === "archived") return { problem: controlProblem(409, "screen_archived", "screen is archived") };
    // Server order: timezone (schedule only), then the default playlist, then until.
    if (change.kind === "schedule" && !screen.timezone) {
      return { problem: controlProblem(400, "invalid_request", "timezone: is required on a screen before a playlist schedule can be set") };
    }
    if ((change.kind === "schedule" || change.kind === "takeover") && !screen.playlist_id) {
      return { problem: controlProblem(400, "invalid_request", `playlist_id: assign the screen a default playlist before setting a ${change.kind === "schedule" ? "playlist schedule" : "takeover"}`) };
    }
    if (change.kind === "takeover" && typeof change.until === "string") {
      const ahead = Date.parse(change.until) - clock().getTime();
      if (!(ahead > 0)) return { problem: controlProblem(400, "invalid_request", "until: must be in the future") };
      if (ahead > 7 * 24 * 60 * 60 * 1000) return { problem: controlProblem(400, "invalid_request", "until: must be at most 7 days ahead; use null to hold until cleared") };
    }
    if (change.kind === "schedule") {
      const entries = change.entries.map((entry, index) => ({ ...entry, id: (entry.id as string | undefined) ?? `entry_${index + 1}` })) as unknown as NonNullable<Screen["playlist_schedule"]>["entries"];
      return { screen: resolveEffective({ ...screen, playlist_schedule: { entries, updated_at: "2026-08-14T17:00:00.000Z" }, revision: screen.revision + 1 }) };
    }
    if (change.kind === "schedule_clear") {
      if (!screen.playlist_schedule) return { screen };
      const { playlist_schedule: _gone, ...rest } = screen;
      return { screen: resolveEffective({ ...rest, revision: screen.revision + 1 }) };
    }
    if (change.kind === "takeover") {
      const takeover = { playlist_id: change.playlist_id, until: change.until ?? null, ...(change.reason ? { reason: change.reason } : {}), set_at: "2026-08-14T17:00:00.000Z" };
      return { screen: resolveEffective({ ...screen, takeover, revision: screen.revision + 1 }) };
    }
    if (!screen.takeover) return { screen };
    const { takeover: _ended, ...rest } = screen;
    return { screen: resolveEffective({ ...rest, revision: screen.revision + 1 }) };
  };
  const controlRoute = (req: TransportRequest, change: Control): TransportResponse => {
    const screen = screens.get(decodeURIComponent(req.path.split("/")[4] ?? ""));
    if (!screen) return { status: 404, headers: { "content-type": "application/problem+json" }, body: controlProblem(404, "not_found", "Resource was not found.") };
    const outcome = applyControl(screen, change);
    if ("problem" in outcome) return { status: outcome.problem.status, headers: { "content-type": "application/problem+json" }, body: outcome.problem };
    screens.set(screen.id, outcome.screen);
    return { status: 200, headers: { etag: `"${outcome.screen.revision}"` }, body: outcome.screen };
  };
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+\/playlist-schedule$/, (req): TransportResponse => {
    const screen = screens.get(decodeURIComponent(req.path.split("/")[4] ?? ""));
    if (!screen) return { status: 404, headers: { "content-type": "application/problem+json" }, body: controlProblem(404, "not_found", "Resource was not found.") };
    const resolved = resolveEffective(screen);
    return { status: 200, headers: {}, body: {
      entries: screen.playlist_schedule?.entries ?? [],
      ...(screen.playlist_schedule ? { updated_at: screen.playlist_schedule.updated_at } : {}),
      ...(resolved.effective_playlist ? { effective_playlist: resolved.effective_playlist } : {}),
    } };
  });
  transport.on("PUT", /^\/api\/v1\/screens\/[^/]+\/playlist-schedule$/, (req) => controlRoute(req, { kind: "schedule", entries: ((req.body ?? {}) as { entries?: Array<Record<string, unknown>> }).entries ?? [] }));
  transport.on("DELETE", /^\/api\/v1\/screens\/[^/]+\/playlist-schedule$/, (req) => controlRoute(req, { kind: "schedule_clear" }));
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/takeover$/, (req) => {
    const body = (req.body ?? {}) as { playlist_id: string; until?: string | null; reason?: string };
    return controlRoute(req, { kind: "takeover", playlist_id: body.playlist_id, until: body.until, reason: body.reason });
  });
  transport.on("DELETE", /^\/api\/v1\/screens\/[^/]+\/takeover$/, (req) => controlRoute(req, { kind: "takeover_clear" }));

  // POST /api/v1/screens/actions: one result per selected screen, in selector
  // order; a missing screen fails with not_found, the rest succeed.
  transport.on("POST", "/api/v1/screens/actions", (req): TransportResponse => {
    const body = req.body as { selector: { by: "ids"; screen_ids: string[] } | { by: "tag"; tag: string }; action: { type: string; tags?: string[]; playlist_id?: string } };
    // Like the server, a fleet takeover's until is checked once before fan-out.
    const fleetUntil = (body.action as { until?: unknown }).until;
    if (body.action.type === "takeover" && typeof fleetUntil === "string") {
      const ahead = Date.parse(fleetUntil) - clock().getTime();
      const detail = !(ahead > 0) ? "until: must be in the future"
        : ahead > 7 * 24 * 60 * 60 * 1000 ? "until: must be at most 7 days ahead; use null to hold until cleared" : undefined;
      if (detail) return { status: 400, headers: { "content-type": "application/problem+json" }, body: controlProblem(400, "invalid_request", detail) };
    }
    const ids = body.selector.by === "ids"
      ? body.selector.screen_ids
      : [...screens.values()].filter((screen) => screen.state === "active" && (screen.tags ?? []).includes((body.selector as { tag: string }).tag)).map((screen) => screen.id);
    const results = ids.map((id) => {
      const screen = screens.get(id);
      if (!screen) {
        return { screen_id: id, status: "failed", problem: { type: "https://screenrig.ai/problems/not-found", title: "Not found", status: 404, code: "not_found", detail: "Screen not found." } };
      }
      const action = body.action;
      if (action.type === "reload") return { screen_id: id, status: "ok", reload: { reload_id: "rld_FLEET0001", expires_at: "2026-08-14T17:10:00.000Z" } };
      if (action.type === "toast") return { screen_id: id, status: "ok", toast: { expires_at: "2026-08-14T17:00:10.000Z" } };
      if (["takeover", "takeover_clear", "set_playlist_schedule", "clear_playlist_schedule"].includes(action.type)) {
        const control = action as unknown as { type: string; playlist_id: string; until?: string | null; reason?: string; entries?: Array<Record<string, unknown>> };
        const change: Control = control.type === "takeover" ? { kind: "takeover", playlist_id: control.playlist_id, until: control.until, reason: control.reason }
          : control.type === "takeover_clear" ? { kind: "takeover_clear" }
          : control.type === "clear_playlist_schedule" ? { kind: "schedule_clear" } : { kind: "schedule", entries: control.entries ?? [] };
        const outcome = applyControl(screen, change);
        if ("problem" in outcome) return { screen_id: id, status: "failed", problem: outcome.problem };
        screens.set(id, outcome.screen);
        return { screen_id: id, status: "ok", revision: outcome.screen.revision };
      }
      const stored = screen.tags ?? [];
      const tags = action.type === "set_tags" ? action.tags ?? []
        : action.type === "add_tags" ? [...stored, ...(action.tags ?? []).filter((tag) => !stored.includes(tag))]
        : action.type === "remove_tags" ? stored.filter((tag) => !(action.tags ?? []).includes(tag))
        : stored;
      const item: Screen = { ...screen, tags, ...(action.type === "assign" ? { playlist_id: action.playlist_id } : {}), revision: screen.revision + 1 };
      screens.set(id, item);
      return { screen_id: id, status: "ok", revision: item.revision, ...(action.type.endsWith("_tags") ? { tags } : {}) };
    });
    const failed = results.filter((result) => result.status === "failed").length;
    return {
      status: 200,
      headers: { "cache-control": "no-store", "x-request-id": req.headers?.["x-request-id"] ?? "req_actions" },
      body: { action: body.action.type, matched: results.length, succeeded: results.length - failed, failed, results },
    };
  });
  transport.on("GET", "/api/v1/screens", (req) => {
    const archivedOnly = req.query?.state === "archived";
    const tag = typeof req.query?.tag === "string" ? req.query.tag : undefined;
    const items = [...screens.values()].filter((screen) => (
      archivedOnly ? screen.state === "archived" : screen.state !== "archived"
    ) && (tag === undefined || (screen.tags ?? []).includes(tag)));
    return { status: 200, headers: {}, body: { items } };
  });
  transport.on("GET", /^\/api\/v1\/screens\/[^/]+$/, (req) => ({ status: 200, headers: {}, body: screens.get(req.path.split("/").pop() ?? "") }));
  transport.on("PATCH", /^\/api\/v1\/screens\/[^/]+$/, (req): TransportResponse => {
    const id = req.path.split("/").pop() ?? "";
    const body = req.body as { name?: string; playlist_id?: string; timezone?: string; tags?: string[] };
    const ifMatch = req.headers?.["if-match"];
    const existing = screens.get(id);
    // Only tag writes model the revision guard; older fixtures reuse fixed revisions.
    if (body.tags && ifMatch && existing && ifMatch !== `"${existing.revision}"`) {
      return { status: 412, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/revision-conflict", title: "Revision conflict", status: 412, code: "revision_conflict", detail: "The screen revision changed.", current_revision: existing.revision } };
    }
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
      ...(body.tags ? { tags: body.tags } : {}),
      revision: body.tags && existing ? existing.revision + 1 : 2,
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
      archive_reason: "project",
      archived_at: "2026-08-14T17:00:03.000Z",
      revision: current.revision + 1,
      content_access_generation: current.content_access_generation + 1,
      updated_at: "2026-08-14T17:00:03.000Z",
    };
    screens.set(id, item);
    return { status: 200, headers: {}, body: item };
  });
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/unarchive$/, (req) => {
    const id = req.path.split("/")[4] ?? "";
    const { archive_reason: _reason, archived_at: _archivedAt, ...current } = screens.get(id) as Screen;
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
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/recovery\/confirm$/, (req): TransportResponse => {
    const id = req.path.split("/")[4] ?? "";
    const current = screens.get(id);
    if (!current) {
      return { status: 404, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/not-found", title: "Not found", status: 404, code: "not_found", detail: "Screen not found." } };
    }
    if (!current.recovery_pending) {
      return { status: 404, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/recovery-not-offered", title: "No screen recovery is pending", status: 404, code: "recovery_not_offered", detail: "Nothing is pending." } };
    }
    const { recovery_pending: _pending, ...rest } = current;
    const item: Screen = {
      ...rest,
      revision: current.revision + 1,
      updated_at: "2026-08-14T17:00:05.000Z",
    };
    screens.set(id, item);
    return { status: 200, headers: { etag: `"${item.revision}"` }, body: item };
  });
  const reloads = new Map<string, { reload_id: string; expires_at: string }>();
  transport.on("POST", /^\/api\/v1\/screens\/[^/]+\/reload$/, (req): TransportResponse => {
    const id = req.path.split("/")[4] ?? "";
    const current = screens.get(id);
    if (!current) {
      return { status: 404, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/not-found", title: "Not found", status: 404, code: "not_found", detail: "Screen not found." } };
    }
    if (current.state === "pairing_pending") {
      return { status: 409, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/resource-conflict", title: "Resource conflict", status: 409, code: "resource_conflict", detail: "The screen has no Player yet." } };
    }
    const ifMatch = req.headers?.["if-match"];
    if (ifMatch && ifMatch !== `"${current.revision}"`) {
      return { status: 412, headers: { "content-type": "application/problem+json" }, body: { type: "https://screenrig.ai/problems/revision-conflict", title: "Revision conflict", status: 412, code: "revision_conflict", detail: "The screen revision changed." } };
    }
    // An exact Idempotency-Key retry returns the original reload.
    const key = req.headers?.["idempotency-key"] ?? "";
    const accepted = reloads.get(key) ?? { reload_id: `rld_${String(reloads.size + 1).padStart(8, "0")}`, expires_at: "2026-08-14T17:10:00.000Z" };
    if (key) reloads.set(key, accepted);
    return {
      status: 202,
      headers: { "cache-control": "no-store", etag: `"${current.revision}"`, "x-request-id": req.headers?.["x-request-id"] ?? "req_reload" },
      body: accepted,
    };
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
    const primitive = req.query?.primitive;
    const items = [...media.values()].filter((item) => {
      const record = item as { tag?: string; primitive?: string; declaration?: unknown };
      if (record.declaration) return false;
      if (tag && record.tag !== tag) return false;
      if (primitive && record.primitive !== primitive) return false;
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
    // Mirror the server's derivation: a declared source_filename whose
    // extension differs from the stored one is kept whole and the stored
    // extension is appended (photo.png -> photo.png.webp); same extension stays.
    const storedExtension = stored.declaration.filename.includes(".") ? stored.declaration.filename.slice(stored.declaration.filename.lastIndexOf(".")) : "";
    const sourceFilename = stored.declaration.source_filename;
    const sourceExtension = sourceFilename?.includes(".") ? sourceFilename.slice(sourceFilename.lastIndexOf(".")) : "";
    const filename = sourceFilename
      ? sourceExtension.toLowerCase() === storedExtension.toLowerCase() ? sourceFilename : `${sourceFilename}${storedExtension}`
      : stored.declaration.filename;
    const item = {
      id,
      filename,
      ...(sourceFilename ? { source_filename: sourceFilename } : {}),
      primitive: commit.content_type.startsWith("image/") ? "image" : "video",
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

  // Feedback: project-scoped, immutable, and keyed by route rather than body.
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

  // Customer webhooks: at most 10 per project, secret only on create and
  // rotate-secret, and an exact Idempotency-Key replay returns the same answer
  // (secret included), like the server's 24-hour idempotency record.
  const webhooks = new Map<string, Record<string, unknown>>();
  const webhookDeliveries = new Map<string, Array<Record<string, unknown>>>();
  const webhookReplays = new Map<string, { request: string; response: TransportResponse }>();
  let webhookSequence = 0;
  let webhookSecretSequence = 0;
  const webhookSecret = () => `whsec_${String(++webhookSecretSequence).padStart(43, "S")}`;
  const webhookReplay = (req: TransportRequest, work: () => TransportResponse): TransportResponse => {
    const key = req.headers?.["idempotency-key"];
    const request = JSON.stringify([req.method, req.path, req.body ?? null]);
    const replay = key ? webhookReplays.get(key) : undefined;
    if (replay) return replay.request === request ? replay.response : problem(409, "idempotency_mismatch", "idempotency key does not match original request");
    const response = work();
    if (key && response.status < 400) webhookReplays.set(key, { request, response });
    return response;
  };
  const webhookUrlRejected = (value: unknown): string | undefined => {
    let url: URL;
    try { url = new URL(String(value)); } catch { return "url must be an absolute https URL"; }
    if (url.protocol !== "https:") return "url must be an absolute https URL";
    if (url.port && url.port !== "443" && url.port !== "8443") return "url port must be 443 (the default) or 8443";
    if (/^(localhost|127\.|10\.|192\.168\.|\[)/.test(url.hostname)) return "url host must be a public Internet address";
    return undefined;
  };
  const rejectedUrl = (reason: string): TransportResponse => ({
    status: 400,
    headers: { "content-type": "application/problem+json" },
    body: { status: 400, code: "webhook_url_rejected", title: "Webhook URL must be HTTPS on a public Internet host", detail: `${reason}.`, errors: [{ field: "url", code: "rejected", detail: `${reason}.` }] },
  });
  const webhookFor = (req: TransportRequest): Record<string, unknown> | undefined => webhooks.get(decodeURIComponent(req.path.split("/")[4] ?? ""));
  const staleRevision = (req: TransportRequest, webhook: Record<string, unknown>): TransportResponse | undefined => {
    const ifMatch = req.headers?.["if-match"];
    if (!ifMatch || ifMatch === `"${webhook.revision}"`) return undefined;
    return { status: 412, headers: { "content-type": "application/problem+json" }, body: { status: 412, code: "revision_conflict", title: "Revision conflict", detail: "The webhook revision does not match If-Match.", current_revision: webhook.revision } };
  };
  transport.on("GET", "/api/v1/webhooks", () => ({ status: 200, headers: {}, body: { items: [...webhooks.values()] } }));
  transport.on("POST", "/api/v1/webhooks", (req) => webhookReplay(req, () => {
    const body = (req.body ?? {}) as { url?: string; event_types?: string[]; enabled?: boolean; description?: string };
    const rejected = webhookUrlRejected(body.url);
    if (rejected) return rejectedUrl(rejected);
    if (webhooks.size >= 10) return problem(409, "webhook_limit_reached", "The project already has the maximum of 10 webhooks.");
    webhookSequence += 1;
    const webhook: Record<string, unknown> = {
      id: `whk_${String(webhookSequence).padStart(20, "A")}`,
      url: body.url, event_types: body.event_types ?? [], enabled: body.enabled ?? true,
      ...(body.description ? { description: body.description } : {}),
      revision: 1, status: body.enabled === false ? "disabled" : "active",
      created_at: "2026-08-14T17:00:00.000Z", updated_at: "2026-08-14T17:00:00.000Z",
    };
    webhooks.set(webhook.id as string, webhook);
    webhookDeliveries.set(webhook.id as string, []);
    return { status: 201, headers: { "cache-control": "no-store" }, body: { ...webhook, secret: webhookSecret() } };
  }));
  transport.on("GET", /^\/api\/v1\/webhooks\/[^/]+$/, (req) => {
    const webhook = webhookFor(req);
    return webhook ? { status: 200, headers: { etag: `"${webhook.revision}"` }, body: webhook } : notFound("Resource was not found.");
  });
  transport.on("PATCH", /^\/api\/v1\/webhooks\/[^/]+$/, (req) => webhookReplay(req, () => {
    const webhook = webhookFor(req);
    if (!webhook) return notFound("Resource was not found.");
    const stale = staleRevision(req, webhook);
    if (stale) return stale;
    const body = (req.body ?? {}) as { url?: string; event_types?: string[]; enabled?: boolean; description?: string };
    if (body.url !== undefined) {
      const rejected = webhookUrlRejected(body.url);
      if (rejected) return rejectedUrl(rejected);
      webhook.url = body.url;
    }
    if (body.event_types !== undefined) webhook.event_types = body.event_types;
    if (body.enabled !== undefined) {
      webhook.enabled = body.enabled;
      webhook.status = body.enabled ? "active" : "disabled";
    }
    if (body.description !== undefined) {
      if (body.description) webhook.description = body.description;
      else delete webhook.description;
    }
    webhook.revision = (webhook.revision as number) + 1;
    return { status: 200, headers: { etag: `"${webhook.revision}"` }, body: { ...webhook } };
  }));
  transport.on("DELETE", /^\/api\/v1\/webhooks\/[^/]+$/, (req) => webhookReplay(req, () => {
    const webhook = webhookFor(req);
    if (!webhook) return notFound("Resource was not found.");
    const stale = staleRevision(req, webhook);
    if (stale) return stale;
    webhooks.delete(webhook.id as string);
    return { status: 204, headers: { "cache-control": "no-store" }, body: undefined };
  }));
  transport.on("POST", /^\/api\/v1\/webhooks\/[^/]+\/rotate-secret$/, (req) => webhookReplay(req, () => {
    const webhook = webhookFor(req);
    if (!webhook) return notFound("Resource was not found.");
    const stale = staleRevision(req, webhook);
    if (stale) return stale;
    webhook.revision = (webhook.revision as number) + 1;
    return { status: 200, headers: { "cache-control": "no-store" }, body: { ...webhook, secret: webhookSecret() } };
  }));
  transport.on("POST", /^\/api\/v1\/webhooks\/[^/]+\/test$/, (req) => webhookReplay(req, () => {
    const webhook = webhookFor(req);
    if (!webhook) return notFound("Resource was not found.");
    const rows = webhookDeliveries.get(webhook.id as string)!;
    const delivery = {
      id: `whd_${String(rows.length + 1).padStart(20, "A")}`, webhook_id: webhook.id, event_id: `ev1_${rows.length + 100}`,
      event_type: "webhook.test", test: true, state: "pending", attempts: 0,
      next_attempt_at: "2026-08-14T17:00:00.000Z", created_at: "2026-08-14T17:00:00.000Z",
    };
    rows.unshift(delivery);
    return { status: 202, headers: {}, body: delivery };
  }));
  transport.on("GET", /^\/api\/v1\/webhooks\/[^/]+\/deliveries$/, (req) => {
    const webhook = webhookFor(req);
    if (!webhook) return notFound("Resource was not found.");
    const rows = webhookDeliveries.get(webhook.id as string) ?? [];
    const limit = Number(req.query?.limit ?? 50);
    const start = typeof req.query?.before === "string" ? Number(req.query.before.slice(5)) : 0;
    const items = rows.slice(start, start + limit);
    const next = start + limit < rows.length ? `whc1_${start + limit}` : null;
    return { status: 200, headers: {}, body: { items, next_cursor: next } };
  });

  return transport;
}
