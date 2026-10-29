import { createHash } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ApiClient } from "./client.js";
import { flagString } from "./command-input.js";
import type { ParsedArgs } from "./command-input.js";
import { successEnvelope } from "./envelope.js";
import { usageError, unexpectedResponseError } from "./problems.js";
import { openTempFile } from "./temp-file.js";

/** The formats a report is written in: json is the envelope, the rest are files. */
export const REPORT_FORMATS = ["json", "csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const CONTENT_TYPES: Record<Exclude<ReportFormat, "json">, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** --format as given: json when absent. */
export function reportFormat(args: ParsedArgs): ReportFormat {
  const value = flagString(args.flags, "format") ?? "json";
  if (!(REPORT_FORMATS as readonly string[]).includes(value)) throw usageError("--format must be json, csv, xlsx or pdf.");
  return value as ReportFormat;
}

/** The formats this CLI writes itself by asking the server for the file. */
export function wantsReportFile(format: ReportFormat, nativeCsv = false): format is Exclude<ReportFormat, "json"> {
  return format !== "json" && !(nativeCsv && format === "csv");
}

export interface ReportFileRequest {
  path: string;
  query?: Record<string, string | undefined>;
  format: Exclude<ReportFormat, "json">;
  /** --output: a file path; - writes the file to stdout. Defaults to ./<stem>.<format>. */
  output: string | undefined;
  stem: string;
  cwd: string;
  /** What the file is, for refusals. */
  what: string;
}

/** Where a download goes: the --output path, never a directory, else ./<stem>.<format>. */
export async function reportOutputPath(request: Pick<ReportFileRequest, "output" | "stem" | "format" | "cwd">): Promise<string> {
  const relative = request.output ?? `./${request.stem}.${request.format}`;
  if (relative.endsWith("/") || relative.endsWith("\\")) throw usageError("--output must be a file path, not a directory.");
  const target = path.resolve(request.cwd, relative);
  const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw usageError("--output must be a file path, not a directory.");
  });
  if (existing?.isDirectory()) throw usageError("--output must be a file path, not a directory.");
  return target;
}

export interface ReportFile {
  path: string;
  bytes: number;
  sha256: string;
  content_type: string;
  format: string;
  requestId: string | undefined;
}

/** A GET answered as a file: where it goes, and the media type it must have. */
export interface FileDownload {
  path: string;
  query?: Record<string, string | undefined>;
  target: string;
  contentType: string;
  what: string;
}

/**
 * GET a file and write it to a private temp file beside the target, then an
 * atomic rename, with its SHA-256. The bytes never reach the envelope or the log.
 */
export async function downloadToFile(client: ApiClient, request: FileDownload): Promise<ReportFile> {
  const response = await client.download({ method: "GET", path: request.path, query: request.query });
  const type = (response.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type !== request.contentType) {
    await response.body?.cancel?.();
    throw unexpectedResponseError(`The ${request.what} export answered ${type || "without a Content-Type"}, not ${request.contentType}.`, response.headers["x-request-id"]);
  }
  if (!response.body) throw unexpectedResponseError(`The ${request.what} export returned no body.`, response.headers["x-request-id"]);
  const temp = await openTempFile(request.target);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await temp.handle.write(chunk, offset, chunk.byteLength - offset);
        offset += result.bytesWritten;
      }
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    await temp.handle.sync();
    await temp.handle.close();
    await rename(temp.path, request.target);
  } catch (error) {
    await temp.handle.close().catch(() => undefined);
    await rm(temp.path, { force: true });
    throw error;
  } finally {
    temp.release();
  }
  return { path: request.target, bytes, sha256: hash.digest("hex"), content_type: request.contentType, format: "", requestId: response.headers["x-request-id"] };
}

/** Ask the server for a report as a file (the route's format member) and save it. */
export async function downloadReportFile(client: ApiClient, request: ReportFileRequest): Promise<ReportFile> {
  const target = await reportOutputPath(request);
  const file = await downloadToFile(client, {
    path: request.path, query: { ...request.query, format: request.format }, target, contentType: CONTENT_TYPES[request.format], what: request.what,
  });
  return { ...file, format: request.format };
}

/** The envelope and text of a written report file. */
export function reportFileResult(file: ReportFile, extra: Record<string, unknown> = {}): { envelope: ReturnType<typeof successEnvelope<unknown>>; human: string } {
  const data = { path: file.path, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, format: file.format, ...extra };
  return {
    envelope: successEnvelope(data, { request_id: file.requestId }),
    human: [`Report written: ${file.path}`, `  format: ${file.format}`, `  bytes: ${file.bytes}`, `  sha256: ${file.sha256}`].join("\n"),
  };
}
