import { vendorBadResponse } from "../http.js";

/**
 * Reading the JSON a signage system's API sends: every value arrives as unknown,
 * and a missing or odd one is a gap, never a guess. Shared by the Xibo and Yodeck
 * adapters.
 */

export type Row = Record<string, unknown>;

export const asRow = (value: unknown): Row => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
export const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(asRow) : []);
export const text = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
export const flag = (value: unknown): boolean => value === true || value === 1 || value === "1";

export function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** The id a row carries in `field`, as a string. A row without one is a bad answer; the detail names the field, never the body. */
export function idOf(vendor: string, row: Row, field: string, where: string): string {
  const value = row[field];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  throw vendorBadResponse(vendor, `${where} has a row without ${field}`);
}

/** A time zone name as this runtime spells it, or undefined when it does not know the name. */
export function zoneOf(value: unknown): string | undefined {
  const name = text(value);
  if (name === "") return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
