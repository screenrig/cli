// Command handlers for the playlist commands, loaded on demand.
import { requireCapability } from "../project-capabilities.js";
import { RESOURCE_ID_PATTERNS } from "../generated/resource-ids.js";
import { replacePlaylistRelease } from "../playlist-release.js";
import { assertOutputAvailable, readAuthoringJson, writeAuthoringJson, writeOutputFile } from "../authoring-input.js";
import { playlistAnswerWarnings, playlistWarnings, withoutAnswerWarnings } from "../playlist-warnings.js";
import { editablePlaylist, isAdSlotPage, preparePlaylist, shortApplicationPageWarning, targetDimensions } from "../playlist-authoring.js";
import { callPlaylist } from "../playlist-api.js";
import { playlistInUseProblem } from "../screen-control.js";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { type Screen } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { loggerOf } from "../log/index.js";
import { pendingReviewLines, pendingReviewOf, pendingReviewWarning, reviewNext } from "../reviews.js";
import { successEnvelope, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { iframeSnippetSource } from "../iframe-snippet.js";
import { hasScreenToken, screenTemplateRefusal, screenTokenStandIn } from "../screen-tokens.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { assertPlaylistValid, PLAYLIST_SERVER_CHECKS, playlistLint } from "../playlist-validate.js";
import { assertWirePages } from "../playlist-write-validation.js";
import { playlistNeedsTimezone } from "../generated/playlist-write-semantics.js";
import { uploadMediaFile, type MediaUploadTiming } from "../media-upload.js";
import { exportPlaylistBundle, importPlaylistBundle } from "../playlist-bundle.js";
import { validatePlaylistCards } from "../cards.js";
import { clientFor, commandHandler, humanLines, jsonBody, pendingReviewResult, playlistWriteResult, progressReporterFor, requireFlagValue, resolveProjectContext, resourceNotes, reviewNoteFrom, scheduleZoneError, simpleList, transcodeOptionsFromArgs, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


export const handlePlaylistValidate = commandHandler(async (args, runtime, resolved) => {
  const file = args.positionals[2];
  if (!file) throw usageError("playlist validate requires one JSON file.");
  let parsed: Record<string, unknown>;
  try { parsed = await readAuthoringJson(file, runtime); }
  catch { throw usageError("Cannot read playlist JSON."); }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.pages)) assertWirePages(parsed.pages);
  const body = parsed;
  assertPlaylistValid(body);
  const lint = playlistLint(body);
  const shortApplication = shortApplicationPageWarning(body);
  return {
    envelope: successEnvelope({ valid: true, scope: "local_schema_and_semantics", server_checks: PLAYLIST_SERVER_CHECKS, lint }, { warnings: shortApplication ? [shortApplication] : [] }),
    exitCode: ExitCode.Success,
    human: [
      "Playlist passed local canonical validation. Reference authorization and runtime readiness require server checks.",
      ...(shortApplication ? [`warning: ${shortApplication.message}`] : []),
      ...lint.map((item) => `lint: ${item.page_id} ${item.code} ${item.id}`),
    ].join("\n"),
  };
}, false);

export const handlePlaylistList = commandHandler(async (args, runtime, resolved) => {

  const result = await simpleList(args, runtime, resolved, "/api/playlists", "Playlists");
  if (result.envelope.ok) {
    const data = result.envelope.data as { items?: Array<{ id: string; name: string; revision: number; updated_at?: string; fields?: unknown[] }> };
    if (Array.isArray(data.items) && flagBool(args.flags, "templates")) {
      data.items = data.items.filter((item) => Array.isArray(item.fields) && item.fields.length > 0);
    }
    if (Array.isArray(data.items)) {
      result.human = ["Playlists", "ID\tRevision\tUpdated\tName",
        ...data.items.map((item) => `${item.id}\t${item.revision}\t${item.updated_at ?? "—"}\t${item.name}`),
      ].join("\n");
    }
  }
  return result;
}, true);

export const handlePlaylistShow = commandHandler(async (args, runtime, resolved) => {

  const id = args.positionals[2];
  if (!id) throw usageError("playlist show requires an id.");
  const output = flagString(args.flags, "output");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await callPlaylist(client, { method: "GET", id });
  if (!output && !flagBool(args.flags, "editable")) {
    const requestId = client.requestId;
    const notes = await resourceNotes(runtime, client, "playlist", id);
    return { envelope: jsonBody(response, requestId, undefined, notes.warnings), exitCode: ExitCode.Success,
      human: [`Playlist\n${JSON.stringify(response.body, null, 2)}`, ...notes.lines].join("\n") };
  }
  const resource = response.body as { id: string; revision: number };
  if (resource.id !== id || !Number.isSafeInteger(resource.revision) || resource.revision < 1) throw usageError("Playlist response has invalid identity or revision.");
  const document = editablePlaylist(response.body);
  const file = output ? await writeAuthoringJson(output, document, runtime, flagBool(args.flags, "overwrite")) : undefined;
  return { envelope: successEnvelope({ playlist_id: id, revision: resource.revision, ...(file ? { output: file } : { document }) }, { request_id: client.requestId }), exitCode: ExitCode.Success, human: file ? `Editable playlist written to ${file}` : JSON.stringify(document, null, 2) };
}, true);

export const handlePlaylistExport = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  requireFlagValue(args, "output", "./playlist-bundle");
  const id = args.positionals[2];
  const output = flagString(args.flags, "output");
  if (!id || !output) {
    throw usageError("playlist export requires <id> --output <directory>.");
  }
  const result = await exportPlaylistBundle({
    playlistId: id,
    outputDirectory: path.resolve(runtime.cwd(), output),
    client,
    skipApplications: flagBool(args.flags, "skip-applications"),
  });
  const skipped = result.skipped_applications;
  return {
    envelope: successEnvelope(result, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Playlist exported", [
      ["playlist_id", result.playlist_id],
      ["directory", result.directory],
      ["media_count", String(result.media_count)],
      ["media_bytes", String(result.media_bytes)],
      ...(skipped.primitives.length > 0 ? [["skipped_application_primitives", skipped.primitives.join(", ")] as [string, string]] : []),
      ...(skipped.pages.length > 0 ? [["skipped_pages", skipped.pages.join(", ")] as [string, string]] : []),
    ]),
  };
}, true);

export const handlePlaylistImport = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  requireFlagValue(args, "update", "pl_01");
  requireFlagValue(args, "expect-rev", "1");
  requireFlagValue(args, "name", "Lobby loop (copy)");
  const directory = args.positionals[2];
  if (!directory) throw usageError("playlist import requires one <directory>.");
  const updateId = flagString(args.flags, "update");
  const ifMatch = flagString(args.flags, "expect-rev");
  const name = flagString(args.flags, "name");
  const result = await importPlaylistBundle({
    directory: path.resolve(runtime.cwd(), directory),
    client,
    runtime,
    updateId,
    ifMatch,
    name,
    timeoutMs: flagNumber(args.flags, "timeout"),
    pollMs: flagNumber(args.flags, "poll-ms"),
    note: flagString(args.flags, "note"),
    beforePlaylistWrite: async (playlist, targetId) => {
      if (targetId) await assertAssignedScreensHaveZone(client, targetId, playlist.pages);
    },
  });
  const media: Array<[string, string]> = [
    ["source_playlist_id", result.source_playlist_id],
    ["directory", result.directory],
    ["media_reused", String(result.media.reused)],
    ["media_uploaded", String(result.media.uploaded)],
  ];
  const lifted = releaseWarnings(result);
  const { warnings: _raw, ...rest } = result as typeof result & { warnings?: unknown };
  const data = { ...rest, playlist: withoutAnswerWarnings(result.playlist) };
  const warningLines = lifted.map((warning) => `warning: ${warning.message}`);
  if (result.review) {
    return {
      envelope: successEnvelope({ ...data, next: reviewNext(result.review.id) }, { request_id: client.requestId, warnings: [pendingReviewWarning(result.review), ...lifted] }),
      exitCode: ExitCode.Success,
      human: [...pendingReviewLines(result.review), ...media.map(([key, value]) => `${key}: ${value}`), ...warningLines].join("\n"),
    };
  }
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: lifted }),
    exitCode: ExitCode.Success,
    human: [humanLines(`Playlist ${result.mode === "create" ? "imported" : "updated from bundle"}`, media), ...warningLines].join("\n"),
  };
}, true);

/** The warnings a library result carried (its `warnings` member, or its playlist answer's), as envelope warnings. */
export function releaseWarnings(result: { warnings?: unknown; playlist?: unknown }): Warning[] {
  const playlist = result.playlist as { id?: unknown } | undefined;
  const id = typeof playlist?.id === "string" ? playlist.id : undefined;
  return result.warnings !== undefined
    ? playlistWarnings(result.warnings, id, true)
    : playlistAnswerWarnings(result.playlist);
}

export async function playlistCreateUpdateAction(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, action: "create" | "update"): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = action === "update" ? args.positionals[2] : undefined;
  const file = action === "update" ? args.positionals[3] : args.positionals[2];
  const ifMatch = flagString(args.flags, "expect-rev");
  if (!file || (action === "update" && !id)) {
    throw usageError(`playlist ${action} requires ${action === "update" ? "<id> <file>" : "<file>"}.`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = await readAuthoringJson(file, runtime) as Record<string, unknown>;
  } catch (err) {
    throw usageError(`Cannot read playlist JSON: ${err instanceof Error ? err.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string" || !Array.isArray(parsed.pages)) {
    throw usageError("Playlist JSON must contain string name and array pages.");
  }
  const extra = Object.keys(parsed).filter((key) => key !== "name" && key !== "audio" && key !== "format" && key !== "fields" && key !== "pages");
  if (extra.length > 0) {
    throw usageError(`Playlist JSON contains unsupported fields: ${extra.join(", ")}.`);
  }
  const pages = parsed.pages;
  assertWirePages(pages);
  const region = flagString(args.flags, "format-region");
  const orientation = flagString(args.flags, "format-orientation");
  const format = region !== undefined && orientation !== undefined ? { region, orientation } : parsed.format;
  const body = { name: parsed.name, ...(parsed.audio !== undefined ? { audio: parsed.audio } : {}), ...(format !== undefined ? { format } : {}), ...(parsed.fields !== undefined ? { fields: parsed.fields } : {}), pages };
  assertPlaylistValid(body);
  await validatePlaylistCards(client, body);
  // Only a signage-capable project may place adslot pages.
  if (pages.some(isAdSlotPage)) {
    await requireCapability(client, "signage.playlists", `playlist ${action} with adslot pages`, {
      command: "screenrig project capabilities",
      reason: "Read the project's effective capabilities before authoring an ad-bearing playlist; only a screens-capable project can place adslot pages.",
    });
  }
  // A create has no assigned screen yet, so there is nothing to check. An
  // update can add a schedule to a playlist screens are already running.
  if (action === "update" && id) {
    await assertAssignedScreensHaveZone(client, id, pages);
  }
  const note = reviewNoteFrom(args);
  const response = action === "create"
    ? await client.call({ method: "POST", path: "/api/playlists", idempotent: true, body, headers: note })
    : await callPlaylist(client, {
      method: "PUT",
      id: id!,
      body,
      headers: { ...note, ...(ifMatch ? { "if-match": quotedRevision(ifMatch) } : {}) },
    });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return playlistWriteResult(response, client.requestId, `Playlist ${action}d.`);

}

export const handlePlaylistCreate = commandHandler(async (args, runtime, resolved) => {
  if (flagString(args.flags, "from-template") !== undefined || flagString(args.flags, "starter") !== undefined) {
    // Loaded here: the module imports this one, so a static import would cycle.
    return (await import("../playlist-fields.js")).playlistCreateFromTemplate(args, runtime, resolved);
  }
  return playlistCreateUpdateAction(args, runtime, resolved, "create");
}, true);

export const handlePlaylistUpdate = commandHandler(async (args, runtime, resolved) => {
  return playlistCreateUpdateAction(args, runtime, resolved, "update");
}, true);

export const handlePlaylistPatch = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const file = args.positionals[3];
  if (!id) throw usageError("playlist patch requires <id> and at least one changed field.");
  let body: Record<string, unknown> = {};
  if (file) {
    const parsed = await readAuthoringJson(file, runtime);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usageError("Playlist patch JSON must be an object.");
    body = parsed as Record<string, unknown>;
  }
  const unknown = Object.keys(body).filter((key) => !["name", "pages", "audio", "format", "fields"].includes(key));
  if (unknown.length) throw usageError(`Playlist patch contains unsupported fields: ${unknown.join(", ")}.`);
  const name = flagString(args.flags, "name");
  if (name !== undefined) {
    if (Object.hasOwn(body, "name")) throw usageError("Supply name in the patch file or --name, not both.");
    body.name = name;
  }
  if (flagBool(args.flags, "clear-audio")) {
    if (Object.hasOwn(body, "audio")) throw usageError("Supply audio in the patch file or --clear-audio, not both.");
    body.audio = null;
  }
  if (!Object.keys(body).length) throw usageError("playlist patch requires a partial JSON file, --name, or --clear-audio.");
  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim() || [...body.name.trim()].length > 120 || /[\p{Cc}]/u.test(body.name)) {
      throw usageError("name must contain 1 to 120 Unicode characters after trimming, with no control characters.");
    }
    body.name = body.name.trim();
  }
  if (Object.hasOwn(body, "pages")) {
    if (!Array.isArray(body.pages) || body.pages.length === 0) throw usageError("pages must be a non-empty array.");
    assertWirePages(body.pages);
  }
  if (body.audio !== undefined && body.audio !== null && (typeof body.audio !== "object" || Array.isArray(body.audio))) {
    throw usageError("audio must be a soundtrack object or null.");
  }
  if (body.format !== undefined && body.format !== null && (typeof body.format !== "object" || Array.isArray(body.format))) {
    throw usageError("format must be a video wall or region format object, or null.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (Array.isArray(body.pages)) {
    await validatePlaylistCards(client, { pages: body.pages });
    await assertAssignedScreensHaveZone(client, id, body.pages);
  }
  const expected = flagString(args.flags, "expect-rev");
  const response = await callPlaylist(client, { method: "PATCH", id, body,
    headers: { ...reviewNoteFrom(args), ...(expected ? { "if-match": quotedRevision(expected) } : {}) },
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return playlistWriteResult(response, client.requestId, `Playlist ${id} updated.`);
}, true);

export const handlePlaylistReplaceRelease = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const result = await replacePlaylistRelease({ client, apiUrl: resolved.apiUrl,
    playlistId: args.positionals[2]!, pageId: flagString(args.flags, "page")!,
    primitiveId: flagString(args.flags, "primitive")!, releaseId: flagString(args.flags, "release-id")!,
    apply: flagBool(args.flags, "apply"), revision: flagString(args.flags, "expect-rev"),
    impact: flagString(args.flags, "expect-impact"), note: flagString(args.flags, "note"),
  });
  const answer = result as { warnings?: unknown; playlist?: unknown };
  const lifted = releaseWarnings(answer);
  const data = { ...result, ...(answer.playlist ? { playlist: withoutAnswerWarnings(answer.playlist) } : {}) };
  delete (data as { warnings?: unknown }).warnings;
  const warningLines = lifted.map((warning) => `warning: ${warning.message}`);
  if ("review" in result && result.review) {
    return {
      envelope: successEnvelope({ ...data, next: reviewNext(result.review.id) }, { request_id: client.requestId, warnings: [pendingReviewWarning(result.review), ...lifted] }),
      exitCode: ExitCode.Success,
      human: [...pendingReviewLines(result.review), ...warningLines].join("\n"),
    };
  }
  return { envelope: successEnvelope(data, { request_id: client.requestId, warnings: lifted }), exitCode: ExitCode.Success, human: [JSON.stringify(data, null, 2), ...warningLines].join("\n") };
}, true);

export const handlePlaylistDelete = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const ifMatch = flagString(args.flags, "expect-rev");
  if (!id) throw usageError("playlist delete requires <id>.");
  let response;
  try {
    response = await callPlaylist(client, {
      method: "DELETE",
      id,
      ...(ifMatch ? { headers: { "if-match": quotedRevision(ifMatch) } } : {}),
    });
  } catch (error) {
    throw playlistInUseProblem(error);
  }
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted playlist ${id}` };
}, true);

/**
 * The same rule reached from the playlist side. Adding civil-time bounds to a
 * playlist that screens already run breaks their manifests, so check every screen
 * the playlist is assigned to rather than waiting for rematerialize to refuse.
 */
export async function assertAssignedScreensHaveZone(client: ApiClient, playlistId: string, pages: unknown): Promise<void> {
  if (!playlistNeedsTimezone({ pages })) {
    return;
  }
  const response = await client.listAll("/api/screens");
  const items = (response.body as { items?: Screen[] } | undefined)?.items;
  if (!Array.isArray(items)) {
    return;
  }
  const unzoned = items.find((screen) => screen?.playlist_id === playlistId && !screen?.timezone);
  if (unzoned) {
    throw scheduleZoneError(unzoned.id);
  }
}

export function sanitizedPreparationApiUrl(value: string): string {
  const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export const PLAYLIST_INIT_UPLOAD_CONCURRENCY = 4;

export const handlePlaylistInit = commandHandler(async (args, runtime, resolved) => {
  let existingClient: ApiClient | undefined;
  let preparedClient: Promise<ApiClient> | undefined;
  const remote = () => preparedClient ??= (async () => {
    // Purely local preparation remains offline. Once this invocation reads
    // a screen/media or uploads a file, bind a config without cached project
    // names to its authenticated project before performing that remote work.
    requireToken(resolved.token);
    resolved = await resolveProjectContext(args, runtime, resolved);
    return existingClient = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  })();
  const screenId = flagString(args.flags, "screen-id");
  const width = flagNumber(args.flags, "target-width"), height = flagNumber(args.flags, "target-height");
  const screen = screenId ? (await (await remote()).call({ method: "GET", path: `/api/screens/${encodeURIComponent(screenId)}` })).body : undefined;
  const dimensions = targetDimensions(screen, width, height);
  const target = screen as { id: string; revision: number } | undefined;
  if (screenId && (!target || target.id !== screenId || !Number.isSafeInteger(target.revision) || target.revision < 1)) {
    throw usageError("Screen response has invalid identity or revision.");
  }
  const content: Record<string, any>[] = [];
  const files = new Map<number, string>();
  const warnings: Warning[] = [];
  for (const input of args.positionals.slice(2)) {
    if (RESOURCE_ID_PATTERNS.media.test(input)) {
      const record = (await (await remote()).call({ method: "GET", path: `/api/media/${input}` })).body as Record<string, any>;
      if (record?.id !== input) throw usageError("Media response identity did not match.");
      content.push(record);
    } else if (RESOURCE_ID_PATTERNS.release.test(input)) {
      content.push({ primitive: "application", release_id: input });
    } else if (iframeSnippetSource(input) !== undefined || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
      // A pasted <iframe> embed code gives its src; the server rebuilds a
      // Google or Microsoft document link when the playlist is written.
      // An address with screen tokens ({screen.id}, {screen.field.NAME}, ...) is a template: it is kept as written, braces and all,
      // and the server fills it in for each screen.
      const written = iframeSnippetSource(input) ?? input;
      const templated = hasScreenToken(written);
      if (templated) {
        const refusal = screenTemplateRefusal(written);
        if (refusal !== undefined) throw usageError(`The iframe address ${refusal}.`);
      }
      let url: URL;
      try { url = new URL(templated ? screenTokenStandIn(written) : written); } catch { throw usageError("Provide a valid http or https iframe URL or embed code."); }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) throw usageError("Iframe URLs must use http or https.");
      content.push({ primitive: "iframe", src: templated ? written.trim() : url.href, title: url.hostname.slice(0, 200) });
    } else {
      const sourcePath = path.resolve(runtime.cwd(), input);
      try { if (!(await stat(sourcePath)).isFile()) throw new Error(); }
      catch { throw usageError("Each input must be a readable image/video/audio file, media ID, release ID, http(s) URL, or iframe embed code."); }
      files.set(content.length, sourcePath);
      // Audio files become soundtrack tracks, not pages, so the preflight
      // shape check must see them as audio before anything uploads.
      const audioFile = /\.(mp3|wav|wave|aac|m4a|m4b|ogg|oga|opus|flac|aif|aiff|wma)$/i.test(sourcePath);
      content.push({ primitive: audioFile ? "audio" : "image", state: "ready", id: "med_PENDING" });
    }
  }
  const options = { name: flagString(args.flags, "name")!, content, ...dimensions, durationMs: flagNumber(args.flags, "duration-ms"), fit: flagString(args.flags, "fit") ?? "contain" };
  // Validate the entire authoring shape and check the output before uploading.
  const validated = preparePlaylist(options);
  const shortApplication = shortApplicationPageWarning(validated);
  if (shortApplication) warnings.push(shortApplication);
  const output = path.resolve(runtime.cwd(), flagString(args.flags, "output")!);
  const overwrite = flagBool(args.flags, "overwrite");
  await assertOutputAvailable(output, overwrite);
  // Upload a few files at once; each one's content slot keeps page order.
  const queue = [...files];
  const uploads: { index: number; media_id: string; reused: boolean; timing: MediaUploadTiming }[] = [];
  const uploadNext = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [index, sourcePath] = next;
      // Scope each occurrence to the invocation key, including repeated files.
      // An identical retry with --idempotency-key reproduces both declare and commit keys.
      const idempotencyKey = createHash("sha256")
        .update(JSON.stringify(["screenrig.playlist.init.upload", (await remote()).idempotencyKey, index]))
        .digest("base64url");
      const client = await remote();
      const uploaded = await loggerOf(runtime).withLocal({ op: "media.upload", message: "media upload" }, () => uploadMediaFile({ runtime, client, sourcePath, idempotencyKey,
        transcodeOptions: transcodeOptionsFromArgs(args), noTranscode: flagBool(args.flags, "no-transcode"),
        reporter: progressReporterFor(args, runtime), noWait: false, resumable: flagString(args.flags, "idempotency-key") !== undefined,
        timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000, pollMs: flagNumber(args.flags, "poll-ms") ?? 1000 }));
      warnings.push(...uploaded.warnings);
      if (!uploaded.mediaId) throw usageError("Upload completed without a media identifier.");
      const record = (await (await remote()).call({ method: "GET", path: `/api/media/${encodeURIComponent(uploaded.mediaId)}` })).body as Record<string, any>;
      if (record?.id !== uploaded.mediaId) throw usageError("Media response identity did not match.");
      content[index] = record;
      uploads.push({ index, media_id: uploaded.mediaId, reused: uploaded.reused, timing: uploaded.timing });
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(PLAYLIST_INIT_UPLOAD_CONCURRENCY, files.size) }, () =>
    uploadNext().catch((error) => { queue.length = 0; throw error; })));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  await writeOutputFile(output, JSON.stringify(preparePlaylist(options), null, 2) + "\n", overwrite);
  const context = ["--config", resolved.configPath, "--api-url", sanitizedPreparationApiUrl(resolved.apiUrl)];
  const trackCount = content.filter((item) => item.primitive === "audio").length;
  // The resolved pins in input order, so a caller asserts what the document
  // holds instead of rereading the file.
  const releaseIds = content.filter((item) => item.primitive === "application").map((item) => String(item.release_id));
  const mediaIds = content.filter((item) => typeof item.id === "string" && RESOURCE_ID_PATTERNS.media.test(item.id)).map((item) => String(item.id));
  return { envelope: successEnvelope({ output, ...dimensions, page_count: content.length - trackCount, ...(trackCount > 0 ? { soundtrack_tracks: trackCount } : {}),
    ...(releaseIds.length > 0 ? { release_ids: releaseIds } : {}), ...(mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
    ...(uploads.length > 0 ? { uploads: uploads.sort((a, b) => a.index - b.index).map(({ index, ...upload }) => ({ source: args.positionals[2 + index], ...upload })) } : {}),
    ...(target ? { screen_id: target.id, screen_revision: target.revision } : {}),
    ...(target ? { publish: { argv: ["screen", "publish", target.id, output, ...context], reason: "Inspect the prepared document before publishing." } } : {}),
  }, { request_id: existingClient?.requestId, warnings }), exitCode: ExitCode.Success, human: `Playlist prepared at ${output}` };
}, false);
