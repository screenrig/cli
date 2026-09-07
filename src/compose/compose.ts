import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { resolveFontFamily, resolveTextFont } from "./fonts.js";
import {
  measureMarkdown,
  measureSpans,
  spanFont,
  stripMarkdown,
  wrapMarkdown,
  type MarkdownSpan,
} from "./markdown.js";
import { parseComposeSpec } from "./parse.js";
import {
  SCALE_MAX,
  SCALE_MIN,
  leadingOf,
  sizesFor,
  textHeight,
  wrapLines,
  type TypeRamp,
} from "./type.js";
import type {
  Align,
  CardItem,
  ComposeDocument,
  LayerBlock,
  LayerManifest,
  LayerOutline,
  LayerSpec,
  LogoCorner,
  PageManifest,
  PageSpec,
  PlaylistRect,
  TableBlock,
} from "./types.js";
import { CARD_INK_PAD, LOGO_INSET, LOGO_MAX } from "./types.js";

export { resolveFontFamily } from "./fonts.js";
export { parseComposeSpec } from "./parse.js";
export { regionRect } from "./parse.js";

function usage(message: string): Error {
  return Object.assign(new Error(message), { code: "usage_error" });
}

const IMAGE_OUTPUT_EXT = /\.(png|webp|jpe?g)$/i;
const TABLE_CELL_PAD = 20;
const HOLE_KINDS = new Set(["video", "iframe", "application"]);

export function rejectImageLikeOutput(output: string, command: string): void {
  if (IMAGE_OUTPUT_EXT.test(output.trim())) {
    throw usage(`${command} --output is a directory, not an image file`);
  }
}

function isDeckSource(source: unknown): boolean {
  return Boolean(source && typeof source === "object" && !Array.isArray(source) && Array.isArray((source as { pages?: unknown }).pages));
}

export function resolveImagePath(src: string, baseDir: string, field = "image"): string {
  if (src.includes("\0")) throw usage(`${field} must not contain a NUL byte`);
  if (src.includes("://") || /^(https?|file|data):/i.test(src)) {
    throw usage(`${field} must be a local filesystem path, not a URL`);
  }
  return isAbsolute(src) ? src : join(baseDir, src);
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComposeQuality {
  target_status: "known" | "unknown";
  output: { width: number; height: number };
  target?: { width: number; height: number };
  output_scale?: { x: number; y: number };
  text: Array<{
    layer: string;
    role: string;
    box: Box;
    ink: Box;
    font_size: number;
    family: string;
  }>;
  fonts: Array<{ layer: string; family: string; fallback_from?: string; missing_codepoints: string[] }>;
  overlaps: Array<{ first: string; second: string; kind: "layer_layer"; area: number }>;
  images: Array<{
    layer: string;
    source: { width: number; height: number };
    box: { width: number; height: number };
    painted: { width: number; height: number };
    object_fit: "cover";
    scale_x: number;
    scale_y: number;
  }>;
}

export interface ComposeWarning {
  code: string;
  message: string;
}

export interface PaintedLayer {
  id: string;
  png: Buffer | null;
  family: string;
  overflow: boolean;
  scale: number;
  /** Distance from the padded region top to the first line of type. */
  originOffset: number;
  ink: Box[];
}

/**
 * Layout decisions a row of regions shares. `scale` pins the type ramp instead
 * of letting the region choose its own, and `originOffset` pins where the
 * first line starts so titles across a row sit on one baseline.
 */
interface SharedLayout {
  scale?: number;
  originOffset?: number;
}

export interface ComposePageResult {
  id: string;
  layers: LayerSpec[];
  painted: PaintedLayer[];
  manifest: PageManifest;
  combined: Buffer;
  quality: ComposeQuality;
  warnings: ComposeWarning[];
  font_family: string;
}

export interface ComposeResult {
  document: ComposeDocument;
  pages: ComposePageResult[];
  canvas: { width: number; height: number };
  name: string | null;
}

function parseColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const raw = value.replace("#", "");
  if (raw.length === 8) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    const a = parseInt(raw.slice(6, 8), 16) / 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  return `#${raw}`;
}

function sortLayers(layers: LayerSpec[]): LayerSpec[] {
  return [...layers].sort((a, b) => a.z - b.z || a.order - b.order);
}

function gapsFor(ramp: TypeRamp): Record<string, number> {
  return {
    eyebrow: Math.round(ramp.eyebrow * 0.35),
    title: Math.round(ramp.title * 0.28),
    subtitle: Math.round(ramp.subtitle * 0.35),
    text: Math.round(ramp.text * 0.45),
    cards: Math.round(ramp.card * 0.4),
    table: Math.round(ramp.table * 0.4),
    image: Math.round(ramp.text * 0.4),
    placeholder: Math.round(ramp.text * 0.4),
  };
}

function packInkWidth(
  ctx: SKRSContext2D,
  blocks: LayerBlock[],
  innerW: number,
  ramp: TypeRamp,
  family: string,
): number {
  let maxW = 0;
  const measure = (text: string, size: number, width = innerW) => {
    for (const line of wrapMarkdown(ctx, text, width, size, family)) {
      maxW = Math.max(maxW, measureSpans(ctx, line, size, family));
    }
  };
  for (const block of blocks) {
    if (block.role === "eyebrow" || block.role === "title" || block.role === "subtitle" || block.role === "text" || block.role === "footer") {
      measure(block.text, ramp[block.role]);
    } else if (block.role === "cards") {
      if (block.items.some((item) => item.price || item.image)) {
        maxW = Math.max(maxW, innerW);
      } else {
        for (const item of block.items) {
          measure(item.title, ramp.card);
          if (item.subtitle) measure(item.subtitle, ramp.small);
          if (item.text) measure(item.text, ramp.small);
        }
      }
    } else if (block.role === "table") {
      maxW = Math.max(maxW, innerW);
    }
  }
  return Math.ceil(maxW);
}

function packFixedHeight(
  ctx: SKRSContext2D,
  blocks: LayerBlock[],
  innerW: number,
  ramp: TypeRamp,
  family: string,
  itemGapBoost = 0,
): number {
  const gapAfter = gapsFor(ramp);
  let height = 0;
  for (const [i, block] of blocks.entries()) {
    if (block.role === "eyebrow" || block.role === "title" || block.role === "subtitle" || block.role === "text") {
      height += textHeight(ctx, block.text, innerW, ramp[block.role], family, leadingOf(ramp[block.role]));
    }
    else if (block.role === "cards") {
      height += measureCards(ctx, block.items, innerW, ramp, family);
      if (itemGapBoost && block.items.length > 1) height += itemGapBoost * (block.items.length - 1);
    } else if (block.role === "table") {
      height += measureTable(ctx, block, innerW, ramp, family, itemGapBoost);
    }
    if (i < blocks.length - 1) height += gapAfter[block.role] ?? 0;
  }
  return height;
}

function isSingleLinePack(ctx: SKRSContext2D, blocks: LayerBlock[], innerW: number, ramp: TypeRamp, family: string): boolean {
  if (blocks.length !== 1) return false;
  const block = blocks[0]!;
  if (block.role === "cards" || block.role === "table") return false;
  if (block.role !== "eyebrow" && block.role !== "title" && block.role !== "subtitle" && block.role !== "text") return false;
  const size = ramp[block.role];
  ctx.font = `${size}px "${family}"`;
  return wrapLines(ctx, block.text, innerW).length <= 1;
}

function chooseScale(
  ctx: SKRSContext2D,
  layer: LayerSpec,
  inner: { w: number; h: number },
  family: string,
  fixed: LayerBlock[],
  footerText: string | undefined,
): { ramp: TypeRamp; height: number; available: number; scale: number } {
  const at = (scale: number) => {
    const eyebrow = fixed.find((block) => block.role === "eyebrow");
    const title = fixed.find((block) => block.role === "title");
    const subtitle = fixed.find((block) => block.role === "subtitle");
    const ramp = sizesFor(ctx, {
      root: layer.root,
      family,
      width: inner.w,
      viewing: layer.viewing,
      eyebrow: eyebrow && eyebrow.role === "eyebrow" ? eyebrow.text : "",
      title: title && title.role === "title" ? title.text : "",
      subtitle: subtitle && subtitle.role === "subtitle" ? subtitle.text : "",
      scale,
    });
    const footerH = footerText ? textHeight(ctx, footerText, inner.w, ramp.footer, family, leadingOf(ramp.footer)) : 0;
    const footerGap = footerText ? Math.round(ramp.footer * 0.8) : 0;
    const available = Math.max(1, inner.h - footerH - footerGap);
    return { ramp, height: packFixedHeight(ctx, fixed, inner.w, ramp, family), available, scale };
  };
  const start = at(1);
  if (isSingleLinePack(ctx, fixed, inner.w, start.ramp, family)) return start;
  if (start.height > start.available) {
    let lo = SCALE_MIN;
    let hi = 1;
    let best = at(SCALE_MIN);
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const trial = at(mid);
      if (trial.height <= trial.available) {
        best = trial;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  }
  let lo = 1;
  let hi = SCALE_MAX;
  let best = start;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const trial = at(mid);
    if (trial.height <= trial.available) {
      best = trial;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function numericColumn(rows: string[][], index: number): boolean {
  return rows.every((row) => /^-?\d+(\.\d+)?$/.test(stripMarkdown(String(row[index] ?? "")).replace(/[,£$€]/g, "")));
}

function roleColor(
  layer: LayerSpec,
  role: "eyebrow" | "title" | "subtitle" | "text" | "footer" | "card" | "price" | "table-header" | "table-body",
): string {
  if (layer.ink) return layer.ink;
  if (role === "eyebrow" || role === "card" || role === "price" || role === "table-header") return layer.brand;
  if (role === "text") return layer.muted;
  return layer.text;
}

function holeOnly(layer: LayerSpec): boolean {
  if (layer.fill || layer.region === "logo") return false;
  return layer.blocks.length > 0 && layer.blocks.every((block) => (
    block.role === "placeholder" && HOLE_KINDS.has(block.kind)
  ));
}

function shouldInsetForLogo(layer: LayerSpec): boolean {
  if (layer.region === "background" || layer.region === "logo") return false;
  if (layer.fill) return true;
  return layer.blocks.some((block) => (
    block.role === "eyebrow" || block.role === "title" || block.role === "subtitle" || block.role === "text" || block.role === "footer"
    || block.role === "cards" || block.role === "table"
    || (block.role === "placeholder" && HOLE_KINDS.has(block.kind))
  ));
}

function extraPadForLogo(layer: LayerSpec, logo: Box | null): { top: number; right: number; bottom: number; left: number } {
  const zero = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!logo || !shouldInsetForLogo(layer)) return zero;
  const overlapX = Math.min(layer.x + layer.w, logo.x + logo.width) - Math.max(layer.x, logo.x);
  const overlapY = Math.min(layer.y + layer.h, logo.y + logo.height) - Math.max(layer.y, logo.y);
  if (overlapX <= 1 || overlapY <= 1) return zero;
  const extra = { ...zero };
  if (logo.x <= layer.x + 1) extra.left = Math.round(overlapX);
  if (logo.x + logo.width >= layer.x + layer.w - 1) extra.right = Math.round(overlapX);
  if (logo.y <= layer.y + 1) extra.top = Math.round(overlapY);
  if (logo.y + logo.height >= layer.y + layer.h - 1) extra.bottom = Math.round(overlapY);
  return extra;
}

export { LOGO_MAX, LOGO_INSET, CARD_INK_PAD };

export function logoSize(img: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, LOGO_MAX.width / img.width, LOGO_MAX.height / img.height);
  return {
    width: Math.max(1, Math.round(img.width * scale)),
    height: Math.max(1, Math.round(img.height * scale)),
  };
}

export function placeLogo(
  img: { width: number; height: number },
  canvas: { width: number; height: number },
  corner: LogoCorner,
): Box {
  const size = logoSize(img);
  const x = corner.endsWith("right") ? canvas.width - size.width - LOGO_INSET : LOGO_INSET;
  const y = corner.startsWith("bottom") ? canvas.height - size.height - LOGO_INSET : LOGO_INSET;
  return { x, y, width: size.width, height: size.height };
}

/** Logo painted box plus the 32 px margin back to the chosen canvas edges. */
export function reservedLogoBox(
  logo: Box,
  canvas: { width: number; height: number },
  corner: LogoCorner,
): Box {
  const right = corner.endsWith("right");
  const bottom = corner.startsWith("bottom");
  return {
    x: right ? logo.x : 0,
    y: bottom ? logo.y : 0,
    width: right ? canvas.width - logo.x : logo.x + logo.width,
    height: bottom ? canvas.height - logo.y : logo.y + logo.height,
  };
}

function measureCards(ctx: SKRSContext2D, items: CardItem[], maxW: number, ramp: TypeRamp, family: string): number {
  let height = 0;
  for (const [i, item] of items.entries()) {
    const thumb = item.image ? Math.round(ramp.card * 2.2) : 0;
    const copyW = Math.max(1, maxW - (thumb ? thumb + 16 : 0));
    let itemH = textHeight(ctx, item.title, copyW * 0.75, ramp.card, family, leadingOf(ramp.card));
    if (item.text) itemH += textHeight(ctx, item.text, copyW, ramp.small, family, leadingOf(ramp.small));
    if (item.subtitle) itemH += textHeight(ctx, item.subtitle, copyW, ramp.small, family, leadingOf(ramp.small));
    height += Math.max(itemH, thumb);
    if (i < items.length - 1) height += Math.round(ramp.card * 0.55);
  }
  return height;
}

function columnWidths(
  ctx: SKRSContext2D,
  table: TableBlock,
  innerW: number,
  headerSize: number,
  bodySize: number,
  family: string,
): { widths: number[]; numeric: boolean[] } {
  const cols = table.columns.length;
  const numeric = table.columns.map((_, i) => numericColumn(table.rows, i));
  const header = table.columns.map((col) => measureMarkdown(ctx, col, headerSize, family));
  const natural = table.columns.map((_, i) => {
    const cell = Math.max(header[i] ?? 0, ...table.rows.map((row) => measureMarkdown(ctx, String(row[i] ?? ""), bodySize, family)));
    return Math.ceil(cell) + TABLE_CELL_PAD + (numeric[i] ? TABLE_CELL_PAD : 0);
  });
  const total = natural.reduce((sum, w) => sum + w, 0);
  if (total <= innerW) {
    const leftover = innerW - total;
    const flex = numeric.lastIndexOf(false);
    const idx = flex >= 0 ? flex : 0;
    const widths = [...natural];
    widths[idx] = (widths[idx] ?? 0) + leftover;
    return { widths, numeric };
  }
  const numericTotal = natural.reduce((sum, w, i) => sum + (numeric[i] ? w : 0), 0);
  const textTotal = total - numericTotal;
  if (numericTotal < innerW * 0.7 && textTotal > 0) {
    const scale = (innerW - numericTotal) / textTotal;
    return { widths: natural.map((w, i) => (numeric[i] ? w : w * scale)), numeric };
  }
  const scale = innerW / total;
  return { widths: natural.map((w) => w * scale), numeric };
}

function measureTable(
  ctx: SKRSContext2D,
  table: TableBlock,
  innerW: number,
  ramp: TypeRamp,
  family: string,
  itemGapBoost = 0,
): number {
  const { widths, numeric } = columnWidths(ctx, table, innerW, ramp.small, ramp.table, family);
  const headerLead = leadingOf(ramp.small);
  const rowLead = leadingOf(ramp.table);
  const cellW = (index: number) => Math.max(1, (widths[index] ?? 1) - TABLE_CELL_PAD - (numeric[index] ? TABLE_CELL_PAD : 0));
  let height = 0;
  height += Math.max(headerLead, ...table.columns.map((col, i) => wrapMarkdown(ctx, col, cellW(i), ramp.small, family).length * headerLead));
  for (const [i, row] of table.rows.entries()) {
    const lines = Math.max(1, ...row.map((cell, c) => wrapMarkdown(ctx, String(cell), cellW(c), ramp.table, family).length));
    height += lines * rowLead;
    if (itemGapBoost && i < table.rows.length - 1) height += itemGapBoost;
  }
  return height;
}

function drawCover(ctx: SKRSContext2D, img: Image, x: number, y: number, w: number, h: number): { scaleX: number; scaleY: number } {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const sx = (dw - w) / 2 / scale;
  const sy = (dh - h) / 2 / scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, sx, sy, w / scale, h / scale, x, y, w, h);
  ctx.restore();
  return { scaleX: scale, scaleY: scale };
}

function drawPlaceholder(
  ctx: SKRSContext2D,
  args: { x: number; y: number; w: number; h: number; label: string; color: string; family: string; size: number },
): void {
  ctx.save();
  ctx.strokeStyle = parseColor(args.color, "#F3E6D0");
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  const r = Math.min(16, args.w / 12, args.h / 12);
  ctx.beginPath();
  ctx.moveTo(args.x + r, args.y);
  ctx.arcTo(args.x + args.w, args.y, args.x + args.w, args.y + args.h, r);
  ctx.arcTo(args.x + args.w, args.y + args.h, args.x, args.y + args.h, r);
  ctx.arcTo(args.x, args.y + args.h, args.x, args.y, r);
  ctx.arcTo(args.x, args.y, args.x + args.w, args.y, r);
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = 0.8;
  ctx.setLineDash([]);
  ctx.fillStyle = parseColor(args.color, "#F3E6D0");
  ctx.font = `${args.size}px "${args.family}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(args.label, args.x + args.w / 2, args.y + args.h / 2, args.w - 24);
  ctx.restore();
}

async function loadLocalImage(src: string, baseDir: string, field = "image"): Promise<Image> {
  const path = resolveImagePath(src, baseDir, field);
  try {
    return await loadImage(path);
  } catch {
    throw usage(`${field} could not be read: ${src}`);
  }
}

interface TextRun {
  layer: string;
  role: string;
  box: Box;
  ink: Box;
  font_size: number;
  family: string;
  text: string;
}

function noteText(
  ctx: SKRSContext2D,
  runs: TextRun[],
  args: { layer: string; role: string; text: string; x: number; y: number; maxW: number; size: number; family: string; align: string; originX: number; originY: number },
): number {
  ctx.textBaseline = "top";
  const lines = wrapMarkdown(ctx, args.text, args.maxW, args.size, args.family);
  const leading = leadingOf(args.size);
  let y = args.y;
  let ink: Box | undefined;
  for (const line of lines) {
    const plain = line.map((span) => span.text).join("");
    if (plain !== "") {
      const width = Math.min(args.maxW, measureSpans(ctx, line, args.size, args.family));
      let x = args.x;
      if (args.align === "center") x = args.x + (args.maxW - width) / 2;
      if (args.align === "right") x = args.x + args.maxW - width;
      const box = { x: args.originX + x, y: args.originY + y, width, height: leading };
      ink = ink
        ? {
            x: Math.min(ink.x, box.x),
            y: Math.min(ink.y, box.y),
            width: Math.max(ink.x + ink.width, box.x + box.width) - Math.min(ink.x, box.x),
            height: Math.max(ink.y + ink.height, box.y + box.height) - Math.min(ink.y, box.y),
          }
        : box;
    }
    y += leading;
  }
  if (ink) {
    runs.push({
      layer: args.layer,
      role: args.role,
      box: { x: args.originX + args.x, y: args.originY + args.y, width: args.maxW, height: y - args.y },
      ink,
      font_size: args.size,
      family: args.family,
      text: stripMarkdown(args.text),
    });
  }
  return y;
}

function relativeLuminance(hex: string): number {
  const raw = hex.replace("#", "");
  const h = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw.slice(0, 6);
  const lin = (n: string) => {
    const c = Number.parseInt(n, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(h.slice(0, 2)) + 0.7152 * lin(h.slice(2, 4)) + 0.0722 * lin(h.slice(4, 6));
}

function rgbaOf(value: string): { r: number; g: number; b: number; a: number } {
  const raw = value.replace("#", "");
  const hex6 = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw.slice(0, 6);
  const a = raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1;
  return {
    r: Number.parseInt(hex6.slice(0, 2), 16),
    g: Number.parseInt(hex6.slice(2, 4), 16),
    b: Number.parseInt(hex6.slice(4, 6), 16),
    a: Number.isFinite(a) ? a : 1,
  };
}

function compositeHex(fill: string, surface: string): string {
  const f = rgbaOf(fill);
  const s = rgbaOf(surface);
  const ch = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${ch(f.r * f.a + s.r * (1 - f.a))}${ch(f.g * f.a + s.g * (1 - f.a))}${ch(f.b * f.a + s.b * (1 - f.a))}`;
}

function contrastRatio(a: string, b: string): number {
  const left = relativeLuminance(a);
  const right = relativeLuminance(b);
  const hi = Math.max(left, right);
  const lo = Math.min(left, right);
  return (hi + 0.05) / (lo + 0.05);
}

function warnCardContrast(layer: LayerSpec, warnings: ComposeWarning[]): void {
  if (!layer.cardFit || !layer.fill) return;
  const plate = compositeHex(layer.fill, layer.surface);
  const colors = [roleColor(layer, "eyebrow"), roleColor(layer, "title"), roleColor(layer, "text")];
  for (const color of colors) {
    if (contrastRatio(color, plate) < 4.5) {
      warnings.push({
        code: "card_low_contrast",
        message: `${layer.id}: type on the card plate is below 4.5:1 contrast. Darken or lighten card.fill or the type color.`,
      });
      return;
    }
  }
}

function fillIsBacking(fill: string | null): boolean {
  if (!fill) return false;
  const raw = fill.replace("#", "");
  if (raw.length === 8) return Number.parseInt(raw.slice(6, 8), 16) > 0;
  return true;
}

type PaintShadow = { x: number; y: number; color: string; blur?: number };

function autoShadow(color: string): PaintShadow {
  return relativeLuminance(color) >= 0.5
    ? { x: 1, y: 1, color: "#000000E6" }
    : { x: 1, y: 1, color: "#FFFFFFE6" };
}

function resolveShadow(layer: LayerSpec, color: string): PaintShadow | null {
  if (layer.shadow === "none") return null;
  if (layer.shadow) return layer.shadow;
  if (!fillIsBacking(layer.fill) && layer.overMedia) return autoShadow(color);
  return null;
}

function drawSpans(
  ctx: SKRSContext2D,
  spans: MarkdownSpan[],
  args: {
    x: number;
    y: number;
    size: number;
    family: string;
    color: string;
    shadow?: PaintShadow | null;
    outline?: LayerOutline | null;
  },
): void {
  let x = args.x;
  for (const span of spans) {
    if (!span.text) continue;
    ctx.font = spanFont(span, args.size, args.family);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const width = ctx.measureText(span.text).width;
    const blur = args.shadow?.blur ?? 0;
    if (args.shadow && blur > 0) {
      ctx.save();
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = args.shadow.x;
      ctx.shadowOffsetY = args.shadow.y;
      ctx.shadowColor = parseColor(args.shadow.color, "#000000E6");
      if (args.outline) {
        ctx.strokeStyle = parseColor(args.outline.color, "#000000");
        ctx.lineWidth = args.outline.width;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(span.text, x, args.y);
      }
      ctx.fillStyle = parseColor(args.color, "#F3E6D0");
      ctx.fillText(span.text, x, args.y);
      ctx.restore();
    } else {
      if (args.shadow) {
        ctx.fillStyle = parseColor(args.shadow.color, "#000000E6");
        ctx.fillText(span.text, x + args.shadow.x, args.y + args.shadow.y);
      }
      if (args.outline) {
        ctx.strokeStyle = parseColor(args.outline.color, "#000000");
        ctx.lineWidth = args.outline.width;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(span.text, x, args.y);
      }
      ctx.fillStyle = parseColor(args.color, "#F3E6D0");
      ctx.fillText(span.text, x, args.y);
    }
    if (span.underline) {
      const underlineY = args.y + Math.round(args.size * 0.92);
      ctx.strokeStyle = parseColor(args.color, "#F3E6D0");
      ctx.lineWidth = Math.max(1, Math.round(args.size / 16));
      ctx.beginPath();
      ctx.moveTo(x, underlineY);
      ctx.lineTo(x + width, underlineY);
      ctx.stroke();
    }
    x += width;
  }
}

function drawText(
  ctx: SKRSContext2D,
  args: {
    text: string;
    x: number;
    y: number;
    maxW: number;
    size: number;
    family: string;
    color: string;
    align: Align;
    leading: number;
    shadow?: PaintShadow | null;
    outline?: LayerOutline | null;
  },
): number {
  ctx.textBaseline = "top";
  const lines = wrapMarkdown(ctx, args.text, args.maxW, args.size, args.family);
  let y = args.y;
  for (const line of lines) {
    if (line.length) {
      const width = measureSpans(ctx, line, args.size, args.family);
      let x = args.x;
      if (args.align === "center") x = args.x + (args.maxW - width) / 2;
      if (args.align === "right") x = args.x + args.maxW - width;
      drawSpans(ctx, line, {
        x, y, size: args.size, family: args.family, color: args.color, shadow: args.shadow, outline: args.outline,
      });
    }
    y += args.leading;
  }
  return y;
}

function recordFont(quality: ComposeQuality, warnings: ComposeWarning[], layer: string, text: string, family: string): string {
  const resolved = resolveTextFont(text, family, "400");
  quality.fonts.push({ layer, ...resolved });
  if (resolved.fallback_from) {
    warnings.push({
      code: "font_glyph_fallback",
      message: `${layer}: ${resolved.fallback_from} cannot render ${resolved.missing_codepoints.slice(0, 16).join(", ")} at this weight. Used ${resolved.family} for this text. Choose that font explicitly for consistent typography.`,
    });
  } else if (resolved.missing_codepoints.length) {
    warnings.push({
      code: "font_glyph_missing",
      message: `${layer}: missing glyphs ${resolved.missing_codepoints.slice(0, 16).join(", ")} in ${resolved.family}; no installed fallback covers this text. Install a font with these characters or choose one from compose catalog.`,
    });
  }
  return resolved.family;
}

async function paintLogoLayer(
  layer: LayerSpec,
  baseDir: string,
  quality: ComposeQuality,
  warnings: ComposeWarning[],
): Promise<PaintedLayer> {
  const src = layer.media?.src ?? (layer.blocks[0] && layer.blocks[0].role === "image" ? layer.blocks[0].src : "");
  const img = await loadLocalImage(src, baseDir, "logo");
  const canvas = createCanvas(layer.w, layer.h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, layer.w, layer.h);
  recordImage(quality, warnings, "logo", img, { width: layer.w, height: layer.h }, { scaleX: layer.w / img.width, scaleY: layer.h / img.height });
  return {
    id: layer.id,
    png: Buffer.from(canvas.toBuffer("image/png")),
    family: resolveFontFamily(layer.font ?? undefined),
    overflow: false,
    scale: 1,
    originOffset: 0,
    ink: [],
  };
}

async function paintLayer(
  layer: LayerSpec,
  baseDir: string,
  quality: ComposeQuality,
  warnings: ComposeWarning[],
  logoBox: Box | null = null,
  shared: SharedLayout = {},
): Promise<PaintedLayer> {
  if (layer.region === "logo") return paintLogoLayer(layer, baseDir, quality, warnings);
  const canvas = createCanvas(layer.w, layer.h);
  const ctx = canvas.getContext("2d");
  const extra = extraPadForLogo(layer, logoBox);
  const area = {
    x: extra.left,
    y: extra.top,
    w: Math.max(1, layer.w - extra.left - extra.right),
    h: Math.max(1, layer.h - extra.top - extra.bottom),
  };
  const inkFit = layer.cardFit === "ink";
  const pad = layer.pad;
  if (layer.fill && !inkFit) {
    ctx.fillStyle = parseColor(layer.fill, "#000");
    ctx.fillRect(area.x, area.y, area.w, area.h);
  }
  warnCardContrast(layer, warnings);
  const family = resolveFontFamily(layer.font ?? undefined);
  let inner = {
    x: area.x + pad,
    y: area.y + pad,
    w: Math.max(1, area.w - pad * 2),
    h: Math.max(1, area.h - pad * 2),
  };
  // The box the type has to fit. An ink plate adds its own padding inside the
  // region, so measure against the region less that padding; otherwise copy
  // sized to the region overflows the plate that then hugs it.
  const fitBox = inkFit
    ? { w: Math.max(1, inner.w - CARD_INK_PAD * 2), h: Math.max(1, inner.h - CARD_INK_PAD * 2) }
    : { w: inner.w, h: inner.h };
  const footer = layer.blocks.find((block) => block.role === "footer");
  const flow = layer.blocks.filter((block) => block.role !== "footer");
  const fluid = flow.filter((block) => block.role === "image" || block.role === "placeholder");
  const fixed = flow.filter((block) => block.role !== "image" && block.role !== "placeholder");
  const hasFluid = fluid.length > 0 && layer.region !== "background";
  const footerText = footer && footer.role === "footer" ? footer.text : undefined;
  const eyebrow = layer.blocks.find((block) => block.role === "eyebrow");
  const title = layer.blocks.find((block) => block.role === "title");
  const subtitle = layer.blocks.find((block) => block.role === "subtitle");
  let scale = shared.scale ?? 1;
  let ramp = sizesFor(ctx, {
    root: layer.root,
    family,
    width: fitBox.w,
    viewing: layer.viewing,
    eyebrow: eyebrow && eyebrow.role === "eyebrow" ? eyebrow.text : "",
    title: title && title.role === "title" ? title.text : "",
    subtitle: subtitle && subtitle.role === "subtitle" ? subtitle.text : "",
    scale,
  });
  if (shared.scale === undefined && !hasFluid && fixed.length) {
    const chosen = chooseScale(ctx, layer, fitBox, family, fixed, footerText);
    ramp = chosen.ramp;
    scale = chosen.scale;
  }
  const footerLead = leadingOf(ramp.footer);
  const footerH = footerText ? textHeight(ctx, footerText, fitBox.w, ramp.footer, family, footerLead) : 0;
  const footerGap = footerText ? Math.round(ramp.footer * 0.8) : 0;
  const available = Math.max(1, fitBox.h - footerH - footerGap);
  const gapAfter = gapsFor(ramp);
  let itemGapBoost = 0;
  let fixedH = packFixedHeight(ctx, fixed, fitBox.w, ramp, family, 0);
  if (!hasFluid && fixed.length && !inkFit) {
    const extraGap = Math.max(0, available - fixedH);
    const list = fixed.find((block) => block.role === "cards" || block.role === "table");
    const n = list?.role === "cards" ? list.items.length : list?.role === "table" ? list.rows.length : 0;
    if (extraGap > 0 && n > 1) {
      const cap = Math.round((list!.role === "cards" ? ramp.card : ramp.table) * 0.4);
      itemGapBoost = Math.min(cap, Math.floor(extraGap / (n - 1)));
      fixedH = packFixedHeight(ctx, fixed, fitBox.w, ramp, family, itemGapBoost);
    }
  }
  if (fixed.length && fluid.length) fixedH += gapAfter[fixed[fixed.length - 1]?.role ?? ""] ?? 0;
  const leftover = Math.max(0, available - fixedH);
  let packH = fixedH + (fluid.length ? leftover : 0);
  if (!fluid.length) packH = fixedH;
  if (inkFit) {
    const flowBlocks = footerText ? [...fixed, footer!] : fixed;
    const inkW = packInkWidth(ctx, flowBlocks, fitBox.w, ramp, family);
    const contentH = packH + (footerText ? footerH + footerGap : 0);
    const plateW = Math.min(inner.w, Math.max(1, inkW + CARD_INK_PAD * 2));
    const plateH = Math.min(inner.h, Math.max(1, Math.ceil(contentH) + CARD_INK_PAD * 2));
    let px = inner.x;
    if (layer.align === "center") px = inner.x + Math.round((inner.w - plateW) / 2);
    if (layer.align === "right") px = inner.x + inner.w - plateW;
    let py = inner.y;
    if (layer.valign === "bottom") py = inner.y + inner.h - plateH;
    else if (layer.valign !== "top") py = inner.y + Math.round((inner.h - plateH) / 2);
    if (layer.fill) {
      ctx.fillStyle = parseColor(layer.fill, "#000");
      ctx.fillRect(px, py, plateW, plateH);
    }
    inner = {
      x: px + CARD_INK_PAD,
      y: py + CARD_INK_PAD,
      w: Math.max(1, plateW - CARD_INK_PAD * 2),
      h: Math.max(1, plateH - CARD_INK_PAD * 2),
    };
  }
  const slack = Math.max(0, (inkFit ? inner.h - (footerText ? footerH + footerGap : 0) : available) - packH);
  const originOffset = (() => {
    if (inkFit || layer.valign === "top") return 0;
    if (layer.valign === "bottom") return slack;
    if (shared.originOffset !== undefined) return Math.min(slack, shared.originOffset);
    return Math.round(slack / 2);
  })();
  const originY = inner.y + originOffset;
  let y = originY;
  let overflow = false;
  const limit = inner.y + inner.h - footerH - footerGap;
  const runs: TextRun[] = [];
  const align = layer.align;
  const sh = (color: string) => resolveShadow(layer, color);

  const paintFlow = async (block: LayerBlock, height: number | null) => {
    if (block.role === "eyebrow" || block.role === "title" || block.role === "subtitle" || block.role === "text") {
      const size = ramp[block.role];
      const color = roleColor(layer, block.role);
      const face = recordFont(quality, warnings, `${layer.id}.${block.role}`, stripMarkdown(block.text), family);
      noteText(ctx, runs, {
        layer: layer.id, role: block.role, text: block.text, x: inner.x, y, maxW: inner.w, size, family: face, align, originX: layer.x, originY: layer.y,
      });
      y = drawText(ctx, {
        text: block.text, x: inner.x, y, maxW: inner.w, size, family: face, color, align, leading: leadingOf(size),
        shadow: sh(color), outline: layer.outline,
      });
    } else if (block.role === "cards") {
      for (const [i, item] of block.items.entries()) {
        const startY = y;
        const thumb = item.image ? Math.round(ramp.card * 2.2) : 0;
        const copyX = inner.x + (thumb ? thumb + 16 : 0);
        const copyW = Math.max(1, inner.w - (thumb ? thumb + 16 : 0));
        const priceW = item.price ? Math.ceil(measureMarkdown(ctx, item.price, ramp.card, family)) + 24 : 0;
        const titleW = Math.max(1, copyW - priceW);
        const titleFace = recordFont(quality, warnings, `${layer.id}.cards`, stripMarkdown(item.title), family);
        const titleColor = roleColor(layer, "card");
        noteText(ctx, runs, {
          layer: layer.id, role: "card", text: item.title, x: copyX, y, maxW: titleW, size: ramp.card, family: titleFace, align: "left", originX: layer.x, originY: layer.y,
        });
        y = drawText(ctx, {
          text: item.title, x: copyX, y, maxW: titleW, size: ramp.card, family: titleFace, color: titleColor, align: "left", leading: leadingOf(ramp.card),
          shadow: sh(titleColor), outline: layer.outline,
        });
        if (item.price) {
          const priceY = y - leadingOf(ramp.card);
          const priceColor = roleColor(layer, "price");
          drawText(ctx, {
            text: item.price, x: copyX, y: priceY, maxW: copyW, size: ramp.card, family, color: priceColor, align: "right", leading: leadingOf(ramp.card),
            shadow: sh(priceColor), outline: layer.outline,
          });
        }
        if (item.subtitle) {
          const subColor = roleColor(layer, "subtitle");
          y = drawText(ctx, {
            text: item.subtitle, x: copyX, y, maxW: copyW, size: ramp.small, family, color: subColor, align: "left", leading: leadingOf(ramp.small),
            shadow: sh(subColor), outline: layer.outline,
          });
        }
        if (item.text) {
          const bodyColor = roleColor(layer, "text");
          y = drawText(ctx, {
            text: item.text, x: copyX, y, maxW: copyW, size: ramp.small, family, color: bodyColor, align: "left", leading: leadingOf(ramp.small),
            shadow: sh(bodyColor), outline: layer.outline,
          });
        }
        if (item.image) {
          const img = await loadLocalImage(item.image, baseDir, `${layer.id}.cards.image`);
          const h = Math.max(thumb, y - startY);
          const painted = drawCover(ctx, img, inner.x, startY, thumb, h);
          recordImage(quality, warnings, `${layer.id}.cards`, img, { width: thumb, height: h }, painted);
          y = Math.max(y, startY + h);
        }
        if (i < block.items.length - 1) y += Math.round(ramp.card * 0.55) + itemGapBoost;
      }
    } else if (block.role === "table") {
      const { widths, numeric } = columnWidths(ctx, block, inner.w, ramp.small, ramp.table, family);
      const headerLead = leadingOf(ramp.small);
      const rowLead = leadingOf(ramp.table);
      const paintRow = (cells: string[], size: number, color: string, lead: number, role: string) => {
        let x = inner.x;
        let rowBottom = y;
        for (let c = 0; c < block.columns.length; c++) {
          const cellAlign = numeric[c] ? "right" : "left";
          const padL = numeric[c] ? TABLE_CELL_PAD : 0;
          const padR = TABLE_CELL_PAD;
          const cellX = x + padL;
          const cellW = Math.max(1, (widths[c] ?? 1) - padL - padR);
          const face = recordFont(quality, warnings, `${layer.id}.table`, stripMarkdown(String(cells[c] ?? "")), family);
          noteText(ctx, runs, {
            layer: layer.id, role, text: String(cells[c] ?? ""), x: cellX, y, maxW: cellW, size, family: face, align: cellAlign, originX: layer.x, originY: layer.y,
          });
          const bottom = drawText(ctx, {
            text: String(cells[c] ?? ""), x: cellX, y, maxW: cellW, size, family: face, color, align: cellAlign, leading: lead,
            shadow: sh(color), outline: layer.outline,
          });
          rowBottom = Math.max(rowBottom, bottom);
          x += widths[c] ?? 0;
        }
        y = rowBottom;
      };
      paintRow(block.columns, ramp.small, roleColor(layer, "table-header"), headerLead, "table");
      for (const [i, row] of block.rows.entries()) {
        paintRow(row, ramp.table, roleColor(layer, "table-body"), rowLead, "table");
        if (itemGapBoost && i < block.rows.length - 1) y += itemGapBoost;
      }
    } else if (block.role === "image") {
      const img = await loadLocalImage(block.src, baseDir, `${layer.id}.image`);
      const h = height ?? Math.max(80, limit - y);
      const painted = drawCover(ctx, img, inner.x, y, inner.w, h);
      recordImage(quality, warnings, layer.id, img, { width: inner.w, height: h }, painted);
      y += h;
    } else if (block.role === "placeholder") {
      if (HOLE_KINDS.has(block.kind)) {
        const h = height ?? Math.max(80, limit - y);
        if (layer.media) layer.media.rect = { x: Math.round(layer.x + inner.x), y: Math.round(layer.y + y), width: Math.round(inner.w), height: Math.round(h) };
        y += h;
      } else if (layer.region === "background") {
        y = drawText(ctx, {
          text: block.label,
          x: inner.x,
          y: Math.max(y, inner.y + inner.h - leadingOf(ramp.small) - 8),
          maxW: inner.w,
          size: ramp.small,
          family,
          color: layer.muted,
          align: "left",
          leading: leadingOf(ramp.small),
          shadow: sh(layer.muted),
          outline: layer.outline,
        });
      } else {
        const h = height ?? Math.max(80, limit - y);
        drawPlaceholder(ctx, { x: inner.x, y, w: inner.w, h, label: block.label, color: layer.muted, family, size: ramp.small });
        y += h;
      }
    }
  };

  for (const [i, block] of flow.entries()) {
    const fluidSize = block.role === "image" || block.role === "placeholder"
      ? (fluid.length ? Math.max(80, Math.floor((inner.h - footerH - footerGap - fixedH) / fluid.length)) : 80)
      : null;
    await paintFlow(block, fluidSize);
    if (flow[i + 1]) y += gapAfter[block.role] ?? 0;
    if (y > limit + 1) overflow = true;
  }

  if (footer && footer.role === "footer") {
    const face = recordFont(quality, warnings, `${layer.id}.footer`, stripMarkdown(footer.text), family);
    const fy = inner.y + inner.h - footerH;
    const footerColor = roleColor(layer, "footer");
    noteText(ctx, runs, {
      layer: layer.id, role: "footer", text: footer.text, x: inner.x, y: fy, maxW: inner.w, size: ramp.footer, family: face, align, originX: layer.x, originY: layer.y,
    });
    drawText(ctx, {
      text: footer.text,
      x: inner.x,
      y: fy,
      maxW: inner.w,
      size: ramp.footer,
      family: face,
      color: footerColor,
      align,
      leading: footerLead,
      shadow: sh(footerColor),
      outline: layer.outline,
    });
  }

  for (const run of runs) quality.text.push(run);
  if (overflow) {
    // Copy that does not fit paints past the plate or the region edge. That
    // PNG is wrong to ship, so it is a usage error naming the spec path, not a
    // warning beside a rendered file.
    const where = inkFit ? `${layer.id}.card` : layer.id;
    const floor = scale <= SCALE_MIN + 1e-6 ? " (the minimum)" : "";
    throw usage(
      `${where}: copy does not fit the ${layer.region} region at ${scale.toFixed(2)}× type scale${floor}. ` +
      "Shorten the title or text, drop a block, split the copy across pages, or use a taller region.",
    );
  }
  return {
    id: layer.id,
    png: holeOnly(layer) ? null : Buffer.from(canvas.toBuffer("image/png")),
    family,
    overflow,
    scale,
    originOffset,
    ink: runs.map((run) => run.ink),
  };
}

/**
 * Regions that sit side by side with the same top and height form a row: the
 * thirds of a menu, or left and right. Each would otherwise choose its own
 * type scale and centre its own copy, so titles land at different heights.
 * A row shares the smallest scale and the smallest centring offset so every
 * title starts on one line. Only automatic vertical alignment on a region-fit
 * card takes part; explicit valign, ink plates, and fluid image or hole
 * blocks keep their own layout.
 */
function layoutRows(layers: LayerSpec[]): LayerSpec[][] {
  const groups = new Map<string, LayerSpec[]>();
  for (const layer of layers) {
    if (layer.region === "background" || layer.region === "logo") continue;
    if (layer.cardFit === "ink" || layer.valign !== "auto") continue;
    if (layer.blocks.some((block) => block.role === "image" || block.role === "placeholder")) continue;
    if (!layer.blocks.some((block) => block.role !== "footer")) continue;
    const key = `${layer.y}:${layer.h}`;
    const group = groups.get(key) ?? [];
    group.push(layer);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => {
    if (group.length < 2) return false;
    const sorted = [...group].sort((a, b) => a.x - b.x);
    return sorted.every((layer, i) => i === 0 || layer.x >= sorted[i - 1]!.x + sorted[i - 1]!.w);
  });
}

async function paintPageLayers(
  layers: LayerSpec[],
  baseDir: string,
  quality: ComposeQuality,
  warnings: ComposeWarning[],
  logoBox: Box | null,
): Promise<PaintedLayer[]> {
  const shared = new Map<string, SharedLayout>();
  for (const row of layoutRows(layers)) {
    // Measurement passes record into scratch quality so the real report holds
    // one entry per layer.
    const scratch = () => ({ quality: emptyQuality({ width: 1, height: 1 }), warnings: [] as ComposeWarning[] });
    let first: PaintedLayer[] = [];
    for (const layer of row) {
      const s = scratch();
      first.push(await paintLayer(layer, baseDir, s.quality, s.warnings, logoBox));
    }
    const scale = Math.min(...first.map((item) => item.scale));
    if (first.some((item) => item.scale !== scale)) {
      first = [];
      for (const layer of row) {
        const s = scratch();
        first.push(await paintLayer(layer, baseDir, s.quality, s.warnings, logoBox, { scale }));
      }
    }
    const originOffset = Math.min(...first.map((item) => item.originOffset));
    for (const layer of row) shared.set(layer.id, { scale, originOffset });
  }
  const painted: PaintedLayer[] = [];
  for (const layer of layers) painted.push(await paintLayer(layer, baseDir, quality, warnings, logoBox, shared.get(layer.id) ?? {}));
  return painted;
}

function recordImage(
  quality: ComposeQuality,
  warnings: ComposeWarning[],
  layer: string,
  img: Image,
  box: { width: number; height: number },
  painted: { scaleX: number; scaleY: number },
): void {
  quality.images.push({
    layer,
    source: { width: img.width, height: img.height },
    box,
    painted: { width: img.width * painted.scaleX, height: img.height * painted.scaleY },
    object_fit: "cover",
    scale_x: painted.scaleX,
    scale_y: painted.scaleY,
  });
  if (Math.max(painted.scaleX, painted.scaleY) > 1.25) {
    warnings.push({
      code: "image_upscaled",
      message: `${layer}: ${img.width}×${img.height} source paints at ${Math.round(img.width * painted.scaleX)}×${Math.round(img.height * painted.scaleY)} (${Math.max(painted.scaleX, painted.scaleY).toFixed(2)}×). Use a higher-resolution original or reduce the image size.`,
    });
  }
}

function manifestOf(canvas: { width: number; height: number }, layers: LayerSpec[], painted: PaintedLayer[]): PageManifest {
  const byId = new Map(painted.map((item) => [item.id, item]));
  return {
    version: 1,
    canvas,
    layers: sortLayers(layers).map((layer) => {
      const item = byId.get(layer.id);
      const entry: LayerManifest = {
        id: layer.id,
        z: layer.z,
        rect: { x: layer.x, y: layer.y, width: layer.w, height: layer.h },
      };
      if (item?.png) entry.file = `${layer.id}.png`;
      if (layer.enter) entry.enter = layer.enter;
      if (layer.motion) entry.motion = layer.motion;
      if (layer.media) entry.media = layer.media;
      if (item?.overflow) entry.overflow = true;
      return entry;
    }),
  };
}

function layerOverlaps(layers: LayerSpec[], quality: ComposeQuality): void {
  const visible = layers.filter((layer) => layer.region !== "background" && layer.fill);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i]!;
      const b = visible[j]!;
      const x = Math.max(a.x, b.x);
      const y = Math.max(a.y, b.y);
      const width = Math.min(a.x + a.w, b.x + b.w) - x;
      const height = Math.min(a.y + a.h, b.y + b.h) - y;
      if (width <= 1 || height <= 1) continue;
      quality.overlaps.push({ first: a.id, second: b.id, kind: "layer_layer", area: width * height });
    }
  }
}

function assessSafeArea(page: ComposePageResult, safeArea: boolean, warnings: ComposeWarning[]): void {
  if (!safeArea) return;
  const { width, height } = page.manifest.canvas;
  const inset = { x: width * 0.05, y: height * 0.05, width: width * 0.9, height: height * 0.9 };
  for (const run of page.quality.text) {
    const ink = run.ink;
    const outside = ink.x < inset.x - 1 || ink.y < inset.y - 1
      || ink.x + ink.width > inset.x + inset.width + 1
      || ink.y + ink.height > inset.y + inset.height + 1;
    if (outside) {
      warnings.push({
        code: "text_outside_safe_area",
        message: `${run.layer}: measured text crosses the 5% TV-safe margin. Inset its region if the screen crops its edges.`,
      });
    }
  }
}

async function combinedPng(page: { layers: LayerSpec[]; painted: PaintedLayer[] }, canvasSize: { width: number; height: number }): Promise<Buffer> {
  const canvas = createCanvas(canvasSize.width, canvasSize.height);
  const ctx = canvas.getContext("2d");
  const byId = new Map(page.painted.map((item) => [item.id, item]));
  for (const layer of sortLayers(page.layers)) {
    const item = byId.get(layer.id);
    if (!item?.png) continue;
    if (layer.region === "background" && layer.media?.type === "video") continue;
    const img = await loadImage(item.png);
    ctx.drawImage(img, layer.x, layer.y);
  }
  return Buffer.from(canvas.toBuffer("image/png"));
}

function emptyQuality(canvas: { width: number; height: number }, target?: { width: number; height: number }): ComposeQuality {
  const quality: ComposeQuality = {
    target_status: target ? "known" : "unknown",
    output: { ...canvas },
    images: [],
    text: [],
    overlaps: [],
    fonts: [],
  };
  if (target) {
    quality.target = target;
    quality.output_scale = { x: target.width / canvas.width, y: target.height / canvas.height };
  }
  return quality;
}

export async function composeDocument(
  source: unknown,
  options: {
    baseDir: string;
    target?: { width: number; height: number };
    safeArea?: boolean;
  },
): Promise<ComposeResult> {
  const document = parseComposeSpec(source);
  if (options.target && ![options.target.width, options.target.height].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw usage("physical target width and height must be positive integers");
  }
  const pages: ComposePageResult[] = [];
  for (const page of document.pages) {
    const warnings: ComposeWarning[] = [];
    const quality = emptyQuality(document.canvas, options.target);
    if (quality.output_scale && Math.max(quality.output_scale.x, quality.output_scale.y) > 1.25) {
      warnings.push({
        code: "compose_output_upscaled",
        message: `page: ${document.canvas.width}×${document.canvas.height} output will display at ${options.target!.width}×${options.target!.height}. Re-render from original sources at target resolution; enlarging the finished PNG cannot recover detail.`,
      });
    }
    const painted: PaintedLayer[] = [];
    const logoLayer = page.layers.find((layer) => layer.region === "logo");
    let logoBox: Box | null = null;
    if (logoLayer) {
      const src = logoLayer.media?.src ?? "";
      const img = await loadLocalImage(src, options.baseDir, "logo");
      const painted = placeLogo(img, document.canvas, logoLayer.logoCorner ?? "bottom-right");
      logoLayer.x = painted.x;
      logoLayer.y = painted.y;
      logoLayer.w = painted.width;
      logoLayer.h = painted.height;
      logoBox = reservedLogoBox(painted, document.canvas, logoLayer.logoCorner ?? "bottom-right");
    }
    painted.push(...await paintPageLayers(page.layers, options.baseDir, quality, warnings, logoBox));
    layerOverlaps(page.layers, quality);
    const manifest = manifestOf(document.canvas, page.layers, painted);
    const combined = await combinedPng({ layers: page.layers, painted }, document.canvas);
    const result: ComposePageResult = {
      id: page.id,
      layers: page.layers,
      painted,
      manifest,
      combined,
      quality,
      warnings,
      font_family: painted.find((item) => item.family)?.family ?? resolveFontFamily(undefined),
    };
    assessSafeArea(result, options.safeArea === true, warnings);
    pages.push(result);
  }
  return { document, pages, canvas: document.canvas, name: document.name };
}

export interface WrittenCompose {
  output: string;
  canvas: { width: number; height: number };
  name: string | null;
  files: string[];
  pages: Array<{
    id: string;
    dir: string;
    manifest: PageManifest;
    images: Array<{ id: string; file: string }>;
    combined?: string;
    quality: ComposeQuality;
    warnings: ComposeWarning[];
    font_family: string;
    scale: Record<string, number>;
  }>;
  manifest: PageManifest | null;
  images: Array<{ id: string; file: string }>;
  quality: ComposeQuality;
  warnings: ComposeWarning[];
  font_family: string;
}

export async function composeAndWrite(
  source: unknown,
  options: {
    baseDir: string;
    outDir: string;
    combined?: boolean;
    target?: { width: number; height: number };
    safeArea?: boolean;
    lintOnly?: boolean;
  },
): Promise<WrittenCompose & { result: ComposeResult }> {
  const result = await composeDocument(source, options);
  const files: string[] = [];
  const pages: WrittenCompose["pages"] = [];
  if (!options.lintOnly) await mkdir(options.outDir, { recursive: true });
  const nested = isDeckSource(source);
  for (const page of result.pages) {
    const dir = nested ? join(options.outDir, page.id) : options.outDir;
    const prefix = nested ? `${page.id}/` : "";
    if (!options.lintOnly) await mkdir(dir, { recursive: true });
    const images: Array<{ id: string; file: string }> = [];
    for (const item of page.painted) {
      if (!item.png) continue;
      const file = `${item.id}.png`;
      if (!options.lintOnly) await writeFile(join(dir, file), item.png);
      files.push(`${prefix}${file}`);
      images.push({ id: item.id, file: `${prefix}${file}` });
    }
    const manifest = page.manifest;
    if (!options.lintOnly) await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    files.push(`${prefix}manifest.json`);
    const prefixed = structuredClone(manifest);
    if (prefix) {
      for (const layer of prefixed.layers) {
        if (layer.file) layer.file = `${prefix}${layer.file}`;
      }
    }
    let combinedPath: string | undefined;
    if (options.combined) {
      combinedPath = `${prefix}combined.png`;
      if (!options.lintOnly) await writeFile(join(dir, "combined.png"), page.combined);
      files.push(combinedPath);
    }
    pages.push({
      id: page.id,
      dir,
      manifest: prefixed,
      images,
      combined: combinedPath,
      quality: page.quality,
      warnings: page.warnings,
      font_family: page.font_family,
      scale: Object.fromEntries(page.painted.map((item) => [item.id, item.scale])),
    });
  }
  if (!options.lintOnly && nested) {
    const deck = {
      version: 1,
      name: result.name,
      canvas: result.canvas,
      pages: pages.map((page) => ({ id: page.id, manifest: page.manifest, images: page.images })),
    };
    await writeFile(join(options.outDir, "deck.json"), `${JSON.stringify(deck, null, 2)}\n`);
    files.push("deck.json");
  }
  const first = pages[0];
  return {
    output: options.outDir,
    canvas: result.canvas,
    name: result.name,
    files,
    pages,
    manifest: first?.manifest ?? null,
    images: first?.images ?? [],
    quality: first?.quality ?? emptyQuality(result.canvas, options.target),
    warnings: pages.flatMap((page) => page.warnings.map((warning) => ({
      ...warning,
      message: result.pages.length > 1 ? `${page.id}: ${warning.message}` : warning.message,
    }))),
    font_family: first?.font_family ?? resolveFontFamily(undefined),
    result,
  };
}

export function defaultComposeOutDir(specPath: string): string {
  return specPath.toLowerCase().endsWith(".json") ? specPath.slice(0, -5) : `${specPath}.out`;
}

export type { PlaylistRect, PageSpec };
