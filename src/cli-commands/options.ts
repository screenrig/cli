import { Option } from "commander";
import { isResourceID } from "../generated/resource-ids.js";
import { quotedRevision } from "../if-match.js";
import { usageError } from "../problems.js";
import { screenTag, screenTagList } from "../screen-fleet.js";
import { decisionNote, reviewNote } from "../reviews.js";

export function nonnegativeInteger(name: string): (value: string) => string {
  return (value) => {
    const number = Number(value);
    if (!value.trim() || !Number.isSafeInteger(number) || number < 0) {
      throw usageError(`--${name} requires a nonnegative whole number.`);
    }
    return value;
  };
}

export function positiveInteger(name: string): (value: string) => string {
  const parse = nonnegativeInteger(name);
  return (value) => {
    parse(value);
    if (Number(value) === 0) throw usageError(`--${name} must be greater than zero.`);
    return value;
  };
}

export function nonnegativeNumber(name: string): (value: string) => string {
  return (value) => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0) {
      throw usageError(`--${name} requires a nonnegative number.`);
    }
    return value;
  };
}

export function positiveNumber(name: string): (value: string) => string {
  return (value) => {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number) || number < 0) {
      throw usageError(`--${name} requires a nonnegative number.`);
    }
    if (number === 0) throw usageError(`--${name} must be greater than zero.`);
    return value;
  };
}

export function toastDuration(value: string): string {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 2000 || number > 60000) {
    throw usageError("--duration-ms must be a whole number between 2000 and 60000.");
  }
  return value;
}

export function revision(value: string): string {
  quotedRevision(value);
  return value;
}

export function screenTagOption(value: string): string {
  return screenTag(value);
}

/** Validate a comma-separated tag list; the handler re-parses the same string. */
export function screenTagListOption(flag: string): (value: string) => string {
  return (value) => {
    screenTagList(value, flag);
    return value;
  };
}

/** AdvertisingSlotWrite.vast_tag_url: an HTTPS URL of at most 2048 characters; the server judges port, host and the tag itself. */
export function vastTagUrl(value: string): string {
  let protocol: string | undefined;
  try { protocol = new URL(value).protocol; } catch { /* reported below */ }
  if (protocol !== "https:" || value.length > 2048) {
    throw usageError("--vast-tag-url must be an HTTPS URL of at most 2048 characters.");
  }
  return value;
}

/** --note help on every review-class write. */
export const NOTE_HELP = "Note for the person who reviews this change when it waits for review (at most 280 characters)";

/** --note on a review-class write: at most 280 characters, sent as Screenrig-Review-Note. */
export function reviewNoteOption(value: string): string {
  return reviewNote(value);
}

/** --note on a review decision: at most 500 characters. */
export function decisionNoteOption(value: string): string {
  return decisionNote(value);
}

/** GET /api/events `type`: an exact event type, or a family prefix ending in a dot. */
export const EVENT_TYPE_FILTER_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/;

export function eventTypeOption(value: string): string {
  if (value.length > 80 || !EVENT_TYPE_FILTER_PATTERN.test(value)) {
    throw usageError("--type takes an event type such as note.added, or a family prefix ending in a dot such as note.");
  }
  return value;
}

/** Native option validation for an explicit token subset, never a permission union. */
export function projectSubset(value: string): string {
  const ids = value.split(/[\s,]+/).filter(Boolean);
  if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length || ids.some(id => !isResourceID(id, "project"))) {
    throw usageError("--projects requires 1–64 distinct project IDs separated by commas or spaces.");
  }
  return ids.join(",");
}

/** --format of a report command: json is the envelope; csv, xlsx and pdf are written to --output. */
export const reportFormatOption = (): Option => new Option("--format <FORMAT>", "json (default), or csv, xlsx or pdf written to --output").choices(["json", "csv", "xlsx", "pdf"]);
export const reportOutputOption = (name = "NAME.FORMAT"): Option => new Option("--output <FILE>", `File to write with --format csv, xlsx or pdf (default ./${name})`);
