import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ApiClient } from "./client.js";
import { ExitCode } from "./exit-codes.js";
import { isValidIdempotencyKey } from "./ids.js";
import { quotedRevision } from "./if-match.js";
import {
  performSignedMediaStreamPut,
  validateMediaUploadSession,
} from "./media-upload.js";
import { validatePlaylistWrite } from "./playlist-write-validation.js";
import { CliError, makeProblem, usageError } from "./problems.js";
import { fetchSignedRawPut, type CliRuntime } from "./runtime.js";
import type { MediaUploadSession, Operation } from "./adapters/protocol.js";

export const PLAYLIST_BUNDLE_SCHEMA = "screenrig.playlist-bundle/v1";
export const PLAYLIST_BUNDLE_MANIFEST = "screenrig-bundle.json";
export const PLAYLIST_BUNDLE_PLAYLIST = "playlist.json";

const JSON_FILE_LIMIT = 8 * 1024 * 1024;
const MAX_MEDIA_BYTES = 1_073_741_824;
const MEDIA_UPLOAD_ADMISSION_QUOTA = 20;
const MEDIA_UPLOAD_ADMISSION_WINDOW_MS = 60_000;
const MEDIA_UPLOAD_RATE_LIMIT_RETRIES = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_ID_PATTERN = /^med_[A-Za-z0-9_-]+$/;
const CONTROL_PATTERN = /[\u0000-\u001F\u007F]/u;

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

interface JsonRecord {
  [key: string]: unknown;
}

export interface PlaylistBundleMedia {
  source_id: string;
  path: string;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  tag?: string;
}

export interface PlaylistBundleManifest {
  schema: typeof PLAYLIST_BUNDLE_SCHEMA;
  selector_policy: "snapshot";
  comments_policy: "excluded";
  playlist: {
    source_id: string;
    source_revision: number;
    path: typeof PLAYLIST_BUNDLE_PLAYLIST;
  };
  media: PlaylistBundleMedia[];
}

interface RemoteMedia extends PlaylistBundleMedia {
  id: string;
  kind?: string;
}

export interface PlaylistBundlePreflight {
  root: string;
  manifest: PlaylistBundleManifest;
  playlist: JsonRecord;
  files: Map<string, { path: string; handle: FileHandle }>;
  close(): Promise<void>;
}

export interface PlaylistBundleExportResult {
  schema: typeof PLAYLIST_BUNDLE_SCHEMA;
  directory: string;
  playlist_id: string;
  playlist_revision: number;
  media_count: number;
  media_bytes: number;
}

export interface PlaylistBundleImportResult {
  schema: typeof PLAYLIST_BUNDLE_SCHEMA;
  directory: string;
  source_playlist_id: string;
  playlist: unknown;
  mode: "create" | "update";
  media: {
    total: number;
    reused: number;
    uploaded: number;
  };
}

function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError(`${name} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function stringField(owner: JsonRecord, key: string, name: string): string {
  const value = owner[key];
  if (typeof value !== "string" || value.length === 0) {
    throw usageError(`${name}.${key} must be a non-empty string.`);
  }
  return value;
}

function integerField(owner: JsonRecord, key: string, name: string): number {
  const value = owner[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw usageError(`${name}.${key} must be a non-negative whole number.`);
  }
  return value as number;
}

function exactKeys(owner: JsonRecord, allowed: readonly string[], name: string): void {
  const extras = Object.keys(owner).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw usageError(`${name} contains unsupported fields: ${extras.join(", ")}.`);
}

function canonicalExtension(contentType: string): string {
  const extension = EXTENSION_BY_TYPE[contentType];
  if (!extension) throw usageError(`Unsupported bundle media content type: ${contentType}.`);
  return extension;
}

function safeRelativePath(value: string, name: string): string {
  if (
    !value ||
    CONTROL_PATTERN.test(value) ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw usageError(`${name} must be a safe relative POSIX path.`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw usageError(`${name} must not contain empty or traversal segments.`);
  }
  if (path.posix.normalize(value) !== value) throw usageError(`${name} is not normalized.`);
  return value;
}

function safeFilename(value: string): string {
  if (
    CONTROL_PATTERN.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    Buffer.byteLength(value, "utf8") > 255
  ) {
    throw usageError("Bundle media filename must be a 1 to 255 byte basename without control characters.");
  }
  return value;
}

function sparse(info: { size: number; blocks?: number }): boolean {
  return typeof info.blocks === "number" && info.blocks * 512 < info.size;
}

async function assertNoSymlinkAncestors(target: string, allowMissing = false): Promise<void> {
  const root = path.parse(target).root;
  let current = path.dirname(target);
  while (current !== root) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
        current = path.dirname(current);
        continue;
      }
      throw usageError(`Cannot inspect bundle ancestor ${current}: ${error instanceof Error ? error.message : "missing path"}`);
    }
    if (info.isSymbolicLink()) throw usageError(`Bundle path has a symlinked ancestor: ${current}.`);
    if (!info.isDirectory()) throw usageError(`Bundle ancestor is not a directory: ${current}.`);
    current = path.dirname(current);
  }
}

async function openBundleFile(root: string, relative: string, maxBytes: number) {
  safeRelativePath(relative, "Bundle file path");
  const absolute = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw usageError("Bundle file escaped the bundle directory.");
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(absolute)]);
  } catch (error) {
    throw usageError(`Cannot resolve bundle file ${relative}: ${error instanceof Error ? error.message : "missing file"}`);
  }
  const canonicalPrefix = canonicalRoot.endsWith(path.sep) ? canonicalRoot : `${canonicalRoot}${path.sep}`;
  if (canonicalRoot !== root || canonicalFile !== absolute || !canonicalFile.startsWith(canonicalPrefix)) {
    throw usageError(`Bundle file must stay within the real, symlink-free bundle root: ${relative}.`);
  }

  let before;
  try {
    before = await lstat(absolute);
  } catch (error) {
    throw usageError(`Cannot inspect bundle file ${relative}: ${error instanceof Error ? error.message : "missing file"}`);
  }
  if (before.isSymbolicLink()) throw usageError(`Bundle file must not be a symlink: ${relative}.`);
  if (!before.isFile()) throw usageError(`Bundle path must be a regular file: ${relative}.`);
  if (before.nlink !== 1) throw usageError(`Bundle file must not be a hardlink: ${relative}.`);
  if (sparse(before)) throw usageError(`Bundle file must not be sparse: ${relative}.`);
  if (before.size > maxBytes) throw usageError(`Bundle file exceeds its size limit: ${relative}.`);

  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw usageError(`Cannot open bundle file ${relative}: ${error instanceof Error ? error.message : "open failed"}`);
  }
  const after = await handle.stat();
  if (!after.isFile() || after.nlink !== 1 || sparse(after) || after.dev !== before.dev || after.ino !== before.ino) {
    await handle.close();
    throw usageError(`Bundle file changed or is unsafe: ${relative}.`);
  }
  return { absolute, handle, info: after };
}

async function readBundleJson(root: string, relative: string): Promise<unknown> {
  const opened = await openBundleFile(root, relative, JSON_FILE_LIMIT);
  try {
    const text = await opened.handle.readFile("utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw usageError(`Cannot parse ${relative}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  } finally {
    await opened.handle.close();
  }
}

async function holdVerifiedBundleFile(
  root: string,
  relative: string,
  expectedBytes: number,
): Promise<{ path: string; handle: FileHandle; sha256: string }> {
  const opened = await openBundleFile(root, relative, MAX_MEDIA_BYTES);
  try {
    if (opened.info.size !== expectedBytes) {
      throw usageError(`Bundle media length mismatch for ${relative}: expected ${expectedBytes}, found ${opened.info.size}.`);
    }
    const hash = createHash("sha256");
    for await (const chunk of opened.handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    return { path: opened.absolute, handle: opened.handle, sha256: hash.digest("hex") };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

function parseManifest(input: unknown): PlaylistBundleManifest {
  const root = record(input, PLAYLIST_BUNDLE_MANIFEST);
  exactKeys(root, ["schema", "selector_policy", "comments_policy", "playlist", "media"], PLAYLIST_BUNDLE_MANIFEST);
  if (root.schema !== PLAYLIST_BUNDLE_SCHEMA) {
    throw usageError(`${PLAYLIST_BUNDLE_MANIFEST}.schema must be ${PLAYLIST_BUNDLE_SCHEMA}.`);
  }
  if (root.selector_policy !== "snapshot") {
    throw usageError(`${PLAYLIST_BUNDLE_MANIFEST}.selector_policy must be snapshot.`);
  }
  if (root.comments_policy !== "excluded") {
    throw usageError(`${PLAYLIST_BUNDLE_MANIFEST}.comments_policy must be excluded.`);
  }
  const playlist = record(root.playlist, `${PLAYLIST_BUNDLE_MANIFEST}.playlist`);
  exactKeys(playlist, ["source_id", "source_revision", "path"], `${PLAYLIST_BUNDLE_MANIFEST}.playlist`);
  const sourceId = stringField(playlist, "source_id", `${PLAYLIST_BUNDLE_MANIFEST}.playlist`);
  if (!sourceId.startsWith("pl_")) throw usageError("Bundle source playlist id must start with pl_.");
  const sourceRevision = integerField(playlist, "source_revision", `${PLAYLIST_BUNDLE_MANIFEST}.playlist`);
  if (sourceRevision < 1) throw usageError("Bundle source playlist revision must be positive.");
  if (playlist.path !== PLAYLIST_BUNDLE_PLAYLIST) {
    throw usageError(`Bundle playlist path must be ${PLAYLIST_BUNDLE_PLAYLIST}.`);
  }
  if (!Array.isArray(root.media)) throw usageError(`${PLAYLIST_BUNDLE_MANIFEST}.media must be an array.`);

  const seenIds = new Set<string>();
  const media = root.media.map((value, index): PlaylistBundleMedia => {
    const itemName = `${PLAYLIST_BUNDLE_MANIFEST}.media[${index}]`;
    const item = record(value, itemName);
    exactKeys(item, ["source_id", "path", "filename", "content_type", "bytes", "sha256", "tag"], itemName);
    const id = stringField(item, "source_id", itemName);
    if (!MEDIA_ID_PATTERN.test(id)) throw usageError(`${itemName}.source_id is not a media id.`);
    if (seenIds.has(id)) throw usageError(`Bundle media source id is duplicated: ${id}.`);
    seenIds.add(id);
    const sha256 = stringField(item, "sha256", itemName);
    if (!SHA256_PATTERN.test(sha256)) throw usageError(`${itemName}.sha256 must be lowercase SHA-256 hex.`);
    const contentType = stringField(item, "content_type", itemName);
    const expectedPath = `media/${sha256}${canonicalExtension(contentType)}`;
    const mediaPath = safeRelativePath(stringField(item, "path", itemName), `${itemName}.path`);
    if (mediaPath !== expectedPath) throw usageError(`${itemName}.path must be ${expectedPath}.`);
    const filename = safeFilename(stringField(item, "filename", itemName));
    const bytes = integerField(item, "bytes", itemName);
    if (bytes < 1 || bytes > MAX_MEDIA_BYTES) throw usageError(`${itemName}.bytes is outside the media upload bounds.`);
    const tag = item.tag;
    if (tag !== undefined && (typeof tag !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(tag))) {
      throw usageError(`${itemName}.tag must be 1 to 32 letters or digits.`);
    }
    return {
      source_id: id,
      path: mediaPath,
      filename,
      content_type: contentType,
      bytes,
      sha256,
      ...(typeof tag === "string" ? { tag } : {}),
    };
  });
  return {
    schema: PLAYLIST_BUNDLE_SCHEMA,
    selector_policy: "snapshot",
    comments_policy: "excluded",
    playlist: { source_id: sourceId, source_revision: sourceRevision, path: PLAYLIST_BUNDLE_PLAYLIST },
    media,
  };
}

export async function preflightPlaylistBundle(directory: string): Promise<PlaylistBundlePreflight> {
  const root = path.resolve(directory);
  await assertNoSymlinkAncestors(root);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw usageError(`Cannot inspect playlist bundle directory: ${error instanceof Error ? error.message : "missing directory"}`);
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw usageError("Playlist bundle source must be a real directory, not a symlink.");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    throw usageError(`Cannot resolve playlist bundle directory: ${error instanceof Error ? error.message : "missing directory"}`);
  }
  if (canonicalRoot !== root) throw usageError("Playlist bundle source must have no symlinked path components.");
  const manifest = parseManifest(await readBundleJson(root, PLAYLIST_BUNDLE_MANIFEST));
  const playlist = record(await readBundleJson(root, PLAYLIST_BUNDLE_PLAYLIST), PLAYLIST_BUNDLE_PLAYLIST);
  const mediaKinds = new Map(manifest.media.map((item) => [
    item.source_id,
    item.content_type.startsWith("image/") ? "image" as const : "video" as const,
  ]));
  const referenced = validatePlaylistWrite(playlist, mediaKinds);
  const listed = new Set(manifest.media.map((item) => item.source_id));
  const missing = [...referenced].filter((id) => !listed.has(id));
  const unused = [...listed].filter((id) => !referenced.has(id));
  if (missing.length > 0) throw usageError(`Bundle manifest is missing referenced media: ${missing.join(", ")}.`);
  if (unused.length > 0) throw usageError(`Bundle manifest lists unreferenced media: ${unused.join(", ")}.`);

  const files = new Map<string, { path: string; handle: FileHandle }>();
  const close = async () => {
    const held = [...files.values()];
    files.clear();
    await Promise.allSettled(held.map((file) => file.handle.close()));
  };
  try {
    for (const item of manifest.media) {
      const verified = await holdVerifiedBundleFile(root, item.path, item.bytes);
      if (verified.sha256 !== item.sha256) {
        await verified.handle.close();
        throw usageError(`Bundle media SHA-256 mismatch for ${item.path}.`);
      }
      files.set(item.source_id, { path: verified.path, handle: verified.handle });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { root, manifest, playlist, files, close };
}

function normalizedMediaSelector(items: unknown, original: unknown): JsonRecord {
  if (!Array.isArray(items) || items.length < 1 || items.length > 32) {
    throw usageError("Playlist export requires 1 to 32 resolved media items per placement.");
  }
  const ids = items.map((value, index) => {
    const item = record(value, `Resolved media item ${index}`);
    const id = stringField(item, "media_id", `Resolved media item ${index}`);
    if (!MEDIA_ID_PATTERN.test(id)) throw usageError("Playlist contains an invalid resolved media id.");
    return id;
  });
  if (new Set(ids).size !== ids.length) throw usageError("Playlist contains duplicate resolved media ids in one selector.");
  const originalRecord = record(original, "Playlist media selector");
  const oneAtATime = originalRecord.one_at_a_time === true;
  if (ids.length === 1 && !oneAtATime) return { by: "id", media_id: ids[0] };
  return { by: "ids", media_ids: ids, one_at_a_time: oneAtATime };
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

export function normalizePlaylistForBundle(input: unknown): { id: string; revision: number; playlist: JsonRecord; mediaIds: string[] } {
  const source = record(input, "Playlist");
  const id = stringField(source, "id", "Playlist");
  const revision = integerField(source, "revision", "Playlist");
  const name = stringField(source, "name", "Playlist");
  if (!Array.isArray(source.pages)) throw usageError("Playlist.pages must be an array.");
  const mediaIds = new Set<string>();
  const pages = source.pages.map((pageValue, pageIndex) => {
    const page = record(pageValue, `Playlist.pages[${pageIndex}]`);
    if (!Array.isArray(page.placements)) throw usageError(`Playlist.pages[${pageIndex}].placements must be an array.`);
    const placements = page.placements.map((placementValue, placementIndex) => {
      const placement = record(placementValue, `Playlist.pages[${pageIndex}].placements[${placementIndex}]`);
      const content = record(placement.content, `Playlist.pages[${pageIndex}].placements[${placementIndex}].content`);
      const type = content.type;
      if (type === "application") throw usageError("Playlist export does not support application placements; export stopped before media download.");
      let normalizedContent: JsonRecord;
      if (type === "iframe") {
        normalizedContent = {
          type: "iframe",
          src: stringField(content, "src", "Iframe content"),
          title: stringField(content, "title", "Iframe content"),
        };
      } else if (type === "image" || type === "video") {
        const selector = normalizedMediaSelector(content.items, content.selector);
        const ids = selector.by === "id" ? [selector.media_id] : selector.media_ids;
        for (const mediaId of ids as string[]) mediaIds.add(mediaId);
        normalizedContent = {
          type,
          selector,
          ...(type === "image" && typeof content.alt === "string" ? { alt: content.alt } : {}),
          ...(type === "image" && typeof content.dwell_ms === "number" ? { dwell_ms: content.dwell_ms } : {}),
          ...(type === "video" ? { muted: content.muted === true, loop: content.loop === true } : {}),
        };
      } else {
        throw usageError("Playlist export encountered an unsupported placement content type.");
      }
      return {
        id: stringField(placement, "id", "Playlist placement"),
        content: normalizedContent,
        rect: cloneJson(placement.rect),
        layer: placement.layer,
        content_fit: placement.content_fit,
        ...(placement.enter !== undefined ? { enter: cloneJson(placement.enter) } : {}),
      };
    });
    return {
      id: stringField(page, "id", "Playlist page"),
      canvas: cloneJson(page.canvas),
      transition: cloneJson(page.transition),
      advance: cloneJson(page.advance),
      ...(page.visibility !== undefined ? { visibility: cloneJson(page.visibility) } : {}),
      placements,
    };
  });
  return { id, revision, playlist: { name, pages }, mediaIds: [...mediaIds].sort() };
}

function parseRemoteMedia(input: unknown, expectedId: string): RemoteMedia {
  const media = record(input, `Media ${expectedId}`);
  const id = stringField(media, "id", `Media ${expectedId}`);
  if (id !== expectedId) throw usageError(`Media response id mismatch for ${expectedId}.`);
  const sha256 = stringField(media, "sha256", `Media ${expectedId}`);
  if (!SHA256_PATTERN.test(sha256)) throw usageError(`Media ${expectedId} has an invalid SHA-256.`);
  const contentType = stringField(media, "content_type", `Media ${expectedId}`);
  const bytes = integerField(media, "bytes", `Media ${expectedId}`);
  if (bytes < 1 || bytes > MAX_MEDIA_BYTES) throw usageError(`Media ${expectedId} is outside the export size bounds.`);
  const tag = media.tag;
  if (tag !== undefined && typeof tag !== "string") throw usageError(`Media ${expectedId} has an invalid tag.`);
  return {
    id,
    source_id: id,
    path: `media/${sha256}${canonicalExtension(contentType)}`,
    filename: safeFilename(stringField(media, "filename", `Media ${expectedId}`)),
    content_type: contentType,
    bytes,
    sha256,
    ...(typeof tag === "string" ? { tag } : {}),
  };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

function validateMediaHeaders(headers: Record<string, string>, media: RemoteMedia): void {
  const length = header(headers, "content-length");
  const contentType = header(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const etag = header(headers, "etag");
  if (contentType !== media.content_type) throw usageError(`Media ${media.id} export Content-Type did not match metadata.`);
  if (length !== String(media.bytes)) throw usageError(`Media ${media.id} export Content-Length did not match metadata.`);
  if (etag !== `"${media.sha256}"`) throw usageError(`Media ${media.id} export ETag did not match metadata SHA-256.`);
}

async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(filename, 0o600);
}

async function streamMediaToFile(client: ApiClient, media: RemoteMedia, filename: string): Promise<void> {
  const head = await client.call({ method: "HEAD", path: `/api/v1/media/${media.id}/content` });
  validateMediaHeaders(head.headers, media);
  const response = await client.download({ method: "GET", path: `/api/v1/media/${media.id}/content` });
  validateMediaHeaders(response.headers, media);
  if (!response.body) throw usageError(`Media ${media.id} export returned no body.`);

  const handle = await open(filename, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += written.bytesWritten;
      }
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (bytes > media.bytes) throw usageError(`Media ${media.id} export exceeded the declared length.`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (bytes !== media.bytes) throw usageError(`Media ${media.id} export ended before the declared length.`);
  if (hash.digest("hex") !== media.sha256) throw usageError(`Media ${media.id} export SHA-256 did not match metadata.`);
  await chmod(filename, 0o600);
}

async function destinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw usageError(`Playlist export destination already exists: ${destination}.`);
}

export async function exportPlaylistBundle(options: {
  playlistId: string;
  outputDirectory: string;
  client: ApiClient;
}): Promise<PlaylistBundleExportResult> {
  if (!options.playlistId.startsWith("pl_")) throw usageError("playlist export requires a playlist id starting with pl_.");
  const destination = path.resolve(options.outputDirectory);
  await assertNoSymlinkAncestors(destination, true);
  await destinationAbsent(destination);
  const playlistResponse = await options.client.call({ method: "GET", path: `/api/v1/playlists/${options.playlistId}` });
  const normalized = normalizePlaylistForBundle(playlistResponse.body);
  if (normalized.id !== options.playlistId) throw usageError("Playlist export response id did not match the requested playlist.");

  // Resolve and validate every metadata row before creating local output or downloading bytes.
  const media: RemoteMedia[] = [];
  for (const mediaId of normalized.mediaIds) {
    const response = await options.client.call({ method: "GET", path: `/api/v1/media/${mediaId}` });
    media.push(parseRemoteMedia(response.body, mediaId));
  }

  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(parent, `.${path.basename(destination)}.tmp-`));
  await chmod(temporary, 0o700);
  try {
    const mediaDirectory = path.join(temporary, "media");
    await mkdir(mediaDirectory, { mode: 0o700 });
    await chmod(mediaDirectory, 0o700);
    await writePrivateJson(path.join(temporary, PLAYLIST_BUNDLE_PLAYLIST), normalized.playlist);
    const writtenPaths = new Set<string>();
    for (const item of media) {
      if (writtenPaths.has(item.path)) continue;
      await streamMediaToFile(options.client, item, path.join(temporary, item.path));
      writtenPaths.add(item.path);
    }
    const manifest: PlaylistBundleManifest = {
      schema: PLAYLIST_BUNDLE_SCHEMA,
      selector_policy: "snapshot",
      comments_policy: "excluded",
      playlist: {
        source_id: normalized.id,
        source_revision: normalized.revision,
        path: PLAYLIST_BUNDLE_PLAYLIST,
      },
      media: media.map(({ id: _id, kind: _kind, ...item }) => item),
    };
    await writePrivateJson(path.join(temporary, PLAYLIST_BUNDLE_MANIFEST), manifest);
    await destinationAbsent(destination);
    await rename(temporary, destination);
    return {
      schema: PLAYLIST_BUNDLE_SCHEMA,
      directory: destination,
      playlist_id: normalized.id,
      playlist_revision: normalized.revision,
      media_count: media.length,
      media_bytes: media.reduce((sum, item) => sum + item.bytes, 0),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function deriveBundleIdempotencyKey(base: string, phase: string, identity: string): string {
  if (!isValidIdempotencyKey(base)) throw usageError("Invalid base idempotency key for playlist import.");
  const key = createHash("sha256")
    .update("screenrig.playlist-bundle\0")
    .update(phase)
    .update("\0")
    .update(identity)
    .update("\0")
    .update(base)
    .digest("base64url");
  if (!isValidIdempotencyKey(key) || key === base) throw usageError("Could not derive playlist import idempotency key.");
  return key;
}

function existingMediaList(input: unknown): RemoteMedia[] {
  const root = record(input, "Media list");
  if (!Array.isArray(root.items)) throw usageError("Media list response must contain items.");
  return root.items.map((item, index) => {
    const value = record(item, `Media list item ${index}`);
    const id = stringField(value, "id", `Media list item ${index}`);
    if (!MEDIA_ID_PATTERN.test(id)) throw usageError(`Media list item ${index} has an invalid id.`);
    const sha256 = stringField(value, "sha256", `Media list item ${index}`);
    if (!SHA256_PATTERN.test(sha256)) throw usageError(`Media list item ${index} has an invalid SHA-256.`);
    const contentType = stringField(value, "content_type", `Media list item ${index}`);
    canonicalExtension(contentType);
    return {
      id,
      source_id: id,
      path: "",
      filename: stringField(value, "filename", `Media list item ${index}`),
      content_type: contentType,
      bytes: integerField(value, "bytes", `Media list item ${index}`),
      sha256,
      ...(typeof value.tag === "string" ? { tag: value.tag } : {}),
    };
  });
}

function exactMediaMatch(candidate: RemoteMedia, source: PlaylistBundleMedia): boolean {
  return candidate.filename === source.filename &&
    candidate.content_type === source.content_type &&
    candidate.bytes === source.bytes &&
    candidate.sha256 === source.sha256 &&
    candidate.tag === source.tag;
}

function rewritePlaylistIds(playlist: JsonRecord, mapping: Map<string, string>): JsonRecord {
  const output = cloneJson(playlist);
  const pages = output.pages as JsonRecord[];
  for (const page of pages) {
    for (const placement of page.placements as JsonRecord[]) {
      const content = placement.content as JsonRecord;
      if (content.type !== "image" && content.type !== "video") continue;
      const selector = content.selector as JsonRecord;
      if (selector.by === "id") {
        const source = selector.media_id as string;
        const destination = mapping.get(source);
        if (!destination) throw usageError(`No imported media mapping exists for ${source}.`);
        selector.media_id = destination;
      } else {
        selector.media_ids = (selector.media_ids as string[]).map((source) => {
          const destination = mapping.get(source);
          if (!destination) throw usageError(`No imported media mapping exists for ${source}.`);
          return destination;
        });
      }
    }
  }
  return output;
}

function mediaIdFromOperation(operation: Operation): string | undefined {
  const id = operation.result?.media_id;
  return typeof id === "string" && MEDIA_ID_PATTERN.test(id) ? id : undefined;
}

function writeImportProgress(runtime: CliRuntime, message: string): void {
  runtime.stderr.write(`${message}\n`);
}

function mediaUploadAdmissionLimiter(runtime: CliRuntime): {
  waitForSlot(): Promise<void>;
  recordAdmission(): void;
} {
  const admissions: number[] = [];
  return {
    async waitForSlot(): Promise<void> {
      while (true) {
        const now = runtime.now().getTime();
        while (admissions.length > 0 && now - admissions[0]! >= MEDIA_UPLOAD_ADMISSION_WINDOW_MS) {
          admissions.shift();
        }
        if (admissions.length < MEDIA_UPLOAD_ADMISSION_QUOTA) return;
        const waitMs = admissions[0]! + MEDIA_UPLOAD_ADMISSION_WINDOW_MS - now;
        writeImportProgress(
          runtime,
          `Playlist import is waiting ${Math.ceil(waitMs / 1000)} seconds for media upload admission.`,
        );
        await runtime.sleep(waitMs);
      }
    },
    recordAdmission(): void {
      admissions.push(runtime.now().getTime());
    },
  };
}

async function declareBundleMediaUpload(options: {
  client: ApiClient;
  runtime: CliRuntime;
  limiter: ReturnType<typeof mediaUploadAdmissionLimiter>;
  idempotencyKey: string;
  body: JsonRecord;
}): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  let rateLimitRetries = 0;
  while (true) {
    await options.limiter.waitForSlot();
    try {
      const response = await options.client.call({
        method: "POST",
        path: "/api/v1/media/uploads",
        idempotent: true,
        idempotencyKey: options.idempotencyKey,
        body: options.body,
      });
      options.limiter.recordAdmission();
      return response;
    } catch (error) {
      const retryAfterSeconds = error instanceof CliError && error.problem.status === 429
        ? error.problem.retry_after_seconds
        : undefined;
      if (retryAfterSeconds === undefined || rateLimitRetries >= MEDIA_UPLOAD_RATE_LIMIT_RETRIES) throw error;
      rateLimitRetries += 1;
      writeImportProgress(
        options.runtime,
        `Playlist import is rate limited; waiting ${retryAfterSeconds} seconds before retrying the same media declaration.`,
      );
      await options.runtime.sleep(retryAfterSeconds * 1000);
      // Only the replay-safe declaration is retried, with its exact key and body.
      // Signed uploads, commits, and playlist writes are never retried here.
    }
  }
}

function rethrowRateLimitedImport(error: unknown, state: {
  uploaded: string[];
  mutationStarted: boolean;
  playlistWriteStarted: boolean;
}): void {
  if (!(error instanceof CliError) || error.problem.status !== 429) return;
  const count = state.uploaded.length;
  const confirmed = count > 0
    ? ` The import is partially complete: ${count} new media object${count === 1 ? " is" : "s are"} confirmed ready.`
    : "";
  let phase: string;
  let next = error.problem.next;
  if (state.playlistWriteStarted) {
    phase = " The playlist write request was sent and its outcome may be unknown. No cleanup was attempted, and no media was deleted.";
    next = {
      command: error.problem.next?.command ?? "retry the same playlist import command",
      reason: `${error.problem.next?.reason ? `${error.problem.next.reason} ` : ""}Read back the destination account when practical, then retry the exact import with the same idempotency key; an exact playlist-write replay returns the original outcome.`,
    };
  } else if (count > 0) {
    phase = " No playlist write was started, no cleanup was attempted, and no media was deleted.";
  } else if (state.mutationStarted) {
    phase = " Media upload work was admitted, but no new media object is confirmed ready. No playlist write was started, no cleanup was attempted, and no media was deleted.";
  } else {
    phase = " No media upload or playlist write was admitted; the import made no remote mutation.";
  }
  throw new CliError(
    {
      ...error.problem,
      detail: `${error.problem.detail}${confirmed}${phase}`,
      errors: [
        ...error.problem.errors,
        ...state.uploaded.map((media_id) => ({ code: "confirmed_media_ready", media_id })),
      ],
      next,
    },
    error.exitCode,
    error.warnings,
  );
}

function partialImportError(
  error: unknown,
  uploaded: string[],
  mutationStarted: boolean,
  playlistWriteStarted: boolean,
): never {
  if (!mutationStarted) throw error;
  const cause = error instanceof CliError ? error.problem.code : "import_failed";
  const playlistState = playlistWriteStarted
    ? "The playlist write outcome may be unknown"
    : "No playlist write was started";
  throw new CliError(
    makeProblem(
      "bundle_import_partial",
      "Playlist bundle import stopped after remote mutation",
      409,
      `The import stopped after starting media upload work (${cause}). ${uploaded.length} new media object${uploaded.length === 1 ? " is" : "s are"} ready. ${playlistState}, and no media was deleted. Retry the same bundle to reuse exact media.`,
      {
        errors: uploaded.map((media_id) => ({ code: "confirmed_media_ready", media_id })),
        next: {
          command: "retry the same playlist import command with the same --idempotency-key when supplied",
          reason: "The importer lists and reuses exact ready media before uploading missing objects.",
        },
      },
    ),
    ExitCode.Conflict,
  );
}

export async function importPlaylistBundle(options: {
  directory: string;
  client: ApiClient;
  runtime: CliRuntime;
  updateId?: string;
  ifMatch?: string;
  timeoutMs?: number;
  pollMs?: number;
  beforePlaylistWrite?: (playlist: JsonRecord, updateId: string | undefined) => Promise<void>;
}): Promise<PlaylistBundleImportResult> {
  if (options.updateId && !options.ifMatch) throw usageError("playlist import --update requires --if-match REVISION.");
  if (!options.updateId && options.ifMatch) throw usageError("playlist import --if-match requires --update PLAYLIST_ID.");
  if (options.updateId && !options.updateId.startsWith("pl_")) throw usageError("playlist import --update requires a playlist id starting with pl_.");
  const ifMatch = options.ifMatch ? quotedRevision(options.ifMatch) : undefined;

  // This completes every local structure, path, type, size, and digest check before a network mutation.
  const bundle = await preflightPlaylistBundle(options.directory);
  const usedDestinationIds = new Set<string>();
  const mapping = new Map<string, string>();
  let reused = 0;
  let mutationStarted = false;
  let playlistWriteStarted = false;
  const uploaded: string[] = [];
  const admissionLimiter = mediaUploadAdmissionLimiter(options.runtime);

  try {
    if (options.updateId && options.ifMatch) {
      const target = await options.client.call({ method: "GET", path: `/api/v1/playlists/${options.updateId}` });
      const targetBody = record(target.body, "Playlist update target");
      if (targetBody.id !== options.updateId) throw usageError("Playlist update target response did not match --update.");
      const current = targetBody.revision;
      const expected = Number(options.ifMatch.replaceAll('"', ""));
      if (!Number.isSafeInteger(current) || current !== expected) {
        throw new CliError(
          makeProblem(
            "revision_conflict",
            "Playlist revision changed",
            409,
            `Playlist ${options.updateId} is at revision ${String(current)}; no media upload was started.`,
            { current_revision: typeof current === "number" ? current : undefined },
          ),
          ExitCode.Conflict,
        );
      }
    }
    await options.beforePlaylistWrite?.(bundle.playlist, options.updateId);
    const list = await options.client.call({ method: "GET", path: "/api/v1/media" });
    const existing = existingMediaList(list.body);
    for (const source of bundle.manifest.media) {
      const reusable = existing
        .filter((candidate) => !usedDestinationIds.has(candidate.id) && exactMediaMatch(candidate, source))
        .sort((left, right) => {
          if (left.id === source.source_id) return -1;
          if (right.id === source.source_id) return 1;
          return left.id.localeCompare(right.id);
        })[0];
      if (reusable) {
        mapping.set(source.source_id, reusable.id);
        usedDestinationIds.add(reusable.id);
        reused += 1;
        continue;
      }

      const declareKey = deriveBundleIdempotencyKey(options.client.idempotencyKey, "media-declare", source.source_id);
      const commitKey = deriveBundleIdempotencyKey(options.client.idempotencyKey, "media-commit", source.source_id);
      const declarationResponse = await declareBundleMediaUpload({
        client: options.client,
        runtime: options.runtime,
        limiter: admissionLimiter,
        idempotencyKey: declareKey,
        body: {
          filename: source.filename,
          content_type: source.content_type,
          bytes: source.bytes,
          sha256: source.sha256,
          ...(source.tag ? { tag: source.tag } : {}),
        },
      });
      mutationStarted = true;
      if (header(declarationResponse.headers, "cache-control") !== "private, no-store") {
        throw usageError("Media upload declaration did not return the required private, no-store cache policy.");
      }
      const session = validateMediaUploadSession(declarationResponse.body as MediaUploadSession, options.runtime.now().getTime());
      const held = bundle.files.get(source.source_id);
      if (!held) throw usageError(`Bundle media handle disappeared from preflight: ${source.source_id}.`);
      await performSignedMediaStreamPut(
        held.handle.createReadStream({ autoClose: false, start: 0 }),
        session,
        options.runtime.signedRawPut ?? fetchSignedRawPut(),
      );
      const commit = await options.client.call({
        method: "POST",
        path: `/api/v1/media/uploads/${session.id}/commit`,
        idempotent: true,
        idempotencyKey: commitKey,
        body: { content_type: source.content_type, bytes: source.bytes, sha256: source.sha256 },
      });
      let operation = commit.body as Operation;
      operation = await options.client.waitForOperation(operation.id, {
        timeoutMs: options.timeoutMs ?? 120_000,
        pollMs: options.pollMs ?? 1000,
        sleep: options.runtime.sleep,
      });
      const destinationId = mediaIdFromOperation(operation);
      if (!destinationId) throw usageError(`Media import operation for ${source.source_id} returned no ready media id.`);
      if (usedDestinationIds.has(destinationId)) throw usageError("Media import did not produce an injective source-to-destination mapping.");
      usedDestinationIds.add(destinationId);
      mapping.set(source.source_id, destinationId);
      uploaded.push(destinationId);
    }

    const playlist = rewritePlaylistIds(bundle.playlist, mapping);
    const playlistKey = deriveBundleIdempotencyKey(
      options.client.idempotencyKey,
      options.updateId ? "playlist-update" : "playlist-create",
      options.updateId ?? bundle.manifest.playlist.source_id,
    );
    playlistWriteStarted = true;
    const response = await options.client.call({
      method: options.updateId ? "PUT" : "POST",
      path: options.updateId ? `/api/v1/playlists/${options.updateId}` : "/api/v1/playlists",
      idempotent: true,
      idempotencyKey: playlistKey,
      headers: ifMatch ? { "if-match": ifMatch } : undefined,
      body: playlist,
    });
    return {
      schema: PLAYLIST_BUNDLE_SCHEMA,
      directory: bundle.root,
      source_playlist_id: bundle.manifest.playlist.source_id,
      playlist: response.body,
      mode: options.updateId ? "update" : "create",
      media: { total: bundle.manifest.media.length, reused, uploaded: uploaded.length },
    };
  } catch (error) {
    rethrowRateLimitedImport(error, { uploaded, mutationStarted, playlistWriteStarted });
    partialImportError(error, uploaded, mutationStarted, playlistWriteStarted);
  } finally {
    await bundle.close();
  }
}
