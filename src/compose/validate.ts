import { PINS, ROLES, SPACES } from "./tokens.js";
import type { ComposeFrame, ComposeNode } from "./types.js";

const FRAME_KEYS = new Set(["type", "width", "height", "background", "fontFamily", "direction", "padding", "gap", "align", "justify", "children"]);
const STACK_KEYS = new Set(["type", "width", "height", "flex", "padding", "gap", "align", "justify", "children", "background", "radius", "pin"]);
const TEXT_KEYS = new Set(["type", "text", "role", "color", "align", "flex", "textShadow"]);
const TEXT_SHADOW_KEYS = new Set(["x", "y", "blur", "color"]);
const IMAGE_KEYS = new Set(["type", "src", "width", "height", "flex", "objectFit", "radius"]);
const SPACER_KEYS = new Set(["type", "width", "height", "flex"]);
const LEAVES = new Set(["Text", "Image", "Spacer"]);
const STACKS = new Set(["Frame", "Column", "Row", "Box"]);
const FORBIDDEN = ["x", "y", "left", "top", "right", "bottom", "fontSize", "font_size", "lineHeight", "level", "weight", "size"];
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function usage(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "usage_error";
  return err;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateTextShadow(value: unknown, path: string): void {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw usage(`${path}.textShadow must be an object { x, y, blur?, color }`);
  }
  const shadow = value as Record<string, unknown>;
  const extra = Object.keys(shadow).filter((key) => !TEXT_SHADOW_KEYS.has(key));
  if (extra.length) throw usage(`${path}.textShadow unknown keys: ${extra.join(", ")}`);
  if (!isFiniteNumber(shadow.x)) throw usage(`${path}.textShadow.x required`);
  if (!isFiniteNumber(shadow.y)) throw usage(`${path}.textShadow.y required`);
  if ("blur" in shadow && (!isFiniteNumber(shadow.blur) || shadow.blur < 0)) {
    throw usage(`${path}.textShadow.blur must be a finite number >= 0`);
  }
  if (typeof shadow.color !== "string") throw usage(`${path}.textShadow.color required`);
  if (!HEX_COLOR.test(shadow.color)) throw usage(`${path}.textShadow.color is not a hex color`);
}

function walk(node: ComposeNode, path: string): void {
  const type = node.type;
  if (!STACKS.has(type) && !LEAVES.has(type)) throw usage(`${path}.type unknown: ${type}`);
  const allowed =
    type === "Frame" ? FRAME_KEYS
    : type === "Text" ? TEXT_KEYS
    : type === "Image" ? IMAGE_KEYS
    : type === "Spacer" ? SPACER_KEYS
    : STACK_KEYS;
  for (const key of FORBIDDEN) {
    if (key in node && !(type === "Frame" && (key === "width" || key === "height"))) {
      throw usage(`${path} must not set ${key}`);
    }
  }
  const extra = Object.keys(node).filter((key) => !allowed.has(key));
  if (extra.length) throw usage(`${path} unknown keys: ${extra.join(", ")}`);
  if (type === "Frame") {
    if ("width" in node && typeof node.width !== "number") throw usage(`${path}.width required`);
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
  if (type === "Text") {
    if (typeof node.text !== "string") throw usage(`${path}.text required`);
    const role = node.role ?? "body";
    if (!(ROLES as readonly string[]).includes(role)) throw usage(`${path}.role must be ${ROLES.join("|")}`);
    if ("textShadow" in node) validateTextShadow(node.textShadow, path);
  }
  if (type === "Image" && typeof node.src !== "string") throw usage(`${path}.src required`);
  if (node.children) {
    if (!STACKS.has(type)) throw usage(`${path} cannot have children`);
    if (!Array.isArray(node.children)) throw usage(`${path}.children must be an array`);
    node.children.forEach((child, i) => walk(child, `${path}.children[${i}]`));
  }
}

export function validateSpec(spec: unknown): ComposeFrame {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw usage("compose spec must be an object");
  const frame = spec as ComposeFrame;
  if (frame.type !== "Frame") throw usage("root type must be Frame");
  if (![frame.width, frame.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 8192) || frame.width * frame.height > 33_554_432) {
    throw usage("Frame.width and Frame.height must be positive integers up to 8192, with at most 33554432 pixels");
  }
  walk(frame, "Frame");
  return frame;
}

// The catalog uses the validator's allowlist so discoverability cannot drift.
export function composeAttributes(): Record<string, string[]> {
  return Object.fromEntries(Object.entries({ Frame: FRAME_KEYS, Column: STACK_KEYS, Row: STACK_KEYS, Box: STACK_KEYS, Text: TEXT_KEYS, Image: IMAGE_KEYS, Spacer: SPACER_KEYS }).map(([type, keys]) => [type, [...keys]]));
}
