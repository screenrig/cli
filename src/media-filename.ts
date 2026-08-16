import path from "node:path";

/**
 * Advisory filename check for `media upload`. Independent of the transcode
 * pipeline: the name is the human-readable handle, whether or not ffmpeg runs.
 */

export const GENERIC_STEMS = [
  "video",
  "movie",
  "clip",
  "output",
  "out",
  "untitled",
  "unnamed",
  "new",
  "temp",
  "tmp",
  "final",
  "export",
  "render",
  "download",
  "downloaded",
  "file",
  "media",
  "image",
  "img",
  "photo",
  "pic",
  "picture",
  "asset",
  "content",
  "sample",
  "test",
  "demo",
  "copy",
  "document",
  "recording",
  "screenshot",
  "screencast",
  "capture",
  "upload",
] as const;

export const NOISE_SUFFIXES = [
  "copy",
  "final",
  "finished",
  "new",
  "edit",
  "edited",
  "export",
  "exported",
  "render",
  "rendered",
  "draft",
  "fixed",
  "updated",
  "revised",
  "compressed",
  "converted",
  "orig",
  "original",
  "backup",
  "bak",
] as const;

/**
 * Camera, phone, and screen-capture defaults. A match only counts when the
 * remainder after the prefix is empty or is only separators, digits, dates,
 * times, and the time-connector words in REMAINDER_TIME_WORDS.
 */
export const DEVICE_PREFIXES = [
  "screen recording",
  "screen capture",
  "whatsapp video",
  "whatsapp image",
  "new project",
  "my movie",
  "screen shot",
  "screenshot",
  "screencast",
  "recording",
  "untitled",
  "document",
  "snapshot",
  "sequence",
  "capture",
  "signal",
  "record",
  "takes",
  "photo",
  "video",
  "movie",
  "clip",
  "frame",
  "scene",
  "take",
  "dscn",
  "dscf",
  "gopr",
  "img",
  "dsc",
  "vid",
  "mvi",
  "mov",
  "pxl",
  "dji",
  "wa",
  "gh",
  "gx",
] as const;

/** `P` + this many digits is a known camera default (`P1010001`). */
export const P_PREFIX_MIN_DIGITS = 7;

/** Allowed in a device-prefix remainder as part of a time phrase (`at 10.14.22`). */
export const REMAINDER_TIME_WORDS = ["at"] as const;

export const SEPARATOR_PATTERN = /[-_.+\s]+/u;

function separators(): RegExp {
  return /[-_.+\s]+/gu;
}

const GENERIC_STEM_SET = new Set<string>(GENERIC_STEMS);
const NOISE_SUFFIX_SET = new Set<string>(NOISE_SUFFIXES);
const REMAINDER_TIME_WORD_SET = new Set<string>(REMAINDER_TIME_WORDS);
const DEVICE_PREFIXES_LONGEST_FIRST = [...DEVICE_PREFIXES].sort((a, b) => b.length - a.length);

const COUNTER_PATTERN = /(?:\(\d+\)|\[\d+\])$/u;
const VERSION_TOKEN_PATTERN = /(?:^|[-_.+\s])v\d+$/iu;
const TRAILING_VERSION_PATTERN = /v\d+$/iu;
const TRAILING_DIGITS_PATTERN = /\d+$/u;
const TRAILING_SEPARATORS_PATTERN = /[-_.+\s]+$/u;
const LETTER_PATTERN = /\p{L}/u;
const NON_ALNUM_PATTERN = /[^\p{L}\p{N}]/gu;
const PURE_DIGITS_PATTERN = /^\d+$/u;
const BARE_DATE_OR_TIMESTAMP_PATTERN =
  /^(?:\d{4}|\d{8}|\d{4}[-_]\d{2}[-_]\d{2})(?:[-_.+\s]+(?:\d{6}|\d{2}[-_.]\d{2}[-_.]\d{2}))?$/u;
const CAMEL_LOWER_TO_UPPER = /(\p{Ll})(\p{Lu})/gu;
const CAMEL_ACRONYM_TO_WORD = /(\p{Lu})(\p{Lu}\p{Ll})/gu;

const WARNING_SUFFIX =
  " carries little information. The filename is how people identify this media in listings, playlists, and playback reports, so ask for a distinctive name and upload again if that matters.";

function stemOf(filename: string): string {
  const base = path.basename(filename);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function collapseSeparators(value: string): string {
  return value.replace(separators(), (run) => run[0] ?? "");
}

function canonicalizeSeparators(value: string): string {
  return value.replace(separators(), " ").trim();
}

function stripTrailingNoiseOnce(value: string): string {
  let next = value;
  if (COUNTER_PATTERN.test(next)) {
    next = next.replace(COUNTER_PATTERN, "");
  } else if (VERSION_TOKEN_PATTERN.test(next)) {
    next = next.replace(TRAILING_VERSION_PATTERN, "");
  } else if (TRAILING_DIGITS_PATTERN.test(next)) {
    next = next.replace(TRAILING_DIGITS_PATTERN, "");
  } else {
    for (const suffix of NOISE_SUFFIXES) {
      const noise = new RegExp(`(?:^|[-_.+\\s])${suffix}$`, "iu");
      if (noise.test(next)) {
        next = next.slice(0, next.length - suffix.length);
        break;
      }
    }
  }
  return next.replace(TRAILING_SEPARATORS_PATTERN, "");
}

function stripTrailingNoise(value: string): string {
  let current = value;
  for (;;) {
    const next = stripTrailingNoiseOnce(current);
    if (next === current) return current;
    current = next;
  }
}

function isBareDateOrDigits(core: string): boolean {
  if (LETTER_PATTERN.test(core)) return false;
  if (PURE_DIGITS_PATTERN.test(core)) return true;
  return BARE_DATE_OR_TIMESTAMP_PATTERN.test(core);
}

function alphanumericLength(core: string): number {
  return core.replace(NON_ALNUM_PATTERN, "").length;
}

function tokensOf(value: string): string[] {
  const withCamelBreaks = value
    .replace(CAMEL_LOWER_TO_UPPER, "$1\0$2")
    .replace(CAMEL_ACRONYM_TO_WORD, "$1\0$2");
  return withCamelBreaks
    .split(separators())
    .flatMap((part) => part.split("\0"))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

function isUninformativeToken(token: string): boolean {
  return GENERIC_STEM_SET.has(token) || NOISE_SUFFIX_SET.has(token) || isBareDateOrDigits(token);
}

function remainderIsDigitsDatesTimes(remainder: string): boolean {
  const tokens = canonicalizeSeparators(remainder)
    .split(" ")
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every((token) => PURE_DIGITS_PATTERN.test(token) || REMAINDER_TIME_WORD_SET.has(token));
}

function remainderAfterPrefix(canonical: string, prefix: string): string | null {
  if (canonical === prefix) return "";
  if (canonical.startsWith(`${prefix} `)) return canonical.slice(prefix.length + 1);
  if (canonical.startsWith(prefix) && PURE_DIGITS_PATTERN.test(canonical.slice(prefix.length, prefix.length + 1))) {
    return canonical.slice(prefix.length);
  }
  return null;
}

function matchesDevicePrefix(core: string): boolean {
  const canonical = canonicalizeSeparators(core);
  for (const prefix of DEVICE_PREFIXES_LONGEST_FIRST) {
    const remainder = remainderAfterPrefix(canonical, prefix);
    if (remainder !== null && remainderIsDigitsDatesTimes(remainder)) return true;
  }
  const pRemainder = remainderAfterPrefix(canonical, "p");
  if (pRemainder !== null && remainderIsDigitsDatesTimes(pRemainder)) {
    const digits = pRemainder.replace(/\D/gu, "");
    if (digits.length >= P_PREFIX_MIN_DIGITS) return true;
  }
  return false;
}

export function lowInformationFilenameWarning(filename: string): string | null {
  const collapsed = collapseSeparators(stemOf(filename).trim());
  const stripped = stripTrailingNoise(collapsed);
  const core = stripped.toLowerCase();
  const warning = `Filename "${filename}"${WARNING_SUFFIX}`;

  if (core.length === 0) return warning;
  if (GENERIC_STEM_SET.has(core)) return warning;
  if (isBareDateOrDigits(core)) return warning;
  if (alphanumericLength(core) <= 2) return warning;
  if (matchesDevicePrefix(core)) return warning;
  const tokens = tokensOf(stripped);
  if (tokens.length > 0 && tokens.every(isUninformativeToken)) return warning;
  return null;
}
