import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createCanvas, loadImage, type DOMMatrix, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import Yoga, {
  Align as YogaAlign,
  Direction,
  Edge,
  FlexDirection,
  Gutter,
  Justify as YogaJustify,
  MeasureMode,
  PositionType,
  type Node as YogaNode,
} from "yoga-layout";
import { cssFont, isSyntheticFace, resolveFontFamily, resolveTextFont } from "./fonts.js";
export { resolveFontFamily } from "./fonts.js";
import { resolveIconCodepoint, resolveIconFont } from "./icons.js";
import { arcSagitta, fitType, underlineThickness, type FittedText } from "./fit-text.js";
import { displayXlWish, REFERENCE_CANVAS, rampRoot, relativeLuminance, resolveSpace, spaceScale, themeOf, typeRamp } from "./tokens.js";
import { applyComposeTheme } from "./theme.js";
import type { Align, ComposeFrame, ComposeNode, ImageFocal, ObjectFit, Paint, Pin, Role, SpaceScale, TextEffects, TextPlate, TextShadow, TypeRamp } from "./types.js";
import { validateSpec } from "./validate.js";
import { expandComposeRecipe } from "./recipes.js";
import { parseViewing, VIEWING_XHEIGHT_RATIO, XHEIGHT_FALLBACK } from "./lint.js";

const ALIGN: Record<string, YogaAlign> = {
  start: YogaAlign.FlexStart,
  center: YogaAlign.Center,
  end: YogaAlign.FlexEnd,
  stretch: YogaAlign.Stretch,
};

const JUSTIFY: Record<string, YogaJustify> = {
  start: YogaJustify.FlexStart,
  center: YogaJustify.Center,
  end: YogaJustify.FlexEnd,
  "space-between": YogaJustify.SpaceBetween,
  "space-around": YogaJustify.SpaceAround,
  "space-evenly": YogaJustify.SpaceEvenly,
};

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutNode extends ComposeNode {
  _yoga?: YogaNode;
  _box?: Box;
  _fit?: FittedText;
  _ink?: Box;
  _textFont?: ReturnType<typeof resolveTextFont>;
  _textFace?: { weight: string; italic: boolean; synthetic: boolean };
  _icon?: { family: string; weight: string; glyph: string; size: number };
  _pillPad?: number;
  _plate?: { code: "plate_applied" | "plate_skipped"; contrast_ratio: number };
  _crop?: Box;
  children?: LayoutNode[];
}

function textEffectsOf(node: ComposeNode): TextEffects {
  return node.effects ?? {};
}

function cssWeightOf(node: ComposeNode, rampWeight: string): string {
  const weight = textEffectsOf(node).weight;
  if (weight === "regular") return "400";
  if (weight === "bold") return "700";
  return rampWeight;
}

function resolvedShadow(node: ComposeNode): TextShadow | undefined {
  return textEffectsOf(node).shadow ?? node.textShadow;
}

export interface LayoutDump {
  type: string;
  role?: string;
  pin?: string;
  box?: Box;
  text_bounds?: Box;
  text_font?: ReturnType<typeof resolveTextFont>;
  plate?: { code: "plate_applied" | "plate_skipped"; contrast_ratio: number };
  crop?: Box;
  fit?: {
    fontSize: number;
    lineHeight: number;
    lines: string[];
    truncated: boolean;
  };
  children?: LayoutDump[];
}

export interface ComposeQuality {
  target_status: "known" | "unknown";
  output: { width: number; height: number };
  target?: { width: number; height: number };
  output_scale?: { x: number; y: number };
  text: Array<{
    node: string;
    box: Box;
    ink: Box;
    font_size: number;
    preferred_font_size: number;
    truncated: boolean;
    plate?: { code: "plate_applied" | "plate_skipped"; contrast_ratio: number };
  }>;
  fonts: Array<{ node: string; family: string; fallback_from?: string; missing_codepoints: string[] }>;
  overlaps: Array<{ first: string; second: string; kind: "text_text" | "text_media" | "media_media"; area: number }> ;
  images: Array<{
    node: string;
    source: { width: number; height: number };
    box: { width: number; height: number };
    painted: { width: number; height: number };
    object_fit: string;
    scale_x: number;
    scale_y: number;
    crop?: Box;
  }>;
}

export interface ComposeWarning { code: string; message: string }

export interface InkEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface InkTightReport {
  frame: { width: number; height: number };
  ink: Box;
  output: { width: number; height: number };
  padding: number;
  overhang: InkEdges;
  clipped: InkEdges;
}

export interface ComposeResult {
  quality: ComposeQuality;
  warnings: ComposeWarning[];
  layout: LayoutDump;
  space: SpaceScale;
  ramp: TypeRamp;
  ramp_root: number;
  ramp_at_1080: TypeRamp;
  font_family: string;
  truncated: boolean;
  width: number;
  height: number;
  ink_tight?: InkTightReport;
}

function usage(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "usage_error";
  return err;
}

export function resolveImagePath(src: string, baseDir: string, field = "Image.src"): string {
  if (src.includes("\0")) {
    throw usage(`${field} must not contain a NUL byte`);
  }
  if (src.includes("://") || /^(https?|file|data):/i.test(src)) {
    throw usage(`${field} must be a local filesystem path, not a URL`);
  }
  return isAbsolute(src) ? src : join(baseDir, src);
}

function applyPin(yoga: YogaNode, pin: Pin): void {
  yoga.setPositionType(PositionType.Absolute);
  if (pin === "bottom" || pin === "top") {
    yoga.setPosition(Edge.Left, 0);
    yoga.setPosition(Edge.Right, 0);
    yoga.setPosition(pin === "bottom" ? Edge.Bottom : Edge.Top, 0);
  } else {
    yoga.setPosition(Edge.Top, 0);
    yoga.setPosition(Edge.Bottom, 0);
    yoga.setPosition(pin === "right" ? Edge.Right : Edge.Left, 0);
  }
}

function buildTree(
  node: LayoutNode,
  ctx: SKRSContext2D,
  family: string,
  ramp: TypeRamp,
  space: SpaceScale,
  parentDirection: "row" | "column" = "column",
  minXHeight = 0,
): YogaNode {
  const yoga = Yoga.Node.create();
  node._yoga = yoga;
  const pad = resolveSpace(node.padding, space, "padding");
  if (pad) {
    yoga.setPadding(Edge.All, pad);
  }
  if (node.gap) yoga.setGap(Gutter.All, resolveSpace(node.gap, space, "gap"));
  if (typeof node.flex === "number") {
    yoga.setFlexGrow(node.flex);
    yoga.setFlexShrink(1);
    yoga.setFlexBasis(0);
  }
  if (node.align) yoga.setAlignItems(ALIGN[node.align] ?? YogaAlign.Stretch);
  else if (node.type === "Row" || node.type === "Column" || node.type === "Frame" || node.type === "Box") {
    yoga.setAlignItems(YogaAlign.Stretch);
  }
  if (node.justify) yoga.setJustifyContent(JUSTIFY[node.justify] ?? YogaJustify.FlexStart);
  if (node.pin) applyPin(yoga, node.pin);
  if (node.type !== "Frame") {
    if (typeof node.width === "number") yoga.setWidth(node.width);
    if (typeof node.height === "number") yoga.setHeight(node.height);
  }

  if (node.type === "Frame") {
    yoga.setWidth(node.width ?? 0);
    yoga.setHeight(node.height ?? 0);
    yoga.setFlexDirection(node.direction === "row" ? FlexDirection.Row : FlexDirection.Column);
  } else if (node.type === "Row") {
    yoga.setFlexDirection(FlexDirection.Row);
  } else if (node.type === "Column" || node.type === "Box") {
    yoga.setFlexDirection(FlexDirection.Column);
  } else if (node.type === "Spacer") {
    if (typeof node.flex !== "number" && node.width == null && node.height == null) {
      yoga.setFlexGrow(1);
    }
  } else if (node.type === "Text") {
    const role = node.role ?? "body";
    const effects = textEffectsOf(node);
    const weight = cssWeightOf(node, ramp[role].weight);
    const italic = effects.italic === true;
    const textFamily = typeof node.fontFamily === "string" ? node.fontFamily : family;
    node._textFont = resolveTextFont(String(node.text ?? ""), textFamily, weight);
    node._textFace = {
      weight,
      italic,
      synthetic: isSyntheticFace(node._textFont.family, weight, italic),
    };
    yoga.setMeasureFunc((width, widthMode, height, heightMode) => {
      let maxWidth = width;
      if (widthMode === MeasureMode.Undefined || maxWidth <= 0) maxWidth = 4096;
      let maxHeight: number | null = null;
      if (heightMode === MeasureMode.AtMost || heightMode === MeasureMode.Exactly) maxHeight = height;
      const tracking = typeof node.letterSpacing === "number" ? node.letterSpacing : 0;
      ctx.letterSpacing = `${tracking}px`;
      const fitted = fitType(ctx, {
        text: String(node.text ?? ""),
        family: node._textFont!.family,
        ramp,
        role,
        maxWidth,
        maxHeight,
        minXHeight,
        weight,
        italic,
        outlineWidth: effects.outline?.width ?? 0,
        underline: effects.underline === true,
        arcDegrees: effects.arc?.degrees,
      });
      node._fit = fitted;
      ctx.font = fitted.font;
      const outlineWidth = effects.outline?.width ?? 0;
      const contentWidth = Math.ceil(Math.max(0, ...fitted.lines.map((line) => ctx.measureText(line).width)) + outlineWidth);
      ctx.letterSpacing = "0px";
      return {
        width: widthMode === MeasureMode.Exactly ? width : Math.min(maxWidth, contentWidth),
        height: fitted.height,
      };
    });
  } else if (node.type === "Image") {
    yoga.setFlexGrow(node.flex ?? 0);
    if (node.flex) yoga.setFlexShrink(1);
  } else if (node.type === "Icon") {
    const size = typeof node.size === "number" ? node.size : space.l;
    yoga.setWidth(size);
    yoga.setHeight(size);
    const codepoint = resolveIconCodepoint(String(node.name ?? ""), "Icon");
    const face = resolveIconFont(codepoint);
    node._icon = { ...face, glyph: String.fromCodePoint(codepoint), size };
  } else if (node.type === "Divider") {
    const thickness = typeof node.thickness === "number" ? node.thickness : 2;
    const horizontal = parentDirection !== "row" || node.style === "dotted";
    if (typeof node.length === "number") {
      if (horizontal) {
        yoga.setWidth(node.length);
        yoga.setHeight(thickness);
      } else {
        yoga.setWidth(thickness);
        yoga.setHeight(node.length);
      }
    } else if (horizontal) {
      yoga.setHeight(thickness);
    } else {
      yoga.setWidth(thickness);
    }
  } else if (node.type === "Pill") {
    const role = (node.role ?? "label") as Role;
    const weight = ramp[role].weight;
    const pad = space.s;
    node._pillPad = pad;
    const textFamily = typeof node.fontFamily === "string" ? node.fontFamily : family;
    node._textFont = resolveTextFont(String(node.text ?? ""), textFamily, weight);
    yoga.setMeasureFunc((width, widthMode, height, heightMode) => {
      let maxWidth = width;
      if (widthMode === MeasureMode.Undefined || maxWidth <= 0) maxWidth = 4096;
      let maxHeight: number | null = null;
      if (heightMode === MeasureMode.AtMost || heightMode === MeasureMode.Exactly) maxHeight = height;
      const innerWidth = Math.max(1, maxWidth - 2 * pad);
      const innerHeight = maxHeight == null ? null : Math.max(1, maxHeight - 2 * pad);
      const fitted = fitType(ctx, {
        text: String(node.text ?? ""),
        family: node._textFont!.family,
        ramp,
        role,
        maxWidth: innerWidth,
        maxHeight: innerHeight,
        weight,
        minXHeight,
      });
      node._fit = fitted;
      ctx.font = fitted.font;
      const contentWidth = Math.ceil(Math.max(0, ...fitted.lines.map((line) => ctx.measureText(line).width)) + 2 * pad);
      return {
        width: widthMode === MeasureMode.Exactly ? width : Math.min(maxWidth, contentWidth),
        height: fitted.height + 2 * pad,
      };
    });
  }

  const childDirection: "row" | "column" =
    node.type === "Row" || (node.type === "Frame" && node.direction === "row") ? "row" : "column";
  (node.children ?? []).forEach((child, i) => {
    yoga.insertChild(buildTree(child, ctx, family, ramp, space, childDirection, minXHeight), i);
  });
  return yoga;
}

function collectBoxes(node: LayoutNode, ox: number, oy: number): void {
  const layout = node._yoga?.getComputedLayout();
  if (!layout) return;
  node._box = {
    x: ox + layout.left,
    y: oy + layout.top,
    width: layout.width,
    height: layout.height,
  };
  for (const child of node.children ?? []) collectBoxes(child, node._box.x, node._box.y);
}

function parseColor(value: string | undefined, fallback: string): string {
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

function srgbChannel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminanceRgb(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

function contrastFromLuminance(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function withAlpha(hex: string, alphaByte: number): string {
  const raw = hex.replace("#", "");
  const rgb = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw.slice(0, 6);
  return `#${rgb}${alphaByte.toString(16).padStart(2, "0")}`;
}

function plateOf(node: ComposeNode): TextPlate {
  return node.plate ?? "none";
}

function focalOf(node: ComposeNode): ImageFocal {
  const focal = node.focal;
  return {
    x: typeof focal?.x === "number" ? focal.x : 0.5,
    y: typeof focal?.y === "number" ? focal.y : 0.5,
  };
}

function autoPlateColor(textHex: string, themeSurface: string | undefined): string {
  if (themeSurface) return withAlpha(themeSurface, 0xd9);
  return relativeLuminance(textHex) >= 0.5 ? "#000000B3" : "#FFFFFFB3";
}

function clampBox(box: Box, width: number, height: number): Box | undefined {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const right = Math.min(width, Math.ceil(box.x + box.width));
  const bottom = Math.min(height, Math.ceil(box.y + box.height));
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

function canvasBox(ctx: SKRSContext2D, box: Box): Box | undefined {
  return clampBox(transformBox(ctx.getTransform(), box), ctx.canvas.width, ctx.canvas.height);
}

function sampleContrast(ctx: SKRSContext2D, rect: Box, textLuminance: number): number {
  const data = ctx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
  const lumas: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! === 0) continue;
    lumas.push(luminanceRgb(data[i]!, data[i + 1]!, data[i + 2]!));
  }
  if (!lumas.length) lumas.push(0);
  const mean = lumas.reduce((sum, value) => sum + value, 0) / lumas.length;
  lumas.sort((a, b) => a - b);
  const p90 = lumas[Math.floor((lumas.length - 1) * 0.9)]!;
  return Math.min(contrastFromLuminance(textLuminance, mean), contrastFromLuminance(textLuminance, p90));
}

function coverSourceRect(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
  focalX: number,
  focalY: number,
): { sx: number; sy: number; sw: number; sh: number; scale: number } {
  const scale = Math.max(boxWidth / imageWidth, boxHeight / imageHeight);
  const sw = boxWidth / scale;
  const sh = boxHeight / scale;
  const sx = Math.min(Math.max(0, focalX * imageWidth - sw / 2), Math.max(0, imageWidth - sw));
  const sy = Math.min(Math.max(0, focalY * imageHeight - sh / 2), Math.max(0, imageHeight - sh));
  return { sx, sy, sw, sh, scale };
}

function fillPaint(
  ctx: SKRSContext2D,
  box: Box,
  paint: Paint | undefined,
  fallback: string,
  radius: number,
): void {
  if (!paint) return;
  if (typeof paint === "string") {
    ctx.fillStyle = parseColor(paint, fallback);
  } else {
    const angle = (paint.angle * Math.PI) / 180;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const len = Math.abs(box.width * Math.sin(angle)) + Math.abs(box.height * Math.cos(angle));
    const dx = Math.sin(angle) * (len / 2);
    const dy = -Math.cos(angle) * (len / 2);
    const gradient = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    for (const stop of paint.stops) {
      gradient.addColorStop(stop.at, parseColor(stop.color, fallback));
    }
    ctx.fillStyle = gradient;
  }
  if (radius) {
    roundRect(ctx, box.x, box.y, box.width, box.height, radius);
    ctx.fill();
  } else {
    ctx.fillRect(box.x, box.y, box.width, box.height);
  }
}

function paintDottedDivider(ctx: SKRSContext2D, box: Box, color: string, thickness: number): void {
  ctx.save();
  ctx.fillStyle = parseColor(color, "#8A8A8A");
  const horizontal = box.width >= box.height;
  const radius = Math.max(1, thickness) / 2;
  const period = Math.max(thickness * 3, 6);
  if (horizontal) {
    const cy = box.y + box.height / 2;
    const end = box.x + box.width - radius;
    for (let x = box.x + radius; x <= end + 0.01; x += period) {
      ctx.beginPath();
      ctx.arc(x, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const cx = box.x + box.width / 2;
    const end = box.y + box.height - radius;
    for (let y = box.y + radius; y <= end + 0.01; y += period) {
      ctx.beginPath();
      ctx.arc(cx, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

async function imageFor(src: string, baseDir: string, cache: Map<string, Promise<Image>>, field = "Image.src"): Promise<Image> {
  const path = resolveImagePath(src, baseDir, field);
  let pending = cache.get(path);
  if (!pending) {
    pending = loadImage(path).catch(() => {
      throw usage(`${field} could not be read as a local file`);
    });
    cache.set(path, pending);
  }
  return pending;
}

function unionBox(a: Box | undefined, b: Box): Box {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function metricsInk(metrics: ReturnType<SKRSContext2D["measureText"]>, x: number, y: number): Box {
  return {
    x: x - metrics.actualBoundingBoxLeft,
    y: y - metrics.actualBoundingBoxAscent,
    width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
    height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
  };
}

function expandInk(ink: Box, outlineWidth: number, underline: number): Box {
  const pad = outlineWidth / 2;
  return {
    x: ink.x - pad,
    y: ink.y - pad,
    width: ink.width + outlineWidth,
    height: ink.height + outlineWidth + underline,
  };
}

function transformBox(matrix: DOMMatrix, box: Box): Box {
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x, y: box.y + box.height },
    { x: box.x + box.width, y: box.y + box.height },
  ].map((point) => ({
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function fittedTexturePattern(
  ctx: SKRSContext2D,
  img: Image,
  box: Box,
  fit: ObjectFit,
): NonNullable<ReturnType<SKRSContext2D["createPattern"]>> {
  const width = Math.max(1, Math.ceil(box.width));
  const height = Math.max(1, Math.ceil(box.height));
  const tile = createCanvas(width, height);
  const tileCtx = tile.getContext("2d");
  const scaleCover = Math.max(width / img.width, height / img.height);
  const scaleContain = Math.min(width / img.width, height / img.height);
  const scale = fit === "contain" ? scaleContain : fit === "fill" ? null : scaleCover;
  const scaleX = scale ?? width / img.width;
  const scaleY = scale ?? height / img.height;
  if (scale == null) {
    tileCtx.drawImage(img, 0, 0, width, height);
  } else {
    const dw = img.width * scaleX;
    const dh = img.height * scaleY;
    tileCtx.drawImage(img, (width - dw) / 2, (height - dh) / 2, dw, dh);
  }
  const pattern = ctx.createPattern(tile, "no-repeat");
  if (!pattern) throw usage("effects.texture.src could not be used as a fill");
  pattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: box.x, f: box.y });
  return pattern;
}

function paintUnderline(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  fontSize: number,
  color: string,
  outline?: { width: number; color: string },
): void {
  const thickness = underlineThickness(fontSize);
  const underlineY = y + Math.max(2, Math.round(fontSize * 0.08));
  ctx.beginPath();
  ctx.moveTo(x, underlineY);
  ctx.lineTo(x + width, underlineY);
  ctx.lineCap = "round";
  if (outline) {
    ctx.strokeStyle = parseColor(outline.color, "#000");
    ctx.lineWidth = thickness + outline.width;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, underlineY);
    ctx.lineTo(x + width, underlineY);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = thickness;
  ctx.stroke();
}

function paintGlyphRun(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  fill: string | NonNullable<ReturnType<SKRSContext2D["createPattern"]>>,
  outline: { width: number; color: string } | undefined,
): void {
  if (outline) {
    ctx.strokeStyle = parseColor(outline.color, "#000");
    ctx.lineWidth = outline.width;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function eachArcGlyph(
  ctx: SKRSContext2D,
  text: string,
  originX: number,
  originY: number,
  degrees: number,
  visit: (glyph: string, localX: number, localY: number) => void,
): void {
  const theta = (degrees * Math.PI) / 180;
  if (Math.abs(theta) < 1e-6) {
    visit(text, originX, originY);
    return;
  }
  const total = ctx.measureText(text).width;
  if (total <= 0) return;
  const radius = total / Math.abs(theta);
  const smile = theta > 0;
  let consumed = 0;
  const glyphs = [...text];
  let prefix = "";
  for (const glyph of glyphs) {
    prefix += glyph;
    const next = ctx.measureText(prefix).width;
    const width = next - consumed;
    const mid = -theta / 2 + ((consumed + width / 2) / total) * theta;
    ctx.save();
    if (smile) {
      ctx.translate(originX, originY + radius);
      ctx.rotate(mid);
      ctx.translate(0, -radius);
    } else {
      ctx.translate(originX, originY - radius);
      ctx.rotate(mid);
      ctx.translate(0, radius);
    }
    ctx.textAlign = "center";
    visit(glyph, 0, 0);
    ctx.restore();
    consumed = next;
  }
}

async function paint(
  ctx: SKRSContext2D,
  node: LayoutNode,
  baseDir: string,
  space: SpaceScale,
  cache: Map<string, Promise<Image>>,
  quality: ComposeQuality,
  warnings: ComposeWarning[],
  nodePath = "Frame",
  themeSurface?: string,
): Promise<void> {
  const box = node._box;
  if (!box) return;
  const radius = node.radius ? resolveSpace(node.radius, space, "radius") : 0;
  const clipBox = Boolean(radius) && node.type !== "Text";
  if (clipBox) {
    ctx.save();
    roundRect(ctx, box.x, box.y, box.width, box.height, radius);
    ctx.clip();
  }
  if (node.background && node.type !== "Image" && node.type !== "Pill") {
    fillPaint(ctx, box, node.background as Paint, "#000", radius);
  }
  if (node.type === "Image") {
    const img = await imageFor(String(node.src ?? ""), baseDir, cache);
    const fit = node.objectFit ?? "cover";
    ctx.save();
    if (radius) {
      roundRect(ctx, box.x, box.y, box.width, box.height, radius);
      ctx.clip();
    } else {
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.width, box.height);
      ctx.clip();
    }
    const scaleCover = Math.max(box.width / img.width, box.height / img.height);
    const scaleContain = Math.min(box.width / img.width, box.height / img.height);
    const scale = fit === "contain" ? scaleContain : fit === "fill" ? null : scaleCover;
    const scaleX = scale ?? box.width / img.width;
    const scaleY = scale ?? box.height / img.height;
    const focal = focalOf(node);
    const cover = fit === "cover" ? coverSourceRect(img.width, img.height, box.width, box.height, focal.x, focal.y) : undefined;
    const crop = cover ? { x: cover.sx, y: cover.sy, width: cover.sw, height: cover.sh } : undefined;
    if (crop) node._crop = crop;
    quality.images.push({ node: nodePath, source: { width: img.width, height: img.height },
      box: { width: box.width, height: box.height },
      painted: { width: img.width * scaleX, height: img.height * scaleY },
      object_fit: fit, scale_x: scaleX, scale_y: scaleY, ...(crop ? { crop } : {}) });
    if (Math.max(scaleX, scaleY) > 1.25) warnings.push({ code: "image_upscaled",
      message: `${nodePath}: ${img.width}×${img.height} source paints at ${Math.round(img.width * scaleX)}×${Math.round(img.height * scaleY)} (${Math.max(scaleX, scaleY).toFixed(2)}×). Use a higher-resolution original or reduce the image size.` });
    if (fit === "fill" && scaleX > 0 && scaleY > 0 && Math.max(scaleX / scaleY, scaleY / scaleX) > 1.01) warnings.push({ code: "image_aspect_stretched",
      message: `${nodePath}: fill stretches the image unevenly (${scaleX.toFixed(2)}× horizontally, ${scaleY.toFixed(2)}× vertically). Use contain to preserve the whole image or cover to crop without distortion.` });
    if (scale == null) {
      ctx.drawImage(img, box.x, box.y, box.width, box.height);
    } else if (cover) {
      ctx.drawImage(img, cover.sx, cover.sy, cover.sw, cover.sh, box.x, box.y, box.width, box.height);
    } else {
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, box.x + (box.width - dw) / 2, box.y + (box.height - dh) / 2, dw, dh);
    }
    ctx.restore();
  }
  if (node.type === "Text" && node._fit) {
    const fit = node._fit;
    const effects = textEffectsOf(node);
    if (effects.arc && fit.lines.length > 1) {
      throw usage(`${nodePath} arc_single_line: arc text must be a single line`);
    }
    if (node._textFace?.synthetic) {
      const wanted = [node._textFace.weight === "700" ? "bold" : null, node._textFace.italic ? "italic" : null].filter(Boolean).join(" ");
      warnings.push({
        code: "synthetic_face",
        message: `${nodePath}: ${node._textFont?.family ?? "font"} has no installed ${wanted} face; used a synthetic face. Install a real ${wanted} face or omit effects.weight/italic.`,
      });
    }
    ctx.save();
    const fillColor = parseColor(node.color, "#EEE9DF");
    ctx.fillStyle = fillColor;
    ctx.font = fit.font;
    ctx.letterSpacing = typeof node.letterSpacing === "number" ? `${node.letterSpacing}px` : "0px";
    ctx.textBaseline = "alphabetic";
    const arcing = effects.arc != null;
    const align = arcing ? "center" : (node.align as Align | "left" | "center" | "right" | undefined) ?? "left";
    ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
    let x = box.x;
    if (align === "center") x = box.x + box.width / 2;
    if (align === "right") x = box.x + box.width;
    const longest = Math.max(0, ...fit.lines.map((line) => ctx.measureText(line).width));
    const sagitta = effects.arc ? arcSagitta(longest, effects.arc.degrees) : 0;
    const blockHeight = fit.lines.length * fit.lineHeight;
    let y = box.y + Math.round((box.height - blockHeight - sagitta) / 2) + Math.round(fit.fontSize * 0.8);
    if (effects.arc && effects.arc.degrees < 0) y += sagitta;
    if (box.height <= blockHeight + sagitta + 2) y = box.y + Math.round(fit.fontSize * 0.8) + (effects.arc && effects.arc.degrees < 0 ? sagitta : 0);
    const outlineWidth = effects.outline?.width ?? 0;
    const underlineExtra = effects.underline ? underlineThickness(fit.fontSize) + 2 : 0;
    const recordInk = (glyph: string, gx: number, gy: number): Box | undefined => {
      const raw = metricsInk(ctx.measureText(glyph), gx, gy);
      const boxInk = arcing && Math.abs(effects.arc!.degrees) >= 1e-6 ? transformBox(ctx.getTransform(), raw) : raw;
      if (boxInk.width <= 0 || boxInk.height <= 0) return undefined;
      return expandInk(boxInk, outlineWidth, underlineExtra);
    };
    let measured: Box | undefined;
    let lineY = y;
    for (const line of fit.lines) {
      if (arcing) {
        eachArcGlyph(ctx, line, x, lineY, effects.arc!.degrees, (glyph, gx, gy) => {
          const ink = recordInk(glyph, gx, gy);
          if (ink) measured = unionBox(measured, ink);
        });
      } else {
        const ink = recordInk(line, x, lineY);
        if (ink) measured = unionBox(measured, ink);
      }
      lineY += fit.lineHeight;
    }
    const plateSpec = plateOf(node);
    if (plateSpec !== "none" && measured) {
      const pad = plateSpec === "auto" ? space.s : resolveSpace(plateSpec.padding, space, "plate.padding");
      const plateRadius = plateSpec === "auto" ? space.s : resolveSpace(plateSpec.radius, space, "plate.radius");
      const plateBox = {
        x: measured.x - pad,
        y: measured.y - pad,
        width: measured.width + 2 * pad,
        height: measured.height + 2 * pad,
      };
      const textHex = typeof node.color === "string" ? node.color : "#EEE9DF";
      const textLum = relativeLuminance(textHex);
      const sampleRect = canvasBox(ctx, measured);
      const measuredRatio = sampleRect ? sampleContrast(ctx, sampleRect, textLum) : 21;
      const apply = plateSpec !== "auto" || measuredRatio < 4.5;
      let afterRatio = measuredRatio;
      if (apply) {
        const plateColor = plateSpec === "auto" ? autoPlateColor(textHex, themeSurface) : plateSpec.color;
        fillPaint(ctx, plateBox, plateColor, "#000000B3", plateRadius);
        const afterRect = canvasBox(ctx, measured);
        afterRatio = afterRect ? sampleContrast(ctx, afterRect, textLum) : measuredRatio;
      }
      node._plate = { code: apply ? "plate_applied" : "plate_skipped", contrast_ratio: measuredRatio };
      if (afterRatio < 3) {
        warnings.push({
          code: "low_contrast",
          message: `${nodePath}: contrast ratio ${afterRatio.toFixed(2)} is below 3.0 after plating.`,
        });
      }
    }
    let fill: string | NonNullable<ReturnType<SKRSContext2D["createPattern"]>> = fillColor;
    if (effects.texture && measured) {
      const img = await imageFor(effects.texture.src, baseDir, cache, "effects.texture.src");
      fill = fittedTexturePattern(ctx, img, measured, effects.texture.objectFit ?? "cover");
    }
    const shadow = resolvedShadow(node);
    if (shadow) {
      ctx.shadowOffsetX = shadow.x;
      ctx.shadowOffsetY = shadow.y;
      ctx.shadowBlur = shadow.blur ?? 0;
      ctx.shadowColor = parseColor(shadow.color, "#000000");
    }
    lineY = y;
    for (const line of fit.lines) {
      const paintLine = (glyph: string, gx: number, gy: number): void => {
        paintGlyphRun(ctx, glyph, gx, gy, fill, effects.outline);
        if (effects.underline) {
          const width = ctx.measureText(glyph).width;
          const left = ctx.textAlign === "center" ? gx - width / 2 : ctx.textAlign === "right" ? gx - width : gx;
          paintUnderline(ctx, left, gy, width, fit.fontSize, fillColor, effects.outline);
        }
        const ink = recordInk(glyph, gx, gy);
        if (ink) node._ink = unionBox(node._ink, ink);
      };
      if (arcing) eachArcGlyph(ctx, line, x, lineY, effects.arc!.degrees, paintLine);
      else paintLine(line, x, lineY);
      lineY += fit.lineHeight;
    }
    ctx.restore();
  }
  if (node.type === "Icon" && node._icon) {
    ctx.save();
    ctx.fillStyle = parseColor(node.color, "#EEE9DF");
    ctx.font = cssFont(node._icon.weight, node._icon.size, node._icon.family);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node._icon.glyph, box.x + box.width / 2, box.y + box.height / 2);
    ctx.restore();
  }
  if (node.type === "Divider") {
    if (node.style === "dotted") {
      paintDottedDivider(ctx, box, node.color ?? "#8A8A8A", typeof node.thickness === "number" ? node.thickness : 2);
    }
    else fillPaint(ctx, box, node.color ?? "#8A8A8A", "#8A8A8A", 0);
  }
  if (node.type === "Pill" && node._fit) {
    const pad = node._pillPad ?? 0;
    const pillRadius = node.radius ? resolveSpace(node.radius, space, "radius") : Math.min(box.width, box.height) / 2;
    fillPaint(ctx, box, (node.background as Paint | undefined) ?? "#FFC857", "#FFC857", pillRadius);
    const fit = node._fit;
    ctx.save();
    const fillColor = parseColor(node.color, "#1B2632");
    ctx.fillStyle = fillColor;
    ctx.font = fit.font;
    ctx.textBaseline = "alphabetic";
    const align = (node.align as Align | "left" | "center" | "right" | undefined) ?? "center";
    ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
    const inner = { x: box.x + pad, y: box.y + pad, width: Math.max(0, box.width - 2 * pad), height: Math.max(0, box.height - 2 * pad) };
    let x = inner.x;
    if (align === "center") x = inner.x + inner.width / 2;
    if (align === "right") x = inner.x + inner.width;
    const blockHeight = fit.lines.length * fit.lineHeight;
    let y = inner.y + Math.round((inner.height - blockHeight) / 2) + Math.round(fit.fontSize * 0.8);
    if (inner.height <= blockHeight + 2) y = inner.y + Math.round(fit.fontSize * 0.8);
    for (const line of fit.lines) {
      ctx.fillText(line, x, y);
      y += fit.lineHeight;
    }
    ctx.restore();
  }
  for (const [index, child] of (node.children ?? []).entries()) await paint(ctx, child, baseDir, space, cache, quality, warnings, `${nodePath}.children[${index}]`, themeSurface);
  if (clipBox) ctx.restore();
}

function layoutDump(node: LayoutNode): LayoutDump {
  const dump: LayoutDump = { type: node.type, role: node.role, pin: node.pin, box: node._box, text_bounds: node._ink, text_font: node._textFont };
  if (node._plate) dump.plate = node._plate;
  if (node._crop) dump.crop = node._crop;
  if (node._fit) {
    dump.fit = {
      fontSize: node._fit.fontSize,
      lineHeight: node._fit.lineHeight,
      lines: node._fit.lines,
      truncated: node._fit.truncated,
    };
  }
  if (node.children) dump.children = node.children.map(layoutDump);
  return dump;
}

function anyTruncated(dump: LayoutDump): boolean {
  if (dump.fit?.truncated) return true;
  return (dump.children ?? []).some(anyTruncated);
}

function assessComposition(layout: LayoutDump, quality: ComposeQuality, warnings: ComposeWarning[], ramp: TypeRamp, safeArea: boolean): void {
  const output = { x: 0, y: 0, ...quality.output };
  const inset = { x: output.width * 0.05, y: output.height * 0.05, width: output.width * 0.9, height: output.height * 0.9 };
  const outside = (ink: Box, box: Box): boolean => ink.x < box.x - 1 || ink.y < box.y - 1 || ink.x + ink.width > box.x + box.width + 1 || ink.y + ink.height > box.y + box.height + 1;
  const visible: Array<{ node: string; type: string; bounds: Box }> = [];
  const visit = (node: LayoutDump, nodePath: string): void => {
    if (node.type === "Text" && node.text_bounds && node.box && node.fit) {
      const ink = node.text_bounds;
      const preferred = ramp[(node.role ?? "body") as keyof TypeRamp].wish;
      if (node.text_font) {
        quality.fonts.push({ node: nodePath, ...node.text_font });
        if (node.text_font.fallback_from) warnings.push({ code: "font_glyph_fallback", message: `${nodePath}: ${node.text_font.fallback_from} cannot render ${node.text_font.missing_codepoints.slice(0, 16).join(", ")} at this weight. Used ${node.text_font.family} for this text, then remeasured it. Choose that font explicitly for consistent typography.` });
        else if (node.text_font.missing_codepoints.length) warnings.push({ code: "font_glyph_missing", message: `${nodePath}: missing glyphs ${node.text_font.missing_codepoints.slice(0, 16).join(", ")} in ${node.text_font.family}; no installed fallback covers this text. Install a font with these characters or choose one from compose catalog.` });
      }
      quality.text.push({
        node: nodePath,
        box: node.box,
        ink,
        font_size: node.fit.fontSize,
        preferred_font_size: preferred,
        truncated: node.fit.truncated,
        ...(node.plate ? { plate: node.plate } : {}),
      });
      visible.push({ node: nodePath, type: "Text", bounds: ink });
      if (outside(ink, node.box) || outside(ink, output)) warnings.push({ code: "text_overflow", message: `${nodePath}: measured text extends beyond its layout box or canvas. Shorten the copy, widen its container, or split it across pages.` });
      if (node.fit.truncated) warnings.push({ code: "text_truncated", message: `${nodePath}: some copy was replaced by an ellipsis. Shorten it or give this text more space.` });
      if (node.fit.fontSize < preferred * 0.8) warnings.push({ code: "text_dense", message: `${nodePath}: text shrank to ${node.fit.fontSize}px from its preferred ${preferred}px. Reduce copy or split this section; do not lower the readable type floor.` });
      if (safeArea && outside(ink, inset)) warnings.push({ code: "text_outside_safe_area", message: `${nodePath}: measured text crosses the 5% TV-safe margin. Inset its container if the screen crops its edges.` });
    } else if (node.type === "Image" && node.box) visible.push({ node: nodePath, type: "Image", bounds: node.box });
    node.children?.forEach((child, index) => visit(child, `${nodePath}.children[${index}]`));
  };
  visit(layout, "Frame");
  for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
    const first = visible[i]!, second = visible[j]!;
    const width = Math.min(first.bounds.x + first.bounds.width, second.bounds.x + second.bounds.width) - Math.max(first.bounds.x, second.bounds.x);
    const height = Math.min(first.bounds.y + first.bounds.height, second.bounds.y + second.bounds.height) - Math.max(first.bounds.y, second.bounds.y);
    if (width <= 1 || height <= 1) continue;
    const kind = first.type === "Text" && second.type === "Text" ? "text_text" : first.type === "Image" && second.type === "Image" ? "media_media" : "text_media";
    quality.overlaps.push({ first: first.node, second: second.node, kind, area: width * height });
    if (kind === "text_text") warnings.push({ code: "text_overlap", message: `${first.node} overlaps ${second.node}. Separate the text containers or shorten their copy. Background plates and intentional text-over-media are not treated as text collisions.` });
  }
}

const INK_PADDING_MAX = 8192;

function isFullyTransparent(color: Paint | undefined): boolean {
  if (!color) return true;
  if (typeof color !== "string") return false;
  const raw = color.replace("#", "");
  if (raw.length === 8) return Number.parseInt(raw.slice(6, 8), 16) === 0;
  return false;
}

function inkWithShadow(ink: Box, shadow: TextShadow | undefined): Box {
  if (!shadow) return ink;
  const blur = shadow.blur ?? 0;
  return unionBox(ink, {
    x: ink.x + Math.min(0, shadow.x) - blur,
    y: ink.y + Math.min(0, shadow.y) - blur,
    width: ink.width + Math.abs(shadow.x) + 2 * blur,
    height: ink.height + Math.abs(shadow.y) + 2 * blur,
  });
}

function collectLayerInk(node: LayoutNode): Box | undefined {
  let ink: Box | undefined;
  if (node.type === "Text" && node._ink) {
    ink = unionBox(ink, inkWithShadow(node._ink, resolvedShadow(node)));
  } else if ((node.type === "Image" || node.type === "Icon" || node.type === "Divider" || node.type === "Pill") && node._box) {
    ink = unionBox(ink, node._box);
  }
  if (node.type !== "Image" && node.background && node._box && !isFullyTransparent(node.background as Paint | undefined)) {
    ink = unionBox(ink, node._box);
  }
  for (const child of node.children ?? []) {
    const childInk = collectLayerInk(child);
    if (childInk) ink = unionBox(ink, childInk);
  }
  return ink;
}

function integerBox(box: Box): Box {
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function overflowPast(content: Box, bounds: Box): InkEdges {
  return {
    left: Math.max(0, Math.round(bounds.x - content.x)),
    top: Math.max(0, Math.round(bounds.y - content.y)),
    right: Math.max(0, Math.round(content.x + content.width - (bounds.x + bounds.width))),
    bottom: Math.max(0, Math.round(content.y + content.height - (bounds.y + bounds.height))),
  };
}

function alphaBounds(ctx: SKRSContext2D, width: number, height: number): Box | undefined {
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function emptyQuality(): ComposeQuality {
  return { target_status: "unknown", output: { width: 0, height: 0 }, images: [], text: [], overlaps: [], fonts: [] };
}

function singleTextDisplayXl(tree: LayoutNode): boolean {
  return tree.children?.length === 1 && tree.children[0]?.type === "Text" && tree.children[0]?.scale === "display-xl";
}

async function applyInkTight(
  tree: LayoutNode,
  frameWidth: number,
  frameHeight: number,
  padding: number,
  paintArgs: { baseDir: string; space: SpaceScale; cache: Map<string, Promise<Image>>; themeSurface?: string },
): Promise<{ png: Uint8Array; output: { width: number; height: number }; report: InkTightReport }> {
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > INK_PADDING_MAX) {
    throw usage(`--ink-padding must be an integer from 0 to ${INK_PADDING_MAX}`);
  }
  const measured = collectLayerInk(tree);
  const ink = measured ? integerBox(measured) : { x: 0, y: 0, width: 0, height: 0 };
  const frame = { x: 0, y: 0, width: frameWidth, height: frameHeight };
  const overhang = overflowPast(ink, frame);
  const crop = {
    x: ink.x - padding,
    y: ink.y - padding,
    width: Math.max(1, ink.width + 2 * padding),
    height: Math.max(1, ink.height + 2 * padding),
  };
  const out = createCanvas(crop.width, crop.height);
  const ctx = out.getContext("2d");
  ctx.translate(-crop.x, -crop.y);
  await paint(ctx, tree, paintArgs.baseDir, paintArgs.space, paintArgs.cache, emptyQuality(), [], "Frame", paintArgs.themeSurface);
  const alpha = alphaBounds(ctx, crop.width, crop.height);
  const painted = alpha
    ? { x: crop.x + alpha.x, y: crop.y + alpha.y, width: alpha.width, height: alpha.height }
    : undefined;
  const clipped = painted ? overflowPast(ink, painted) : overflowPast(ink, { x: crop.x, y: crop.y, width: 0, height: 0 });
  return {
    png: Buffer.from(out.toBuffer("image/png")),
    output: { width: crop.width, height: crop.height },
    report: {
      frame: { width: frameWidth, height: frameHeight },
      ink,
      output: { width: crop.width, height: crop.height },
      padding,
      overhang,
      clipped,
    },
  };
}

export async function composeSpec(
  spec: unknown,
  options: {
    baseDir: string;
    outPath?: string;
    layoutOutPath?: string;
    safeArea?: boolean;
    target?: { width: number; height: number };
    inkTight?: boolean;
    inkPadding?: number;
  },
): Promise<ComposeResult & { png: Buffer }> {
  const warnings: ComposeWarning[] = [];
  const validated = validateSpec(expandComposeRecipe(spec, warnings));
  const tree = structuredClone(validated) as LayoutNode;
  applyComposeTheme(tree as ComposeFrame, warnings);
  const family = resolveFontFamily(typeof tree.fontFamily === "string" ? tree.fontFamily : undefined);
  const width = tree.width ?? 0;
  const height = tree.height ?? 0;
  if (options.target && (![options.target.width, options.target.height].every((n) => Number.isSafeInteger(n) && n > 0))) {
    throw usage("physical target width and height must be positive integers");
  }
  const quality: ComposeQuality = { target_status: options.target ? "known" : "unknown", output: { width, height }, images: [], text: [], overlaps: [], fonts: [] };
  if (options.target) {
    quality.target = options.target;
    quality.output_scale = { x: options.target.width / width, y: options.target.height / height };
    if (Math.max(quality.output_scale.x, quality.output_scale.y) > 1.25) warnings.push({ code: "compose_output_upscaled",
      message: `Frame: ${width}×${height} output will display at ${options.target.width}×${options.target.height}. Re-render from original sources at target resolution; enlarging the finished PNG cannot recover detail.` });
  }
  const themeSurface = typeof tree.theme === "string" ? themeOf(tree.theme).surface : undefined;
  const space = spaceScale(width, height);
  const viewing = parseViewing(tree.viewing);
  const minXHeight = Math.min(width, height) * VIEWING_XHEIGHT_RATIO[viewing];
  const viewingFloor = Math.ceil(minXHeight / XHEIGHT_FALLBACK);
  let ramp = typeRamp(width, height);
  ramp = Object.fromEntries(
    Object.entries(ramp).map(([role, scale]) => [role, { ...scale, min: Math.max(scale.min, viewingFloor) }]),
  ) as TypeRamp;
  if (singleTextDisplayXl(tree)) {
    const role = (tree.children![0]!.role ?? "body") as Role;
    ramp = { ...ramp, [role]: { ...ramp[role], wish: displayXlWish(width, height) } };
  }
  const ramp_root = rampRoot(width, height);
  const ramp_at_1080 = typeRamp(REFERENCE_CANVAS.width, REFERENCE_CANVAS.height);
  if (options.inkPadding != null && options.inkTight !== true) {
    throw usage("--ink-padding requires --ink-tight");
  }
  const scratch = createCanvas(8, 8);
  const measureCtx = scratch.getContext("2d");
  const root = buildTree(tree, measureCtx, family, ramp, space, "column", minXHeight);
  try {
    root.calculateLayout(width, height, Direction.LTR);
    collectBoxes(tree, 0, 0);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const cache = new Map<string, Promise<Image>>();
    // paint owns the Frame background too; pre-filling would apply its alpha twice.
    await paint(ctx, tree, options.baseDir, space, cache, quality, warnings, "Frame", themeSurface);
    const layout = layoutDump(tree);
    assessComposition(layout, quality, warnings, ramp, options.safeArea === true);
    let png: Buffer;
    let outWidth = width;
    let outHeight = height;
    let ink_tight: InkTightReport | undefined;
    if (options.inkTight === true) {
      const applied = await applyInkTight(tree, width, height, options.inkPadding ?? 0, {
        baseDir: options.baseDir,
        space,
        cache,
        themeSurface,
      });
      png = Buffer.from(applied.png);
      outWidth = applied.output.width;
      outHeight = applied.output.height;
      ink_tight = applied.report;
    } else {
      png = Buffer.from(canvas.toBuffer("image/png"));
    }
    if (options.outPath) {
      await mkdir(dirname(options.outPath), { recursive: true });
      await writeFile(options.outPath, png);
    }
    if (options.layoutOutPath) {
      await mkdir(dirname(options.layoutOutPath), { recursive: true });
      await writeFile(
        options.layoutOutPath,
        `${JSON.stringify({ space, ramp, ramp_root, ramp_at_1080, quality, warnings, tree: layout, ...(ink_tight ? { ink_tight } : {}) }, null, 2)}\n`,
      );
    }
    return {
      quality,
      warnings,
      png,
      layout,
      space,
      ramp,
      ramp_root,
      ramp_at_1080,
      font_family: family,
      truncated: anyTruncated(layout),
      width: outWidth,
      height: outHeight,
      ...(ink_tight ? { ink_tight } : {}),
    };
  } finally {
    root.freeRecursive();
  }
}
