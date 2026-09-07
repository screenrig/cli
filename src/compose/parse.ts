import {
  ALIGN,
  CARD_FITS,
  DRIFT_DIR,
  DRIFT_ZOOM,
  ENTER_TYPES,
  LOGO_CORNERS,
  LOGO_INSET,
  LOGO_MAX,
  REGIONS,
  SPEED,
  SPIN_DIR,
  VALIGN,
  VIEWING_DISTANCES,
  type Align,
  type CardFit,
  type CardItem,
  type ComposeDocument,
  type LayerOutline,
  type LayerShadow,
  type LayerSpec,
  type LogoCorner,
  type PrimitiveEnter,
  type PrimitiveMotion,
  type PrimitiveMotionDrift,
  type PrimitiveMotionSpin,
  type RegionName,
  type TableBlock,
  type Valign,
  type ViewingDistance,
} from "./types.js";
import { pageRoot, parseViewing } from "./type.js";

export { REGIONS };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const PAGE_META = new Set([
  "width", "height", "font", "background", "brand", "text", "image", "video", "motion", "pages", "name", "viewing", "logo",
]);
const LEAF_PAGE_KEYS = new Set(["id", "video", "image", "motion", "background", "brand", "text", "font", "viewing", "logo", ...REGIONS]);
const LOGO_KEYS = new Set(["src", "corner"]);
const PAGE_RENAMES: Record<string, string> = {
  ink: "text",
  accent: "brand",
  muted: "text (muted is derived from text and background)",
  surface: "background",
  color: "text",
  fontSize: "fontSize is not authorable; type size is procedural",
  fontFamily: "font",
  theme: "theme palettes are removed; set background, brand, and text on the page",
  recipe: "recipes are removed; write regions from compose catalog",
  children: "Frame trees are removed; write regions from compose catalog",
  type: "Frame/Column/Row/Box/Text are removed; write regions from compose catalog",
};
const REGION_CONTENT_KEYS = new Set([
  "eyebrow", "title", "subtitle", "text", "footer",
  "image", "video", "iframe", "webapp",
  "cards", "table", "fill",
]);
const REGION_KEYS = new Set([
  "eyebrow", "title", "subtitle", "text", "footer",
  "image", "video", "iframe", "webapp",
  "cards", "card", "table",
  "enter", "stagger", "motion",
  "align", "valign", "fill", "color", "z", "shadow", "outline",
]);
const SHADOW_KEYS = new Set(["x", "y", "color", "blur"]);
const OUTLINE_KEYS = new Set(["width", "color"]);
const CARD_KEYS = new Set(["title", "subtitle", "text", "price", "image"]);
const CARD_PLATE_KEYS = new Set(["eyebrow", "title", "subtitle", "text", "footer", "image", "cards", "table", "fill", "color", "fit"]);
const TABLE_KEYS = new Set(["columns", "rows"]);
const OLD_LANGUAGE_KEYS = new Set(["type", "recipe", "children", "theme", "fontFamily", "fontSize", "padding", "gap", "pin", "flex"]);

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "usage_error" });
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hex(value: unknown, path: string): string {
  if (typeof value !== "string" || !HEX.test(value)) fail(`${path} must be #RGB, #RRGGBB, or #RRGGBBAA`);
  return value;
}

/** Page background RGB with alpha B3 (70% opaque). `#0D0D0D` → `#0D0D0DB3`. */
export function defaultCardFill(background: string): string {
  const raw = background.replace("#", "");
  const rgb = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw.slice(0, 6);
  return `#${rgb}B3`;
}

function rgbOf(value: string): { r: number; g: number; b: number } {
  const raw = value.replace("#", "");
  const hex6 = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw.slice(0, 6);
  return {
    r: Number.parseInt(hex6.slice(0, 2), 16),
    g: Number.parseInt(hex6.slice(2, 4), 16),
    b: Number.parseInt(hex6.slice(4, 6), 16),
  };
}

function mixHex(from: string, toward: string, t: number): string {
  const a = rgbOf(from);
  const b = rgbOf(toward);
  const ch = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${ch(a.r + (b.r - a.r) * t)}${ch(a.g + (b.g - a.g) * t)}${ch(a.b + (b.b - a.b) * t)}`;
}

function unknownHint(key: string, where: string): string {
  if (PAGE_RENAMES[key]) return `${where}${key}; use ${PAGE_RENAMES[key]}`;
  if (key === "x" || key === "y") return `${where}${key}; region names place content. Run compose catalog.`;
  if (key === "font") return `${where}font; set font on the page`;
  return `${where}${key}`;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${path} must be nonempty text`);
  return value;
}

function copy(value: unknown, path: string): string {
  if (Array.isArray(value)) {
    if (!value.length || value.some((line) => typeof line !== "string")) fail(`${path} must be text or an array of strings`);
    const joined = value.join("\n").trim();
    if (!joined) fail(`${path} must be nonempty text`);
    return joined;
  }
  return str(value, path);
}

function optionalStr(value: unknown, path: string): string | null {
  if (value == null) return null;
  return str(value, path);
}

function optionalCopy(value: unknown, path: string): string | null {
  if (value == null) return null;
  return copy(value, path);
}

function int(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${path} must be an integer ${min}..${max}`);
  }
  return value;
}

function parseMotion(value: unknown, path: string): PrimitiveMotion {
  if (typeof value === "string") {
    return parseMotionParts(value.split(":"), path);
  }
  if (!isTable(value) || typeof value.type !== "string") fail(`${path} must be a string or an object with type`);
  if (value.type === "spin") {
    return parseMotionParts(["spin", String(value.direction ?? "cw"), String(value.speed ?? "slow")], path);
  }
  if (value.type === "drift") {
    return parseMotionParts(["drift", String(value.zoom ?? "in"), String(value.direction ?? "none"), String(value.speed ?? "slow")], path);
  }
  if (value.type === "path") fail(`${path}.type path is a playlist field, not compose motion; use spin or drift`);
  fail(`${path}.type must be spin or drift`);
}

function parseMotionParts(parts: string[], path: string): PrimitiveMotion {
  const type = parts[0];
  if (type === "spin") {
    const direction = parts[1] ?? "cw";
    const speed = parts[2] ?? "slow";
    if (!(SPIN_DIR as readonly string[]).includes(direction) || !(SPEED as readonly string[]).includes(speed) || parts.length > 3) {
      fail(`${path} spin is spin:cw|ccw:slow|medium|fast`);
    }
    return {
      type: "spin",
      direction: direction as PrimitiveMotionSpin["direction"],
      speed: speed as PrimitiveMotionSpin["speed"],
    };
  }
  if (type === "drift") {
    const zoom = parts[1] ?? "in";
    const direction = parts[2] ?? "none";
    const speed = parts[3] ?? "slow";
    if (
      !(DRIFT_ZOOM as readonly string[]).includes(zoom)
      || !(DRIFT_DIR as readonly string[]).includes(direction)
      || !(SPEED as readonly string[]).includes(speed)
      || parts.length > 4
    ) {
      fail(`${path} drift is drift:in|out:left|right|up|down|none:slow|medium|fast`);
    }
    return {
      type: "drift",
      zoom: zoom as PrimitiveMotionDrift["zoom"],
      direction: direction as PrimitiveMotionDrift["direction"],
      speed: speed as PrimitiveMotionDrift["speed"],
    };
  }
  fail(`${path} type must be spin or drift`);
}

export function regionRect(name: string, width: number, height: number): { x: number; y: number; w: number; h: number } | null {
  const midX = Math.round(width / 2);
  const t1 = Math.round(width / 3);
  const t2 = Math.round((2 * width) / 3);
  const midY = Math.round(height / 2);
  const band = Math.round(height * 0.34);
  switch (name) {
    case "background":
    case "fullpage":
      return { x: 0, y: 0, w: width, h: height };
    case "left":
      return { x: 0, y: 0, w: midX, h: height };
    case "right":
      return { x: midX, y: 0, w: width - midX, h: height };
    case "left-third":
      return { x: 0, y: 0, w: t1, h: height };
    case "middle-third":
      return { x: t1, y: 0, w: t2 - t1, h: height };
    case "right-third":
      return { x: t2, y: 0, w: width - t2, h: height };
    case "middle-half":
      return { x: Math.round(width * 0.25), y: 0, w: Math.round(width * 0.5), h: height };
    case "top-half":
      return { x: 0, y: 0, w: width, h: midY };
    case "bottom-half":
      return { x: 0, y: midY, w: width, h: height - midY };
    case "top":
      return { x: 0, y: 0, w: width, h: band };
    case "bottom":
      return { x: 0, y: height - band, w: width, h: band };
    default:
      return null;
  }
}

function parseShadow(value: unknown, path: string): LayerShadow {
  if (value === "none") return "none";
  if (!isTable(value)) fail(`${path} must be "none" or { x, y, color, blur? }`);
  const extra = Object.keys(value).filter((key) => !SHADOW_KEYS.has(key));
  if (extra.length) fail(`${path} unknown keys: ${extra.join(", ")}`);
  if (!Number.isFinite(value.x) || !Number.isInteger(value.x)) fail(`${path}.x must be an integer`);
  if (!Number.isFinite(value.y) || !Number.isInteger(value.y)) fail(`${path}.y must be an integer`);
  const blur = value.blur == null ? 0 : value.blur;
  if (typeof blur !== "number" || !Number.isInteger(blur) || blur < 0 || blur > 32) {
    fail(`${path}.blur must be an integer 0..32`);
  }
  const shadow: { x: number; y: number; color: string; blur?: number } = {
    x: value.x as number,
    y: value.y as number,
    color: hex(value.color, `${path}.color`),
  };
  if (blur > 0) shadow.blur = blur;
  return shadow;
}

function parseOutline(value: unknown, path: string): LayerOutline {
  if (!isTable(value)) fail(`${path} must be { width, color }`);
  const extra = Object.keys(value).filter((key) => !OUTLINE_KEYS.has(key));
  if (extra.length) fail(`${path} unknown keys: ${extra.join(", ")}`);
  if (typeof value.width !== "number" || !Number.isFinite(value.width) || value.width < 0.5 || value.width > 12) {
    fail(`${path}.width must be a number from 0.5 to 12`);
  }
  return { width: value.width, color: hex(value.color, `${path}.color`) };
}

function parseCards(value: unknown, path: string): CardItem[] {
  if (!Array.isArray(value) || value.length < 1) fail(`${path} must be an array of objects`);
  return value.map((item, i) => {
    if (!isTable(item)) fail(`${path}[${i}] must be an object`);
    const extra = Object.keys(item).filter((key) => !CARD_KEYS.has(key));
    if (extra.length) fail(`${path}[${i}] unknown keys: ${extra.join(", ")}`);
    return {
      title: str(item.title, `${path}[${i}].title`),
      subtitle: optionalCopy(item.subtitle, `${path}[${i}].subtitle`),
      text: optionalCopy(item.text, `${path}[${i}].text`),
      price: optionalStr(item.price, `${path}[${i}].price`),
      image: optionalStr(item.image, `${path}[${i}].image`),
    };
  });
}

function parseTable(value: unknown, path: string): TableBlock {
  if (!isTable(value)) fail(`${path} must be an object`);
  const extra = Object.keys(value).filter((key) => !TABLE_KEYS.has(key));
  if (extra.length) fail(`${path} unknown keys: ${extra.join(", ")}`);
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 8) {
    fail(`${path}.columns must be 1 to 8 strings`);
  }
  const columns = value.columns.map((col, i) => {
    if (typeof col !== "string" || !col.trim()) fail(`${path}.columns[${i}] must be nonempty text`);
    return col;
  });
  if (!Array.isArray(value.rows) || value.rows.length < 1) fail(`${path}.rows must be an array of arrays`);
  const rows = value.rows.map((row, i) => {
    if (!Array.isArray(row) || row.length !== columns.length) fail(`${path}.rows[${i}] must have ${columns.length} cells`);
    return row.map((cell, j) => {
      if (typeof cell !== "string" && typeof cell !== "number") fail(`${path}.rows[${i}][${j}] must be text or a number`);
      return String(cell);
    });
  });
  return { columns, rows };
}

interface PageLogo {
  src: string;
  corner: LogoCorner;
}

interface PageDefaults {
  font: string | null;
  background: string;
  brand: string;
  text: string;
  muted: string;
  image: string | null;
  video: string | null;
  motion: PrimitiveMotion | null;
  viewing: ViewingDistance;
  logo: PageLogo | null;
}

function parseLogo(value: unknown, path: string): PageLogo {
  if (typeof value === "string") return { src: str(value, path), corner: "bottom-right" };
  if (!isTable(value)) fail(`${path} must be a path or { src, corner }`);
  const extra = Object.keys(value).filter((key) => !LOGO_KEYS.has(key));
  if (extra.length) fail(`${path} unknown keys: ${extra.join(", ")}`);
  const corner = value.corner == null ? "bottom-right" : value.corner;
  if (typeof corner !== "string" || !(LOGO_CORNERS as readonly string[]).includes(corner)) {
    fail(`${path}.corner must be ${LOGO_CORNERS.join("|")}`);
  }
  return { src: str(value.src, `${path}.src`), corner: corner as LogoCorner };
}

function parseRegion(name: RegionName, value: unknown, canvas: { width: number; height: number }, order: number, defaults: PageDefaults): LayerSpec {
  if (!isTable(value)) fail(`${name} must be an object`);
  const extra = Object.keys(value).filter((key) => !REGION_KEYS.has(key));
  if (extra.length) fail(extra.map((key) => unknownHint(key, `${name} unknown key `)).join("; "));
  const rect = regionRect(name, canvas.width, canvas.height);
  if (!rect) fail(`${name} is not a region`);
  let content: Record<string, unknown> = value;
  let contentPath: string = name;
  let fill = value.fill != null ? hex(value.fill, `${name}.fill`) : null;
  let ink = value.color != null ? hex(value.color, `${name}.color`) : null;
  let cardFit: CardFit | null = null;
  if (value.card != null) {
    const siblings = [...REGION_CONTENT_KEYS].filter((key) => value[key] != null);
    if (siblings.length) fail(`${name} cannot mix card with ${siblings.join(", ")}; put those fields inside card`);
    if (!isTable(value.card)) fail(`${name}.card must be an object`);
    if ("card" in value.card) fail(`${name}.card cannot nest card`);
    const cardExtra = Object.keys(value.card).filter((key) => !CARD_PLATE_KEYS.has(key));
    if (cardExtra.length) fail(`${name}.card unknown keys: ${cardExtra.join(", ")}`);
    const fit = value.card.fit == null ? "region" : value.card.fit;
    if (typeof fit !== "string" || !(CARD_FITS as readonly string[]).includes(fit)) {
      fail(`${name}.card.fit must be region|ink`);
    }
    cardFit = fit as CardFit;
    content = value.card;
    contentPath = `${name}.card`;
    fill = value.card.fill != null ? hex(value.card.fill, `${name}.card.fill`) : defaultCardFill(defaults.background);
    if (value.card.color != null) ink = hex(value.card.color, `${name}.card.color`);
  }
  const shadow = value.shadow == null ? null : parseShadow(value.shadow, `${name}.shadow`);
  const outline = value.outline == null ? null : parseOutline(value.outline, `${name}.outline`);
  const align = value.align == null ? "left" : value.align;
  if (!(ALIGN as readonly string[]).includes(String(align))) fail(`${name}.align must be left|center|right`);
  const valign = value.valign == null ? "auto" : value.valign;
  if (!(VALIGN as readonly string[]).includes(String(valign))) fail(`${name}.valign must be auto|top|center|bottom`);
  let enter: PrimitiveEnter | null = null;
  if (value.enter != null) {
    if (typeof value.enter !== "string" || !(ENTER_TYPES as readonly string[]).includes(value.enter)) {
      fail(`${name}.enter must be ${ENTER_TYPES.join("|")}`);
    }
    enter = { type: value.enter as PrimitiveEnter["type"] };
  }
  if (value.stagger != null) {
    const stagger = int(value.stagger, `${name}.stagger`, 0, 8);
    enter = { ...(enter ?? { type: "fade-in" }), stagger };
  }
  const motion = value.motion == null ? null : parseMotion(value.motion, `${name}.motion`);
  const z = value.z == null ? order : int(value.z, `${name}.z`, -999, 999);
  const contentPad = Math.round(Math.min(canvas.width, canvas.height) * 0.055);
  const blocks: LayerSpec["blocks"] = [];
  const pushText = (role: "eyebrow" | "title" | "subtitle" | "text" | "footer", raw: unknown) => {
    if (raw == null) return;
    blocks.push({ role, text: copy(raw, `${contentPath}.${role}`) });
  };
  pushText("eyebrow", content.eyebrow);
  pushText("title", content.title);
  pushText("subtitle", content.subtitle);
  pushText("text", content.text);
  if (content.image != null) blocks.push({ role: "image", src: str(content.image, `${contentPath}.image`) });
  let media: LayerSpec["media"] = null;
  if (value.video != null) {
    const src = str(value.video, `${name}.video`);
    media = { type: "video", src };
    blocks.push({ role: "placeholder", kind: "video", src, label: `video · ${src}` });
  }
  if (content.cards != null) blocks.push({ role: "cards", items: parseCards(content.cards, `${contentPath}.cards`) });
  if (content.table != null) blocks.push({ role: "table", ...parseTable(content.table, `${contentPath}.table`) });
  if (value.iframe != null) {
    const src = str(value.iframe, `${name}.iframe`);
    media = { type: "iframe", src };
    blocks.push({ role: "placeholder", kind: "iframe", src, label: `iframe · ${src}` });
  }
  if (value.webapp != null) {
    const src = str(value.webapp, `${name}.webapp`);
    media = { type: "application", src };
    blocks.push({ role: "placeholder", kind: "application", src, label: `webapp · ${src}` });
  }
  pushText("footer", content.footer);
  if (!fill && !blocks.length) fail(`${name} is empty`);
  return {
    id: name,
    region: name,
    z,
    order,
    ...rect,
    pad: contentPad,
    fill,
    ink,
    cardFit,
    surface: defaults.background,
    shadow,
    outline,
    overMedia: Boolean(defaults.image || defaults.video),
    align: align as Align,
    valign: valign as Valign,
    font: defaults.font,
    text: defaults.text,
    muted: defaults.muted,
    brand: defaults.brand,
    root: pageRoot(canvas.width, canvas.height),
    viewing: defaults.viewing,
    enter,
    motion,
    media: content.image != null && !media ? { type: "image", src: String(content.image) } : media,
    blocks,
  };
}

function backgroundLayer(canvas: { width: number; height: number }, defaults: PageDefaults): LayerSpec {
  const blocks: LayerSpec["blocks"] = [];
  let media: LayerSpec["media"] = null;
  if (defaults.video) {
    media = { type: "video", src: defaults.video };
  } else if (defaults.image) {
    blocks.push({ role: "image", src: defaults.image });
    media = { type: "image", src: defaults.image };
  }
  const opaque = defaults.background.replace("#", "").slice(0, 6);
  return {
    id: "background",
    region: "background",
    z: 0,
    order: 0,
    ...regionRect("fullpage", canvas.width, canvas.height)!,
    pad: 0,
    fill: defaults.video ? `#${opaque}00` : defaults.background,
    ink: null,
    cardFit: null,
    surface: defaults.background,
    shadow: null,
    outline: null,
    overMedia: false,
    align: "left",
    valign: "top",
    font: defaults.font,
    text: defaults.text,
    muted: defaults.muted,
    brand: defaults.brand,
    root: pageRoot(canvas.width, canvas.height),
    viewing: defaults.viewing,
    enter: null,
    motion: defaults.motion,
    media,
    blocks,
  };
}

function logoLayer(canvas: { width: number; height: number }, defaults: PageDefaults, order: number): LayerSpec {
  const logo = defaults.logo!;
  const w = LOGO_MAX.width;
  const h = LOGO_MAX.height;
  const x = logo.corner.endsWith("right") ? canvas.width - w - LOGO_INSET : LOGO_INSET;
  const y = logo.corner.startsWith("bottom") ? canvas.height - h - LOGO_INSET : LOGO_INSET;
  return {
    id: "logo",
    region: "logo",
    z: 1000,
    order,
    x,
    y,
    w,
    h,
    pad: 0,
    fill: null,
    ink: null,
    cardFit: null,
    surface: defaults.background,
    shadow: null,
    outline: null,
    overMedia: Boolean(defaults.image || defaults.video),
    align: "left",
    valign: "top",
    font: defaults.font,
    text: defaults.text,
    muted: defaults.muted,
    brand: defaults.brand,
    root: pageRoot(canvas.width, canvas.height),
    viewing: defaults.viewing,
    enter: null,
    motion: null,
    media: { type: "image", src: logo.src },
    blocks: [{ role: "image", src: logo.src }],
    logoCorner: logo.corner,
  };
}

function parseLeaf(body: Record<string, unknown>, canvas: { width: number; height: number }, defaults: PageDefaults, path: string): LayerSpec[] {
  const extra = Object.keys(body).filter((key) => !LEAF_PAGE_KEYS.has(key) && !PAGE_META.has(key));
  if (extra.length) fail(extra.map((key) => unknownHint(key, `${path} unknown key `)).join("; "));
  const background = body.background == null ? defaults.background : hex(body.background, `${path}.background`);
  const textColor = body.text == null ? defaults.text : hex(body.text, `${path}.text`);
  const brand = body.brand == null ? defaults.brand : hex(body.brand, `${path}.brand`);
  const viewing = body.viewing == null ? defaults.viewing : parseViewingValue(body.viewing, `${path}.viewing`);
  const local: PageDefaults = {
    ...defaults,
    font: body.font == null ? defaults.font : str(body.font, `${path}.font`),
    background,
    text: textColor,
    brand,
    muted: mixHex(textColor, background, 0.38),
    image: body.image == null ? defaults.image : str(body.image, `${path}.image`),
    video: body.video == null ? defaults.video : str(body.video, `${path}.video`),
    motion: body.motion == null ? defaults.motion : parseMotion(body.motion, `${path}.motion`),
    viewing,
    logo: body.logo == null ? defaults.logo : parseLogo(body.logo, `${path}.logo`),
  };
  const layers = [backgroundLayer(canvas, local)];
  let order = 1;
  for (const name of REGIONS) {
    if (body[name] == null) continue;
    layers.push(parseRegion(name, body[name], canvas, order, local));
    order += 1;
  }
  if (local.logo) {
    layers.push(logoLayer(canvas, local, order));
  }
  if (layers.length === 1 && !local.video && !local.image) fail(`${path} needs a region (left, right, fullpage, …). Run compose catalog.`);
  return layers;
}

function parseViewingValue(value: unknown, path: string): ViewingDistance {
  if (typeof value !== "string" || !(VIEWING_DISTANCES as readonly string[]).includes(value)) {
    fail(`${path} must be ${VIEWING_DISTANCES.join("|")}`);
  }
  return parseViewing(value);
}

function rootOf(data: Record<string, unknown>): Record<string, unknown> {
  if (data.page == null) return data;
  if (!isTable(data.page)) fail("page must be an object");
  const merged = { ...data, ...data.page };
  delete merged.page;
  return merged;
}

function rejectOldLanguage(data: Record<string, unknown>, path: string): void {
  if (data.type === "Frame" || typeof data.recipe === "string" || (typeof data.type === "string" && Array.isArray(data.children))) {
    fail(`${path} uses the old Frame/recipe language. Write a page with regions (fullpage, left, right, …). Run compose catalog.`);
  }
  const old = Object.keys(data).filter((key) => OLD_LANGUAGE_KEYS.has(key));
  if (old.length) {
    fail(`${path} unknown key ${old[0]}; ${PAGE_RENAMES[old[0]!] ?? "the Frame language is removed"}. Run compose catalog.`);
  }
}

export function parseComposeSpec(source: unknown): ComposeDocument {
  let data: unknown = source;
  if (typeof source === "string") {
    try {
      data = JSON.parse(source);
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid JSON");
    }
  }
  if (!isTable(data)) fail("compose spec must be a JSON object. Run compose catalog.");
  rejectOldLanguage(data, "spec");
  const root = rootOf(data);
  rejectOldLanguage(root, "page");
  if (isTable(root.background)) {
    fail("background is a page color, not a region. Set image or video on the page: \"image\": \"./still.jpg\"");
  }
  const extra = Object.keys(root).filter((key) => !PAGE_META.has(key) && !(REGIONS as readonly string[]).includes(key));
  if (extra.length) fail(extra.map((key) => unknownHint(key, "unknown key ")).join("; "));
  const width = root.width == null ? 1920 : int(root.width, "width", 1, 8192);
  const height = root.height == null ? 1080 : int(root.height, "height", 1, 8192);
  if (width * height > 33_554_432) fail("canvas is too large");
  const canvas = { width, height };
  const background = root.background == null ? "#1C1410" : hex(root.background, "background");
  const text = root.text == null ? "#F3E6D0" : hex(root.text, "text");
  const brand = root.brand == null ? "#C9A227" : hex(root.brand, "brand");
  const viewing = root.viewing == null ? "mid" : parseViewingValue(root.viewing, "viewing");
  const defaults: PageDefaults = {
    font: root.font == null ? null : str(root.font, "font"),
    background,
    brand,
    text,
    muted: mixHex(text, background, 0.38),
    image: root.image == null ? null : str(root.image, "image"),
    video: root.video == null ? null : str(root.video, "video"),
    motion: root.motion == null ? null : parseMotion(root.motion, "motion"),
    viewing,
    logo: root.logo == null ? null : parseLogo(root.logo, "logo"),
  };
  if (root.pages != null) {
    const regionAtRoot = REGIONS.filter((name) => root[name] != null);
    if (regionAtRoot.length) fail(`pages cannot mix with root regions (${regionAtRoot.join(", ")}); put regions on each page`);
    if (!Array.isArray(root.pages) || root.pages.length < 1) fail("pages must be a nonempty array");
    const seen = new Set<string>();
    const pages = root.pages.map((page, i) => {
      const path = `pages[${i}]`;
      if (!isTable(page)) fail(`${path} must be an object`);
      rejectOldLanguage(page, path);
      if (isTable(page.spec) || "spec" in page) fail(`${path} unknown key spec; put regions on the page object. Run compose catalog.`);
      const id = page.id == null ? `page-${i + 1}` : str(page.id, `${path}.id`);
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) fail(`${path}.id must be letters, digits, _ or -`);
      if (seen.has(id)) fail(`duplicate page id ${id}`);
      seen.add(id);
      return { id, layers: parseLeaf(page, canvas, defaults, path) };
    });
    return { canvas, name: root.name == null ? null : str(root.name, "name"), viewing, pages };
  }
  return {
    canvas,
    name: root.name == null ? null : str(root.name, "name"),
    viewing,
    pages: [{ id: "page", layers: parseLeaf(root, canvas, defaults, "page") }],
  };
}
