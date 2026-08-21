import { ROLES, SPACES, type Role, type SpaceScale, type SpaceToken, type TypeRamp } from "./types.js";

export { PINS, ROLES, SPACES } from "./types.js";

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

export function typeRamp(canvasWidth: number, canvasHeight: number): TypeRamp {
  const root = rampRoot(canvasWidth, canvasHeight);
  const display = Math.max(64, Math.round(root * 0.12));
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
