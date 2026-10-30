import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "./problems.js";

/**
 * `project export DIR`: a complete copy of a project in open formats, composed
 * from the project's own read routes. JSON for the configuration (screens,
 * folders, tags, playlists with revisions, schedules, campaigns, cards, sources,
 * notifications, webhooks, applications, triggers), the original media files
 * with a manifest of hashes, CSV for plays, uptime and alerts, and the event log
 * as JSON lines. Secrets are never read back by the routes (a webhook's signing
 * secret, a source's credentials) and are stripped again here.
 *
 * A rerun is safe: every JSON file is rewritten whole, a media file that is
 * already complete (its size and SHA-256 match the project's record) is kept,
 * and a partly downloaded one continues from the bytes it has.
 */

export const EXPORT_FORMAT = "screenrig.export/v1";
const PLAYS_WINDOW_DAYS = 31;
const PLAYS_LOOKBACK_DAYS = 400;
const UPTIME_LOOKBACK_DAYS = 365;
const DAY_MS = 86_400_000;

/** What the export reads from a project. */
export interface ExportApi {
  /** GET a JSON route. */
  get(pathName: string, query?: Record<string, string | undefined>): Promise<unknown>;
  /** GET a cursor-paged list whole: every page's items. */
  list(pathName: string, query?: Record<string, string | undefined>): Promise<unknown[]>;
  /** GET a file (a CSV report) to target. */
  file(pathName: string, query: Record<string, string | undefined>, target: string, contentType: string): Promise<void>;
  /** GET the bytes from `offset` on (a Range request) and append them to target. */
  append(pathName: string, offset: number, target: string): Promise<void>;
}

export interface ExportOptions {
  directory: string;
  media: boolean;
  /** First UTC day of the CSV data and the event log; default the longest lookback a plan keeps, and the whole log. */
  since?: string;
  now: Date;
  progress?: (line: string) => void;
}

export interface ExportedFile { path: string; bytes: number; sha256: string }
export interface ExportSection { name: string; status: "ok" | "skipped" | "failed"; files: number; detail?: string; code?: string }
export interface ExportResult {
  directory: string;
  sections: ExportSection[];
  files: ExportedFile[];
  media: { listed: number; downloaded: number; kept: number; failed: number };
  failed: number;
}

export async function sha256Of(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).byteLength;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** Write text whole through a temp file beside the target, so an interrupted run leaves the earlier copy. */
async function writeAtomic(target: string, text: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.part`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, target);
}

const asArray = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** A receiver URL is often its only credential: keep the origin. */
function origin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** Drop what could be a credential from a record, keeping the names of the secrets. */
export function stripSecrets(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...record };
  delete out.secret;
  if (typeof out.url === "string") {
    out.url_origin = origin(out.url);
    delete out.url;
  }
  if (out.secrets && typeof out.secrets === "object") {
    out.secret_names = Object.keys(out.secrets as Record<string, unknown>).sort();
    delete out.secrets;
  }
  return out;
}

/** A screen that has no such schedule (a 404) exports it as null; any other failure stays one. */
function absent(error: unknown): null {
  if (error instanceof CliError && error.problem.status === 404) return null;
  throw error;
}

/** Run `work` over every item, a few at a time, results in order; the first failure ends it. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** How many requests of one section run at once. */
const CONCURRENCY = 8;

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** The file extension of a media content type; the media id alone names the file otherwise. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/ogg": "ogg",
};

/** Append a CSV file to target, without its header line unless it is the first. */
async function appendCsv(target: string, source: string, first: boolean): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const output = createWriteStream(target, { flags: first ? "w" : "a", mode: 0o600 });
  let skipping = !first;
  await new Promise<void>((resolve, reject) => {
    output.on("error", reject);
    const input = createReadStream(source);
    input.on("error", reject);
    input.on("data", (chunk: string | Buffer) => {
      let buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (skipping) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        buffer = buffer.subarray(newline + 1);
        skipping = false;
      }
      if (buffer.length > 0) output.write(buffer);
    });
    input.on("end", () => output.end(resolve));
  });
}

export async function runProjectExport(api: ExportApi, options: ExportOptions): Promise<ExportResult> {
  const root = path.resolve(options.directory);
  await mkdir(root, { recursive: true });
  const say = options.progress ?? (() => undefined);
  const sections: ExportSection[] = [];
  const written = new Set<string>();
  const result: ExportResult = { directory: root, sections, files: [], media: { listed: 0, downloaded: 0, kept: 0, failed: 0 }, failed: 0 };

  const json = async (relative: string, value: unknown): Promise<void> => {
    await writeAtomic(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
    written.add(relative);
  };
  const section = async (name: string, run: () => Promise<number>): Promise<void> => {
    say(`exporting ${name}`);
    try {
      sections.push({ name, status: "ok", files: await run() });
    } catch (error) {
      const problem = error instanceof CliError ? error.problem : undefined;
      // A route this credential or plan does not reach is skipped, not a failure of the copy.
      const skipped = problem?.status === 403 || problem?.status === 404 || problem?.code === "forbidden" || problem?.code === "not_ready";
      sections.push({ name, status: skipped ? "skipped" : "failed", files: 0, detail: problem?.detail ?? (error instanceof Error ? error.message : String(error)), code: problem?.code });
      if (!skipped) result.failed += 1;
    }
  };

  let projectCreated: string | undefined;
  await section("project", async () => {
    const project = asRecord(await api.get("/api/project"));
    projectCreated = typeof project.created_at === "string" ? project.created_at : undefined;
    await json("project.json", project);
    return 1;
  });

  let screens: Array<Record<string, unknown>> = [];
  await section("screens", async () => {
    screens = [...asArray(await api.list("/api/screens")), ...asArray(await api.list("/api/screens", { state: "archived" }))];
    await json("screens/screens.json", screens);
    const tags = new Map<string, string[]>();
    for (const screen of screens) {
      for (const tag of Array.isArray(screen.tags) ? screen.tags as string[] : []) tags.set(tag, [...(tags.get(tag) ?? []), String(screen.id)]);
    }
    await json("tags.json", [...tags.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, ids]) => ({ tag, screen_ids: ids })));
    return 2;
  });

  await section("screen schedules", async () => {
    const schedules = await mapLimit(screens, CONCURRENCY, async (screen) => {
      const id = String(screen.id);
      const playlist = await api.get(`/api/screens/${id}/playlist-schedule`).catch(absent);
      const display = await api.get(`/api/screens/${id}/display-schedule`).catch(absent);
      return { screen_id: id, playlist_schedule: playlist, display_schedule: display, takeover: screen.takeover ?? null, effective_playlist: screen.effective_playlist ?? null };
    });
    await json("screens/schedules.json", schedules);
    return 1;
  });

  await section("folders", async () => {
    await json("screens/folders.json", asArray(asRecord(await api.get("/api/screen-folders")).items));
    await json("media/folders.json", asArray(asRecord(await api.get("/api/media-folders")).items));
    return 2;
  });

  await section("playlists", async () => {
    const playlists = asArray(await api.list("/api/playlists"));
    await json("playlists/playlists.json", playlists);
    const counts = await mapLimit(playlists, CONCURRENCY, async (playlist) => {
      const id = String(playlist.id);
      await json(`playlists/${id}/playlist.json`, await api.get(`/api/playlists/${id}`));
      const revisions = asArray(await api.list(`/api/playlists/${id}/revisions`));
      await json(`playlists/${id}/revisions.json`, revisions);
      await mapLimit(revisions, CONCURRENCY, async (revision) => {
        const number = String(revision.revision ?? revision.number);
        await json(`playlists/${id}/revisions/${number}.json`, await api.get(`/api/playlists/${id}/revisions/${number}`));
      });
      return revisions.length + 2;
    });
    return 1 + counts.reduce((sum, count) => sum + count, 0);
  });

  await section("campaigns", async () => {
    await json("campaigns.json", asArray(asRecord(await api.get("/api/campaigns")).items));
    return 1;
  });

  await section("direct campaigns", async () => {
    await json("advertising/direct-campaigns.json", asArray(asRecord(await api.get("/api/advertising/direct-campaigns")).items));
    return 1;
  });

  await section("cards", async () => {
    await json("cards/cards.json", asArray(await api.list("/api/cards")));
    await json("cards/card-data.json", asArray(await api.list("/api/card-data")));
    return 2;
  });

  await section("sources", async () => {
    await json("sources.json", asArray(await api.list("/api/sources")).map(stripSecrets));
    return 1;
  });

  await section("notifications", async () => {
    await json("notifications.json", asArray(asRecord(await api.get("/api/notifications")).items).map(stripSecrets));
    await json("alert-mutes.json", asArray(asRecord(await api.get("/api/alert-mutes")).items));
    return 2;
  });

  await section("webhooks", async () => {
    await json("webhooks.json", asArray(asRecord(await api.get("/api/webhooks")).items).map(stripSecrets));
    return 1;
  });

  await section("applications", async () => {
    await json("applications.json", asArray(await api.list("/api/applications")));
    await json("triggers.json", asArray(asRecord(await api.get("/api/triggers")).items).map(stripSecrets));
    return 2;
  });

  await section("report subscriptions", async () => {
    await json("report-subscriptions.json", asArray(asRecord(await api.get("/api/report-subscriptions")).items));
    return 1;
  });

  await section("event log", async () => {
    const target = path.join(root, "log/events.jsonl");
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.part`;
    const handle = await open(temp, "w", 0o600);
    try {
      if (options.since === undefined) {
        let after: string | undefined;
        for (;;) {
          const page = asRecord(await api.get("/api/events", { limit: "200", ...(after ? { after } : {}) }));
          const items = asArray(page.items);
          if (items.length > 0) await handle.write(`${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
          const next = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
          if (!next || items.length === 0) break;
          after = next;
        }
      } else {
        // From --since on: newest first until the first event before the day, then written oldest first.
        const from = `${options.since}T00:00:00Z`;
        const kept: Array<Record<string, unknown>> = [];
        let before: string | undefined;
        for (let done = false; !done;) {
          const page = asRecord(await api.get("/api/events", { limit: "200", order: "desc", ...(before ? { before } : {}) }));
          const items = asArray(page.items);
          for (const item of items) {
            if (typeof item.at === "string" && item.at < from) {
              done = true;
              break;
            }
            kept.push(item);
          }
          const next = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
          if (!next || items.length === 0) done = true;
          before = next;
        }
        if (kept.length > 0) await handle.write(`${kept.reverse().map((item) => JSON.stringify(item)).join("\n")}\n`);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    written.add("log/events.jsonl");
    return 1;
  });

  // The audit log: every configuration change with its before and after, and the
  // chain head, so the copy carries its own anchor (audit verify --anchor).
  await section("audit log", async () => {
    const target = path.join(root, "log/audit.jsonl");
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.part`;
    const handle = await open(temp, "w", 0o600);
    try {
      // The head first: entries chained after it are newer than the anchor.
      const head = asRecord(await api.get("/api/audit/head"));
      let cursor: string | undefined;
      const query = options.since === undefined ? {} : { since: `${options.since}T00:00:00Z` };
      const kept: Array<Record<string, unknown>> = [];
      for (;;) {
        // Newest first, page by page; the file is written oldest first.
        const page = asRecord(await api.get("/api/audit", { limit: "200", ...query, ...(cursor ? { cursor } : {}) }));
        const items = asArray(page.items);
        kept.push(...items);
        const next = typeof page.next_cursor === "string" ? page.next_cursor : undefined;
        if (!next || items.length === 0) break;
        cursor = next;
      }
      if (kept.length > 0) await handle.write(`${kept.reverse().map((item) => JSON.stringify(item)).join("\n")}\n`);
      await handle.sync();
      await json("log/audit-head.json", head);
    } finally {
      await handle.close();
    }
    await rename(temp, target);
    written.add("log/audit.jsonl");
    return 2;
  });

  await section("plays, uptime and alerts", async () => {
    let files = 0;
    const csv = async (relative: string, pathName: string, query: Record<string, string | undefined>): Promise<void> => {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await api.file(pathName, { ...query, format: "csv" }, `${target}.part`, "text/csv");
      await rename(`${target}.part`, target);
      written.add(relative);
      files += 1;
    };
    const today = dayOf(options.now);
    const playsFrom = dayOf(new Date(options.now.getTime() - (PLAYS_LOOKBACK_DAYS - 1) * DAY_MS));
    const created = projectCreated ? projectCreated.slice(0, 10) : playsFrom;
    const since = options.since ?? (created > playsFrom ? created : playsFrom);
    const uptimeFrom = (() => {
      const limit = dayOf(new Date(options.now.getTime() - (UPTIME_LOOKBACK_DAYS - 1) * DAY_MS));
      return since > limit ? since : limit;
    })();
    await csv("data/uptime-daily.csv", "/api/uptime/daily", { day_from: uptimeFrom, day_to: today });
    await csv("data/uptime-by-screen.csv", "/api/reports/uptime", { group_by: "screen", from: uptimeFrom, to: today });
    await csv("data/alerts.csv", "/api/alerts", { state: "all" });
    await csv("data/play-aggregates.csv", "/api/playback", { day_from: uptimeFrom, day_to: today });
    // Plays: one request per window of at most 31 days, joined under one header.
    const playsTarget = path.join(root, "data/plays.csv");
    await rm(playsTarget, { force: true });
    let first = true;
    for (let start = Date.parse(`${since}T00:00:00Z`); start < options.now.getTime(); start += PLAYS_WINDOW_DAYS * DAY_MS) {
      const end = Math.min(start + PLAYS_WINDOW_DAYS * DAY_MS, options.now.getTime() - 5_000);
      if (end <= start) break;
      const piece = `${playsTarget}.window`;
      await api.file("/api/playback/plays", { from: new Date(start).toISOString(), to: new Date(end).toISOString(), format: "csv" }, piece, "text/csv");
      await appendCsv(playsTarget, piece, first);
      first = false;
      await rm(piece, { force: true });
    }
    written.add("data/plays.csv");
    return files + 1;
  });

  await section("media", async () => {
    const items = asArray(await api.list("/api/media"));
    result.media.listed = items.length;
    const manifest: Array<Record<string, unknown>> = [];
    let files = 0;
    for (const item of items) {
      const id = String(item.id);
      const extension = EXTENSIONS[String(item.content_type ?? "").toLowerCase()] ?? "bin";
      const relative = `media/files/${id}.${extension}`;
      const entry: Record<string, unknown> = {
        id, filename: item.source_filename ?? item.filename, content_type: item.content_type, primitive: item.primitive, bytes: item.bytes, sha256: item.sha256,
        folder_id: item.folder_id ?? null, tags: item.tags ?? [], created_at: item.created_at, path: options.media ? relative : null,
      };
      if (options.media) {
        try {
          const state = await mediaFile(api, `/api/media/${id}/content`, path.join(root, relative), Number(item.bytes), String(item.sha256));
          result.media[state] += 1;
          entry.status = "complete";
          written.add(relative);
          files += 1;
        } catch (error) {
          result.media.failed += 1;
          entry.status = "failed";
          entry.error = error instanceof CliError ? error.problem.detail : error instanceof Error ? error.message : String(error);
        }
        say(`media ${manifest.length + 1}/${items.length} ${id}`);
      }
      manifest.push(entry);
    }
    await json("media/media.json", items);
    await json("media/manifest.json", { format: EXPORT_FORMAT, files: manifest });
    if (result.media.failed > 0) throw new Error(`${result.media.failed} media file(s) did not download; run the export again to continue them.`);
    return files + 2;
  });

  for (const relative of [...written].sort()) {
    const { bytes, sha256 } = await sha256Of(path.join(root, relative));
    result.files.push({ path: relative, bytes, sha256 });
  }
  const project = asRecord(await readFile(path.join(root, "project.json"), "utf8").then((text) => JSON.parse(text) as unknown).catch(() => undefined));
  await json("export.json", {
    format: EXPORT_FORMAT, generated_at: options.now.toISOString(), project_id: project.id ?? null, media_files: options.media, sections, files: result.files,
  });
  return result;
}

/**
 * One media file: kept when it is already complete (size and SHA-256 match the
 * record), else downloaded, continuing a partial `.part` file from the bytes it
 * holds. The finished file must match the record's SHA-256: one that does not is
 * discarded and fetched again once.
 */
async function mediaFile(api: ExportApi, pathName: string, target: string, bytes: number, sha256: string): Promise<"downloaded" | "kept"> {
  await mkdir(path.dirname(target), { recursive: true });
  const existing = await stat(target).catch(() => undefined);
  if (existing?.isFile() && existing.size === bytes && (await sha256Of(target)).sha256 === sha256) return "kept";
  const part = `${target}.part`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let have = (await stat(part).catch(() => undefined))?.size ?? 0;
    if (attempt > 0 || have > bytes) {
      await rm(part, { force: true });
      have = 0;
    }
    if (have < bytes || bytes === 0) await api.append(pathName, have, part);
    const done = await sha256Of(part).catch(() => undefined);
    if (done && done.bytes === bytes && done.sha256 === sha256) {
      await rename(part, target);
      return "downloaded";
    }
  }
  await rm(part, { force: true });
  throw new Error(`Media ${path.basename(target)} did not match its recorded SHA-256 after downloading it twice.`);
}
