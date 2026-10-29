// Command handlers for the cards commands, loaded on demand.
import { cardExpiry } from "../card-expiry.js";
import { withCardPreview } from "../card-preview.js";
import { readAuthoringJson } from "../authoring-input.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { parseRetryAfter, unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { cardId, cardUid, cardProperties, cardDetailsHuman, feedQuery, type CardDetails, type CardSummary } from "../cards.js";
import { clientFor, commandHandler, jsonBody, simpleGet, simpleList } from "../commands.js";


export const handleCardsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/card-types" });
  const tag = flagString(args.flags, "tag"), category = flagString(args.flags, "category");
  const cards = (response.body as { cards: CardSummary[] }).cards.filter(card =>
    (!tag || card.tags.includes(tag)) && (!category || card.category === category));
  return { envelope: jsonBody(response, client.requestId, { cards }), exitCode: ExitCode.Success,
    human: cards.length ? cards.map(card => `${card.id}: ${card.title} — ${card.short}\n  category: ${card.category}; tags: ${card.tags.join(", ")}; tier: ${card.tier}; layouts: ${card.layouts.join(", ") || "(none)"}; majors: ${card.majors.join(", ")}`).join("\n") : "No matching cards." };
});

export const handleCardsShow = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/card-types/${cardId(args.positionals[2]!)}` });
  const card = response.body as CardDetails;
  return { envelope: jsonBody(response, client.requestId, { properties: cardProperties(card) }), exitCode: ExitCode.Success, human: cardDetailsHuman(card) };
});

/** Global instance IDs are separate from catalogue type names. */
export function cardInstanceId(args: ParsedArgs, index = 2): string {
  const id = args.positionals[index] ?? "";
  return cardUid(id);
}

export async function cardObjectFile(args: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const value = await readAuthoringJson(flagString(args.flags, "file")!, runtime);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("Card input must be a JSON object.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576) throw usageError("Card input must be at most 1 MiB.");
  return value as Record<string, unknown>;
}

export const handleCardPreview = commandHandler(async (args, runtime, resolved) => {
  const target = args.positionals[2];
  const output = flagString(args.flags, "output");
  if (!target || !output) throw usageError("card preview requires <type|id> and --output FILE.png.");
  const paramsFile = flagString(args.flags, "params");
  const dataFile = flagString(args.flags, "data");
  const feedFile = flagString(args.flags, "feed");
  const feed = feedFile ? await readAuthoringJson(feedFile, runtime) as Record<string, unknown> : undefined;
  const params = paramsFile ? await readAuthoringJson(paramsFile, runtime) as Record<string, unknown> : undefined;
  const data = dataFile ? await readAuthoringJson(dataFile, runtime) as Record<string, unknown> : undefined;
  const client = resolved.token ? clientFor(runtime, args, resolved.apiUrl, resolved.token) : undefined;
  const result = await withCardPreview({ apiUrl: resolved.apiUrl, runtime, client }, async (renderer) => {
    const placement = await renderer.placement({ card: target });
    const rendered = await renderer.render({ ...placement, ...(params ? { params } : {}), ...(data ? { data } : {}), ...(feed ? { feed } : {}),
      width: flagNumber(args.flags, "width") ?? 1920, height: flagNumber(args.flags, "height") ?? 1080,
      layout: flagString(args.flags, "layout"), anchor: flagString(args.flags, "anchor"),
      now: flagString(args.flags, "now"), timezone: flagString(args.flags, "timezone"),
    });
    const file = path.resolve(runtime.cwd(), output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rendered.png);
    return { ...rendered.result, file, local: true };
  });
  return { envelope: successEnvelope(result, { request_id: client?.requestId }), exitCode: ExitCode.Success,
    human: `Local card preview: ${result.file}\nOpen and inspect this image before publishing.` };
});

export const handleCardCreate = commandHandler(async (args, runtime, resolved) => {
  const params = await cardObjectFile(args, runtime);
  const type = cardId(flagString(args.flags, "type")!);
  const major = flagNumber(args.flags, "major");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/cards", idempotent: true,
    body: { type, params, ...(major !== undefined ? { major } : {}) } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Created card ${(response.body as { id: string }).id}` };
});

export const handleCardList = commandHandler(async (args, runtime, resolved) => simpleList(args, runtime, resolved, "/api/cards", "Card instances"));
export const handleCardShow = commandHandler(async (args, runtime, resolved) => simpleGet(args, runtime, resolved, `/api/cards/${cardInstanceId(args)}`, "Card instance"));
export const handleCardParams = commandHandler(async (args, runtime, resolved) => {
  const id = cardInstanceId(args);
  const params = await cardObjectFile(args, runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PATCH", path: `/api/cards/${id}`, body: { params } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Card params replaced: ${id}` };
});
export const handleCardDelete = commandHandler(async (args, runtime, resolved) => {
  const id = cardInstanceId(args);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "DELETE", path: `/api/cards/${id}`, idempotent: true });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted card: ${id}` };
});
export const handleCardInstanceDataGet = commandHandler(async (args, runtime, resolved) => simpleGet(args, runtime, resolved, `/api/cards/${cardInstanceId(args, 3)}/data`, "Card instance data"));
export const handleCardInstanceDataPut = commandHandler(async (args, runtime, resolved) => {
  const id = cardInstanceId(args, 3);
  const document = await cardObjectFile(args, runtime);
  const revision = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PUT", path: `/api/cards/${id}/data`, body: { document, ...cardExpiry(args.flags) }, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Card data written: ${id}\nrevision: ${(response.body as { revision: number }).revision}` };
});

export const handleFeedsGet = commandHandler(async (args, runtime, resolved) => {
  const { query, repeated } = feedQuery(args);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/feeds/${args.positionals[2]!}`, query, ...(Object.keys(repeated).length ? { queryRepeated: repeated } : {}) });
  const body = response.body as Record<string, unknown>;
  const key = response.headers["screenrig-feed-key"] ?? body.key;
  if (response.status === 202) {
    const now = runtime.now().getTime();
    const seconds = parseRetryAfter(response.headers["retry-after"], now) ?? body.retry_after_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(new Date(now + seconds * 1000).getTime())) {
      throw unexpectedResponseError("Pending feed response lacks a valid retry time.", client.requestId);
    }
    const retryAt = new Date(now + seconds * 1000).toISOString();
    return { envelope: jsonBody(response, client.requestId, { key, state: "pending", retry_after_seconds: seconds, retry_at: retryAt }), exitCode: ExitCode.Success,
      human: `Feed pending\nkey: ${key}\nretry after: ${seconds} seconds (${retryAt})` };
  }
  return { envelope: jsonBody(response, client.requestId, key ? { key } : undefined), exitCode: ExitCode.Success,
    human: `Feed\n${JSON.stringify(body, null, 2)}` };
});
