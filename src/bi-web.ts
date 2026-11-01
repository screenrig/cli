import { readAuthoringText } from "./authoring-input.js";
import { usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";

// Signed-in web pages (BI kind web): a web connection is a service account of a
// site that shows a dashboard behind a sign-in, or a cookie jar exported from a
// signed-in browser; a web view is one page of it. Parsers and readers of its
// inputs; the commands that use them are in bi.ts.

/** BIConnectionConfig.login_mode (vendor/openapi.yaml). */
export const BI_WEB_LOGIN_MODES = ["auto", "steps", "none"] as const;
export type BiWebLoginMode = (typeof BI_WEB_LOGIN_MODES)[number];
/** BIWebStep.action. */
const STEP_ACTIONS = ["goto", "fill", "click", "press", "wait_for", "wait_ms"] as const;
const STEPS_MAX = 30;
const COOKIES_MAX = 100;
/** The sign-in script and the cookie jar are small documents; a jar is at most 48 KiB once sealed. */
const DOCUMENT_MAX_BYTES = 256 * 1024;
const SECRET_FILE_MAX_BYTES = 16 * 1024;
const PASSWORD_MAX_CHARACTERS = 4096;
const TOTP_MAX_CHARACTERS = 1024;
const SELECTOR_MAX_CHARACTERS = 512;

export interface BiWebStep { action: string; selector?: string; value?: string; url?: string; ms?: number }
export interface BiWebCookie { name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }
export interface BiWebSession {
  state: string; cookies: number; cookies_updated_at: string | null; last_login_at: string | null; login_failures: number; retry_at: string | null;
}

/** --login-url: the https address of the site's sign-in page; the server checks the host is public. */
export function biWebLoginUrl(value: string): string {
  const text = value.trim();
  let protocol: string | undefined;
  try { protocol = new URL(text).protocol; } catch { /* reported below */ }
  if (protocol !== "https:" || [...text].length > 2048 || /[\s\p{Cc}]/u.test(text)) {
    throw usageError("--login-url takes the https address of the site's sign-in page, such as https://login.example.com/signin.");
  }
  return text;
}

/** --wait-for and --clip: a CSS selector of 1 to 512 characters. */
export function biCssSelector(flag: string): (value: string) => string {
  return (value) => {
    const text = value.trim();
    if (!text || [...text].length > SELECTOR_MAX_CHARACTERS || /\p{Cc}/u.test(text)) {
      throw usageError(`${flag} takes a CSS selector of 1 to ${SELECTOR_MAX_CHARACTERS} characters, such as "#dashboard .loaded".`);
    }
    return text;
  };
}

/** --wait-ms: milliseconds to wait once the page is ready, 0 to 10000; 0 removes the wait on an update. */
export function biWaitMs(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) > 10_000) throw usageError("--wait-ms takes whole milliseconds from 0 to 10000.");
  return value;
}

/** The text of a secret file without the line ending an editor or a shell leaves; spaces inside are the secret's. */
function secretText(text: string, where: string, what: string, max: number): string {
  const secret = text.replace(/(?:\r?\n)+$/, "");
  if (!secret.trim()) throw usageError(`${where} holds no ${what}.`);
  if (/\p{Cc}/u.test(secret)) throw usageError(`${where} must hold only the ${what}: one line of text.`);
  if ([...secret].length > max) throw usageError(`The ${what} in ${where} is longer than ${max} characters.`);
  return secret;
}

/** --password-file: the service account's password. Spaces are allowed; a trailing line ending is dropped. */
export async function readWebPassword(file: string, runtime: CliRuntime): Promise<string> {
  return secretText(await readAuthoringText(file, runtime, SECRET_FILE_MAX_BYTES), file === "-" ? "stdin" : file, "password", PASSWORD_MAX_CHARACTERS);
}

/** --totp-file: the base32 key of the account's authenticator app, or its otpauth://totp address. */
export async function readTotpSeed(file: string, runtime: CliRuntime): Promise<string> {
  return secretText(await readAuthoringText(file, runtime, SECRET_FILE_MAX_BYTES), file === "-" ? "stdin" : file, "authenticator key", TOTP_MAX_CHARACTERS);
}

async function readJson(file: string, flag: string, runtime: CliRuntime): Promise<unknown> {
  const text = await readAuthoringText(file, runtime, DOCUMENT_MAX_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw usageError(`${flag} must hold valid JSON.`);
  }
}

/** --steps: the sign-in script, a JSON array of up to 30 steps. A value may hold {{username}}, {{password}} and {{otp}}; never the secret itself. */
export async function readWebSteps(file: string, runtime: CliRuntime): Promise<BiWebStep[]> {
  const parsed = await readJson(file, "--steps", runtime);
  if (!Array.isArray(parsed) || !parsed.length) throw usageError(`--steps must hold a JSON array of 1 to ${STEPS_MAX} steps: [{"action":"goto","url":"https://…"},{"action":"fill","selector":"#user","value":"{{username}}"}].`);
  if (parsed.length > STEPS_MAX) throw usageError(`--steps holds ${parsed.length} steps; a sign-in script has at most ${STEPS_MAX}.`);
  parsed.forEach((step, index) => {
    const action = step && typeof step === "object" && !Array.isArray(step) ? (step as { action?: unknown }).action : undefined;
    if (typeof action !== "string" || !(STEP_ACTIONS as readonly string[]).includes(action)) {
      throw usageError(`--steps[${index}] needs an action: ${STEP_ACTIONS.join(", ")}.`);
    }
  });
  return parsed as BiWebStep[];
}

/**
 * The cookies of a jar exported from a signed-in browser: a JSON array (a cookie
 * extension's export) or an object with a cookies array (Playwright's storage
 * state). Only the members the API takes are sent: an extension's hostOnly,
 * storeId and session members are dropped, expirationDate is read as expires, and
 * a cookie with no positive expiry is a session cookie.
 */
export function webCookies(parsed: unknown): BiWebCookie[] {
  const list = Array.isArray(parsed) ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { cookies?: unknown }).cookies) ? (parsed as { cookies: unknown[] }).cookies
    : undefined;
  if (!list) throw usageError("--cookies-file must hold a JSON array of cookies, or an object with a cookies array, as a browser extension or Playwright exports them.");
  if (list.length > COOKIES_MAX) throw usageError(`--cookies-file holds ${list.length} cookies; a jar has at most ${COOKIES_MAX}.`);
  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw usageError(`--cookies-file cookie ${index} is not an object.`);
    const cookie = entry as Record<string, unknown>;
    if (typeof cookie.name !== "string" || !cookie.name || typeof cookie.value !== "string" || typeof cookie.domain !== "string" || !cookie.domain) {
      throw usageError(`--cookies-file cookie ${index} needs a name, a value and the domain of the site (.example.com for every subdomain).`);
    }
    const expiry = [cookie.expires, cookie.expirationDate].find((value): value is number => typeof value === "number" && value > 0);
    return {
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      ...(typeof cookie.path === "string" && cookie.path ? { path: cookie.path } : {}),
      ...(expiry !== undefined ? { expires: Math.floor(expiry) } : {}),
      ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
      ...(typeof cookie.sameSite === "string" && cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    };
  });
}

/** --cookies-file: the jar, read and normalized. */
export async function readWebCookies(file: string, runtime: CliRuntime): Promise<BiWebCookie[]> {
  return webCookies(await readJson(file, "--cookies-file", runtime));
}

/** A web connection's sign-in and cookies as the lines of a read. */
export function webConnectionLines(connection: {
  config: { login_mode?: string; login_url?: string; username?: string; steps?: unknown[] };
  totp_secret?: { set: boolean };
  session?: BiWebSession;
}): string[] {
  const config = connection.config ?? {};
  const session = connection.session;
  return [
    `login: ${config.login_mode ?? "-"}${config.login_url ? ` at ${config.login_url}` : ""}`,
    ...(config.username ? [`user: ${config.username}`] : []),
    ...(config.steps?.length ? [`steps: ${config.steps.length}`] : []),
    `authenticator key: ${connection.totp_secret?.set ? "set" : "not set"}`,
    ...(session ? [`session: ${session.state}, ${session.cookies} cookie${session.cookies === 1 ? "" : "s"}${session.cookies_updated_at ? ` (updated ${session.cookies_updated_at})` : ""}${session.last_login_at ? `, last sign-in ${session.last_login_at}` : ""}${session.login_failures ? `, ${session.login_failures} refused sign-in${session.login_failures === 1 ? "" : "s"} in a row` : ""}${session.retry_at ? `, next sign-in not before ${session.retry_at}` : ""}`] : []),
  ];
}
