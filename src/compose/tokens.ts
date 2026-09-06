import {
  COLOR_TOKENS,
  ROLES,
  SPACES,
  THEME_NAMES,
  type ColorToken,
  type ComposeTheme,
  type Role,
  type SpaceScale,
  type SpaceToken,
  type ThemeName,
  type TypeRamp,
  type ViewingDistance,
} from "./types.js";

export { COLOR_TOKENS, PINS, ROLES, SPACES, TEXT_SCALES, THEME_NAMES, VIEWING_DISTANCES } from "./types.js";
export type { ColorToken, ComposeTheme, ThemeName, ViewingDistance };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function expandHex(value: string): { r: number; g: number; b: number } {
  const raw = value.replace("#", "");
  const hex = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance for an sRGB hex color. Alpha is ignored. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = expandHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2 contrast ratio of two sRGB hex colors. */
export function contrastRatio(a: string, b: string): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export function isColorToken(value: string): value is ColorToken {
  return (COLOR_TOKENS as readonly string[]).includes(value);
}

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/** Curated signage themes. ink/background and accentInk/accent are >= 4.5:1. */
export const THEMES: Record<ThemeName, ComposeTheme> = {
  "warm-cafe": {
    background: "#2C1810",
    surface: "#3D2418",
    ink: "#F5E6D3",
    inkMuted: "#C4A882",
    accent: "#C4783A",
    accentInk: "#1A0E08",
    fontDisplay: "Noto Serif",
    fontBody: "Noto Sans",
  },
  "bakery-cream": {
    background: "#F6EBD9",
    surface: "#FFEFD4",
    ink: "#3B2A1A",
    inkMuted: "#7A5C40",
    accent: "#A3471A",
    accentInk: "#FFF8EE",
    fontDisplay: "Liberation Serif",
    fontBody: "Liberation Sans",
  },
  "midnight-neon": {
    background: "#0B1020",
    surface: "#161B33",
    ink: "#E8F0FF",
    inkMuted: "#8BA0C8",
    accent: "#39FFB6",
    accentInk: "#04140E",
    fontDisplay: "Exo 2",
    fontBody: "Noto Sans",
  },
  "clean-corporate": {
    background: "#F4F6F8",
    surface: "#FFFFFF",
    ink: "#1A2332",
    inkMuted: "#5B677A",
    accent: "#0B5CAB",
    accentInk: "#FFFFFF",
    fontDisplay: "Liberation Sans",
    fontBody: "Liberation Sans",
  },
  "earthy-market": {
    background: "#F3EDE3",
    surface: "#E7D9C4",
    ink: "#2F261C",
    inkMuted: "#6B5A45",
    accent: "#4F7A3E",
    accentInk: "#F4F8F0",
    fontDisplay: "Noto Serif",
    fontBody: "Noto Sans",
  },
  "ocean-calm": {
    background: "#E7F1F5",
    surface: "#D2E4EC",
    ink: "#16323F",
    inkMuted: "#4A6B78",
    accent: "#1B7A8F",
    accentInk: "#F2FBFC",
    fontDisplay: "Noto Sans",
    fontBody: "Noto Sans",
  },
  "bold-retail": {
    background: "#111111",
    surface: "#1C1C1C",
    ink: "#F5F5F5",
    inkMuted: "#A3A3A3",
    accent: "#E10600",
    accentInk: "#FFFFFF",
    fontDisplay: "Rubik",
    fontBody: "Noto Sans",
  },
  "cinema-noir": {
    background: "#0D0D0D",
    surface: "#1A1A1A",
    ink: "#F2EDE4",
    inkMuted: "#A3988A",
    accent: "#D4AF37",
    accentInk: "#14110A",
    fontDisplay: "Noto Serif",
    fontBody: "Noto Sans",
  },
  "pastel-kiosk": {
    background: "#F6F0FA",
    surface: "#EDE4F5",
    ink: "#3A2B4A",
    inkMuted: "#6E5B80",
    accent: "#E07A9A",
    accentInk: "#2A1018",
    fontDisplay: "Rubik",
    fontBody: "Noto Sans",
  },
  "forest-lodge": {
    background: "#1B2A22",
    surface: "#24352C",
    ink: "#E6EFE8",
    inkMuted: "#9BB5A4",
    accent: "#C4A35A",
    accentInk: "#1A1408",
    fontDisplay: "Noto Serif",
    fontBody: "Noto Sans",
  },
  "sunset-promo": {
    background: "#2A1210",
    surface: "#3A1B16",
    ink: "#FFE8D6",
    inkMuted: "#D4A090",
    accent: "#FF6B35",
    accentInk: "#1A0806",
    fontDisplay: "Exo 2",
    fontBody: "Liberation Sans",
  },
  "monochrome-ink": {
    background: "#F7F7F5",
    surface: "#EBEBE8",
    ink: "#161616",
    inkMuted: "#5C5C5C",
    accent: "#161616",
    accentInk: "#F7F7F5",
    fontDisplay: "Noto Serif",
    fontBody: "Noto Sans",
  },
  "sport-arena": {
    background: "#0E1A2B",
    surface: "#16263C",
    ink: "#F4F7FA",
    inkMuted: "#9BB0C7",
    accent: "#FFB800",
    accentInk: "#1A1400",
    fontDisplay: "Rubik",
    fontBody: "Liberation Sans",
  },
  "healthcare-soft": {
    background: "#F3F8F7",
    surface: "#E4F0EE",
    ink: "#1C3330",
    inkMuted: "#4F6E69",
    accent: "#1B6B61",
    accentInk: "#F4FFFC",
    fontDisplay: "Noto Sans",
    fontBody: "Noto Sans",
  },
  "festival-pop": {
    background: "#1A1030",
    surface: "#2A1A48",
    ink: "#FFF5FB",
    inkMuted: "#C9B3D9",
    accent: "#FF3CAC",
    accentInk: "#1A0510",
    fontDisplay: "Exo 2",
    fontBody: "Rubik",
  },
  "luxury-gold": {
    background: "#16120C",
    surface: "#221C14",
    ink: "#F3E6C8",
    inkMuted: "#B8A27A",
    accent: "#C9A227",
    accentInk: "#1A1508",
    fontDisplay: "Noto Serif",
    fontBody: "Noto Serif",
  },
};

export const THEME_GUIDANCE = "Pick one theme per deck; use accent for one element per page.";

export function themeOf(name: string): ComposeTheme {
  if (!isThemeName(name)) {
    const err = new Error(`Frame.theme must be ${THEME_NAMES.join("|")}`) as Error & { code: string };
    err.code = "usage_error";
    throw err;
  }
  return THEMES[name];
}

/** Role type wish as a fraction of the shorter canvas edge. */
export const ROLE_FONT_SCALE = 0.12;
/** Single-Text `scale: "display-xl"` wish as a fraction of the shorter canvas edge. */
export const DISPLAY_XL_FONT_SCALE = 0.6;

/** 1920×1080 reference canvas for comparing strip-Frame ramps. */
export const REFERENCE_CANVAS = { width: 1920, height: 1080 } as const;

export function rampRoot(canvasWidth: number, canvasHeight: number): number {
  return Math.min(canvasWidth, canvasHeight);
}

export function spaceScale(canvasWidth: number, canvasHeight: number): SpaceScale {
  const root = rampRoot(canvasWidth, canvasHeight);
  const s = Math.max(8, Math.round(root / 68));
  return {
    xs: Math.max(4, Math.round(s / 2)),
    s,
    m: Math.round(s * 1.5),
    l: s * 3,
    xl: s * 4,
  };
}

export function displayXlWish(canvasWidth: number, canvasHeight: number): number {
  return Math.max(64, Math.round(rampRoot(canvasWidth, canvasHeight) * DISPLAY_XL_FONT_SCALE));
}

export function typeRamp(canvasWidth: number, canvasHeight: number): TypeRamp {
  const root = rampRoot(canvasWidth, canvasHeight);
  const display = Math.max(64, Math.round(root * ROLE_FONT_SCALE));
  const title = Math.max(48, Math.round(root * 0.08));
  const body = Math.max(32, Math.round(root * 0.042));
  const caption = Math.max(22, Math.round(root * 0.03));
  const min = (wish: number) => Math.max(18, Math.round(wish * 0.5));
  return {
    display: { wish: display, min: min(display), weight: "700" },
    title: { wish: title, min: min(title), weight: "700" },
    body: { wish: body, min: min(body), weight: "400" },
    caption: { wish: caption, min: min(caption), weight: "400" },
    label: { wish: caption, min: min(caption), weight: "700" },
  };
}

export function resolveSpace(token: SpaceToken | undefined, scale: SpaceScale, path: string): number {
  if (token == null) return 0;
  if (!(SPACES as readonly string[]).includes(token)) {
    const err = new Error(`${path} spacing must be ${SPACES.join("|")}, got ${token}`) as Error & { code: string };
    err.code = "usage_error";
    throw err;
  }
  return scale[token];
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
