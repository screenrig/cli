import type { SuccessEnvelope, Warning } from "./envelope.js";

/** Whole prepaid credits. Remaining below this value is `credits_low`. */
export const CREDITS_LOW_THRESHOLD = 1000;
export const CREDITS_LOW_CODE = "credits_low";
export const CREDITS_REMAINING_HEADER = "screenrig-credits-remaining";

const remainingByOwner = new WeakMap<object, number>();

export function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) {
      return value;
    }
  }
  return undefined;
}

/** Integer prepaid credits. Missing, negative, fractional, or unparseable values are absent. */
export function parseCreditsInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || !Number.isSafeInteger(value) || value < 0) {
      return undefined;
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function parseCreditsRemainingHeader(headers: Record<string, string> | undefined): number | undefined {
  return parseCreditsInteger(headerValue(headers, CREDITS_REMAINING_HEADER));
}

export function creditsLowWarning(remaining: number | undefined): Warning | undefined {
  if (remaining === undefined || remaining >= CREDITS_LOW_THRESHOLD) {
    return undefined;
  }
  return {
    code: CREDITS_LOW_CODE,
    message: `Remaining prepaid credit is ${remaining}, below 1000 credits.`,
  };
}

export function creditsLowWarnings(remaining: number | undefined): Warning[] {
  const warning = creditsLowWarning(remaining);
  return warning ? [warning] : [];
}

export function observeCreditsRemaining(owner: object, remaining: number | undefined): void {
  if (remaining === undefined) {
    return;
  }
  remainingByOwner.set(owner, remaining);
}

export function observedCreditsRemaining(owner: object): number | undefined {
  return remainingByOwner.get(owner);
}

export function applyCreditsLowToSuccess<T extends { envelope: SuccessEnvelope<unknown>; human: string }>(
  result: T,
  remaining: number | undefined,
): T {
  const warning = creditsLowWarning(remaining);
  if (!warning) {
    return result;
  }
  const warnings = result.envelope.warnings.some((item) => item.code === CREDITS_LOW_CODE)
    ? result.envelope.warnings
    : [...result.envelope.warnings, warning];
  if (!result.human) {
    return { ...result, envelope: { ...result.envelope, warnings } };
  }
  const line = `warning: ${warning.message}`;
  const human = result.human.includes(line) ? result.human : `${result.human}\n${line}`;
  return { ...result, envelope: { ...result.envelope, warnings }, human };
}
