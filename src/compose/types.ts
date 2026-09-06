export const ROLES = ["display", "title", "body", "caption", "label"] as const;
export type Role = (typeof ROLES)[number];
export const TEXT_SCALES = ["display-xl"] as const;
export type TextScale = (typeof TEXT_SCALES)[number];
export const SPACES = ["xs", "s", "m", "l", "xl"] as const;
export type SpaceToken = (typeof SPACES)[number];
export const PINS = ["top", "bottom", "left", "right"] as const;
export type Pin = (typeof PINS)[number];
export const COLOR_TOKENS = ["accent", "ink", "inkMuted", "surface", "accentInk", "background"] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export const VIEWING_DISTANCES = ["near", "mid", "far"] as const;
export type ViewingDistance = (typeof VIEWING_DISTANCES)[number];
export const THEME_NAMES = [
  "warm-cafe",
  "bakery-cream",
  "midnight-neon",
  "clean-corporate",
  "earthy-market",
  "ocean-calm",
  "bold-retail",
  "cinema-noir",
  "pastel-kiosk",
  "forest-lodge",
  "sunset-promo",
  "monochrome-ink",
  "sport-arena",
  "healthcare-soft",
  "festival-pop",
  "luxury-gold",
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
export type TextAlign = "left" | "center" | "right";
export type ObjectFit = "cover" | "contain" | "fill";

export interface GradientStop {
  at: number;
  color: string;
}

export interface LinearGradient {
  type: "linear";
  angle: number;
  stops: GradientStop[];
}

export type Paint = string | LinearGradient;

export interface ComposeTheme {
  background: string;
  surface: string;
  ink: string;
  inkMuted: string;
  accent: string;
  accentInk: string;
  fontDisplay: string;
  fontBody: string;
}

export interface TextShadow {
  x: number;
  y: number;
  blur?: number;
  color: string;
}

export type TextWeight = "regular" | "bold";

export interface TextOutline {
  width: number;
  color: string;
}

export interface TextArc {
  degrees: number;
}

export interface TextTexture {
  src: string;
  objectFit?: ObjectFit;
}

export interface TextEffects {
  weight?: TextWeight;
  italic?: boolean;
  underline?: boolean;
  outline?: TextOutline;
  shadow?: TextShadow;
  arc?: TextArc;
  texture?: TextTexture;
}

export type TextPlate =
  | "auto"
  | "none"
  | {
      color: string;
      radius?: SpaceToken;
      padding?: SpaceToken;
    };

export interface ImageFocal {
  x: number;
  y: number;
}

export interface ComposeNode {
  type: string;
  width?: number;
  height?: number;
  background?: Paint;
  fontFamily?: string;
  direction?: "row" | "column";
  padding?: SpaceToken;
  gap?: SpaceToken;
  radius?: SpaceToken;
  pin?: Pin;
  flex?: number;
  align?: Align | TextAlign;
  justify?: Justify;
  children?: ComposeNode[];
  text?: string;
  role?: Role;
  scale?: TextScale;
  color?: string;
  textShadow?: TextShadow;
  effects?: TextEffects;
  plate?: TextPlate;
  letterSpacing?: number;
  src?: string;
  objectFit?: ObjectFit;
  focal?: ImageFocal;
  name?: string;
  size?: number;
  thickness?: number;
  length?: number;
  style?: "solid" | "dotted";
  theme?: string;
  [key: string]: unknown;
}

export interface ComposeFrame extends ComposeNode {
  type: "Frame";
  width: number;
  height: number;
  theme?: ThemeName | string;
  viewing?: ViewingDistance;
}

export interface SpaceScale {
  xs: number;
  s: number;
  m: number;
  l: number;
  xl: number;
}

export interface TypeRoleRamp {
  wish: number;
  min: number;
  weight: "400" | "700";
}

export type TypeRamp = Record<Role, TypeRoleRamp>;
