// Command handlers for the events commands, loaded on demand.
import { isResourceID } from "../generated/resource-ids.js";
import { formatResultContext } from "../project-context.js";
import { healthChangesText } from "../screen-health.js";
import { type ProjectEvent, type EventPage } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { projectStreamQuery } from "../project-routing.js";
import { requireToken } from "../client.js";
import { resolveConfig } from "../config.js";
import { loggerOf } from "../log/index.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { parseSse } from "../sse.js";
import { isSensitiveKey, isSensitiveValue, redactEvent } from "../redact.js";
import { EVENT_STREAM_BACKOFF_CAP_MS, EVENT_STREAM_BACKOFF_MS, clientFor, commandHandler, isAbortError, isHardFollowError, jsonBody, requireFlagValue, sleepWhileOpen, streamEnvelope, streamToken, transportFor, type CommandResult } from "../commands.js";


export const handleEventsList = commandHandler(eventsList);

export const handleEventsFollow = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "events.follow", message: "events follow" }, () =>
    eventsFollow(args, runtime, resolved),
  );
}, true);

export const CANNED_EVENT_MESSAGES = new Set([
  "Application emitted an event",
  "Runtime reported a bounded condition",
  "Player reported runtime status",
  "Screen screenshot requested",
  "Screen screenshot ready",
  "Screen screenshot failed",
  "Screenshot requested",
  "Screenshot ready",
  "Screenshot failed",
  "Stream cursor advanced",
  "Stream replay state is no longer retained",
  "Screen came online",
  "Screen went offline",
  "Screen effective playlist switched",
  "Screen takeover started",
  "Screen takeover ended",
  "A scheduled playlist cannot be shown; its entries were skipped",
  "Screen health changed",
  "Screen reboot requested",
  // screen.suspended carries the notice as details.message, so its own message must not repeat the key.
  "Screen suspended",
  "Screen resumed",
  "Screen replaced by another device",
  "Screen display override set",
  "Screen display schedule updated",
  "Screen display schedule cleared",
]);

/**
 * Effective-playlist events carry null for "no playlist" (playlist_switched)
 * and "until cleared" (takeover_started); render it as none rather than
 * dropping the field.
 */
export const NULL_AS_NONE_EVENT_TYPES = new Set(["screen.display_changed", "screen.playlist_switched", "screen.takeover_started", "screen.takeover_ended", "screen.playlist_unavailable"]);

export const SILENT_EVENT_TYPES = new Set(["application.event", "runtime.reported"]);

export function isEventScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function formatLogfmtValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (!/[\s="]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

export function pushLogfmtField(parts: string[], key: string, value: unknown): boolean {
  if (!isEventScalar(value)) return false;
  if (isSensitiveKey(key)) return false;
  if (typeof value === "string") {
    if (value.length === 0 || isSensitiveValue(value)) return false;
  }
  parts.push(`${key}=${formatLogfmtValue(value)}`);
  return true;
}

/** One logfmt line per event. Undefined when there is nothing to print. */
export function formatEventLine(event: ProjectEvent): string | undefined {
  const parts: string[] = [];
  const hasAt = pushLogfmtField(parts, "at", event.at);
  const hasType = pushLogfmtField(parts, "type", event.type);
  pushLogfmtField(parts, "severity", event.severity);

  let payload = 0;
  const resource = event.resource;
  if (resource) {
    if (pushLogfmtField(parts, "resource_type", resource.type)) payload += 1;
    if (pushLogfmtField(parts, "resource_id", resource.id)) payload += 1;
  }

  const details = event.details ?? {};
  const used = new Set<string>();
  for (const key of ["code", "primitive_id"]) {
    if (!pushLogfmtField(parts, key, details[key])) continue;
    used.add(key);
    payload += 1;
  }
  if (event.type === "screen.health_changed") {
    // changes[] is a list of objects; print it as one compact value.
    const changes = healthChangesText(details.changes);
    if (changes && pushLogfmtField(parts, "changes", changes)) payload += 1;
    used.add("changes");
  }
  const nullAsNone = NULL_AS_NONE_EVENT_TYPES.has(event.type);
  for (const key of Object.keys(details).sort()) {
    if (used.has(key)) continue;
    const raw = details[key];
    // entry_ids and similar short id lists print comma-joined.
    const value = nullAsNone && raw === null ? "none"
      : nullAsNone && Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(item)) ? raw.join(",")
      : raw;
    if (pushLogfmtField(parts, key, value)) payload += 1;
  }

  const message = event.message ?? "";
  const detailCode = details.code;
  const canned = CANNED_EVENT_MESSAGES.has(message);
  const duplicate = message === event.type || (typeof detailCode === "string" && message === detailCode);
  if (message && !canned && !duplicate && pushLogfmtField(parts, "message", message)) {
    payload += 1;
  }

  if (!hasAt && !hasType) return undefined;
  if (SILENT_EVENT_TYPES.has(event.type) && payload === 0) return undefined;
  return parts.join(" ");
}

export function formatEventLines(events: ProjectEvent[]): string {
  return events
    .map((event) => formatEventLine(event))
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export const EVENT_APPLICATION_ID = /^(?:(?:stage|qa|development)_)?app_[A-Za-z0-9_-]+$/;

/**
 * events list resource filters. The project event source takes screen, playlist
 * and application ids; the Player log (--source log) belongs to a screen only.
 * Shapes are checked here with the same id patterns the backend enforces, so a
 * wrong kind of id fails before a request.
 */
export function eventsListFilters(args: ParsedArgs): { source?: string; screen_id?: string; playlist_id?: string; application_id?: string } {
  requireFlagValue(args, "source", "log");
  requireFlagValue(args, "screen-id", "scr_01");
  requireFlagValue(args, "playlist-id", "pl_01");
  requireFlagValue(args, "app-id", "app_01");
  const source = flagString(args.flags, "source");
  const screenId = flagString(args.flags, "screen-id");
  const playlistId = flagString(args.flags, "playlist-id");
  const applicationId = flagString(args.flags, "app-id");
  if (source !== undefined && source !== "project" && source !== "log") throw usageError("--source must be project or log.");
  if (screenId !== undefined && !isResourceID(screenId, "screen")) throw usageError("--screen-id must be a screen identifier (scr_...).");
  if (playlistId !== undefined && !isResourceID(playlistId, "playlist")) throw usageError("--playlist-id must be a playlist identifier (pl_...).");
  if (applicationId !== undefined && !EVENT_APPLICATION_ID.test(applicationId)) throw usageError("--app-id must be an application identifier (app_...).");
  if (source === "log" && (playlistId !== undefined || applicationId !== undefined)) {
    const flag = playlistId !== undefined ? "--playlist-id" : "--app-id";
    throw usageError(`${flag} reads project events, and the Player log (--source log) holds screen records only. Drop --source log to read the project events of ${playlistId !== undefined ? "a playlist" : "an application"}, or use --screen-id to read one screen's Player log.`);
  }
  return {
    ...(source === undefined ? {} : { source }),
    ...(screenId === undefined ? {} : { screen_id: screenId }),
    ...(playlistId === undefined ? {} : { playlist_id: playlistId }),
    ...(applicationId === undefined ? {} : { application_id: applicationId }),
  };
}

export async function eventsList(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  // `--limit` is forwarded verbatim: the server owns the 1..200 bound and
  // answers 400 invalid_request with errors[].field = "limit", which the
  // envelope surfaces. A null next_cursor is the end of the history, not an error.
  requireFlagValue(args, "limit", "50");
  requireFlagValue(args, "after", "ev1_0");
  const filters = eventsListFilters(args);
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/events",
    query: {
      after: flagString(args.flags, "after"),
      limit: flagString(args.flags, "limit"),
      type: flagString(args.flags, "type"),
      ...filters,
    },
  });
  const page = response.body as EventPage;
  const items = page.items ?? [];
  const human = formatEventLines(items);
  const safePage = redactEvent({ ...page, items });
  return {
    envelope: jsonBody({ ...response, body: safePage }, client.requestId),
    exitCode: ExitCode.Success,
    human,
  };
}

/**
 * `events follow --type`: the project stream takes no type filter, so the CLI
 * filters what it prints. An exact type, or a family prefix ending in a dot.
 * stream.* frames describe the stream itself and always pass.
 */
export function eventTypeMatches(type: unknown, filter: string | undefined): boolean {
  if (!filter) return true;
  if (typeof type !== "string") return false;
  if (type.startsWith("stream.")) return true;
  return filter.endsWith(".") ? type.startsWith(filter) : type === filter;
}

export async function eventsFollow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  let token = requireToken(resolved.token);
  const typeFilter = flagString(args.flags, "type");
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const transport = transportFor(runtime, resolved.apiUrl, token);
  const json = !flagBool(args.flags, "human");
  let printed = 0;
  let after = flagString(args.flags, "after");
  let delayMs = EVENT_STREAM_BACKOFF_MS;
  const controller = new AbortController();
  const timeoutMs = flagNumber(args.flags, "timeout");
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const emit = (event: ProjectEvent): void => {
    if (!eventTypeMatches(event?.type, typeFilter)) return;
    if (json) {
      printed += 1;
      runtime.stdout.write(`${JSON.stringify(streamEnvelope(runtime, redactEvent(event), client.requestId))}\n`);
      return;
    }
    const line = formatEventLine(event);
    if (!line) return;
    if (printed === 0) {
      if (formatResultContext(runtime)) runtime.stdout.write(`${formatResultContext(runtime)}\n`);
    }
    printed += 1;
    runtime.stdout.write(`${line}\n`);
  };
  try {
    while (!controller.signal.aborted) {
      let buffer = "";
      let connected = false;
      try {
        token = await streamToken(runtime, token);
        const stream = await transport.stream({
          method: "GET",
          path: "/stream/project",
          query: { after, ...projectStreamQuery(resolved.projectId) },
          headers: { "x-request-id": client.nextRequestId(), authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        connected = true;
        for await (const chunk of stream) {
          buffer += chunk;
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            if (event.id) {
              after = event.id;
            }
            if (!event.data) continue;
            try {
              emit(JSON.parse(event.data) as ProjectEvent);
            } catch {
              // Unstructured frames are not event data.
            }
          }
          if (controller.signal.aborted) {
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          break;
        }
        if (isHardFollowError(err)) {
          throw err;
        }
      }
      if (controller.signal.aborted) {
        break;
      }
      await sleepWhileOpen(delayMs, controller.signal, runtime.sleep);
      if (controller.signal.aborted) {
        break;
      }
      delayMs = connected
        ? EVENT_STREAM_BACKOFF_MS
        : Math.min(delayMs * 2, EVENT_STREAM_BACKOFF_CAP_MS);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (printed === 0 && json) {
    runtime.stdout.write(`${JSON.stringify(streamEnvelope(runtime, { items: [] }, client.requestId))}\n`);
  }
  return {
    envelope: successEnvelope({ items: [] }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: "",
    output: "stream",
  };
}
