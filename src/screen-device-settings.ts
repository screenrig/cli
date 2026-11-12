import type { ScreenDisplay, ScreenDisplayBrightness, ScreenDisplayIdle, ScreenKiosk, ScreenObservationDisplayOutput, ScreenPatch } from "./adapters/protocol.js";
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

/** display.output.mode (vendor/openapi.yaml ScreenDisplayOutput): auto, or WIDTHxHEIGHTxFPS with an optional p or i. */
const DISPLAY_OUTPUT_MODE = /^(auto|[1-9][0-9]{1,4}x[1-9][0-9]{1,4}x[1-9][0-9]{0,2}(\.[0-9]{1,3})?[pi]?)$/;

/** --mode MODE: auto or a video mode such as 3840x2160x60p or 1920x1080x59.94i. */
export function displayOutputModeOption(value: string): string {
  if (value.length > 24 || !DISPLAY_OUTPUT_MODE.test(value)) {
    throw usageError("--mode takes auto or a video mode WIDTHxHEIGHTxFPS with an optional p or i, such as 3840x2160x60p or 1920x1080x59.94i.");
  }
  return value;
}

/** The ScreenPatch that sets the video output mode (--mode) or clears the setting (--clear sends null). */
export function displayOutputPatch(mode: string | undefined, clear: boolean): ScreenPatch {
  if (clear === (mode !== undefined)) throw usageError("screen display-output requires --mode MODE or --clear.");
  return { display: { output: clear ? null : { mode: displayOutputModeOption(mode!) } } };
}

/** The ScreenPatch for display.cec: --on has the Player take the TV's input, --off keeps it from, --clear removes the setting. */
export function displayCecPatch(on: boolean, off: boolean, clear: boolean): ScreenPatch {
  if ([on, off, clear].filter(Boolean).length !== 1) throw usageError("screen display-cec requires exactly one of --on, --off or --clear.");
  return { display: { cec: clear ? null : { take_input: on } } };
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
  if (typeof display.output?.mode === "string") lines.push(`Display output: ${display.output.mode}`);
  if (typeof display.cec?.take_input === "boolean") lines.push(`Display CEC: ${display.cec.take_input ? "takes the TV's input (active source) at start and when display power turns on" : "does not take the TV's input"}`);
  return lines;
}

/**
 * The video output a Player reports (observation.display_output): the mode in
 * force and the modes it can set now, which `screen display-output --mode`
 * must pick from. Nothing for a Player that does not report it.
 */
export function displayOutputObservationLines(reported: ScreenObservationDisplayOutput | undefined): string[] {
  if (!reported) return [];
  const modes = Array.isArray(reported.modes) ? reported.modes.filter((mode) => typeof mode === "string") : [];
  const lines: string[] = [];
  if (typeof reported.mode === "string") lines.push(`Output mode in force: ${reported.mode}`);
  if (modes.length > 0) lines.push(`Output modes the Player can set (${modes.length}): ${modes.join(", ")}`);
  return lines;
}

/** The `Kiosk lock` line of screen show: the lock appears on a screen only while it is on. */
export function kioskLines(kiosk: ScreenKiosk | undefined): string[] {
  return kiosk && typeof kiosk.lock === "boolean" ? [`Kiosk lock: ${kiosk.lock ? "on" : "off"}`] : [];
}
