import { flagString } from "./command-input.js";
import type { ParsedArgs } from "./command-input.js";
import { usageError } from "./problems.js";
import { table } from "./webhooks.js";

export const AUDIT_ACTOR_KINDS = ["person", "agent", "service_client", "staff", "system"] as const;
export const AUDIT_SOURCES = ["dashboard", "api", "cli", "mcp", "staff", "device", "webhook", "system"] as const;

const ID_PATTERN = /^(?:(?:stage|qa|development)_)?aud_[A-Za-z0-9_-]{1,100}$/;
const ANCHOR_PATTERN = /^\d{1,18}:[0-9a-f]{64}$/;
const ACTION_PATTERN = /^[a-z_.]{1,64}\*?$/;

export function auditId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`audit ${command} requires <id>.`);
  if (!ID_PATTERN.test(value)) {
    throw usageError("An audit entry id looks like aud_ followed by letters, digits, - or _.", {
      command: "screenrig audit list",
      reason: "List the project's audit entries and their ids.",
    });
  }
  return value;
}

/** --since and --until: an RFC 3339 instant with a zone. */
export function auditInstant(flag: string) {
  return (value: string): string => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
      throw usageError(`${flag} must be an RFC 3339 instant with a zone, such as 2026-10-01T00:00:00Z.`);
    }
    return value;
  };
}

export function auditAction(value: string): string {
  if (!ACTION_PATTERN.test(value)) throw usageError("--action is a code such as screen.update, or a prefix ending in * such as playlist.*.");
  return value;
}

export function auditField(value: string): string {
  if (!value.startsWith("/") || value.length > 200) throw usageError("--field is a JSON Pointer such as /label or /fields/room.");
  return value;
}

export function auditAnchor(value: string): string {
  if (!ANCHOR_PATTERN.test(value)) throw usageError("--anchor is SEQ:HASH, the chain head an export or `audit head` printed.");
  return value;
}

/** The query of the list and export commands: only what the flags name. */
export function auditQuery(args: ParsedArgs): Record<string, string | undefined> {
  return {
    actor: flagString(args.flags, "actor"),
    actor_kind: flagString(args.flags, "actor-kind"),
    source: flagString(args.flags, "source"),
    resource_type: flagString(args.flags, "resource-type"),
    resource_id: flagString(args.flags, "resource-id"),
    action: flagString(args.flags, "action"),
    field: flagString(args.flags, "field"),
    since: flagString(args.flags, "since"),
    until: flagString(args.flags, "until"),
    cursor: flagString(args.flags, "after"),
    limit: flagString(args.flags, "limit"),
  };
}

interface AuditChange { path: string; before: unknown; after: unknown; redacted?: boolean }
export interface AuditEntry {
  id?: string; at?: string; actor?: { kind?: string; id?: string; name?: string }; approved_by?: { kind?: string; id?: string; name?: string };
  review_id?: string; source?: string; action?: string; resource?: { type?: string; id?: string; name?: string }; changes?: AuditChange[];
  revision?: { type?: string; id?: string; before?: number; after?: number }; truncated?: boolean; unrecorded?: boolean;
  request_id?: string; route?: string; client?: { kind?: string; version?: string }; client_ip?: string; seq?: number; hash?: string; event_sequence?: number;
}

const actorText = (actor: AuditEntry["actor"]): string => (actor?.name ? `${actor.name} (${actor.kind ?? ""})` : `${actor?.id ?? ""} (${actor?.kind ?? ""})`);
const valueText = (value: unknown): string => (value === null || value === undefined ? "(none)" : typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value));

export function auditListLines(items: AuditEntry[] | undefined, next: string | null | undefined): string[] {
  if (!items?.length) return ["No audit entries"];
  const lines = table(["TIME", "ACTOR", "SOURCE", "ACTION", "RESOURCE", "CHANGES", "ID"], items.map((item) => [
    item.at ?? "", actorText(item.actor), item.source ?? "", item.action ?? "",
    `${item.resource?.type ?? ""} ${item.resource?.id ?? ""}${item.resource?.name ? ` ${item.resource.name}` : ""}`.trim(),
    item.unrecorded ? "(not recorded)" : String(item.changes?.length ?? 0), item.id ?? "",
  ]));
  if (next) lines.push("", `More: --after ${next}`);
  return lines;
}

/** One entry with every field's before and after. */
export function auditEntryLines(entry: AuditEntry | undefined): string[] {
  if (!entry) return ["No audit entry"];
  const lines = [
    `${entry.action ?? ""} on ${entry.resource?.type ?? ""} ${entry.resource?.id ?? ""}${entry.resource?.name ? ` (${entry.resource.name})` : ""}`,
    `  ${entry.id ?? ""} at ${entry.at ?? ""}`,
    `  by ${actorText(entry.actor)} through ${entry.source ?? ""}${entry.client?.kind ? ` (${entry.client.kind}${entry.client.version ? ` ${entry.client.version}` : ""})` : ""}${entry.client_ip ? ` from ${entry.client_ip}` : ""}`,
  ];
  if (entry.approved_by) lines.push(`  approved by ${actorText(entry.approved_by)}${entry.review_id ? ` in review ${entry.review_id}` : ""}`);
  if (entry.request_id) lines.push(`  request ${entry.request_id}${entry.route ? ` (${entry.route})` : ""}`);
  if (entry.revision) lines.push(`  ${entry.revision.type ?? "revision"} ${entry.revision.id ?? ""} ${entry.revision.before ?? ""} -> ${entry.revision.after ?? ""}`.replace(/\s+/g, " ").replace(/^ /, "  "));
  if (entry.unrecorded) lines.push("  The change was made; its values were not recorded.");
  for (const change of entry.changes ?? []) {
    lines.push(`  ${change.path}${change.redacted ? " (redacted)" : ""}`, `    before: ${valueText(change.before)}`, `    after:  ${valueText(change.after)}`);
  }
  if (entry.truncated) lines.push("  More fields changed than an entry keeps.");
  if (entry.seq) lines.push(`  chain ${entry.seq} ${entry.hash ?? ""}`);
  else lines.push("  waiting to be chained");
  return lines;
}

interface AuditHeadBody { scope?: string; seq?: number; hash?: string; floor_seq?: number; floor_hash?: string; unsealed?: number; sealed_through?: string; oldest_retained_seq?: number }

export function auditHeadLines(head: AuditHeadBody | undefined): string[] {
  if (!head) return ["No audit chain head"];
  return [
    `Audit chain of ${head.scope ?? ""}`,
    `  head: ${head.seq ?? 0}:${head.hash ?? ""}`,
    `  retention floor: ${head.floor_seq ?? 0}:${head.floor_hash ?? ""} (oldest kept entry ${head.oldest_retained_seq ?? 1})`,
    `  waiting to be chained: ${head.unsealed ?? 0}${head.sealed_through ? `, chained through ${head.sealed_through}` : ""}`,
    "  Keep the head as an anchor: screenrig audit verify --anchor SEQ:HASH proves nothing before it was rewritten or removed.",
  ];
}

interface AuditVerifyBody { ok?: boolean; checked?: number; first_seq?: number; last_seq?: number; next_seq?: number; head?: AuditHeadBody; problems?: Array<{ seq: number; code: string; detail: string }> }

export function auditVerifyLines(result: AuditVerifyBody | undefined): string[] {
  if (!result) return ["No verification result"];
  const lines = [result.ok ? `Verified ${result.checked ?? 0} entries (${result.first_seq ?? 0} to ${result.last_seq ?? 0}). The chain is intact.` : `The audit chain does not verify (${result.problems?.length ?? 0} problems in ${result.checked ?? 0} entries checked).`];
  for (const problem of result.problems ?? []) lines.push(`  ${problem.seq}: ${problem.code} - ${problem.detail}`);
  if (result.next_seq) lines.push(`More entries follow: screenrig audit verify --from-seq ${result.next_seq}`);
  if (result.head?.unsealed) lines.push(`${result.head.unsealed} newer entries are waiting to be chained.`);
  return lines;
}
