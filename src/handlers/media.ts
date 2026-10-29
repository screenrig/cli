// Command handlers for the media commands, loaded on demand.
import { RESOURCE_ID_PATTERNS, isResourceID } from "../generated/resource-ids.js";
import { readAuthoringJson, readAuthoringText } from "../authoring-input.js";
import { openTempFile } from "../temp-file.js";
import { createHash } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { type MediaRecord, type MediaGeneration, type MediaGenerationAspectRatio, type MediaGenerationQuality, type MediaGenerationRequest, type MediaTagPatch } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { resolveConfig } from "../config.js";
import { loggerOf } from "../log/index.js";
import { successEnvelope, type ProblemNext } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { uploadMediaFile } from "../media-upload.js";
import { runMediaUploadBatch, UPLOAD_BATCH_DEFAULT_CONCURRENCY, UPLOAD_BATCH_MAX_CONCURRENCY, UPLOAD_BATCH_MIN_CONCURRENCY } from "../media-upload-batch.js";
import { clearGenerateRetryState, generateRequestHash, generateRetryState } from "../media-generate-retry.js";
import { MEDIA_FOLDER_ID_PATTERN, clientFor, commandHandler, humanLines, jsonBody, mediaFolderId, progressReporterFor, requireFlagValue, requireInputFile, resolveDownloadOutput, simpleGet, simpleList, transcodeOptionsFromArgs, type CommandResult } from "../commands.js";


export const MEDIA_TAG_PATTERN = /^[A-Za-z0-9]{1,32}$/;

export function mediaTagFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "tag", "lobby");
  const tag = flagString(args.flags, "tag");
  if (tag === undefined) {
    return undefined;
  }
  if (!MEDIA_TAG_PATTERN.test(tag)) {
    throw usageError("--tag must be 1 to 32 letters or digits.");
  }
  return tag;
}

export function mediaPrimitiveFromArgs(args: ParsedArgs): "image" | "video" | "audio" | undefined {
  requireFlagValue(args, "primitive", "image");
  const primitive = flagString(args.flags, "primitive");
  if (primitive === undefined) {
    return undefined;
  }
  if (primitive !== "image" && primitive !== "video" && primitive !== "audio") {
    throw usageError("--primitive must be image, video, or audio.");
  }
  return primitive;
}

export const handleMediaList = commandHandler(async (args, runtime, resolved) => {

  const folder = flagString(args.flags, "folder");
  return simpleList(args, runtime, resolved, "/api/media", "Media", {
    tag: mediaTagFromArgs(args),
    primitive: mediaPrimitiveFromArgs(args),
    ...(folder === undefined ? {} : { folder: folder === "root" ? folder : mediaFolderId(folder, "--folder") }),
  });
}, true);

export const handleMediaShow = commandHandler(async (args, runtime, resolved) => {

  const id = args.positionals[2];
  if (!id) throw usageError("media show requires an id.");
  return simpleGet(args, runtime, resolved, `/api/media/${id}`, "Media");
}, true);

export const handleSelectorPreview = commandHandler(async (args, runtime, resolved) => {
  const file = args.positionals[2];
  if (!file) throw usageError("media selector-preview requires <selector.json> and --primitive image|video.");
  const selector = await readAuthoringJson(file, runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const rect = flagString(args.flags, "rect");
  let rectBody: { width: number; height: number } | undefined;
  if (rect !== undefined) {
    const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(rect);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw usageError("media selector-preview --rect takes WIDTHxHEIGHT, both above 0, for example 1080x1920.");
    rectBody = { width: Number(match[1]), height: Number(match[2]) };
  }
  const timezone = flagString(args.flags, "timezone");
  const response = await client.call({ method: "POST", path: "/api/selectors/preview", body: { primitive: flagString(args.flags, "primitive"), selector, ...(rectBody ? { rect: rectBody } : {}), ...(timezone === undefined ? {} : { timezone }) } });
  const preview = response.body as { candidates?: Array<{ filename: string; media_id: string; weight?: number; share_percent?: number }>; excluded?: Array<{ filename: string; media_id: string; reason: string }>; cycle?: number };
  const shares = (preview.candidates ?? []).filter((item) => item.share_percent !== undefined).map((item) => `${item.share_percent}%\t${item.filename}\t${item.media_id}`);
  const left = (preview.excluded ?? []).map((item) => `left out (${item.reason})\t${item.filename}\t${item.media_id}`);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [JSON.stringify(response.body, null, 2), ...(shares.length > 0 ? [`Expected shares (one cycle is ${preview.cycle} plays):`, ...shares] : []), ...left].join("\n"),
  };
}, true);

export const handleMediaUpdate = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return mediaUpdate(args, client);
}, true);

export const handleMediaDownload = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "media.download", message: "media download" }, () =>
    mediaDownload(args, runtime, client),
  );
}, true);

export const handleMediaDelete = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const revision = flagString(args.flags, "expect-rev");
  if (!id) throw usageError("media delete requires <id>.");
  const response = await client.call({
    method: "DELETE",
    path: `/api/media/${id}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted media ${id}` };
}, true);

/** `--folder` on an upload: the destination must exist before any transcode or transfer work starts. */
export async function uploadFolderFromArgs(args: ParsedArgs, client: ApiClient): Promise<string | undefined> {
  const folder = flagString(args.flags, "folder");
  if (folder === undefined) return undefined;
  const id = mediaFolderId(folder, "--folder");
  await client.call({ method: "GET", path: `/api/media-folders/${id}` });
  return id;
}

export const handleMediaFolderList = commandHandler(async (args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/media-folders", "Media folders"), true);

export const handleMediaFolderShow = commandHandler(async (args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, `/api/media-folders/${mediaFolderId(args.positionals[3], "media folder show <id>")}`, "Media folder"), true);

export const handleMediaFolderCreate = commandHandler(async (args, runtime, resolved) => {
  const parent = flagString(args.flags, "parent");
  const body: { name: string; parent_id?: string } = { name: flagString(args.flags, "name")! };
  if (parent !== undefined) body.parent_id = mediaFolderId(parent, "--parent");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/media-folders", idempotent: true, body });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Created media folder ${(response.body as { id: string }).id}` };
}, true);

export const handleMediaFolderUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = mediaFolderId(args.positionals[3], "media folder update <id>");
  const name = flagString(args.flags, "name");
  const parent = flagString(args.flags, "parent");
  const root = flagBool(args.flags, "root");
  const revision = flagString(args.flags, "expect-rev");
  if (name === undefined && parent === undefined && !root) {
    throw usageError("media folder update requires --name NAME, --parent ID, or --root.");
  }
  const body: { name?: string; parent_id?: string | null } = {};
  if (name !== undefined) body.name = name;
  if (parent !== undefined) body.parent_id = mediaFolderId(parent, "--parent");
  if (root) body.parent_id = null;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "PATCH", path: `/api/media-folders/${id}`, idempotent: true, body,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Updated media folder ${id}` };
}, true);

export const handleMediaFolderDelete = commandHandler(async (args, runtime, resolved) => {
  const id = mediaFolderId(args.positionals[3], "media folder delete <id>");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "DELETE", path: `/api/media-folders/${id}`, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted media folder ${id}; its contents moved up one level` };
}, true);

export const handleMediaMove = commandHandler(async (args, runtime, resolved) => {
  const destination = flagString(args.flags, "folder");
  const toRoot = flagBool(args.flags, "root");
  if ((destination === undefined) === !toRoot) throw usageError("media move requires exactly one of --folder ID or --root.");
  const media_ids: string[] = [];
  const folder_ids: string[] = [];
  for (const id of args.positionals.slice(2)) {
    if (MEDIA_FOLDER_ID_PATTERN.test(id)) folder_ids.push(id);
    else if (MEDIA_ID_PATTERN.test(id)) media_ids.push(id);
    else throw usageError(`media move takes media IDs (med_...) and folder IDs (mfd_...), not ${JSON.stringify(id)}.`);
  }
  if (!media_ids.length && !folder_ids.length) throw usageError("media move requires at least one media or folder ID.");
  const body = {
    folder_id: destination === undefined ? null : mediaFolderId(destination, "--folder"),
    ...(media_ids.length ? { media_ids } : {}),
    ...(folder_ids.length ? { folder_ids } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/media/move", idempotent: true, body });
  const moved = response.body as { media: number; folders: number };
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Moved ${moved.media} files and ${moved.folders} folders` };
}, true);

export const handleMediaGenerate = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "media.generate", message: "media generate" }, () =>
    mediaGenerate(args, runtime, client, resolved),
  );
}, true);

export const handleMediaUpload = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "media.upload", message: "media upload" }, () =>
    mediaUpload(args, runtime, client),
  );
}, true);

export const handleMediaUploadBatch = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return mediaUploadBatch(args, runtime, client, resolved);
}, true);

export const GENERATE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const GENERATE_QUALITIES = ["low", "medium", "high"] as const;
export const GENERATE_PROMPT_MAX = 4000;

/**
 * `media generate` is answered with the generation's operation (HTTP 202) and
 * then waits on that operation. One request that stays open while the image
 * vendor works would be cut off by the proxy in front of the API after 100 s
 * without a byte. The server's own budget for the vendor,
 * the render, the store and the debit is 165 s, so the wait sits above it and the
 * CLI never abandons a still the project has already been billed for. `--timeout`
 * sets the wait, as it does for the other operations.
 */
export const GENERATE_WAIT_MS = 180_000;

/** Measured durations per tier, for the up-front notice only. */
export const GENERATE_TYPICAL_SECONDS: Record<MediaGenerationQuality, number> = {
  low: 15,
  medium: 35,
  high: 80,
};

export function isGenerateAspectRatio(value: string): value is MediaGenerationAspectRatio {
  return (GENERATE_ASPECT_RATIOS as readonly string[]).includes(value);
}

export function isGenerateQuality(value: string): value is MediaGenerationQuality {
  return (GENERATE_QUALITIES as readonly string[]).includes(value);
}

export function mediaGenerationFromBody(body: unknown): MediaGeneration {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  const rec = body as Record<string, unknown>;
  const media = rec.media;
  const usage = rec.usage;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  const id = (media as { id?: unknown }).id;
  if (typeof id !== "string" || !isResourceID(id, "media")) {
    throw unexpectedResponseError("Media generation response is missing a med_… media id.");
  }
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  const credits = (usage as { credits?: unknown }).credits;
  const usd = (usage as { usd?: unknown }).usd;
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 1) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  if (typeof usd !== "string" || usd.length < 1) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  return {
    media: media as MediaGeneration["media"],
    usage: usage as MediaGeneration["usage"],
  };
}

/**
 * A billed generation whose answer never arrived leaves the caller unable
 * to say whether the still exists. Name both ways to find out: the identical
 * re-run replays under the stored key, and the listing shows what the project
 * actually holds.
 */
/**
 * A generation answer the CLI cannot use (empty, not JSON, wrong status, not a
 * MediaGeneration) leaves the outcome unknown. Say how to check before an
 * agent generates, and pays for, a second still.
 */
export function unusableGenerateAnswer(error: unknown, tag?: string): unknown {
  if (!(error instanceof CliError) || error.problem.code !== "unexpected_response") return error;
  const listCommand = tag ? `screenrig media list --tag ${tag}` : "screenrig media list --primitive image";
  return new CliError({
    ...error.problem,
    hint: `The server's answer did not describe a generated still, so it is unknown whether one was created. Check ${listCommand} before generating again; if no new still is there, create the image with your own tools and add it with screenrig media upload, and report the request_id with screenrig feedback bug.`,
    next: { command: listCommand, reason: "Lists this project's stills, newest first, so you can see whether the generation produced one." },
  }, error.exitCode, error.warnings);
}

export function ambiguousGenerateError(error: unknown, options: { elapsedMs: number; tag?: string }): unknown {
  if (!(error instanceof CliError)) return error;
  if (error.problem.code !== "timeout" && error.problem.code !== "transport_error") return error;
  const seconds = Math.round(options.elapsedMs / 1000);
  const listCommand = options.tag
    ? `screenrig media list --tag ${options.tag}`
    : "screenrig media list --primitive image";
  return new CliError(
    makeProblem(
      error.problem.code,
      error.problem.title,
      error.problem.status,
      `media generate did not return a result after ${seconds} s. The still may or may not have been created, and a created still is billed. ` +
        "Re-run the identical media generate command: it retries with the same idempotency key, so a still that was created is returned instead of generating and billing a second one.",
      {
        request_id: error.problem.request_id,
        hint: "Run the identical media generate command again, unchanged: a still that was already created is returned and not billed twice. Changing the prompt or options starts a new, separately billed generation.",
        next: {
          command: listCommand,
          reason: "Lists this project's stills, newest first, so you can see whether the generation completed before you re-run it.",
        },
      },
    ),
    error.exitCode,
    error.warnings,
  );
}

export function writeGenerateNotice(
  args: ParsedArgs,
  runtime: CliRuntime,
  quality: MediaGenerationQuality,
): void {
  if (flagBool(args.flags, "no-progress")) return;
  const seconds = GENERATE_TYPICAL_SECONDS[quality];
  if (!flagBool(args.flags, "human")) {
    runtime.stderr.write(
      `${JSON.stringify({
        event: "media_generate_started",
        quality,
        typical_seconds: seconds,
        timeout_ms: GENERATE_WAIT_MS,
      })}\n`,
    );
    return;
  }
  runtime.stderr.write(
    `screenrig: media generate waits until the still is ready; ${quality} quality usually takes about ${seconds} s.\n`,
  );
}

export async function mediaGenerate(
  args: ParsedArgs,
  runtime: CliRuntime,
  client: ApiClient,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  requireFlagValue(args, "prompt", `"Finished event poster with title, facts, and type in the image"`);
  requireFlagValue(args, "aspect-ratio", "16:9");
  requireFlagValue(args, "quality", "medium");
  const promptFile = flagString(args.flags, "prompt-file");
  const prompt = promptFile ? await readAuthoringText(promptFile, runtime, GENERATE_PROMPT_MAX * 4) : flagString(args.flags, "prompt");
  if (prompt === undefined || prompt.length < 1 || prompt.length > GENERATE_PROMPT_MAX) {
    throw usageError("media generate requires --prompt TEXT or --prompt-file FILE containing 1 to 4000 characters.");
  }
  const aspectRatio = flagString(args.flags, "aspect-ratio") ?? "16:9";
  if (!isGenerateAspectRatio(aspectRatio)) {
    throw usageError("--aspect-ratio must be 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, or 2:3.");
  }
  const quality = flagString(args.flags, "quality") ?? "medium";
  if (!isGenerateQuality(quality)) {
    throw usageError("--quality must be low, medium, or high.");
  }
  const tag = mediaTagFromArgs(args);
  const body: MediaGenerationRequest = {
    prompt,
    aspect_ratio: aspectRatio,
    quality,
    ...(tag ? { tag } : {}),
  };
  const waitMs = flagNumber(args.flags, "timeout") ?? GENERATE_WAIT_MS;
  const retry = await generateRetryState({
    resolved,
    runtime,
    requestHash: generateRequestHash(body),
    ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
  });
  writeGenerateNotice(args, runtime, quality);
  const startedAt = runtime.now().getTime();
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: "/api/media/generations",
      idempotent: true,
      idempotencyKey: retry.state.idempotency_key,
      body,
    });
  } catch (error) {
    const ambiguous = ambiguousGenerateError(error, {
      elapsedMs: runtime.now().getTime() - startedAt,
      ...(tag ? { tag } : {}),
    });
    if (ambiguous === error) {
      // The server answered, so there is nothing for a replay to recover.
      await clearGenerateRetryState(resolved, runtime, retry.state.idempotency_key);
    }
    throw unusableGenerateAnswer(ambiguous, tag);
  }
  let generated: MediaGeneration;
  let operationId: string | undefined;
  try {
    if (response.status === 202) {
      const accepted = acceptedGenerationOperation(response.body);
      operationId = accepted;
      const operation = await client.waitForOperation(accepted, {
        timeoutMs: waitMs,
        pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
        sleep: runtime.sleep,
      });
      generated = mediaGenerationFromBody({ media: { id: operation.result?.media_id }, usage: operation.result?.usage });
      generated = { ...generated, media: await generatedMedia(client, generated.media.id) };
    } else {
      throw unexpectedResponseError(
        `media generate expected HTTP 202 with an operation and got HTTP ${response.status}.`,
        response.headers["x-request-id"] ?? client.requestId,
      );
    }
  } catch (error) {
    // Only a wait that ended without an answer keeps the key: the operation is
    // still running, and the identical command resumes it. Anything the server
    // decided (a failed operation, a refusal, an unusable answer) has nothing
    // left to replay.
    if (!(error instanceof CliError && (error.problem.code === "timeout" || error.problem.code === "transport_error") && operationId !== undefined)) {
      await clearGenerateRetryState(resolved, runtime, retry.state.idempotency_key);
    }
    throw unusableGenerateAnswer(waitingForGeneration(error, operationId), tag);
  }
  const elapsedMs = runtime.now().getTime() - startedAt;
  const mediaId = generated.media.id;
  // The generation resolved, so the stored key has nothing left to replay.
  await clearGenerateRetryState(resolved, runtime, retry.state.idempotency_key);
  return {
    envelope: successEnvelope(
      { media: generated.media, usage: generated.usage, id: mediaId, media_id: mediaId, elapsed_ms: elapsedMs },
      {
        request_id: client.requestId,
        ...(operationId ? { operation_id: operationId } : {}),
        warnings: response.headers.warning ? [{ code: "server_warning", message: response.headers.warning }] : [],
      },
    ),
    exitCode: ExitCode.Success,
    human: humanLines("Generated media", [
      ["media_id", mediaId],
      ["quality", generated.usage.quality ?? quality],
      ["credits", String(generated.usage.credits)],
      ["usd", generated.usage.usd],
      ["elapsed_ms", String(elapsedMs)],
    ]),
  };
}

/**
 * The operation id of a 202 answer, or the unusable-answer error that says the
 * outcome is unknown. A random id may carry an environment marker (stage_op_…),
 * as the other resource ids do.
 */
export function acceptedGenerationOperation(body: unknown): string {
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !/^(?:(?:stage|qa|development)_)?op_[A-Za-z0-9_-]+$/.test(id)) {
    throw unexpectedResponseError("media generate expected an op_… operation id in the HTTP 202 answer.");
  }
  return id;
}

/**
 * The finished still, for the envelope's `media`. The operation names only the
 * media id; the still is already stored and billed, so a failed read falls back
 * to the id instead of failing the command.
 */
export async function generatedMedia(client: ApiClient, mediaId: string): Promise<MediaGeneration["media"]> {
  try {
    const response = await client.call({ method: "GET", path: `/api/media/${mediaId}` });
    return response.body as MediaGeneration["media"];
  } catch {
    // The client's operation log already holds the failed read.
    return { id: mediaId } as MediaGeneration["media"];
  }
}

/**
 * A wait that ended while the generation was still running leaves the still
 * unfinished, not lost: say that the identical command resumes it.
 */
export function waitingForGeneration(error: unknown, operationId: string | undefined): unknown {
  if (operationId === undefined || !(error instanceof CliError)) return error;
  if (error.problem.code !== "timeout" && error.problem.code !== "transport_error") return error;
  return new CliError({
    ...error.problem,
    hint: `${error.problem.hint ?? ""} Or rerun the identical media generate command: it resumes operation ${operationId} under the same idempotency key and never bills a second still.`.trim(),
  }, error.exitCode, error.warnings);
}

export async function mediaUpdate(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  const revision = flagString(args.flags, "expect-rev");
  const clearTag = flagBool(args.flags, "clear-tag");
  const tag = mediaTagFromArgs(args);
  if (!id) {
    throw usageError("media update requires <id> and --tag TAG, --tags TAG1,TAG2, or --clear-tag.");
  }
  if ([clearTag, Boolean(tag), flagString(args.flags, "tags") !== undefined].filter(Boolean).length !== 1) {
    throw usageError("media update requires exactly one of --tag TAG, --tags TAG1,TAG2, or --clear-tag.");
  }
  const tagsFlag = flagString(args.flags, "tags");
  const tags = tagsFlag?.split(",");
  if (tags !== undefined && (tags.length > 32 || new Set(tags).size !== tags.length || tags.some(value => !/^[A-Za-z0-9]{1,32}$/.test(value)))) throw usageError("--tags requires 1 through 32 unique alphanumeric tags separated by commas; use --clear-tag to clear the set.");
  const body: MediaTagPatch = tags === undefined ? { tag: clearTag ? null : tag ?? null } : { tags };
  const response = await client.call({
    method: "PATCH",
    path: `/api/media/${id}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
    body,
  });
  const done = clearTag ? `Cleared tags on media ${id}` : `Replaced tags on media ${id}`;
  // Under Propose a tag change waits for a person's review.
  if ((response.body as { review_state?: unknown } | undefined)?.review_state === "pending") return mediaReviewPendingResult(response, client.requestId, done);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: done,
  };
}

export const MEDIA_AVAILABILITY_KEYS = ["from", "until", "windows", "monthly", "dates", "except"];

/** The availability rule of a media item: the schedule's clock grammar without data or interaction. The server checks every value; this refuses a file that cannot be a rule at all. */
export function mediaAvailabilityRule(parsed: unknown, file: string): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`${file} must hold one JSON object, for example {"from": "2026-11-27T00:00", "until": "2026-11-30T00:00"}.`);
  }
  const rule = parsed as Record<string, unknown>;
  const keys = Object.keys(rule);
  if (keys.length === 0) {
    throw usageError(`${file} holds an empty rule. Give at least one of ${MEDIA_AVAILABILITY_KEYS.join(", ")}, or use --clear to make the file always available.`);
  }
  for (const key of keys) {
    if (key === "data" || key === "interaction") {
      throw usageError(`An availability rule says when a file may play, not what plays: remove "${key}" from ${file}.`);
    }
    if (!MEDIA_AVAILABILITY_KEYS.includes(key)) {
      throw usageError(`${file} has "${key}", which an availability rule does not take. Use ${MEDIA_AVAILABILITY_KEYS.join(", ")}.`);
    }
  }
  return rule;
}

export const handleMediaAvailability = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const file = flagString(args.flags, "file");
  const clear = flagBool(args.flags, "clear");
  if (!id) throw usageError("media availability requires <id> and exactly one of --file RULE.json or --clear.");
  if (!MEDIA_ID_PATTERN.test(id)) throw usageError(`media availability takes a media ID (med_...), not ${JSON.stringify(id)}; media list shows them.`);
  if ((file === undefined) === !clear) throw usageError("media availability requires exactly one of --file RULE.json (or - for stdin) or --clear.");
  const rule = file === undefined ? null : mediaAvailabilityRule(await readAuthoringJson(file, runtime), file);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // The route requires the media revision: read it unless --expect-rev names it.
  let revision = flagString(args.flags, "expect-rev");
  if (revision === undefined) {
    const current = await client.call({ method: "GET", path: `/api/media/${id}` });
    const value = (current.body as { revision?: unknown } | undefined)?.revision;
    if (typeof value !== "number") throw usageError(`Media ${id} returned no revision; pass --expect-rev REVISION.`);
    revision = String(value);
  }
  const response = await client.call({
    method: "PATCH",
    path: `/api/media/${id}/availability`,
    idempotent: true,
    headers: { "if-match": quotedRevision(revision) },
    body: { availability: rule },
  });
  const done = rule === null ? `Cleared availability on media ${id}: the file is always available to dynamic selectors` : `Set availability on media ${id}`;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `${done}\n${JSON.stringify(response.body, null, 2)}`,
  };
}, true);

export const MEDIA_REVIEW_PENDING_SENTENCE ="Screens keep playing what was approved until a person approves this change. Its review appears in screenrig reviews list within seconds; a change that alters no approved playlist or open proposal applies without one. Do not repeat the write.";

/**
 * Media a Propose write left pending (review_state pending): a success, exit
 * 0. The media review worker opens its review shortly after, so the answer
 * carries no review id; next lists reviews.
 */
export function mediaReviewPendingResult(response: { body: unknown; headers: Record<string, string> }, requestId: string, done: string): CommandResult {
  const next: ProblemNext = { command: "screenrig reviews list", argv: ["reviews", "list"], reason: "Find this media's review and give the person its URL." };
  return {
    envelope: jsonBody(response, requestId, { next }, [{ code: "media_review_pending", message: "Waiting for a person to approve this media change; its review appears in screenrig reviews list within seconds." }]),
    exitCode: ExitCode.Success,
    human: [done, "review_state: pending", MEDIA_REVIEW_PENDING_SENTENCE, `next: ${next.command}`].join("\n"),
  };
}

export const MEDIA_ID_PATTERN = RESOURCE_ID_PATTERNS.media;

/** Canonical file extension for each verified media content type, matching the server's Content-Disposition. */
export const MEDIA_CONTENT_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
};

export function mediaRecordFromBody(body: unknown, id: string): MediaRecord {
  const rec = (body ?? {}) as Partial<MediaRecord>;
  if (
    rec.id !== id ||
    typeof rec.content_type !== "string" ||
    typeof rec.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(rec.sha256) ||
    typeof rec.bytes !== "number" ||
    !Number.isInteger(rec.bytes) ||
    rec.bytes < 1
  ) {
    throw usageError(`Media ${id} metadata does not match the Media contract; cannot verify a download.`);
  }
  return rec as MediaRecord;
}

/**
 * `media download <id> [--output FILE]` binds `GET /api/media/{id}/content`.
 *
 * The metadata row is read first so the default name, the expected length,
 * and the expected SHA-256 come from the server; the streamed bytes are
 * verified against them before the file is moved into place. Bytes never
 * reach stdout, the envelope, or the log.
 */
export async function mediaDownload(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id || !MEDIA_ID_PATTERN.test(id)) {
    throw usageError("media download requires <id> starting with med_.");
  }

  const metadataResponse = await client.call({ method: "GET", path: `/api/media/${id}` });
  const media = mediaRecordFromBody(metadataResponse.body, id);
  const extension = MEDIA_CONTENT_EXTENSIONS[media.content_type.toLowerCase()];
  if (!extension) {
    throw usageError(`Media ${id} has content type ${media.content_type}, which this CLI cannot write.`);
  }
  const outputPath = await resolveDownloadOutput(runtime.cwd(), `./${id}.${extension}`, args.flags);

  const response = await client.download({ method: "GET", path: `/api/media/${id}/content` });
  let temp: Awaited<ReturnType<typeof openTempFile>> | undefined;
  let digest = "";
  let written = 0;
  try {
    const contentType = (response.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== media.content_type.toLowerCase()) {
      throw usageError(`Media ${id} download Content-Type did not match its metadata.`);
    }
    const reportedLength = response.headers["content-length"];
    if (reportedLength !== undefined && reportedLength !== String(media.bytes)) {
      throw usageError(`Media ${id} download Content-Length did not match its metadata.`);
    }
    if (!response.body) {
      throw usageError(`Media ${id} download returned no body.`);
    }
    const hash = createHash("sha256");
    temp = await openTempFile(outputPath);
    const handle = temp.handle;
    try {
      for await (const chunk of response.body) {
        written += chunk.byteLength;
        if (written > media.bytes) {
          throw usageError(`Media ${id} download exceeded the declared length.`);
        }
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += result.bytesWritten;
        }
        hash.update(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (written !== media.bytes) {
      throw usageError(`Media ${id} download ended before the declared length.`);
    }
    digest = hash.digest("hex");
    if (digest !== media.sha256) {
      throw usageError(`Media ${id} download SHA-256 did not match its metadata.`);
    }
    await rename(temp.path, outputPath);
  } catch (error) {
    if (temp) await rm(temp.path, { force: true });
    if (error instanceof CliError) {
      throw error;
    }
    throw usageError("Cannot write the media download to the output path.");
  } finally {
    temp?.release();
    await response.body?.cancel?.();
  }

  const data = {
    media_id: id,
    id,
    path: outputPath,
    bytes: written,
    sha256: digest,
    content_type: media.content_type,
    primitive: media.primitive,
    filename: media.filename,
    ...(typeof media.source_filename === "string" ? { source_filename: media.source_filename } : {}),
    ...(typeof media.width === "number" ? { width: media.width } : {}),
    ...(typeof media.height === "number" ? { height: media.height } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Media downloaded", [
      ["media_id", id],
      ["path", outputPath],
      ["bytes", String(written)],
      ["sha256", digest],
      ["content_type", media.content_type],
      ["filename", media.filename],
      ["source_filename", media.source_filename],
      ["size", typeof media.width === "number" && typeof media.height === "number" ? `${media.width}x${media.height}` : undefined],
    ]),
  };
}

export async function mediaUpload(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const file = args.positionals[2];
  if (!file) throw usageError("media upload requires a file.");
  const sourcePath = path.resolve(runtime.cwd(), file);
  await requireInputFile(sourcePath, file);
  const explicitContentType = flagString(args.flags, "content-type");

  // Validate unconditionally so a typo such as --webp-quality 500 is rejected
  // whether or not transcoding runs. The result is unused under --no-transcode.
  const transcodeOptions = transcodeOptionsFromArgs(args);
  const folderId = await uploadFolderFromArgs(args, client);
  const uploaded = await uploadMediaFile({
    runtime,
    client,
    sourcePath,
    explicitContentType,
    tag: mediaTagFromArgs(args),
    ...(folderId ? { folderId } : {}),
    transcodeOptions,
    noTranscode: flagBool(args.flags, "no-transcode"),
    reporter: progressReporterFor(args, runtime),
    noWait: flagBool(args.flags, "no-wait"),
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
    resumable: flagString(args.flags, "idempotency-key") !== undefined,
  });
  const mediaId = uploaded.mediaId;
  const data = {
    ...(mediaId ? { media_id: mediaId, id: mediaId } : {}),
    ...(folderId ? { folder_id: folderId } : {}),
    operation: uploaded.operation,
    reused: uploaded.reused,
    upload: uploaded.upload,
    transcode: uploaded.transcode,
    timing: uploaded.timing,
  };
  return {
    envelope: successEnvelope(data, {
      request_id: client.requestId,
      operation_id: uploaded.operation.id,
      warnings: uploaded.warnings,
    }),
    exitCode: ExitCode.Success,
    human: humanLines(uploaded.reused ? "Media already uploaded" : flagBool(args.flags, "no-wait") ? "Media upload committed" : "Media uploaded", [
      ["media_id", mediaId],
      ["operation_id", uploaded.operation.id],
      ["state", uploaded.operation.state],
      ["filename", uploaded.upload.filename],
      ["source_filename", uploaded.upload.source_filename],
      ["content_type", uploaded.upload.content_type],
      ["tag", uploaded.upload.tag],
      ["folder_id", folderId],
      ["transcode", typeof uploaded.transcode.duration_ms === "number" ? `${uploaded.transcode.reason} in ${uploaded.transcode.duration_ms} ms` : "skipped"],
      ["sha256", uploaded.upload.sha256],
      ["timing", Object.entries(uploaded.timing).map(([stage, ms]) => `${stage.replace(/_ms$/, "")} ${ms} ms`).join(", ")],
      ...uploaded.warnings.map((warning): [string, string] => ["warning", warning.message]),
    ]),
  };
}

export async function mediaUploadBatch(
  args: ParsedArgs,
  runtime: CliRuntime,
  client: ApiClient,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const manifest = args.positionals[2];
  if (!manifest) {
    throw usageError("media upload-batch requires one manifest JSON file.");
  }
  requireFlagValue(args, "state", "./upload-state.json");
  requireFlagValue(args, "concurrency", "4");
  const state = flagString(args.flags, "state") ?? path.join(path.dirname(resolved.configPath), "upload-batches", createHash("sha256").update(JSON.stringify([resolved.apiUrl, resolved.projectId ?? resolved.token, path.resolve(runtime.cwd(), manifest)])).digest("hex") + ".json");
  const concurrency = flagNumber(args.flags, "concurrency") ?? UPLOAD_BATCH_DEFAULT_CONCURRENCY;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < UPLOAD_BATCH_MIN_CONCURRENCY ||
    concurrency > UPLOAD_BATCH_MAX_CONCURRENCY
  ) {
    throw usageError(
      `--concurrency must be a whole number from ${UPLOAD_BATCH_MIN_CONCURRENCY} to ${UPLOAD_BATCH_MAX_CONCURRENCY}.`,
    );
  }
  const transcodeOptions = transcodeOptionsFromArgs(args);
  const folderId = await uploadFolderFromArgs(args, client);
  const result = await runMediaUploadBatch({
    runtime,
    client,
    manifestPath: path.resolve(runtime.cwd(), manifest),
    statePath: path.resolve(runtime.cwd(), state),
    apiUrl: resolved.apiUrl,
    projectId: resolved.projectId,
    concurrency,
    defaultTag: mediaTagFromArgs(args),
    ...(folderId ? { folderId } : {}),
    transcodeOptions,
    noTranscode: flagBool(args.flags, "no-transcode"),
    reporter: progressReporterFor(args, runtime),
    json: !flagBool(args.flags, "human"),
    noProgress: flagBool(args.flags, "no-progress"),
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
  });
  return {
    envelope: successEnvelope(folderId ? { ...result.data, folder_id: folderId } : result.data, {
      request_id: client.requestId,
      warnings: result.warnings,
    }),
    exitCode: result.exitCode,
    human: result.human,
  };
}
