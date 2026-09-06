import type { CanvasRenderingContext2D } from "@napi-rs/canvas";
import { cssFont } from "./fonts.js";
import type { Role, TypeRamp } from "./types.js";

export function lineHeightFor(size: number): number {
  return Math.ceil(size * 1.25);
}

export function underlineThickness(size: number): number {
  return Math.max(1, Math.round(size * 0.06));
}

export function arcSagitta(textWidth: number, degrees: number): number {
  const theta = (degrees * Math.PI) / 180;
  if (!Number.isFinite(textWidth) || textWidth <= 0 || Math.abs(theta) < 1e-6) return 0;
  const radius = textWidth / Math.abs(theta);
  return radius * (1 - Math.cos(Math.abs(theta) / 2));
}

export function wrapLines(ctx: CanvasRenderingContext2D, text: string, font: string, maxWidth: number): string[] {
  ctx.font = font;
  const paragraphs = String(text).split("\n");
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.length === 0 ? [""] : paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const trial = current ? `${current} ${word}` : word;
      if (ctx.measureText(trial).width <= maxWidth || current === "") current = trial;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

function fits(
  ctx: CanvasRenderingContext2D,
  text: string,
  family: string,
  weight: string,
  italic: boolean,
  size: number,
  maxWidth: number,
  maxHeight: number | null,
  outlineWidth: number,
  underline: boolean,
  arcDegrees: number | undefined,
) {
  const font = cssFont(weight, size, family, italic);
  const wrapWidth = Math.max(1, maxWidth - outlineWidth);
  const lines = arcDegrees != null ? [String(text)] : wrapLines(ctx, text, font, wrapWidth);
  ctx.font = font;
  const lineHeight = lineHeightFor(size);
  const extra = outlineWidth + (underline ? underlineThickness(size) + 2 : 0);
  const longest = Math.max(0, ...lines.map((line) => ctx.measureText(line).width));
  const sagitta = arcDegrees != null ? arcSagitta(longest, arcDegrees) : 0;
  const height = lines.length * lineHeight + extra + sagitta;
  const widthOk = lines.every((line) => ctx.measureText(line).width + outlineWidth <= maxWidth + 0.5);
  const heightOk = maxHeight == null || height <= maxHeight + 0.5;
  return { ok: widthOk && heightOk, lines, height, lineHeight, font };
}

export interface FittedText {
  fontSize: number;
  role: Role;
  lines: string[];
  height: number;
  lineHeight: number;
  font: string;
  truncated: boolean;
}

export function fitType(
  ctx: CanvasRenderingContext2D,
  args: {
    text: string;
    family: string;
    ramp: TypeRamp;
    role: Role;
    maxWidth: number;
    maxHeight: number | null;
    weight?: string;
    italic?: boolean;
    outlineWidth?: number;
    underline?: boolean;
    arcDegrees?: number;
    minXHeight?: number;
  },
): FittedText {
  const scale = args.ramp[args.role];
  const xHeightFloor = args.minXHeight != null ? Math.ceil(args.minXHeight / 0.52) : 0;
  const floor = Math.max(scale.min, xHeightFloor);
  const wish = scale.wish;
  const weight = args.weight ?? scale.weight;
  const italic = args.italic === true;
  const outlineWidth = args.outlineWidth ?? 0;
  const underline = args.underline === true;
  const trialArgs = [args.text, args.family, weight, italic] as const;
  let cap = args.maxHeight;
  if (cap != null && cap < floor * 1.25) cap = null;
  let best: FittedText | null = null;
  let lo = floor;
  let hi = wish;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = fits(ctx, ...trialArgs, mid, args.maxWidth, cap, outlineWidth, underline, args.arcDegrees);
    if (trial.ok) {
      best = { fontSize: mid, role: args.role, truncated: false, ...trial };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;
  const fallback = fits(ctx, ...trialArgs, floor, args.maxWidth, null, outlineWidth, underline, args.arcDegrees);
  const maxLines = cap != null ? Math.max(1, Math.floor(cap / fallback.lineHeight)) : fallback.lines.length;
  let lines = args.arcDegrees != null ? fallback.lines.slice(0, 1) : fallback.lines.slice(0, maxLines);
  const truncated = fallback.lines.length > lines.length;
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = `${last.replace(/…$/, "").replace(/\s+\S*$/, "")}…`;
  }
  ctx.font = fallback.font;
  const longest = Math.max(0, ...lines.map((line) => ctx.measureText(line).width));
  const extra = outlineWidth + (underline ? underlineThickness(floor) + 2 : 0);
  const sagitta = args.arcDegrees != null ? arcSagitta(longest, args.arcDegrees) : 0;
  return {
    fontSize: floor,
    role: args.role,
    lines,
    height: lines.length * fallback.lineHeight + extra + sagitta,
    lineHeight: fallback.lineHeight,
    font: fallback.font,
    truncated,
  };
}
