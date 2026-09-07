export const REGIONS = [
  "fullpage",
  "left",
  "right",
  "left-third",
  "middle-third",
  "right-third",
  "middle-half",
  "top-half",
  "bottom-half",
  "top",
  "bottom",
] as const;
export type RegionName = (typeof REGIONS)[number];

export const ENTER_TYPES = [
  "fade-up",
  "fade-down",
  "fade-left",
  "fade-right",
  "fade-in",
  "zoom-in",
  "zoom-out",
] as const;
export type EnterType = (typeof ENTER_TYPES)[number];

export const ALIGN = ["left", "center", "right"] as const;
export type Align = (typeof ALIGN)[number];

export const VALIGN = ["auto", "top", "center", "bottom"] as const;
export type Valign = (typeof VALIGN)[number];

export const SPIN_DIR = ["cw", "ccw"] as const;
export const DRIFT_ZOOM = ["in", "out"] as const;
export const DRIFT_DIR = ["left", "right", "up", "down", "none"] as const;
export const SPEED = ["slow", "medium", "fast"] as const;
export const VIEWING_DISTANCES = ["near", "mid", "far"] as const;
export type ViewingDistance = (typeof VIEWING_DISTANCES)[number];

export const TYPE_ROLES = ["eyebrow", "title", "subtitle", "text", "footer", "card", "small", "table"] as const;
export type TypeRole = (typeof TYPE_ROLES)[number];

export const LOGO_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
export type LogoCorner = (typeof LOGO_CORNERS)[number];

export const CARD_FITS = ["region", "ink"] as const;
export type CardFit = (typeof CARD_FITS)[number];

export const LOGO_INSET = 32;
export const LOGO_MAX = { width: 200, height: 100 } as const;
export const CARD_INK_PAD = 24;

export const WIRE_PRIMITIVES = ["image", "video", "iframe", "application"] as const;
export type WirePrimitive = (typeof WIRE_PRIMITIVES)[number];

/** Playlist PrimitiveEnter, field-for-field. */
export interface PrimitiveEnter {
  type: EnterType;
  stagger?: number;
}

/** Playlist PrimitiveMotionSpin, field-for-field. */
export interface PrimitiveMotionSpin {
  type: "spin";
  direction: (typeof SPIN_DIR)[number];
  speed: (typeof SPEED)[number];
}

/** Playlist PrimitiveMotionDrift, field-for-field. */
export interface PrimitiveMotionDrift {
  type: "drift";
  zoom: (typeof DRIFT_ZOOM)[number];
  direction: (typeof DRIFT_DIR)[number];
  speed: (typeof SPEED)[number];
}

export type PrimitiveMotion = PrimitiveMotionSpin | PrimitiveMotionDrift;

/** Playlist PlaylistRect with integer fields. */
export interface PlaylistRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardItem {
  title: string;
  subtitle?: string | null;
  text?: string | null;
  price?: string | null;
  image?: string | null;
}

/** Drop shadow. Optional `blur` is 0–32 px; omit is 0 (unblurred offset fill). `"none"` disables the automatic media shadow. */
export type LayerShadow = "none" | { x: number; y: number; color: string; blur?: number };

/** Stroke around glyphs. Off unless set. Width is 0.5–12 px. */
export interface LayerOutline {
  width: number;
  color: string;
}

export interface TableBlock {
  columns: string[];
  rows: string[][];
}

export type LayerBlock =
  | { role: "eyebrow" | "title" | "subtitle" | "text" | "footer"; text: string }
  | { role: "image"; src: string }
  | { role: "placeholder"; kind: "video" | "iframe" | "application"; src: string; label: string }
  | { role: "cards"; items: CardItem[] }
  | ({ role: "table" } & TableBlock);

export interface LayerMedia {
  type: WirePrimitive;
  src: string;
  rect?: PlaylistRect;
}

export interface LayerSpec {
  id: string;
  region: RegionName | "background" | "logo";
  z: number;
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
  pad: number;
  fill: string | null;
  ink: string | null;
  cardFit: CardFit | null;
  surface: string;
  shadow: LayerShadow | null;
  outline: LayerOutline | null;
  overMedia: boolean;
  align: Align;
  valign: Valign;
  font: string | null;
  text: string;
  muted: string;
  brand: string;
  root: number;
  viewing: ViewingDistance;
  enter: PrimitiveEnter | null;
  motion: PrimitiveMotion | null;
  media: LayerMedia | null;
  blocks: LayerBlock[];
  logoCorner?: LogoCorner | null;
}

export interface PageSpec {
  id: string;
  layers: LayerSpec[];
}

export interface ComposeDocument {
  canvas: { width: number; height: number };
  name: string | null;
  viewing: ViewingDistance;
  pages: PageSpec[];
}

export interface LayerManifest {
  id: string;
  file?: string;
  z: number;
  rect: PlaylistRect;
  enter?: PrimitiveEnter;
  motion?: PrimitiveMotion;
  media?: LayerMedia;
  overflow?: boolean;
}

export interface PageManifest {
  version: 1;
  canvas: { width: number; height: number };
  layers: LayerManifest[];
}
