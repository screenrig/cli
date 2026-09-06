import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Box, ComposeQuality } from "./compose.js";
import { VIEWING_DISTANCES, VIEWING_XHEIGHT_RATIO, XHEIGHT_FALLBACK, parseViewing, type ViewingDistance } from "./type.js";
import { cssFont } from "./fonts.js";

export { VIEWING_DISTANCES, parseViewing };
export type { ViewingDistance };

export const LOOK_AT_THE_CONTACT_SHEET =
  "Look at the contact sheet before publishing. Fix what the lint names, then look again.";

export const LINT_CODES = [
  "low_contrast_rendered",
  "text_over_busy_image",
  "too_small_for_distance",
  "too_dense",
  "collision",
  "motion_overuse",
  "adjacent_repeat",
  "safe_margin",
] as const;

export type LintCode = (typeof LINT_CODES)[number];

export const FREEFORM_WORD_BUDGET = 60;
export { VIEWING_XHEIGHT_RATIO, XHEIGHT_FALLBACK };

const COLLISION_OVERLAP = 0.2;
const FULL_BLEED_COVERAGE = 0.95;
const CONTRAST_MIN = 4.5;
const BUSY_STDDEV = 40;
const SAFE_MARGIN = 0.04;

export interface LintFinding {
  page_id: string;
  code: LintCode;
  id: string;
  message: string;
}

export interface PixelBuffer {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export function viewingOf(spec: unknown): ViewingDistance {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "mid";
  return parseViewing((spec as { viewing?: unknown }).viewing);
}

export function sortLint(findings: LintFinding[], pageOrder: string[]): LintFinding[] {
  const order = new Map(pageOrder.map((id, index) => [id, index]));
  const codeOrder = new Map(LINT_CODES.map((code, index) => [code, index]));
  return [...findings].sort((left, right) => {
    const page = (order.get(left.page_id) ?? 0) - (order.get(right.page_id) ?? 0);
    if (page !== 0) return page;
    const code = (codeOrder.get(left.code) ?? 0) - (codeOrder.get(right.code) ?? 0);
    if (code !== 0) return code;
    return left.id.localeCompare(right.id);
  });
}

export async function pixelsFromPng(png: Buffer): Promise<PixelBuffer> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, image.width, image.height);
  return { data: imageData.data, width: image.width, height: image.height };
}

export function lintComposedPage(args: {
  page_id: string;
  spec: unknown;
  quality: ComposeQuality;
  pixels?: PixelBuffer;
  viewing?: ViewingDistance;
}): LintFinding[] {
  const findings: LintFinding[] = [];
  const viewing = args.viewing ?? viewingOf(args.spec);
  const frame = args.quality.output;
  const shorter = Math.min(frame.width, frame.height);
  const minXHeight = shorter * VIEWING_XHEIGHT_RATIO[viewing];
  const wordCount = countSpecWords(args.spec);
  if (wordCount > FREEFORM_WORD_BUDGET) {
    findings.push({
      page_id: args.page_id,
      code: "too_dense",
      id: "page",
      message: `${args.page_id}: ${wordCount} words exceed the ${FREEFORM_WORD_BUDGET} word budget for this page.`,
    });
  }
  const measure = createCanvas(8, 8).getContext("2d");
  const seen = new Set<string>();
  for (const run of args.quality.text) {
    if (seen.has(`${run.layer}:${run.role}:${run.font_size}`)) continue;
    seen.add(`${run.layer}:${run.role}:${run.font_size}`);
    const xHeight = measureXHeight(measure, run.family, run.font_size);
    if (xHeight + 0.05 < minXHeight) {
      findings.push({
        page_id: args.page_id,
        code: "too_small_for_distance",
        id: run.layer,
        message: `${args.page_id}: ${run.layer} x-height ${xHeight.toFixed(1)}px is below the ${viewing} minimum ${minXHeight.toFixed(1)}px.`,
      });
    }
    if (!isFullBleed(run.ink, frame) && withinSafeMargin(run.ink, frame)) {
      findings.push({
        page_id: args.page_id,
        code: "safe_margin",
        id: run.layer,
        message: `${args.page_id}: ${run.layer} ink sits within 4% of a frame edge.`,
      });
    }
    if (args.pixels) {
      const contrast = sampledContrast(args.pixels, run.ink);
      if (contrast !== undefined && contrast < CONTRAST_MIN) {
        findings.push({
          page_id: args.page_id,
          code: "low_contrast_rendered",
          id: run.layer,
          message: `${args.page_id}: ${run.layer} contrast ${contrast.toFixed(2)}:1 is below 4.5:1.`,
        });
      }
      if (overBusyImage(run.ink, args.quality, args.pixels)) {
        findings.push({
          page_id: args.page_id,
          code: "text_over_busy_image",
          id: run.layer,
          message: `${args.page_id}: ${run.layer} sits on a high-variance image.`,
        });
      }
    }
  }
  return findings;
}

function countSpecWords(value: unknown): number {
  if (typeof value === "string") {
    const bits = value.trim().split(/\s+/);
    return bits[0] ? bits.length : 0;
  }
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + countSpecWords(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  let n = 0;
  for (const key of ["title", "subtitle", "text", "footer", "price"]) {
    if (key in record) n += countSpecWords(record[key]);
  }
  if (Array.isArray(record.cards)) n += countSpecWords(record.cards);
  if (record.card && typeof record.card === "object") n += countSpecWords(record.card);
  if (record.table && typeof record.table === "object") n += countSpecWords(record.table);
  if (Array.isArray(record.pages)) n += countSpecWords(record.pages);
  for (const name of ["fullpage", "left", "right", "left-third", "middle-third", "right-third", "middle-half", "top-half", "bottom-half", "top", "bottom"]) {
    if (name in record) n += countSpecWords(record[name]);
  }
  return n;
}

export function lintAdjacentComposePages(pages: Array<{ id: string; spec: unknown }>): LintFinding[] {
  const findings: LintFinding[] = [];
  for (let i = 1; i < pages.length; i++) {
    const previous = pages[i - 1]!;
    const current = pages[i]!;
    const left = regionKey(previous.spec);
    const right = regionKey(current.spec);
    if (left && right && left === right) {
      findings.push({
        page_id: current.id,
        code: "adjacent_repeat",
        id: current.id,
        message: `${current.id}: repeats region set ${left} from ${previous.id}.`,
      });
    }
  }
  return findings;
}

export function lintPlaylistPages(
  pages: unknown[],
  options: { pixelsByPage?: Map<string, PixelBuffer> } = {},
): LintFinding[] {
  const findings: LintFinding[] = [];
  const records = pages.map(pageRecord);
  for (const [index, page] of records.entries()) {
    if (!page) continue;
    findings.push(...lintPlaylistPage(page, options.pixelsByPage?.get(page.id)));
    if (index === 0) continue;
    const previous = records[index - 1];
    if (!previous) continue;
    if (rectSet(previous) === rectSet(page) && rectSet(page) !== "") {
      findings.push({
        page_id: page.id,
        code: "adjacent_repeat",
        id: page.primitives[0]?.id ?? page.id,
        message: `${page.id}: identical primitive rect set to ${previous.id}.`,
      });
    }
  }
  return sortLint(findings, records.map((page) => page?.id ?? ""));
}

function lintPlaylistPage(page: PlaylistPage, pixels?: PixelBuffer): LintFinding[] {
  const findings: LintFinding[] = [];
  const canvas = page.canvas;
  const motions = page.primitives.filter((primitive) => primitive.motion);
  if (motions.length > 1) {
    for (const extra of motions.slice(1)) {
      findings.push({
        page_id: page.id,
        code: "motion_overuse",
        id: extra.id,
        message: `${page.id}: more than one persistent motion (${extra.id}).`,
      });
    }
  }
  const enters = page.primitives.filter((primitive) => primitive.enter && !isFullBleed(primitive.rect, canvas));
  if (enters.length > 2) {
    for (const extra of enters.slice(2)) {
      findings.push({
        page_id: page.id,
        code: "motion_overuse",
        id: extra.id,
        message: `${page.id}: more than two enter effects with text (${extra.id}).`,
      });
    }
  }
  for (let i = 0; i < page.primitives.length; i++) {
    for (let j = i + 1; j < page.primitives.length; j++) {
      const first = page.primitives[i]!;
      const second = page.primitives[j]!;
      if (isFullBleed(first.rect, canvas) || isFullBleed(second.rect, canvas)) continue;
      const overlap = overlapBox(first.rect, second.rect);
      if (!overlap) continue;
      const ratio = area(overlap) / Math.min(area(first.rect), area(second.rect));
      if (ratio > COLLISION_OVERLAP) {
        findings.push({
          page_id: page.id,
          code: "collision",
          id: second.id,
          message: `${page.id}: ${first.id} overlaps ${second.id} by ${(ratio * 100).toFixed(0)}%.`,
        });
      }
    }
  }
  for (const primitive of page.primitives) {
    if (isFullBleed(primitive.rect, canvas)) continue;
    if (withinSafeMargin(primitive.rect, canvas)) {
      findings.push({
        page_id: page.id,
        code: "safe_margin",
        id: primitive.id,
        message: `${page.id}: ${primitive.id} sits within 4% of a canvas edge.`,
      });
    }
    if (pixels && primitive.kind === "image" && !isFullBleed(primitive.rect, canvas)) {
      const stddev = luminanceStddev(pixels, primitive.rect);
      if (stddev > BUSY_STDDEV) {
        const overlay = page.primitives.find((other) => other.id !== primitive.id && overlapBox(other.rect, primitive.rect));
        if (overlay) {
          findings.push({
            page_id: page.id,
            code: "text_over_busy_image",
            id: overlay.id,
            message: `${page.id}: ${overlay.id} sits on a high-variance image without a plate.`,
          });
        }
      }
    }
  }
  return findings;
}

interface PlaylistPage {
  id: string;
  raw: Record<string, unknown>;
  canvas: Box;
  primitives: Array<{
    id: string;
    kind: string;
    rect: Box;
    motion?: unknown;
    enter?: unknown;
  }>;
}

function pageRecord(value: unknown): PlaylistPage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "page";
  const canvasValue = raw.canvas;
  const canvasRecord = canvasValue && typeof canvasValue === "object" && !Array.isArray(canvasValue)
    ? canvasValue as Record<string, unknown>
    : {};
  const canvas: Box = {
    x: 0,
    y: 0,
    width: numberOf(canvasRecord.width, 1920),
    height: numberOf(canvasRecord.height, 1080),
  };
  const primitives = Array.isArray(raw.primitives) ? raw.primitives.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const primitive = item as Record<string, unknown>;
    const rectValue = primitive.rect;
    const rectRecord = rectValue && typeof rectValue === "object" && !Array.isArray(rectValue)
      ? rectValue as Record<string, unknown>
      : {};
    return [{
      id: typeof primitive.id === "string" ? primitive.id : "primitive",
      kind: typeof primitive.primitive === "string" ? primitive.primitive : "image",
      rect: {
        x: numberOf(rectRecord.x, 0),
        y: numberOf(rectRecord.y, 0),
        width: numberOf(rectRecord.width, 0),
        height: numberOf(rectRecord.height, 0),
      },
      motion: primitive.motion,
      enter: primitive.enter,
    }];
  }) : [];
  return { id, raw, canvas, primitives };
}

function rectSet(page: PlaylistPage): string {
  return page.primitives
    .map((primitive) => `${primitive.rect.x},${primitive.rect.y},${primitive.rect.width},${primitive.rect.height}`)
    .sort()
    .join("|");
}

function regionKey(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return undefined;
  const record = spec as Record<string, unknown>;
  const names = ["fullpage", "left", "right", "left-third", "middle-third", "right-third", "middle-half", "top-half", "bottom-half", "top", "bottom"]
    .filter((name) => record[name] != null);
  return names.length ? names.join("+") : undefined;
}

function area(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function overlapBox(left: Box, right: Box): Box | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  if (width <= 1 || height <= 1) return undefined;
  return { x, y, width, height };
}

function isFullBleed(box: Box, frame: { width: number; height: number }): boolean {
  const coverage = area(overlapBox(box, { x: 0, y: 0, width: frame.width, height: frame.height }) ?? { x: 0, y: 0, width: 0, height: 0 })
    / Math.max(1, frame.width * frame.height);
  return coverage >= FULL_BLEED_COVERAGE;
}

function withinSafeMargin(box: Box, frame: { width: number; height: number }): boolean {
  const inset = Math.min(frame.width, frame.height) * SAFE_MARGIN;
  return box.x < inset
    || box.y < inset
    || box.x + box.width > frame.width - inset
    || box.y + box.height > frame.height - inset;
}

function overBusyImage(ink: Box, quality: ComposeQuality, pixels: PixelBuffer): boolean {
  for (const image of quality.images) {
    const box = { x: 0, y: 0, width: image.box.width, height: image.box.height };
    const overlap = overlapBox(ink, box);
    if (!overlap) continue;
    if (luminanceStddev(pixels, overlap) > BUSY_STDDEV) return true;
  }
  if (quality.images.length === 0) return false;
  return luminanceStddev(pixels, ink) > BUSY_STDDEV && quality.images.length > 0;
}

function measureXHeight(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  family: string,
  size: number,
): number {
  ctx.font = cssFont("400", size, family);
  const metrics = ctx.measureText("x");
  const measured = metrics.actualBoundingBoxAscent;
  if (Number.isFinite(measured) && measured > 0) return measured;
  return size * XHEIGHT_FALLBACK;
}

function sampledContrast(pixels: PixelBuffer, box: Box): number | undefined {
  const samples: number[] = [];
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(pixels.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(pixels.height, Math.ceil(box.y + box.height));
  if (right <= left || bottom <= top) return undefined;
  const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 48));
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const i = (y * pixels.width + x) * 4;
      const a = pixels.data[i + 3] ?? 0;
      if (a < 16) continue;
      samples.push(luminanceOf(pixels.data[i] ?? 0, pixels.data[i + 1] ?? 0, pixels.data[i + 2] ?? 0));
    }
  }
  if (samples.length < 4) return undefined;
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.15)] ?? samples[0]!;
  const hi = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.85))] ?? samples[samples.length - 1]!;
  return (Math.max(hi, lo) + 0.05) / (Math.min(hi, lo) + 0.05);
}

function luminanceStddev(pixels: PixelBuffer, box: Box): number {
  const values: number[] = [];
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(pixels.width, Math.ceil(box.x + box.width));
  const bottom = Math.min(pixels.height, Math.ceil(box.y + box.height));
  const step = Math.max(1, Math.floor(Math.max(right - left, bottom - top) / 64));
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const i = (y * pixels.width + x) * 4;
      values.push(0.2126 * (pixels.data[i] ?? 0) + 0.7152 * (pixels.data[i + 1] ?? 0) + 0.0722 * (pixels.data[i + 2] ?? 0));
    }
  }
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function luminanceOf(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function lintCodesList(): string {
  return LINT_CODES.join(", ");
}
