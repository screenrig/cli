import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
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
import { FONT_FALLBACKS } from "./catalog.js";
import { fitType, type FittedText } from "./fit-text.js";
import { resolveSpace, spaceScale, typeRamp } from "./tokens.js";
import type { Align, ComposeFrame, ComposeNode, Pin, SpaceScale, TypeRamp } from "./types.js";
import { validateSpec } from "./validate.js";

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
  children?: LayoutNode[];
}

export interface LayoutDump {
  type: string;
  role?: string;
  pin?: string;
  box?: Box;
  fit?: {
    fontSize: number;
    lineHeight: number;
    lines: string[];
    truncated: boolean;
  };
  children?: LayoutDump[];
}

export interface ComposeResult {
  layout: LayoutDump;
  space: SpaceScale;
  ramp: TypeRamp;
  font_family: string;
  truncated: boolean;
  width: number;
  height: number;
}

function usage(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "usage_error";
  return err;
}

export function resolveFontFamily(name: string | undefined): string {
  if (name != null && name !== "") {
    if (!GlobalFonts.has(name)) {
      throw usage(`font family not installed: ${name}`);
    }
    return name;
  }
  for (const family of FONT_FALLBACKS) {
    if (GlobalFonts.has(family)) {
      return family;
    }
  }
  throw usage(
    `none of the fallback fonts were installed: ${FONT_FALLBACKS.join(", ")}`,
  );
}

export function resolveImagePath(src: string, baseDir: string): string {
  if (src.includes("\0")) {
    throw usage("Image.src must not contain a NUL byte");
  }
  if (src.includes("://") || /^(https?|file|data):/i.test(src)) {
    throw usage("Image.src must be a local filesystem path, not a URL");
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
  }
  if (node.align) yoga.setAlignItems(ALIGN[node.align] ?? YogaAlign.Stretch);
  else if (node.type === "Row" || node.type === "Column" || node.type === "Frame" || node.type === "Box") {
    yoga.setAlignItems(YogaAlign.Stretch);
  }
  if (node.justify) yoga.setJustifyContent(JUSTIFY[node.justify] ?? YogaJustify.FlexStart);
  if (node.pin) applyPin(yoga, node.pin);

  if (node.type === "Frame") {
    yoga.setWidth(node.width ?? 0);
    yoga.setHeight(node.height ?? 0);
    yoga.setFlexDirection(node.direction === "row" ? FlexDirection.Row : FlexDirection.Column);
  } else if (node.type === "Row") {
    yoga.setFlexDirection(FlexDirection.Row);
  } else if (node.type === "Column" || node.type === "Box") {
    yoga.setFlexDirection(FlexDirection.Column);
  } else if (node.type === "Spacer") {
    yoga.setFlexGrow(node.flex ?? 1);
  } else if (node.type === "Text") {
    const role = node.role ?? "body";
    yoga.setMeasureFunc((width, widthMode, height, heightMode) => {
      let maxWidth = width;
      if (widthMode === MeasureMode.Undefined || maxWidth <= 0) maxWidth = 4096;
      let maxHeight: number | null = null;
      if (heightMode === MeasureMode.AtMost || heightMode === MeasureMode.Exactly) maxHeight = height;
      const fitted = fitType(ctx, {
        text: String(node.text ?? ""),
        family,
        ramp,
        role,
        maxWidth,
        maxHeight,
      });
      node._fit = fitted;
      const contentWidth = Math.ceil(Math.max(0, ...fitted.lines.map((line) => {
        ctx.font = fitted.font;
        return ctx.measureText(line).width;
      })));
      return {
        width: widthMode === MeasureMode.Exactly ? width : Math.min(maxWidth, contentWidth),
        height: fitted.height,
      };
    });
  } else if (node.type === "Image") {
    yoga.setFlexGrow(node.flex ?? 0);
    if (node.flex) yoga.setFlexShrink(1);
  }

  (node.children ?? []).forEach((child, i) => {
    yoga.insertChild(buildTree(child, ctx, family, ramp, space), i);
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

async function imageFor(src: string, baseDir: string, cache: Map<string, Promise<Image>>): Promise<Image> {
  const path = resolveImagePath(src, baseDir);
  let pending = cache.get(path);
  if (!pending) {
    pending = loadImage(path).catch(() => {
      throw usage("Image.src could not be read as a local file");
    });
    cache.set(path, pending);
  }
  return pending;
}

async function paint(
  ctx: SKRSContext2D,
  node: LayoutNode,
  baseDir: string,
  space: SpaceScale,
  cache: Map<string, Promise<Image>>,
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
  if (node.background && node.type !== "Image") {
    ctx.fillStyle = parseColor(node.background, "#000");
    if (radius) {
      roundRect(ctx, box.x, box.y, box.width, box.height, radius);
      ctx.fill();
    } else {
      ctx.fillRect(box.x, box.y, box.width, box.height);
    }
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
    if (scale == null) {
      ctx.drawImage(img, box.x, box.y, box.width, box.height);
    } else {
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, box.x + (box.width - dw) / 2, box.y + (box.height - dh) / 2, dw, dh);
    }
    ctx.restore();
  }
  if (node.type === "Text" && node._fit) {
    const fit = node._fit;
    ctx.fillStyle = parseColor(node.color, "#EEE9DF");
    ctx.font = fit.font;
    ctx.textBaseline = "alphabetic";
    const align = (node.align as Align | "left" | "center" | "right" | undefined) ?? "left";
    ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
    let x = box.x;
    if (align === "center") x = box.x + box.width / 2;
    if (align === "right") x = box.x + box.width;
    const blockHeight = fit.lines.length * fit.lineHeight;
    let y = box.y + Math.round((box.height - blockHeight) / 2) + Math.round(fit.fontSize * 0.8);
    if (box.height <= blockHeight + 2) y = box.y + Math.round(fit.fontSize * 0.8);
    for (const line of fit.lines) {
      ctx.fillText(line, x, y);
      y += fit.lineHeight;
    }
  }
  for (const child of node.children ?? []) await paint(ctx, child, baseDir, space, cache);
  if (clipBox) ctx.restore();
}

function layoutDump(node: LayoutNode): LayoutDump {
  const dump: LayoutDump = { type: node.type, role: node.role, pin: node.pin, box: node._box };
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

export async function composeSpec(
  spec: unknown,
  options: { baseDir: string; outPath?: string; layoutOutPath?: string },
): Promise<ComposeResult & { png: Buffer }> {
  const validated = validateSpec(spec);
  const tree = structuredClone(validated) as LayoutNode;
  const family = resolveFontFamily(typeof tree.fontFamily === "string" ? tree.fontFamily : undefined);
  const width = tree.width ?? 0;
  const height = tree.height ?? 0;
  const space = spaceScale(width, height);
  const ramp = typeRamp(width, height);
  const scratch = createCanvas(8, 8);
  const measureCtx = scratch.getContext("2d");
  const root = buildTree(tree, measureCtx, family, ramp, space);
  try {
    root.calculateLayout(width, height, Direction.LTR);
    collectBoxes(tree, 0, 0);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = parseColor(typeof tree.background === "string" ? tree.background : undefined, "#1B2632");
    ctx.fillRect(0, 0, width, height);
    await paint(ctx, tree, options.baseDir, space, new Map());
    const png = Buffer.from(canvas.toBuffer("image/png"));
    const layout = layoutDump(tree);
    if (options.outPath) {
      await mkdir(dirname(options.outPath), { recursive: true });
      await writeFile(options.outPath, png);
    }
    if (options.layoutOutPath) {
      await mkdir(dirname(options.layoutOutPath), { recursive: true });
      await writeFile(
        options.layoutOutPath,
        `${JSON.stringify({ space, ramp, tree: layout }, null, 2)}\n`,
      );
    }
    return {
      png,
      layout,
      space,
      ramp,
      font_family: family,
      truncated: anyTruncated(layout),
      width,
      height,
    };
  } finally {
    root.freeRecursive();
  }
}
