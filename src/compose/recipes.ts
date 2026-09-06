import { isThemeName, THEME_NAMES, THEMES } from "./tokens.js";
import type { ComposeFrame, ComposeNode, LinearGradient, ThemeName, ViewingDistance } from "./types.js";

export const RECIPE_NAMES = [
  "title", "split-image", "cards", "table", "overlay",
  "hero", "price-list", "menu-board", "promo", "event", "quote", "schedule",
] as const;
export type RecipeName = typeof RECIPE_NAMES[number];
export const SIGNAGE_RECIPES = ["hero", "price-list", "menu-board", "promo", "event", "quote", "schedule"] as const;
export type SignageRecipe = typeof SIGNAGE_RECIPES[number];
export const RECIPE_VARIANTS = ["a", "b", "c"] as const;
export type RecipeVariant = typeof RECIPE_VARIANTS[number];
export const RECIPE_GUIDANCE = "Alternate variants or recipes on adjacent pages; a deck that repeats one layout reads as a slideshow, not signage.";

export interface RecipeWarning { code: string; message: string }
export interface RecipeCatalogEntry {
  fields: string[];
  variants?: readonly RecipeVariant[];
  example: unknown;
  description?: string;
}

export const RECIPE_WORD_BUDGET: Record<SignageRecipe, number> = {
  hero: 28,
  "price-list": 90,
  "menu-board": 110,
  promo: 36,
  event: 30,
  quote: 45,
  schedule: 70,
};

const COMMON = ["recipe", "width", "height", "fontFamily", "background", "color", "accent", "surface", "theme", "viewing", "subtitle", "footnote"];
const SPECIFIC: Record<RecipeName, string[]> = {
  title: ["title", "body"],
  "split-image": ["title", "body", "image", "objectFit"],
  cards: ["title", "cards"],
  table: ["title", "headers", "rows", "columnWeights"],
  overlay: ["title", "body", "image", "objectFit"],
  hero: ["headline", "subhead", "image", "callout", "objectFit", "variant"],
  "price-list": ["title", "rows", "variant"],
  "menu-board": ["title", "image", "sections", "objectFit", "variant"],
  promo: ["headline", "price", "image", "finePrint", "objectFit", "variant"],
  event: ["date", "title", "venue", "image", "objectFit", "variant"],
  quote: ["quotation", "attribution", "image", "objectFit", "variant"],
  schedule: ["title", "rows", "variant"],
};

function fail(message: string): never { throw Object.assign(new Error(message), { code: "usage_error" }); }
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`recipe.${field} must be nonempty text`);
  return value;
}
function oneLine(value: unknown, field: string): string {
  const s = text(value, field);
  if (/[\n\r]/.test(s)) fail(`recipe.${field} must be one line`);
  return s;
}
function optional(value: unknown, field: string, line = false): string | undefined {
  if (value === undefined) return undefined;
  return line ? oneLine(value, field) : text(value, field);
}
function words(...parts: Array<string | undefined>): number {
  let n = 0;
  for (const part of parts) {
    if (!part) continue;
    const bits = part.trim().split(/\s+/);
    if (bits[0]) n += bits.length;
  }
  return n;
}
function density(recipe: SignageRecipe, count: number, warnings: RecipeWarning[]): void {
  const budget = RECIPE_WORD_BUDGET[recipe];
  if (count > budget) {
    warnings.push({
      code: "too_dense",
      message: `recipe.${recipe} exceeds its word budget (${count} > ${budget}). Shorten the copy or split this page.`,
    });
  }
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`recipe.${field} must be an object`);
  return value as Record<string, unknown>;
}
function onlyKeys(obj: Record<string, unknown>, allowed: string[], field: string): void {
  const extra = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`recipe.${field} contains unsupported fields: ${extra.join(", ")}`);
}
function variantOf(value: Record<string, unknown>): RecipeVariant {
  if (value.variant === undefined) return "a";
  if (value.variant === "a" || value.variant === "b" || value.variant === "c") return value.variant;
  fail('recipe.variant must be a|b|c');
}
function photo(value: Record<string, unknown>, fallback: "contain" | "cover" = "cover"): ComposeNode {
  if (value.objectFit !== undefined && value.objectFit !== "contain" && value.objectFit !== "cover") {
    fail("recipe.objectFit must be contain or cover; recipes preserve image aspect ratio");
  }
  return { type: "Image", src: text(value.image, "image"), flex: 1, objectFit: (value.objectFit ?? fallback) as "contain" | "cover" };
}

interface Palette {
  themed: boolean;
  theme?: ThemeName;
  ink: string;
  muted: string;
  accent: string;
  surface: string;
  background: string;
  accentInk: string;
}

function hexColor(value: Record<string, unknown>, field: string, fallback: string): string {
  if (value[field] === undefined) return fallback;
  if (typeof value[field] !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value[field] as string)) {
    fail(`recipe.${field} must be a hex color`);
  }
  return value[field] as string;
}

function paletteOf(value: Record<string, unknown>): Palette {
  const themed = value.theme !== undefined;
  if (themed && (typeof value.theme !== "string" || !isThemeName(value.theme))) {
    fail(`recipe.theme must be ${THEME_NAMES.join("|")}`);
  }
  const theme = themed ? value.theme as ThemeName : undefined;
  return {
    themed,
    theme,
    ink: value.color !== undefined ? hexColor(value, "color", "#F7F7F2") : themed ? "ink" : "#F7F7F2",
    muted: themed ? "inkMuted" : "#A8B2B9",
    accent: value.accent !== undefined ? hexColor(value, "accent", "#FFC857") : themed ? "accent" : "#FFC857",
    surface: value.surface !== undefined ? hexColor(value, "surface", "#101820") : themed ? "surface" : "#101820",
    background: value.background !== undefined ? hexColor(value, "background", "#1B2632") : themed ? "background" : "#1B2632",
    accentInk: themed ? "accentInk" : "#1B2632",
  };
}

function viewingOfRecipe(value: Record<string, unknown>): ViewingDistance | undefined {
  if (value.viewing === undefined) return undefined;
  if (value.viewing === "near" || value.viewing === "mid" || value.viewing === "far") return value.viewing;
  fail('recipe.viewing must be near|mid|far');
}

function frameOf(value: Record<string, unknown>, width: number, height: number, palette: Palette): ComposeFrame {
  const frame: ComposeFrame = { type: "Frame", width, height, children: [] };
  if (palette.theme) frame.theme = palette.theme;
  if (value.background !== undefined || !palette.themed) frame.background = palette.background;
  if (value.fontFamily !== undefined) frame.fontFamily = text(value.fontFamily, "fontFamily");
  const viewing = viewingOfRecipe(value);
  if (viewing) frame.viewing = viewing;
  return frame;
}

function stage(width: number, height: number, children: ComposeNode[], extra: Partial<ComposeNode> = {}): ComposeNode {
  return { type: "Column", width: width * 0.84, height: height * 0.84, gap: "l", ...extra, children };
}

function applyStage(frame: ComposeFrame, children: ComposeNode[], extra: Partial<ComposeNode> = {}): ComposeFrame {
  frame.padding = undefined;
  frame.gap = undefined;
  frame.align = "center";
  frame.justify = "center";
  frame.children = [stage(frame.width, frame.height, children, extra)];
  return frame;
}

function txt(role: ComposeNode["role"], copy: string, color: string, extra: Partial<ComposeNode> = {}): ComposeNode {
  return { type: "Text", role, text: copy, color, ...extra };
}
function pill(label: string, palette: Palette): ComposeNode {
  return { type: "Pill", text: label, role: "label", color: palette.accentInk, background: palette.accent };
}
function pillRow(label: string, palette: Palette): ComposeNode {
  return { type: "Row", children: [pill(label, palette)] };
}
function dottedLeader(palette: Palette): ComposeNode {
  return { type: "Divider", flex: 1, thickness: 2, color: palette.muted, style: "dotted" };
}
function paintHex(palette: Palette, token: "surface" | "background"): string {
  if (palette.themed && palette.theme) return THEMES[palette.theme][token];
  const value = token === "surface" ? palette.surface : palette.background;
  return value.startsWith("#") ? value : token === "surface" ? "#101820" : "#1B2632";
}
function withAlphaByte(hex: string, byte: number): string {
  const raw = hex.replace("#", "");
  const rgb = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw.slice(0, 6);
  return `#${rgb}${byte.toString(16).padStart(2, "0")}`;
}
function rowWash(palette: Palette): string {
  return withAlphaByte(paintHex(palette, "surface"), 0x0f);
}
function trackingOf(width: number): number {
  return Math.max(2, Math.round(width * 0.002));
}
function headerLabel(copy: string, palette: Palette, tracking: number): ComposeNode {
  return txt("label", copy.toUpperCase(), palette.ink, { letterSpacing: tracking });
}
function accentRule(width: number, palette: Palette): ComposeNode {
  return { type: "Divider", thickness: 4, color: palette.accent, length: Math.max(48, Math.round(width * 0.12)) };
}
function titleBlock(heading: string, palette: Palette, opts: {
  width: number;
  subtitle?: string;
  accentRule?: boolean;
  role?: ComposeNode["role"];
  plate?: ComposeNode["plate"];
}): ComposeNode {
  const extra: Partial<ComposeNode> = {};
  if (opts.plate) extra.plate = opts.plate;
  const children: ComposeNode[] = [txt(opts.role ?? "title", heading, palette.ink, extra)];
  if (opts.subtitle) children.push(txt("caption", opts.subtitle, palette.muted, extra));
  if (opts.accentRule !== false) children.push(accentRule(opts.width, palette));
  return { type: "Column", gap: "s", children };
}
function slot(child: ComposeNode, wash?: string): ComposeNode {
  const box: ComposeNode = { type: "Box", justify: "center", children: [child] };
  if (wash) box.background = wash;
  return box;
}
function fadePlate(palette: Palette, angle: number): LinearGradient {
  return {
    type: "linear",
    angle,
    stops: [
      { at: 0, color: "#00000000" },
      { at: 0.4, color: palette.background },
      { at: 1, color: palette.background },
    ],
  };
}
function insetRow(width: number, height: number, children: ComposeNode[]): ComposeNode {
  return {
    type: "Column",
    flex: 1,
    children: [
      { type: "Spacer", height: height * 0.08 },
      { type: "Row", flex: 1, children: [{ type: "Spacer", width: width * 0.08 }, ...children, { type: "Spacer", width: width * 0.08 }] },
      { type: "Spacer", height: height * 0.08 },
    ],
  };
}

interface PriceRow { name: string; description?: string; price: string }
interface MenuItem { name: string; description?: string; price?: string }
interface MenuSection { heading: string; items: MenuItem[] }
interface ScheduleRow { time: string; item: string; note?: string }

function parsePriceRows(value: unknown): PriceRow[] {
  if (!Array.isArray(value) || value.length < 6 || value.length > 14) fail("recipe.rows must contain 6 to 14 {name,price} objects");
  return value.map((entry, index) => {
    const row = record(entry, `rows[${index}]`);
    onlyKeys(row, ["name", "description", "price"], `rows[${index}]`);
    return {
      name: oneLine(row.name, `rows[${index}].name`),
      description: optional(row.description, `rows[${index}].description`),
      price: oneLine(row.price, `rows[${index}].price`),
    };
  });
}

function parseMenuSections(value: unknown): MenuSection[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) fail("recipe.sections must contain 2 to 3 {heading,items} objects");
  return value.map((entry, index) => {
    const section = record(entry, `sections[${index}]`);
    onlyKeys(section, ["heading", "items"], `sections[${index}]`);
    if (!Array.isArray(section.items) || section.items.length < 1 || section.items.length > 10) {
      fail(`recipe.sections[${index}].items must contain 1 to 10 {name} objects`);
    }
    return {
      heading: oneLine(section.heading, `sections[${index}].heading`),
      items: section.items.map((item, j) => {
        const row = record(item, `sections[${index}].items[${j}]`);
        onlyKeys(row, ["name", "description", "price"], `sections[${index}].items[${j}]`);
        return {
          name: oneLine(row.name, `sections[${index}].items[${j}].name`),
          description: optional(row.description, `sections[${index}].items[${j}].description`),
          price: optional(row.price, `sections[${index}].items[${j}].price`, true),
        };
      }),
    };
  });
}

function parseScheduleRows(value: unknown): ScheduleRow[] {
  if (!Array.isArray(value) || value.length < 4 || value.length > 10) fail("recipe.rows must contain 4 to 10 {time,item} objects");
  return value.map((entry, index) => {
    const row = record(entry, `rows[${index}]`);
    onlyKeys(row, ["time", "item", "note"], `rows[${index}]`);
    return {
      time: oneLine(row.time, `rows[${index}].time`),
      item: text(row.item, `rows[${index}].item`),
      note: optional(row.note, `rows[${index}].note`),
    };
  });
}

function priceLine(row: PriceRow, palette: Palette, priceWidth: number): ComposeNode {
  const line: ComposeNode = {
    type: "Row",
    align: "center",
    gap: "s",
    children: [
      txt("body", row.name, palette.ink),
      dottedLeader(palette),
      { type: "Box", width: priceWidth, align: "end" as const, children: [txt("label", row.price, palette.ink, { align: "right" })] },
    ],
  };
  if (!row.description) return line;
  return { type: "Column", gap: "xs", children: [line, txt("caption", row.description, palette.muted)] };
}

function listCard(rows: ComposeNode[], wash?: Array<string | undefined>, header?: ComposeNode): ComposeNode {
  const list: ComposeNode = {
    type: "Column",
    flex: 1,
    justify: "space-between",
    children: rows.map((row, index) => slot(row, wash?.[index])),
  };
  return {
    type: "Box",
    flex: 1,
    padding: "m",
    children: [header ? { type: "Column", flex: 1, gap: "m", children: [header, list] } : list],
  };
}

function distributedRows(rows: ComposeNode[], wash?: Array<string | undefined>): ComposeNode {
  return listCard(rows, wash);
}

function priceColumn(rows: PriceRow[], palette: Palette, priceWidth: number): ComposeNode {
  const stripes = rows.length > 8 ? rows.map((_, i) => (i % 2 === 1 ? rowWash(palette) : undefined)) : undefined;
  return distributedRows(rows.map((row) => priceLine(row, palette, priceWidth)), stripes);
}

function menuItemLine(item: MenuItem, palette: Palette, priceWidth: number): ComposeNode {
  const line: ComposeNode = {
    type: "Row",
    align: "center",
    gap: "s",
    children: [
      txt("body", item.name, palette.ink),
      ...(item.price ? [
        dottedLeader(palette),
        { type: "Box", width: priceWidth, align: "end" as const, children: [txt("label", item.price, palette.ink, { align: "right" })] },
      ] : []),
    ],
  };
  if (!item.description) return line;
  return { type: "Column", gap: "xs", children: [line, txt("caption", item.description, palette.muted)] };
}

function sectionHeading(heading: string, palette: Palette, treatment: "label" | "rule", tracking: number): ComposeNode {
  const label = headerLabel(heading, palette, tracking);
  if (treatment === "rule") {
    return { type: "Column", gap: "xs", children: [label, { type: "Divider", thickness: 2, color: palette.muted }] };
  }
  return label;
}

function sectionColumn(section: MenuSection, palette: Palette, treatment: "label" | "rule", tracking: number, priceWidth: number): ComposeNode {
  const wash = section.items.length > 8 ? section.items.map((_, i) => (i % 2 === 1 ? rowWash(palette) : undefined)) : undefined;
  return {
    type: "Column",
    flex: 1,
    gap: "m",
    children: [
      sectionHeading(section.heading, palette, treatment, tracking),
      distributedRows(section.items.map((item) => menuItemLine(item, palette, priceWidth)), wash),
    ],
  };
}

function scheduleLine(row: ScheduleRow, palette: Palette, timeWidth: number): ComposeNode {
  const copy: ComposeNode[] = [txt("body", row.item, palette.ink)];
  if (row.note) copy.push(txt("caption", row.note, palette.muted));
  return {
    type: "Row",
    gap: "l",
    align: "center",
    children: [
      { type: "Box", width: timeWidth, children: [txt("label", row.time, palette.ink)] },
      { type: "Column", flex: 1, gap: "xs", children: copy },
    ],
  };
}

function scheduleHeader(palette: Palette, timeWidth: number, tracking: number): ComposeNode {
  return {
    type: "Row",
    gap: "l",
    children: [
      { type: "Box", width: timeWidth, background: "#00000000", children: [headerLabel("Time", palette, tracking)] },
      { type: "Box", flex: 1, background: "#00000000", children: [headerLabel("Programme", palette, tracking)] },
    ],
  };
}

function chromeOf(value: Record<string, unknown>): { subtitle?: string; footnote?: string } {
  return {
    subtitle: optional(value.subtitle, "subtitle"),
    footnote: optional(value.footnote, "footnote", true),
  };
}

function withFootnote(children: ComposeNode[], footnote: string | undefined, palette: Palette, extra: Partial<ComposeNode> = {}): ComposeNode[] {
  if (!footnote) return children;
  return [...children, txt("caption", footnote, palette.muted, extra)];
}

function expandHero(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const headline = text(value.headline, "headline");
  const subhead = oneLine(value.subhead, "subhead");
  const callout = optional(value.callout, "callout", true);
  const { subtitle, footnote } = chromeOf(value);
  const picture = photo(value);
  const copy: ComposeNode[] = [txt("display", headline, palette.ink, { plate: "auto" })];
  if (subtitle) copy.push(txt("caption", subtitle, palette.muted, { plate: "auto" }));
  if (!callout) copy.push(accentRule(frame.width, palette));
  copy.push(txt("body", subhead, palette.muted, { plate: "auto" }));
  if (callout) copy.push(pillRow(callout, palette));
  if (footnote) copy.push(txt("caption", footnote, palette.muted, { plate: "auto" }));
  const { width, height } = frame;
  if (variant === "a") {
    frame.padding = undefined;
    frame.gap = undefined;
    frame.children = [
      picture,
      {
        type: "Box",
        pin: "bottom",
        height: height * 0.5,
        background: fadePlate(palette, 180),
        children: [insetRow(width, height, [{ type: "Column", flex: 1, gap: "m", justify: "end", children: copy }])],
      },
    ];
    return frame;
  }
  if (variant === "b") {
    frame.padding = undefined;
    frame.gap = undefined;
    frame.children = [
      picture,
      {
        type: "Box",
        pin: "top",
        height,
        background: "#00000000",
        align: "center",
        justify: "center",
        children: [{
          type: "Box",
          width: width * 0.56,
          padding: "xl",
          gap: "m",
          background: palette.surface,
          radius: "m",
          align: "center",
          justify: "center",
          children: copy.map((node) => node.type === "Text" ? { ...node, align: "center" } : node),
        }],
      },
    ];
    return frame;
  }
  frame.padding = undefined;
  frame.gap = undefined;
  frame.children = [{
    type: "Row",
    flex: 1,
    children: [
      { type: "Box", flex: 3, children: [picture] },
      {
        type: "Column",
        flex: 2,
        justify: "center",
        background: palette.surface,
        children: [insetRow(width, height, [{ type: "Column", flex: 1, gap: "m", justify: "center", children: copy }])],
      },
    ],
  }];
  return frame;
}

function expandPriceList(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const title = text(value.title, "title");
  const rows = parsePriceRows(value.rows);
  const { subtitle, footnote } = chromeOf(value);
  const { width } = frame;
  const featuredAccent = variant === "c";
  const heading = titleBlock(title, palette, { width, subtitle, accentRule: !featuredAccent });
  if (variant === "b") {
    const mid = Math.ceil(rows.length / 2);
    return applyStage(frame, withFootnote([heading, {
      type: "Row",
      flex: 1,
      gap: "xl",
      children: [priceColumn(rows.slice(0, mid), palette, width * 0.1), priceColumn(rows.slice(mid), palette, width * 0.1)],
    }], footnote, palette));
  }
  if (variant === "c") {
    const featured = rows[0]!;
    const rest = rows.slice(1);
    const featuredCopy: ComposeNode[] = [
      txt("caption", "Featured", palette.muted),
      txt("title", featured.name, palette.ink),
    ];
    if (featured.description) featuredCopy.push(txt("body", featured.description, palette.muted));
    featuredCopy.push(txt("title", featured.price, palette.accent));
    return applyStage(frame, withFootnote([
      heading,
      {
        type: "Row",
        flex: 1,
        gap: "xl",
        children: [
          { type: "Box", flex: 1, padding: "l", gap: "m", background: palette.surface, radius: "m", justify: "center", children: featuredCopy },
          priceColumn(rest, palette, width * 0.1),
        ],
      },
    ], footnote, palette));
  }
  return applyStage(frame, withFootnote([heading, priceColumn(rows, palette, width * 0.14)], footnote, palette));
}

function expandMenuBoard(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const title = optional(value.title, "title");
  const sections = parseMenuSections(value.sections);
  const { subtitle, footnote } = chromeOf(value);
  const picture = value.image === undefined ? undefined : photo(value);
  const treatment: "label" | "rule" = variant === "b" ? "rule" : "label";
  const { width, height } = frame;
  const tracking = trackingOf(width);
  const priceWidth = Math.max(72, Math.round(width * 0.055));
  const columns: ComposeNode = {
    type: "Row",
    flex: 1,
    gap: "xl",
    children: sections.map((section) => sectionColumn(section, palette, treatment, tracking, priceWidth)),
  };
  const heading = title ? [titleBlock(title, palette, { width, subtitle, accentRule: true, role: variant === "c" ? "title" : "display" })] : (subtitle ? [txt("caption", subtitle, palette.muted)] : []);
  if (!picture) return applyStage(frame, withFootnote([...heading, columns], footnote, palette));
  if (variant === "b") {
    return applyStage(frame, withFootnote([...heading, {
      type: "Row",
      flex: 1,
      gap: "xl",
      children: [columns, { type: "Box", flex: 1, radius: "m", children: [picture] }],
    }], footnote, palette));
  }
  if (variant === "c") {
    return applyStage(frame, withFootnote([
      { type: "Box", height: height * 0.16, radius: "m", children: [picture] },
      ...heading,
      columns,
    ], footnote, palette), { gap: "s" });
  }
  return applyStage(frame, withFootnote([...heading, {
    type: "Row",
    flex: 1,
    gap: "xl",
    children: [{ type: "Box", width: width * 0.28, radius: "m", children: [picture] }, columns],
  }], footnote, palette));
}

function expandPromo(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const headline = text(value.headline, "headline");
  const price = oneLine(value.price, "price");
  const fine = optional(value.finePrint, "finePrint");
  const { subtitle, footnote } = chromeOf(value);
  const picture = photo(value);
  const badge = pill(price, palette);
  const copy: ComposeNode[] = [txt("display", headline, palette.ink, { plate: "auto" })];
  if (subtitle) copy.push(txt("caption", subtitle, palette.muted, { plate: "auto" }));
  copy.push({ type: "Row", children: [badge] });
  if (fine) copy.push(txt("caption", fine, palette.muted, { plate: "auto" }));
  if (footnote) copy.push(txt("caption", footnote, palette.muted, { plate: "auto" }));
  const { width, height } = frame;
  if (variant === "a") {
    frame.padding = undefined;
    frame.gap = undefined;
    frame.children = [
      picture,
      {
        type: "Box",
        pin: "top",
        height: height * 0.22,
        background: "#00000000",
        children: [insetRow(width, height, [{ type: "Row", flex: 1, justify: "end", align: "start", children: [badge] }])],
      },
      {
        type: "Box",
        pin: "bottom",
        height: height * 0.42,
        background: fadePlate(palette, 180),
        children: [insetRow(width, height, [{
          type: "Column",
          flex: 1,
          gap: "m",
          justify: "end",
          children: [
            txt("display", headline, palette.ink, { plate: "auto" }),
            ...(subtitle ? [txt("caption", subtitle, palette.muted, { plate: "auto" })] : []),
            ...(fine ? [txt("caption", fine, palette.muted, { plate: "auto" })] : []),
            ...(footnote ? [txt("caption", footnote, palette.muted, { plate: "auto" })] : []),
          ],
        }])],
      },
    ];
    return frame;
  }
  if (variant === "b") {
    frame.padding = undefined;
    frame.gap = undefined;
    frame.children = [
      picture,
      {
        type: "Box",
        pin: "right",
        width: width * 0.55,
        background: fadePlate(palette, 135),
        children: [insetRow(width, height, [{ type: "Column", flex: 1, gap: "m", justify: "center", children: copy }])],
      },
    ];
    return frame;
  }
  frame.padding = undefined;
  frame.gap = undefined;
  frame.children = [{
    type: "Row",
    flex: 1,
    children: [
      { type: "Box", flex: 1, children: [picture] },
      {
        type: "Column",
        flex: 1,
        justify: "center",
        background: palette.surface,
        children: [insetRow(width, height, [{ type: "Column", flex: 1, gap: "m", justify: "center", children: copy }])],
      },
    ],
  }];
  return frame;
}

function expandEvent(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const date = oneLine(value.date, "date");
  const title = text(value.title, "title");
  const venue = oneLine(value.venue, "venue");
  const { subtitle, footnote } = chromeOf(value);
  const picture = value.image === undefined ? undefined : photo(value);
  const dateBlock: ComposeNode = {
    type: "Box",
    padding: "l",
    background: palette.surface,
    radius: "s",
    justify: "center",
    children: [txt("display", date, palette.accent, { align: "center" })],
  };
  const details: ComposeNode[] = [txt("title", title, palette.ink)];
  if (subtitle) details.push(txt("caption", subtitle, palette.muted));
  details.push(txt("body", venue, palette.muted));
  if (variant === "b") {
    const stub: ComposeNode[] = [
      dateBlock,
      { type: "Divider", thickness: 4, color: palette.muted },
      { type: "Column", flex: 1, gap: "m", justify: "center", children: details },
    ];
    if (picture) stub.push({ type: "Box", flex: 1, radius: "s", children: [picture] });
    return applyStage(frame, withFootnote([{ type: "Row", flex: 1, gap: "l", align: "stretch", children: stub }], footnote, palette));
  }
  if (variant === "c") {
    const band: ComposeNode[] = [
      { type: "Column", flex: 1, gap: "m", justify: "center", children: [dateBlock, ...details] },
    ];
    if (picture) band.push({ type: "Box", flex: 1, radius: "s", children: [picture] });
    return applyStage(frame, withFootnote([{ type: "Row", flex: 1, gap: "xl", align: "center", children: band }], footnote, palette));
  }
  const poster: ComposeNode[] = [];
  if (picture) poster.push({ type: "Box", flex: 1, radius: "m", children: [picture] });
  poster.push({ type: "Row", gap: "l", align: "center", children: [dateBlock, { type: "Column", flex: 1, gap: "s", children: details }] });
  return applyStage(frame, withFootnote(poster, footnote, palette), { justify: picture ? "start" : "center" });
}

function expandQuote(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const quotation = text(value.quotation, "quotation");
  const attribution = oneLine(value.attribution, "attribution");
  const { subtitle, footnote } = chromeOf(value);
  if (variant === "c" && value.image === undefined) fail("recipe.quote variant c requires image");
  const quoteText = txt("display", quotation, palette.ink, { plate: "auto" });
  const by = txt("caption", attribution, palette.muted, { plate: "auto" });
  const kicker = subtitle ? [txt("caption", subtitle, palette.muted, { plate: "auto" })] : [];
  const note = footnote ? [txt("caption", footnote, palette.muted, { plate: "auto" })] : [];
  if (variant === "b") {
    return applyStage(frame, [{
      type: "Row",
      flex: 1,
      gap: "l",
      align: "stretch",
      children: [
        { type: "Divider", thickness: 8, color: palette.accent },
        { type: "Column", flex: 1, gap: "l", justify: "center", children: [...kicker, quoteText, by, ...note] },
      ],
    }]);
  }
  if (variant === "c") {
    const { width, height } = frame;
    frame.padding = undefined;
    frame.gap = undefined;
    frame.children = [
      photo(value),
      {
        type: "Box",
        pin: "top",
        height,
        background: "#00000000",
        align: "center",
        justify: "center",
        children: [{
          type: "Box",
          width: width * 0.7,
          padding: "xl",
          gap: "l",
          background: palette.surface,
          radius: "m",
          align: "center",
          children: [
            ...kicker.map((node) => ({ ...node, align: "center" as const })),
            txt("display", quotation, palette.ink, { align: "center", plate: "auto" }),
            accentRule(width, palette),
            txt("caption", attribution, palette.muted, { align: "center", plate: "auto" }),
            ...note.map((node) => ({ ...node, align: "center" as const })),
          ],
        }],
      },
    ];
    return frame;
  }
  return applyStage(frame, [...kicker, txt("display", quotation, palette.ink, { align: "center", plate: "auto" }), { type: "Divider", thickness: 4, length: frame.width * 0.2, color: palette.accent }, txt("caption", attribution, palette.muted, { align: "center", plate: "auto" }), ...note], {
    align: "center",
    justify: "center",
  });
}

function expandSchedule(value: Record<string, unknown>, frame: ComposeFrame, palette: Palette, variant: RecipeVariant): ComposeFrame {
  const title = text(value.title, "title");
  const rows = parseScheduleRows(value.rows);
  const { subtitle, footnote } = chromeOf(value);
  const { width } = frame;
  const timeWidth = width * 0.14;
  const tracking = trackingOf(width);
  const heading = titleBlock(title, palette, { width, subtitle, accentRule: variant !== "c" });
  const wash = rows.length > 8 ? rows.map((_, i) => (i % 2 === 1 ? rowWash(palette) : undefined)) : undefined;
  if (variant === "b") {
    const mid = Math.ceil(rows.length / 2);
    const col = (slice: ScheduleRow[]): ComposeNode => listCard(
      slice.map((row) => scheduleLine(row, palette, timeWidth * 0.7)),
      undefined,
      scheduleHeader(palette, timeWidth * 0.7, tracking),
    );
    return applyStage(frame, withFootnote([heading, { type: "Row", flex: 1, gap: "xl", children: [col(rows.slice(0, mid)), col(rows.slice(mid))] }], footnote, palette));
  }
  if (variant === "c") {
    return applyStage(frame, withFootnote([heading, {
      type: "Row",
      flex: 1,
      gap: "l",
      children: [
        {
          type: "Column",
          width: timeWidth,
          children: [
            headerLabel("Time", palette, tracking),
            distributedRows(rows.map((row) => txt("label", row.time, palette.ink))),
          ],
        },
        { type: "Divider", thickness: 4, color: palette.accent },
        {
          type: "Column",
          flex: 1,
          children: [
            headerLabel("Programme", palette, tracking),
            distributedRows(rows.map((row) => {
              const copy: ComposeNode[] = [txt("body", row.item, palette.ink)];
              if (row.note) copy.push(txt("caption", row.note, palette.muted));
              return { type: "Column", gap: "xs", children: copy };
            })),
          ],
        },
      ],
    }], footnote, palette));
  }
  return applyStage(frame, withFootnote([
    heading,
    listCard(rows.map((row) => scheduleLine(row, palette, timeWidth)), wash, scheduleHeader(palette, timeWidth, tracking)),
  ], footnote, palette));
}

function countSignage(recipe: SignageRecipe, value: Record<string, unknown>): number {
  const chrome = [optional(value.subtitle, "subtitle"), optional(value.footnote, "footnote", true)];
  if (recipe === "hero") return words(optional(value.headline, "headline"), optional(value.subhead, "subhead", true), optional(value.callout, "callout", true), ...chrome);
  if (recipe === "promo") return words(optional(value.headline, "headline"), optional(value.price, "price", true), optional(value.finePrint, "finePrint"), ...chrome);
  if (recipe === "event") return words(optional(value.date, "date", true), optional(value.title, "title"), optional(value.venue, "venue", true), ...chrome);
  if (recipe === "quote") return words(optional(value.quotation, "quotation"), optional(value.attribution, "attribution", true), ...chrome);
  if (recipe === "price-list") {
    const rows = Array.isArray(value.rows) ? value.rows : [];
    return words(optional(value.title, "title"), ...chrome, ...rows.flatMap((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      return [optional(row.name, `rows[${i}].name`, true), optional(row.description, `rows[${i}].description`), optional(row.price, `rows[${i}].price`, true)];
    }));
  }
  if (recipe === "menu-board") {
    const sections = Array.isArray(value.sections) ? value.sections : [];
    return words(optional(value.title, "title"), ...chrome, ...sections.flatMap((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const section = entry as Record<string, unknown>;
      const items = Array.isArray(section.items) ? section.items : [];
      return [
        optional(section.heading, `sections[${i}].heading`, true),
        ...items.flatMap((item, j) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return [];
          const row = item as Record<string, unknown>;
          return [optional(row.name, `sections[${i}].items[${j}].name`, true), optional(row.description, `sections[${i}].items[${j}].description`), optional(row.price, `sections[${i}].items[${j}].price`, true)];
        }),
      ];
    }));
  }
  const rows = Array.isArray(value.rows) ? value.rows : [];
  return words(optional(value.title, "title"), ...chrome, ...rows.flatMap((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    return [optional(row.time, `rows[${i}].time`, true), optional(row.item, `rows[${i}].item`), optional(row.note, `rows[${i}].note`)];
  }));
}

function expandSignage(recipe: SignageRecipe, value: Record<string, unknown>, width: number, height: number, warnings: RecipeWarning[]): ComposeFrame {
  const variant = variantOf(value);
  const palette = paletteOf(value);
  const frame = frameOf(value, width, height, palette);
  density(recipe, countSignage(recipe, value), warnings);
  if (recipe === "hero") return expandHero(value, frame, palette, variant);
  if (recipe === "price-list") return expandPriceList(value, frame, palette, variant);
  if (recipe === "menu-board") return expandMenuBoard(value, frame, palette, variant);
  if (recipe === "promo") return expandPromo(value, frame, palette, variant);
  if (recipe === "event") return expandEvent(value, frame, palette, variant);
  if (recipe === "quote") return expandQuote(value, frame, palette, variant);
  return expandSchedule(value, frame, palette, variant);
}

/** Recipes expand to ordinary measured Text/Row/Column nodes, never SVG text. */
export function expandComposeRecipe(input: unknown, warnings: RecipeWarning[] = []): unknown {
  if (!input || typeof input !== "object" || !("recipe" in input)) return input;
  const value = input as Record<string, unknown>;
  const recipe = value.recipe as RecipeName;
  if (!RECIPE_NAMES.includes(recipe)) fail(`recipe must be ${RECIPE_NAMES.join("|")}`);
  const extras = Object.keys(value).filter((key) => !COMMON.includes(key) && !SPECIFIC[recipe].includes(key));
  if (extras.length) fail(`recipe contains unsupported fields: ${extras.join(", ")}`);
  const width = value.width === undefined ? 1920 : value.width;
  const height = value.height === undefined ? 1080 : value.height;
  if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) fail("recipe width and height must be positive numbers");
  if (SIGNAGE_RECIPES.includes(recipe as SignageRecipe)) return expandSignage(recipe as SignageRecipe, value, width, height, warnings);
  const color = (field: string, fallback: string): string => hexColor(value, field, fallback);
  const foreground = color("color", "#F7F7F2"), background = color("background", "#1B2632"), accent = color("accent", "#FFC857"), surface = color("surface", "#101820");
  const muted = value.theme !== undefined ? "inkMuted" : "#A8B2B9";
  const title: ComposeNode = { type: "Text", role: "title", text: text(value.title, "title"), color: foreground };
  const body = (): ComposeNode => ({ type: "Text", role: "body", text: text(value.body, "body"), color: foreground });
  const header: ComposeNode[] = [title];
  if (value.subtitle !== undefined) header.push({ type: "Text", role: "caption", text: text(value.subtitle, "subtitle"), color: muted });
  header.push({ type: "Divider", thickness: 4, color: accent, length: Math.max(48, Math.round(width * 0.12)) });
  const footnote = value.footnote === undefined ? [] : [{ type: "Text", role: "caption" as const, text: oneLine(value.footnote, "footnote"), color: muted }];
  const frame: ComposeFrame = { type: "Frame", width, height, background, padding: "xl", gap: "l", children: [] };
  if (value.theme !== undefined) {
    if (typeof value.theme !== "string" || !isThemeName(value.theme)) fail(`recipe.theme must be ${THEME_NAMES.join("|")}`);
    frame.theme = value.theme;
  }
  const viewing = viewingOfRecipe(value);
  if (viewing) frame.viewing = viewing;
  if (value.fontFamily !== undefined) frame.fontFamily = text(value.fontFamily, "fontFamily");
  const image = (): ComposeNode => {
    if (value.objectFit !== undefined && value.objectFit !== "contain" && value.objectFit !== "cover") fail("recipe.objectFit must be contain or cover; recipes preserve image aspect ratio");
    return { type: "Image", src: text(value.image, "image"), flex: 1, objectFit: (value.objectFit ?? "contain") as "contain" | "cover" };
  };
  if (recipe === "title") {
    frame.children = [{ type: "Column", flex: 1, justify: "center", gap: "l", children: [...header, body()] }];
  } else if (recipe === "split-image") {
    frame.children = [{ type: "Row", flex: 1, gap: "xl", children: [{ type: "Column", flex: 1, justify: "center", gap: "l", children: [...header, body()] }, { type: "Box", flex: 1, children: [image()] }] }];
  } else if (recipe === "overlay") {
    frame.padding = undefined;
    frame.background = "#00000000";
    frame.children = value.image === undefined ? [] : [image()];
    frame.children.push({ type: "Box", pin: "bottom", height: height * 0.46, background: value.surface === undefined ? "#101820E3" : surface, padding: "xl", gap: "m", children: [...header, body()] });
  } else if (recipe === "cards") {
    if (!Array.isArray(value.cards) || value.cards.length < 2 || value.cards.length > 4) fail("recipe.cards must contain 2 to 4 {title,body} objects");
    frame.children = [...header, { type: "Row", flex: 1, gap: "l", children: value.cards.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => key !== "title" && key !== "body")) fail(`recipe.cards[${index}] must contain only title and body`);
      return { type: "Box", flex: 1, padding: "l", background: surface, gap: "l", justify: "center", children: [
        { type: "Text", role: "title", color: foreground, text: text(entry.title, `cards[${index}].title`) },
        { type: "Text", role: "body", color: foreground, text: text(entry.body, `cards[${index}].body`) },
      ] };
    }) }];
  } else {
    if (!Array.isArray(value.headers) || value.headers.length < 2 || value.headers.length > 5) fail("recipe.headers must contain 2 to 5 column labels");
    const headers = value.headers.map((v, i) => text(v, `headers[${i}]`));
    if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 8) fail("recipe.rows must contain 1 to 8 rows");
    const rows = value.rows.map((row, i) => {
      if (!Array.isArray(row) || row.length !== headers.length) fail(`recipe.rows[${i}] must match the number of headers`);
      return row.map((v, j) => text(v, `rows[${i}][${j}]`));
    });
    const weights = value.columnWeights ?? headers.map(() => 1);
    if (!Array.isArray(weights) || weights.length !== headers.length || weights.some((w) => typeof w !== "number" || !Number.isFinite(w) || w <= 0)) fail("recipe.columnWeights must be positive numbers, one per header");
    const tracking = trackingOf(width);
    frame.children = [...header, { type: "Column", flex: 1, gap: "xs", children: [headers.map((cell) => cell.toUpperCase()), ...rows].map((row, i) => ({ type: "Row", flex: 1, gap: "xs", children: row.map((cell, j) => ({ type: "Box", flex: weights[j] as number, background: i === 0 || i % 2 ? surface : background, padding: "m", justify: "center", children: [{ type: "Text", role: i === 0 ? "label" : "body", color: foreground, text: cell, ...(i === 0 ? { letterSpacing: tracking, align: "center" as const } : {}) }] })) })) }];
  }
  if (recipe === "overlay") {
    const plate = frame.children!.at(-1)!;
    plate.padding = undefined; plate.gap = undefined; plate.align = "center"; plate.justify = "center";
    plate.children = [{ type: "Column", width: width * 0.9, height: height * 0.36, gap: "m", justify: "center", children: [...(plate.children ?? []), ...footnote] }];
  } else {
    const children = [...(frame.children ?? []), ...footnote];
    frame.padding = undefined; frame.gap = undefined; frame.align = "center"; frame.justify = "center";
    frame.children = [{ type: "Column", width: width * 0.9, height: height * 0.9, gap: "l", children }];
  }
  return frame;
}

const PRICE_EXAMPLE = [
  { name: "House salad", description: "Greens, citrus, seeds", price: "9" },
  { name: "Tomato soup", price: "8" },
  { name: "Grilled cheese", price: "11" },
  { name: "Roast chicken", description: "Pan jus, herbs", price: "22" },
  { name: "River trout", price: "24" },
  { name: "Chocolate tart", price: "10" },
];

const SCHEDULE_EXAMPLE = [
  { time: "09:00", item: "Doors", note: "Lobby" },
  { time: "09:30", item: "Welcome", note: "Hall A" },
  { time: "11:00", item: "Break" },
  { time: "11:20", item: "Workshop" },
  { time: "13:00", item: "Lunch", note: "Courtyard" },
  { time: "14:00", item: "Close" },
];

export function recipeExamples(): Record<RecipeName, RecipeCatalogEntry> {
  return {
    title: { fields: [...COMMON, ...SPECIFIC.title], example: { recipe: "title", title: "One clear point", subtitle: "A single next step", body: "Explain the outcome.\nAdd one useful next step.", footnote: "screenrig.ai" } },
    "split-image": { fields: [...COMMON, ...SPECIFIC["split-image"]], example: { recipe: "split-image", title: "Explain the image", subtitle: "Keep the subject large", body: "Use an original with enough pixels.", image: "./photo.png", objectFit: "contain", footnote: "Photo: house archive" } },
    cards: { fields: [...COMMON, ...SPECIFIC.cards], example: { recipe: "cards", title: "Compare outcomes", subtitle: "Three beats, one deck", cards: [{ title: "Prepare", body: "Validate locally." }, { title: "Publish", body: "Assign when ready." }, { title: "Verify", body: "Inspect the screen." }], footnote: "Keep adjacent pages on different recipes." } },
    table: { fields: [...COMMON, ...SPECIFIC.table], example: { recipe: "table", title: "Compare plans", subtitle: "Per account", headers: ["Plan", "Screens", "Support"], rows: [["Standard", "100", "Documentation"], ["Premium", "500", "Human support"], ["Reserve", "50", "Self serve"]], footnote: "Limits are per account." } },
    overlay: { fields: [...COMMON, ...SPECIFIC.overlay], example: { recipe: "overlay", title: "A clear headline", subtitle: "On a plate", body: "Opaque text on a subtly translucent plate.", footnote: "Do not print pixels." } },
    hero: {
      fields: [...COMMON, ...SPECIFIC.hero],
      variants: RECIPE_VARIANTS,
      example: { recipe: "hero", variant: "a", theme: "warm-cafe", headline: "Tonight's special", subhead: "Wood-fired pies until ten.", callout: "New", image: "./photo.png", footnote: "Kitchen closes at 22:00" },
    },
    "price-list": {
      fields: [...COMMON, ...SPECIFIC["price-list"]],
      variants: RECIPE_VARIANTS,
      example: { recipe: "price-list", variant: "a", theme: "earthy-market", title: "Kitchen", subtitle: "From noon", rows: PRICE_EXAMPLE, footnote: "Ask about allergens" },
    },
    "menu-board": {
      fields: [...COMMON, ...SPECIFIC["menu-board"]],
      variants: RECIPE_VARIANTS,
      example: {
        recipe: "menu-board",
        variant: "a",
        theme: "bakery-cream",
        title: "Lunch",
        subtitle: "Baked this morning",
        image: "./photo.png",
        sections: [
          { heading: "Savoury", items: [{ name: "Pie", description: "Leek and cheddar", price: "7" }, { name: "Roll", price: "5" }, { name: "Soup", price: "6" }, { name: "Quiche", price: "8" }] },
          { heading: "Sweet", items: [{ name: "Bun", price: "4" }, { name: "Tart", price: "6" }, { name: "Cake", price: "5" }, { name: "Cookie", price: "3" }] },
        ],
        footnote: "Contains gluten, dairy, nuts",
      },
    },
    promo: {
      fields: [...COMMON, ...SPECIFIC.promo],
      variants: RECIPE_VARIANTS,
      example: { recipe: "promo", variant: "a", theme: "sunset-promo", headline: "Weekend roast", subtitle: "Two courses", price: "18", finePrint: "Until Sunday.", image: "./photo.png", footnote: "Walk-ins welcome" },
    },
    event: {
      fields: [...COMMON, ...SPECIFIC.event],
      variants: RECIPE_VARIANTS,
      example: { recipe: "event", variant: "a", theme: "cinema-noir", date: "12 Oct", title: "Open rehearsal", subtitle: "Free seating", venue: "Hall A", image: "./photo.png", footnote: "Doors 18:30" },
    },
    quote: {
      fields: [...COMMON, ...SPECIFIC.quote],
      variants: RECIPE_VARIANTS,
      description: "Intentionally airy centred quotation; empty margin is the point.",
      example: { recipe: "quote", variant: "a", theme: "luxury-gold", quotation: "Come as you are.", attribution: "The house", footnote: "Est. 1924" },
    },
    schedule: {
      fields: [...COMMON, ...SPECIFIC.schedule],
      variants: RECIPE_VARIANTS,
      example: { recipe: "schedule", variant: "a", theme: "clean-corporate", title: "Today", subtitle: "Main hall", rows: SCHEDULE_EXAMPLE, footnote: "Times in local zone" },
    },
  };
}
