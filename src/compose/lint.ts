import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ComposeQuality, LayoutDump } from "./compose.js";
import { cssFont } from "./fonts.js";
import { expandComposeRecipe, RECIPE_WORD_BUDGET, type SignageRecipe } from "./recipes.js";
import type { ComposeNode, TextEffects, TextPlate, TextShadow } from "./types.js";
import { VIEWING_DISTANCES, type ViewingDistance } from "./types.js";

export { RECIPE_WORD_BUDGET, VIEWING_DISTANCES };
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
  "effects_overuse",
  "adjacent_repeat",
  "safe_margin",
] as const;

export type LintCode = (typeof LINT_CODES)[number];

/** Body-text x-height as a fraction of the frame's shorter edge. */
export const VIEWING_XHEIGHT_RATIO: Record<ViewingDistance, number> = {
  near: 0.007,
  mid: 0.012,
  far: 0.02,
};

export const FREEFORM_WORD_BUDGET = 60;
/** Fallback x-height as a fraction of font size when metrics are missing. */
export const XHEIGHT_FALLBACK = 0.52;

const COLLISION_OVERLAP = 0.2;
const FULL_BLEED_COVERAGE = 0.95;
const CONTRAST_MIN = 4.5;
const BUSY_STDDEV = 40;
const SAFE_MARGIN = 0.04;
const EFFECT_FAMILIES = ["weight", "italic", "underline", "outline", "shadow", "arc", "texture"] as const;

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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NodeInfo {
  id: string;
  type: string;
  role?: string;
  text?: string;
  color?: string;
  background?: unknown;
  effects?: TextEffects;
  textShadow?: TextShadow;
  plate?: TextPlate;
  plateDiag?: { code: "plate_applied" | "plate_skipped"; contrast_ratio: number };
  box?: Box;
  ink?: Box;
  fontSize?: number;
  fontFamily?: string;
  parentId?: string;
}

export function parseViewing(value: unknown): ViewingDistance {
  if (value === "near" || value === "mid" || value === "far") return value;
  return "mid";
}

export function viewingOf(spec: unknown): ViewingDistance {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "mid";
  return parseViewing((spec as { viewing?: unknown }).viewing);
}

export function wordBudgetOf(spec: unknown): number {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return FREEFORM_WORD_BUDGET;
  const recipe = (spec as { recipe?: unknown }).recipe;
  if (typeof recipe === "string" && recipe in RECIPE_WORD_BUDGET) return RECIPE_WORD_BUDGET[recipe as SignageRecipe]!;
  return FREEFORM_WORD_BUDGET;
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
  layout: LayoutDump;
  quality: ComposeQuality;
  pixels?: PixelBuffer;
  viewing?: ViewingDistance;
}): LintFinding[] {
  const findings: LintFinding[] = [];
  const viewing = args.viewing ?? viewingOf(args.spec);
  const frame = args.quality.output;
  const shorter = Math.min(frame.width, frame.height);
  const expanded = safeExpand(args.spec);
  const nodes = collectNodes(expanded, args.layout, "Frame");
  const minXHeight = shorter * VIEWING_XHEIGHT_RATIO[viewing];
  const words = countWords(nodes);
  const budget = wordBudgetOf(args.spec);
  if (words > budget) {
    findings.push({
      page_id: args.page_id,
      code: "too_dense",
      id: "Frame",
      message: `${args.page_id}: ${words} words exceed the ${budget} word budget for this page.`,
    });
  }
  const families = new Set<string>();
  let extraEffectId: string | undefined;
  for (const node of nodes) {
    if (node.type !== "Text") continue;
    for (const family of effectFamilies(node)) {
      if (families.has(family)) continue;
      if (families.size >= 1 && extraEffectId === undefined) extraEffectId = node.id;
      families.add(family);
    }
  }
  if (families.size > 1 && extraEffectId) {
    findings.push({
      page_id: args.page_id,
      code: "effects_overuse",
      id: extraEffectId,
      message: `${args.page_id}: more than one text effect family on this page (${[...families].join(", ")}).`,
    });
  }
  const opaque = nodes.filter((node) => isOpaque(node) && node.box && area(node.box) > 1);
  for (let i = 0; i < opaque.length; i++) {
    for (let j = i + 1; j < opaque.length; j++) {
      const first = opaque[i]!;
      const second = opaque[j]!;
      if (related(first.id, second.id)) continue;
      if (isFullBleed(first.box!, frame) || isFullBleed(second.box!, frame)) continue;
      const overlap = overlapBox(first.box!, second.box!);
      if (!overlap) continue;
      const ratio = area(overlap) / Math.min(area(first.box!), area(second.box!));
      if (ratio > COLLISION_OVERLAP) {
        findings.push({
          page_id: args.page_id,
          code: "collision",
          id: second.id,
          message: `${args.page_id}: ${first.id} overlaps ${second.id} by ${(ratio * 100).toFixed(0)}%.`,
        });
      }
    }
  }
  const measure = createCanvas(8, 8).getContext("2d");
  for (const node of nodes) {
    if (node.type !== "Text" || !node.ink || !node.fontSize) continue;
    const family = node.fontFamily ?? "sans-serif";
    const xHeight = measureXHeight(measure, family, node.fontSize, node.effects);
    if (xHeight + 0.05 < minXHeight) {
      findings.push({
        page_id: args.page_id,
        code: "too_small_for_distance",
        id: node.id,
        message: `${args.page_id}: ${node.id} x-height ${xHeight.toFixed(1)}px is below the ${viewing} minimum ${minXHeight.toFixed(1)}px.`,
      });
    }
    if (!isFullBleed(node.ink, frame) && withinSafeMargin(node.ink, frame)) {
      findings.push({
        page_id: args.page_id,
        code: "safe_margin",
        id: node.id,
        message: `${args.page_id}: ${node.id} ink sits within 4% of a frame edge.`,
      });
    }
    if (args.pixels) {
      const contrast = sampledContrast(args.pixels, node.ink);
      if (contrast !== undefined && contrast < CONTRAST_MIN) {
        findings.push({
          page_id: args.page_id,
          code: "low_contrast_rendered",
          id: node.id,
          message: `${args.page_id}: ${node.id} contrast ${contrast.toFixed(2)}:1 is below 4.5:1.`,
        });
      }
      if (!hasPlate(node, nodes) && overBusyImage(node, nodes, args.pixels)) {
        findings.push({
          page_id: args.page_id,
          code: "text_over_busy_image",
          id: node.id,
          message: `${args.page_id}: ${node.id} sits on a high-variance image without a plate.`,
        });
      }
    }
  }
  return findings;
}

export function lintAdjacentComposePages(pages: Array<{ id: string; spec: unknown }>): LintFinding[] {
  const findings: LintFinding[] = [];
  for (let i = 1; i < pages.length; i++) {
    const previous = pages[i - 1]!;
    const current = pages[i]!;
    const left = recipeKey(previous.spec);
    const right = recipeKey(current.spec);
    if (left && right && left === right) {
      findings.push({
        page_id: current.id,
        code: "adjacent_repeat",
        id: "Frame",
        message: `${current.id}: repeats ${left} from ${previous.id}.`,
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
    const previousRecipe = pageRecipeKey(previous.raw);
    const currentRecipe = pageRecipeKey(page.raw);
    if (previousRecipe && currentRecipe && previousRecipe === currentRecipe) {
      findings.push({
        page_id: page.id,
        code: "adjacent_repeat",
        id: page.id,
        message: `${page.id}: repeats ${currentRecipe} from ${previous.id}.`,
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

function pageRecipeKey(raw: Record<string, unknown>): string | undefined {
  return recipeKey(raw.template ?? raw);
}

function rectSet(page: PlaylistPage): string {
  return page.primitives
    .map((primitive) => `${primitive.rect.x},${primitive.rect.y},${primitive.rect.width},${primitive.rect.height}`)
    .sort()
    .join("|");
}

function recipeKey(spec: unknown): string | undefined {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return undefined;
  const recipe = (spec as { recipe?: unknown; id?: unknown }).recipe ?? (spec as { id?: unknown }).id;
  if (typeof recipe !== "string" || recipe.length === 0) return undefined;
  const variant = (spec as { variant?: unknown }).variant;
  return `${recipe}:${typeof variant === "string" ? variant : "a"}`;
}

function safeExpand(spec: unknown): ComposeNode {
  try {
    const expanded = expandComposeRecipe(structuredClone(spec), []);
    if (expanded && typeof expanded === "object") return expanded as ComposeNode;
  } catch {
    // Lint never fails closed on an unexpanded recipe; compose already validated the spec.
  }
  if (spec && typeof spec === "object") return spec as ComposeNode;
  return { type: "Frame" };
}

function collectNodes(spec: ComposeNode, layout: LayoutDump, path: string, parentId?: string): NodeInfo[] {
  const node: NodeInfo = {
    id: path,
    type: spec.type,
    role: typeof spec.role === "string" ? spec.role : layout.role,
    text: typeof spec.text === "string" ? spec.text : undefined,
    color: typeof spec.color === "string" ? spec.color : undefined,
    background: spec.background,
    effects: spec.effects,
    textShadow: spec.textShadow,
    plate: spec.plate,
    plateDiag: layout.plate,
    box: layout.box,
    ink: layout.text_bounds,
    fontSize: layout.fit?.fontSize,
    fontFamily: layout.text_font?.family ?? (typeof spec.fontFamily === "string" ? spec.fontFamily : undefined),
    parentId,
  };
  const nodes = [node];
  const specChildren = spec.children ?? [];
  const layoutChildren = layout.children ?? [];
  const count = Math.max(specChildren.length, layoutChildren.length);
  for (let i = 0; i < count; i++) {
    const childSpec = specChildren[i] ?? { type: layoutChildren[i]?.type ?? "Box" };
    const childLayout = layoutChildren[i] ?? { type: childSpec.type };
    nodes.push(...collectNodes(childSpec, childLayout, `${path}.children[${i}]`, path));
  }
  return nodes;
}

function countWords(nodes: NodeInfo[]): number {
  let n = 0;
  for (const node of nodes) {
    if (!node.text) continue;
    const bits = node.text.trim().split(/\s+/);
    if (bits[0]) n += bits.length;
  }
  return n;
}

function effectFamilies(node: NodeInfo): string[] {
  const effects = node.effects ?? {};
  const families: string[] = [];
  if (effects.weight) families.push("weight");
  if (effects.italic === true) families.push("italic");
  if (effects.underline === true) families.push("underline");
  if (effects.outline) families.push("outline");
  if (effects.shadow || node.textShadow) families.push("shadow");
  if (effects.arc) families.push("arc");
  if (effects.texture) families.push("texture");
  return families.filter((family) => (EFFECT_FAMILIES as readonly string[]).includes(family));
}

function isOpaque(node: NodeInfo): boolean {
  if (node.type === "Text" || node.type === "Image" || node.type === "Icon" || node.type === "Divider" || node.type === "Pill") return true;
  return hasFill(node.background);
}

function hasFill(paint: unknown): boolean {
  if (typeof paint === "string") return !isFullyTransparent(paint);
  if (!paint || typeof paint !== "object" || Array.isArray(paint)) return false;
  return (paint as { type?: unknown }).type === "linear";
}

function isFullyTransparent(color: string): boolean {
  const raw = color.replace("#", "");
  if (raw.length === 8) return Number.parseInt(raw.slice(6, 8), 16) === 0;
  return false;
}

function isFullBleed(box: Box, frame: { width: number; height: number }): boolean {
  const coverage = area(overlapBox(box, { x: 0, y: 0, width: frame.width, height: frame.height }) ?? { x: 0, y: 0, width: 0, height: 0 })
    / Math.max(1, frame.width * frame.height);
  return coverage >= FULL_BLEED_COVERAGE;
}

function related(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
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

function withinSafeMargin(box: Box, frame: { width: number; height: number }): boolean {
  const inset = Math.min(frame.width, frame.height) * SAFE_MARGIN;
  return box.x < inset
    || box.y < inset
    || box.x + box.width > frame.width - inset
    || box.y + box.height > frame.height - inset;
}

function hasPlate(node: NodeInfo, nodes: NodeInfo[]): boolean {
  if (node.plate === "auto") return true;
  if (node.plate && typeof node.plate === "object") return true;
  if (node.plateDiag?.code === "plate_applied") return true;
  let parentId = node.parentId;
  while (parentId) {
    const parent = nodes.find((item) => item.id === parentId);
    if (!parent) break;
    if (parent.type !== "Frame" && hasFill(parent.background)) return true;
    parentId = parent.parentId;
  }
  return false;
}

function overBusyImage(node: NodeInfo, nodes: NodeInfo[], pixels: PixelBuffer): boolean {
  const ink = node.ink;
  if (!ink) return false;
  for (const other of nodes) {
    if (other.type !== "Image" || !other.box) continue;
    const overlap = overlapBox(ink, other.box);
    if (!overlap) continue;
    if (luminanceStddev(pixels, overlap) > BUSY_STDDEV) return true;
  }
  return false;
}

function measureXHeight(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  family: string,
  size: number,
  effects?: TextEffects,
): number {
  const weight = effects?.weight === "bold" ? "700" : "400";
  ctx.font = cssFont(weight, size, family, effects?.italic === true);
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

export function viewingGuidance(): string {
  return 'optional Frame "near"|"mid"|"far"; default mid. Fit-text applies that x-height floor at layout; lint warns too_small_for_distance if a node still undershoots 0.7%/1.2%/2.0% of the shorter edge.';
}
