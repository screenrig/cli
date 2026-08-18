import { usageError } from "./problems.js";
import {
  longestSansLineWidth,
  minSansLineHeight,
} from "./sans-advance.js";

export { minSansLineHeight, measureSansLineWidth, longestSansLineWidth } from "./sans-advance.js";

export const SLIDE_CANVAS_WIDTH = 1920;
export const SLIDE_CANVAS_HEIGHT = 1080;
export const SLIDE_VIEWPORT_FIT = "contain" as const;
export const SLIDE_BACKGROUND = "#1B2632FF";
export const SLIDE_TEXT_COLOR = "#EEE9DFFF";
export const SLIDE_BAR_COLOR = "#F8B334FF";
export const SLIDE_MUSTARD = "#F8B334FF";
export const SLIDE_DIM = "#B8B3A9FF";
export const SLIDE_FAINT = "#8C8880FF";
export const SLIDE_FONT_FAMILY = "sans" as const;
export const SLIDE_DEFAULT_TRANSITION = { type: "crossfade" as const, duration_ms: 200 };
export const SLIDE_DEFAULT_ADVANCE = { mode: "duration" as const, after_ms: 8000 };
export const SLIDE_PLATE_FILL = "#243040FF";
export const SLIDE_PLATE_RADIUS = 24;
export const SLIDE_PLATE_PAD_X = 48;
export const SLIDE_PLATE_PAD_Y = 40;
export const SLIDE_FIT_MIN_RATIO = 0.5;
export const SLIDE_FIT_MAX_RATIO = 1.5;
export const SLIDE_FIT_ABS_FLOOR = 12;
export const SHARED_LOGO_RECT = { x: 59, y: 972, width: 344, height: 64 };

const TEMPLATED_PAGE_KEYS = new Set([
  "id",
  "template",
  "slots",
  "canvas",
  "text_color",
  "transition",
  "advance",
  "visibility",
]);

const COLOR = /^#[0-9A-Fa-f]{8}$/;
const ALIGN = new Set(["left", "center", "right"]);
const VERTICAL_ALIGN = new Set(["top", "middle", "bottom"]);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Align = "left" | "center" | "right";
type VerticalAlign = "top" | "middle" | "bottom";

interface TextSlotDef {
  id: string;
  kind: "text";
  required: boolean;
  rect: Rect;
  font_size: number;
  line_height: number;
  font_weight: 400 | 700;
  align: Align;
  vertical_align: VerticalAlign;
  color?: string;
}

interface PictureSlotDef {
  id: string;
  kind: "picture";
  required: boolean;
  rect: Rect;
  content_fit: "cover" | "contain";
  accept: "image" | "image_or_video";
  layer: 0 | 2;
}

type SlotDef = TextSlotDef | PictureSlotDef;

interface ChromeDef {
  id: string;
  rect: Rect;
  color: string;
}

export interface SlideTemplateDef {
  id: string;
  slots: readonly SlotDef[];
  chrome: readonly ChromeDef[];
  stack: readonly string[];
  pack: "start" | "center";
  plate: boolean;
}

const BAR: ChromeDef = {
  id: "bar",
  rect: { x: 0, y: 0, width: 1920, height: 16 },
  color: SLIDE_BAR_COLOR,
};

const LOGO: PictureSlotDef = {
  id: "logo",
  kind: "picture",
  required: false,
  rect: { ...SHARED_LOGO_RECT },
  content_fit: "contain",
  accept: "image",
  layer: 2,
};

// Inter `sans` natural line box is font_size * (1984+494)/2048. line_height
// below that yields negative half-leading and clips descenders (no-overflow).
const EYEBROW = { font_size: 32, line_height: 40, font_weight: 400 as const, color: SLIDE_MUSTARD };
const HEADLINE = { font_size: 80, line_height: 100, font_weight: 700 as const };
const HEADLINE_LG = { font_size: 96, line_height: 120, font_weight: 700 as const };
const SUB = { font_size: 36, line_height: 48, font_weight: 400 as const, color: SLIDE_DIM };
const FOOT = { font_size: 22, line_height: 32, font_weight: 400 as const, color: SLIDE_FAINT };

function text(
  id: string,
  required: boolean,
  rect: Rect,
  type: {
    font_size: number;
    line_height: number;
    font_weight: 400 | 700;
    align?: Align;
    vertical_align?: VerticalAlign;
    color?: string;
  },
): TextSlotDef {
  return {
    id,
    kind: "text",
    required,
    rect,
    font_size: type.font_size,
    line_height: type.line_height,
    font_weight: type.font_weight,
    align: type.align ?? "left",
    vertical_align: type.vertical_align ?? "top",
    ...(type.color ? { color: type.color } : {}),
  };
}

function picture(
  id: string,
  required: boolean,
  rect: Rect,
  content_fit: "cover" | "contain" = "cover",
): PictureSlotDef {
  return {
    id,
    kind: "picture",
    required,
    rect,
    content_fit,
    accept: "image_or_video",
    layer: 0,
  };
}

function copyStack(column: { x: number; width: number }, align: Align = "left"): TextSlotDef[] {
  const { x, width } = column;
  return [
    text("eyebrow", false, { x, y: 140, width, height: 40 }, { ...EYEBROW, align }),
    text("headline", true, { x, y: 192, width, height: 200 }, { ...HEADLINE, align }),
    text("subhead", false, { x, y: 408, width, height: 110 }, { ...SUB, align }),
    text("body", false, { x, y: 534, width, height: 336 }, { ...SUB, align }),
    text("footnote", false, { x, y: 886, width, height: 64 }, { ...FOOT, align }),
  ];
}

function headerEyebrow(width: number): TextSlotDef {
  return text("eyebrow", false, { x: 280, y: 68, width, height: 40 }, EYEBROW);
}

function statPair(index: 1 | 2 | 3 | 4, col: 0 | 1, row: 0 | 1, required: boolean): TextSlotDef[] {
  const x = 59 + col * (880 + 43);
  const y = 250 + row * (360 + 43);
  return [
    text(`v${index}`, required, { x, y, width: 880, height: 96 }, {
      font_size: 72,
      line_height: 88,
      font_weight: 700,
      color: SLIDE_MUSTARD,
    }),
    text(`l${index}`, required, { x, y: y + 108, width: 880, height: 191 }, {
      font_size: 24,
      line_height: 32,
      font_weight: 400,
      color: SLIDE_DIM,
    }),
  ];
}

function threeUpPair(index: 1 | 2 | 3, x: number, required: boolean): TextSlotDef[] {
  return [
    text(`t${index}`, required, { x, y: 250, width: 560, height: 80 }, {
      font_size: 36,
      line_height: 44,
      font_weight: 700,
      color: SLIDE_MUSTARD,
    }),
    text(`b${index}`, required, { x, y: 350, width: 560, height: 602 }, {
      font_size: 26,
      line_height: 36,
      font_weight: 400,
      color: SLIDE_DIM,
    }),
  ];
}

function bullets(): TextSlotDef[] {
  return [1, 2, 3, 4, 5, 6].map((index) =>
    text(`b${index}`, index === 1, { x: 59, y: 260 + (index - 1) * 100, width: 1100, height: 88 }, {
      font_size: 36,
      line_height: 44,
      font_weight: 400,
    }),
  );
}

const COPY_STACK_IDS = ["eyebrow", "headline", "subhead", "body", "footnote"] as const;

export const SLIDE_TEMPLATES: readonly SlideTemplateDef[] = [
  {
    id: "slide-intro",
    pack: "center",
    stack: ["title", "subtitle"],
    plate: false,
    slots: [
      text("title", true, { x: 160, y: 460, width: 1600, height: 240 }, {
        ...HEADLINE_LG,
        align: "center",
        vertical_align: "middle",
        color: SLIDE_MUSTARD,
      }),
      text("subtitle", false, { x: 240, y: 716, width: 1440, height: 104 }, {
        ...SUB,
        align: "center",
      }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-text-only-1",
    pack: "center",
    stack: COPY_STACK_IDS,
    plate: false,
    slots: [
      text("eyebrow", true, { x: 160, y: 180, width: 1600, height: 40 }, { ...EYEBROW, align: "center" }),
      text("headline", true, { x: 160, y: 232, width: 1600, height: 200 }, { ...HEADLINE, align: "center" }),
      text("subhead", false, { x: 160, y: 448, width: 1600, height: 110 }, { ...SUB, align: "center" }),
      text("body", false, { x: 160, y: 574, width: 1600, height: 288 }, { ...SUB, align: "center" }),
      text("footnote", false, { x: 160, y: 878, width: 1600, height: 78 }, { ...FOOT, align: "center" }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-text-only-2",
    pack: "center",
    stack: ["eyebrow", "headline", "subhead"],
    plate: false,
    slots: [
      text("eyebrow", true, { x: 160, y: 180, width: 1600, height: 40 }, { ...EYEBROW, align: "center" }),
      text("headline", true, { x: 160, y: 236, width: 1600, height: 240 }, { ...HEADLINE_LG, align: "center" }),
      text("subhead", false, { x: 160, y: 492, width: 1600, height: 200 }, { ...SUB, align: "center" }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-text-photo-1",
    pack: "start",
    stack: COPY_STACK_IDS,
    plate: false,
    slots: [
      ...copyStack({ x: 59, width: 825 }),
      picture("picture", false, { x: 1003, y: 165, width: 874, height: 750 }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-text-photo-2",
    pack: "start",
    stack: COPY_STACK_IDS,
    plate: false,
    slots: [
      ...copyStack({ x: 1036, width: 825 }),
      picture("picture", false, { x: 43, y: 165, width: 874, height: 750 }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-text-photo-3",
    pack: "start",
    stack: COPY_STACK_IDS,
    plate: false,
    slots: [
      ...copyStack({ x: 1257, width: 604 }),
      picture("picture", false, { x: 43, y: 165, width: 1095, height: 750 }, "contain"),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-half-bleed-1",
    pack: "start",
    stack: COPY_STACK_IDS,
    plate: false,
    slots: [
      ...copyStack({ x: 1020, width: 840 }),
      picture("picture", true, { x: 0, y: 16, width: 960, height: 1064 }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-half-bleed-2",
    pack: "start",
    stack: COPY_STACK_IDS,
    plate: false,
    slots: [
      ...copyStack({ x: 60, width: 840 }),
      picture("picture", true, { x: 960, y: 16, width: 960, height: 1064 }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-quote",
    pack: "center",
    stack: ["quote", "author"],
    plate: true,
    slots: [
      text("quote", true, { x: 200, y: 280, width: 1520, height: 520 }, {
        font_size: 72,
        line_height: 88,
        font_weight: 700,
        align: "center",
        vertical_align: "middle",
      }),
      text("author", false, { x: 300, y: 820, width: 1320, height: 80 }, {
        font_size: 28,
        line_height: 36,
        font_weight: 400,
        align: "center",
        color: SLIDE_DIM,
      }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-callout",
    pack: "center",
    stack: ["headline", "body"],
    plate: true,
    slots: [
      text("headline", true, { x: 248, y: 280, width: 1424, height: 240 }, {
        ...HEADLINE,
        align: "center",
      }),
      text("body", false, { x: 248, y: 544, width: 1424, height: 336 }, {
        ...SUB,
        align: "center",
      }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-bullets",
    pack: "start",
    stack: ["eyebrow", "headline"],
    plate: false,
    slots: [
      headerEyebrow(820),
      text("headline", true, { x: 59, y: 140, width: 1100, height: 100 }, HEADLINE),
      ...bullets(),
      picture("picture", false, { x: 1200, y: 165, width: 680, height: 750 }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-stat-grid",
    pack: "start",
    stack: ["eyebrow", "headline"],
    plate: false,
    slots: [
      headerEyebrow(1579),
      text("headline", true, { x: 59, y: 140, width: 1800, height: 100 }, HEADLINE),
      ...statPair(1, 0, 0, true),
      ...statPair(2, 1, 0, false),
      ...statPair(3, 0, 1, false),
      ...statPair(4, 1, 1, false),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-three-up",
    pack: "start",
    stack: ["eyebrow", "headline"],
    plate: false,
    slots: [
      headerEyebrow(1579),
      text("headline", true, { x: 59, y: 140, width: 1800, height: 100 }, HEADLINE),
      ...threeUpPair(1, 59, true),
      ...threeUpPair(2, 666, false),
      ...threeUpPair(3, 1273, false),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-photo",
    pack: "start",
    stack: [],
    plate: false,
    slots: [
      picture("picture", true, { x: 43, y: 122, width: 1834, height: 880 }),
      text("caption", false, { x: 419, y: 1012, width: 1421, height: 52 }, {
        font_size: 22,
        line_height: 30,
        font_weight: 400,
      }),
      LOGO,
    ],
    chrome: [BAR],
  },
  {
    id: "slide-full-bleed",
    pack: "start",
    stack: [],
    plate: false,
    slots: [
      picture("picture", true, { x: 0, y: 0, width: 1920, height: 1080 }),
      LOGO,
    ],
    chrome: [BAR],
  },
];

const TEMPLATE_BY_ID = new Map(SLIDE_TEMPLATES.map((template) => [template.id, template]));

export type CatalogSlotKind = "text" | "image" | "image_or_video";

export interface TemplateCatalogSlot {
  id: string;
  kind: CatalogSlotKind;
  required: boolean;
  align?: Align;
  vertical_align?: VerticalAlign;
}

export interface TemplateCatalogEntry {
  id: string;
  slots: TemplateCatalogSlot[];
}

export interface TemplateCatalog {
  canvas: {
    width: number;
    height: number;
    viewport_fit: "contain";
    background: string;
  };
  text_color: string;
  font_family: "sans";
  wrap: false;
  transition: { type: "crossfade"; duration_ms: number };
  advance: { mode: "duration"; after_ms: number };
  templates: TemplateCatalogEntry[];
}

export function playlistTemplateCatalog(): TemplateCatalog {
  return {
    canvas: {
      width: SLIDE_CANVAS_WIDTH,
      height: SLIDE_CANVAS_HEIGHT,
      viewport_fit: SLIDE_VIEWPORT_FIT,
      background: SLIDE_BACKGROUND,
    },
    text_color: SLIDE_TEXT_COLOR,
    font_family: SLIDE_FONT_FAMILY,
    wrap: false,
    transition: { ...SLIDE_DEFAULT_TRANSITION },
    advance: { ...SLIDE_DEFAULT_ADVANCE },
    templates: SLIDE_TEMPLATES.map((template) => ({
      id: template.id,
      slots: template.slots.map((slot) => catalogSlot(slot)),
    })),
  };
}

function catalogSlot(slot: SlotDef): TemplateCatalogSlot {
  if (slot.kind === "text") {
    const entry: TemplateCatalogSlot = {
      id: slot.id,
      kind: "text",
      required: slot.required,
      align: slot.align,
    };
    if (slot.vertical_align !== "top") {
      entry.vertical_align = slot.vertical_align;
    }
    return entry;
  }
  return {
    id: slot.id,
    kind: slot.accept === "image" ? "image" : "image_or_video",
    required: slot.required,
  };
}

export function formatTemplateCatalog(catalog: TemplateCatalog): string {
  const lines = ["Closed slide templates"];
  for (const template of catalog.templates) {
    const slots = template.slots.map((slot) => formatCatalogSlot(slot)).join("; ");
    lines.push(`${template.id}  ${slots}`);
  }
  return lines.join("\n");
}

function formatCatalogSlot(slot: TemplateCatalogSlot): string {
  const parts = [slot.kind, slot.required ? "required" : "optional"];
  if (slot.align) {
    parts.push(`align ${slot.align}`);
  }
  if (slot.vertical_align) {
    parts.push(`vertical_align ${slot.vertical_align}`);
  }
  return `${slot.id} (${parts.join(", ")})`;
}

export function expandPlaylistPages(pages: unknown[]): unknown[] {
  return pages.map((page, index) => expandPlaylistPage(page, index));
}

export function expandPlaylistPage(page: unknown, index = 0): unknown {
  if (!isRecord(page)) {
    return page;
  }
  if ("template" in page && "placements" in page) {
    throw usageError(`${pageLabel(page, index)} mixes template and placements. Use one page shape.`);
  }
  if (!("template" in page)) {
    return page;
  }
  return expandTemplatedPage(page, index);
}

interface TextSlotValue {
  text: string;
  align: Align;
  vertical_align: VerticalAlign;
}

interface LaidText {
  text: string;
  font_size: number;
  line_height: number;
  align: Align;
  vertical_align: VerticalAlign;
  rect: Rect;
}

function expandTemplatedPage(page: Record<string, unknown>, index: number): Record<string, unknown> {
  const label = pageLabel(page, index);
  const extra = Object.keys(page).filter((key) => !TEMPLATED_PAGE_KEYS.has(key)).sort();
  if (extra.length > 0) {
    throw usageError(`${label} has unsupported fields: ${extra.join(", ")}.`);
  }
  if (typeof page.id !== "string" || page.id.length === 0) {
    throw usageError(`${label} requires id.`);
  }
  const template = resolveTemplate(page.template);
  const slots = readSlots(page.slots, label);
  const unknownSlots = Object.keys(slots).filter((id) => !template.slots.some((slot) => slot.id === id)).sort();
  if (unknownSlots.length > 0) {
    throw usageError(`Unknown slot ${unknownSlots.join(", ")} on template ${template.id}.`);
  }
  for (const slot of template.slots) {
    if (slot.required && !(slot.id in slots)) {
      throw usageError(`Missing required slot ${slot.id} on template ${template.id}.`);
    }
  }

  const background = readBackground(page.canvas, label);
  const textColor = page.text_color === undefined
    ? SLIDE_TEXT_COLOR
    : canvasColor(page.text_color, `${label} text_color`);

  const laid = new Map<string, LaidText>();
  for (const slot of template.slots) {
    if (slot.kind !== "text") {
      continue;
    }
    const value = readTextSlot(slot, slots[slot.id]);
    if (value === undefined) {
      continue;
    }
    laid.set(slot.id, layoutTextSlot(slot, value, template.stack.includes(slot.id)));
  }
  packCopyStack(template, laid);

  const placements: unknown[] = [];
  for (const slot of template.slots) {
    if (slot.kind !== "picture" || slot.layer !== 0) {
      continue;
    }
    const pictured = readPictureSlot(slot, slots[slot.id]);
    if (pictured) {
      placements.push(picturePlacement(slot, pictured));
    }
  }
  for (const chrome of template.chrome) {
    placements.push(linePlacement(chrome));
  }
  if (template.plate) {
    const plateRects = template.stack
      .map((id) => laid.get(id)?.rect)
      .filter((rect): rect is Rect => rect !== undefined);
    if (plateRects.length > 0) {
      placements.push(platePlacement(plateRects));
    }
  }
  for (const slot of template.slots) {
    if (slot.kind !== "picture" || slot.layer !== 2) {
      continue;
    }
    const pictured = readPictureSlot(slot, slots[slot.id]);
    if (pictured) {
      placements.push(picturePlacement(slot, pictured));
    }
  }
  for (const slot of template.slots) {
    if (slot.kind !== "text") {
      continue;
    }
    const value = laid.get(slot.id);
    if (value === undefined) {
      continue;
    }
    placements.push(textPlacement(slot, value, slot.color ?? textColor));
  }

  const expanded: Record<string, unknown> = {
    id: page.id,
    canvas: {
      width: SLIDE_CANVAS_WIDTH,
      height: SLIDE_CANVAS_HEIGHT,
      viewport_fit: SLIDE_VIEWPORT_FIT,
      background,
    },
    transition: page.transition === undefined ? { ...SLIDE_DEFAULT_TRANSITION } : page.transition,
    advance: page.advance === undefined ? { ...SLIDE_DEFAULT_ADVANCE } : page.advance,
    placements,
  };
  if ("visibility" in page) {
    expanded.visibility = page.visibility;
  }
  return expanded;
}

function resolveTemplate(value: unknown): SlideTemplateDef {
  if (typeof value !== "string" || !TEMPLATE_BY_ID.has(value)) {
    const named = typeof value === "string" && value.length > 0 ? ` ${value}` : "";
    throw usageError(`Unknown template${named}. Run playlist templates for the closed catalog.`, {
      command: "screenrig --json playlist templates",
      reason: "List the closed slide templates and their slots.",
    });
  }
  return TEMPLATE_BY_ID.get(value) as SlideTemplateDef;
}

function readSlots(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw usageError(`${label} slots must be an object keyed by slot id.`);
  }
  return value;
}

function readBackground(canvas: unknown, label: string): string {
  if (canvas === undefined) {
    return SLIDE_BACKGROUND;
  }
  if (!isRecord(canvas)) {
    throw usageError(`${label} canvas must be an object.`);
  }
  const extra = Object.keys(canvas).filter((key) => key !== "background").sort();
  if (extra.length > 0) {
    throw usageError(`${label} canvas has unsupported fields: ${extra.join(", ")}.`);
  }
  if (canvas.background === undefined) {
    return SLIDE_BACKGROUND;
  }
  return canvasColor(canvas.background, `${label} canvas.background`);
}

function readTextSlot(slot: TextSlotDef, value: unknown): TextSlotValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw usageError(`Slot ${slot.id} must be an object.`);
  }
  if ("type" in value) {
    throw usageError(`Slot ${slot.id} is a text slot and does not take type ${String(value.type)}.`);
  }
  const extra = Object.keys(value).filter((key) => key !== "text" && key !== "align" && key !== "vertical_align").sort();
  if (extra.length > 0) {
    throw usageError(`Slot ${slot.id} has unsupported fields: ${extra.join(", ")}.`);
  }
  if (!("text" in value)) {
    throw usageError(`Slot ${slot.id} is a text slot and requires text.`);
  }
  const joined = joinText(value.text, slot.id);
  if (joined.length === 0) {
    throw usageError(slot.required
      ? `Required slot ${slot.id} has empty text.`
      : `Slot ${slot.id} has empty text.`);
  }
  return {
    text: joined,
    align: readAlign(slot, value.align),
    vertical_align: readVerticalAlign(slot, value.vertical_align),
  };
}

function readAlign(slot: TextSlotDef, value: unknown): Align {
  if (value === undefined) {
    return slot.align;
  }
  if (typeof value !== "string" || !ALIGN.has(value)) {
    throw usageError(`Slot ${slot.id} align must be left, center, or right.`);
  }
  return value as Align;
}

function readVerticalAlign(slot: TextSlotDef, value: unknown): VerticalAlign {
  if (value === undefined) {
    return slot.vertical_align;
  }
  if (typeof value !== "string" || !VERTICAL_ALIGN.has(value)) {
    throw usageError(`Slot ${slot.id} vertical_align must be top, middle, or bottom.`);
  }
  return value as VerticalAlign;
}

function readPictureSlot(
  slot: PictureSlotDef,
  value: unknown,
): { content: Record<string, unknown>; content_fit: "cover" | "contain" } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw usageError(`Slot ${slot.id} must be an object.`);
  }
  if ("text" in value && !("type" in value)) {
    throw usageError(
      slot.accept === "image"
        ? `Slot ${slot.id} is an image slot and does not take text.`
        : `Slot ${slot.id} is an image or video slot and does not take text.`,
    );
  }
  const type = value.type;
  if (type !== "image" && type !== "video") {
    throw usageError(
      slot.accept === "image"
        ? `Slot ${slot.id} must be image content.`
        : `Slot ${slot.id} must be image or video content.`,
    );
  }
  if (slot.accept === "image" && type === "video") {
    throw usageError(`Slot ${slot.id} is an image slot and does not take video.`);
  }
  const allowed = type === "image"
    ? slot.accept === "image"
      ? ["type", "selector", "alt", "dwell_ms"]
      : ["type", "selector", "alt", "dwell_ms", "content_fit"]
    : ["type", "selector", "muted", "loop", "content_fit"];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (extra.length > 0) {
    throw usageError(`Slot ${slot.id} has unsupported fields: ${extra.join(", ")}.`);
  }
  if (!isRecord(value.selector)) {
    throw usageError(`Slot ${slot.id} requires a selector.`);
  }
  const content_fit = readContentFit(slot, value.content_fit);
  const content: Record<string, unknown> = { type, selector: value.selector };
  if (type === "image") {
    if (value.alt !== undefined) content.alt = value.alt;
    if (value.dwell_ms !== undefined) content.dwell_ms = value.dwell_ms;
  } else {
    if (value.muted !== undefined) content.muted = value.muted;
    if (value.loop !== undefined) content.loop = value.loop;
  }
  return { content, content_fit };
}

function readContentFit(slot: PictureSlotDef, value: unknown): "cover" | "contain" {
  if (value === undefined) {
    return slot.content_fit;
  }
  if (value !== "cover" && value !== "contain") {
    throw usageError(`Slot ${slot.id} content_fit must be contain or cover.`);
  }
  return value;
}

function joinText(value: unknown, slotId: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.every((line) => typeof line === "string")) {
      throw usageError(`Slot ${slotId} text array must contain only strings.`);
    }
    return value.join("\n");
  }
  throw usageError(`Slot ${slotId} text must be a string or an array of strings.`);
}

function layoutTextSlot(slot: TextSlotDef, value: TextSlotValue, inStack: boolean): LaidText {
  const fitted = fitAndTruncate(slot, value.text);
  let y = slot.rect.y;
  if (!inStack) {
    if (value.vertical_align === "middle") {
      y = slot.rect.y + Math.round((slot.rect.height - fitted.height) / 2);
    } else if (value.vertical_align === "bottom") {
      y = slot.rect.y + slot.rect.height - fitted.height;
    }
  }
  return {
    text: fitted.text,
    font_size: fitted.font_size,
    line_height: fitted.line_height,
    align: value.align,
    vertical_align: value.vertical_align,
    rect: { x: slot.rect.x, y, width: slot.rect.width, height: fitted.height },
  };
}

function fitAndTruncate(slot: TextSlotDef, raw: string): {
  text: string;
  font_size: number;
  line_height: number;
  height: number;
} {
  const source = raw.split("\n");
  let { font_size, line_height } = fitType(slot, source, true);
  const maxLines = Math.max(1, Math.floor(slot.rect.height / line_height));
  const truncated = source.length > maxLines;
  const lines = truncateLines(source, maxLines);
  if (truncated) {
    ({ font_size, line_height } = fitType(slot, lines, false));
  }
  return {
    text: lines.join("\n"),
    font_size,
    line_height,
    height: lines.length * line_height,
  };
}

function fitType(
  slot: TextSlotDef,
  lines: readonly string[],
  allowGrow: boolean,
): { font_size: number; line_height: number } {
  const minSize = Math.max(SLIDE_FIT_ABS_FLOOR, Math.ceil(slot.font_size * SLIDE_FIT_MIN_RATIO));
  const maxSize = Math.floor(slot.font_size * SLIDE_FIT_MAX_RATIO);
  const widthAt = (size: number) => longestSansLineWidth(lines, size, slot.font_weight);
  const lineHeightAt = (size: number) => lineHeightForSize(slot, size);
  const maxLinesAt = (size: number) => Math.max(1, Math.floor(slot.rect.height / lineHeightAt(size)));

  let size = slot.font_size;
  if (widthAt(size) > slot.rect.width) {
    let low = minSize;
    let high = size;
    let best = minSize;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (widthAt(mid) <= slot.rect.width) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    size = best;
  } else if (allowGrow && size < maxSize) {
    const keep = Math.min(lines.length, maxLinesAt(slot.font_size));
    let low = size;
    let high = maxSize;
    let best = size;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const shown = Math.min(lines.length, maxLinesAt(mid));
      const packed = shown * lineHeightAt(mid);
      if (widthAt(mid) <= slot.rect.width && packed <= slot.rect.height && shown >= keep) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    size = best;
  }
  return { font_size: size, line_height: lineHeightAt(size) };
}

function lineHeightForSize(slot: TextSlotDef, fontSize: number): number {
  const scaled = Math.ceil((slot.line_height * fontSize) / slot.font_size);
  return Math.max(scaled, minSansLineHeight(fontSize));
}

function truncateLines(lines: readonly string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return [...lines];
  }
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = kept.length - 1;
  kept[last] = `${kept[last] ?? ""}…`;
  return kept;
}

function packCopyStack(template: SlideTemplateDef, laid: Map<string, LaidText>): void {
  if (template.stack.length === 0) {
    return;
  }
  const defs = template.stack
    .map((id) => template.slots.find((slot) => slot.kind === "text" && slot.id === id))
    .filter((slot): slot is TextSlotDef => slot !== undefined);
  const present = defs.filter((slot) => laid.has(slot.id));
  if (present.length === 0) {
    return;
  }
  const holeTop = defs[0]!.rect.y;
  const holeBottom = Math.max(...defs.map((slot) => slot.rect.y + slot.rect.height));
  let y = holeTop;
  let previous: TextSlotDef | undefined;
  for (const slot of present) {
    if (previous !== undefined) {
      const originalGap = slot.rect.y - (previous.rect.y + previous.rect.height);
      const adjacent = defs[defs.indexOf(previous)! + 1] === slot;
      y += adjacent ? Math.max(0, originalGap) : 16;
    }
    const item = laid.get(slot.id)!;
    item.rect = { ...item.rect, y, height: item.rect.height };
    y += item.rect.height;
    previous = slot;
  }
  if (template.pack !== "center") {
    return;
  }
  const first = laid.get(present[0]!.id)!;
  const last = laid.get(present[present.length - 1]!.id)!;
  const packedHeight = last.rect.y + last.rect.height - first.rect.y;
  const holeHeight = holeBottom - holeTop;
  const shift = Math.round((holeHeight - packedHeight) / 2);
  if (shift <= 0) {
    return;
  }
  for (const slot of present) {
    const item = laid.get(slot.id)!;
    item.rect = { ...item.rect, y: item.rect.y + shift };
  }
}

function textPlacement(slot: TextSlotDef, value: LaidText, color: string): Record<string, unknown> {
  return {
    id: slot.id,
    content: {
      type: "text",
      text: value.text,
      font_family: SLIDE_FONT_FAMILY,
      font_weight: slot.font_weight,
      italic: false,
      font_size: value.font_size,
      line_height: value.line_height,
      color,
      align: value.align,
      vertical_align: value.vertical_align,
    },
    rect: { ...value.rect },
    layer: 2,
    content_fit: "fill",
  };
}

function picturePlacement(
  slot: PictureSlotDef,
  pictured: { content: Record<string, unknown>; content_fit: "cover" | "contain" },
): Record<string, unknown> {
  return {
    id: slot.id,
    content: pictured.content,
    rect: { ...slot.rect },
    layer: slot.layer,
    content_fit: pictured.content_fit,
  };
}

function linePlacement(chrome: ChromeDef): Record<string, unknown> {
  return {
    id: chrome.id,
    content: {
      type: "line",
      orientation: chrome.rect.width >= chrome.rect.height ? "horizontal" : "vertical",
      color: chrome.color,
    },
    rect: { ...chrome.rect },
    layer: 1,
    content_fit: "fill",
  };
}

function platePlacement(rects: readonly Rect[]): Record<string, unknown> {
  const left = Math.max(0, Math.min(...rects.map((rect) => rect.x)) - SLIDE_PLATE_PAD_X);
  const top = Math.max(0, Math.min(...rects.map((rect) => rect.y)) - SLIDE_PLATE_PAD_Y);
  const right = Math.min(
    SLIDE_CANVAS_WIDTH,
    Math.max(...rects.map((rect) => rect.x + rect.width)) + SLIDE_PLATE_PAD_X,
  );
  const bottom = Math.min(
    SLIDE_CANVAS_HEIGHT,
    Math.max(...rects.map((rect) => rect.y + rect.height)) + SLIDE_PLATE_PAD_Y,
  );
  return {
    id: "plate",
    content: {
      type: "box",
      fill: SLIDE_PLATE_FILL,
      border_width: 0,
      border_color: "#00000000",
      corner_radius: {
        top_left: SLIDE_PLATE_RADIUS,
        top_right: SLIDE_PLATE_RADIUS,
        bottom_right: SLIDE_PLATE_RADIUS,
        bottom_left: SLIDE_PLATE_RADIUS,
      },
    },
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    layer: 1,
    content_fit: "fill",
  };
}

function canvasColor(value: unknown, name: string): string {
  if (typeof value !== "string" || !COLOR.test(value)) {
    throw usageError(`${name} must be an 8-digit #RRGGBBAA color.`);
  }
  return value.toUpperCase();
}

function pageLabel(page: Record<string, unknown>, index: number): string {
  return typeof page.id === "string" && page.id.length > 0 ? `Page ${page.id}` : `pages[${index}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
