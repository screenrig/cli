// Command handlers for the app commands, loaded on demand.
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { limitsFromCapabilities, type Capabilities, type OperationAccepted } from "../adapters/protocol.js";
import { SDK_PROTOCOL_VERSION } from "../adapters/sdk-injection.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { resolveConfig } from "../config.js";
import { loggerOf } from "../log/index.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import { packDirectory } from "../pack/index.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { applicationNameHeaders, normalizeApplicationName } from "../application-name.js";
import { directApplicationUploads, uploadApplicationDirect } from "../app-upload.js";
import { clientFor, commandHandler, humanLines, jsonBody, requireFlagValue, simpleGet, simpleList, type CommandResult } from "../commands.js";


export const handleAppPack = commandHandler(appPack, false);

export const handleAppUpload = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "app.upload", message: "app upload" }, () =>
    appUpload(args, runtime, resolved, false),
  );
}, true);

export const handleAppUpdate = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "app.update", message: "app update" }, () =>
    appUpload(args, runtime, resolved, true),
  );
}, true);

export const handleAppList = commandHandler(async (args, runtime, resolved) => {
  return simpleList(args, runtime, resolved, "/api/applications", "Applications");
}, true);

export const handleAppShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("app show requires an application id.");
  return simpleGet(args, runtime, resolved, `/api/applications/${id}`, "Application");
}, true);

export const handleAppRename = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const name = normalizeApplicationName(flagString(args.flags, "name") ?? "");
  if (!id || !name) throw usageError("app rename requires <id> and a nonempty --name.");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "PATCH", path: `/api/applications/${encodeURIComponent(id)}`,
    body: { name }, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  const application = response.body as { id: string; name: string; revision: number };
  return {
    envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: humanLines("Application renamed", [["id", application.id], ["name", application.name], ["revision", String(application.revision)]]),
  };
}, true);

export const handleAppDelete = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("app delete requires <id>.");
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "DELETE", path: `/api/applications/${encodeURIComponent(id)}`, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted application ${id}` };
}, true);

export async function appPack(args: ParsedArgs, runtime: CliRuntime): Promise<CommandResult> {
  const dir = args.positionals[2];
  if (!dir) {
    throw usageError("app pack requires a directory.");
  }
  const result = await packDirectory(await requireAppDirectory(runtime, dir, "app pack ./DIRECTORY"), { logger: loggerOf(runtime) });
  const output = flagString(args.flags, "output");
  if (output) {
    await writeFile(path.resolve(runtime.cwd(), output), result.archive);
  }
  const data = {
    sha256: result.sha256,
    compressed_bytes: result.compressed_bytes,
    expanded_bytes: result.expanded_bytes,
    file_count: result.file_count,
    entries: result.entries,
    sdk_injection: result.sdk_injection,
    output,
  };
  return {
    envelope: successEnvelope(data),
    exitCode: ExitCode.Success,
    human: humanLines("Archive packed", [
      ["sha256", result.sha256],
      ["compressed_bytes", String(result.compressed_bytes)],
      ["expanded_bytes", String(result.expanded_bytes)],
      ["file_count", String(result.file_count)],
      ["sdk_injection", result.sdk_injection.injected ? "yes" : "deferred"],
    ]),
  };
}

/** app upload and update pack the built directory themselves; a packed archive or other file is a usage error. */
export async function requireAppDirectory(runtime: CliRuntime, dir: string, usage: string): Promise<string> {
  const root = path.resolve(runtime.cwd(), dir);
  let isDirectory = false;
  try {
    isDirectory = (await stat(root)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw usageError(`${dir} does not exist. Pass the built application directory (the one with index.html).`,
      { command: `screenrig ${usage}`, reason: "Packs and uploads the directory in one step." });
  }
  if (!isDirectory) {
    throw usageError(`${dir} is a file. Pass the built application directory (the one with index.html), not a packed archive; the upload packs the directory itself.`,
      { command: `screenrig ${usage}`, reason: "Packs and uploads the directory in one step; app pack is only an optional local preview." });
  }
  return root;
}

export async function appUpload(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>, update: boolean): Promise<CommandResult> {
  const id = update ? args.positionals[2] : undefined;
  const dir = args.positionals[update ? 3 : 2];
  requireFlagValue(args, "expect-rev", "1");
  const revision = flagString(args.flags, "expect-rev");
  if (!dir || (update && !id)) {
    throw usageError(update ? "app update requires <id> <directory>." : "app upload requires one directory.");
  }
  if (update && args.flags.name !== undefined) throw usageError("app update preserves the application name; use app rename <id> --name NAME to rename it.");
  const ifMatch = update && revision ? quotedRevision(revision) : undefined;
  requireFlagValue(args, "name", "Lobby board");
  const name = flagString(args.flags, "name");
  const nameHeaders = applicationNameHeaders(name);
  const root = await requireAppDirectory(runtime, dir, update ? `app update ${id} ./DIRECTORY` : "app upload ./DIRECTORY");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const capabilitiesResponse = await client.call({ method: "GET", path: "/api/capabilities" });
  const capabilities = capabilitiesResponse.body as Capabilities;
  const packed = await packDirectory(root, {
    limits: limitsFromCapabilities(capabilities),
    logger: loggerOf(runtime),
  });
  // Where the server takes them, the archive goes straight to the object
  // store (declare, signed PUT, commit), so a slow uplink is not cut off by
  // the API's proxy. Older servers take the streamed POST.
  const { accepted: body, response } = directApplicationUploads(capabilities)
    ? await uploadApplicationDirect({
      runtime, client, packed, sdkVersion: SDK_PROTOCOL_VERSION,
      ...(update ? { applicationId: id! } : {}),
      ...(ifMatch ? { ifMatch } : {}),
      ...(name !== undefined ? { name: normalizeApplicationName(name) } : {}),
    })
    : await client.call({
      method: "POST",
      path: update ? `/api/applications/${encodeURIComponent(id!)}/releases` : "/api/applications",
      idempotent: true,
      headers: {
        "content-type": "application/gzip",
        "screenrig-archive-sha256": packed.sha256,
        "screenrig-expanded-bytes": String(packed.expanded_bytes),
        "screenrig-file-count": String(packed.file_count),
        "screenrig-sdk-version": SDK_PROTOCOL_VERSION,
        ...(ifMatch ? { "if-match": ifMatch } : {}),
        ...nameHeaders,
      },
      body: packed.archive,
    }).then((streamed) => ({ accepted: streamed.body as OperationAccepted, response: streamed }));
  const operation = !flagBool(args.flags, "no-wait") && body.operation_id
    ? await client.waitForOperation(body.operation_id, {
      timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
      pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
      sleep: runtime.sleep,
    })
    : null;
  return {
    // The accepted body, whichever way the archive traveled: a direct upload's
    // commit answers the operation, not the accepted application.
    envelope: jsonBody({ body, headers: response.headers }, client.requestId, {
      // Keep the historical flat accepted fields and sha256 as aliases while
      // exposing the same canonical paths regardless of waiting mode.
      application: body,
      operation,
      pack: { sha256: packed.sha256, file_count: packed.file_count },
      sha256: packed.sha256,
    }),
    exitCode: ExitCode.Success,
    human: humanLines(
      operation
        ? (update ? "Application release uploaded" : "Application uploaded")
        : (update ? "Application release accepted" : "Application upload accepted"),
      [
        ["application_id", body.id],
        // Application primitives use the release id, not the application id.
        ["release_id", body.release_id],
        ["operation_id", body.operation_id],
        ["state", operation?.state],
        ["sha256", packed.sha256],
      ],
    ),
  };
}
