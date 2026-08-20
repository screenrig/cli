import { WIRE_PLACEMENT_KINDS } from "./compose/catalog.js";
import { usageError } from "./problems.js";

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
// Omitted templated transitions stay crossfade. Swipe is opt-in, never this default.
export const SLIDE_DEFAULT_TRANSITION = { type: "crossfade" as const, duration_ms: 200 };
/** Authoring duration when a swipe type is chosen. Not an OpenAPI default. */
export const SLIDE_SWIPE_AUTHORING_DURATION_MS = 600;
export const PLAYLIST_TRANSITION_TYPES = [
  "crossfade",
  "swipe-left",
  "swipe-right",
  "swipe-up",
  "swipe-down",
] as const;
export const PLACEMENT_ENTER_TYPES = [
  "fade-up",
  "fade-down",
  "fade-left",
  "fade-right",
  "fade-in",
  "zoom-in",
  "zoom-out",
] as const;
export const SLIDE_DEFAULT_ADVANCE = { mode: "duration" as const, after_ms: 8000 };
export const SLIDE_PLATE_FILL = "#243040FF";
export const SLIDE_PLATE_RADIUS = 24;
export const SLIDE_PLATE_PAD_X = 48;
export const SLIDE_PLATE_PAD_Y = 40;
export const SLIDE_FIT_MIN_RATIO = 0.5;
export const SLIDE_FIT_MAX_RATIO = 1.5;
export const SLIDE_FIT_ABS_FLOOR = 12;
export const SHARED_LOGO_RECT = { x: 59, y: 972, width: 344, height: 64 };

/** One stop on a top-to-bottom linear canvas background. `at=0` is the top edge. */
export interface LinearGradientStop {
  at: number;
  color: string;
}

/**
 * Top-to-bottom linear fill. There is no angle field. `stops` is 2 through 8
 * entries, strictly increasing `at` in [0, 1], first at=0, last at=1.
 */
export interface LinearGradientBackground {
  type: "linear";
  stops: LinearGradientStop[];
}

/** Solid canonical `#RRGGBBAA`, or a linear top-to-bottom gradient. */
export type CanvasBackground = string | LinearGradientBackground;

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

export type CatalogSlotKind = "compose" | "image" | "image_or_video";

export interface TemplateCatalogSlot {
  id: string;
  kind: CatalogSlotKind;
  required: boolean;
}

export interface TemplateCatalogEntry {
  id: string;
  compose_locally: boolean;
  slots: TemplateCatalogSlot[];
}

export interface TemplateCatalog {
  compose: {
    catalog_command: string;
    render_command: string;
    wire_kinds: readonly string[];
  };
  canvas: {
    width: number;
    height: number;
    viewport_fit: "contain";
    background: string;
  };
  transition: { type: "crossfade"; duration_ms: number };
  transition_types: readonly typeof PLAYLIST_TRANSITION_TYPES[number][];
  swipe_duration_ms: number;
  enter_types: readonly typeof PLACEMENT_ENTER_TYPES[number][];
  advance: { mode: "duration"; after_ms: number };
  templates: TemplateCatalogEntry[];
}

export function playlistTemplateCatalog(): TemplateCatalog {
  return {
    compose: {
      catalog_command: "screenrig --json compose catalog",
      render_command: "screenrig --json compose render <file>",
      wire_kinds: [...WIRE_PLACEMENT_KINDS],
    },
    canvas: {
      width: SLIDE_CANVAS_WIDTH,
      height: SLIDE_CANVAS_HEIGHT,
      viewport_fit: SLIDE_VIEWPORT_FIT,
      background: SLIDE_BACKGROUND,
    },
    transition: { ...SLIDE_DEFAULT_TRANSITION },
    transition_types: [...PLAYLIST_TRANSITION_TYPES],
    swipe_duration_ms: SLIDE_SWIPE_AUTHORING_DURATION_MS,
    enter_types: [...PLACEMENT_ENTER_TYPES],
    advance: { ...SLIDE_DEFAULT_ADVANCE },
    templates: SLIDE_TEMPLATES.map((template) => ({
      id: template.id,
      compose_locally: template.slots.some((slot) => slot.kind === "text") || template.chrome.length > 0 || template.plate,
      slots: template.slots.map((slot) => catalogSlot(slot)),
    })),
  };
}

function catalogSlot(slot: SlotDef): TemplateCatalogSlot {
  if (slot.kind === "text") {
    return {
      id: slot.id,
      kind: "compose",
      required: slot.required,
    };
  }
  return {
    id: slot.id,
    kind: slot.accept === "image" ? "image" : "image_or_video",
    required: slot.required,
  };
}

export function formatTemplateCatalog(catalog: TemplateCatalog): string {
  const lines = [
    "Slide layouts with copy or chrome are composed locally, uploaded as image, then placed as one image.",
    `Wire kinds: ${catalog.compose.wire_kinds.join(", ")}.`,
    `Compose: ${catalog.compose.catalog_command}`,
    `Default page transition is ${catalog.transition.type} ${catalog.transition.duration_ms} ms with no placement enter. Swipe and enter are optional and spare.`,
  ];
  for (const template of catalog.templates) {
    const slots = template.slots.map((slot) => formatCatalogSlot(slot)).join("; ");
    lines.push(`${template.id}  ${slots}`);
  }
  return lines.join("\n");
}

function formatCatalogSlot(slot: TemplateCatalogSlot): string {
  const parts = [slot.kind, slot.required ? "required" : "optional"];
  return `${slot.id} (${parts.join(", ")})`;
}

function vectorChromeError(label: string): never {
  throw usageError(
    `${label} would emit native text, box, or line placements. Compose a still with compose render, upload it as image, and place that image on the page.`,
    {
      command: "screenrig --json compose catalog",
      reason: "List the local compose catalog, then run compose render and media upload.",
    },
  );
}

function assertWirePlacementKinds(page: unknown, index: number): void {
  if (!isRecord(page) || !Array.isArray(page.placements)) {
    return;
  }
  const label = pageLabel(page, index);
  for (const [placementIndex, placement] of page.placements.entries()) {
    if (!isRecord(placement) || !isRecord(placement.content)) {
      continue;
    }
    const type = placement.content.type;
    if (typeof type !== "string" || !(WIRE_PLACEMENT_KINDS as readonly string[]).includes(type)) {
      throw usageError(
        `${label} placements[${placementIndex}] content.type must be ${WIRE_PLACEMENT_KINDS.join("|")}. Compose copy and chrome locally.`,
        {
          command: "screenrig --json compose catalog",
          reason: "List the local compose catalog, then run compose render and media upload.",
        },
      );
    }
  }
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
    assertWirePlacementKinds(page, index);
    return page;
  }
  const expanded = expandTemplatedPage(page, index);
  assertWirePlacementKinds(expanded, index);
  return expanded;
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
  if (template.slots.some((slot) => slot.kind === "text" && (slot.required || slot.id in slots))) {
    vectorChromeError(label);
  }
  for (const slot of template.slots) {
    if (slot.kind === "picture" && slot.required && !(slot.id in slots)) {
      throw usageError(`Missing required slot ${slot.id} on template ${template.id}.`);
    }
  }

  const background = readBackground(page.canvas, label);

  const placements: unknown[] = [];
  for (const slot of template.slots) {
    if (slot.kind !== "picture") {
      continue;
    }
    const pictured = readPictureSlot(slot, slots[slot.id]);
    if (pictured) {
      placements.push(picturePlacement(slot, pictured));
    }
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

function readBackground(canvas: unknown, label: string): CanvasBackground {
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
  return canvasBackground(canvas.background, `${label} canvas.background`);
}

function canvasBackground(value: unknown, name: string): CanvasBackground {
  if (typeof value === "string") {
    return canvasColor(value, name);
  }
  if (!isRecord(value)) {
    throw usageError(`${name} must be an 8-digit #RRGGBBAA color or a linear gradient.`);
  }
  const extra = Object.keys(value).filter((key) => key !== "type" && key !== "stops").sort();
  if (extra.length > 0) {
    throw usageError(`${name} has unsupported fields: ${extra.join(", ")}.`);
  }
  if (value.type !== "linear") {
    throw usageError(`${name}.type must be linear.`);
  }
  if (!Array.isArray(value.stops) || value.stops.length < 2 || value.stops.length > 8) {
    throw usageError(`${name}.stops must contain 2 through 8 stops.`);
  }
  const last = value.stops.length - 1;
  let previousAt = Number.NEGATIVE_INFINITY;
  const stops = value.stops.map((stop, index) => {
    const stopName = `${name}.stops[${index}]`;
    if (!isRecord(stop)) {
      throw usageError(`${stopName} must be an object.`);
    }
    const stopExtra = Object.keys(stop).filter((key) => key !== "at" && key !== "color").sort();
    if (stopExtra.length > 0) {
      throw usageError(`${stopName} has unsupported fields: ${stopExtra.join(", ")}.`);
    }
    if (typeof stop.at !== "number" || !Number.isFinite(stop.at) || stop.at < 0 || stop.at > 1) {
      throw usageError(`${stopName}.at must be a finite number from 0 through 1.`);
    }
    if (index === 0 && stop.at !== 0) {
      throw usageError(`${stopName}.at must be 0.`);
    }
    if (index === last && stop.at !== 1) {
      throw usageError(`${stopName}.at must be 1.`);
    }
    if (index > 0 && !(stop.at > previousAt)) {
      throw usageError(`${stopName}.at must be strictly greater than the previous stop.`);
    }
    previousAt = stop.at;
    return {
      at: stop.at,
      color: canvasColor(stop.color, `${stopName}.color`),
    };
  });
  return { type: "linear", stops };
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
