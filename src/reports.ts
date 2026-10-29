import { flagBool, flagString } from "./command-input.js";
import type { ParsedArgs } from "./command-input.js";
import { usageError } from "./problems.js";
import { table } from "./webhooks.js";

/** The report kinds GET /api/reports lists. */
export const REPORT_KINDS = ["fleet_health", "uptime", "publishing", "alerts", "alert_log", "proof_of_play"] as const;
export const REPORT_GROUPINGS = ["folder", "screen", "tag"] as const;
export const REPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export const REPORT_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const REPORT_SUBSCRIPTION_FORMATS = ["pdf", "xlsx", "csv"] as const;
export const REPORT_SUBSCRIPTIONS_MAX = 50;
export const REPORT_RECIPIENTS_MAX = 25;

const KIND_PATTERN = /^[a-z][a-z_]{1,40}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUBSCRIPTION_ID_PATTERN = /^(?:(?:stage|qa|development)_)?rsub_[A-Za-z0-9_-]{16,24}$/;

export function reportKind(value: string | undefined, command: string): string {
  if (!value || !KIND_PATTERN.test(value)) {
    throw usageError(`${command} requires a report kind such as fleet_health, uptime, publishing, alerts, alert_log or proof_of_play.`, {
      command: "screenrig reports list",
      reason: "List the report kinds and the filters each takes.",
    });
  }
  return value;
}

export function reportSubscriptionId(value: string | undefined, command: string): string {
  if (!value) throw usageError(`reports subscriptions ${command} requires <id>.`);
  if (!SUBSCRIPTION_ID_PATTERN.test(value)) {
    throw usageError("A report subscription id looks like rsub_ followed by 16 to 24 letters, digits, - or _.", {
      command: "screenrig reports subscriptions list",
      reason: "List this project's report subscriptions and their ids.",
    });
  }
  return value;
}

/** A UTC calendar day, YYYY-MM-DD. */
export function reportDay(flag: string) {
  return (value: string): string => {
    const ms = DAY_PATTERN.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw usageError(`${flag} must be a UTC calendar day as YYYY-MM-DD.`);
    return value;
  };
}

/** The query of `reports show`: only what the flags name. */
export function reportQuery(args: ParsedArgs): Record<string, string | undefined> {
  return {
    from: flagString(args.flags, "from"),
    to: flagString(args.flags, "to"),
    group_by: flagString(args.flags, "group-by"),
    folder_id: flagString(args.flags, "folder-id"),
    direct: flagBool(args.flags, "direct") ? "true" : undefined,
    tag: flagString(args.flags, "tag"),
    campaign_id: flagString(args.flags, "campaign-id"),
    advertiser: flagString(args.flags, "advertiser"),
  };
}

interface ReportColumn { key: string; label: string; type: string }
interface ReportTable {
  title?: string; subtitle?: string; from?: string; to?: string; truncated?: boolean; notes?: string[];
  columns?: ReportColumn[]; rows?: Array<Record<string, unknown>>; totals?: Record<string, unknown>;
}

function cell(column: ReportColumn, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return column.type === "percent" || column.type === "hours" ? value.toFixed(2) : String(value);
  return String(value);
}

/** A report as a text table, its totals last. */
export function reportTableLines(report: ReportTable | undefined): string[] {
  const columns = report?.columns ?? [];
  const rows = report?.rows ?? [];
  const lines = [report?.title ?? "Report"];
  if (report?.subtitle) lines.push(report.subtitle);
  else if (report?.from && report?.to) lines.push(`${report.from} to ${report.to}`);
  if (columns.length === 0) return lines;
  const body = rows.map((row) => columns.map((column) => cell(column, row[column.key])));
  if (report?.totals && Object.keys(report.totals).length > 0) {
    body.push(columns.map((column, index) => (index === 0 && report.totals?.[column.key] == null ? "Total" : cell(column, report.totals?.[column.key]))));
  }
  lines.push(...table(columns.map((column) => column.label), body));
  if (rows.length === 0) lines.push("Nothing to report for this period.");
  for (const note of report?.notes ?? []) lines.push(note);
  if (report?.truncated) lines.push("The report shows only its first rows.");
  return lines;
}

/** Catalog lines of `reports list`. */
export function reportCatalogLines(catalog: { items?: Array<{ kind: string; title: string; description: string; params: Array<{ name: string; description: string }> }>; formats?: string[] } | undefined): string[] {
  const lines = ["Reports"];
  for (const item of catalog?.items ?? []) {
    lines.push(`${item.kind}: ${item.title}`, `  ${item.description}`, `  filters: ${item.params.map((param) => param.name).join(", ")}`);
  }
  if (catalog?.formats?.length) lines.push(`formats: ${catalog.formats.join(", ")} (reports show KIND --format xlsx --output report.xlsx)`);
  return lines;
}

/** --recipients: user ids or email addresses of project members, comma-separated. */
export function reportRecipients(value: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > REPORT_RECIPIENTS_MAX || new Set(entries.map((entry) => entry.toLowerCase())).size !== entries.length || entries.some((entry) => entry.length > 254)) {
    throw usageError(`--recipients takes 1 to ${REPORT_RECIPIENTS_MAX} different project members, comma-separated: a user id or the email address of a member.`);
  }
  return entries;
}

/** Repeatable --filter NAME=VALUE: the report's filters other than the days. */
export function reportFilter(value: string, previous?: string): string {
  const separator = value.indexOf("=");
  const name = value.slice(0, separator);
  if (separator < 1 || !/^[a-z_]{1,40}$/.test(name) || value.length - separator - 1 > 200) {
    throw usageError("--filter takes NAME=VALUE, such as --filter folder_id=sfd_ID or --filter group_by=screen.");
  }
  return previous ? `${previous}\n${value}` : value;
}

export function reportFilters(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const filters: Record<string, string> = {};
  for (const entry of raw.split("\n")) {
    const separator = entry.indexOf("=");
    filters[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return filters;
}

/** The schedule members the flags name, or undefined when none. */
export function reportSchedule(args: ParsedArgs): Record<string, unknown> | undefined {
  const cadence = flagString(args.flags, "cadence");
  const weekday = flagString(args.flags, "weekday");
  const dayOfMonth = flagString(args.flags, "day-of-month");
  const hour = flagString(args.flags, "hour");
  const timezone = flagString(args.flags, "timezone");
  if ([cadence, weekday, dayOfMonth, hour, timezone].every((member) => member === undefined)) return undefined;
  const schedule: Record<string, unknown> = {};
  if (cadence !== undefined) schedule.cadence = cadence;
  if (weekday !== undefined) schedule.weekday = weekday;
  if (dayOfMonth !== undefined) schedule.day_of_month = Number(dayOfMonth);
  if (hour !== undefined) schedule.hour = Number(hour);
  if (timezone !== undefined) schedule.timezone = timezone;
  return schedule;
}

interface Subscription {
  id?: string; name?: string; kind?: string; format?: string; enabled?: boolean; filters?: Record<string, string>;
  schedule?: { cadence?: string; weekday?: string; day_of_month?: number; hour?: number; timezone?: string };
  recipients?: Array<{ user_id: string }>; next_run_at?: string | null; last_run_at?: string | null; last_status?: string; last_error?: string;
  last_delivered?: number; last_from?: string; last_to?: string; revision?: number;
}

export function scheduleText(schedule: Subscription["schedule"]): string {
  if (!schedule) return "";
  const when = schedule.cadence === "weekly" ? `weekly on ${schedule.weekday ?? "monday"}` : schedule.cadence === "monthly" ? `monthly on day ${schedule.day_of_month ?? 1}` : "daily";
  return `${when} at ${String(schedule.hour ?? 0).padStart(2, "0")}:00 ${schedule.timezone ?? "UTC"}`;
}

export function subscriptionLines(subscription: Subscription | undefined): string[] {
  if (!subscription) return ["No report subscription"];
  const lines = [
    `${subscription.name ?? ""} (${subscription.id ?? ""})`,
    `  report: ${subscription.kind ?? ""} as ${subscription.format ?? ""}${subscription.enabled === false ? " (paused)" : ""}`,
    `  schedule: ${scheduleText(subscription.schedule)}`,
    `  recipients: ${(subscription.recipients ?? []).map((recipient) => recipient.user_id).join(", ")}`,
  ];
  if (subscription.filters && Object.keys(subscription.filters).length > 0) {
    lines.push(`  filters: ${Object.entries(subscription.filters).map(([name, value]) => `${name}=${value}`).join(" ")}`);
  }
  if (subscription.next_run_at) lines.push(`  next run: ${subscription.next_run_at}`);
  if (subscription.last_status) {
    lines.push(`  last run: ${subscription.last_status}${subscription.last_run_at ? ` at ${subscription.last_run_at}` : ""}${subscription.last_from ? ` for ${subscription.last_from} to ${subscription.last_to}` : ""}`);
    if (subscription.last_status === "failed" && subscription.last_error) lines.push(`  failure: ${subscription.last_error}`);
    if (subscription.last_status === "delivered") lines.push(`  mailed: ${subscription.last_delivered ?? 0} member${subscription.last_delivered === 1 ? "" : "s"}`);
  }
  return lines;
}

export function subscriptionListLines(items: Subscription[] | undefined): string[] {
  if (!items?.length) return ["No report subscriptions"];
  return table(["ID", "NAME", "REPORT", "SCHEDULE", "FORMAT", "NEXT_RUN", "LAST"], items.map((item) => [
    item.id ?? "", item.name ?? "", item.kind ?? "", scheduleText(item.schedule), item.format ?? "", item.enabled === false ? "(paused)" : item.next_run_at ?? "", item.last_status ?? "",
  ]));
}
