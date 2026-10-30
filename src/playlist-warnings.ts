import type { Warning } from "./envelope.js";
import { plainText } from "./reviews.js";

/** One item of a playlist write answer's `warnings` member, as the server sends it. */
export interface PlaylistWarningItem {
  code: string;
  message: string;
  page_id?: string;
  primitive_id?: string;
  src?: string;
  reason?: string;
  /** screen_fact_missing: the screen tokens some listed screen has no value for. */
  tokens?: string[];
  /** screen_fact_missing: the first 20 affected screens. */
  screen_ids?: string[];
  /** screen_fact_missing: how many screens are affected. */
  screen_count?: number;
}

export const IFRAME_FRAMING_REFUSED = "iframe_framing_refused";
export const SCREEN_FACT_MISSING = "screen_fact_missing";

function text(value: unknown, max = 600): string | undefined {
  return typeof value === "string" && value.trim() ? plainText(value).trim().slice(0, max) : undefined;
}

/** The server's warnings items, ignoring anything that is not a code with a message. */
export function playlistWarningItems(value: unknown): PlaylistWarningItem[] {
  if (!Array.isArray(value)) return [];
  const items: PlaylistWarningItem[] = [];
  for (const raw of value) {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    const code = text(item.code, 80);
    const message = text(item.message, 1000);
    if (!code || !message) continue;
    items.push({
      code, message,
      ...(text(item.page_id, 200) ? { page_id: text(item.page_id, 200)! } : {}),
      ...(text(item.primitive_id, 200) ? { primitive_id: text(item.primitive_id, 200)! } : {}),
      ...(text(item.src, 2000) ? { src: text(item.src, 2000)! } : {}),
      ...(text(item.reason, 80) ? { reason: text(item.reason, 80)! } : {}),
      ...(Array.isArray(item.tokens) ? { tokens: item.tokens.flatMap((token) => text(token, 100) ?? []).slice(0, 64) } : {}),
      ...(Array.isArray(item.screen_ids) ? { screen_ids: item.screen_ids.flatMap((id) => text(id, 200) ?? []).slice(0, 20) } : {}),
      ...(typeof item.screen_count === "number" && Number.isSafeInteger(item.screen_count) && item.screen_count > 0 ? { screen_count: item.screen_count } : {}),
    });
  }
  return items;
}

/** The envelope warning for one server item: its code, its message and a next step built from the item. */
export function playlistWarning(item: PlaylistWarningItem, playlistId?: string, pending = false): Warning {
  if (item.code === SCREEN_FACT_MISSING) return screenFactWarning(item);
  if (item.code !== IFRAME_FRAMING_REFUSED) return { code: item.code, message: item.message };
  const where = [
    item.page_id ? `page ${item.page_id}` : undefined,
    item.primitive_id ? `primitive ${item.primitive_id}` : undefined,
    item.src ? item.src : undefined,
  ].filter(Boolean).join(", ");
  const edit = playlistId ? `screenrig playlist patch ${playlistId}` : "screenrig playlist patch ID";
  return {
    code: item.code,
    message: `${item.message} ${pending ? "The change waits for review as written." : "The playlist was saved as written."} Next: ${where ? `replace the iframe (${where}) with a page that allows framing from the Player origin, or ask the page's owner to allow it` : "replace the iframe with a page that allows framing from the Player origin, or ask the page's owner to allow it"}; edit the pages with ${edit} FILE.`,
  };
}

/** screen_fact_missing: the server's message, the screens it names (first 20 of screen_count) and the tokens that need a value, with the commands that give one. */
function screenFactWarning(item: PlaylistWarningItem): Warning {
  const ids = item.screen_ids ?? [];
  const more = item.screen_count !== undefined && item.screen_count > ids.length ? ` and ${item.screen_count - ids.length} more` : "";
  const screens = ids.length ? ` Screens: ${ids.join(", ")}${more}.` : "";
  const tokens = item.tokens?.length ? ` Tokens: ${item.tokens.join(", ")}.` : "";
  const where = item.page_id || item.primitive_id ? ` First use: ${[item.page_id ? `page ${item.page_id}` : "", item.primitive_id ? `primitive ${item.primitive_id}` : ""].filter(Boolean).join(", ")}.` : "";
  const next = ids.length
    ? ` Next: screenrig screen update ${ids[0]} --field NAME=VALUE (or --location LAT,LON, --timezone ZONE) gives a screen the value; screenrig screen show ${ids[0]} lists what it has.`
    : "";
  return { code: item.code, message: `${item.message}${where}${tokens}${screens}${next}` };
}

export function playlistWarnings(items: unknown, playlistId?: string, pending = false): Warning[] {
  return playlistWarningItems(items).map((item) => playlistWarning(item, playlistId, pending));
}

/** The warnings member of a playlist write answer (or a pending_review answer), as envelope warnings. */
export function playlistAnswerWarnings(body: unknown): Warning[] {
  const answer = body as { warnings?: unknown; id?: unknown; status?: unknown; playlist?: { id?: unknown } } | undefined;
  if (!answer || typeof answer !== "object") return [];
  const id = typeof answer.id === "string" ? answer.id : typeof answer.playlist?.id === "string" ? answer.playlist.id : undefined;
  return playlistWarnings(answer.warnings, id, answer.status === "pending_review");
}

/** A copy of an answer without its warnings member: they are lifted into the envelope, not repeated in data. */
export function withoutAnswerWarnings<T>(body: T): T {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("warnings" in body)) return body;
  const { warnings: _lifted, ...rest } = body as Record<string, unknown>;
  return rest as T;
}

/** Whether the warnings say a page cannot be framed by the Player web app. */
export function hasFramingRefusal(warnings: Warning[]): boolean {
  return warnings.some((warning) => warning.code === IFRAME_FRAMING_REFUSED);
}
