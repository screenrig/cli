import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { ApiClient } from "./client.js";
import {
  LOOK_AT_THE_CONTACT_SHEET,
  lintPlaylistPages,
  pixelsFromPng,
  type LintFinding,
  type PixelBuffer,
} from "./compose/lint.js";

export { LOOK_AT_THE_CONTACT_SHEET };
import { ffmpegLookup, runProcessFor } from "./media/ffmpeg.js";
import { assertPlaylistValid } from "./playlist-validate.js";
import { expandPlaylistPages } from "./playlist-templates.js";
import { usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

export const PREVIEW_STATES = ["rest", "entry", "motion-mid"] as const;
export type PreviewState = (typeof PREVIEW_STATES)[number];
export const PREVIEW_VIEWPORT = { width: 1920, height: 1080 };
export const ENTRY_TIME_MS = 700;
export const OBJECT_ENTER_DELAY_MS = 500;
export const OBJECT_ENTER_DURATION_MS = 400;
export const OBJECT_ENTER_STAGGER_STEP_MS = 120;
export const CONTACT_SHEET_COLUMNS = 6;
export const CONTACT_SHEET_TILE_WIDTH = 320;
export const CONTACT_SHEET_TILE_HEIGHT = 180;
export const CONTACT_SHEET_LABEL_HEIGHT = 28;

const MEDIA_EXTENSIONS = [".png", ".webp", ".jpg", ".jpeg", ".gif", ".mp4", ".webm"];
const VIDEO_TYPES = new Set([".mp4", ".webm"]);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Size {
  width: number;
  height: number;
}

interface Transform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

interface ContinuousRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ResolvedPrimitive {
  id: string;
  kind: string;
  sourceIndex: number;
  layer: number;
  paintOrder: number;
  rect: Rect;
  viewportRect: Rect;
  clipRect: Rect;
  contentRect: Rect;
  contentFit: "contain" | "cover" | "fill";
  enter?: { type: string; stagger?: number };
  motion?: Record<string, unknown>;
  selector?: Record<string, unknown>;
  src?: string;
  title?: string;
  image?: Image;
  label?: string;
}

interface PreviewPage {
  id: string;
  raw: Record<string, unknown>;
  canvas: { width: number; height: number; viewportFit: "contain" | "cover" | "fill"; background: unknown };
  transitionDurationMs: number;
  primitives: ResolvedPrimitive[];
}

export interface PreviewPageResult {
  id: string;
  files: Record<PreviewState, string>;
  lint_count: number;
}

export interface PlaylistPreviewResult {
  output: string;
  viewport: Size;
  pages: PreviewPageResult[];
  contact_sheet?: string;
  lint: LintFinding[];
}

export async function previewPlaylist(options: {
  playlist: unknown;
  outputDirectory: string;
  viewport?: Size;
  frameMs?: number;
  contactSheet?: boolean;
  lintOnly?: boolean;
  searchDirs?: string[];
  client?: ApiClient;
  runtime?: CliRuntime;
}): Promise<PlaylistPreviewResult> {
  const viewport = options.viewport ?? PREVIEW_VIEWPORT;
  if (![viewport.width, viewport.height].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw usageError("playlist preview viewport width and height must be positive integers.");
  }
  const body = normalizePlaylist(options.playlist);
  assertPlaylistValid(body);
  const pages = await preparePages(body.pages, viewport, options);
  const restPixels = new Map<string, PixelBuffer>();
  const pageResults: PreviewPageResult[] = [];
  if (!options.lintOnly) await mkdir(options.outputDirectory, { recursive: true });
  for (const page of pages) {
    const files = {} as Record<PreviewState, string>;
    for (const state of PREVIEW_STATES) {
      const png = renderPage(page, viewport, state);
      const filename = path.join(options.outputDirectory, `${page.id}.${state}.png`);
      files[state] = filename;
      if (state === "rest") restPixels.set(page.id, await pixelsFromPng(png));
      if (!options.lintOnly) await writeFile(filename, png);
    }
    pageResults.push({ id: page.id, files, lint_count: 0 });
  }
  const lint = lintPlaylistPages(body.pages, { pixelsByPage: restPixels });
  for (const result of pageResults) {
    result.lint_count = lint.filter((item) => item.page_id === result.id).length;
  }
  let contact_sheet: string | undefined;
  if (options.contactSheet) {
    contact_sheet = path.join(options.outputDirectory, "contact-sheet.png");
    const sheet = await renderContactSheet(pages, viewport, lint, options.lintOnly ? undefined : options.outputDirectory);
    if (!options.lintOnly) await writeFile(contact_sheet, sheet.png);
  }
  return {
    output: options.outputDirectory,
    viewport,
    pages: pageResults,
    ...(contact_sheet ? { contact_sheet } : {}),
    lint,
  };
}

export function contactSheetSize(pageCount: number): Size {
  const rows = Math.max(1, Math.ceil(pageCount / CONTACT_SHEET_COLUMNS));
  return {
    width: CONTACT_SHEET_COLUMNS * CONTACT_SHEET_TILE_WIDTH,
    height: rows * (CONTACT_SHEET_TILE_HEIGHT + CONTACT_SHEET_LABEL_HEIGHT),
  };
}

function normalizePlaylist(input: unknown): { name: string; pages: unknown[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw usageError("Playlist JSON must be an object with name and pages.");
  }
  const raw = input as Record<string, unknown>;
  const pages = Array.isArray(raw.pages) ? expandPlaylistPages(raw.pages) : undefined;
  if (typeof raw.name !== "string" || !pages) {
    throw usageError("Playlist JSON must contain string name and array pages.");
  }
  return { name: raw.name, pages };
}

async function preparePages(
  pages: unknown[],
  viewport: Size,
  options: {
    frameMs?: number;
    searchDirs?: string[];
    client?: ApiClient;
    runtime?: CliRuntime;
  },
): Promise<PreviewPage[]> {
  const prepared: PreviewPage[] = [];
  for (const value of pages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "page";
    const canvasValue = recordOf(raw.canvas);
    const canvas = {
      width: numberOf(canvasValue.width, 1920),
      height: numberOf(canvasValue.height, 1080),
      viewportFit: fitOf(canvasValue.viewport_fit, "contain"),
      background: canvasValue.background ?? "#000000FF",
    };
    const transition = recordOf(raw.transition);
    const source = Array.isArray(raw.primitives) ? raw.primitives : [];
    const primitives: ResolvedPrimitive[] = [];
    for (const [sourceIndex, item] of source.entries()) {
      const primitive = recordOf(item);
      const rectValue = recordOf(primitive.rect);
      const rect: Rect = {
        x: numberOf(rectValue.x, 0),
        y: numberOf(rectValue.y, 0),
        width: numberOf(rectValue.width, 0),
        height: numberOf(rectValue.height, 0),
      };
      const kind = typeof primitive.primitive === "string" ? primitive.primitive : "image";
      const selector = recordOf(primitive.selector);
      const media = kind === "image" || kind === "video"
        ? await loadMedia(selector, kind, options)
        : undefined;
      primitives.push({
        id: typeof primitive.id === "string" ? primitive.id : `p${sourceIndex}`,
        kind,
        sourceIndex,
        layer: numberOf(primitive.layer, 0),
        paintOrder: 0,
        rect,
        viewportRect: rect,
        clipRect: rect,
        contentRect: rect,
        contentFit: fitOf(primitive.content_fit, kind === "iframe" || kind === "application" ? "fill" : "contain"),
        enter: enterOf(primitive.enter),
        motion: primitive.motion && typeof primitive.motion === "object" ? primitive.motion as Record<string, unknown> : undefined,
        selector,
        src: typeof primitive.src === "string" ? primitive.src : undefined,
        title: typeof primitive.title === "string" ? primitive.title : undefined,
        image: media?.image,
        label: media?.label ?? placeholderLabel(kind, primitive),
      });
    }
    const resolved = resolvePage({ canvas, primitives, viewport });
    prepared.push({
      id,
      raw,
      canvas,
      transitionDurationMs: numberOf(transition.duration_ms, 0),
      primitives: resolved,
    });
  }
  return prepared;
}

function resolvePage(args: {
  canvas: { width: number; height: number; viewportFit: "contain" | "cover" | "fill" };
  primitives: ResolvedPrimitive[];
  viewport: Size;
}): ResolvedPrimitive[] {
  const mapping = canvasTransform(args.canvas, args.viewport, args.canvas.viewportFit);
  const canvasViewportRect = snapRect(mapContinuous({ x: 0, y: 0, width: args.canvas.width, height: args.canvas.height }, mapping));
  const viewportRect: Rect = { x: 0, y: 0, width: snapEndpoint(args.viewport.width), height: snapEndpoint(args.viewport.height) };
  const canvasClipRect = intersect(canvasViewportRect, viewportRect);
  const ordered = args.primitives
    .map((primitive, sourceIndex) => ({ primitive, sourceIndex }))
    .sort((left, right) => left.primitive.layer - right.primitive.layer || left.sourceIndex - right.sourceIndex);
  return ordered.map(({ primitive, sourceIndex }, paintOrder) => {
    const continuous = mapContinuous(primitive.rect, mapping);
    const viewportPrimitive = snapRect(continuous);
    const clipRect = intersect(intersect(viewportPrimitive, canvasViewportRect), viewportRect);
    const contentRect = fitContent(continuous, primitive);
    return {
      ...primitive,
      sourceIndex,
      paintOrder,
      viewportRect: viewportPrimitive,
      clipRect,
      contentRect: intersect(contentRect, clipRect),
      label: primitive.label,
    };
  }).map((primitive) => ({ ...primitive, clipRect: intersect(primitive.clipRect, canvasClipRect) }));
}

function canvasTransform(canvas: Size, viewport: Size, fit: "contain" | "cover" | "fill"): Transform {
  if (fit === "fill") return { scaleX: viewport.width / canvas.width, scaleY: viewport.height / canvas.height, offsetX: 0, offsetY: 0 };
  const scale = fit === "contain"
    ? Math.min(viewport.width / canvas.width, viewport.height / canvas.height)
    : Math.max(viewport.width / canvas.width, viewport.height / canvas.height);
  return {
    scaleX: scale,
    scaleY: scale,
    offsetX: (viewport.width - canvas.width * scale) / 2,
    offsetY: (viewport.height - canvas.height * scale) / 2,
  };
}

function mapContinuous(rect: Rect, mapping: Transform): ContinuousRect {
  return {
    left: mapping.offsetX + rect.x * mapping.scaleX,
    top: mapping.offsetY + rect.y * mapping.scaleY,
    right: mapping.offsetX + (rect.x + rect.width) * mapping.scaleX,
    bottom: mapping.offsetY + (rect.y + rect.height) * mapping.scaleY,
  };
}

function snapEndpoint(value: number): number {
  return Math.floor(value + 0.5);
}

function snapRect(rect: ContinuousRect): Rect {
  const x = snapEndpoint(rect.left);
  const y = snapEndpoint(rect.top);
  const farX = snapEndpoint(rect.right);
  const farY = snapEndpoint(rect.bottom);
  return { x, y, width: Math.max(0, farX - x), height: Math.max(0, farY - y) };
}

function intersect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const farX = Math.min(left.x + left.width, right.x + right.width);
  const farY = Math.min(left.y + left.height, right.y + right.height);
  if (farX <= x || farY <= y) return { x, y, width: 0, height: 0 };
  return { x, y, width: farX - x, height: farY - y };
}

function fitContent(primitiveRect: ContinuousRect, primitive: ResolvedPrimitive): Rect {
  if (primitive.contentFit === "fill" || !primitive.image) return snapRect(primitiveRect);
  const primitiveWidth = primitiveRect.right - primitiveRect.left;
  const primitiveHeight = primitiveRect.bottom - primitiveRect.top;
  const scale = primitive.contentFit === "contain"
    ? Math.min(primitiveWidth / primitive.image.width, primitiveHeight / primitive.image.height)
    : Math.max(primitiveWidth / primitive.image.width, primitiveHeight / primitive.image.height);
  const width = primitive.image.width * scale;
  const height = primitive.image.height * scale;
  const left = primitiveRect.left + (primitiveWidth - width) / 2;
  const top = primitiveRect.top + (primitiveHeight - height) / 2;
  return snapRect({ left, top, right: left + width, bottom: top + height });
}

function renderPage(page: PreviewPage, viewport: Size, state: PreviewState): Buffer {
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111111";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  const mapping = canvasTransform(page.canvas, viewport, page.canvas.viewportFit);
  const canvasRect = snapRect(mapContinuous({ x: 0, y: 0, width: page.canvas.width, height: page.canvas.height }, mapping));
  const clip = intersect(canvasRect, { x: 0, y: 0, width: viewport.width, height: viewport.height });
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.clip();
  fillBackground(ctx, clip, page.canvas.background);
  for (const primitive of page.primitives) {
    paintPrimitive(ctx, primitive, state);
  }
  ctx.restore();
  return Buffer.from(canvas.toBuffer("image/png"));
}

function fillBackground(ctx: SKRSContext2D, rect: Rect, background: unknown): void {
  if (typeof background === "string") {
    ctx.fillStyle = cssColor(background);
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  const gradient = recordOf(background);
  if (gradient.type !== "linear" || !Array.isArray(gradient.stops)) {
    ctx.fillStyle = "#000000";
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  const fill = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.height);
  for (const stop of gradient.stops) {
    const item = recordOf(stop);
    if (typeof item.color === "string" && typeof item.at === "number") fill.addColorStop(item.at, cssColor(item.color));
  }
  ctx.fillStyle = fill;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

function paintPrimitive(ctx: SKRSContext2D, primitive: ResolvedPrimitive, state: PreviewState): void {
  const clip = primitive.clipRect;
  if (clip.width <= 0 || clip.height <= 0) return;
  const pose = poseOf(primitive, state);
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.clip();
  ctx.globalAlpha = pose.opacity;
  const cx = clip.x + clip.width / 2;
  const cy = clip.y + clip.height / 2;
  ctx.translate(cx + pose.x, cy + pose.y);
  ctx.rotate(pose.rotate);
  ctx.scale(pose.scale, pose.scale);
  ctx.translate(-cx, -cy);
  if (primitive.image) {
    const content = primitive.contentRect;
    ctx.drawImage(primitive.image, content.x, content.y, Math.max(1, content.width), Math.max(1, content.height));
  } else {
    drawPlaceholder(ctx, clip, primitive.label ?? primitive.kind);
  }
  ctx.restore();
}

function poseOf(primitive: ResolvedPrimitive, state: PreviewState): { x: number; y: number; scale: number; rotate: number; opacity: number } {
  const pose = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 };
  if (state === "entry" && primitive.enter) {
    const stagger = typeof primitive.enter.stagger === "number" ? primitive.enter.stagger : 0;
    const delay = OBJECT_ENTER_DELAY_MS + stagger * OBJECT_ENTER_STAGGER_STEP_MS;
    const progress = enterProgress(ENTRY_TIME_MS, delay);
    const eased = easeOut(progress);
    pose.opacity = eased;
    const offset = 0.12;
    switch (primitive.enter.type) {
      case "fade-up": pose.y = (1 - eased) * primitive.clipRect.height * offset; break;
      case "fade-down": pose.y = (1 - eased) * -primitive.clipRect.height * offset; break;
      case "fade-left": pose.x = (1 - eased) * primitive.clipRect.width * offset; break;
      case "fade-right": pose.x = (1 - eased) * -primitive.clipRect.width * offset; break;
      case "zoom-in": pose.scale = 0.92 + 0.08 * eased; break;
      case "zoom-out": pose.scale = 1.08 - 0.08 * eased; break;
      default: break;
    }
    return pose;
  }
  if (state !== "motion-mid" || !primitive.motion) return pose;
  const motion = primitive.motion;
  const type = motion.type;
  if (type === "spin") {
    const direction = motion.direction === "ccw" ? -1 : 1;
    pose.rotate = direction * Math.PI;
    return pose;
  }
  if (type === "drift") {
    const zoom = motion.zoom === "out" ? -1 : 1;
    pose.scale = 1 + zoom * 0.04;
    const amount = 0.02;
    switch (motion.direction) {
      case "left": pose.x = -primitive.clipRect.width * amount; break;
      case "right": pose.x = primitive.clipRect.width * amount; break;
      case "up": pose.y = -primitive.clipRect.height * amount; break;
      case "down": pose.y = primitive.clipRect.height * amount; break;
      default: break;
    }
    return pose;
  }
  if (type === "path" && Array.isArray(motion.points)) {
    const start = { x: primitive.rect.x, y: primitive.rect.y };
    const points = (motion.points as unknown[]).flatMap((item) => {
      const point = recordOf(item);
      return typeof point.x === "number" && typeof point.y === "number" ? [{ x: point.x, y: point.y }] : [];
    });
    const along = [start, ...points];
    const loop = motion.loop === "ping-pong" || motion.loop === "once" ? along : [...along, start];
    const pos = pointAtFraction(loop, 0.5);
    pose.x = pos.x - start.x;
    pose.y = pos.y - start.y;
  }
  return pose;
}

function enterProgress(timeMs: number, delayMs: number): number {
  if (timeMs <= delayMs) return 0;
  if (timeMs >= delayMs + OBJECT_ENTER_DURATION_MS) return 1;
  return (timeMs - delayMs) / OBJECT_ENTER_DURATION_MS;
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function pointAtFraction(points: Array<{ x: number; y: number }>, fraction: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let total = 0;
  const lengths: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    const length = Math.hypot(dx, dy);
    lengths.push(length);
    total += length;
  }
  let remaining = total * fraction;
  for (let i = 1; i < points.length; i++) {
    const length = lengths[i - 1] ?? 0;
    if (remaining <= length || i === points.length - 1) {
      const t = length === 0 ? 0 : remaining / length;
      return {
        x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t,
        y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1]!;
}

function drawPlaceholder(ctx: SKRSContext2D, rect: Rect, label: string): void {
  ctx.fillStyle = "#6B7280";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.fillStyle = "#E5E7EB";
  ctx.font = `${Math.max(16, Math.min(32, Math.round(rect.height / 8)))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2, Math.max(8, rect.width - 16));
}

async function renderContactSheet(
  pages: PreviewPage[],
  viewport: Size,
  lint: LintFinding[],
  directory?: string,
): Promise<{ png: Buffer; width: number; height: number }> {
  const size = contactSheetSize(Math.max(1, pages.length));
  const canvas = createCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#17202A";
  ctx.fillRect(0, 0, size.width, size.height);
  for (const [index, page] of pages.entries()) {
    const col = index % CONTACT_SHEET_COLUMNS;
    const row = Math.floor(index / CONTACT_SHEET_COLUMNS);
    const x = col * CONTACT_SHEET_TILE_WIDTH;
    const y = row * (CONTACT_SHEET_TILE_HEIGHT + CONTACT_SHEET_LABEL_HEIGHT);
    const rest = directory
      ? await loadImage(path.join(directory, `${page.id}.rest.png`))
      : await loadImage(renderPage(page, viewport, "rest"));
    const scale = Math.min(CONTACT_SHEET_TILE_WIDTH / rest.width, CONTACT_SHEET_TILE_HEIGHT / rest.height);
    const dw = rest.width * scale;
    const dh = rest.height * scale;
    ctx.drawImage(rest, x + (CONTACT_SHEET_TILE_WIDTH - dw) / 2, y + (CONTACT_SHEET_TILE_HEIGHT - dh) / 2, dw, dh);
    const count = lint.filter((item) => item.page_id === page.id).length;
    ctx.fillStyle = count > 0 ? "#FFCC80" : "#FFFFFF";
    ctx.font = "16px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(`${page.id} · ${count}`, x + 8, y + CONTACT_SHEET_TILE_HEIGHT + 20, CONTACT_SHEET_TILE_WIDTH - 16);
  }
  return { png: Buffer.from(canvas.toBuffer("image/png")), ...size };
}

async function loadMedia(
  selector: Record<string, unknown>,
  kind: string,
  options: { frameMs?: number; searchDirs?: string[]; client?: ApiClient; runtime?: CliRuntime },
): Promise<{ image?: Image; label?: string } | undefined> {
  const mediaId = mediaIdOf(selector);
  if (!mediaId) return { label: kind === "video" ? "video" : "image" };
  const local = await findLocalMedia(mediaId, options.searchDirs ?? []);
  if (local) {
    if (VIDEO_TYPES.has(path.extname(local).toLowerCase())) {
      const poster = await videoPoster(local, options.frameMs ?? 1000, options.runtime);
      if (poster) return { image: await loadImage(poster) };
      return { label: "video" };
    }
    try {
      return { image: await loadImage(local) };
    } catch {
      return { label: kind };
    }
  }
  if (options.client) {
    const fetched = await fetchMedia(options.client, mediaId, kind, options);
    if (fetched) return fetched;
  }
  return { label: kind === "video" ? "video" : mediaId };
}

function mediaIdOf(selector: Record<string, unknown>): string | undefined {
  if (selector.by === "id" && typeof selector.media_id === "string") return selector.media_id;
  if (selector.by === "ids" && Array.isArray(selector.media_ids) && typeof selector.media_ids[0] === "string") {
    return selector.media_ids[0];
  }
  return undefined;
}

async function findLocalMedia(mediaId: string, dirs: string[]): Promise<string | undefined> {
  for (const dir of dirs) {
    for (const extension of MEDIA_EXTENSIONS) {
      const candidate = path.join(dir, `${mediaId}${extension}`);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Keep looking; missing local compose output is not an error.
      }
    }
  }
  return undefined;
}

async function fetchMedia(
  client: ApiClient,
  mediaId: string,
  kind: string,
  options: { frameMs?: number; runtime?: CliRuntime },
): Promise<{ image?: Image; label?: string } | undefined> {
  try {
    const meta = await client.call({ method: "GET", path: `/api/v1/media/${mediaId}` });
    const body = recordOf(meta.body);
    const contentType = typeof body.content_type === "string" ? body.content_type : "";
    const download = await client.download({ method: "GET", path: `/api/v1/media/${mediaId}/content` });
    if (!download.body) return { label: kind };
    const bytes = await readStream(download.body);
    await download.body.cancel?.();
    if (contentType.startsWith("video/") || kind === "video") {
      if (!options.runtime) return { label: "video" };
      const dir = await mkdtemp(path.join(tmpdir(), "screenrig-preview-"));
      const temp = path.join(dir, "source.bin");
      try {
        await writeFile(temp, bytes);
        const poster = await videoPoster(temp, options.frameMs ?? 1000, options.runtime);
        if (poster) return { image: await loadImage(poster) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return { label: "video" };
    }
    return { image: await loadImage(bytes) };
  } catch {
    return { label: kind };
  }
}

async function videoPoster(file: string, frameMs: number, runtime?: CliRuntime): Promise<Buffer | undefined> {
  if (!runtime?.runProcess) return undefined;
  const dir = await mkdtemp(path.join(tmpdir(), "screenrig-poster-"));
  const output = path.join(dir, "poster.png");
  try {
    const lookup = ffmpegLookup(runtime.env);
    const run = runProcessFor(runtime);
    const seconds = Math.max(0, frameMs) / 1000;
    const result = await run({
      command: lookup.ffmpeg,
      args: ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(seconds), "-i", file, "-frames:v", "1", output],
      timeoutMs: 15_000,
    });
    if (result.code !== 0) return undefined;
    return await readFile(output);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readStream(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function placeholderLabel(kind: string, primitive: Record<string, unknown>): string {
  if (kind === "iframe") return typeof primitive.title === "string" ? primitive.title : "iframe";
  if (kind === "application") return "application";
  return kind;
}

function enterOf(value: unknown): { type: string; stagger?: number } | undefined {
  const enter = recordOf(value);
  if (typeof enter.type !== "string") return undefined;
  return { type: enter.type, stagger: typeof enter.stagger === "number" ? enter.stagger : undefined };
}

function fitOf(value: unknown, fallback: "contain" | "cover" | "fill"): "contain" | "cover" | "fill" {
  return value === "contain" || value === "cover" || value === "fill" ? value : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cssColor(value: string): string {
  const raw = value.replace("#", "");
  if (raw.length === 8) {
    const r = Number.parseInt(raw.slice(0, 2), 16);
    const g = Number.parseInt(raw.slice(2, 4), 16);
    const b = Number.parseInt(raw.slice(4, 6), 16);
    const a = Number.parseInt(raw.slice(6, 8), 16) / 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  return value;
}
