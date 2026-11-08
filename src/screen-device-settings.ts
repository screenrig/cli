import type { ScreenDisplay, ScreenDisplayBrightness, ScreenDisplayIdle, ScreenKiosk, ScreenPatch } from "./adapters/protocol.js";
import { usageError } from "./problems.js";

/** display.idle.after_s bounds (vendor/openapi.yaml ScreenDisplayIdle). */
export const DISPLAY_IDLE_AFTER_MIN_S = 30;
export const DISPLAY_IDLE_AFTER_MAX_S = 86_400;
/** display.idle.wake values, touch first: the order the backend stores them in. */
export const DISPLAY_IDLE_WAKE = ["touch", "presence"] as const;
export const DISPLAY_BRIGHTNESS_MODES = ["auto", "fixed"] as const;

/** --after SECONDS: a whole number from 30 to 86400. */
export function displayIdleAfterOption(value: string): string {
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(seconds) || seconds < DISPLAY_IDLE_AFTER_MIN_S || seconds > DISPLAY_IDLE_AFTER_MAX_S) {
    throw usageError(`--after takes a whole number of seconds from ${DISPLAY_IDLE_AFTER_MIN_S} to ${DISPLAY_IDLE_AFTER_MAX_S} (one day).`);
  }
  return value;
}

/** --wake: touch, presence or touch,presence. Returns the canonical spelling, touch first. */
export function displayIdleWakeOption(value: string): string {
  const names = value.split(",").map((item) => item.trim());
  const known = names.every((name) => (DISPLAY_IDLE_WAKE as readonly string[]).includes(name));
  if (!known || new Set(names).size !== names.length) {
    throw usageError("--wake takes touch, presence or touch,presence: what lights the glass again, each at most once.");
  }
  return DISPLAY_IDLE_WAKE.filter((name) => names.includes(name)).join(",");
}

/** The ScreenPatch that turns idle-dark on (--after with --wake) or off (--off sends null). */
export function displayIdlePatch(after: string | undefined, wake: string | undefined, off: boolean): ScreenPatch {
  if (off) {
    if (after !== undefined || wake !== undefined) throw usageError("screen display-idle takes --after with --wake, or --off, not both.");
    return { display: { idle: null } };
  }
  if (after === undefined || wake === undefined) throw usageError("screen display-idle requires --after and --wake together, or --off.");
  const idle: ScreenDisplayIdle = { after_s: Number(displayIdleAfterOption(after)), wake: displayIdleWakeOption(wake).split(",") as ScreenDisplayIdle["wake"] };
  return { display: { idle } };
}

/** The ScreenPatch that sets the brightness mode. */
export function brightnessPatch(mode: string | undefined): ScreenPatch {
  if (mode === undefined || !(DISPLAY_BRIGHTNESS_MODES as readonly string[]).includes(mode)) {
    throw usageError("screen brightness requires --mode auto or fixed.");
  }
  return { display: { brightness: { mode: mode as ScreenDisplayBrightness["mode"] } } };
}

/** The ScreenPatch that pins the Player to the screen (on) or releases it (off). */
export function kioskLockPatch(on: boolean, off: boolean): ScreenPatch {
  if (on === off) throw usageError("screen kiosk-lock requires --on or --off.");
  return { kiosk: { lock: on } };
}

/** display.idle as one phrase: "dark after 300 s, wakes on touch or presence". */
export function displayIdleText(idle: ScreenDisplayIdle): string {
  return `dark after ${idle.after_s} s, wakes on ${idle.wake.join(" or ")}`;
}

/** The `Display idle` and `Display brightness` lines of screen show; nothing for a setting the screen lacks. */
export function displaySettingsLines(display: ScreenDisplay): string[] {
  const lines: string[] = [];
  const idle = display.idle;
  if (idle && Number.isSafeInteger(idle.after_s) && Array.isArray(idle.wake) && idle.wake.length > 0) lines.push(`Display idle: ${displayIdleText(idle)}`);
  const mode = display.brightness?.mode;
  if (mode === "auto" || mode === "fixed") lines.push(`Display brightness: ${mode}`);
  return lines;
}

/** The `Kiosk lock` line of screen show: the lock appears on a screen only while it is on. */
export function kioskLines(kiosk: ScreenKiosk | undefined): string[] {
  return kiosk && typeof kiosk.lock === "boolean" ? [`Kiosk lock: ${kiosk.lock ? "on" : "off"}`] : [];
}
