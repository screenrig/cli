import { PINS, ROLES, SPACES } from "./tokens.js";

export const COMPOSE_TYPES = ["Frame", "Column", "Row", "Box", "Spacer", "Text", "Image"] as const;
export const WIRE_PLACEMENT_KINDS = ["image", "video", "iframe", "application"] as const;
export const FONT_FALLBACKS = ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans", "Liberation Sans"] as const;

export interface ComposeCatalog {
  types: typeof COMPOSE_TYPES[number][];
  roles: typeof ROLES[number][];
  spaces: typeof SPACES[number][];
  pins: typeof PINS[number][];
  rules: {
    authoring_xy: string;
    fontSize: false;
    image_src: string;
    envelope: string;
  };
  wire_kinds: typeof WIRE_PLACEMENT_KINDS[number][];
  font_fallbacks: typeof FONT_FALLBACKS[number][];
}

export function composeCatalog(): ComposeCatalog {
  return {
    types: [...COMPOSE_TYPES],
    roles: [...ROLES],
    spaces: [...SPACES],
    pins: [...PINS],
    rules: {
      authoring_xy: "Frame canvas only; child nodes use pin, flex, padding, and gap",
      fontSize: false,
      image_src: "local filesystem path relative to the spec file directory",
      envelope: "structured JSON, not pixels",
    },
    wire_kinds: [...WIRE_PLACEMENT_KINDS],
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
    "fontSize: not authorable",
    `image_src: ${catalog.rules.image_src}`,
    `wire_kinds: ${catalog.wire_kinds.join("|")}`,
    "envelope: structured JSON, not pixels",
  ];
  return lines.join("\n");
}
