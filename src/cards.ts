import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ApiClient } from "./client.js";
import { usageError } from "./problems.js";
import { flagString, type ParsedArgs } from "./command-input.js";

type Schema = Record<string, any>;
export interface CardDetails {
  id: string;
  major: number;
  version: string;
  params_schema: Schema;
  data_schema: Schema;
  feed: string;
  tier: string;
  layouts: string[];
  example: Record<string, unknown>;
}
export interface CardSummary {
  id: string; title: string; short: string; category: string;
  tags: string[]; tier: string; layouts: string[]; majors: number[];
}

export function cardId(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw usageError("Card id must be 1–40 lowercase letters, digits or hyphens, starting with a letter.");
  return value;
}

export function cardUid(value: string): string {
  if (!/^(?:(?:stage|qa|development)_)?crd_[A-Za-z0-9_-]+$/.test(value)) throw usageError("Use a card instance ID (crd_...).");
  return value;
}

export function cardDataKey(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) || value.startsWith("feed:")) {
    throw usageError("Card data key must follow the K/V key grammar and may not start with feed:.");
  }
  return value;
}

function property(schema: Schema, root: Schema): Schema {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/$defs/")) return schema;
  const name = schema.$ref.slice(8).replace(/~1/g, "/").replace(/~0/g, "~");
  return { ...root.$defs?.[name], ...schema };
}

/** Preserve complete schemas (including nested limits) in structured discovery. */
export function cardProperties(card: CardDetails): { static: Schema; dynamic: Schema } {
  const result: { static: Schema; dynamic: Schema } = { static: {}, dynamic: {} };
  for (const [name, value] of Object.entries(card.params_schema.properties ?? {})) {
    const schema = property(value as Schema, card.params_schema);
    const dynamic = schema.dynamic === true || Object.hasOwn(card.data_schema.properties ?? {}, name);
    Object.defineProperty(result[dynamic ? "dynamic" : "static"], name, {
      value: { schema, required: (card.params_schema.required ?? []).includes(name) }, enumerable: true,
    });
  }
  return result;
}

export function cardDetailsHuman(card: CardDetails): string {
  const properties = cardProperties(card);
  const section = (name: "static" | "dynamic") => [
    `${name} properties:`,
    ...Object.entries(properties[name]).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`),
    ...(Object.keys(properties[name]).length ? [] : ["  (none)"]),
  ];
  return [
    `${card.id} v${card.version} (major ${card.major})`, ...section("static"), ...section("dynamic"),
    `tier: ${card.tier}`, `layouts: ${card.layouts.length ? card.layouts.join(", ") : "(none)"}`, `feed: ${card.feed || "(none)"}`,
    `example placement:\n${JSON.stringify(card.example, null, 2)}`,
  ].join("\n");
}

function assertParams(schema: Schema, params: unknown, field: string): void {
  // Published schemas are self-contained; compile never fetches references or runs models.
  const ajv = schema.$schema?.includes("2020-12") ? new Ajv2020({ allErrors: true, strict: false }) : new Ajv({ allErrors: true, strict: false });
  ajv.addKeyword({ keyword: "dynamic", schemaType: "boolean", valid: true });
  const validate = ajv.compile(schema);
  if (!validate(params)) {
    const errors = (validate.errors ?? []).map(error => `${field}${error.instancePath}: ${error.message}`).join("; ");
    throw usageError(`Invalid card params: ${errors}`);
  }
}

/** One catalogue read per card, before uploading a playlist. Older pinned majors are server-validated. */
export async function validatePlaylistCards(client: ApiClient, playlist: { pages: any[] }): Promise<void> {
  const cards = new Map<string, CardDetails>();
  for (const [pageIndex, page] of playlist.pages.entries()) {
    for (const [index, item] of (page.primitives ?? []).entries()) {
      if (item.primitive !== "card") continue;
      if (typeof item.card === "string" && /^(?:(?:stage|qa|development)_)?crd_/.test(item.card)) continue;
      const id = cardId(item.card);
      let card = cards.get(id);
      if (!card) {
        card = (await client.call({ method: "GET", path: `/api/card-types/${id}` })).body as CardDetails;
        cards.set(id, card);
      }
      if (item.major !== undefined && item.major !== card.major) continue;
      if (typeof item.layout === "string" && Array.isArray(card.layouts) && !card.layouts.includes(item.layout)) {
        throw usageError(`pages[${pageIndex}].primitives[${index}].layout: card ${id} (${card.tier} tier) takes ${card.layouts.length ? card.layouts.join(", ") : "no layout"}, not ${item.layout}.`);
      }
      const schema = structuredClone(card.params_schema);
      const field = `pages[${pageIndex}].primitives[${index}].params`;
      if (item.data !== undefined) {
        cardDataKey(item.data);
        const dynamic = Object.keys(cardProperties(card).dynamic);
        for (const name of dynamic) {
          if (Object.hasOwn(item.params ?? {}, name)) throw usageError(`${field}.${name} is dynamic; write it with card-data put for a bound placement.`);
          delete schema.properties?.[name];
        }
        schema.required = (schema.required ?? []).filter((name: string) => !dynamic.includes(name));
      }
      assertParams(schema, item.params ?? {}, field);
    }
  }
}

export function feedQuery(args: ParsedArgs): Record<string, string> {
  const family = args.positionals[2]!;
  const allowed: Record<string, string[]> = {
    weather: ["lat", "lon"], airquality: ["lat", "lon"], alerts: ["lat", "lon"],
    earthquakes: ["lat", "lon", "radius-km"], rates: ["base"], crypto: ["symbols", "currency"], headlines: ["url"],
  };
  const names = allowed[family];
  if (!names) throw usageError("Unknown feed family.");
  const query: Record<string, string> = {};
  for (const name of ["lat", "lon", "radius-km", "base", "symbols", "currency", "url"]) {
    const value = flagString(args.flags, name);
    if (value === undefined) continue;
    if (!names.includes(name)) throw usageError(`--${name} does not apply to ${family}.`);
    if (["lat", "lon", "radius-km"].includes(name)) {
      const ranges: Record<string, number[]> = { lat: [-90, 90], lon: [-180, 180], "radius-km": [10, 20000] };
      const [min, max] = ranges[name]!;
      if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < min! || Number(value) > max!) {
        throw usageError(`--${name} must be a number from ${min} to ${max}.`);
      }
    }
    query[name.replaceAll("-", "_")] = value;
  }
  const required = names.includes("lat") ? ["lat", "lon"] : family === "crypto" ? ["symbols"] : family === "headlines" ? ["url"] : [];
  for (const name of required) if (!query[name]) throw usageError(`${family} requires --${name}.`);
  return query;
}
