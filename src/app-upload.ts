import type {
  ApplicationUploadCommit,
  ApplicationUploadDeclaration,
  ApplicationUploadSession,
  Capabilities,
  OperationAccepted,
} from "./adapters/protocol.js";
import type { ApiClient } from "./client.js";
import { performSignedBodyPut, validateMediaUploadSession } from "./media-upload.js";
import { CliError, usageError } from "./problems.js";
import { fetchSignedRawPut, type CliRuntime } from "./runtime.js";
import type { TransportResponse } from "./transport/types.js";

/** The capabilities feature of a server that takes direct application uploads. */
export function directApplicationUploads(capabilities: Capabilities | undefined): boolean {
  return capabilities?.features?.application_direct_uploads === true;
}

export interface DirectApplicationUpload {
  runtime: CliRuntime;
  client: ApiClient;
  /** Set for app update: the release goes to this application. */
  applicationId?: string;
  /** Quoted revision guard for app update. */
  ifMatch?: string;
  /** Normalized name of a new application. */
  name?: string;
  sdkVersion: string;
  packed: { archive: Uint8Array; sha256: string; compressed_bytes: number; expanded_bytes: number; file_count: number };
}

/** How often a commit is sent before its failure is reported: the archive is already uploaded by then. */
const COMMIT_ATTEMPTS = 4;

/**
 * Declare, signed PUT and commit, the way media uploads travel. The archive
 * goes to the object store, never through the API, whose proxy ends a request
 * it has not answered within about 100 seconds; the signed PUT only has to
 * start while its URL is valid. Answers the same accepted body the streamed
 * POST does, with the commit's response.
 */
export async function uploadApplicationDirect(input: DirectApplicationUpload): Promise<{ accepted: OperationAccepted; response: TransportResponse }> {
  const { runtime, client, packed } = input;
  const declaration: ApplicationUploadDeclaration = {
    ...(input.name ? { name: input.name } : {}),
    sha256: packed.sha256,
    compressed_bytes: packed.compressed_bytes,
    expanded_bytes: packed.expanded_bytes,
    file_count: packed.file_count,
    sdk_version: input.sdkVersion,
  };
  const declared = await client.call({
    method: "POST",
    path: input.applicationId ? `/api/applications/${encodeURIComponent(input.applicationId)}/uploads` : "/api/applications/uploads",
    idempotent: true,
    ...(input.ifMatch ? { headers: { "if-match": input.ifMatch } } : {}),
    body: declaration,
  });
  if (declared.headers["cache-control"] !== "private, no-store") {
    throw usageError("Application upload declaration did not return the required private, no-store cache policy.");
  }
  const body = declared.body as ApplicationUploadSession;
  const session = validateMediaUploadSession(body, runtime.now().getTime(), "Application upload");
  if (typeof body.application_id !== "string" || !body.application_id || typeof body.release_id !== "string" || !body.release_id) {
    throw usageError("Application upload declaration returned an invalid binding.");
  }
  await performSignedBodyPut(packed.archive, session, runtime.signedRawPut ?? fetchSignedRawPut(), "Application package upload");
  const commit: ApplicationUploadCommit = { sha256: packed.sha256, compressed_bytes: packed.compressed_bytes };
  const response = await commitUpload(client, runtime, session.id, commit);
  return {
    accepted: { id: body.application_id, release_id: body.release_id, operation_id: session.operationId },
    response,
  };
}

/**
 * A commit is safe to repeat: the server answers a committed upload's
 * operation again. Retry a commit the server could not answer (5xx, 429, or no
 * answer at all) rather than lose an upload that already arrived.
 */
async function commitUpload(client: ApiClient, runtime: CliRuntime, uploadId: string, commit: ApplicationUploadCommit): Promise<TransportResponse> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.call({
        method: "POST",
        path: `/api/applications/uploads/${encodeURIComponent(uploadId)}/commit`,
        idempotent: true,
        body: commit,
      });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      const { status, retry_after_seconds: after } = error.problem;
      if (attempt >= COMMIT_ATTEMPTS || !(status >= 500 || status === 429 || status === 408)) throw error;
      await runtime.sleep(typeof after === "number" && after > 0 ? Math.min(after, 30) * 1000 : 2000 * attempt);
    }
  }
}
