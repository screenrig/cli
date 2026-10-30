// Command handlers for the screen commands, loaded on demand.
import { newIdempotencyKey } from "../ids.js";
import { readAuthoringJson } from "../authoring-input.js";
import { publishScreen } from "../screen-publish.js";
import { fleetHumanLines, fleetOutcome, rejectFleetRevision, screenActionResult, SCREEN_FOLDER_ID_PATTERN, screenFolderId, screenTag, screenTagList, screenTarget, selectorFlags, folderSubtree, SCREEN_TAGS_MAX, type FleetItem } from "../screen-fleet.js";
import { canonicalPairingCode } from "../pairing-code.js";
import { playlistWarnings, playlistAnswerWarnings, withoutAnswerWarnings, hasFramingRefusal } from "../playlist-warnings.js";
import { shortApplicationPageWarning } from "../playlist-authoring.js";
import { callPlaylist } from "../playlist-api.js";
import { instantInZone, assignmentLine, scheduleEntries, scheduleTableLines, screenControlProblem, takeoverForProblem, takeoverLine, takeoverReason, takeoverUntil, effectivePlaylistText } from "../screen-control.js";
import { wallFromFlags, wallLine, wallProblem } from "../screen-wall.js";
import { screenFactsLines, screenFactsPatch, screenFieldsCell, screenListFacts, screenLocationCell } from "../screen-facts.js";
import { displayLines, displayPower, displayProblem, displayScheduleWrite, displayUntil, playPageProblem, rebootProblem, rebootScheduleLines, rebootScheduleProblem, rebootScheduleWrite, rebootWindowList } from "../screen-display.js";
import { commandCancelProblem, commandLines, commandResultText, expiresInSeconds, identifyDurationMs, identifyProblem, MAINTENANCE, maintenanceProblem, replaceProblem, replacedByLines, suspendMessage, suspendProblem, suspensionLines, type MaintenanceSpec } from "../screen-commands.js";
import { flatFrameNote, frameRow, glassLines } from "../screen-glass.js";
import { LIVE_WAIT_DEFAULT_MS, liveDurationSeconds, liveEndedError, liveHumanLines, liveNotReadyWarning, liveProblem, liveScreenId, liveSessionBody, liveWaitMs, settleLive } from "../screen-live.js";
import { LIVE_FRAME_INTERVAL_DEFAULT_MS, captureLiveFrames, liveFrameIntervalMs, liveFrameLeaseSeconds, liveFramesHumanLines, resolveFrameOutput } from "../screen-live-frame.js";
import { levelsLines, sumLevels } from "../screen-folders.js";
import type { LiveStartRequest, ScreenLevelChanges, ScreenRebootScheduleView } from "../adapters/protocol.js";
import { healthLines, screenHealthIssues } from "../screen-health.js";
import { outageLines } from "../screen-outage.js";
import { anyManifestUpgrade, manifestUpgradeCell, manifestUpgradeLines } from "../screen-manifest-upgrade.js";
import { forecastStorageWarnings, isStorageFailureCode, screenStorageWarnings, storageFullWarning } from "../screen-storage.js";
import { removeOnSignal, tempPathFor } from "../temp-file.js";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type PairScreen, type PairingClaim, type HostContext, type ProvisionScreen, type Screen, type ScreenAction, type ScreenActionRequest, type ScreenActionSelector, type ScreenFolder, type ScreenCommandWrite, type ScreenIdentifyAccepted, type ScreenIdentifyWrite, type ScreenPatch, type ScreenProvisioning, type ScreenReloadAccepted, type ScreenReplaceWrite, type ScreenSuspendWrite, type ScreenScreenshotAccepted, type ScreenScreenshotFrame, type ScreenScreenshotStatus, type ScreenStorageForecastDryRun, type ScreenStorageForecastRequest, type ScreenToastAccepted, type ScreenToastLevel, type ScreenToastWrite, type ScreenPlaylistScheduleView, type ScreenPlaylistScheduleWrite, type ScreenTakeoverWrite, type ScreenDisplayScheduleView, type ScreenMaintenanceAccepted, type ScreenRebootAccepted, type ScreenPlayPageAccepted, type ScreenPlayPageWrite } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { HEALTH_DEFAULT_WINDOW_MS, HEALTH_HOURLY_MAX_DAYS, HEALTH_RAW_MAX_DAYS, PRESENCE_DEFAULT_WINDOW_MS, PRESENCE_MAX_DAYS, SERIES_PAGE_SIZE, seriesWindow } from "../series.js";
import { loggerOf } from "../log/index.js";
import { PENDING_REVIEW_SENTENCE, pendingReviewOf, pendingReviewWarning, reviewNext } from "../reviews.js";
import { successEnvelope, type ProblemNext, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { screenLinkSummaryLines } from "../screen-link-format.js";
import { assertPlaylistValid } from "../playlist-validate.js";
import { assertWirePages } from "../playlist-write-validation.js";
import { playlistNeedsTimezone } from "../generated/playlist-write-semantics.js";
import { clearProvisionRetryState, provisionRetryState } from "../provisioning-state.js";
import { formatBytes } from "../media/progress.js";
import { validateProvisioningUrls } from "../provisioning-url.js";
import { aspectMismatchWarnings } from "../aspect-mismatch.js";
import { clientFor, commandHandler, humanLines, isScreenId, jsonBody, pendingReviewResult, requireFlagValue, requirePrivateNoStore, resolveDownloadOutput, resourceNotes, reviewNoteFrom, scheduleZoneError, simpleGet, simpleList, uptimeDays, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


export function screenListQuery(args: ParsedArgs): { query: Record<string, string>; repeated?: Record<string, string[]> } {
  const state = screenListStateFromArgs(args);
  const tag = screenListTagFromArgs(args);
  const folder = screenListFolderFromArgs(args);
  const facts = screenListFacts(args.flags);
  return { query: { ...(state ? { state } : {}), ...(tag ? { tag } : {}), ...(folder ? { folder } : {}), ...facts.query }, ...(facts.repeated ? { repeated: facts.repeated } : {}) };
}

/** --folder: a screen folder ID, or root for the screens outside every folder. */
export function screenListFolderFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "folder", "sfd_NORTH");
  const folder = flagString(args.flags, "folder");
  return folder === undefined || folder === "root" ? folder : screenFolderId(folder, "--folder");
}

export function screenListTagFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "tag", "Lobby");
  const tag = flagString(args.flags, "tag");
  return tag === undefined ? undefined : screenTag(tag);
}

/** Printable tags: only grammar-shaped values, so server text never reaches a table cell unchecked. */
export function screenTags(screen: Screen | undefined): string[] {
  const tags = screen?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string" && /^[A-Za-z0-9]{1,32}$/.test(tag)) : [];
}

/** The screen folder holding a screen, when it sits in one; only an id-shaped value is printed. */
export function screenFolderCell(screen: Screen | undefined): string {
  const folder = screen?.folder_id;
  return typeof folder === "string" && SCREEN_FOLDER_ID_PATTERN.test(folder) ? folder : "";
}

export function screenFolderLine(screen: Screen | undefined): string[] {
  const folder = screenFolderCell(screen);
  return folder ? [`Folder: ${folder} (screen folder show ${folder})`] : [];
}

export function screenListStateFromArgs(args: ParsedArgs): "archived" | undefined {
  requireFlagValue(args, "state", "archived");
  const state = flagString(args.flags, "state");
  if (state === undefined) {
    return undefined;
  }
  if (state !== "archived") {
    throw usageError("--state must be archived.");
  }
  return state;
}

/** The id of `screen uptime|presence|health-history ID`, checked like the other screen reads. */
export function screenSeriesId(args: ParsedArgs, command: string): string {
  const id = args.positionals[2];
  if (!id || !isScreenId(id)) throw usageError(`${command} requires a screen ID (scr_...); screen list shows them.`);
  return id;
}

export const handleScreenUptime = commandHandler(async (args, runtime, resolved) => {
  const id = screenSeriesId(args, "screen uptime");
  return simpleGet(args, runtime, resolved, `/api/screens/${id}/uptime`, "Screen uptime", uptimeDays(args));
}, true);

export const handleScreenPresence = commandHandler(async (args, runtime, resolved) => {
  const id = screenSeriesId(args, "screen presence");
  requireFlagValue(args, "since", "7d");
  requireFlagValue(args, "until", "now");
  const range = seriesWindow({
    from: flagString(args.flags, "since"), to: flagString(args.flags, "until"), fromFlag: "--since", toFlag: "--until",
    now: runtime.now(), defaultMs: PRESENCE_DEFAULT_WINDOW_MS, maxDays: PRESENCE_MAX_DAYS,
  });
  return simpleList(args, runtime, resolved, `/api/screens/${id}/presence`, "Screen presence",
    { since: range.from, until: range.to, limit: SERIES_PAGE_SIZE }, { cursorParam: "before", uncapped: true });
}, true);

export const handleScreenHealthHistory = commandHandler(async (args, runtime, resolved) => {
  const id = screenSeriesId(args, "screen health-history");
  requireFlagValue(args, "resolution", "hour");
  requireFlagValue(args, "from", "7d");
  requireFlagValue(args, "to", "now");
  const resolution = flagString(args.flags, "resolution") ?? "raw";
  if (resolution !== "raw" && resolution !== "hour") throw usageError("--resolution must be raw or hour.");
  const range = seriesWindow({
    from: flagString(args.flags, "from"), to: flagString(args.flags, "to"), fromFlag: "--from", toFlag: "--to",
    now: runtime.now(), defaultMs: HEALTH_DEFAULT_WINDOW_MS,
    maxDays: resolution === "hour" ? HEALTH_HOURLY_MAX_DAYS : HEALTH_RAW_MAX_DAYS,
    advice: resolution === "raw" ? ` with --resolution raw; --resolution hour spans up to ${HEALTH_HOURLY_MAX_DAYS} days` : "",
  });
  return simpleList(args, runtime, resolved, `/api/screens/${id}/health/history`, "Screen health history",
    { from: range.from, to: range.to, resolution: flagString(args.flags, "resolution"), limit: SERIES_PAGE_SIZE },
    { cursorParam: "cursor", itemsKey: resolution === "hour" ? "hours" : "samples", uncapped: true });
}, true);

export const TOAST_LEVELS = new Set<ScreenToastLevel>(["error", "alert", "info"]);
export const TOAST_DEFAULT_LEVEL: ScreenToastLevel = "info";
export const TOAST_TEXT_MAX = 120;
export const TOAST_MAX_LINES = 3;
export const TOAST_DURATION_MIN = 2000;
export const TOAST_DURATION_MAX = 60000;
export const SCREENSHOT_DEFAULT_WAIT_MS = 35_000;
export const SCREENSHOT_DEFAULT_POLL_MS = 500;

export function isScreenToastLevel(value: string): value is ScreenToastLevel {
  return TOAST_LEVELS.has(value as ScreenToastLevel);
}

export function trimToastText(value: string): string {
  return value.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
}

export function toastTextHasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function toastLineCount(value: string): number {
  if (value === "") {
    return 0;
  }
  return value.split("\n").length;
}

/**
 * Refuse a scheduled playlist locally before the PATCH goes out. The server
 * rejects the same pair, but it answers about a body the operator did not
 * write; naming the screen and the fixing command here is the difference
 * between a clear message and an opaque rejection.
 */
export async function assertScheduledPlaylistHasZone(client: ApiClient, screenId: string, playlistId: string): Promise<unknown> {
  const playlist = await callPlaylist(client, { method: "GET", id: playlistId });
  if (!playlistNeedsTimezone(playlist.body)) {
    return playlist.body;
  }
  const screen = await client.call({ method: "GET", path: `/api/screens/${screenId}` });
  if ((screen.body as Screen | undefined)?.timezone) {
    return playlist.body;
  }
  throw scheduleZoneError(screenId);
}

export const handleScreenList = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const { query, repeated } = screenListQuery(args);
  const response = await client.listAll("/api/screens", query, repeated ? { queryRepeated: repeated } : undefined);
  const items = (response.body as { items?: Screen[] } | undefined)?.items;
  const warnings = Array.isArray(items) ? items.flatMap((screen) => screenStorageWarnings(screen.id, screen, runtime.now())) : [];
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: ["Screens", ...screenTableLines(Array.isArray(items) ? items : [], runtime.now()), JSON.stringify(response.body, null, 2), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

/**
 * One row per screen. The platform column appears only when at least one
 * screen reports a host, and the reason column only when at least one
 * archived screen reports why it was archived, and the tags column only when
 * at least one screen carries a tag, and the fields and location columns only
 * when at least one screen carries them, and the upgrade column only when at
 * least one screen has a manifest upgrade story, so a fleet without any
 * keeps the table it had. The JSON body follows unchanged in both output modes.
 */
export function screenTableLines(items: Screen[], now: Date): string[] {
  if (!items.length) return [];
  const withPlatform = items.some((screen) => typeof screen?.host?.platform === "string");
  const withReason = items.some((screen) => archiveReason(screen) !== undefined);
  const withTags = items.some((screen) => screenTags(screen).length > 0);
  // Only when a listed screen sits in a screen folder, so a fleet without folders keeps its table.
  const withFolder = items.some((screen) => screenFolderCell(screen) !== "");
  // Only when a listed screen carries fields or a location, so plain fleets keep their table.
  const withFields = items.some((screen) => screenFieldsCell(screen) !== "");
  const withLocation = items.some((screen) => screenLocationCell(screen) !== "");
  // Only when something overrides the assigned default, so plain fleets keep their table.
  const withAssignment = items.some((screen) => screen?.effective_playlist && screen.effective_playlist.source !== "default");
  // Only when a listed screen has a manifest upgrade story: a target versus
  // acknowledged mismatch, a failed/retrying/partial report, or an overdue retry.
  const withUpgrade = anyManifestUpgrade(items, now);
  // Only when a listed screen needs attention: display disconnected, hot, crashing, or a stale report.
  const withHealth = items.some((screen) => screenHealthIssues(screen).length > 0);
  const rows = items.map((screen) => [
    screen?.id ?? "", screen?.label ?? "", screen?.state ?? "",
    ...(withPlatform ? [screen?.host?.platform ?? ""] : []),
    ...(withReason ? [archiveReason(screen) ?? ""] : []),
    ...(withTags ? [screenTags(screen).join(",")] : []),
    ...(withFolder ? [screenFolderCell(screen)] : []),
    ...(withFields ? [screenFieldsCell(screen)] : []),
    ...(withLocation ? [screenLocationCell(screen)] : []),
    ...(withAssignment ? [effectivePlaylistText(screen?.effective_playlist, screen?.takeover, screen?.timezone) ?? ""] : []),
    ...(withHealth ? [screenHealthIssues(screen).join(", ") || (screen?.health ? "ok" : "")] : []),
    ...(withUpgrade ? [manifestUpgradeCell(screen, now) ?? ""] : []),
    ...(screen?.recovery_pending?.expires_at ? [`recovery pending until ${screen.recovery_pending.expires_at}`] : []),
    ...(applicationsUnsupportedAt(screen) ? ["applications unsupported"] : []),
  ]);
  const header = ["ID", "LABEL", "STATE", ...(withPlatform ? ["PLATFORM"] : []), ...(withReason ? ["REASON"] : []), ...(withTags ? ["TAGS"] : []), ...(withFolder ? ["FOLDER"] : []), ...(withFields ? ["FIELDS"] : []), ...(withLocation ? ["LOCATION"] : []), ...(withAssignment ? ["ASSIGNED"] : []), ...(withHealth ? ["HEALTH"] : []), ...(withUpgrade ? ["UPGRADE"] : [])];
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => index < widths.length ? cell.padEnd(widths[index]!) : cell).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

export const ARCHIVE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Why an archived screen was archived, when the server says so. Only a
 * token-shaped value is printed; the JSON body carries whatever the server
 * sent. Unknown tokens print as they are, without an explanation.
 */
export function archiveReason(screen: Screen | undefined): string | undefined {
  const reason = screen?.state === "archived" ? screen.archive_reason : undefined;
  return typeof reason === "string" && ARCHIVE_REASON_PATTERN.test(reason) ? reason : undefined;
}

export const ARCHIVE_REASON_TEXT: Record<string, string> = {
  project: "An project or dashboard request archived it.",
  device_reset: "The player was reset on the display. Its key is still bound to this screen. If the display now shows a pairing code, screen show may report recovery_pending: screen recover moves this screen to the display's new key and retires the old one, and the screen stays archived until screen unarchive.",
  device_unpair: "The paired browser unpaired itself. Its device credential is still bound to this screen.",
  replaced: "A screen replace moved this screen's device onto another screen, so this screen keeps no device binding.",
};

/**
 * The archive block `screen show` prints. Every archive keeps the device
 * binding: the display stays dark, and unarchive re-admits the same key so a
 * display that still holds it resumes with no re-pairing.
 */
export function archivedLines(screen: Screen | undefined): string[] {
  if (screen?.state !== "archived") return [];
  const reason = archiveReason(screen);
  const at = serverInstant(screen.archived_at);
  const id = typeof screen.id === "string" && screen.id ? screen.id : "<id>";
  return [
    `Archived${reason ? ` (${reason})` : ""}${at ? ` at ${at}` : ""}`,
    ...(reason && ARCHIVE_REASON_TEXT[reason] ? [ARCHIVE_REASON_TEXT[reason]] : []),
    // A replaced screen holds no key, so there is nothing for unarchive to re-admit.
    reason === "replaced"
      ? `screen unarchive cannot restore it; screen delete ${id} removes it.`
      : `Restore with screen unarchive ${id}. It re-admits the same key, so a display that still holds it resumes without re-pairing.`,
  ];
}

export function applicationsUnsupportedAt(screen: Screen | undefined): string | undefined {
  return serverInstant(screen?.applications_unsupported?.at);
}

/**
 * A server date-time that is safe to print on its own line: RFC 3339 shaped
 * and parseable. Anything else stays in the JSON body only.
 */
export function serverInstant(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/** The screen health line for a Player that cannot host applications or web pages. */
export function applicationsUnsupportedLines(screen: Screen | undefined): string[] {
  const at = applicationsUnsupportedAt(screen);
  if (!at) return [];
  return [
    `This player can't show applications or web pages (since ${at}).`,
    "Its manifest is unchanged: the player skips application and iframe primitives, and skips a page left with none.",
  ];
}

/** The `Host` block `screen show` prints. Absent fields are omitted; identifiers belong to the owning project. */
export function hostLines(host: HostContext | undefined, updatedAt: string | undefined): string[] {
  if (!host || typeof host !== "object") return [];
  const device = host.device ?? {};
  return humanLines("Host", [
    ["platform", host.platform],
    ["asset_id", device.asset_id],
    ["location", device.location],
    ["host_version", host.host_version],
    ["model", device.model],
    ["manufacturer", device.manufacturer],
    ["firmware", device.firmware],
    ["serial", device.serial],
    ["duid", device.duid],
    ["mac", device.mac],
    ["capabilities", Array.isArray(host.capabilities) && host.capabilities.length ? host.capabilities.join(", ") : undefined],
    ["updated_at", updatedAt],
  ]).split("\n");
}

/**
 * The recovery offer `screen show` prints. When the server describes the
 * display asking to reconnect, its manufacturer, platform, model, and firmware
 * follow the deadline so the operator can compare them with the display they
 * expect before confirming. Absent fields are omitted.
 */
export function recoveryPendingLine(screen: Screen | undefined): string[] {
  const pending = screen?.recovery_pending;
  const expiresAt = pending?.expires_at;
  if (!expiresAt) return [];
  const host = pending?.host && typeof pending.host === "object" ? pending.host : undefined;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const name = [text(host?.manufacturer), text(host?.platform), text(host?.model)].filter((part): part is string => part !== undefined).join(" ");
  const firmware = text(host?.firmware);
  const described = [name || undefined, firmware ? `firmware ${firmware}` : undefined].filter((part): part is string => part !== undefined).join(", ");
  return [
    `Recovery pending until ${expiresAt}${described ? `: ${described}` : ""}`,
    "Confirm with screen recover <id>; nothing is rebound until then.",
    ...(described ? ["Compare the reported model and firmware with the display you expect before confirming."] : []),
  ];
}

/** A storage report older than 24 hours is stale; consumers re-check before trusting it. */
export const STORAGE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The `Storage` block `screen show` prints from the player's last storage
 * report. A report older than 24 hours (per received_at) is marked stale; a
 * screen that never reported prints no storage lines. Absent parts are
 * omitted: the forecast without a report, the shortfall while the plan fits.
 */
export function storageLines(screen: Screen | undefined, now: Date): string[] {
  const storage = screen?.storage;
  if (!storage || typeof storage !== "object") return [];
  const receivedMs = Date.parse(storage.received_at);
  const stale = Number.isFinite(receivedMs) && now.getTime() - receivedMs > STORAGE_STALE_MS;
  const plan = storage.plan;
  const planSummary = [plan?.fit, plan?.transition ? `${plan.transition} transition` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const excludedPages = Array.isArray(plan?.excluded_pages) ? plan.excluded_pages.length : undefined;
  const transfer = storage.transfer_24h;
  const transferred = transfer.new + transfer.refetch + transfer.repair + transfer.failed;
  const transferSummary = transferred === 0
    ? "0 B"
    : `${formatBytes(transferred)} (new ${formatBytes(transfer.new)}, refetch ${formatBytes(transfer.refetch)}, repair ${formatBytes(transfer.repair)}, failed ${formatBytes(transfer.failed)})`;
  const forecast = screen?.storage_forecast;
  const shortfall = screen?.storage_shortfall;
  return humanLines(stale ? "Storage (stale)" : "Storage", [
    ["received_at", storage.received_at],
    ["capacity", formatBytes(storage.cache.capacity_bytes)],
    ["used", formatBytes(storage.cache.house_used_bytes)],
    ["durability", storage.durability],
    ["plan", planSummary],
    ["excluded pages", excludedPages === undefined ? undefined : String(excludedPages)],
    ["transferred in 24h", transferSummary],
    ["forecast", forecast?.fit ? `${forecast.fit} (manifest ${forecast.manifest_revision})` : undefined],
    ["shortfall", shortfall
      ? `needs ${formatBytes(shortfall.required_bytes)}, capacity ${formatBytes(shortfall.capacity_bytes)}${serverInstant(shortfall.at) ? ` (since ${shortfall.at})` : ""}`
      : undefined],
  ]).split("\n");
}

export const handleScreenProvision = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const openMode = flagBool(args.flags, "open");
  const printMode = flagBool(args.flags, "print-url") || !openMode;
  if (openMode === printMode) {
    throw usageError("screen provision requires exactly one of --open or --print-url.");
  }
  const label = flagString(args.flags, "name");
  const enrollmentRuntime = {
    fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
    now: runtime.now,
    sleep: runtime.sleep,
  };
  const retry = await provisionRetryState({
    resolved,
    runtime: enrollmentRuntime,
    ...(label ? { label } : {}),
    ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
  });

  const request: ProvisionScreen = { ...(label ? { label } : {}) };
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: "/api/screens/provision",
      idempotent: true,
      idempotencyKey: retry.idempotency_key,
      body: request,
    });
  } catch (error) {
    if (error instanceof CliError && error.problem.code === "provisioning_expired") {
      await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
    }
    throw error;
  }
  requirePrivateNoStore(response.headers, "Browser provisioning response");
  const provisioned = response.body as ScreenProvisioning;
  if (!provisioned.screen?.id || !provisioned.screen.public_id || !provisioned.expires_at || Number.isNaN(Date.parse(provisioned.expires_at))) {
    throw unexpectedResponseError("Browser provisioning response does not match the generated ScreenProvisioning contract.", client.requestId,
      "The server may have created the screen. Run screenrig screen list to find it before provisioning again.");
  }
  const urls = validateProvisioningUrls(provisioned);
  if ("withheld" in urls) {
    // The screen exists now. Report it and say why the handoff is not shown;
    // a rerun would replay the same answer, so the retry key is done too.
    await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
    const warning = { code: "provisioning_url_withheld", message: `The screen was created, but its provisioning URL is not shown: ${urls.withheld} Report the request_id with screenrig feedback bug, and archive the screen if it is not needed.` };
    return {
      envelope: successEnvelope({ screen_id: provisioned.screen.id, expires_at: provisioned.expires_at, url_withheld: urls.withheld }, { request_id: client.requestId, warnings: [warning] }),
      exitCode: ExitCode.Success,
      human: humanLines("Screen created; provisioning URL withheld", [
        ["screen_id", provisioned.screen.id],
        ["expires_at", provisioned.expires_at],
        ["url_withheld", urls.withheld],
      ]),
    };
  }
  const opened = openMode ? await (runtime.openUrl?.(urls.provisioningUrl) ?? Promise.resolve(false)) : false;
  if (printMode || opened) await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
  const data = {
    screen_id: provisioned.screen.id,
    public_url: urls.publicUrl,
    expires_at: provisioned.expires_at,
    ...(openMode ? { opened } : { provisioning_url: urls.provisioningUrl }),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(openMode ? "Browser provisioning" : "Sensitive one-time browser provisioning URL", [
      ["screen_id", provisioned.screen.id],
      ["public_url", urls.publicUrl],
      ["expires_at", provisioned.expires_at],
      ...(openMode ? [["opened", opened ? "true" : "false"] as [string, string]] : [["provisioning_url", urls.provisioningUrl] as [string, string]]),
    ]),
  };
}, true);

/**
 * The `Storage forecast` block `screen storage-forecast` prints. A report
 * older than 24 hours (per received_at) is marked stale, exactly like the
 * Storage block, but the forecast is still shown. With fit unknown the byte
 * counts and report time are null and their lines are omitted.
 */
export function forecastLines(screenId: string, playlistId: string, forecast: ScreenStorageForecastDryRun, now: Date): string {
  const receivedMs = forecast.received_at === null ? Number.NaN : Date.parse(forecast.received_at);
  const stale = Number.isFinite(receivedMs) && now.getTime() - receivedMs > STORAGE_STALE_MS;
  return humanLines(stale ? "Storage forecast (stale)" : "Storage forecast", [
    ["screen_id", screenId],
    ["playlist_id", playlistId],
    ["fit", forecast.fit],
    ["excluded pages", String(forecast.excluded_page_count)],
    ["required", forecast.required_bytes === null ? undefined : formatBytes(forecast.required_bytes)],
    ["capacity", forecast.capacity_bytes === null ? undefined : formatBytes(forecast.capacity_bytes)],
    ["basis", forecast.basis],
    ["received_at", forecast.received_at === null ? undefined : forecast.received_at],
  ]);
}

export const handleScreenPair = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  // The Player shows the code grouped ("ABC 234"), so an unquoted code
  // arrives as two arguments.
  const rawCode = args.positionals.slice(2).join(" ");
  if (!rawCode) throw usageError("screen pair requires CODE.");
  const code = canonicalPairingCode(rawCode, "screen pair CODE");
  const label = flagString(args.flags, "name");
  const request: PairScreen = { code, ...(label ? { label } : {}) };
  const response = await client.call({
    method: "POST",
    path: "/api/screens/pair",
    idempotent: true,
    body: request,
  });
  requirePrivateNoStore(response.headers, "Screen pairing response");
  const claim = response.body as PairingClaim;
  if (!claim.screen?.id || !claim.screen.label || !claim.public_url) {
    throw usageError("Screen pairing response does not match the generated PairingClaim contract.");
  }
  // The claim is done; the Player still has to pick it up. Say how to see that happen.
  const waiting = claim.screen.state === "pairing_pending" || claim.screen.online === false;
  const next = waiting ? {
    command: `screenrig screen show ${claim.screen.id}`,
    argv: ["screen", "show", claim.screen.id],
    reason: "The Player finishes pairing the next time it contacts the service, with nothing to do on the display. screen show reports state active and online true once it has; assign a playlist with screen assign meanwhile or after.",
  } : undefined;
  return {
    envelope: jsonBody(response, client.requestId, next ? { next } : undefined),
    exitCode: ExitCode.Success,
    human: humanLines("Screen paired", [
      ["code", code],
      ["screen_id", claim.screen.id],
      ["label", claim.screen.label],
      ["state", claim.screen.state],
      ["next", next ? `${next.command} (the Player finishes pairing when it next contacts the service)` : undefined],
    ]),
  };
}, true);

export const handleScreenShow = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  if (!id) throw usageError("screen show requires an id.");
  const response = await client.call({ method: "GET", path: `/api/screens/${id}` });
  const screen = response.body as Screen | undefined;
  const requestId = client.requestId;
  const notes = await resourceNotes(runtime, client, "screen", id);
  const warnings = screenStorageWarnings(id, screen, runtime.now());
  return {
    envelope: jsonBody(response, requestId, undefined, [...notes.warnings, ...warnings]),
    exitCode: ExitCode.Success,
    human: [
      "Screen",
      JSON.stringify(response.body, null, 2),
      ...(screenTags(screen).length ? [`Tags: ${screenTags(screen).join(", ")}`] : []),
      ...screenFolderLine(screen),
      ...screenFactsLines(screen),
      ...(screen?.fleet_link_id ? [`Created by fleet link: ${screen.fleet_link_id}`] : []),
      ...screenLinkSummaryLines(screen?.link),
      ...assignmentLine(screen?.effective_playlist, screen?.takeover, screen?.timezone),
      ...takeoverLine(screen?.takeover, screen?.timezone),
      ...(screen?.playlist_schedule?.entries?.length
        ? [`Playlist schedule: ${screen.playlist_schedule.entries.length} entr${screen.playlist_schedule.entries.length === 1 ? "y" : "ies"}${screen.playlist_schedule.entries.some((entry) => entry.paused) ? `, ${screen.playlist_schedule.entries.filter((entry) => entry.paused).length} draft` : ""} (screen schedule show ${screen.id})`] : []),
      ...suspensionLines(screen),
      ...glassLines(screen),
      ...hostLines(screen?.host, screen?.host_updated_at),
      ...archivedLines(screen),
      ...replacedByLines(screen),
      ...applicationsUnsupportedLines(screen),
      ...recoveryPendingLine(screen),
      ...warnings.map((warning) => `warning: ${warning.message}`),
      ...storageLines(screen, runtime.now()),
      ...manifestUpgradeLines(screen, runtime.now()),
      ...displayLines(screen?.display, screen?.timezone),
      ...rebootScheduleLines(screen?.reboot_schedule, screen?.next_reboot_at, screen?.timezone),
      ...healthLines(screen?.health),
      ...outageLines(screen),
      ...commandLines(screen),
      ...notes.lines,
    ].join("\n"),
  };
}, true);

export const handleScreenStorageForecast = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const playlistId = flagString(args.flags, "playlist-id");
  const playlistRevision = flagString(args.flags, "playlist-rev");
  if (!id || !playlistId) throw usageError("screen storage-forecast requires <id> --playlist-id.");
  // A read-only dry run: no idempotency key, because the route writes nothing
  // and has no replay semantics to make safe.
  const body: ScreenStorageForecastRequest = {
    playlist_id: playlistId,
    ...(playlistRevision ? { playlist_revision: Number(playlistRevision) } : {}),
  };
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/storage-forecast`,
    body,
  });
  const forecast = response.body as ScreenStorageForecastDryRun | undefined;
  if (!forecast
    || !["fits", "partial", "none_fit", "unknown"].includes(forecast.fit)
    || !Number.isSafeInteger(forecast.excluded_page_count)
    || forecast.excluded_page_count < 0
    || !(forecast.required_bytes === null || (Number.isSafeInteger(forecast.required_bytes) && forecast.required_bytes >= 0))
    || !(forecast.capacity_bytes === null || (Number.isSafeInteger(forecast.capacity_bytes) && forecast.capacity_bytes >= 0))
    || !(forecast.received_at === null || serverInstant(forecast.received_at) !== undefined)
    || forecast.basis !== "reported_capacity") {
    throw usageError("Screen storage forecast response does not match the generated ScreenStorageForecastDryRun contract.");
  }
  const warnings = forecastStorageWarnings(id, forecast, runtime.now());
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [forecastLines(id, playlistId, forecast, runtime.now()), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

export const handleScreenUpdate = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const ifMatch = flagString(args.flags, "expect-rev");
  const name = flagString(args.flags, "name");
  const playlistId = flagString(args.flags, "playlist-id");
  const timezone = flagString(args.flags, "timezone");
  const facts = screenFactsPatch(args.flags);
  const changesFacts = facts.fields !== undefined || facts.location !== undefined;
  if (!id || (!name && !playlistId && !timezone && !changesFacts)) {
    throw usageError("screen update requires <id>, and --name, --playlist-id, --timezone, --field, --unset-field, --clear-fields, --location, or --clear-location.");
  }
  // A patch that sets both a playlist and a timezone satisfies the schedule
  // rule in one request, so only check when the patch leaves the screen
  // without one.
  let playlist: unknown;
  if (playlistId && !timezone) {
    playlist = await assertScheduledPlaylistHasZone(client, id, playlistId);
  } else if (playlistId) {
    // This read exists only for advisory aspect warnings. A missing warning
    // must not block a patch that supplies the required timezone itself.
    try {
      playlist = (await callPlaylist(client, { method: "GET", id: playlistId })).body;
    } catch {
      playlist = undefined;
    }
  }
  const body: ScreenPatch = {
    ...(name ? { name } : {}),
    ...(playlistId ? { playlist_id: playlistId } : {}),
    ...(timezone ? { timezone } : {}),
    ...facts,
  };
  const response = await client.call({ method: "PATCH", path: `/api/screens/${id}`, idempotent: true, headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined, body });
  // A playlist-only change under Propose access waits for review.
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  // The answer's screen_fact_missing warning (a playlist the screen shows reads a value it lacks) moves into the envelope.
  const warnings = [
    ...(playlistId ? aspectMismatchWarnings(id, response.body, playlist) : []),
    ...screenStorageWarnings(id, response.body as Screen | undefined, runtime.now()),
    ...playlistAnswerWarnings(response.body),
  ];
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    // The merged fields and the location the screen now holds, when this update changed them.
    // Tags change through screen tag; an answer that carries levels (a tag change) prints them here too.
    human: [`Updated screen ${id}`, ...(changesFacts ? screenFactsLines(response.body as Screen | undefined) : []), ...levelsLines((response.body as Screen | undefined)?.levels), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

export const handleScreenAssign = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const playlistId = flagString(args.flags, "playlist-id");
  const ifMatch = flagString(args.flags, "expect-rev");
  if (!playlistId) throw usageError("screen assign requires <id> --playlist-id.");
  const target = screenTarget(args, "screen assign");
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen assign");
    // Each screen runs the single-screen PATCH on the server, including its
    // timezone rule for scheduled playlists; a refusal is that screen's result.
    return screenFleetAction(client, runtime, "Fleet assign", target.selector, { type: "assign", playlist_id: playlistId }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const playlist = await assertScheduledPlaylistHasZone(client, id, playlistId);
  const body: ScreenPatch = { playlist_id: playlistId };
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${id}`,
    idempotent: true,
    headers: { ...reviewNoteFrom(args), ...(ifMatch ? { "if-match": quotedRevision(ifMatch) } : {}) },
    body,
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  const warnings = [
    ...aspectMismatchWarnings(id, response.body, playlist),
    ...screenStorageWarnings(id, response.body as Screen | undefined, runtime.now()),
    ...playlistAnswerWarnings(response.body),
  ];
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [`Assigned playlist ${playlistId} to ${id}`, ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

export const handleScreenSetTimezone = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const timezone = flagString(args.flags, "timezone");
  const ifMatch = flagString(args.flags, "expect-rev");
  if (!id || !timezone) throw usageError("screen set-timezone requires <id> --timezone.");
  // The zone database belongs to the server, which validates the identifier
  // against it. Sending the value unchanged keeps one authority for what a
  // real zone is, so the CLI never carries a list that can go stale.
  const body: ScreenPatch = { timezone };
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${id}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
    body,
  });
  const lifted = playlistAnswerWarnings(response.body);
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, client.requestId, undefined, lifted),
    exitCode: ExitCode.Success,
    human: [`Set timezone ${timezone} on ${id}`, ...lifted.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

/** screen wall set|clear: one ScreenPatch carrying only wall; null clears it. */
export async function screenWallPatch(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, id: string, wall: ScreenPatch["wall"]) {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const ifMatch = flagString(args.flags, "expect-rev");
  const body: ScreenPatch = { wall };
  let response;
  try {
    response = await client.call({
      method: "PATCH",
      path: `/api/screens/${encodeURIComponent(id)}`,
      idempotent: true,
      headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
      body,
    });
  } catch (error) {
    throw wallProblem(error, id);
  }
  return { response, client, screen: response.body as Screen | undefined };
}

export const handleScreenWallSet = commandHandler(async (args, runtime, resolved) => {
  // positionals are [screen, wall, set, ID].
  const id = args.positionals[3];
  const outputs = flagString(args.flags, "outputs");
  const arrangement = flagString(args.flags, "arrangement");
  if (!id || !outputs || !arrangement) throw usageError("screen wall set requires <id> --outputs --arrangement.");
  const wall = wallFromFlags(outputs, arrangement, flagString(args.flags, "rotation"), flagString(args.flags, "columns"));
  const { response, client, screen } = await screenWallPatch(args, runtime, resolved, id, wall);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Set video wall on ${id}: ${wallLine(wall)}`,
      "Once the screen plays a playlist with a matching format, every display shows its number and name for 20 seconds after a change; playlist init --screen-id writes that format.",
      ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : []),
    ].join("\n"),
  };
}, true);

export const handleScreenWallClear = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen wall clear requires <id>.");
  const { response, client, screen } = await screenWallPatch(args, runtime, resolved, id, null);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Cleared the video wall on ${id}`, ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : [])].join("\n"),
  };
}, true);

export async function screenArchiveUnarchiveAction(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, action: "archive" | "unarchive"): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const revision = flagString(args.flags, "expect-rev");
  if (!id) throw usageError(`screen ${action} requires <id>.`);
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/${action}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: action === "archive" ? `Archived screen ${id}` : `Unarchived screen ${id}`,
  };

}

export const handleScreenArchive = commandHandler(async (args, runtime, resolved) => {
  return screenArchiveUnarchiveAction(args, runtime, resolved, "archive");
}, true);

export const handleScreenUnarchive = commandHandler(async (args, runtime, resolved) => {
  return screenArchiveUnarchiveAction(args, runtime, resolved, "unarchive");
}, true);

export const handleScreenDelete = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const ifMatch = flagString(args.flags, "expect-rev");
  if (!id) throw usageError("screen delete requires <id>.");
  const response = await client.call({
    method: "DELETE",
    path: `/api/screens/${id}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted screen ${id}` };
}, true);

export const handleScreenRotatePublicId = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const revision = flagString(args.flags, "expect-rev");
  if (!id) throw usageError("screen rotate-public-id requires <id>.");
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/public-id/rotate`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `Rotated public id for ${id}`,
  };
}, true);

export const RECOVERY_PROBLEM_MESSAGES: Record<string, { detail: string; next: ProblemNext }> = {
  recovery_not_offered: {
    detail: "No recovery is pending for this screen. A display has to start pairing and report this screen's identifiers before recovery can be confirmed.",
    next: { command: "screenrig screen show <id>", reason: "Check recovery_pending. If the display is showing a pairing code, pair it as a new screen instead." },
  },
  recovery_expired: {
    detail: "The recovery offer for this screen has expired because the display's pairing session lapsed. Nothing was rebound.",
    next: { command: "screenrig screen show <id>", reason: "Restart pairing on the display; a new offer appears as recovery_pending." },
  },
  recovery_ambiguous: {
    detail: "The display's identifiers are attached to more than one screen, so recovery cannot be offered. Nothing was rebound.",
    next: { command: "screenrig screen pair <code>", reason: "Pair the display as a new screen, or archive the duplicate screens first." },
  },
};

export const handleScreenRecover = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  if (!id) throw usageError("screen recover requires <id>.");
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    // A fresh Idempotency-Key per invocation: the client mints one when the
    // operator did not pass --idempotency-key, and write recovery keeps it.
    response = await client.call({
      method: "POST",
      path: `/api/screens/${id}/recovery/confirm`,
      idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    const mapped = error instanceof CliError ? RECOVERY_PROBLEM_MESSAGES[error.problem.code] : undefined;
    if (!(error instanceof CliError) || !mapped) throw error;
    const next = { ...mapped.next, command: mapped.next.command.replace("<id>", id) };
    throw new CliError({ ...error.problem, detail: mapped.detail, next: error.problem.next ?? next }, error.exitCode, error.warnings);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Recovered screen ${id}`, [
        ["screen_id", screen?.id],
        ["label", screen?.label],
        ["state", screen?.state],
        ["revision", screen?.revision === undefined ? undefined : String(screen.revision)],
        ["public_id", screen?.public_id],
        ["platform", screen?.host?.platform],
      ]),
      "The display now runs this screen with its new key; the previous key retires after a fifteen-minute grace window.",
    ].join("\n"),
  };
}, true);

export const handleScreenReload = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const target = screenTarget(args, "screen reload");
  const lifetime = commandLifetime(args);
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen reload");
    return screenFleetAction(client, runtime, "Fleet reload", target.selector, { type: "reload", ...lifetime });
  }
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: `/api/screens/${encodeURIComponent(id)}/reload`,
      idempotent: true,
      ...(lifetime.expires_in_s === undefined ? {} : { body: lifetime }),
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    if (!(error instanceof CliError) || error.problem.next) throw error;
    // A pairing_pending screen has no Player to reload yet.
    if (error.problem.code === "resource_conflict") {
      throw new CliError({
        ...error.problem,
        next: { command: `screenrig screen show ${id}`, reason: "A screen still waiting to pair has no Player to reload. Pair it first." },
      }, error.exitCode, error.warnings);
    }
    throw error;
  }
  const accepted = (response.body ?? {}) as Partial<ScreenReloadAccepted>;
  if (typeof accepted.reload_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(accepted.reload_id)
    || serverInstant(accepted.expires_at) === undefined || !validDelivery(accepted.state)) {
    throw usageError("Screen reload response does not match the generated ScreenReloadAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Reload accepted", [
        ["screen_id", id],
        ["reload_id", accepted.reload_id],
        ["state", accepted.state],
        ["expires_at", accepted.expires_at],
      ]),
      accepted.state === "queued"
        ? `The screen is offline, so the reload waits: it is sent when the screen comes online before expires_at. Cancel it with screen command cancel ${id} ${accepted.reload_id}.`
        : "The Player reloads once; a Player that reloaded in the last ten minutes ignores it.",
    ].join("\n"),
  };
}, true);

/** --expires-in as the expires_in_s of a queued command; empty when the flag is absent, so the server's 24 hours applies. */
export function commandLifetime(args: ParsedArgs): ScreenCommandWrite {
  const value = flagString(args.flags, "expires-in");
  return value === undefined ? {} : { expires_in_s: expiresInSeconds(value) };
}

/** The state of a queued command's answer: queued or sent. */
export function validDelivery(state: unknown): boolean {
  return state === "queued" || state === "sent";
}

/**
 * One fleet action for any number of screens: one metered action across
 * bounded continuations, paced against control budgets. Aggregate every
 * result page; partial success keeps `ok: true` and moves the exit code (see
 * fleetOutcome). An Idempotency-Key is always sent. The command's write
 * recovery keeps it only while the outcome is unknown: rerunning the
 * identical command after an interrupted or ambiguous request replays
 * finished screens without repeating their side effects. A returned answer,
 * including a partial failure, completes the write, so a later rerun is a new
 * request.
 */
export async function screenFleetAction(client: ApiClient, runtime: CliRuntime, title: string, selector: ScreenActionSelector, action: ScreenAction, recoverySupersede?: string, headers?: Record<string, string>): Promise<CommandResult> {
  const body: ScreenActionRequest = { selector, action };
  let response;
  let after: string | undefined;
  const result: import("../adapters/protocol.js").ScreenActionResult = { action: action.type, matched: 0, succeeded: 0, failed: 0, results: [] };
  let total: number | undefined;
  const answerWarnings: Warning[] = [];
  const pageLevels: Array<ScreenLevelChanges | undefined> = [];
  while (true) {
    try {
      response = await client.call({ method: "POST", path: "/api/screens/actions", idempotent: true, body,
        ...(after === undefined ? {} : { query: { after } }), recoveryQuery: {}, retainRecoveryOnRefusal: true,
        ...(recoverySupersede ? { recoverySupersede } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}) });
    } catch (error) {
      if (error instanceof CliError && error.problem.status === 429 && error.problem.retry_after_seconds) {
        await runtime.sleep(error.problem.retry_after_seconds * 1000);
        continue;
      }
      throw error;
    }
    // Under Propose access the whole fleet change is one review; a 202 is
    // otherwise a continuation page.
    const pending = pendingReviewOf(response);
    if (pending) {
      if (after !== undefined) throw unexpectedResponseError("A fleet continuation answered pending_review after screens already changed; rerun the identical command to resume safely.");
      return { ...pendingReviewResult(response, pending, client.requestId), keepRecoveryUntilOutput: true };
    }
    const page = screenActionResult(response.body, action.type);
    if ((page.offset ?? 0) !== result.matched || (total !== undefined && page.total !== total)) {
      throw unexpectedResponseError("Fleet continuation does not match the selected screens; rerun the identical command to resume safely.");
    }
    if (page.total !== undefined) total = page.total;
    result.matched += page.matched;
    result.succeeded += page.succeeded;
    result.failed += page.failed;
    result.results.push(...page.results);
    // A fleet assign page answers screen_fact_missing when a playlist it assigns reads a value some screen of the page lacks.
    answerWarnings.push(...playlistWarnings(page.warnings ?? []));
    pageLevels.push(page.levels);
    if (page.next_cursor === undefined) {
      if (response.status !== 200 || (total !== undefined && result.matched !== total)) {
        throw unexpectedResponseError("Fleet action ended without all selected screens; rerun the identical command to resume safely.");
      }
      break;
    }
    if (response.status !== 202 || page.next_cursor !== String(result.matched)) {
      throw unexpectedResponseError("Fleet continuation cursor does not match its results.");
    }
    after = page.next_cursor;
    const wait = Number(response.headers["retry-after"] ?? 0);
    if (!page.matched && (!Number.isFinite(wait) || wait <= 0)) {
      throw unexpectedResponseError("Fleet action made no progress and supplied no Retry-After; rerun the identical command to resume safely.");
    }
    if (wait > 0 && Number.isFinite(wait)) await runtime.sleep(wait * 1000);
  }
  const outcome = fleetOutcome(result);
  // The tag actions answer the campaigns the screens entered or left, page by page; the envelope carries them added up.
  const levels = sumLevels(pageLevels);
  if (levels) result.levels = levels;
  return {
    envelope: jsonBody({ ...response, body: result }, client.requestId, undefined, [...outcome.warnings, ...answerWarnings]),
    exitCode: outcome.exitCode,
    human: [
      fleetHumanLines(title, result, (item) => {
        if (Array.isArray(item.tags)) return `tags ${item.tags.filter((tag) => /^[A-Za-z0-9]{1,32}$/.test(tag)).join(",") || "(none)"}`;
        if (typeof item.revision === "number") return `revision ${item.revision}`;
        const maintenance = item.command && (item.command.command === "clear_cache" || item.command.command === "restart_app" || item.command.command === "update")
          ? commandResultText(item.command.command, item.command) : undefined;
        const command = commandResultText("reload", item.reload) ?? commandResultText("reboot", item.reboot) ?? maintenance;
        if (command) return command;
        if (item.toast && serverInstant(item.toast.expires_at)) return `toast expires ${item.toast.expires_at}`;
        return undefined;
      }),
      ...levelsLines(levels),
      ...outcome.warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

/**
 * `screen tag`: exactly one of --set, --add, --remove, --clear.
 *
 * One screen id uses PATCH /api/screens/{id} with the whole tag set, the
 * same revision semantics as every other single-screen write. --set and
 * --clear send the set directly (If-Match only with --expect-rev). --add and
 * --remove read the screen, compute the new set, and PATCH it guarded by
 * --expect-rev or, when omitted, by the revision just read, so a concurrent
 * change fails with revision_conflict instead of being overwritten.
 *
 * Several ids or --tag use the fleet actions route (set_tags, add_tags,
 * remove_tags), which applies add/remove against each stored set atomically
 * and takes no revision guard.
 */
export const handleScreenTag = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  for (const flag of ["set", "add", "remove"]) requireFlagValue(args, flag, "Lobby");
  const set = flagString(args.flags, "set");
  const add = flagString(args.flags, "add");
  const remove = flagString(args.flags, "remove");
  const clear = flagBool(args.flags, "clear");
  if ([set, add, remove].filter((value) => value !== undefined).length + (clear ? 1 : 0) !== 1) {
    throw usageError("Provide exactly one of --set or --add or --remove or --clear.");
  }
  const tags = set !== undefined ? screenTagList(set, "--set")
    : add !== undefined ? screenTagList(add, "--add")
    : remove !== undefined ? screenTagList(remove, "--remove")
    : [];
  const target = screenTarget(args, "screen tag");
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen tag");
    const action: ScreenAction = add !== undefined ? { type: "add_tags", tags }
      : remove !== undefined ? { type: "remove_tags", tags }
      : { type: "set_tags", tags };
    return screenFleetAction(client, runtime, "Fleet tag", target.selector, action);
  }
  const id = target.id;
  let ifMatch = flagString(args.flags, "expect-rev");
  let next = tags;
  if (add !== undefined || remove !== undefined) {
    const current = (await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` })).body as Screen | undefined;
    if (!current || current.id !== id || !Number.isSafeInteger(current.revision) || current.revision < 1) {
      throw usageError("Screen response has invalid identity or revision.");
    }
    const stored = Array.isArray(current.tags) ? current.tags : [];
    next = add !== undefined ? [...stored, ...tags.filter((tag) => !stored.includes(tag))] : stored.filter((tag) => !tags.includes(tag));
    if (next.length > SCREEN_TAGS_MAX) {
      throw usageError(`Screen ${id} would carry ${next.length} tags; a screen carries at most ${SCREEN_TAGS_MAX}. Remove tags first or use --set.`);
    }
    ifMatch ??= String(current.revision);
  }
  const body: ScreenPatch = { tags: next };
  const derived = add !== undefined || remove !== undefined;
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${encodeURIComponent(id)}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
    body,
    // The body and guard derive from the read, so a rerun after an ambiguous
    // failure fingerprints differently; it supersedes the obsolete entry.
    ...(derived ? { recoverySupersede: JSON.stringify(["screen tag", id, add !== undefined ? "add" : "remove", tags, flagString(args.flags, "expect-rev") ?? null]) } : {}),
  });
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Tagged screen ${id}`, [
        ["tags", screenTags(screen).join(", ") || "(none)"],
        ["revision", typeof screen?.revision === "number" ? String(screen.revision) : undefined],
      ]),
      ...levelsLines(screen?.levels),
    ].join("\n"),
  };
}, true);

export const handleScreenToast = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return screenToast(args, runtime, client);
}, true);

export const handleScreenScreenshot = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "screenshot.capture", message: "screen screenshot" }, () =>
    screenScreenshot(args, runtime, client),
  );
}, true);

export async function screenToast(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const body = toastWriteFromArgs(args);
  const target = screenTarget(args, "screen toast");
  if (target.kind === "fleet") {
    return screenFleetAction(client, runtime, "Fleet toast", target.selector, { type: "toast", ...body });
  }
  const id = target.id;
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/toast`,
    idempotent: true,
    body,
  });
  const accepted = (response.body ?? {}) as ScreenToastAccepted;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Toast accepted", [
      ["screen_id", id],
      ["level", body.level],
      ["expires_at", accepted.expires_at],
    ]),
  };
}

/** The validated toast write shared by the single-screen route and the fleet toast action. */
export function toastWriteFromArgs(args: ParsedArgs): ScreenToastWrite {
  if (args.flags.level === true) {
    throw usageError("--level requires a value, such as --level info.");
  }
  if (args.flags.text === true) {
    throw usageError("--text requires a value.");
  }
  if (args.flags["duration-ms"] === true) {
    throw usageError("--duration-ms requires a value.");
  }
  const rawLevel = flagString(args.flags, "level");
  const rawText = flagString(args.flags, "text");
  if (rawText === undefined) {
    throw usageError("screen toast requires <id> and --text TEXT.");
  }
  const level = rawLevel ?? TOAST_DEFAULT_LEVEL;
  if (!isScreenToastLevel(level)) {
    throw usageError("--level must be error, alert, or info. Agent toasts use --level info.");
  }
  const text = trimToastText(rawText);
  const textLength = [...text].length;
  if (
    textLength < 1
    || textLength > TOAST_TEXT_MAX
    || toastTextHasDisallowedControl(text)
    || toastLineCount(text) > TOAST_MAX_LINES
  ) {
    throw usageError(
      "Toast text must be 1 to 120 characters, use only line feed as a line break, and have at most three lines.",
    );
  }
  const body: ScreenToastWrite = { level, text };
  if (args.flags["duration-ms"] !== undefined) {
    const durationMs = flagNumber(args.flags, "duration-ms");
    if (
      durationMs === undefined
      || !Number.isInteger(durationMs)
      || durationMs < TOAST_DURATION_MIN
      || durationMs > TOAST_DURATION_MAX
    ) {
      throw usageError("--duration-ms must be an integer between 2000 and 60000.");
    }
    body.duration_ms = durationMs;
  }
  return body;
}

export type ScreenshotFailure = "timed_out" | "unsupported_surface" | "capture_failed" | "unavailable" | "deadline" | "offline";

export const SCREENSHOT_FAILURE_DETAIL: Record<ScreenshotFailure, string> = {
  timed_out: "The Player did not upload the screenshot before the request expired (timed_out).",
  unsupported_surface: "The Player cannot capture the page it is showing now (unavailable: unsupported_surface).",
  capture_failed: "The Player tried to capture its screen and failed (unavailable: capture_failed).",
  unavailable: "The Player reported the screenshot as unavailable.",
  deadline: "No screenshot arrived before --timeout; the Player may still upload it (pending).",
  offline: "The screen is offline, so its Player cannot take a screenshot.",
};

export const SCREENSHOT_FAILURE_HINT: Record<ScreenshotFailure, string> = {
  timed_out: "Check the screen is online with screenrig screen show ID, then run screen screenshot again; every run requests a new capture.",
  unsupported_surface: "Capture again while the screen shows an image, video or application page; screenrig screen show ID shows what it plays.",
  capture_failed: "Run screen screenshot again; every run requests a new capture.",
  unavailable: "Run screen screenshot again; every run requests a new capture.",
  deadline: "Run screen screenshot again with a larger --timeout; every run requests a new capture.",
  offline: "Bring the Player back online (screenrig screen show ID shows last_online_at), then run screen screenshot again.",
};

export function screenshotUnavailable(requestId: string, failure: ScreenshotFailure, lastSeen?: string): CliError {
  const detail = failure === "offline" && lastSeen
    ? `The screen is offline (last online ${lastSeen}), so its Player cannot take a screenshot.`
    : SCREENSHOT_FAILURE_DETAIL[failure];
  return new CliError(
    makeProblem("screenshot_unavailable", "Screenshot is not available", 409, detail, {
      request_id: requestId,
      hint: SCREENSHOT_FAILURE_HINT[failure],
    }),
  );
}

export function screenshotFailure(status: ScreenScreenshotStatus): ScreenshotFailure {
  if (status.state === "timed_out") return "timed_out";
  return status.reason === "unsupported_surface" || status.reason === "capture_failed" ? status.reason : "unavailable";
}

export async function resolveScreenshotOutput(cwd: string, id: string, flags: ParsedArgs["flags"]): Promise<string> {
  return resolveDownloadOutput(cwd, `./${id}.webp`, flags);
}

export async function screenScreenshot(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const target = screenTarget(args, "screen screenshot");
  if (target.kind === "fleet") return screenScreenshotFleet(args, runtime, client, target.selector);
  const id = target.id;
  if (!isScreenId(id)) {
    throw usageError("screen screenshot requires <id>.");
  }
  const outputPath = await resolveScreenshotOutput(runtime.cwd(), id, args.flags);
  const saved = await captureScreenshot(runtime, client, id, outputPath, screenshotOptions(args, runtime), client.idempotencyKey);
  // The screen's own picture verdict, if it has one, goes beside the image.
  const screen = await screenAfterScreenshot(client, id);
  const picture = screen?.glass?.picture;
  const data = { ...saved, ...(picture ? { picture } : {}) };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Screenshot saved", [
        ["screen_id", data.screen_id],
        ["capture_id", data.capture_id],
        ["path", data.path],
        ["bytes", String(data.bytes)],
        ["sha256", data.sha256],
        ["width", String(data.width)],
        ["height", String(data.height)],
        ["frame", frameRow(data.frame)],
      ]),
      ...flatFrameNote(data.frame, screen),
      ...glassLines(screen),
    ].join("\n"),
  };
}

/**
 * Read the screen once after its screenshot is saved, for the glass verdicts.
 * Best effort, as the explanation of a failed capture is: the screenshot is
 * already on disk, and a screen that cannot be read now prints without them.
 */
export async function screenAfterScreenshot(client: ApiClient, id: string): Promise<Screen | undefined> {
  try {
    return (await client.call({ method: "GET", path: `/api/screens/${id}` })).body as Screen | undefined;
  } catch {
    return undefined;
  }
}

/** How one invocation's captures wait, retry and report progress. */
export interface ScreenshotOptions {
  /** Whole wait per capture in ms; 0 leaves it to the server, which expires an unanswered request after 30 s. */
  timeoutMs: number;
  pollMs: number;
  /** Without an explicit --timeout, a Retry-After longer than the remaining wait is still honoured. */
  explicitTimeout: boolean;
  /** Shared by every capture of one invocation: no capture request goes out before this instant. */
  pace: { until: number };
  /** Progress lines for stderr, in human mode or when stderr is a terminal. */
  notify?: (line: string) => void;
}

export function screenshotOptions(args: ParsedArgs, runtime: CliRuntime): ScreenshotOptions {
  const { timeoutMs, pollMs } = screenshotTiming(args);
  const visible = flagBool(args.flags, "human") || runtime.isStderrTty?.() === true;
  return {
    timeoutMs,
    pollMs,
    explicitTimeout: flagNumber(args.flags, "timeout") !== undefined,
    pace: { until: 0 },
    ...(visible ? { notify: (line: string) => { runtime.stderr.write(`${line}\n`); } } : {}),
  };
}

export function screenshotTiming(args: ParsedArgs): { timeoutMs: number; pollMs: number } {
  const timeoutMs = flagNumber(args.flags, "timeout") ?? SCREENSHOT_DEFAULT_WAIT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw usageError("--timeout must be a non-negative number of milliseconds.");
  }
  if (args.flags["poll-ms"] !== undefined) {
    const pollMs = flagNumber(args.flags, "poll-ms");
    if (pollMs === undefined || !Number.isInteger(pollMs) || pollMs < 1) {
      throw usageError("--poll-ms must be a positive integer.");
    }
  }
  const pollMs = flagNumber(args.flags, "poll-ms") ?? SCREENSHOT_DEFAULT_POLL_MS;
  return { timeoutMs, pollMs };
}

export interface ScreenshotSaved {
  screen_id: string;
  capture_id: string;
  path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  /** What the backend read of this image; absent when it could not be read. */
  frame?: ScreenScreenshotFrame;
}

export const SCREENSHOT_RETRY_MAX = 6;
export const SCREENSHOT_BACKOFF_MS = 500;
export const SCREENSHOT_BACKOFF_CAP_MS = 8000;
/** The longest Retry-After a capture honours past its default wait. */
export const SCREENSHOT_RETRY_AFTER_CAP_MS = 120_000;

/** Network failures, timeouts, 429 and 5xx answers: the capture may still succeed on a later try. */
export function transientScreenshotFailure(error: unknown): error is CliError {
  return error instanceof CliError && error.problem.code !== "file_error"
    && (error.problem.status >= 500 || error.problem.status === 408 || error.problem.status === 429);
}

/**
 * Bounded backoff shared by every step of one capture. Retry-After wins over
 * the exponential step; a wait that would pass the deadline ends the capture
 * with the last real failure.
 */
export class ScreenshotRetry {
  private attempts = 0;
  deadline: number;
  constructor(private readonly runtime: CliRuntime, private readonly id: string, readonly options: ScreenshotOptions) {
    this.deadline = options.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  }

  async wait(error: CliError): Promise<void> {
    const after = error.problem.retry_after_seconds;
    const delay = typeof after === "number" ? after * 1000 : Math.min(SCREENSHOT_BACKOFF_MS * 2 ** this.attempts, SCREENSHOT_BACKOFF_CAP_MS);
    if (typeof after === "number" && error.problem.status === 429) {
      // A rate limit holds for every capture of this invocation, not just this one.
      this.options.pace.until = Math.max(this.options.pace.until, Date.now() + delay);
    }
    if (this.attempts >= SCREENSHOT_RETRY_MAX) throw this.exhausted(error);
    if (Date.now() + delay > this.deadline) {
      // The default wait honours one server-named wait, then allows a normal capture after it.
      if (this.options.explicitTimeout || typeof after !== "number" || delay > SCREENSHOT_RETRY_AFTER_CAP_MS) throw this.exhausted(error);
      this.deadline = Date.now() + delay + SCREENSHOT_DEFAULT_WAIT_MS;
    }
    this.attempts += 1;
    const reason = error.problem.code === "transport_error" || error.problem.code === "timeout"
      ? error.problem.code : `${error.problem.code} (HTTP ${error.problem.status})`;
    this.options.notify?.(`screen screenshot ${this.id}: ${reason}; retrying in ${Math.ceil(delay / 1000)} s${typeof after === "number" ? " as Retry-After asks" : ""} (retry ${this.attempts} of ${SCREENSHOT_RETRY_MAX}).`);
    await this.runtime.sleep(delay);
  }

  /** Sleep before the next poll, never past the deadline. */
  async poll(): Promise<void> {
    await this.runtime.sleep(Math.max(1, Math.min(this.options.pollMs, this.deadline - Date.now())));
  }

  /** Hold a new capture request until a shared Retry-After has passed. */
  async paced(): Promise<void> {
    const wait = this.options.pace.until - Date.now();
    if (wait <= 0) return;
    this.options.notify?.(`screen screenshot ${this.id}: waiting ${Math.ceil(wait / 1000)} s for the screenshot rate limit.`);
    if (Date.now() + wait > this.deadline && this.options.explicitTimeout) return;
    if (Date.now() + wait > this.deadline) this.deadline = Date.now() + wait + SCREENSHOT_DEFAULT_WAIT_MS;
    await this.runtime.sleep(wait);
  }

  private exhausted(error: CliError): CliError {
    const tried = this.attempts ? `screen screenshot retried this ${this.attempts} time${this.attempts === 1 ? "" : "s"} with backoff before giving up.` : "No retry fit before --timeout.";
    const hint = `${error.problem.hint ? `${error.problem.hint} ` : ""}${tried} Run screen screenshot again later; every run requests a new capture.`;
    return new CliError({ ...error.problem, hint }, error.exitCode, error.warnings);
  }
}

/**
 * Ask for a capture under one Idempotency-Key. After an ambiguous failure the
 * screen's status is read first: a pending capture is still in progress (ours,
 * or one requested elsewhere) and is adopted, because a new request would
 * replace it. Otherwise the same key is sent again, so a request the server
 * already accepted returns its original capture_id instead of starting another.
 */
export async function requestScreenshotCapture(client: ApiClient, id: string, key: string, retry: ScreenshotRetry): Promise<string> {
  let lastFailure: CliError | undefined;
  while (true) {
    if (lastFailure) {
      await retry.wait(lastFailure);
      try {
        const current = (await client.call({ method: "GET", path: `/api/screens/${id}/screenshot/status` })).body as ScreenScreenshotStatus | undefined;
        if (current?.state === "pending" && typeof current.capture_id === "string" && current.capture_id.length > 0) return current.capture_id;
      } catch (error) {
        if (!transientScreenshotFailure(error)) throw error;
        lastFailure = error;
        continue;
      }
    }
    let acceptedResponse;
    try {
      await retry.paced();
      acceptedResponse = await client.call({ method: "POST", path: `/api/screens/${id}/screenshot`, idempotent: true, idempotencyKey: key });
    } catch (error) {
      if (!transientScreenshotFailure(error)) throw error;
      lastFailure = error;
      continue;
    }
    const captureId = ((acceptedResponse.body ?? {}) as ScreenScreenshotAccepted).capture_id;
    if (typeof captureId !== "string" || captureId.length === 0) {
      throw new CliError(
        makeProblem("invalid_request", "Request is invalid", 400, "Screenshot request did not return a capture_id.", {
          request_id: client.requestId,
        }),
      );
    }
    return captureId;
  }
}

/**
 * A capture that expired or outlived --timeout usually means the Player is not
 * connected. Read the screen once to say so instead of the bare state.
 */
export async function explainedScreenshotFailure(client: ApiClient, id: string, failure: ScreenshotFailure): Promise<CliError> {
  if (failure === "timed_out" || failure === "deadline") {
    try {
      const screen = (await client.call({ method: "GET", path: `/api/screens/${id}` })).body as Partial<Screen> | undefined;
      if (screen?.online === false) return screenshotUnavailable(client.requestId, "offline", typeof screen.last_online_at === "string" ? screen.last_online_at : undefined);
    } catch {
      // The explanation is best effort; the capture's own state still stands.
    }
  }
  return screenshotUnavailable(client.requestId, failure);
}

/** One read, retried on transient failures until the shared retry budget runs out. */
export async function retriedScreenshotRead<T>(retry: ScreenshotRetry, read: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (!transientScreenshotFailure(error)) throw error;
      await retry.wait(error);
    }
  }
}

/**
 * Request, wait for, verify, and atomically write one screen's screenshot.
 * `key` is fresh for every run: a screenshot is an observation, so a stored
 * answer from an earlier run is never replayed.
 */
export async function captureScreenshot(runtime: CliRuntime, client: ApiClient, id: string, outputPath: string, options: ScreenshotOptions, key: string): Promise<ScreenshotSaved> {
  const retry = new ScreenshotRetry(runtime, id, options);
  let captureId = await requestScreenshotCapture(client, id, key, retry);

  let status: ScreenScreenshotStatus | undefined;
  await loggerOf(runtime).withLocal(
    { op: "screenshot.wait", message: `wait for screenshot ${id}` },
    async (span) => {
      while (true) {
        const statusResponse = await retriedScreenshotRead(retry, () => client.call({
          method: "GET",
          path: `/api/screens/${id}/screenshot/status`,
        }));
        status = (statusResponse.body ?? {}) as ScreenScreenshotStatus;
        const currentId = status.capture_id;
        span.progress({ capture_id: currentId, state: status.state });
        if (typeof currentId === "string" && currentId.length > 0 && currentId !== captureId) {
          // A later request for this screen replaced ours. It captures the same
          // screen, so wait for it and return it rather than failing.
          span.progress({ adopted_capture_id: currentId, replaced_capture_id: captureId });
          options.notify?.(`screen screenshot ${id}: a later request replaced capture ${captureId}; waiting for ${currentId}.`);
          captureId = currentId;
        }
        if (status.state === "ready" && currentId === captureId) {
          span.finish({ capture_id: captureId, state: status.state });
          return;
        }
        if ((status.state === "timed_out" || status.state === "unavailable") && currentId === captureId) {
          throw await explainedScreenshotFailure(client, id, screenshotFailure(status));
        }
        if (Date.now() >= retry.deadline) {
          throw await explainedScreenshotFailure(client, id, "deadline");
        }
        await retry.poll();
      }
    },
  );

  const download = await retriedScreenshotRead(retry, () => client.call({
    method: "GET",
    path: `/api/screens/${id}/screenshot`,
    query: { capture_id: captureId },
    headers: { accept: "image/webp" },
    binary: true,
  }));
  const bytes = download.body;
  const contentType = download.headers["content-type"] ?? "";
  const digest = bytes instanceof Uint8Array ? createHash("sha256").update(bytes).digest("hex") : "";
  const reportedLength = download.headers["content-length"];
  const parsedLength = reportedLength !== undefined ? Number(reportedLength) : undefined;
  const lengthMatches =
    bytes instanceof Uint8Array
    && typeof status?.bytes === "number"
    && bytes.byteLength === status.bytes
    && (parsedLength === undefined || !Number.isFinite(parsedLength) || parsedLength === bytes.byteLength);
  const digestMatches = typeof status?.sha256 === "string" && status.sha256 === digest;
  const typeMatches = contentType.toLowerCase().startsWith("image/webp");
  if (
    !(bytes instanceof Uint8Array)
    || !typeMatches
    || !lengthMatches
    || !digestMatches
    || typeof status?.width !== "number"
    || typeof status.height !== "number"
  ) {
    throw new CliError(
      makeProblem(
        "invalid_request",
        "Request is invalid",
        400,
        "Screenshot download did not match the ready status metadata.",
        { request_id: client.requestId },
      ),
    );
  }

  const tempPath = tempPathFor(outputPath);
  const release = removeOnSignal(tempPath);
  try {
    await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(tempPath, outputPath);
  } catch {
    await rm(tempPath, { force: true });
    throw usageError("Cannot write screenshot to the output path.");
  } finally {
    release();
  }

  return {
    screen_id: id,
    capture_id: captureId,
    path: outputPath,
    bytes: bytes.byteLength,
    sha256: digest,
    width: status.width,
    height: status.height,
    ...(status.frame && typeof status.frame.flat === "boolean" ? { frame: { flat: status.frame.flat, analyzed_at: status.frame.analyzed_at } } : {}),
  };
}

export const SCREENSHOT_FLEET_DEFAULT_CONCURRENCY = 4;
export const SCREENSHOT_FLEET_MAX_CONCURRENCY = 8;

export type ScreenshotFleetItem = FleetItem & Partial<Omit<ScreenshotSaved, "screen_id">>;

/**
 * Client-side screenshot fan-out: screenshots are unbilled per screen, so
 * there is no fleet screenshot action. --tag resolves through
 * GET /api/screens?tag=T and keeps active screens, matching the fleet
 * actions selector (one metered list request per page; captures are unbilled). Each
 * capture writes DIRECTORY/<screen_id>.webp; a failed capture is that
 * screen's result, never a transport error. An unexpected (non-CliError)
 * failure stops scheduling: the failing screen and every screen not yet
 * started are reported as failed, and the exit code is Unexpected.
 */
export async function screenScreenshotFleet(args: ParsedArgs, runtime: CliRuntime, client: ApiClient, selector: ScreenActionSelector): Promise<CommandResult> {
  if (flagString(args.flags, "idempotency-key")) {
    throw usageError("screen screenshot with several screens or --tag does not take --idempotency-key; each capture uses its own key.");
  }
  requireFlagValue(args, "concurrency", "4");
  const concurrency = flagNumber(args.flags, "concurrency") ?? SCREENSHOT_FLEET_DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > SCREENSHOT_FLEET_MAX_CONCURRENCY) {
    throw usageError(`--concurrency must be a whole number from 1 to ${SCREENSHOT_FLEET_MAX_CONCURRENCY}.`);
  }
  if (selector.by === "ids") {
    const invalid = selector.screen_ids.find((id) => !isScreenId(id));
    if (invalid !== undefined) throw usageError("screen screenshot takes screen ids (scr_...); nothing was captured.");
  }
  if (args.flags.output === true) throw usageError("--output requires a directory path.");
  const directory = path.resolve(runtime.cwd(), flagString(args.flags, "output") ?? ".");
  try {
    if (!(await stat(directory)).isDirectory()) throw usageError("--output must be a directory with several screens or --tag.");
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw usageError("--output must be a directory with several screens or --tag.");
  }
  // One pace for the whole fleet: a 429's Retry-After holds every worker.
  const options = screenshotOptions(args, runtime);

  let ids: string[];
  const offline = new Map<string, string | undefined>();
  if (selector.by === "tag") {
    const listed = await client.listAll("/api/screens", { tag: selector.tag }, { uncapped: true });
    const items = (listed.body as { items?: Screen[] } | undefined)?.items;
    if (!Array.isArray(items)) throw usageError("Screen list response does not match the generated ScreenList contract.");
    const active = items.filter((screen) => screen?.state === "active" && typeof screen.id === "string");
    ids = active.map((screen) => screen.id);
    // The list already says which screens are offline; do not wait out their captures.
    for (const screen of active) if (screen.online === false) offline.set(screen.id, screen.last_online_at);
    if (ids.some((id) => !isScreenId(id))) throw usageError("Screen list response does not match the generated ScreenList contract.");
  } else if (selector.by === "folder") {
    // The folder and every folder inside it; GET /api/screens?folder lists only the screens directly in one folder.
    await client.call({ method: "GET", path: `/api/screen-folders/${selector.folder_id}` });
    const folders = ((await client.call({ method: "GET", path: "/api/screen-folders" })).body as { items?: ScreenFolder[] } | undefined)?.items;
    if (!Array.isArray(folders)) throw usageError("Screen folder list response does not match the generated ScreenFolderList contract.");
    const active: Screen[] = [];
    for (const folderId of folderSubtree(folders, selector.folder_id)) {
      const listed = await client.listAll("/api/screens", { folder: folderId }, { uncapped: true });
      const items = (listed.body as { items?: Screen[] } | undefined)?.items;
      if (!Array.isArray(items)) throw usageError("Screen list response does not match the generated ScreenList contract.");
      active.push(...items.filter((screen) => screen?.state === "active" && typeof screen.id === "string"));
    }
    ids = active.map((screen) => screen.id);
    for (const screen of active) if (screen.online === false) offline.set(screen.id, screen.last_online_at);
    if (ids.some((id) => !isScreenId(id))) throw usageError("Screen list response does not match the generated ScreenList contract.");
  } else {
    ids = selector.screen_ids;
  }
  if (ids.length) {
    try {
      await mkdir(directory, { recursive: true });
    } catch {
      throw usageError("Cannot create the --output directory.");
    }
  }

  const results: ScreenshotFleetItem[] = new Array(ids.length);
  // The exit code each failed capture would have had on its own; never serialized.
  const exitCodes = new Map<number, ExitCode>();
  const failure = (id: string, problem: Record<string, unknown>): ScreenshotFleetItem => ({ screen_id: id, status: "failed", problem: problem as FleetItem["problem"] });
  let next = 0;
  let fatal = false;
  const worker = async () => {
    while (!fatal && next < ids.length) {
      const index = next++;
      const id = ids[index]!;
      try {
        if (offline.has(id)) throw screenshotUnavailable(client.requestId, "offline", offline.get(id));
        const saved = await captureScreenshot(runtime, client, id, path.join(directory, `${id}.webp`), options, newIdempotencyKey());
        results[index] = { ...saved, status: "ok" };
      } catch (error) {
        if (error instanceof CliError) {
          exitCodes.set(index, error.exitCode);
          // A dropped connection or timeout has no HTTP status; do not report one.
          const local = error.problem.code === "transport_error" || error.problem.code === "timeout";
          results[index] = failure(id, {
            code: error.problem.code,
            ...(local ? {} : { status: error.problem.status }),
            title: error.problem.title,
            detail: error.problem.detail,
            ...(error.problem.hint ? { hint: error.problem.hint } : {}),
            ...(typeof error.problem.retry_after_seconds === "number" ? { retry_after_seconds: error.problem.retry_after_seconds } : {}),
            ...(error.problem.request_id ? { request_id: error.problem.request_id } : {}),
          });
        } else {
          fatal = true;
          exitCodes.set(index, ExitCode.Unexpected);
          results[index] = failure(id, { code: "unexpected_error", title: "Unexpected error", detail: "The capture failed unexpectedly; remaining captures were not started." });
        }
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  for (let index = 0; index < ids.length; index += 1) {
    if (results[index] === undefined) {
      exitCodes.set(index, ExitCode.Unexpected);
      results[index] = failure(ids[index]!, { code: "not_attempted", title: "Not attempted", detail: "Not captured because an earlier capture failed unexpectedly." });
    }
  }

  const failed = results.filter((item) => item.status === "failed").length;
  const data = {
    action: "screenshot" as const,
    selector,
    output: directory,
    matched: results.length,
    succeeded: results.length - failed,
    failed,
    results,
  };
  const outcome = fleetOutcome(data, (item) => exitCodes.get(results.indexOf(item as ScreenshotFleetItem)));
  if (fatal) outcome.exitCode = ExitCode.Unexpected;
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: outcome.warnings }),
    exitCode: outcome.exitCode,
    human: [
      fleetHumanLines("Fleet screenshot", data, (item) => item.path),
      ...outcome.warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

export const handleScreenPublish = commandHandler(async (args, runtime, resolved) => {
  const parsed = await readAuthoringJson(args.positionals[3]!, runtime);
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.pages)) assertWirePages(parsed.pages);
  const document = parsed;
  assertPlaylistValid(document);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const json = !flagBool(args.flags, "human");
  const progress = flagBool(args.flags, "no-progress") ? undefined : (stage: string, state?: string) =>
    runtime.stderr.write(json ? `${JSON.stringify({ event: "publish_stage", stage, ...(state ? { state } : {}) })}\n` : `screenrig: ${stage}${state ? ` (${state})` : ""}\n`);
  const shortApplication = shortApplicationPageWarning(document);
  const result = await publishScreen({ client, runtime, configPath: resolved.configPath, apiUrl: resolved.apiUrl, screenId: args.positionals[2]!, revision: flagString(args.flags, "expect-rev")!, document, requestedKey: flagString(args.flags, "idempotency-key"),
    note: flagString(args.flags, "note"),
    wait: flagBool(args.flags, "no-wait") ? undefined : { timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000, pollMs: flagNumber(args.flags, "poll-ms") ?? 2000 },
    progress });
  if (result.stage === "pending_review") {
    // The playlist review decides the content (approving it can approve the
    // assignment too), so it is the one to check first.
    const first = result.reviews.find((review) => review.kind === "playlist_change") ?? result.reviews[0]!;
    const { warnings: raw, ...pendingData } = result;
    const framing = playlistWarnings(raw, result.playlist_id, true);
    return {
      envelope: successEnvelope({ ...pendingData, next: reviewNext(first.id) }, { request_id: client.requestId, warnings: [...(shortApplication ? [shortApplication] : []), ...result.reviews.map(pendingReviewWarning), ...framing] }),
      exitCode: ExitCode.Success,
      human: [
        "Publish waiting for review",
        `playlist_id: ${result.playlist_id}`,
        `screen_id: ${result.screen_id}`,
        ...result.reviews.map((review) => `review: ${review.id} ${review.kind} ${review.state} ${review.url}`),
        `next: screenrig reviews show ${first.id}`,
        PENDING_REVIEW_SENTENCE,
        ...framing.map((item) => `warning: ${item.message}`),
      ].join("\n"),
    };
  }
  const warning = publishPlaybackWarning(result);
  // playback_verified stays what the Player reported; a page the Player web app
  // cannot frame is reported beside it, in the same result.
  const { warnings: raw, ...data } = result;
  const framing = playlistWarnings(raw, result.playlist_id);
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: [...(shortApplication ? [shortApplication] : []), ...(warning ? [warning] : []), ...framing] }),
    exitCode: ExitCode.Success,
    human: humanLines(`${result.playback_verified ? "Published and playing" : "Published and assigned"}${hasFramingRefusal(framing) ? "; see the framing warning" : ""}`, [
      ["playlist_id", result.playlist_id],
      ["screen_id", result.screen_id],
      ["stage", result.stage],
      ["waited", `${result.playback.waited_ms} ms`],
      ...(warning ? [["warning", warning.message] as [string, string]] : []),
      ...(shortApplication ? [["warning", shortApplication.message] as [string, string]] : []),
      ...framing.map((item) => ["warning", item.message] as [string, string]),
    ]),
  };
});

/** Why a publish is not visibly playing yet, and what to do about it. */
export function publishPlaybackWarning(result: Extract<Awaited<ReturnType<typeof publishScreen>>, { playback: unknown }>): Warning | undefined {
  const { playback, screen_id: screen } = result;
  if ((playback.reason === "playback_failed" || playback.reason === "playback_pending" || playback.playing)
    && isStorageFailureCode(playback.code)) {
    return storageFullWarning(screen, playback.state === "partial" ? "partial"
      : playback.code === "transition_blocked" ? "transition_blocked" : "none_fit");
  }
  const rerun = "Rerun the identical publish command to wait again; it does not create another playlist.";
  switch (playback.reason) {
    case "screen_offline":
      return { code: "screen_offline", message: `The screen is offline, so its Player has not picked up the playlist. It plays when the Player reconnects. ${rerun}` };
    case "playlist_not_effective":
      return { code: "playlist_not_effective", message: `A takeover, campaign or playlist schedule shows ${playback.effective_playlist_id} on this screen. The published playlist is its default and plays when that ends; screen show ${screen} reports effective_playlist, and campaign explain ${screen} says which campaigns apply.` };
    case "playback_failed":
      return { code: "playback_failed", message: `The Player could not switch to the playlist${playback.code ? ` (${playback.code})` : ""}. screen show ${screen} reports the reason; fix it, then screen reload ${screen}.` };
    case "playback_pending":
      return { code: "playback_pending", message: `The Player had not shown the playlist after ${Math.round(playback.waited_ms / 1000)} s (state ${playback.state ?? "unknown"}). Large videos take longer to download. ${rerun}` };
  }
  if (playback.playing && playback.state === "partial") {
    return { code: "playback_partial", message: `The Player is showing only part of the playlist. screen show ${screen} reports progress and screen storage-forecast ${screen} --playlist-id ${result.playlist_id} checks available storage.` };
  }
  return undefined;
}

// Playlist schedules and takeover. One screen id uses the single-screen
// routes (revision guard allowed); several ids or --tag use the fleet actions
// route (set_playlist_schedule, takeover, takeover_clear).
export function nestedScreenTarget(args: ParsedArgs, command: string) {
  // positionals are [screen, schedule|takeover, action, ...ids].
  return screenTarget({ ...args, positionals: args.positionals.slice(1) }, command);
}

export async function screenControlCall(client: ApiClient, id: string, request: Parameters<ApiClient["call"]>[0]) {
  try {
    return await client.call(request);
  } catch (error) {
    throw screenControlProblem(error, id);
  }
}

/** The review note and revision guard of a single-screen control write. */
export function screenControlHeaders(args: ParsedArgs, revision: string | undefined): Record<string, string> {
  return { ...reviewNoteFrom(args), ...(revision ? { "if-match": quotedRevision(revision) } : {}) };
}

export function screenControlHuman(title: string, screen: Screen | undefined): string {
  return [
    title,
    ...assignmentLine(screen?.effective_playlist, screen?.takeover, screen?.timezone),
    ...takeoverLine(screen?.takeover, screen?.timezone),
    ...(screen?.playlist_schedule ? scheduleTableLines(screen.playlist_schedule.entries, screen.timezone ?? null) : []),
    ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : []),
  ].join("\n");
}

export const handleScreenScheduleShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen schedule show requires <id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "GET", path: `/api/screens/${encodeURIComponent(id)}/playlist-schedule` });
  const view = response.body as ScreenPlaylistScheduleView | undefined;
  // The view carries no zone; human output reads it from the screen so civil
  // windows and instants are labelled. JSON output makes no extra request.
  let timezone: string | null | undefined;
  if (flagBool(args.flags, "human")) {
    try {
      const screen = await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` });
      timezone = (screen.body as Screen | undefined)?.timezone ?? null;
    } catch {
      timezone = undefined;
    }
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Playlist schedule for ${id}`,
      ...assignmentLine(view?.effective_playlist, undefined, timezone ?? undefined),
      ...(view?.updated_at ? [`updated_at: ${view.updated_at}`] : []),
      ...scheduleTableLines(view?.entries, timezone === undefined ? "unknown" : timezone),
    ].join("\n"),
  };
});

export const handleScreenScheduleSet = commandHandler(async (args, runtime, resolved) => {
  const file = flagString(args.flags, "file");
  if (!file) throw usageError("screen schedule set requires --file FILE (or --file - for stdin).");
  const target = nestedScreenTarget(args, "screen schedule set");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen schedule set");
  const entries = scheduleEntries(await readAuthoringJson(file, runtime));
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    // Entries are normalized once on the server so every screen stores the
    // same ids; a screen without a timezone fails alone with invalid_request.
    return screenFleetAction(client, runtime, "Fleet schedule set", target.selector, { type: "set_playlist_schedule", entries }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const body: ScreenPlaylistScheduleWrite = { entries };
  const revision = flagString(args.flags, "expect-rev");
  const response = await screenControlCall(client, id, {
    method: "PUT", path: `/api/screens/${encodeURIComponent(id)}/playlist-schedule`, idempotent: true, body,
    headers: screenControlHeaders(args, revision),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Set a ${entries.length}-entry playlist schedule on ${id}`, response.body as Screen | undefined),
  };
});

export const handleScreenScheduleClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen schedule clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen schedule clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    return screenFleetAction(client, runtime, "Fleet schedule clear", target.selector, { type: "clear_playlist_schedule" }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/playlist-schedule`, idempotent: true,
    headers: screenControlHeaders(args, revision),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Cleared the playlist schedule on ${id}`, response.body as Screen | undefined),
  };
});

export const handleScreenTakeover = commandHandler(async (args, runtime, resolved) => {
  const playlistId = flagString(args.flags, "playlist-id");
  if (!playlistId) throw usageError("screen takeover requires <id>, --tag TAG or --folder ID, and --playlist-id.");
  const target = nestedScreenTarget(args, "screen takeover");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen takeover");
  const forValue = flagString(args.flags, "for");
  const until = takeoverUntil(flagString(args.flags, "until"), forValue, runtime.now());
  const reason = flagString(args.flags, "reason");
  const write: ScreenTakeoverWrite = {
    playlist_id: playlistId,
    ...(until !== undefined ? { until } : {}),
    ...(reason !== undefined ? { reason: takeoverReason(reason) } : {}),
  };
  // --for derives until from the clock, so a rerun fingerprints differently;
  // drop the obsolete saved key instead of leaving it behind.
  const supersede = forValue !== undefined
    ? JSON.stringify(["screen takeover --for", target.kind === "single" ? target.id : target.selector, playlistId]) : undefined;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    try {
      return await screenFleetAction(client, runtime, "Fleet takeover", target.selector, { type: "takeover", ...write }, supersede, reviewNoteFrom(args));
    } catch (error) {
      throw forValue !== undefined ? takeoverForProblem(error) : error;
    }
  }
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await screenControlCall(client, id, {
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/takeover`, idempotent: true, body: write,
      headers: screenControlHeaders(args, revision),
      ...(supersede ? { recoverySupersede: supersede } : {}),
    });
  } catch (error) {
    throw forValue !== undefined ? takeoverForProblem(error) : error;
  }
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Took over ${id} with ${playlistId} ${typeof until === "string" ? `until ${instantInZone(until, (response.body as Screen | undefined)?.timezone)}` : "until cleared"}`, response.body as Screen | undefined),
  };
});

export const handleScreenTakeoverClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen takeover clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen takeover clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    return screenFleetAction(client, runtime, "Fleet takeover clear", target.selector, { type: "takeover_clear" }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/takeover`, idempotent: true,
    headers: screenControlHeaders(args, revision),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Cleared the takeover on ${id}`, response.body as Screen | undefined),
  };
});

// Reboot and display power. One screen id uses the single-screen routes
// (revision guard allowed); several ids or --tag use the fleet actions route
// (reboot, display, set_display_schedule, clear_display_schedule).
export const handleScreenReboot = commandHandler(async (args, runtime, resolved) => {
  const target = screenTarget(args, "screen reboot");
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen reboot");
    // Noninteractive: a fleet reboot is never a side effect of a typo.
    if (!flagBool(args.flags, "yes")) {
      throw usageError("screen reboot with several screens or --tag reboots every matching device; add --yes to confirm.", {
        command: `screenrig screen reboot ${selectorFlags(target.selector)} --yes`,
        reason: "Check the matching screens with screen list first; each rebooted device is dark until it restarts.",
      });
    }
  }
  const lifetime = commandLifetime(args);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet reboot", target.selector, { type: "reboot", ...lifetime });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/reboot`, idempotent: true,
      ...(lifetime.expires_in_s === undefined ? {} : { body: lifetime }),
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw rebootProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenRebootAccepted>;
  if (typeof accepted.reboot_id !== "string" || !/^rbt_[A-Za-z0-9_-]{8,64}$/.test(accepted.reboot_id) || serverInstant(accepted.expires_at) === undefined || !validDelivery(accepted.state)) {
    throw usageError("Screen reboot response does not match the generated ScreenRebootAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Reboot accepted", [["screen_id", id], ["reboot_id", accepted.reboot_id], ["state", accepted.state], ["expires_at", accepted.expires_at]]),
      accepted.state === "queued"
        ? `The screen is offline, so the reboot waits: it is sent when the screen comes online before expires_at, and screen show lists it under commands (done once the device reports it booted). Cancel it with screen command cancel ${id} ${accepted.reboot_id}.`
        : "The Player reboots the device when it receives this before expires_at. Confirm it came back with screen show (online, health uptime).",
    ].join("\n"),
  };
}, true);

// clear-cache, restart-app and update-software: the reboot shape for the three
// maintenance commands (docs/player-compatibility.md §6.5.1). One screen id uses
// its single-screen route (revision guard allowed); several ids, --tag or
// --folder use the fleet action of the same type behind --yes.
export function maintenanceHandler(spec: MaintenanceSpec) {
  const command = `screen ${spec.name}`;
  return commandHandler(async (args, runtime, resolved) => {
    const target = screenTarget(args, command);
    if (target.kind === "fleet") {
      rejectFleetRevision(args, command);
      // Noninteractive: a fleet action is never a side effect of a typo.
      if (!flagBool(args.flags, "yes")) {
        throw usageError(`${command} with several screens, --tag or --folder acts on every matching Player; add --yes to confirm.`, {
          command: `screenrig ${command} ${selectorFlags(target.selector)} --yes`,
          reason: `Check the matching screens with screen list first; ${spec.fleetWarning}`,
        });
      }
    }
    const lifetime = commandLifetime(args);
    const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
    if (target.kind === "fleet") return screenFleetAction(client, runtime, `Fleet ${spec.name}`, target.selector, { type: spec.type, ...lifetime });
    const id = target.id;
    const revision = flagString(args.flags, "expect-rev");
    let response;
    try {
      response = await client.call({
        method: "POST", path: `/api/screens/${encodeURIComponent(id)}/${spec.route}`, idempotent: true,
        ...(lifetime.expires_in_s === undefined ? {} : { body: lifetime }),
        ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
      });
    } catch (error) {
      throw maintenanceProblem(error, id, spec);
    }
    const accepted = (response.body ?? {}) as Partial<ScreenMaintenanceAccepted>;
    if (typeof accepted.command_id !== "string" || !/^cmd_[A-Za-z0-9_-]{8,64}$/.test(accepted.command_id) || accepted.command !== spec.type
      || serverInstant(accepted.expires_at) === undefined || (accepted.state !== "queued" && accepted.state !== "sent")) {
      throw usageError(`Screen ${spec.name} response does not match the generated ScreenMaintenanceAccepted contract.`);
    }
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: [
        humanLines(`${spec.title} accepted`, [["screen_id", id], ["command_id", accepted.command_id], ["command", accepted.command], ["state", accepted.state], ["expires_at", accepted.expires_at]]),
        accepted.state === "queued"
          ? `The screen is offline, so ${spec.name} waits: it is sent when the screen comes online before expires_at, and screen show lists it under commands (done or failed, with the cause the Player reports). Cancel it with screen command cancel ${id} ${accepted.command_id}.`
          : `${spec.effect} screen show lists the result under commands (done or failed, with the cause the Player reports).`,
      ].join("\n"),
    };
  }, true);
}

export const handleScreenClearCache = maintenanceHandler(MAINTENANCE["clear-cache"]);
export const handleScreenRestartApp = maintenanceHandler(MAINTENANCE["restart-app"]);
export const handleScreenUpdateSoftware = maintenanceHandler(MAINTENANCE["update-software"]);

// Start one page of the playlist a screen is playing now. Single screen only.
export const handleScreenPlayPage = commandHandler(async (args, runtime, resolved) => {
  if (args.flags["page-id"] === true) throw usageError("--page-id requires a value, such as --page-id pg_WELCOME.");
  const pageId = flagString(args.flags, "page-id");
  const ids = args.positionals.slice(2);
  if (!ids.length || pageId === undefined) throw usageError("screen play-page requires <id> and --page-id PAGE_ID.");
  const id = ids[0]!;
  if (id.length < 1 || id.length > 200) throw usageError("screen play-page screen ids must be 1 to 200 characters.");
  if (pageId.length < 1 || pageId.length > 128) throw usageError("--page-id must be 1 to 128 characters.");
  const body: ScreenPlayPageWrite = { page_id: pageId };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "POST", path: `/api/screens/${encodeURIComponent(id)}/play-page`, idempotent: true, body });
  } catch (error) {
    throw playPageProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenPlayPageAccepted>;
  if (typeof accepted.playlist_id !== "string" || typeof accepted.page_id !== "string" || serverInstant(accepted.expires_at) === undefined) {
    throw usageError("Screen play-page response does not match the generated ScreenPlayPageAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Play-page accepted", [["screen_id", id], ["playlist_id", accepted.playlist_id], ["page_id", accepted.page_id], ["expires_at", accepted.expires_at]]),
  };
}, true);

// Show the screen's name over its content. Single screen only.
export const handleScreenIdentify = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("screen identify requires <id>.");
  const duration = flagString(args.flags, "duration");
  // The server's 60 seconds applies unless --duration is given.
  const body: ScreenIdentifyWrite | undefined = duration === undefined ? undefined : { duration_ms: identifyDurationMs(duration) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "POST", path: `/api/screens/${encodeURIComponent(id)}/identify`, idempotent: true, ...(body ? { body } : {}) });
  } catch (error) {
    throw identifyProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenIdentifyAccepted>;
  if (typeof accepted.identify_id !== "string" || !/^idf_[A-Za-z0-9_-]{8,64}$/.test(accepted.identify_id) || serverInstant(accepted.expires_at) === undefined) {
    throw unexpectedResponseError("Screen identify response does not match the generated ScreenIdentifyAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Identify accepted", [
        ["screen_id", id],
        ["identify_id", accepted.identify_id],
        ["duration_ms", Number.isSafeInteger(accepted.duration_ms) ? String(accepted.duration_ms) : undefined],
        ["expires_at", accepted.expires_at],
      ]),
      "The Player shows the screen's name over its content for the duration, counted from when it receives this; playback continues underneath. Run it again to replace the overlay.",
    ].join("\n"),
  };
}, true);

// Start live view of a screen, or renew it, and wait for the Player to publish.
// The video is watched on data.viewer_url; the CLI never carries it.
export const handleScreenLiveStart = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "start");
  const duration = flagString(args.flags, "duration");
  const wait = flagString(args.flags, "wait");
  const waitMs = wait === undefined ? LIVE_WAIT_DEFAULT_MS : liveWaitMs(wait);
  // The server's 5 minutes applies unless --duration is given.
  const body: LiveStartRequest | undefined = duration === undefined ? undefined : { duration_s: liveDurationSeconds(duration) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const path = `/api/screens/${encodeURIComponent(id)}/live`;
  let response;
  try {
    response = await client.call({ method: "POST", path, ...(body ? { body } : {}) });
  } catch (error) {
    throw liveProblem(error, id);
  }
  let session = liveSessionBody(response.body);
  if (!session) throw unexpectedResponseError("Screen live start response does not match the generated LiveSession contract.");
  session = await settleLive(session, async () => {
    response = await client.call({ method: "GET", path });
    const read = liveSessionBody(response.body);
    if (!read) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
    return read;
  }, { waitMs, now: () => runtime.now().getTime(), sleep: runtime.sleep });
  if (session.state === "ended" || session.state === "idle") throw liveEndedError(session);
  const warnings = session.publisher?.connected ? [] : [liveNotReadyWarning(session)];
  return {
    envelope: jsonBody({ body: session, headers: response.headers }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [liveHumanLines(session), ...warnings.map((warning) => warning.message)].join("\n"),
  };
}, true);

// Read a screen's live session.
export const handleScreenLiveStatus = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "status");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}/live` });
  } catch (error) {
    throw liveProblem(error, id);
  }
  const session = liveSessionBody(response.body);
  if (!session) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: liveHumanLines(session) };
}, true);

// End a screen's live session. Also succeeds when there is none.
export const handleScreenLiveStop = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "stop");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const path = `/api/screens/${encodeURIComponent(id)}/live`;
  let response;
  try {
    await client.call({ method: "DELETE", path });
    response = await client.call({ method: "GET", path });
  } catch (error) {
    throw liveProblem(error, id);
  }
  const session = liveSessionBody(response.body);
  if (!session) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: liveHumanLines(session) };
}, true);

// Save JPEG frames of a screen's live stream: start the session, wait for the
// Player to publish, start frames, then read each new frame once.
export const handleScreenLiveFrame = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "frame");
  const count = flagNumber(args.flags, "count") ?? 1;
  if (!Number.isInteger(count) || count < 1) throw usageError("--count must be a whole number of at least 1.");
  const interval = flagString(args.flags, "interval");
  const intervalMs = interval === undefined ? LIVE_FRAME_INTERVAL_DEFAULT_MS : liveFrameIntervalMs(interval);
  const duration = flagString(args.flags, "duration");
  const wait = flagString(args.flags, "wait");
  const plan = {
    screenId: id,
    count,
    intervalMs,
    leaseSeconds: liveFrameLeaseSeconds(duration === undefined ? undefined : liveDurationSeconds(duration), count, intervalMs),
    waitMs: wait === undefined ? LIVE_WAIT_DEFAULT_MS : liveWaitMs(wait),
    stop: flagBool(args.flags, "stop"),
    output: await resolveFrameOutput(runtime.cwd(), flagString(args.flags, "output"), count),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const result = await captureLiveFrames(plan, client, { now: () => runtime.now().getTime(), sleep: runtime.sleep });
  return { envelope: successEnvelope(result, { request_id: client.requestId }), exitCode: ExitCode.Success, human: liveFramesHumanLines(result) };
}, true);

// Put a notice on a screen instead of its content. Single screen only.
export const handleScreenSuspend = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const message = flagString(args.flags, "message");
  if (!id || message === undefined) throw usageError("screen suspend requires <id> and --message TEXT.");
  const body: ScreenSuspendWrite = { message: suspendMessage(message) };
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/suspend`, idempotent: true, body,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw suspendProblem(error, id);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Suspended screen ${id}`, [
        ["since", serverInstant(screen?.suspension?.since)],
        ["revision", screen?.revision === undefined ? undefined : String(screen.revision)],
      ]),
      `The screen shows your notice instead of its content until screen resume ${id}; its playlist, schedule and settings are unchanged.`,
    ].join("\n"),
  };
}, true);

// End a suspension. Single screen only.
export const handleScreenResume = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("screen resume requires <id>.");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/resume`, idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw suspendProblem(error, id);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Resumed screen ${id}`, [["revision", screen?.revision === undefined ? undefined : String(screen.revision)]]),
      "The screen shows its own content again.",
    ].join("\n"),
  };
}, true);

// Move the device paired as another screen onto this one. Always carries an
// idempotency key, like recovery confirm: it retires a key and archives a screen.
export const handleScreenReplace = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const withId = flagString(args.flags, "with");
  if (!id || !withId) throw usageError("screen replace requires <id> and --with ID.");
  if (withId === id) throw usageError("--with must name another screen than <id>: the screen whose paired device takes over.");
  const body: ScreenReplaceWrite = { with: withId };
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/replace`, idempotent: true, body,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw replaceProblem(error, id, withId);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Replaced the device of screen ${id} with the one paired as ${withId}`, [
        ["revision", screen?.revision === undefined ? undefined : String(screen.revision)],
      ]),
      `${id} keeps its name, tags, playlist, schedules and history on the new device. ${withId} is archived as replaced, and any key ${id} held retires after a fifteen-minute grace window.`,
    ].join("\n"),
  };
}, true);

// Cancel a queued command (reboot, reload, clear_cache, restart_app or update) that is still waiting for an offline screen.
export const handleScreenCommandCancel = commandHandler(async (args, runtime, resolved) => {
  // positionals are [screen, command, cancel, ID, COMMAND_ID].
  const id = args.positionals[3];
  const commandId = args.positionals[4];
  if (!id || !commandId) throw usageError("screen command cancel requires <id> and <command_id>.");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/cancel`, idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw commandCancelProblem(error, id);
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `Cancelled command ${commandId} on ${id}: it is never sent.`,
  };
}, true);

export function displayHuman(title: string, screen: Screen | undefined): string {
  return [title, ...displayLines(screen?.display, screen?.timezone), ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : [])].join("\n");
}

export const handleScreenDisplay = commandHandler(async (args, runtime, resolved) => {
  // A trailing on|off positional is shorthand for --power.
  // positionals are [screen, display, set, ...ids].
  const last = args.positionals.at(-1);
  const trailing = args.positionals.length > 3 && (last === "on" || last === "off") ? last : undefined;
  const positionals = (trailing ? args.positionals.slice(0, -1) : args.positionals).slice(1);
  const flagPower = flagString(args.flags, "power");
  if (trailing && flagPower && trailing !== flagPower) throw usageError("screen display got two different powers; use --power on|off once.");
  const power = displayPower(flagPower ?? trailing);
  const target = screenTarget({ ...args, positionals }, "screen display");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display");
  const until = displayUntil(flagString(args.flags, "until"), flagString(args.flags, "for"), runtime.now());
  const write = { power, ...(until !== undefined ? { until } : {}) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, `Fleet display ${power}`, target.selector, { type: "display", ...write });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/display`, idempotent: true, body: write,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw displayProblem(screenControlProblem(error, id), id);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Display ${power} on ${id} ${until ? `until ${instantInZone(until, screen?.timezone)}` : "until the display schedule's next boundary, or until replaced"}`, screen),
  };
}, true);

export const handleScreenDisplayScheduleShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen display-schedule show requires <id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "GET", path: `/api/screens/${encodeURIComponent(id)}/display-schedule` });
  const view = response.body as ScreenDisplayScheduleView | undefined;
  let timezone: string | undefined;
  if (flagBool(args.flags, "human")) {
    try {
      timezone = ((await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` })).body as Screen | undefined)?.timezone;
    } catch {
      timezone = undefined;
    }
  }
  const display = view?.display ?? (view?.display_schedule ? { requested: "on" as const, source: "default" as const, schedule: view.display_schedule } : undefined);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Display schedule for ${id}`, ...(view?.display_schedule ? [] : ["No display schedule: the display stays on unless turned off."]), ...displayLines(display, timezone)].join("\n"),
  };
}, true);

export const handleScreenDisplayScheduleSet = commandHandler(async (args, runtime, resolved) => {
  const file = flagString(args.flags, "file");
  if (!file) throw usageError("screen display-schedule set requires --file FILE (or --file - for stdin).");
  const target = nestedScreenTarget(args, "screen display-schedule set");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display-schedule set");
  const write = displayScheduleWrite(await readAuthoringJson(file, runtime));
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet display schedule set", target.selector, { type: "set_display_schedule", ...write });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  const response = await screenControlCall(client, id, {
    method: "PUT", path: `/api/screens/${encodeURIComponent(id)}/display-schedule`, idempotent: true, body: write,
    ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Set a ${write.windows.length}-window display schedule on ${id}${write.enabled ? "" : " (disabled: the display stays on)"}`, response.body as Screen | undefined),
  };
}, true);

export const handleScreenDisplayScheduleClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen display-schedule clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display-schedule clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet display schedule clear", target.selector, { type: "clear_display_schedule" });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/display-schedule`, idempotent: true,
    ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Cleared the display schedule on ${id}`, response.body as Screen | undefined),
  };
}, true);

function rebootScheduleHuman(title: string, screen: Screen | undefined): string {
  return [title, ...rebootScheduleLines(screen?.reboot_schedule, screen?.next_reboot_at, screen?.timezone), ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : [])].join("\n");
}

export const handleScreenRebootScheduleShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen reboot-schedule show requires <id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "GET", path: `/api/screens/${encodeURIComponent(id)}/reboot-schedule` });
  const view = response.body as ScreenRebootScheduleView | undefined;
  let timezone: string | undefined;
  if (flagBool(args.flags, "human")) {
    try {
      timezone = ((await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` })).body as Screen | undefined)?.timezone;
    } catch {
      timezone = undefined;
    }
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Reboot schedule for ${id}`, ...(view?.reboot_schedule ? [] : ["No reboot schedule: the screen reboots only when asked (screen reboot)."]), ...rebootScheduleLines(view?.reboot_schedule, view?.next_reboot_at, timezone)].join("\n"),
  };
}, true);

export const handleScreenRebootScheduleSet = commandHandler(async (args, runtime, resolved) => {
  const file = flagString(args.flags, "file");
  const windows = flagString(args.flags, "window");
  if ((file === undefined) === (windows === undefined)) throw usageError("screen reboot-schedule set requires --window SPEC (repeatable) or --file FILE (or --file - for stdin).");
  const target = nestedScreenTarget(args, "screen reboot-schedule set");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen reboot-schedule set");
  const write = file !== undefined
    ? rebootScheduleWrite(await readAuthoringJson(file, runtime))
    : { enabled: !flagBool(args.flags, "disabled"), windows: rebootWindowList(windows!) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet reboot schedule set", target.selector, { type: "set_reboot_schedule", ...write });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await client.call({
      method: "PUT", path: `/api/screens/${encodeURIComponent(id)}/reboot-schedule`, idempotent: true, body: write,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw rebootScheduleProblem(screenControlProblem(error, id), id);
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: rebootScheduleHuman(`Set a ${write.windows.length}-window reboot schedule on ${id}${write.enabled ? "" : " (disabled: no reboots)"}`, response.body as Screen | undefined),
  };
}, true);

export const handleScreenRebootScheduleClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen reboot-schedule clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen reboot-schedule clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet reboot schedule clear", target.selector, { type: "clear_reboot_schedule" });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/reboot-schedule`, idempotent: true,
    ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: rebootScheduleHuman(`Cleared the reboot schedule on ${id}`, response.body as Screen | undefined),
  };
}, true);

export const handleScreenDisplayClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen display clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet display clear", target.selector, { type: "display_clear" });
  const id = target.id;
  const revision = flagString(args.flags, "expect-rev");
  let response;
  try {
    response = await client.call({
      method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/display`, idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw displayProblem(screenControlProblem(error, id), id);
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Cleared the display override on ${id}`, response.body as Screen | undefined),
  };
}, true);
