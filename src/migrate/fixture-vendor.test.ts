import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceCatalog, SourceMedia, VendorAdapter } from "./types.js";
import { VENDORS } from "./vendors/index.js";

/**
 * A made-up signage system for the framework tests: a CMS at cms.example.com that
 * lists its library and serves the files, and an adapter that reads it. It holds
 * no tests itself. Its token is a fixture, not a credential.
 */
export const FIXTURE_TOKEN = "fixture-token";
export const FIXTURE_URL = "https://cms.example.com";
const FILES = fileURLToPath(new URL("../../fixtures/migrate/files/signage/", import.meta.url));

export const libraryFiles: Record<string, { name: string; filename: string; type: "image" | "video" | "audio"; path: string }> = {
  "1": { name: "Welcome", filename: "welcome.png", type: "image", path: "images/welcome.png" },
  "2": { name: "Promo", filename: "promo.mp4", type: "video", path: "video/intro.mp4" },
  "4": { name: "Theme", filename: "theme.mp3", type: "audio", path: "audio/theme.mp3" },
};

/** Another host the fixture CMS can point a download at; it is sent no key. */
export const CDN_URL = "https://cdn.example.net";

export interface RouterOptions {
  /** Downloads of these ids answer this status. */
  downloadStatus?: Record<string, number>;
  /** Downloads of these ids are redirected to the CDN host, which answers `cdnStatus`. */
  downloadRedirect?: readonly string[];
  /** What the CDN host answers (default 200 with the file). */
  cdnStatus?: number;
  /** Downloads of these ids answer 200 with no body at all. */
  emptyDownloads?: readonly string[];
  /** Downloads of these ids never connect: the request fails as a lost network does. */
  networkDown?: readonly string[];
  /** Answer every request 401. */
  refuse?: boolean;
}

export interface Router {
  fetch: typeof fetch;
  requests: Array<{ method: string; path: string; authorization?: string }>;
}

/** The fixture CMS: GET /api/library, GET /api/library/download/ID, bearer auth. */
export function fixtureRouter(options: RouterOptions = {}): Router {
  const requests: Router["requests"] = [];
  const handler = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    requests.push({ method: init?.method ?? "GET", path: url.pathname, ...(headers.authorization ? { authorization: headers.authorization } : {}) });
    if (url.origin === CDN_URL) {
      if (options.cdnStatus) return new Response("no", { status: options.cdnStatus });
      return new Response(await readFile(path.join(FILES, libraryFiles[/\/(\d+)$/.exec(url.pathname)?.[1] ?? ""]?.path ?? "images/welcome.png")));
    }
    if (url.origin !== FIXTURE_URL) return new Response("wrong origin", { status: 502 });
    if (options.refuse || headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) return new Response("denied: the key fixture-token is not allowed", { status: 401 });
    if (url.pathname === "/api/library") {
      return Response.json({ data: Object.entries(libraryFiles).map(([id, file]) => ({ id, name: file.name, filename: file.filename, type: file.type })) });
    }
    const download = /^\/api\/library\/download\/(\d+)$/.exec(url.pathname);
    if (download) {
      const id = download[1]!;
      if (options.networkDown?.includes(id)) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      if (options.downloadRedirect?.includes(id)) return new Response(null, { status: 302, headers: { location: `${CDN_URL}/blob/${id}` } });
      if (options.emptyDownloads?.includes(id)) return new Response(null, { status: 200 });
      const status = options.downloadStatus?.[id];
      if (status) return new Response("no", { status });
      const file = libraryFiles[id];
      return file ? new Response(await readFile(path.join(FILES, file.path))) : new Response("missing", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: handler, requests };
}

const catalogOf = (media: SourceMedia[]): SourceCatalog => ({
  account: FIXTURE_URL,
  label: "cms.example.com",
  media,
  playlists: [
    { id: "10", name: "Lobby loop", items: [{ media_id: "1", duration_s: 10 }, { media_id: "2" }, { media_id: "4" }], notes: [] },
    { id: "11", name: "Promos", items: [{ media_id: "2" }, { url: "https://example.com/board", duration_s: 20 }], notes: ["It had a transition between items that does not come over."] },
  ],
  layouts: [
    {
      id: "20", name: "Split", width: 1920, height: 1080, notes: [],
      zones: [
        { id: "z1", name: "Main", x: 0, y: 0, width: 1280, height: 1080, z: 0, items: [{ media_id: "1", duration_s: 6 }, { media_id: "2" }] },
        { id: "z2", name: "Side", x: 1280, y: 0, width: 640, height: 1080, z: 1, items: [{ url: "https://example.com/ticker" }] },
      ],
    },
  ],
  groups: [{ id: "g1", name: "Lobby screens" }, { id: "g2", name: "Café" }],
  screens: [
    { id: "s1", name: "Front desk", group_ids: ["g1"], content: { playlist_id: "10" }, timezone: "America/Toronto", notes: [] },
    { id: "s2", name: "Café wall", group_ids: ["g2"], content: { layout_id: "20" }, notes: [] },
    { id: "s3", name: "Back office", group_ids: [], notes: [] },
  ],
  schedules: [
    { id: "sc1", name: "Weekday mornings", targets: { group_ids: ["g1"], screen_ids: [] }, content: { playlist_id: "11" }, start: "2026-11-02T07:00", end: "2026-11-02T11:00", repeat: { every: "week", weekdays: ["mon", "tue", "wed", "thu", "fri"], until: "2026-12-18" }, priority: 10, notes: [] },
    { id: "sc2", name: "Holiday", targets: { group_ids: [], screen_ids: ["s3"] }, content: { playlist_id: "11" }, start: "2026-12-24T09:00", end: "2026-12-26T09:00", priority: 20, notes: [] },
    { id: "sc3", name: "Monthly report", targets: { group_ids: ["g1"], screen_ids: [] }, content: { playlist_id: "11" }, start: "2026-11-01T09:00", end: "2026-11-01T10:00", repeat: { every: "month" }, priority: 0, notes: [] },
    { id: "sc4", name: "Always at the café", targets: { group_ids: ["g2"], screen_ids: [] }, content: { playlist_id: "11" }, always: true, priority: 5, notes: [] },
  ],
  not_imported: [{ kind: "media", source_id: "3", name: "Brand font", reason: "Fonts are not media." }],
  notes: [],
});

export const fixtureAdapter: VendorAdapter = {
  id: "fixture",
  name: "Fixture CMS",
  inputs: { url: "required", timezone: true, files: "optional" },
  credentials: [{ env: "FIXTURE_TOKEN", secret: true, required: true, help: "A read-only key from the Fixture CMS settings." }],
  connect: ["Open Settings, then API keys, and make a key that can read."],
  maps: ["Media, playlists, layouts, groups, screens and schedules."],
  skips: ["Fonts."],
  docs: ["https://cms.example.com/docs/api"],
  example: "screenrig migrate scan --from fixture --url https://cms.example.com",
  async open(input) {
    const client = input.http.client({ base: `${input.url}/api`, auth: { Authorization: `Bearer ${input.credentials.FIXTURE_TOKEN}` } });
    return {
      async scan() {
        const library = await client.json<{ data: Array<{ id: string; name: string; filename: string; type: "image" | "video" | "audio" }> }>("/library", { query: { start: 0, length: 100 } });
        return catalogOf(library.data.map((item): SourceMedia => ({ id: item.id, name: item.name, filename: item.filename, kind: item.type, fetch: { path: `/library/download/${item.id}` }, original: true })));
      },
      async fetchMedia(media, destination) {
        return client.download((media.fetch as { path: string }).path, destination);
      },
    };
  },
};

/** A system whose API lists files but cannot hand any out: the originals come from --files. */
export const fixtureLocalAdapter: VendorAdapter = {
  id: "fixture-local",
  name: "Local CMS",
  inputs: { files: "optional" },
  credentials: [],
  connect: ["Download your files into one folder."],
  maps: ["Media and one playlist."],
  skips: [],
  docs: ["https://cms.example.com/docs/api"],
  example: "screenrig migrate scan --from fixture-local --files ./downloads",
  async open() {
    return {
      async scan() {
        const media: SourceMedia[] = [
          { id: "a", name: "Welcome", filename: "welcome.png", kind: "image", original: true },
          { id: "b", name: "Intro", filename: "INTRO.MP4", kind: "video", original: true },
          { id: "c", name: "Gone", filename: "gone.png", kind: "image", original: true },
        ];
        return {
          account: "local-cms", label: "local-cms", media,
          playlists: [{ id: "p", name: "All of it", items: [{ media_id: "a" }, { media_id: "b" }, { media_id: "c" }], notes: [] }],
          layouts: [], groups: [], screens: [], schedules: [], not_imported: [], notes: [],
        };
      },
      async fetchMedia() {
        throw new Error("this system hands out no files");
      },
    };
  },
};

/** A system whose two media name the same original file, as two assets with one file name do. */
export const fixtureSharedAdapter: VendorAdapter = {
  id: "fixture-shared",
  name: "Shared CMS",
  inputs: { files: "optional" },
  credentials: [],
  connect: ["Download your files into one folder."],
  maps: ["Two media and one playlist."],
  skips: [],
  docs: ["https://cms.example.com/docs/api"],
  example: "screenrig migrate scan --from fixture-shared --files ./downloads",
  async open() {
    return {
      async scan() {
        const media: SourceMedia[] = [
          { id: "one", name: "Welcome", filename: "welcome.png", kind: "image", original: true },
          { id: "two", name: "Welcome again", filename: "Welcome.PNG", kind: "image", original: true },
        ];
        return {
          account: "shared-cms", label: "shared-cms", media,
          playlists: [{ id: "p", name: "Both", items: [{ media_id: "one" }, { media_id: "two" }], notes: [] }],
          layouts: [], groups: [], screens: [], schedules: [], not_imported: [], notes: [],
        };
      },
      async fetchMedia() {
        throw new Error("this system hands out no files");
      },
    };
  },
};

/** Adds the fixture systems to the registry for this test process. */
export function registerFixtureVendor(): void {
  for (const adapter of [fixtureAdapter, fixtureLocalAdapter, fixtureSharedAdapter]) {
    if (!VENDORS.some((vendor) => vendor.id === adapter.id)) (VENDORS as VendorAdapter[]).push(adapter);
  }
}
