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
}

export const IFRAME_FRAMING_REFUSED = "iframe_framing_refused";

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
    });
  }
  return items;
}

/** The envelope warning for one server item: its code, its message and a next step built from the item. */
export function playlistWarning(item: PlaylistWarningItem, playlistId?: string, pending = false): Warning {
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
