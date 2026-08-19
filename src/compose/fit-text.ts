import type { CanvasRenderingContext2D } from "@napi-rs/canvas";
import type { Role, TypeRamp } from "./types.js";

export function lineHeightFor(size: number): number {
  return Math.ceil(size * 1.25);
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
  size: number,
  maxWidth: number,
  maxHeight: number | null,
) {
  const font = `${weight} ${size}px "${family}"`;
  const lines = wrapLines(ctx, text, font, maxWidth);
  const lineHeight = lineHeightFor(size);
  const height = lines.length * lineHeight;
  const widthOk = lines.every((line) => ctx.measureText(line).width <= maxWidth + 0.5);
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
  },
): FittedText {
  const scale = args.ramp[args.role];
  const floor = scale.min;
  const wish = scale.wish;
  const weight = scale.weight;
  let cap = args.maxHeight;
  if (cap != null && cap < floor * 1.25) cap = null;
  let best: FittedText | null = null;
  let lo = floor;
  let hi = wish;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const trial = fits(ctx, args.text, args.family, weight, mid, args.maxWidth, cap);
    if (trial.ok) {
      best = { fontSize: mid, role: args.role, truncated: false, ...trial };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;
  const fallback = fits(ctx, args.text, args.family, weight, floor, args.maxWidth, null);
  const maxLines = cap != null ? Math.max(1, Math.floor(cap / fallback.lineHeight)) : fallback.lines.length;
  let lines = fallback.lines.slice(0, maxLines);
  const truncated = fallback.lines.length > maxLines;
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = `${last.replace(/…$/, "").replace(/\s+\S*$/, "")}…`;
  }
  return {
    fontSize: floor,
    role: args.role,
    lines,
    height: lines.length * fallback.lineHeight,
    lineHeight: fallback.lineHeight,
    font: fallback.font,
    truncated,
  };
}
