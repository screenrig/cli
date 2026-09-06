import { resolveFontFamily } from "./fonts.js";
import { isColorToken, themeOf, type ComposeTheme } from "./tokens.js";
import type { ComposeFrame, ComposeNode, LinearGradient, Paint, Role } from "./types.js";

export interface ThemeWarning {
  code: string;
  message: string;
}

function usage(message: string): Error {
  return Object.assign(new Error(message), { code: "usage_error" });
}

function resolveThemeFont(name: string, warnings: ThemeWarning[], field: "fontDisplay" | "fontBody"): string {
  try {
    return resolveFontFamily(name);
  } catch {
    const fallback = resolveFontFamily(undefined);
    warnings.push({
      code: "theme_font_fallback",
      message: `theme ${field} ${name} is not installed; using ${fallback}`,
    });
    return fallback;
  }
}

function resolveColor(value: string, theme: ComposeTheme | undefined, path: string): string {
  if (!isColorToken(value)) return value;
  if (!theme) throw usage(`${path} color token "${value}" requires Frame.theme`);
  return theme[value];
}

function resolvePaint(value: Paint | undefined, theme: ComposeTheme | undefined, path: string): Paint | undefined {
  if (value == null) return value;
  if (typeof value === "string") return resolveColor(value, theme, path);
  return {
    type: "linear",
    angle: value.angle,
    stops: value.stops.map((stop, i) => ({
      at: stop.at,
      color: resolveColor(stop.color, theme, `${path}.stops[${i}].color`),
    })),
  };
}

function displayRole(role: Role | undefined): boolean {
  return role === "display" || role === "title";
}

function applyNode(
  node: ComposeNode,
  theme: ComposeTheme | undefined,
  fonts: { display: string; body: string },
  inheritedFamily: string,
  path: string,
): void {
  if (typeof node.fontFamily === "string") {
    node.fontFamily = resolveFontFamily(node.fontFamily);
  }
  if (node.type === "Box" && theme) {
    if (node.background == null) node.background = theme.surface;
    if (node.fontFamily == null) node.fontFamily = inheritedFamily;
  }
  if (node.type === "Text") {
    if (node.color == null && theme) node.color = theme.ink;
    if (node.fontFamily == null && theme) {
      node.fontFamily = displayRole(node.role) ? fonts.display : inheritedFamily;
    }
    if (node.plate && typeof node.plate === "object" && typeof node.plate.color === "string") {
      node.plate = { ...node.plate, color: resolveColor(node.plate.color, theme, `${path}.plate.color`) };
    }
  }
  if (node.type === "Icon" && node.color == null && theme) node.color = theme.ink;
  if (node.type === "Divider" && node.color == null && theme) node.color = theme.inkMuted;
  if (node.type === "Pill") {
    if (node.color == null && theme) node.color = theme.accentInk;
    if (node.background == null && theme) node.background = theme.accent;
  }
  if (node.color != null) node.color = resolveColor(node.color, theme, `${path}.color`);
  if (node.background != null) node.background = resolvePaint(node.background as Paint, theme, `${path}.background`);
  const family = typeof node.fontFamily === "string" ? node.fontFamily : inheritedFamily;
  (node.children ?? []).forEach((child, i) => {
    applyNode(child, theme, fonts, family, `${path}.children[${i}]`);
  });
}

export function applyComposeTheme(tree: ComposeFrame, warnings: ThemeWarning[]): void {
  const theme = typeof tree.theme === "string" ? themeOf(tree.theme) : undefined;
  if (!theme) {
    if (tree.background == null) tree.background = "#1B2632";
    applyNode(tree, undefined, { display: "", body: "" }, "", "Frame");
    return;
  }
  const display = resolveThemeFont(theme.fontDisplay, warnings, "fontDisplay");
  const body = resolveThemeFont(theme.fontBody, warnings, "fontBody");
  if (tree.fontFamily == null) tree.fontFamily = body;
  else tree.fontFamily = resolveFontFamily(tree.fontFamily);
  if (tree.background == null) tree.background = theme.background;
  applyNode(tree, theme, { display, body }, tree.fontFamily, "Frame");
}

export function isLinearGradient(value: unknown): value is LinearGradient {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (value as LinearGradient).type === "linear";
}
