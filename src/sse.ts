export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
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
    } else if (field === "data") {
      item.data = item.data === undefined ? value : `${item.data}\n${value}`;
    }
  }
  return { events, rest: buffer.slice(frameStart) };
}
