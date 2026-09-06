import { resolveIconCodepoint } from "./icons.js";
import { isColorToken, isHexColor, isThemeName, PINS, ROLES, SPACES, TEXT_SCALES, THEME_NAMES, VIEWING_DISTANCES } from "./tokens.js";
import type { ComposeFrame, ComposeNode } from "./types.js";

const FRAME_KEYS = new Set(["type", "theme", "width", "height", "background", "fontFamily", "direction", "padding", "gap", "align", "justify", "children", "viewing"]);
const STACK_KEYS = new Set(["type", "width", "height", "flex", "padding", "gap", "align", "justify", "children", "background", "radius", "pin", "fontFamily"]);
const TEXT_KEYS = new Set(["type", "text", "role", "scale", "color", "align", "flex", "fontFamily", "textShadow", "effects", "plate", "letterSpacing"]);
const TEXT_SHADOW_KEYS = new Set(["x", "y", "blur", "color"]);
const TEXT_EFFECTS_KEYS = new Set(["weight", "italic", "underline", "outline", "shadow", "arc", "texture"]);
const TEXT_OUTLINE_KEYS = new Set(["width", "color"]);
const TEXT_ARC_KEYS = new Set(["degrees"]);
const TEXT_TEXTURE_KEYS = new Set(["src", "objectFit"]);
const TEXT_PLATE_KEYS = new Set(["color", "radius", "padding"]);
const TEXT_WEIGHTS = new Set(["regular", "bold"]);
const OBJECT_FITS = new Set(["cover", "contain", "fill"]);
const IMAGE_KEYS = new Set(["type", "src", "width", "height", "flex", "objectFit", "radius", "focal"]);
const IMAGE_FOCAL_KEYS = new Set(["x", "y"]);
const SPACER_KEYS = new Set(["type", "width", "height", "flex"]);
const ICON_KEYS = new Set(["type", "name", "size", "color", "flex", "pin"]);
const DIVIDER_KEYS = new Set(["type", "thickness", "color", "length", "flex", "pin", "style"]);
const PILL_KEYS = new Set(["type", "text", "role", "color", "background", "radius", "flex", "pin", "align"]);
const GRADIENT_KEYS = new Set(["type", "angle", "stops"]);
const STOP_KEYS = new Set(["at", "color"]);
const LEAVES = new Set(["Text", "Image", "Spacer", "Icon", "Divider", "Pill"]);
const STACKS = new Set(["Frame", "Column", "Row", "Box"]);
const FORBIDDEN = ["x", "y", "left", "top", "right", "bottom", "fontSize", "font_size", "lineHeight", "level", "weight", "size"];

function usage(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "usage_error";
  return err;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateShadow(value: unknown, path: string): void {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw usage(`${path} must be an object { x, y, blur?, color }`);
  }
  const shadow = value as Record<string, unknown>;
  const extra = Object.keys(shadow).filter((key) => !TEXT_SHADOW_KEYS.has(key));
  if (extra.length) throw usage(`${path} unknown keys: ${extra.join(", ")}`);
  if (!isFiniteNumber(shadow.x)) throw usage(`${path}.x required`);
  if (!isFiniteNumber(shadow.y)) throw usage(`${path}.y required`);
  if ("blur" in shadow && (!isFiniteNumber(shadow.blur) || shadow.blur < 0)) {
    throw usage(`${path}.blur must be a finite number >= 0`);
  }
  if (typeof shadow.color !== "string") throw usage(`${path}.color required`);
  if (!isHexColor(shadow.color)) throw usage(`${path}.color is not a hex color`);
}

function validateColorValue(value: unknown, path: string, hasTheme: boolean): void {
  if (typeof value !== "string") throw usage(`${path} must be a hex color or accent|ink|inkMuted|surface|accentInk|background`);
  if (isColorToken(value)) {
    if (!hasTheme) throw usage(`${path} color token "${value}" requires Frame.theme`);
    return;
  }
  if (!isHexColor(value)) {
    throw usage(`${path} must be a hex color or accent|ink|inkMuted|surface|accentInk|background`);
  }
}

function validatePaint(value: unknown, path: string, hasTheme: boolean): void {
  if (typeof value === "string") {
    validateColorValue(value, path, hasTheme);
    return;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw usage(`${path} must be a hex color, a color token, or a linear gradient`);
  }
  const gradient = value as Record<string, unknown>;
  const extra = Object.keys(gradient).filter((key) => !GRADIENT_KEYS.has(key));
  if (extra.length) throw usage(`${path} unknown keys: ${extra.join(", ")}`);
  if (gradient.type !== "linear") throw usage(`${path}.type must be linear`);
  if (!isFiniteNumber(gradient.angle) || gradient.angle < 0 || gradient.angle > 360) {
    throw usage(`${path}.angle must be a finite number from 0 to 360`);
  }
  if (!Array.isArray(gradient.stops) || gradient.stops.length < 2 || gradient.stops.length > 8) {
    throw usage(`${path}.stops must contain 2 to 8 stops`);
  }
  const stops = gradient.stops as unknown[];
  let previous = -1;
  stops.forEach((entry, i) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw usage(`${path}.stops[${i}] must be an object { at, color }`);
    }
    const stop = entry as Record<string, unknown>;
    const stopExtra = Object.keys(stop).filter((key) => !STOP_KEYS.has(key));
    if (stopExtra.length) throw usage(`${path}.stops[${i}] unknown keys: ${stopExtra.join(", ")}`);
    if (!isFiniteNumber(stop.at) || stop.at < 0 || stop.at > 1) {
      throw usage(`${path}.stops[${i}].at must be a finite number from 0 to 1`);
    }
    if (i === 0 && stop.at !== 0) throw usage(`${path}.stops[0].at must be 0`);
    if (i === stops.length - 1 && stop.at !== 1) throw usage(`${path}.stops[${i}].at must be 1`);
    if (stop.at <= previous) throw usage(`${path}.stops must be strictly increasing`);
    previous = stop.at;
    validateColorValue(stop.color, `${path}.stops[${i}].color`, hasTheme);
  });
}

function validateTextShadow(value: unknown, path: string): void {
  validateShadow(value, `${path}.textShadow`);
}

function validateEffects(value: unknown, path: string, text: string): void {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw usage(`${path}.effects must be an object`);
  }
  const effects = value as Record<string, unknown>;
  const extra = Object.keys(effects).filter((key) => !TEXT_EFFECTS_KEYS.has(key));
  if (extra.length) throw usage(`${path}.effects unknown keys: ${extra.join(", ")}`);
  if ("weight" in effects && (typeof effects.weight !== "string" || !TEXT_WEIGHTS.has(effects.weight))) {
    throw usage(`${path}.effects.weight must be regular|bold`);
  }
  if ("italic" in effects && typeof effects.italic !== "boolean") {
    throw usage(`${path}.effects.italic must be a boolean`);
  }
  if ("underline" in effects && typeof effects.underline !== "boolean") {
    throw usage(`${path}.effects.underline must be a boolean`);
  }
  if ("outline" in effects) {
    if (effects.outline == null || typeof effects.outline !== "object" || Array.isArray(effects.outline)) {
      throw usage(`${path}.effects.outline must be an object { width, color }`);
    }
    const outline = effects.outline as Record<string, unknown>;
    const outlineExtra = Object.keys(outline).filter((key) => !TEXT_OUTLINE_KEYS.has(key));
    if (outlineExtra.length) throw usage(`${path}.effects.outline unknown keys: ${outlineExtra.join(", ")}`);
    if (!isFiniteNumber(outline.width) || outline.width < 0.5 || outline.width > 12) {
      throw usage(`${path}.effects.outline.width must be a finite number from 0.5 to 12`);
    }
    if (typeof outline.color !== "string") throw usage(`${path}.effects.outline.color required`);
    if (!isHexColor(outline.color)) throw usage(`${path}.effects.outline.color is not a hex color`);
  }
  if ("shadow" in effects) validateShadow(effects.shadow, `${path}.effects.shadow`);
  if ("arc" in effects) {
    if (effects.arc == null || typeof effects.arc !== "object" || Array.isArray(effects.arc)) {
      throw usage(`${path}.effects.arc must be an object { degrees }`);
    }
    const arc = effects.arc as Record<string, unknown>;
    const arcExtra = Object.keys(arc).filter((key) => !TEXT_ARC_KEYS.has(key));
    if (arcExtra.length) throw usage(`${path}.effects.arc unknown keys: ${arcExtra.join(", ")}`);
    if (!isFiniteNumber(arc.degrees) || arc.degrees < -180 || arc.degrees > 180) {
      throw usage(`${path}.effects.arc.degrees must be a finite number from -180 to 180`);
    }
    if (text.includes("\n")) {
      throw usage(`${path} arc_single_line: arc text must be a single line`);
    }
  }
  if ("texture" in effects) {
    if (effects.texture == null || typeof effects.texture !== "object" || Array.isArray(effects.texture)) {
      throw usage(`${path}.effects.texture must be an object { src, objectFit? }`);
    }
    const texture = effects.texture as Record<string, unknown>;
    const textureExtra = Object.keys(texture).filter((key) => !TEXT_TEXTURE_KEYS.has(key));
    if (textureExtra.length) throw usage(`${path}.effects.texture unknown keys: ${textureExtra.join(", ")}`);
    if (typeof texture.src !== "string" || texture.src.length === 0) {
      throw usage(`${path}.effects.texture.src required`);
    }
    if ("objectFit" in texture && (typeof texture.objectFit !== "string" || !OBJECT_FITS.has(texture.objectFit))) {
      throw usage(`${path}.effects.texture.objectFit must be cover|contain|fill`);
    }
  }
}

function validatePlate(value: unknown, path: string, hasTheme: boolean): void {
  if (value === "auto" || value === "none") return;
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw usage(`${path}.plate must be auto, none, or an object { color, radius?, padding? }`);
  }
  const plate = value as Record<string, unknown>;
  const extra = Object.keys(plate).filter((key) => !TEXT_PLATE_KEYS.has(key));
  if (extra.length) throw usage(`${path}.plate unknown keys: ${extra.join(", ")}`);
  if (typeof plate.color !== "string") throw usage(`${path}.plate.color required`);
  validateColorValue(plate.color, `${path}.plate.color`, hasTheme);
  for (const field of ["radius", "padding"] as const) {
    if (field in plate && !(SPACES as readonly string[]).includes(String(plate[field]))) {
      throw usage(`${path}.plate.${field} must be ${SPACES.join("|")}`);
    }
  }
}

function validateFocal(value: unknown, path: string): void {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw usage(`${path}.focal must be an object { x, y }`);
  }
  const focal = value as Record<string, unknown>;
  const extra = Object.keys(focal).filter((key) => !IMAGE_FOCAL_KEYS.has(key));
  if (extra.length) throw usage(`${path}.focal unknown keys: ${extra.join(", ")}`);
  if (!isFiniteNumber(focal.x) || focal.x < 0 || focal.x > 1) {
    throw usage(`${path}.focal.x must be a finite number from 0 to 1`);
  }
  if (!isFiniteNumber(focal.y) || focal.y < 0 || focal.y > 1) {
    throw usage(`${path}.focal.y must be a finite number from 0 to 1`);
  }
}

function walk(node: ComposeNode, path: string, hasTheme: boolean): void {
  const type = node.type;
  if (!STACKS.has(type) && !LEAVES.has(type)) throw usage(`${path}.type unknown: ${type}`);
  const allowed =
    type === "Frame" ? FRAME_KEYS
    : type === "Text" ? TEXT_KEYS
    : type === "Image" ? IMAGE_KEYS
    : type === "Spacer" ? SPACER_KEYS
    : type === "Icon" ? ICON_KEYS
    : type === "Divider" ? DIVIDER_KEYS
    : type === "Pill" ? PILL_KEYS
    : STACK_KEYS;
  for (const key of FORBIDDEN) {
    if (key in node && !(type === "Frame" && (key === "width" || key === "height")) && !(type === "Icon" && key === "size")) {
      throw usage(`${path} must not set ${key}`);
    }
  }
  const extra = Object.keys(node).filter((key) => !allowed.has(key));
  if (extra.length) throw usage(`${path} unknown keys: ${extra.join(", ")}`);
  if (type === "Frame") {
    if ("width" in node && typeof node.width !== "number") throw usage(`${path}.width required`);
    if ("theme" in node) {
      if (typeof node.theme !== "string" || !isThemeName(node.theme)) {
        throw usage(`${path}.theme must be ${THEME_NAMES.join("|")}`);
      }
    }
    if ("viewing" in node) {
      if (typeof node.viewing !== "string" || !(VIEWING_DISTANCES as readonly string[]).includes(node.viewing)) {
        throw usage(`${path}.viewing must be ${VIEWING_DISTANCES.join("|")}`);
      }
    }
  } else {
    for (const field of ["width", "height"] as const) {
      if (!(field in node)) continue;
      const value = node[field];
      if (!isFiniteNumber(value) || value <= 0) {
        throw usage(`${path}.${field} must be a finite number greater than 0`);
      }
    }
  }
  for (const field of ["padding", "gap", "radius"] as const) {
    const value = node[field];
    if (value != null && !(SPACES as readonly string[]).includes(String(value))) {
      throw usage(`${path}.${field} must be ${SPACES.join("|")}`);
    }
  }
  if (node.pin != null && !(PINS as readonly string[]).includes(node.pin)) {
    throw usage(`${path}.pin must be ${PINS.join("|")}`);
  }
  if ("background" in node) validatePaint(node.background, `${path}.background`, hasTheme);
  if ("color" in node) validateColorValue(node.color, `${path}.color`, hasTheme);
  if (type === "Text") {
    if (typeof node.text !== "string") throw usage(`${path}.text required`);
    const role = node.role ?? "body";
    if (!(ROLES as readonly string[]).includes(role)) throw usage(`${path}.role must be ${ROLES.join("|")}`);
    if ("scale" in node) {
      if (typeof node.scale !== "string" || !(TEXT_SCALES as readonly string[]).includes(node.scale)) {
        throw usage(`${path}.scale must be ${TEXT_SCALES.join("|")}`);
      }
    }
    if ("textShadow" in node) validateTextShadow(node.textShadow, path);
    if ("effects" in node) validateEffects(node.effects, path, node.text);
    if ("plate" in node) validatePlate(node.plate, path, hasTheme);
    if ("letterSpacing" in node) {
      const spacing = node.letterSpacing;
      if (!isFiniteNumber(spacing) || spacing < 0 || spacing > 40) {
        throw usage(`${path}.letterSpacing must be a finite number from 0 to 40`);
      }
    }
  }
  if (type === "Image") {
    if (typeof node.src !== "string") throw usage(`${path}.src required`);
    if ("focal" in node) validateFocal(node.focal, path);
  }
  if (type === "Icon") {
    if (typeof node.name !== "string") throw usage(`${path}.name required`);
    resolveIconCodepoint(node.name, path);
    if ("size" in node && (!isFiniteNumber(node.size) || node.size <= 0)) {
      throw usage(`${path}.size must be a finite number greater than 0`);
    }
  }
  if (type === "Divider") {
    if ("thickness" in node && (!isFiniteNumber(node.thickness) || node.thickness <= 0)) {
      throw usage(`${path}.thickness must be a finite number greater than 0`);
    }
    if ("length" in node && (!isFiniteNumber(node.length) || node.length <= 0)) {
      throw usage(`${path}.length must be a finite number greater than 0`);
    }
    if ("style" in node && node.style !== "solid" && node.style !== "dotted") {
      throw usage(`${path}.style must be solid|dotted`);
    }
  }
  if (type === "Pill") {
    if (typeof node.text !== "string") throw usage(`${path}.text required`);
    const role = node.role ?? "label";
    if (!(ROLES as readonly string[]).includes(role)) throw usage(`${path}.role must be ${ROLES.join("|")}`);
  }
  if (node.children) {
    if (!STACKS.has(type)) throw usage(`${path} cannot have children`);
    if (!Array.isArray(node.children)) throw usage(`${path}.children must be an array`);
    node.children.forEach((child, i) => walk(child, `${path}.children[${i}]`, hasTheme));
  }
}

export function validateSpec(spec: unknown): ComposeFrame {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw usage("compose spec must be an object");
  const frame = spec as ComposeFrame;
  if (frame.type !== "Frame") throw usage("root type must be Frame");
  if (![frame.width, frame.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 8192) || frame.width * frame.height > 33_554_432) {
    throw usage("Frame.width and Frame.height must be positive integers up to 8192, with at most 33554432 pixels");
  }
  walk(frame, "Frame", typeof frame.theme === "string");
  return frame;
}

// The catalog uses the validator's allowlist so discoverability cannot drift.
export function composeAttributes(): Record<string, string[]> {
  return Object.fromEntries(Object.entries({
    Frame: FRAME_KEYS,
    Column: STACK_KEYS,
    Row: STACK_KEYS,
    Box: STACK_KEYS,
    Text: TEXT_KEYS,
    Image: IMAGE_KEYS,
    Spacer: SPACER_KEYS,
    Icon: ICON_KEYS,
    Divider: DIVIDER_KEYS,
    Pill: PILL_KEYS,
  }).map(([type, keys]) => [type, [...keys]]));
}
