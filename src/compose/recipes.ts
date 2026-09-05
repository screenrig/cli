import type { ComposeFrame, ComposeNode } from "./types.js";

export const RECIPE_NAMES = ["title", "split-image", "cards", "table", "overlay"] as const;
export type RecipeName = typeof RECIPE_NAMES[number];
function fail(message: string): never { throw Object.assign(new Error(message), { code: "usage_error" }); }
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`recipe.${field} must be nonempty text`);
  return value;
}

/** Recipes expand to ordinary measured Text/Row/Column nodes, never SVG text. */
export function expandComposeRecipe(input: unknown): unknown {
  if (!input || typeof input !== "object" || !("recipe" in input)) return input;
  const value = input as Record<string, unknown>;
  const recipe = value.recipe as RecipeName;
  if (!RECIPE_NAMES.includes(recipe)) fail(`recipe must be ${RECIPE_NAMES.join("|")}`);
  const common = ["recipe", "width", "height", "fontFamily", "title", "subtitle", "background", "color", "accent", "surface"];
  const specific: Record<RecipeName, string[]> = { title: ["body"], "split-image": ["body", "image", "objectFit"], cards: ["cards"], table: ["headers", "rows", "columnWeights"], overlay: ["body", "image", "objectFit"] };
  const extras = Object.keys(value).filter((key) => !common.includes(key) && !specific[recipe].includes(key));
  if (extras.length) fail(`recipe contains unsupported fields: ${extras.join(", ")}`);
  const width = value.width === undefined ? 1920 : value.width;
  const height = value.height === undefined ? 1080 : value.height;
  if (typeof width !== "number" || typeof height !== "number" || width < 1 || height < 1) fail("recipe width and height must be positive numbers");
  const color = (field: string, fallback: string): string => {
    if (value[field] === undefined) return fallback;
    if (typeof value[field] !== "string" || !/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value[field] as string)) fail(`recipe.${field} must be a hex color`);
    return value[field] as string;
  };
  const foreground = color("color", "#F7F7F2"), background = color("background", "#1B2632"), accent = color("accent", "#FFC857"), surface = color("surface", "#101820");
  const title: ComposeNode = { type: "Text", role: "title", text: text(value.title, "title"), color: foreground };
  const body = (): ComposeNode => ({ type: "Text", role: "body", text: text(value.body, "body"), color: foreground });
  const header: ComposeNode[] = [title];
  if (value.subtitle !== undefined) header.push({ type: "Text", role: "caption", text: text(value.subtitle, "subtitle"), color: accent });
  const frame: ComposeFrame = { type: "Frame", width, height, background, padding: "xl", gap: "l", children: [] };
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
        { type: "Text", role: "title", color: accent, text: text(entry.title, `cards[${index}].title`) },
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
    frame.children = [...header, { type: "Column", flex: 1, gap: "xs", children: [headers, ...rows].map((row, i) => ({ type: "Row", flex: 1, gap: "xs", children: row.map((cell, j) => ({ type: "Box", flex: weights[j] as number, background: i === 0 || i % 2 ? surface : background, padding: "m", justify: "center", children: [{ type: "Text", role: i === 0 ? "label" : "body", color: i === 0 ? accent : foreground, text: cell }] })) })) }];
  }
  if (recipe === "overlay") {
    const plate = frame.children!.at(-1)!;
    plate.padding = undefined; plate.gap = undefined; plate.align = "center"; plate.justify = "center";
    plate.children = [{ type: "Column", width: width * 0.9, height: height * 0.36, gap: "m", justify: "center", children: plate.children }];
  } else {
    const children = frame.children;
    frame.padding = undefined; frame.gap = undefined; frame.align = "center"; frame.justify = "center";
    frame.children = [{ type: "Column", width: width * 0.9, height: height * 0.9, gap: "l", children }];
  }
  return frame;
}

export function recipeExamples(): Record<RecipeName, unknown> {
  return {
    title: { recipe: "title", title: "One clear point", body: "Explain the outcome.\nAdd one useful next step." },
    "split-image": { recipe: "split-image", title: "Explain the image", body: "Use an original with enough pixels.", image: "./photo.png", objectFit: "contain" },
    cards: { recipe: "cards", title: "Compare outcomes", cards: [{ title: "Prepare", body: "Validate locally." }, { title: "Publish", body: "Assign when ready." }, { title: "Verify", body: "Inspect the screen." }] },
    table: { recipe: "table", title: "Compare plans", headers: ["Plan", "Screens", "Support"], rows: [["Standard", "100", "Documentation"], ["Premium", "500", "Human support"]] },
    overlay: { recipe: "overlay", title: "A clear headline", body: "Opaque text on a subtly translucent plate." },
  };
}
