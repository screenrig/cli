export const ROLES = ["display", "title", "body", "caption", "label"] as const;
export type Role = (typeof ROLES)[number];
export const SPACES = ["xs", "s", "m", "l", "xl"] as const;
export type SpaceToken = (typeof SPACES)[number];
export const PINS = ["top", "bottom", "left", "right"] as const;
export type Pin = (typeof PINS)[number];

export type Align = "start" | "center" | "end" | "stretch";
export type Justify = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
export type TextAlign = "left" | "center" | "right";
export type ObjectFit = "cover" | "contain" | "fill";

export interface TextShadow {
  x: number;
  y: number;
  blur?: number;
  color: string;
}

export interface ComposeNode {
  type: string;
  width?: number;
  height?: number;
  background?: string;
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
  color?: string;
  textShadow?: TextShadow;
  src?: string;
  objectFit?: ObjectFit;
  [key: string]: unknown;
}

export interface ComposeFrame extends ComposeNode {
  type: "Frame";
  width: number;
  height: number;
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
