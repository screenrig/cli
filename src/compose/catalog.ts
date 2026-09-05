import { PINS, ROLES, SPACES } from "./tokens.js";

export const COMPOSE_TYPES = ["Frame", "Column", "Row", "Box", "Spacer", "Text", "Image"] as const;
export const WIRE_PRIMITIVES = ["image", "video", "iframe", "application"] as const;
import { GlobalFonts } from "@napi-rs/canvas";
import { FONT_FALLBACKS, loadUserFonts } from "./fonts.js";
import { composeAttributes } from "./validate.js";
import { recipeExamples } from "./recipes.js";
export { FONT_FALLBACKS } from "./fonts.js";

export interface ComposeCatalog {
  attributes: Record<string, string[]>;
  installed_fonts: string[];
  examples: Record<string, unknown>;
  recipes: Record<string, unknown>;
  types: typeof COMPOSE_TYPES[number][];
  roles: typeof ROLES[number][];
  spaces: typeof SPACES[number][];
  pins: typeof PINS[number][];
  rules: {
    authoring_xy: string;
    child_size: string;
    pin_stretch: string;
    fontSize: false;
    image_src: string;
    envelope: string;
    textShadow: string;
  };
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
    },
    types: [...COMPOSE_TYPES],
    roles: [...ROLES],
    spaces: [...SPACES],
    pins: [...PINS],
    rules: {
      authoring_xy: "Frame canvas only; child nodes use width, height, pin, flex, padding, and gap",
      child_size: "Image, Box, Row, Column, and Spacer honor width and height in px. Keep flex for remaining space.",
      pin_stretch: "pin top|bottom stretches the full width; pin left|right stretches the full height. Size a wordmark with width and height, not pin.",
      fontSize: false,
      image_src: "local filesystem path relative to the spec file directory",
      envelope: "structured JSON, not pixels",
      textShadow: "optional Text object { x, y, blur?, color }; omitted paints without a shadow",
    },
    wire_primitives: [...WIRE_PRIMITIVES],
    font_fallbacks: [...FONT_FALLBACKS],
  };
}

export function formatComposeCatalog(catalog: ComposeCatalog): string {
  const lines = [
    "Local compose catalog",
    `types: ${catalog.types.join("|")}`,
    `roles: ${catalog.roles.join("|")}`,
    `spaces: ${catalog.spaces.join("|")}`,
    `pins: ${catalog.pins.join("|")}`,
    `authoring_xy: ${catalog.rules.authoring_xy}`,
    `child_size: ${catalog.rules.child_size}`,
    `pin_stretch: ${catalog.rules.pin_stretch}`,
    "fontSize: not authorable",
    `image_src: ${catalog.rules.image_src}`,
    `textShadow: ${catalog.rules.textShadow}`,
    `wire_primitives: ${catalog.wire_primitives.join("|")}`,
    "envelope: structured JSON, not pixels",
    `installed_fonts: ${catalog.installed_fonts.join(" | ")}`,
    `attributes: ${JSON.stringify(catalog.attributes)}`,
    `examples: ${JSON.stringify(catalog.examples)}`,
    `recipes: ${JSON.stringify(catalog.recipes)}`,
  ];
  return lines.join("\n");
}
