import { PINS, ROLES, SPACES } from "./tokens.js";
import type { ComposeFrame, ComposeNode } from "./types.js";

const FRAME_KEYS = new Set(["type", "width", "height", "background", "fontFamily", "direction", "padding", "gap", "align", "justify", "children"]);
const STACK_KEYS = new Set(["type", "flex", "padding", "gap", "align", "justify", "children", "background", "radius", "pin"]);
const TEXT_KEYS = new Set(["type", "text", "role", "color", "align", "flex"]);
const IMAGE_KEYS = new Set(["type", "src", "flex", "objectFit", "radius"]);
const SPACER_KEYS = new Set(["type", "flex"]);
const LEAVES = new Set(["Text", "Image", "Spacer"]);
const STACKS = new Set(["Frame", "Column", "Row", "Box"]);
const FORBIDDEN = ["x", "y", "left", "top", "right", "bottom", "fontSize", "font_size", "lineHeight", "level", "weight", "size"];

function usage(message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = "usage_error";
  return err;
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
  if (!Number.isFinite(frame.width) || !Number.isFinite(frame.height)) {
    throw usage("Frame.width and Frame.height required");
  }
  walk(frame, "Frame");
  return frame;
}
