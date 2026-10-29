/** Geometry lint for a playlist document: what `playlist validate` reports beside schema validity. */

const LINT_CODES = [
  "collision",
  "motion_overuse",
  "adjacent_repeat",
  "safe_margin",
] as const;

type LintCode = (typeof LINT_CODES)[number];

const COLLISION_OVERLAP = 0.2;
const FULL_BLEED_COVERAGE = 0.95;
const SAFE_MARGIN = 0.04;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LintFinding {
  page_id: string;
  code: LintCode;
  id: string;
  message: string;
}

function sortLint(findings: LintFinding[], pageOrder: string[]): LintFinding[] {
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

export function lintPlaylistPages(pages: unknown[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const records = pages.map(pageRecord);
  for (const [index, page] of records.entries()) {
    if (!page) continue;
    findings.push(...lintPlaylistPage(page));
    if (index === 0) continue;
    const previous = records[index - 1];
    if (!previous) continue;
    // Two consecutive full-bleed photos are a slideshow, not a repeat. The
    // lint fires only when the pages show the same media in the same places.
    if (contentSet(previous) === contentSet(page) && contentSet(page) !== "" && page.primitives.every((primitive) => primitive.content !== "")) {
      findings.push({
        page_id: page.id,
        code: "adjacent_repeat",
        id: page.primitives[0]?.id ?? page.id,
        message: `${page.id}: shows the same media at the same rects as ${previous.id}.`,
      });
    }
  }
  return sortLint(findings, records.map((page) => page?.id ?? ""));
}

function lintPlaylistPage(page: PlaylistPage): LintFinding[] {
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
  const enters = page.primitives.filter((primitive) => primitive.enter && !(primitive.rect && isFullBleed(primitive.rect, canvas)));
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
      if (!first.rect || !second.rect) continue;
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
    const rect = primitive.rect;
    if (!rect || isFullBleed(rect, canvas)) continue;
    if (withinSafeMargin(rect, canvas)) {
      findings.push({
        page_id: page.id,
        code: "safe_margin",
        id: primitive.id,
        message: `${page.id}: ${primitive.id} sits within 4% of a canvas edge.`,
      });
    }
  }
  return findings;
}

interface PlaylistPage {
  id: string;
  canvas: Box;
  primitives: Array<{
    id: string;
    kind: string;
    /** Absent when the document carries no rect (a layout or displays placement the server derives); no geometry is judged then. */
    rect?: Box;
    /** What the primitive shows: media ids, a tag, or a URL. Empty when unknown. */
    content: string;
    motion?: unknown;
    enter?: unknown;
  }>;
}

/**
 * The content identity of a primitive, independent of where it sits. Image and
 * video name media through a selector; iframe and application name a source.
 */
function primitiveContent(primitive: Record<string, unknown>): string {
  const selector = primitive.selector;
  if (selector && typeof selector === "object" && !Array.isArray(selector)) {
    const record = selector as Record<string, unknown>;
    if (typeof record.media_id === "string") return `id:${record.media_id}`;
    if (Array.isArray(record.media_ids)) return `ids:${record.media_ids.filter((id) => typeof id === "string").sort().join(",")}`;
    if (typeof record.tag === "string") return `tag:${record.tag}`;
    if (typeof record.folder_id === "string") return `folder:${record.folder_id}`;
    if (record.by === "all") return "all";
  }
  if (typeof primitive.src === "string") return `src:${primitive.src}`;
  if (typeof primitive.release_id === "string") return `release:${primitive.release_id}`;
  if (typeof primitive.application_id === "string") return `application:${primitive.application_id}`;
  return "";
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
      : undefined;
    return [{
      id: typeof primitive.id === "string" ? primitive.id : "primitive",
      kind: typeof primitive.primitive === "string" ? primitive.primitive : "image",
      ...(rectRecord ? { rect: {
        x: numberOf(rectRecord.x, 0),
        y: numberOf(rectRecord.y, 0),
        width: numberOf(rectRecord.width, 0),
        height: numberOf(rectRecord.height, 0),
      } } : {}),
      content: primitiveContent(primitive),
      motion: primitive.motion,
      enter: primitive.enter,
    }];
  }) : [];
  return { id, canvas, primitives };
}

function contentSet(page: PlaylistPage): string {
  return page.primitives
    .map((primitive) => `${primitive.content}@${primitive.rect ? `${primitive.rect.x},${primitive.rect.y},${primitive.rect.width},${primitive.rect.height}` : "derived"}`)
    .sort()
    .join("|");
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

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
