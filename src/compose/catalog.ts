import { PINS, ROLES, SPACES, TEXT_SCALES, THEME_GUIDANCE, THEME_NAMES, THEMES } from "./tokens.js";
import type { ComposeTheme, ThemeName } from "./types.js";

export const COMPOSE_TYPES = ["Frame", "Column", "Row", "Box", "Spacer", "Text", "Image", "Icon", "Divider", "Pill"] as const;
export const WIRE_PRIMITIVES = ["image", "video", "iframe", "application"] as const;
import { GlobalFonts } from "@napi-rs/canvas";
import { FONT_FALLBACKS, loadUserFonts } from "./fonts.js";
import { composeAttributes } from "./validate.js";
import { RECIPE_GUIDANCE, recipeExamples } from "./recipes.js";
import { LOOK_AT_THE_CONTACT_SHEET, lintCodesList, viewingGuidance } from "./lint.js";
export { FONT_FALLBACKS } from "./fonts.js";

export interface ComposeCatalog {
  attributes: Record<string, string[]>;
  installed_fonts: string[];
  examples: Record<string, unknown>;
  recipes: Record<string, unknown>;
  types: typeof COMPOSE_TYPES[number][];
  roles: typeof ROLES[number][];
  scales: typeof TEXT_SCALES[number][];
  spaces: typeof SPACES[number][];
  pins: typeof PINS[number][];
  rules: {
    authoring_xy: string;
    child_size: string;
    pin_stretch: string;
    fontSize: false;
    scale: string;
    image_src: string;
    envelope: string;
    textShadow: string;
    effects: string;
    effects_guidance: string;
    plate: string;
    focal: string;
    theme_guidance: string;
    recipe_guidance: string;
    viewing: string;
    lint: string;
    preview: string;
  };
  themes: Record<ThemeName, ComposeTheme>;
  wire_primitives: typeof WIRE_PRIMITIVES[number][];
  font_fallbacks: typeof FONT_FALLBACKS[number][];
}

export function composeCatalog(): ComposeCatalog {
  loadUserFonts();
  return {
    attributes: composeAttributes(),
    recipes: recipeExamples(),
    installed_fonts: GlobalFonts.families.map((family) => family.family).sort(),
    examples: {
      slide: { type: "Frame", width: 1920, height: 1080, padding: "l", children: [{ type: "Text", role: "title", text: "Welcome" }] },
      transparent_overlay: { type: "Frame", width: 1920, height: 1080, background: "#00000000", children: [{ type: "Box", pin: "bottom", height: 300, padding: "l", background: "#000000E0", children: [{ type: "Text", role: "title", color: "#FFFFFF", text: "Welcome" }] }] },
      effects_headline: { type: "Frame", width: 1920, height: 1080, padding: "l", children: [{ type: "Text", role: "display", text: "Tonight", color: "#FFC857", align: "center", effects: { weight: "bold", italic: true, underline: true, outline: { width: 4, color: "#000000" }, shadow: { x: 2, y: 2, blur: 4, color: "#00000080" }, arc: { degrees: 40 } } }] },
      themed_slide: { type: "Frame", theme: "warm-cafe", width: 1920, height: 1080, padding: "l", gap: "m", children: [{ type: "Text", role: "title", text: "Tonight's menu" }, { type: "Text", role: "body", color: "inkMuted", text: "Soup, bread, and a quiet table." }, { type: "Pill", text: "New", color: "accentInk", background: "accent" }] },
      gradient_band: { type: "Frame", width: 1920, height: 1080, background: { type: "linear", angle: 180, stops: [{ at: 0, color: "#1B2632" }, { at: 1, color: "#0B1020" }] }, padding: "l", children: [{ type: "Text", role: "title", color: "#E8F0FF", text: "After dark" }] },
      icon_row: { type: "Frame", theme: "clean-corporate", width: 1920, height: 1080, padding: "l", gap: "m", direction: "row", children: [{ type: "Icon", name: "star", size: 64, color: "accent" }, { type: "Divider", thickness: 4 }, { type: "Pill", text: "Featured" }] },
    },
    types: [...COMPOSE_TYPES],
    roles: [...ROLES],
    scales: [...TEXT_SCALES],
    spaces: [...SPACES],
    pins: [...PINS],
    rules: {
      authoring_xy: "Frame canvas only; child nodes use width, height, pin, flex, padding, and gap",
      child_size: "Image, Box, Row, Column, and Spacer honor width and height in px. Keep flex for remaining space.",
      pin_stretch: "pin top|bottom stretches the full width; pin left|right stretches the full height. Size a wordmark with width and height, not pin.",
      fontSize: false,
      scale: 'optional Text "display-xl"; raises the type wish to 60% of the shorter edge when the Frame has that single Text child. Other roles and layouts keep the 12% cap',
      image_src: "local filesystem path relative to the spec file directory",
      envelope: "structured JSON, not pixels",
      textShadow: "optional Text object { x, y, blur?, color }; omitted paints without a shadow",
      effects: "optional Text object { weight: regular|bold, italic, underline, outline: { width, color }, shadow: { x, y, blur?, color }, arc: { degrees }, texture: { src, objectFit? } }; every effect is off by default; textShadow maps onto effects.shadow",
      effects_guidance: "Use text effects sparingly, when the design calls for them (a headline, a badge); body copy and prices stay plain for readability.",
      plate: 'optional Text "auto"|"none"|{ color, radius?, padding? }; default none. auto samples pixels behind the ink box after layout and paints a readability plate when contrast is below 4.5. plate.color accepts a hex colour or a theme token when Frame.theme is set',
      focal: "optional Image { x, y } in 0..1; default 0.5, 0.5. Positions the cover crop so the focal point stays visible",
      theme_guidance: THEME_GUIDANCE,
      recipe_guidance: RECIPE_GUIDANCE,
      viewing: viewingGuidance(),
      lint: `warnings (${lintCodesList()}); never errors. compose render, compose batch, and playlist validate emit lint ordered by page. --lint-only skips artifact writes.`,
      preview: LOOK_AT_THE_CONTACT_SHEET,
    },
    themes: { ...THEMES },
    wire_primitives: [...WIRE_PRIMITIVES],
    font_fallbacks: [...FONT_FALLBACKS],
  };
}

export function formatComposeCatalog(catalog: ComposeCatalog): string {
  const lines = [
    "Local compose catalog",
    `types: ${catalog.types.join("|")}`,
    `roles: ${catalog.roles.join("|")}`,
    `scales: ${catalog.scales.join("|")}`,
    `spaces: ${catalog.spaces.join("|")}`,
    `pins: ${catalog.pins.join("|")}`,
    `authoring_xy: ${catalog.rules.authoring_xy}`,
    `child_size: ${catalog.rules.child_size}`,
    `pin_stretch: ${catalog.rules.pin_stretch}`,
    "fontSize: not authorable",
    `scale: ${catalog.rules.scale}`,
    `image_src: ${catalog.rules.image_src}`,
    `textShadow: ${catalog.rules.textShadow}`,
    `effects: ${catalog.rules.effects}`,
    `effects_guidance: ${catalog.rules.effects_guidance}`,
    `plate: ${catalog.rules.plate}`,
    `focal: ${catalog.rules.focal}`,
    "themes:",
    ...THEME_NAMES.map((name) => {
      const theme = catalog.themes[name]!;
      return `${name} background=${theme.background} surface=${theme.surface} ink=${theme.ink} inkMuted=${theme.inkMuted} accent=${theme.accent} accentInk=${theme.accentInk} fontDisplay=${theme.fontDisplay} fontBody=${theme.fontBody}`;
    }),
    `theme_guidance: ${catalog.rules.theme_guidance}`,
    `recipe_guidance: ${catalog.rules.recipe_guidance}`,
    `viewing: ${catalog.rules.viewing}`,
    `lint: ${catalog.rules.lint}`,
    `preview: ${catalog.rules.preview}`,
    `wire_primitives: ${catalog.wire_primitives.join("|")}`,
    "envelope: structured JSON, not pixels",
    `installed_fonts: ${catalog.installed_fonts.join(" | ")}`,
    `attributes: ${JSON.stringify(catalog.attributes)}`,
    `examples: ${JSON.stringify(catalog.examples)}`,
    `recipes: ${JSON.stringify(catalog.recipes)}`,
  ];
  return lines.join("\n");
}
