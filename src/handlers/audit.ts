// Command handlers for the audit commands, loaded on demand.
import { flagString } from "../command-input.js";
import { requireToken } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { auditAnchor, auditEntryLines, auditHeadLines, auditId, auditListLines, auditQuery, auditVerifyLines } from "../audit.js";
import { clientFor, commandHandler, jsonBody, reportFileOf } from "../commands.js";
import { usageError } from "../problems.js";

// The audit log: GET /api/audit lists the project's configuration changes with
// their field-level before and after, and writes them as CSV, XLSX or PDF.
// GET /api/audit/verify recomputes the hash chain.
export const AUDIT_PATH = "/api/audit";

export const handleAuditList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: AUDIT_PATH, query: auditQuery(args) });
  const body = response.body as { items?: Parameters<typeof auditListLines>[0]; next_cursor?: string | null } | undefined;
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: auditListLines(body?.items, body?.next_cursor).join("\n") };
});

export const handleAuditShow = commandHandler(async (args, runtime, resolved) => {
  const id = auditId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${AUDIT_PATH}/${id}` });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: auditEntryLines(response.body as Parameters<typeof auditEntryLines>[0]).join("\n") };
});

export const handleAuditHead = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${AUDIT_PATH}/head` });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: auditHeadLines(response.body as Parameters<typeof auditHeadLines>[0]).join("\n") };
});

export const handleAuditVerify = commandHandler(async (args, runtime, resolved) => {
  const anchor = flagString(args.flags, "anchor");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "GET", path: `${AUDIT_PATH}/verify`,
    query: { from_seq: flagString(args.flags, "from-seq"), limit: flagString(args.flags, "limit"), anchor: anchor === undefined ? undefined : auditAnchor(anchor) },
  });
  const body = response.body as Parameters<typeof auditVerifyLines>[0];
  return { envelope: jsonBody(response, client.requestId), exitCode: body?.ok === false ? ExitCode.OperationFailed : ExitCode.Success, human: auditVerifyLines(body).join("\n") };
});

export const handleAuditExport = commandHandler(async (args, runtime, resolved) => {
  if (flagString(args.flags, "format") === undefined || flagString(args.flags, "format") === "json") {
    throw usageError("audit export writes a file: give --format csv, xlsx or pdf (audit list prints the entries as JSON).");
  }
  const query = auditQuery(args);
  query.limit = undefined;
  const file = await reportFileOf(args, runtime, resolved, AUDIT_PATH, query, `audit-log${query.until ? `-${query.until.slice(0, 10)}` : ""}`, "audit log");
  if (!file) throw usageError("audit export writes a file: give --format csv, xlsx or pdf.");
  return file;
});
