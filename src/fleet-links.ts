import type { Warning } from "./envelope.js";
import { CliError, usageError } from "./problems.js";
import type { FleetLink } from "./adapters/protocol.js";
import { isResourceID } from "./generated/resource-ids.js";
import { normalizeInstant } from "./screen-control.js";
import { SCREEN_TAGS_MAX, screenTagList } from "./screen-fleet.js";

/** Backend FleetLink.id shape (vendor/openapi.yaml). */
export const FLEET_LINK_ID_PATTERN = /^(?:(?:stage|qa|development)_)?flk_[A-Za-z0-9_-]{1,64}$/;
export const FLEET_LINKS_MAX = 50;
export const FLEET_LINK_LABEL_MAX = 80;
export const FLEET_LINK_MAX_SCREENS = 10000;
const FLEET_LINK_URL_MAX = 512;
const FLEET_FRAGMENT_PATTERN = /^#fleet=srfl_[A-Za-z0-9_-]{43}$/;

export function fleetLinkId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`fleet-links ${command} requires <id>.`);
  if (!FLEET_LINK_ID_PATTERN.test(value)) {
    throw usageError("A fleet link id looks like flk_ followed by letters, digits, - or _.", {
      command: "screenrig fleet-links list",
      reason: "List this project's fleet links and their ids.",
    });
  }
  return value;
}

/** The link's display name (FleetLink.label): 1 to 80 characters after trimming, no controls. */
export function fleetLinkName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > FLEET_LINK_LABEL_MAX || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw usageError(`--name must contain 1 to ${FLEET_LINK_LABEL_MAX} characters without controls.`);
  }
  return trimmed;
}

/** Repeatable --tag; each value may also list comma-separated tags. Returns the accumulated list joined by commas. */
export function fleetLinkTags(value: string, previous?: string): string {
  const tags = [...(previous ? previous.split(",") : []), ...screenTagList(value, "--tag")];
  if (new Set(tags).size !== tags.length) throw usageError("--tag lists a tag more than once.");
  if (tags.length > SCREEN_TAGS_MAX) throw usageError(`--tag accepts at most ${SCREEN_TAGS_MAX} tags.`);
  return tags.join(",");
}

export function fleetLinkPlaylistId(value: string): string {
  if (!isResourceID(value, "playlist")) {
    throw usageError("--playlist-id must be a playlist id (pl_…).", {
      command: "screenrig playlist list",
      reason: "List this project's playlists and their ids.",
    });
  }
  return value;
}

export function fleetLinkMaxScreens(value: string): string {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > FLEET_LINK_MAX_SCREENS) {
    throw usageError(`--max-screens must be a whole number from 1 to ${FLEET_LINK_MAX_SCREENS}.`);
  }
  return value;
}

/**
 * --expires-at: an RFC 3339 date-time with seconds and a zone, sent as the UTC
 * instant it names. A time already past is allowed: the link expires at once.
 */
export function fleetLinkExpiresAt(value: string): string {
  const instant = normalizeInstant(value);
  if (instant === undefined) {
    throw usageError("--expires-at takes an RFC 3339 time with seconds and a zone, such as 2026-12-31T23:59:59Z or 2026-12-31T18:00:00-05:00.");
  }
  return instant;
}

/**
 * Why a returned fleet link url is unsafe to print, or undefined when it is a
 * Player URL that carries its secret only in the #fleet= fragment. The reason
 * never repeats the URL.
 */
export function fleetLinkUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "url is not a string.";
  if (value.length > FLEET_LINK_URL_MAX) return `url is longer than ${FLEET_LINK_URL_MAX} characters.`;
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
  if (!FLEET_FRAGMENT_PATTERN.test(url.hash)) return "url carries its secret outside the #fleet= fragment.";
  return undefined;
}

function urlWithheldWarning(id: string, reason: string): Warning {
  return {
    code: "fleet_link_url_withheld",
    message: `The url returned for fleet link ${id} failed a safety check, so it is not shown: ${reason} The link itself is unchanged. Report the request_id with screenrig feedback bug.`,
  };
}

/**
 * Drop an unsafe url from one link, with a warning that names the link and the
 * reason. A Read only credential's empty url with url_redacted true is kept as
 * returned.
 */
export function guardFleetLink(link: FleetLink): { link: FleetLink; warnings: Warning[] } {
  if (link.url === undefined || (link.url_redacted === true && link.url === "")) return { link, warnings: [] };
  const reason = link.url_redacted === true ? "url_redacted is true but url is not empty." : fleetLinkUrlProblem(link.url);
  if (!reason) return { link, warnings: [] };
  const { url: _withheld, ...rest } = link;
  return { link: rest, warnings: [urlWithheldWarning(String(link.id), reason)] };
}

export function guardFleetLinks(items: FleetLink[]): { items: FleetLink[]; warnings: Warning[] } {
  const guarded = items.map(guardFleetLink);
  return { items: guarded.map((item) => item.link), warnings: guarded.flatMap((item) => item.warnings) };
}

/** Map fleet link problems to actionable guidance; exit codes stay status-derived (400 → 8, 404 → 4, 409 → 5, 412 → 6). */
export function fleetLinkProblem(error: unknown, id?: string): unknown {
  if (!(error instanceof CliError)) return error;
  const problem = error.problem;
  if (problem.code === "fleet_link_limit_reached") {
    return new CliError({
      ...problem,
      detail: `This project already has the maximum of ${FLEET_LINKS_MAX} fleet links. Nothing was created.`,
      next: problem.next ?? {
        command: "screenrig fleet-links list",
        reason: "Delete a fleet link you no longer need with screenrig fleet-links delete ID, then rerun create. Screens it created stay.",
      },
    }, error.exitCode, error.warnings);
  }
  if (problem.next) return error;
  if (problem.code === "revision_conflict" && id) {
    return new CliError({
      ...problem,
      next: { command: `screenrig fleet-links show ${id}`, reason: "Read the current revision and state, then rerun with --expect-rev REVISION if the change still applies." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "not_found" && id) {
    return new CliError({
      ...problem,
      next: { command: "screenrig fleet-links list", reason: "List this project's fleet links; a deleted link does not come back." },
    }, error.exitCode, error.warnings);
  }
  if (problem.code === "invalid_request" && problem.errors.some((item) => (item as { field?: unknown } | null)?.field === "playlist_id")) {
    return new CliError({
      ...problem,
      next: { command: "screenrig playlist list", reason: "Choose a playlist id from this project for --playlist-id." },
    }, error.exitCode, error.warnings);
  }
  return error;
}

function when(value: string | number | undefined, label: string): string[] {
  return value === undefined || value === "" ? [] : [`${label}: ${value}`];
}

function screensCell(link: FleetLink): string {
  const created = String(link.screens_created ?? 0);
  return link.max_screens === undefined ? created : `${created}/${link.max_screens}`;
}

/** Whether the link is past its expires_at (it expires at that instant); false without one or when it cannot be read. */
function fleetLinkExpired(link: FleetLink, now: Date): boolean {
  const expires = link.expires_at ? Date.parse(link.expires_at) : Number.NaN;
  return Number.isFinite(expires) && expires <= now.getTime();
}

/** expires_at as the server returned it, marked once it has passed; empty when the link never expires. */
function expiryText(link: FleetLink, now: Date): string {
  return link.expires_at ? `${link.expires_at}${fleetLinkExpired(link, now) ? " (expired)" : ""}` : "";
}

/** Every field except url, which is printed apart under its own sensitive label. */
export function fleetLinkLines(link: FleetLink | undefined, now: Date): string[] {
  if (!link) return [];
  return [
    `id: ${link.id}`,
    `label: ${link.label}`,
    `enabled: ${link.enabled}`,
    `tags: ${(link.tags ?? []).join(", ")}`,
    ...when(link.playlist_id, "playlist_id"),
    `screens_created: ${link.screens_created ?? 0}`,
    ...when(link.max_screens, "max_screens"),
    ...when(expiryText(link, now), "expires_at"),
    ...when(link.last_used_at, "last_used_at"),
    `revision: ${link.revision}`,
    ...when(link.created_at, "created_at"),
    ...when(link.updated_at, "updated_at"),
  ];
}

const READ_ONLY_URL = "URL: withheld from a Read only credential. A Manage sign-in (screenrig login --access manage) receives it.";

/** The url block for show, create and rotate. An empty or missing url is never printed as the link. */
export function fleetLinkUrlLines(link: FleetLink | undefined, withheld: boolean): string[] {
  if (!link) return [];
  if (link.url) {
    return ["", "Sensitive fleet link URL (every device that opens it becomes a screen in this project; give it only to your device manager)", `url: ${link.url}`];
  }
  if (withheld) return ["", "URL: withheld, see the warning."];
  if (link.url_redacted === true) return ["", READ_ONLY_URL];
  return ["", "URL: not returned."];
}

/** The list table never prints url; say once when a Read only credential received them redacted. */
export function fleetLinkRedactedNote(items: FleetLink[]): string[] {
  return items.some((item) => item.url_redacted === true)
    ? ["URLs: withheld from a Read only credential. With a Manage sign-in (screenrig login --access manage), fleet-links show prints one."]
    : [];
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

/** The list table never prints url. EXPIRES appears only while a listed link has an expiry, and marks a link past it. */
export function fleetLinkTableLines(items: FleetLink[], now: Date): string[] {
  if (!items.length) return ["No fleet links"];
  const expiry = items.some((item) => item.expires_at);
  return table(["ID", "LABEL", "ENABLED", "SCREENS", ...(expiry ? ["EXPIRES"] : []), "TAGS", "LAST_USED"], items.map((item) => [
    item.id ?? "", item.label ?? "", String(item.enabled), screensCell(item),
    ...(expiry ? [expiryText(item, now)] : []),
    (item.tags ?? []).join(","), item.last_used_at ?? "",
  ]));
}
