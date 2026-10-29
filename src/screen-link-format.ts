import type { ScreenLink, ScreenLinkSummary } from "./adapters/protocol.js";
import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";

/*
 * A screen link is the Player URL that opens one screen in a browser that keeps
 * no storage, such as a vMix or OBS browser source. It is a credential that
 * stays valid until the link is replaced or turned off: the URL is printed
 * only by `screen link show` and `screen link create`, under a sensitive label,
 * and never reaches the operation log. These are the pure rules; the handlers
 * are in screen-link.ts.
 */

const SCREEN_ID = /^(?:(?:stage|qa|development)_)?scr_[A-Za-z0-9_-]{1,64}$/;
const SCREEN_LINK_URL_MAX = 512;
const SCREEN_FRAGMENT_PATTERN = /^#screen=srsl_[A-Za-z0-9_-]{43}$/;

/** The screen id of `screen link ACTION <id>`: a screen id, never a path. */
export function screenLinkScreenId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`screen link ${command} requires <id>.`);
  if (!SCREEN_ID.test(value)) {
    throw usageError("A screen id looks like scr_ followed by letters, digits, - or _.", {
      command: "screenrig screen list",
      reason: "List this project's screens and their ids.",
    });
  }
  return value;
}

/**
 * Why a returned screen link url is unsafe to print, or undefined when it is a
 * Player URL that carries its secret only in the #screen= fragment. The reason
 * never repeats the URL.
 */
export function screenLinkUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "url is not a string.";
  if (value.length > SCREEN_LINK_URL_MAX) return `url is longer than ${SCREEN_LINK_URL_MAX} characters.`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "url is not a valid URL.";
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".localhost"));
  if (url.protocol !== "https:" && !localHttp) return "url is not HTTPS.";
  if (url.username || url.password) return "url carries credentials.";
  if (url.search) return "url carries a query.";
  if (url.pathname !== "/player/") return "url does not open the Player at /player/.";
  if (!SCREEN_FRAGMENT_PATTERN.test(url.hash)) return "url carries its secret outside the #screen= fragment.";
  return undefined;
}

/**
 * Drop an unsafe url from the answer, with a warning that names the screen and
 * the reason. A Read only credential's empty url with url_redacted true is kept
 * as returned.
 */
export function guardScreenLink(id: string, link: ScreenLink): { link: ScreenLink; warnings: Warning[] } {
  if (link.url === undefined || (link.url_redacted === true && link.url === "")) return { link, warnings: [] };
  const reason = link.url_redacted === true ? "url_redacted is true but url is not empty." : screenLinkUrlProblem(link.url);
  if (!reason) return { link, warnings: [] };
  const { url: _withheld, ...rest } = link;
  return {
    link: rest,
    warnings: [{
      code: "screen_link_url_withheld",
      message: `The url returned for the link of screen ${id} failed a safety check, so it is not shown: ${reason} The link itself is unchanged. Report the request_id with screenrig feedback bug.`,
    }],
  };
}

const READ_ONLY_URL = "URL: withheld from a Read only credential. A Manage sign-in (screenrig login --access manage) receives it.";

/** Every field except url, which is printed apart under its own sensitive label. */
export function screenLinkLines(id: string, link: ScreenLink | undefined): string[] {
  if (!link) return [];
  return [
    `screen: ${id}`,
    `hint: ${link.hint}`,
    `created_at: ${link.created_at}`,
    `last_used_at: ${link.last_used_at ?? "never"}`,
  ];
}

/** The url block for show and create. An empty or missing url is never printed as the link. */
export function screenLinkUrlLines(link: ScreenLink | undefined, withheld: boolean): string[] {
  if (!link) return [];
  if (link.url) {
    return ["", "Sensitive screen link URL (it opens this screen in a browser that keeps no storage, such as a vMix or OBS browser source; open it in one place)", `url: ${link.url}`];
  }
  if (withheld) return ["", "URL: withheld, see the warning."];
  if (link.url_redacted === true) return ["", READ_ONLY_URL];
  return ["", "URL: not returned."];
}

/** `screen show`'s line for the screen's link: on with its last four characters and last use, or nothing. */
export function screenLinkSummaryLines(link: ScreenLinkSummary | undefined): string[] {
  if (!link) return [];
  return [`Screen link: on (…${link.hint}), last opened ${link.last_used_at ?? "never"}`];
}

/** Map screen link problems to actionable guidance; exit codes stay status-derived (404 → 4, 409 → 5, 412 → 6). */
export function screenLinkProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  const problem = error.problem;
  if (problem.code === "screen_link_not_found") {
    return new CliError({
      ...problem,
      next: { command: `screenrig screen link create ${id}`, reason: "Create the screen's link, then print its URL with screenrig screen link show." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "resource_conflict" && /no paired Player/i.test(problem.detail)) {
    return new CliError({
      ...problem,
      next: { command: "screenrig screen pair CODE", reason: "Open the Player on the display once and pair it with the code it shows; then create the link." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "screen_archived") {
    return new CliError({
      ...problem,
      next: { command: `screenrig screen unarchive ${id}`, reason: "An archived screen takes no new link. Unarchive it first if it should play again." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "revision_conflict") {
    return new CliError({
      ...problem,
      next: { command: `screenrig screen show ${id}`, reason: "Read the screen's current revision, then rerun with --expect-rev REVISION if the change still applies." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "not_found") {
    return new CliError({
      ...problem,
      next: { command: "screenrig screen list", reason: "List this project's screens; a deleted screen does not come back." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

