import type { SuccessEnvelope, Warning } from "./envelope.js";

/** Whole prepaid credits. Remaining below this value is `credits_low`. */
export const CREDITS_LOW_THRESHOLD = 1000;
export const CREDITS_LOW_CODE = "credits_low";
export const CREDITS_REMAINING_HEADER = "screenrig-credits-remaining";
/** The server's own low-credit verdict; under launch terms an empty free balance is not low. */
export const CREDITS_LOW_HEADER = "screenrig-credits-low";

/** What one response said about credit: the balance, and whether the server calls it low. */
export interface CreditsObservation {
  remaining: number;
  /** Absent when an older server sent no ScreenRig-Credits-Low header. */
  low?: boolean;
}

const observedByOwner = new WeakMap<object, CreditsObservation>();

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

/** `true` or `false` from ScreenRig-Credits-Low; anything else, including absence, is unknown. */
export function parseCreditsLowHeader(headers: Record<string, string> | undefined): boolean | undefined {
  const value = headerValue(headers, CREDITS_LOW_HEADER)?.trim().toLowerCase();
  return value === "true" ? true : value === "false" ? false : undefined;
}

/** Remaining and the low verdict from one response's headers, or undefined without a balance. */
export function parseCreditsHeaders(headers: Record<string, string> | undefined): CreditsObservation | undefined {
  const remaining = parseCreditsRemainingHeader(headers);
  if (remaining === undefined) return undefined;
  const low = parseCreditsLowHeader(headers);
  return low === undefined ? { remaining } : { remaining, low };
}

/**
 * Warn when the server says credit is low. Only a response without the
 * ScreenRig-Credits-Low header (an older server) falls back to remaining
 * below 1000.
 */
export function creditsLowWarning(credits: CreditsObservation | number | undefined): Warning | undefined {
  if (credits === undefined) return undefined;
  const { remaining, low } = typeof credits === "number" ? { remaining: credits, low: undefined } : credits;
  if (!(low ?? remaining < CREDITS_LOW_THRESHOLD)) return undefined;
  return {
    code: CREDITS_LOW_CODE,
    message: `Remaining prepaid credit is ${remaining}, below 1000 credits.`,
  };
}

export function creditsLowWarnings(credits: CreditsObservation | number | undefined): Warning[] {
  const warning = creditsLowWarning(credits);
  return warning ? [warning] : [];
}

export function observeCreditsRemaining(owner: object, credits: CreditsObservation | number | undefined): void {
  if (credits === undefined) {
    return;
  }
  observedByOwner.set(owner, typeof credits === "number" ? { remaining: credits } : credits);
}

export function observedCreditsRemaining(owner: object): CreditsObservation | undefined {
  return observedByOwner.get(owner);
}

export function applyCreditsLowToSuccess<T extends { envelope: SuccessEnvelope<unknown>; human: string }>(
  result: T,
  credits: CreditsObservation | number | undefined,
): T {
  const warning = creditsLowWarning(credits);
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
