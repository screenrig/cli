// Command handlers for the billing commands, loaded on demand.
import { flagString } from "../command-input.js";
import { requireToken } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { successEnvelope } from "../envelope.js";
import { formatMcrAsDollars } from "../money.js";
import type { ProjectBillingUsage } from "../adapters/protocol.js";
import { clientFor, commandHandler, humanLines, jsonBody, requirePrivateNoStore, simpleGet } from "../commands.js";


/**
 * What this organization's plan allows: stored bytes of the storage limit and
 * the agent requests an hour (`allowance.requests_per_hour`). Requests are never
 * charged, so there is no money or monthly meter here.
 */
export const handleBillingUsage = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/billing/usage" });
  requirePrivateNoStore(response.headers, "Billing usage response");
  const body = (response.body ?? {}) as Partial<ProjectBillingUsage>;
  const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
  const allowance = {
    storage_bytes: text(body.allowance?.storage_bytes),
    requests_per_hour: text(body.allowance?.requests_per_hour),
  };
  const data = {
    stored_bytes: text(body.stored_bytes),
    allowance: Object.fromEntries(Object.entries(allowance).filter(([, value]) => value !== undefined)),
  };
  return {
    envelope: successEnvelope(data, {
      request_id: response.headers["x-request-id"] ?? client.requestId,
      warnings: response.headers.warning ? [{ code: "server_warning", message: response.headers.warning }] : [],
    }),
    exitCode: ExitCode.Success,
    human: humanLines("Plan limits", [
      ["storage", allowance.storage_bytes ? `${data.stored_bytes ?? "?"} of ${allowance.storage_bytes} bytes` : undefined],
      ["agent_requests_per_hour", allowance.requests_per_hour],
    ]),
  };
});

/**
 * Read this project's advertising amounts. Human output shows US dollars from
 * the exact mcr strings; the JSON envelope keeps every `*_mcr` member as sent.
 * Payouts start 1 January 2027 and are requested in the dashboard, never here.
 */
export const handleBillingBalance = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/billing/balance" });
  requirePrivateNoStore(response.headers, "Billing balance response");
  const body = (response.body ?? {}) as {
    remaining_mcr?: unknown; reserved_mcr?: unknown; available_mcr?: unknown;
    withdrawal?: { allowed?: unknown; eligible_earned_mcr?: unknown; blockers?: unknown };
  };
  const withdrawal = body.withdrawal ?? {};
  const blockers = Array.isArray(withdrawal.blockers) ? withdrawal.blockers.filter((item): item is string => typeof item === "string") : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Advertising amounts", [
      ["remaining", formatMcrAsDollars(body.remaining_mcr)],
      ["reserved", formatMcrAsDollars(body.reserved_mcr)],
      ["available", formatMcrAsDollars(body.available_mcr)],
      ["payable_earnings", formatMcrAsDollars(withdrawal.eligible_earned_mcr)],
      ["payout_allowed", withdrawal.allowed === undefined ? undefined : String(withdrawal.allowed)],
      ["blockers", blockers.length > 0 ? blockers.join(", ") : undefined],
      ["note", "Advertisers pay by card or x402 machine payment. Payouts start 1 January 2027 and are requested in the dashboard, not from this CLI. Amounts are US dollars."],
    ]),
  };
});

/** One posted entry as a line: sequence, time, kind and its amount in dollars. */
function statementLine(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const row = entry as Record<string, unknown>;
  const amount = formatMcrAsDollars(row.amount_mcr) ?? (typeof row.amount_usd === "string" ? `$${row.amount_usd}` : undefined);
  const parts = [row.sequence, row.occurred_at, row.kind, amount, row.category, row.source]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number");
  return parts.length > 0 ? `  ${parts.join("  ")}` : undefined;
}

export const handleBillingStatement = commandHandler(async (args, runtime, resolved) => {
  const result = await simpleGet(args, runtime, resolved, "/api/billing/statement", "Ledger statement", {
    cursor: flagString(args.flags, "cursor"),
    limit: flagString(args.flags, "limit"),
  });
  if (result.output !== undefined || !result.envelope.ok) return result;
  const data = result.envelope.data as { entries?: unknown; next_cursor?: unknown } | undefined;
  if (!Array.isArray(data?.entries)) return result;
  const lines = data.entries.map(statementLine).filter((line): line is string => line !== undefined);
  return {
    ...result,
    human: ["Ledger statement (US dollars)", ...(lines.length > 0 ? lines : ["  no entries"]),
      ...(typeof data.next_cursor === "string" && data.next_cursor !== "" ? [`next_cursor: ${data.next_cursor}`] : [])].join("\n"),
  };
});
