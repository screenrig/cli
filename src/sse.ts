export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
  /** The server's reconnect delay in milliseconds (the `retry:` field; digits only). */
  retry?: number;
}

/**
 * The ProjectEvent a listen-stream frame carries, or undefined when the frame is
 * something else: no data, data that is not an event object, or a frame whose
 * `event:` names another kind of frame (an in-band problem, for one) than the
 * event it would parse as. A project event's frame is named by its type.
 */
export function projectEventOf<T extends { type: string }>(frame: SseEvent): T | undefined {
  if (!frame.data) return undefined;
  let value: unknown;
  try { value = JSON.parse(frame.data); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = (value as { type?: unknown }).type;
  // An event type is a dotted name (screen.paired); a problem document's type is a URL.
  if (typeof type !== "string" || !/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/.test(type)) return undefined;
  if (frame.event !== undefined && frame.event !== "message" && frame.event !== type) return undefined;
  return value as T;
}

export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let item: SseEvent = {};
  let lineStart = 0;
  let frameStart = 0;
  // Keep incomplete frames verbatim so CRLF split between chunks is preserved.
  for (const ending of buffer.matchAll(/\r\n|\r|\n/g)) {
    const line = buffer.slice(lineStart, ending.index);
    lineStart = ending.index + ending[0].length;
    if (line === "") {
      if (Object.keys(item).length > 0) events.push(item);
      item = {};
      frameStart = lineStart;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    // SSE removes one optional space, not arbitrary leading/trailing whitespace.
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id" && !value.includes("\0")) {
      item.id = value;
    } else if (field === "event") {
      item.event = value;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) item.retry = Number(value);
    } else if (field === "data") {
      item.data = item.data === undefined ? value : `${item.data}\n${value}`;
    }
  }
  return { events, rest: buffer.slice(frameStart) };
}
