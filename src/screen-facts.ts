import { flagBool, flagString } from "./command-input.js";
import type { Screen, ScreenPatch } from "./adapters/protocol.js";
import { usageError } from "./problems.js";
import { plainText } from "./reviews.js";

/**
 * A screen's own facts: custom fields and a location, and the {screen.…}
 * tokens a card placement reads them through. The server checks the same
 * limits and decides; these checks keep a bad value from costing a request.
 */

type Flags = Record<string, string | boolean>;

/** Field names are token path segments: lower case letters, digits and underscores. */
export const SCREEN_FIELD_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
export const SCREEN_FIELDS_MAX = 32;
export const SCREEN_FIELD_VALUE_MAX = 200;
export const SCREEN_LOCATION_NAME_MAX = 40;
export const SCREEN_LOCATION_ADDRESS_MAX = 200;

/** As the whole value of a card's location param, the screen's location in that card's own location shape. */
export const SCREEN_LOCATION_TOKEN = "{screen.location}";
/** The text tokens any string in a card's params may carry. */
const TEXT_TOKEN = /\{screen\.(?:name|timezone|field\.[a-z0-9_]{1,32})\}/g;
/** A card data key may carry field tokens only. */
const KEY_TOKEN = /\{screen\.field\.[a-z0-9_]{1,32}\}/g;

/** The decimal grammar of the server's near parameter: no exponent, no sign but a minus. */
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const CONTROL = /\p{Cc}/u;
const characters = (value: string): number => [...value].length;

/**
 * A card param as a schema check reads it before any screen is known: every
 * text token in every string, however deep, is the letter x, the shortest
 * text a token can stand for.
 */
export function screenTextPlaceholders(value: unknown): unknown {
  if (typeof value === "string") return value.replace(TEXT_TOKEN, "x");
  if (Array.isArray(value)) return value.map(screenTextPlaceholders);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, screenTextPlaceholders(member)]));
  }
  return value;
}

/** A card data key with each {screen.field.NAME} as the letter x, to check against the key grammar. */
export function screenKeyPlaceholder(key: string): string {
  return key.replace(KEY_TOKEN, "x");
}

interface FieldEntry {
  name: string;
  value: string;
}

/** NAME=VALUE: the name before the first "=", the value trimmed. */
function fieldEntry(input: string, hint: string): FieldEntry {
  const at = input.indexOf("=");
  if (at < 0) throw usageError("--field takes NAME=VALUE, such as --field store_number=0142.");
  const name = input.slice(0, at).trim();
  if (!SCREEN_FIELD_NAME_PATTERN.test(name)) {
    throw usageError("--field takes a name of 1 to 32 lower case letters, digits or underscores, such as --field store_number=0142.");
  }
  const value = input.slice(at + 1).trim();
  if (!value || characters(value) > SCREEN_FIELD_VALUE_MAX || CONTROL.test(value)) {
    throw usageError(`--field ${name} takes a value of 1 to ${SCREEN_FIELD_VALUE_MAX} characters after trimming, without control characters.${hint}`);
  }
  return { name, value };
}

/** The entries an accumulated --field value holds. Values carry no control characters, so a newline only ever separates entries. */
function fieldEntries(accumulated: string | undefined): FieldEntry[] {
  if (accumulated === undefined) return [];
  return accumulated.split("\n").map((line) => {
    const at = line.indexOf("=");
    return { name: line.slice(0, at), value: line.slice(at + 1) };
  });
}

/** A repeatable --field: each value is checked as it is read and the entries accumulate newline-separated. */
function fieldOption(hint: string): (input: string, previous?: string) => string {
  return (input, previous) => {
    const entry = fieldEntry(input, hint);
    const held = fieldEntries(previous);
    if (held.some((item) => item.name === entry.name)) throw usageError(`--field ${entry.name} is given more than once.`);
    if (held.length >= SCREEN_FIELDS_MAX) throw usageError(`--field takes at most ${SCREEN_FIELDS_MAX} fields.`);
    return [...held, entry].map((item) => `${item.name}=${item.value}`).join("\n");
  };
}

/** screen update --field NAME=VALUE: sets one field; the screen's other fields stay. */
export const screenFieldSetOption = fieldOption(" --unset-field NAME removes a field.");
/** screen list --field NAME=VALUE: every one must match. */
export const screenFieldFilterOption = fieldOption("");
/** fleet-links create|update --field NAME=VALUE: the fields every screen the link creates starts with. */
export const fleetLinkFieldOption = fieldOption("");

/** An accumulated --field value as a name-to-value map; undefined without one. */
export function fieldMap(accumulated: string | undefined): Record<string, string> | undefined {
  if (accumulated === undefined) return undefined;
  return Object.fromEntries(fieldEntries(accumulated).map((entry) => [entry.name, entry.value]));
}

/** screen update --unset-field NAME, repeatable: names accumulate newline-separated. */
export function screenUnsetFieldOption(input: string, previous?: string): string {
  const name = input.trim();
  if (!SCREEN_FIELD_NAME_PATTERN.test(name)) {
    throw usageError("--unset-field takes a field name of 1 to 32 lower case letters, digits or underscores.");
  }
  const held = previous === undefined ? [] : previous.split("\n");
  if (held.includes(name)) throw usageError(`--unset-field ${name} is given more than once.`);
  return [...held, name].join("\n");
}

/** Comma-separated decimal numbers whose first two are a latitude and a longitude; returns them trimmed and rejoined. */
function coordinates(input: string, flag: string, shape: string, example: string, count: number): string {
  const parts = input.split(",").map((part) => part.trim());
  if (parts.length !== count || !parts.every((part) => DECIMAL.test(part))) {
    throw usageError(`${flag} takes ${shape} as decimal numbers, such as ${flag} ${example}.`);
  }
  const [latitude, longitude] = parts.map(Number) as [number, number];
  if (latitude < -90 || latitude > 90) throw usageError(`${flag} latitude must be from -90 to 90.`);
  if (longitude < -180 || longitude > 180) throw usageError(`${flag} longitude must be from -180 to 180.`);
  return parts.join(",");
}

/** screen update --location LAT,LON, in decimal degrees. */
export function screenLocationOption(input: string): string {
  return coordinates(input, "--location", "LAT,LON", "47.6062,-122.3321", 2);
}

/** screen list --near LAT,LON,KM: a point in decimal degrees and a radius in kilometres above zero. */
export function screenNearOption(input: string): string {
  const near = coordinates(input, "--near", "LAT,LON,KM", "47.6062,-122.3321,25", 3);
  if (!(Number(near.split(",")[2]) > 0)) throw usageError("--near KM must be greater than zero.");
  return near;
}

function placeText(input: string, flag: string, max: number): string {
  const value = input.trim();
  if (!value || characters(value) > max || CONTROL.test(value)) {
    throw usageError(`${flag} takes 1 to ${max} characters after trimming, without control characters.`);
  }
  return value;
}

/** screen update --location-name: the short place name a card shows. */
export function screenLocationNameOption(input: string): string {
  return placeText(input, "--location-name", SCREEN_LOCATION_NAME_MAX);
}

/** screen update --address: free text for people and agents. */
export function screenAddressOption(input: string): string {
  return placeText(input, "--address", SCREEN_LOCATION_ADDRESS_MAX);
}

/**
 * The fields and location members of a screen update. --field and
 * --unset-field build the merge object (a string sets, null removes);
 * --clear-fields is a null fields; --location replaces the whole location and
 * --clear-location is a null location. Members the flags do not name are absent.
 */
export function screenFactsPatch(flags: Flags): Pick<ScreenPatch, "fields" | "location"> {
  const set = flagString(flags, "field");
  const unset = flagString(flags, "unset-field");
  const location = flagString(flags, "location");
  const placeName = flagString(flags, "location-name");
  const address = flagString(flags, "address");
  const clearFields = flagBool(flags, "clear-fields");
  const clearLocation = flagBool(flags, "clear-location");
  if (clearFields && (set !== undefined || unset !== undefined)) throw usageError("--clear-fields cannot be used with --field or --unset-field.");
  if (clearLocation && location !== undefined) throw usageError("--clear-location cannot be used with --location.");
  if (location === undefined && (placeName !== undefined || address !== undefined)) {
    throw usageError(`${placeName !== undefined ? "--location-name" : "--address"} requires --location.`);
  }
  const patch: Pick<ScreenPatch, "fields" | "location"> = {};
  if (clearFields) {
    patch.fields = null;
  } else if (set !== undefined || unset !== undefined) {
    const sets = fieldEntries(set);
    const removed = unset === undefined ? [] : unset.split("\n");
    const clash = removed.find((name) => sets.some((entry) => entry.name === name));
    if (clash !== undefined) throw usageError(`--field and --unset-field both name ${clash}.`);
    patch.fields = Object.fromEntries([...sets.map((entry): [string, string | null] => [entry.name, entry.value]), ...removed.map((name): [string, string | null] => [name, null])]);
  }
  if (clearLocation) {
    patch.location = null;
  } else if (location !== undefined) {
    const [latitude, longitude] = location.split(",").map(Number) as [number, number];
    patch.location = { latitude, longitude, ...(placeName !== undefined ? { name: placeName } : {}), ...(address !== undefined ? { address } : {}) };
  }
  return patch;
}

/** The screen list filters: near is one query value; each field travels as its own NAME:VALUE parameter. */
export function screenListFacts(flags: Flags): { query: Record<string, string>; repeated?: Record<string, string[]> } {
  const near = flagString(flags, "near");
  const field = flagString(flags, "field");
  return {
    query: near === undefined ? {} : { near },
    ...(field === undefined ? {} : { repeated: { field: fieldEntries(field).map((entry) => `${entry.name}:${entry.value}`) } }),
  };
}

/** Printable fields: only grammar-shaped names, and server text with control characters made spaces. */
function printableFields(screen: Screen | undefined): Array<[string, string]> {
  const fields: unknown = screen?.fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return [];
  return Object.entries(fields)
    .filter((entry): entry is [string, string] => SCREEN_FIELD_NAME_PATTERN.test(entry[0]) && typeof entry[1] === "string")
    .map(([name, value]) => [name, plainText(value)]);
}

interface PrintableLocation {
  latitude: string;
  longitude: string;
  name?: string;
  address?: string;
}

/** The location as plain text, or undefined unless the server sent finite coordinates. */
function printableLocation(screen: Screen | undefined): PrintableLocation | undefined {
  const place: unknown = screen?.location;
  if (place === null || typeof place !== "object") return undefined;
  const { latitude, longitude, name, address } = place as Record<string, unknown>;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) return undefined;
  const text = (value: unknown): string | undefined => (typeof value === "string" ? plainText(value).trim() || undefined : undefined);
  return { latitude: String(latitude), longitude: String(longitude), name: text(name), address: text(address) };
}

/** The fields and location lines `screen show` prints, each only when the screen has one. */
export function screenFactsLines(screen: Screen | undefined): string[] {
  const fields = printableFields(screen);
  const place = printableLocation(screen);
  return [
    ...(fields.length ? [`Fields: ${fields.map(([name, value]) => `${name}=${value}`).join(", ")}`] : []),
    ...(place ? [`Location: ${place.latitude}, ${place.longitude}${place.name ? ` (${place.name})` : ""}${place.address ? ` · ${place.address}` : ""}`] : []),
  ];
}

/** The screen list FIELDS cell: name=value pairs, comma-separated. Empty for a screen with none. */
export function screenFieldsCell(screen: Screen | undefined): string {
  return printableFields(screen).map(([name, value]) => `${name}=${value}`).join(",");
}

/** The screen list LOCATION cell: the coordinates, then the place name in parentheses. Empty for a screen with none. */
export function screenLocationCell(screen: Screen | undefined): string {
  const place = printableLocation(screen);
  return place ? `${place.latitude},${place.longitude}${place.name ? ` (${place.name})` : ""}` : "";
}
