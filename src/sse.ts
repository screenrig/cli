export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    if (!block.trim() || block.startsWith(":")) {
      continue;
    }
    const item: SseEvent = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) {
        item.id = line.slice(3).trim();
      } else if (line.startsWith("event:")) {
        item.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).trimStart();
        item.data = item.data ? `${item.data}\n${value}` : value;
      }
    }
    events.push(item);
  }
  return { events, rest };
}
