import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { writeConfigAtomic, type ConfigFs } from "../config.js";
import { run, type CliRuntime } from "../main.js";
import { FakeTransport, listPage } from "../transport/fake.js";
import type { TransportRequest, TransportResponse } from "../transport/types.js";

/**
 * An in-memory screenRIG project for the migration tests: media uploads with
 * idempotent replays, folders, playlists, screens, fleet links and campaigns,
 * the project's own caps, and a way to open a fleet link as a device would. It
 * holds no tests itself.
 */
export const PROJECT_ID = "prj_AAAAAAAAAAAAAAAAAAAAAAAA";
export const API_URL = "https://api.screenrig.ai";
const TOKEN = "eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr";

type Row = Record<string, unknown> & { id: string };

export interface FakeProject {
  transport: FakeTransport;
  media: Map<string, Row>;
  folders: Map<string, Row>;
  playlists: Map<string, Row>;
  screens: Map<string, Row>;
  links: Map<string, Row>;
  campaigns: Map<string, Row>;
  /** Return a response to answer the request with it instead of the route. */
  intercept?: (req: TransportRequest) => TransportResponse | undefined;
  /** A device opens a fleet link: a screen appears with the link's tags, fields and playlist and a label of its own. */
  openLink(linkId: string, label: string): Row;
  /** A screen the project already had. */
  addScreen(id: string, over?: Record<string, unknown>): Row;
  /** Writes by route, in order, for assertions: "POST /api/playlists". */
  writes(): string[];
}

const problem = (status: number, code: string, detail: string): TransportResponse => ({
  status,
  headers: { "content-type": "application/problem+json" },
  body: { status, code, title: "Request refused", detail },
});

export function fakeProject(options: { linkCap?: number; campaignCap?: number } = {}): FakeProject {
  const transport = new FakeTransport();
  const media = new Map<string, Row>();
  const folders = new Map<string, Row>();
  const playlists = new Map<string, Row>();
  const screens = new Map<string, Row>();
  const links = new Map<string, Row>();
  const campaigns = new Map<string, Row>();
  const uploads = new Map<string, { declaration: Record<string, unknown>; operationId: string }>();
  const operations = new Map<string, Record<string, unknown>>();
  const replays = new Map<string, TransportResponse>();
  const counters: Record<string, number> = {};
  const next = (kind: string): string => {
    counters[kind] = (counters[kind] ?? 0) + 1;
    return `${kind}_${String(counters[kind]).padStart(8, "A")}`;
  };
  const project: FakeProject = {
    transport, media, folders, playlists, screens, links, campaigns,
    openLink(linkId, label) {
      const link = links.get(linkId);
      if (!link) throw new Error(`no link ${linkId}`);
      const screen: Row = {
        id: next("scr"), label, state: "active", online: true, revision: 1, tags: [...((link.tags as string[]) ?? [])],
        ...(link.fields ? { fields: { ...(link.fields as object) } } : {}), ...(link.playlist_id ? { playlist_id: link.playlist_id } : {}), fleet_link_id: linkId,
      };
      screens.set(screen.id, screen);
      link.screens_created = ((link.screens_created as number) ?? 0) + 1;
      return screen;
    },
    addScreen(id, over = {}) {
      const screen: Row = { id, label: id, state: "active", online: true, revision: 1, tags: [], ...over };
      screens.set(id, screen);
      return screen;
    },
    writes() {
      return transport.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);
    },
  };
  const route = (method: string, pattern: string | RegExp, handler: (req: TransportRequest) => TransportResponse): void => {
    transport.on(method, pattern, (req) => project.intercept?.(req) ?? handler(req));
  };
  /** An idempotent write replays its first answer, whatever it is asked the second time. */
  const keyed = (handler: (req: TransportRequest) => TransportResponse) => (req: TransportRequest): TransportResponse => {
    const key = req.headers?.["idempotency-key"];
    if (key && replays.has(key)) return replays.get(key)!;
    const response = handler(req);
    if (key && response.status < 400) replays.set(key, response);
    return response;
  };
  const id = (req: TransportRequest): string => req.path.split("/").pop() ?? "";
  const body = (req: TransportRequest): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;

  route("GET", "/api/project", () => ({ status: 200, headers: {}, body: { id: PROJECT_ID, name: "Amber Acorn", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization" } }));

  route("GET", "/api/media", (req) => listPage(req, [...media.values()], 1000));
  route("POST", "/api/media/uploads", keyed((req) => {
    const declaration = body(req);
    const uploadId = next("upl");
    const operationId = next("op");
    uploads.set(uploadId, { declaration, operationId });
    const operation = { id: operationId, kind: "media.upload", state: "queued", created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-28T10:00:00.000Z" };
    operations.set(operationId, operation);
    return {
      status: 201, headers: { "cache-control": "private, no-store" },
      body: { id: uploadId, operation, upload_url: "https://storage.example.invalid/signed/object", method: "PUT", headers: { "content-type": String(declaration.content_type) }, expires_at: "2099-01-01T00:00:00.000Z" },
    };
  }));
  route("POST", /^\/api\/media\/uploads\/[^/]+\/commit$/, keyed((req) => {
    const upload = uploads.get(req.path.split("/").at(-2) ?? "");
    if (!upload) return problem(404, "not_found", "No such upload.");
    const { declaration } = upload;
    const content = String(declaration.content_type);
    const primitive = content.startsWith("image/") ? "image" : content.startsWith("video/") ? "video" : "audio";
    const mediaId = next("med");
    media.set(mediaId, {
      id: mediaId, filename: declaration.filename, source_filename: declaration.source_filename, primitive, content_type: content, sha256: declaration.sha256, bytes: declaration.bytes,
      ...(primitive === "video" ? { duration_ms: 9000 } : {}), revision: 1, state: "ready",
    });
    const operation = { id: upload.operationId, kind: "media.upload", state: "succeeded", created_at: "2026-10-28T10:00:00.000Z", updated_at: "2026-10-28T10:00:01.000Z", result: { media_id: mediaId, revision: 1 } };
    operations.set(upload.operationId, operation);
    return { status: 202, headers: {}, body: operation };
  }));
  route("GET", /^\/api\/operations\/[^/]+$/, (req) => ({ status: 200, headers: {}, body: operations.get(id(req)) }));
  route("GET", /^\/api\/media\/[^/]+$/, (req) => (media.has(id(req)) ? { status: 200, headers: {}, body: media.get(id(req)) } : problem(404, "not_found", "No such media.")));
  route("POST", "/api/media/move", keyed((req) => {
    const input = body(req);
    for (const mediaId of input.media_ids as string[]) {
      const item = media.get(mediaId);
      if (item) item.folder_id = input.folder_id;
    }
    return { status: 200, headers: {}, body: { media: (input.media_ids as string[]).length, folders: 0 } };
  }));

  route("GET", "/api/media-folders", () => ({ status: 200, headers: {}, body: { items: [...folders.values()] } }));
  route("GET", /^\/api\/media-folders\/[^/]+$/, (req) => (folders.has(id(req)) ? { status: 200, headers: {}, body: folders.get(id(req)) } : problem(404, "not_found", "No such folder.")));
  route("POST", "/api/media-folders", keyed((req) => {
    const folder: Row = { id: next("mfd"), name: body(req).name };
    folders.set(folder.id, folder);
    return { status: 201, headers: {}, body: folder };
  }));

  route("GET", "/api/playlists", (req) => listPage(req, [...playlists.values()], 200));
  route("POST", "/api/playlists", keyed((req) => {
    const playlist: Row = { ...body(req), id: next("pl"), revision: 1 };
    playlists.set(playlist.id, playlist);
    return { status: 201, headers: {}, body: playlist };
  }));

  route("GET", "/api/screens", (req) => listPage(req, [...screens.values()], 500));
  route("GET", /^\/api\/screens\/[^/]+$/, (req) => (screens.has(id(req)) ? { status: 200, headers: {}, body: screens.get(id(req)) } : problem(404, "not_found", "No such screen.")));
  route("PATCH", /^\/api\/screens\/[^/]+$/, keyed((req) => {
    const screen = screens.get(id(req));
    if (!screen) return problem(404, "not_found", "No such screen.");
    const patch = body(req);
    if (typeof patch.name === "string") screen.label = patch.name;
    if (typeof patch.playlist_id === "string") screen.playlist_id = patch.playlist_id;
    if (typeof patch.timezone === "string") screen.timezone = patch.timezone;
    if (Array.isArray(patch.tags)) screen.tags = patch.tags;
    if (patch.fields && typeof patch.fields === "object") {
      const fields = { ...((screen.fields as Record<string, string>) ?? {}) };
      for (const [name, value] of Object.entries(patch.fields)) {
        if (value === null) delete fields[name];
        else fields[name] = String(value);
      }
      screen.fields = fields;
    }
    screen.revision = (screen.revision as number) + 1;
    return { status: 200, headers: {}, body: screen };
  }));
  route("POST", "/api/screens/pair", keyed((req) => {
    const input = body(req);
    if (input.code === "000000") return problem(404, "pairing_code_not_found", "That code is not waiting.");
    const screen: Row = { id: next("scr"), label: input.label ?? "Screen", state: "pairing_pending", online: false, revision: 1, tags: [] };
    screens.set(screen.id, screen);
    return { status: 201, headers: { "cache-control": "private, no-store" }, body: { screen, public_url: "https://play.screenrig.ai/player/s/public" } };
  }));

  route("GET", "/api/fleet-links", () => ({ status: 200, headers: { "cache-control": "no-store" }, body: { items: [...links.values()].map((link) => ({ ...link })) } }));
  route("POST", "/api/fleet-links", keyed((req) => {
    if (links.size >= (options.linkCap ?? 50)) return problem(409, "fleet_link_limit_reached", "This project already has the maximum of 50 fleet links.");
    const link: Row = { ...body(req), id: next("flk"), enabled: true, tags: body(req).tags ?? [], screens_created: 0, revision: 1, url: `https://play.screenrig.ai/player/#fleet=srfl_${"A".repeat(43)}` };
    links.set(link.id, link);
    return { status: 201, headers: {}, body: link };
  }));
  route("DELETE", /^\/api\/fleet-links\/[^/]+$/, keyed((req) => {
    if (!links.delete(id(req))) return problem(404, "not_found", "No such fleet link.");
    return { status: 204, headers: {}, body: undefined };
  }));

  route("GET", "/api/campaigns", () => ({ status: 200, headers: { "cache-control": "no-store" }, body: { items: [...campaigns.values()] } }));
  route("POST", "/api/campaigns", keyed((req) => {
    if (campaigns.size >= (options.campaignCap ?? 100)) return problem(409, "campaign_limit_reached", "This project already has the maximum of 100 campaigns.");
    const campaign: Row = { ...body(req), id: next("cmp"), paused: false, revision: 1 };
    campaigns.set(campaign.id, campaign);
    return { status: 201, headers: {}, body: campaign };
  }));
  return project;
}

// ---- running the CLI against it ---------------------------------------------------------------------

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

function realFs(home: string, env: NodeJS.Dict<string>): ConfigFs {
  return { mkdir, open, rename, rm, chmod, stat, homedir: () => home, env: { XDG_CONFIG_HOME: home, ...env } };
}

export interface Harness {
  /** Runs `screenrig ARGV` and parses the envelope. */
  invoke(argv: string[], extra?: { env?: NodeJS.Dict<string>; vendorFetch?: typeof fetch; signedRawPut?: CliRuntime["signedRawPut"]; sleep?: (ms: number) => Promise<void> }): Promise<{ code: number; stdout: string; stderr: string; json: Record<string, any> }>;
  configDir: string;
  cwd: string;
}

/** An enrolled CLI in `configDir`, working in `cwd`, talking to `project`. */
export async function harness(project: FakeProject, configDir: string, cwd: string): Promise<Harness> {
  await writeConfigAtomic(
    path.join(configDir, "screenrig", "config.json"),
    { api_url: API_URL, token: TOKEN, project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", project_id: PROJECT_ID },
    realFs(configDir, {}),
  );
  return {
    configDir,
    cwd,
    async invoke(argv, extra = {}) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const out = collect(stdout);
      const err = collect(stderr);
      const fsLike = realFs(configDir, extra.env ?? {});
      const runtime: CliRuntime = {
        argv,
        env: fsLike.env,
        stdout,
        stderr,
        now: () => new Date("2026-10-28T10:00:00.000Z"),
        sleep: extra.sleep ?? (async () => undefined),
        homedir: fsLike.homedir,
        cwd: () => cwd,
        fs: fsLike,
        transport: project.transport,
        signedRawPut: extra.signedRawPut ?? (async () => ({ status: 200 })),
        ...(extra.vendorFetch ? { vendorFetch: extra.vendorFetch } : {}),
      };
      const code = await run(runtime);
      stdout.end();
      stderr.end();
      const text = await out;
      let json: Record<string, any> = {};
      try {
        json = text.trim() ? JSON.parse(text) : {};
      } catch {
        json = {};
      }
      return { code, stdout: text, stderr: await err, json };
    },
  };
}

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}
