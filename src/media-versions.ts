import path from "node:path";
import { requireToken, type ApiClient } from "./client.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./command-input.js";
import {
  clientFor, commandHandler, jsonBody, progressReporterFor, requireInputFile, transcodeOptionsFromArgs, type CommandResult,
} from "./commands.js";
import { successEnvelope, type ProblemNext, type Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { isResourceID } from "./generated/resource-ids.js";
import { quotedRevision } from "./if-match.js";
import { loggerOf } from "./log/logger.js";
import { uploadMediaFile, type MediaFileUploadResult } from "./media-upload.js";
import { CliError, usageError } from "./problems.js";
import { pendingReviewOf, pendingReviewWarning, plainText, reviewNext } from "./reviews.js";
import type { CliRuntime } from "./runtime.js";
import { table } from "./webhooks.js";

/** MediaVersionActor (vendor/openapi.yaml): who put a version in service. */
export interface MediaVersionActor { kind: "person" | "agent" | "client" | "sync"; id?: string; name?: string }
/** MediaVersion: one file a media item had. */
export interface MediaVersion {
  number: number;
  current: boolean;
  filename: string;
  source_filename?: string;
  content_type: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  duration_ms?: number;
  codecs?: string;
  source: "upload" | "replace" | "sync" | "restore";
  note?: string;
  by?: MediaVersionActor;
  restored_from?: number;
  created_at: string;
}
export interface MediaVersionPage { items: MediaVersion[]; next_cursor?: string | null }
/** MediaWarning: a file change that deserves a look, with the playlists it touches. */
export interface MediaWarning { code: string; detail: string; playlists: Array<{ id: string; name: string }> }

const versionsPath = (id: string): string => `/api/media/${encodeURIComponent(id)}/versions`;

/** The media ID a media version command takes; the ID is placed in a path, so it is checked first. */
function mediaIdArg(value: string | undefined, usage: string): string {
  if (!value) throw usageError(`${usage} requires a media ID (med_...); media list shows them.`);
  if (!isResourceID(value, "media")) throw usageError(`${usage} takes a media ID (med_...), not ${JSON.stringify(value)}; media list shows them.`);
  return value;
}

/** `--number` as media versions lists it (the root `--version` flag is the CLI's own, so a subcommand cannot use it). Commander validated the text; the path takes the number. */
function versionNumber(args: ParsedArgs, command: string): number {
  const value = flagString(args.flags, "number");
  const number = Number(value);
  if (value === undefined || !Number.isSafeInteger(number) || number < 1) {
    throw usageError(`${command} requires --number N, a whole number from 1 as media versions lists it.`);
  }
  return number;
}

/** Where to go next after a refusal on the version routes; a problem that already says what to do passes through. */
export function mediaVersionProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  const problem = error.problem;
  const next: ProblemNext | undefined = problem.code === "revision_conflict"
    ? { command: `screenrig media show ${id}`, argv: ["media", "show", id], reason: "Read the media's current revision, then run the command again with --expect-rev REVISION if the change still applies." }
    : problem.code === "not_found"
      ? { command: `screenrig media versions ${id}`, argv: ["media", "versions", id], reason: "List the version numbers this media has; a deleted version does not come back." }
      : problem.code === "resource_conflict"
        ? { command: `screenrig media versions ${id}`, argv: ["media", "versions", id], reason: "Read which version is current and whether a replacement waits for review (reviews list)." }
        : undefined;
  return next ? new CliError({ ...problem, next }, error.exitCode, error.warnings) : error;
}

async function versionCall(client: ApiClient, request: Parameters<ApiClient["call"]>[0], id: string): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw mediaVersionProblem(error, id);
  }
}

// ---------------------------------------------------------------- warnings

function isMediaWarning(value: unknown): value is MediaWarning {
  const warning = value as Partial<MediaWarning> | null;
  return !!warning && typeof warning === "object" && typeof warning.code === "string" && typeof warning.detail === "string";
}

/** The MediaWarning list of an answer or an operation result; anything else is ignored. */
function mediaWarningsOf(value: unknown): MediaWarning[] {
  return Array.isArray(value) ? value.filter(isMediaWarning).map((warning) => ({ ...warning, playlists: Array.isArray(warning.playlists) ? warning.playlists : [] })) : [];
}

function playlistsText(warning: MediaWarning): string {
  return warning.playlists.map((playlist) => `${plainText(playlist.name)} (${playlist.id})`).join(", ");
}

/** An envelope warning for a media warning: its detail, then the playlists it touches by name. */
function envelopeWarning(warning: MediaWarning): Warning {
  const playlists = playlistsText(warning);
  return { code: warning.code, message: `${plainText(warning.detail)}${playlists ? ` Playlists: ${playlists}.` : ""}` };
}

// ---------------------------------------------------------------- media replace

const REPLACE_PENDING_SENTENCE = "Screens keep playing the current file until a person approves the replacement; they can also reject it or ask for changes. Do not repeat the write: check the decision later.";

function replaceNext(id: string): ProblemNext {
  return { command: `screenrig media versions ${id}`, argv: ["media", "versions", id], reason: "Lists the media's versions; the new file is the current one." };
}

/** A reviewer's page for a pending replacement; best effort, because the replacement is already recorded. */
async function reviewUrl(client: ApiClient, reviewId: string): Promise<string | undefined> {
  try {
    const url = ((await client.call({ method: "GET", path: `/api/reviews/${encodeURIComponent(reviewId)}` })).body as { url?: unknown } | undefined)?.url;
    return typeof url === "string" && url ? url : undefined;
  } catch {
    return undefined;
  }
}

async function mediaRevision(client: ApiClient, id: string): Promise<number | undefined> {
  try {
    const revision = ((await client.call({ method: "GET", path: `/api/media/${encodeURIComponent(id)}` })).body as { revision?: unknown } | undefined)?.revision;
    return typeof revision === "number" ? revision : undefined;
  } catch {
    return undefined;
  }
}

function sizeText(version: Pick<MediaVersion, "width" | "height" | "duration_ms">): string {
  const parts = [
    typeof version.width === "number" && typeof version.height === "number" ? `${version.width}x${version.height}` : "",
    typeof version.duration_ms === "number" ? `${(version.duration_ms / 1000).toFixed(1)} s` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : "-";
}

function mediaReplaceResult(
  args: ParsedArgs,
  runtime: CliRuntime,
  client: ApiClient,
  mediaId: string,
  uploaded: MediaFileUploadResult,
  revision: number | undefined,
  reviewLink: string | undefined,
): CommandResult {
  const result = (uploaded.operation.result ?? {}) as Record<string, unknown>;
  const waited = uploaded.operation.state === "succeeded";
  const warnings = mediaWarningsOf(result.warnings);
  const pendingId = waited && result.status === "pending_review" && typeof result.review_id === "string" ? result.review_id : undefined;
  const version = typeof result.version === "number" ? result.version : undefined;
  const data = {
    media_id: mediaId,
    id: mediaId,
    ...(pendingId ? { status: "pending_review" as const, review_id: pendingId } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(waited ? { warnings } : {}),
    operation: uploaded.operation,
    upload: uploaded.upload,
    transcode: uploaded.transcode,
    timing: uploaded.timing,
    ...(pendingId ? { next: reviewNext(pendingId) } : waited ? { next: replaceNext(mediaId) } : {}),
  };
  const envelopeWarnings: Warning[] = [
    ...(pendingId ? [reviewLink
      ? pendingReviewWarning({ url: reviewLink })
      : { code: "pending_review", message: `The replacement waits for a person to approve it: screenrig reviews show ${pendingId}` }] : []),
    ...warnings.map(envelopeWarning),
    ...uploaded.warnings,
  ];
  const human = flagBool(args.flags, "human");
  // An agent reading JSON gets the warning in the envelope; a plain line on stderr says it as well.
  if (!human) for (const warning of warnings) runtime.stderr.write(`screenrig: warning: ${envelopeWarning(warning).message}\n`);
  const title = pendingId ? "Replacement waiting for review" : waited ? "Media replaced" : "Media replacement accepted";
  const lines = [
    title,
    `media_id: ${mediaId}`,
    ...(version !== undefined ? [`version: ${version}`] : []),
    ...(revision !== undefined ? [`revision: ${revision}`] : []),
    `operation_id: ${uploaded.operation.id}`,
    `state: ${uploaded.operation.state}`,
    ...(pendingId ? [`review_id: ${pendingId}`, ...(reviewLink ? [`url: ${reviewLink}`] : []), `next: screenrig reviews show ${pendingId}`, REPLACE_PENDING_SENTENCE]
      : waited ? [`next: screenrig media versions ${mediaId}`] : [`next: screenrig operations wait ${uploaded.operation.id}`]),
    `content_type: ${uploaded.upload.content_type}`,
    `sha256: ${uploaded.upload.sha256}`,
    `transcode: ${typeof uploaded.transcode.duration_ms === "number" ? `${uploaded.transcode.reason} in ${uploaded.transcode.duration_ms} ms` : "skipped"}`,
    `timing: ${Object.entries(uploaded.timing).map(([stage, ms]) => `${stage.replace(/_ms$/, "")} ${ms} ms`).join(", ")}`,
    ...warnings.map((warning) => `warning: ${envelopeWarning(warning).message}`),
    ...uploaded.warnings.map((warning) => `warning: ${warning.message}`),
  ];
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, operation_id: uploaded.operation.id, warnings: envelopeWarnings }),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
  };
}

export const handleMediaReplace = commandHandler(async (args, runtime, resolved) => {
  const mediaId = mediaIdArg(args.positionals[2], "media replace");
  const file = args.positionals[3];
  if (!file) throw usageError("media replace requires <id> and <file>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  return loggerOf(runtime).withLocal({ op: "media.replace", message: "media replace" }, async () => {
    const sourcePath = path.resolve(runtime.cwd(), file);
    await requireInputFile(sourcePath, file);
    // Validate unconditionally so a typo such as --webp-quality 500 is rejected whether or not transcoding runs.
    const transcodeOptions = transcodeOptionsFromArgs(args);
    // The media's kind comes first: a file of another kind is refused before any transcode or transfer.
    let media: { primitive?: unknown };
    try {
      media = (await client.call({ method: "GET", path: `/api/media/${encodeURIComponent(mediaId)}` })).body as { primitive?: unknown };
    } catch (error) {
      throw mediaVersionProblem(error, mediaId);
    }
    const primitive = media.primitive === "image" || media.primitive === "video" || media.primitive === "audio" ? media.primitive : undefined;
    const note = flagString(args.flags, "note");
    const ifMatch = flagString(args.flags, "expect-rev");
    const noWait = flagBool(args.flags, "no-wait");
    let uploaded: MediaFileUploadResult;
    try {
      uploaded = await uploadMediaFile({
        runtime,
        client,
        sourcePath,
        explicitContentType: flagString(args.flags, "content-type"),
        transcodeOptions,
        noTranscode: flagBool(args.flags, "no-transcode"),
        reporter: progressReporterFor(args, runtime),
        noWait,
        timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
        pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
        resumable: flagString(args.flags, "idempotency-key") !== undefined,
        replace: { mediaId, ...(primitive ? { primitive } : {}), ...(ifMatch !== undefined ? { ifMatch } : {}), ...(note !== undefined ? { note } : {}) },
      });
    } catch (error) {
      throw mediaVersionProblem(error, mediaId);
    }
    const result = (uploaded.operation.result ?? {}) as Record<string, unknown>;
    const pendingId = uploaded.operation.state === "succeeded" && result.status === "pending_review" && typeof result.review_id === "string" ? result.review_id : undefined;
    const reviewLink = pendingId ? await reviewUrl(client, pendingId) : undefined;
    const revision = uploaded.operation.state === "succeeded" && !pendingId ? await mediaRevision(client, mediaId) : undefined;
    return mediaReplaceResult(args, runtime, client, mediaId, uploaded, revision, reviewLink);
  });
}, true);

// ---------------------------------------------------------------- media versions

function actorText(by: MediaVersionActor | undefined): string {
  if (!by) return "-";
  const name = plainText(by.name ?? by.id ?? "");
  return name ? `${name} (${by.kind})` : by.kind;
}

function sourceText(version: MediaVersion): string {
  return version.source === "restore" && version.restored_from !== undefined ? `restore of ${version.restored_from}` : version.source;
}

/** The human page of `media versions`: one row per version, the current one first, and the command that reads the next page. */
export function mediaVersionLines(mediaId: string, page: MediaVersionPage | undefined): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return [
    `Media ${mediaId} versions (${items.length})`,
    ...(items.length
      ? table(["NUMBER", "SOURCE", "FILENAME", "BYTES", "SIZE", "BY", "CREATED", "NOTE"], items.map((item) => [
        `${item.number}${item.current ? " (current)" : ""}`, sourceText(item), plainText(item.filename), String(item.bytes), sizeText(item),
        actorText(item.by), item.created_at, item.note === undefined ? "" : plainText(item.note),
      ]))
      : ["No versions"]),
    ...(next ? [`next: screenrig media versions ${mediaId} --cursor ${next}`] : []),
  ];
}

export const handleMediaVersions = commandHandler(async (args, runtime, resolved) => {
  const id = mediaIdArg(args.positionals[2], "media versions");
  const limit = flagString(args.flags, "limit");
  const cursor = flagString(args.flags, "cursor");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // --limit or --cursor asks for one page; otherwise every page is read, so the list is never silently cut.
  const request = async () => limit !== undefined || cursor !== undefined
    ? client.call({ method: "GET", path: versionsPath(id), query: { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) } })
    : client.listAll(versionsPath(id), undefined, { cursorParam: "cursor" });
  let response;
  try {
    response = await request();
  } catch (error) {
    throw mediaVersionProblem(error, id);
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: mediaVersionLines(id, response.body as MediaVersionPage | undefined).join("\n"),
  };
}, true);

// ---------------------------------------------------------------- media restore

const RESTORE_PENDING_SENTENCE = "Screens keep playing the current file until a person approves the restore; they can also reject it or ask for changes. Do not repeat the write: check the decision later.";

export const handleMediaRestore = commandHandler(async (args, runtime, resolved) => {
  const id = mediaIdArg(args.positionals[2], "media restore");
  const number = versionNumber(args, "media restore");
  const note = flagString(args.flags, "note");
  const ifMatch = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await versionCall(client, {
    method: "POST",
    path: `${versionsPath(id)}/${number}/restore`,
    idempotent: true,
    ...(ifMatch !== undefined ? { headers: { "if-match": quotedRevision(ifMatch) } } : {}),
    ...(note !== undefined ? { body: { note } } : {}),
  }, id);
  const warnings = mediaWarningsOf((response.body as { warnings?: unknown } | undefined)?.warnings);
  const pending = pendingReviewOf(response);
  if (pending) {
    return {
      envelope: jsonBody(response, client.requestId, { next: reviewNext(pending.review.id) }, [pendingReviewWarning(pending.review), ...warnings.map(envelopeWarning)]),
      exitCode: ExitCode.Success,
      human: [
        `Restore of version ${number} waiting for review`,
        `review_id: ${pending.review.id}`,
        ...(pending.review.subject ? [`subject: media ${plainText(pending.review.subject.name)} (${pending.review.subject.id})`] : []),
        ...(typeof pending.review.impact?.screens === "number" ? [`impact: approving changes ${pending.review.impact.screens} screen${pending.review.impact.screens === 1 ? "" : "s"}`] : []),
        `url: ${pending.review.url}`,
        `next: screenrig reviews show ${pending.review.id}`,
        RESTORE_PENDING_SENTENCE,
        ...warnings.map((warning) => `warning: ${envelopeWarning(warning).message}`),
      ].join("\n"),
    };
  }
  const revision = (response.body as { media?: { revision?: unknown } } | undefined)?.media?.revision;
  return {
    envelope: jsonBody(response, client.requestId, { next: replaceNext(id) }, warnings.map(envelopeWarning)),
    exitCode: ExitCode.Success,
    human: [
      `Restored version ${number} of ${id} as the current file`,
      ...(typeof revision === "number" ? [`revision: ${revision}`] : []),
      `next: screenrig media versions ${id}`,
      ...warnings.map((warning) => `warning: ${envelopeWarning(warning).message}`),
    ].join("\n"),
  };
}, true);

// ---------------------------------------------------------------- media version delete

export const handleMediaVersionDelete = commandHandler(async (args, runtime, resolved) => {
  const id = mediaIdArg(args.positionals[3], "media version delete");
  const number = versionNumber(args, "media version delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await versionCall(client, { method: "DELETE", path: `${versionsPath(id)}/${number}`, idempotent: true }, id);
  return {
    envelope: jsonBody(response, client.requestId, { media_id: id, version: number, deleted: true }),
    exitCode: ExitCode.Success,
    human: `Deleted version ${number} of media ${id}`,
  };
}, true);
