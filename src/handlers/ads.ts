// Command handlers for the ads commands, loaded on demand.
import { readAuthoringJson } from "../authoring-input.js";
import { formatResultContext } from "../project-context.js";
import { csvByteStream, csvRecord, isoUtc, playsInstant, writeCsvFile, writeCsvStdout } from "../playback-export.js";
import { type AdvertisingCreativeReview } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { plainText } from "../reviews.js";
import { successEnvelope, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { adsListOption, clientFor, commandHandler, humanLines, jsonBody, playbackFormat, reportFileOf, requireFlagValue, requirePrivateNoStore, resolveDownloadOutput, simpleGet, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


/**
 * One advertising or billing mutation.
 *
 * Every mutation is idempotent by contract, revision-checked writes carry
 * If-Match, and no advertising or billing response may be cached. Nothing here
 * moves money: a draft authorizes nothing and activation is a separate,
 * explicitly quoted request.
 */
export async function adsMutation(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: ResolvedCommandConfig,
  options: { method: "POST" | "PUT"; path: string; body?: unknown; ifMatch?: string; human: string },
): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: options.method,
    path: options.path,
    idempotent: true,
    ...(options.ifMatch ? { headers: { "if-match": quotedRevision(options.ifMatch) } } : {}),
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  requirePrivateNoStore(response.headers, "Advertising response");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: options.human };
}

/** Optional body member: the key is omitted entirely when the operator supplied nothing. */
export function plugged(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}
/** mcr amounts travel as canonical decimal strings in both directions. */
export function adsNetworkRateBody(args: ParsedArgs): Record<string, unknown> {
  return { rate_mcr_per_15s: flagString(args.flags, "rate-mcr-per-15s") };
}

export function adsInventoryBody(args: ParsedArgs): Record<string, unknown> {
  const enabled = flagBool(args.flags, "enabled") ? true : flagBool(args.flags, "disabled") ? false : undefined;
  const rate = flagString(args.flags, "rate-mcr-per-15s");
  const tags = flagString(args.flags, "audience-tags");
  const impressions = flagNumber(args.flags, "impressions-per-hour");
  return {
    ...(enabled === undefined ? {} : { ads_enabled: enabled }),
    ...plugged("site_name", flagString(args.flags, "site-name")),
    ...plugged("city", flagString(args.flags, "city")),
    ...plugged("region", flagString(args.flags, "region")),
    ...plugged("venue_type", flagString(args.flags, "venue-type")),
    ...(tags === undefined ? {} : { audience_tags: adsListOption(tags, "audience-tags") }),
    ...plugged("placement", flagString(args.flags, "placement")),
    ...plugged("public_description", flagString(args.flags, "public-description")),
    ...(rate === undefined ? {} : { rate_override_mcr_per_15s: rate }),
    ...(flagBool(args.flags, "clear-rate") ? { rate_override_mcr_per_15s: null } : {}),
    ...plugged("impressions_per_hour", impressions),
    ...(flagBool(args.flags, "clear-impressions-per-hour") ? { impressions_per_hour: null } : {}),
  };
}

export function adsSlotBody(args: ParsedArgs): Record<string, unknown> {
  const media = flagString(args.flags, "accepted-media");
  const rate = flagString(args.flags, "rate-mcr-per-15s");
  const enabled = flagBool(args.flags, "enabled") ? true : flagBool(args.flags, "disabled") ? false : undefined;
  return {
    ...plugged("enabled", enabled),
    ...plugged("name", flagString(args.flags, "name")),
    ...(media === undefined ? {} : { accepted_media: adsListOption(media, "accepted-media") }),
    ...plugged("max_image_duration_ms", flagNumber(args.flags, "max-image-duration-ms")),
    ...plugged("max_video_duration_ms", flagNumber(args.flags, "max-video-duration-ms")),
    ...(rate === undefined ? {} : { rate_override_mcr_per_15s: rate }),
    ...(flagBool(args.flags, "clear-rate") ? { rate_override_mcr_per_15s: null } : {}),
    ...plugged("vast_tag_url", flagString(args.flags, "vast-tag-url")),
    ...(flagBool(args.flags, "clear-vast-tag-url") ? { vast_tag_url: null } : {}),
  };
}

/** One row of a list route by key, or undefined when the project has none. */
export async function adsExistingRow(
  client: ApiClient,
  path: string,
  collection: string,
  key: string,
  value: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await client.call({ method: "GET", path });
  const rows = (response.body as { [name: string]: unknown } | undefined)?.[collection];
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return key in item && item[key] === value;
  });
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : undefined;
}

/**
 * The full slot row the update route expects. The server replaces the whole
 * definition, so every field the operator did not change is carried over from
 * the stored row rather than dropped; only an explicit flag overrides it.
 */
export function adsSlotWriteBody(current: Record<string, unknown> | undefined, args: ParsedArgs): Record<string, unknown> {
  const supplied = adsSlotBody(args);
  if (!current) return supplied;
  return {
    name: current.name,
    enabled: current.enabled,
    accepted_media: current.accepted_media,
    max_image_duration_ms: current.max_image_duration_ms,
    max_video_duration_ms: current.max_video_duration_ms,
    rate_override_mcr_per_15s: current.rate_override_mcr_per_15s ?? null,
    // An absent vast_tag_url clears the tag, so the stored one (shown to the owning seller) is sent back.
    ...(typeof current.vast_tag_url === "string" && current.vast_tag_url ? { vast_tag_url: current.vast_tag_url } : {}),
    ...supplied,
  };
}

/**
 * The full inventory row the update route expects, for the same reason: a
 * partial body would reset the opt-in flag, the price override, and the public
 * metadata the operator did not touch.
 */
export function adsInventoryWriteBody(current: Record<string, unknown> | undefined, args: ParsedArgs): Record<string, unknown> {
  const supplied = adsInventoryBody(args);
  if (!current) return supplied;
  return {
    ads_enabled: typeof current.ads_enabled === "boolean" ? current.ads_enabled : false,
    site_name: current.site_name,
    city: current.city,
    region: current.region,
    venue_type: current.venue_type,
    audience_tags: current.audience_tags,
    placement: current.placement,
    public_description: current.public_description,
    rate_override_mcr_per_15s: current.rate_override_mcr_per_15s ?? null,
    // An absent estimate clears it, so the stored one is sent back.
    ...(typeof current.impressions_per_hour === "number" ? { impressions_per_hour: current.impressions_per_hour } : {}),
    ...supplied,
  };
}

/**
 * The full membership body. The route takes the policy and both scope lists, so
 * an unspecified list keeps the stored scope instead of clearing it. The policy
 * is always sent: the server replaces it rather than defaulting it.
 */
export function adsMembershipWriteBody(current: Record<string, unknown> | undefined, args: ParsedArgs): Record<string, unknown> {
  const screenIds = flagString(args.flags, "screen-id");
  const slotIds = flagString(args.flags, "slot-id");
  const policy = flagString(args.flags, "policy")
    ?? (typeof current?.policy === "string" && current.policy.length > 0 ? current.policy : undefined);
  if (policy === undefined) {
    throw usageError(`The membership row was not found, so its current review policy cannot be carried over. Run ads memberships list, or pass --policy trusted|review_required explicitly.`);
  }
  const scope = current?.scope;
  if ((screenIds === undefined || slotIds === undefined)
    && (!scope || typeof scope !== "object" || Array.isArray(scope))) {
    throw usageError("The membership did not report its scope; refusing to replace an omitted list with an empty one.");
  }
  const storedScope = (scope ?? {}) as Record<string, unknown>;
  return {
    screen_ids: screenIds === undefined ? storedScope.screen_ids ?? [] : adsListOption(screenIds, "screen-id"),
    slot_ids: slotIds === undefined ? storedScope.slot_ids ?? [] : adsListOption(slotIds, "slot-id"),
    policy,
  };
}

/** Money in a campaign draft is a canonical decimal mcr string, never a number. */
export function isDecimalMcr(value: unknown): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

/** A positive mcr amount for a price ceiling: a decimal string, never zero. */
export function isPositiveMcr(value: unknown): boolean {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

/**
 * Read and preflight one campaign draft document.
 *
 * The required field set is the published draft contract. A malformed draft is
 * refused here so the operator learns which field is wrong instead of receiving
 * a server field error about a body the CLI wrote; the server still validates
 * everything, including fields this preflight does not name.
 */
export async function campaignDraft(file: string | undefined, runtime: CliRuntime): Promise<Record<string, unknown>> {
  if (!file) throw usageError("ads campaigns requires a draft JSON document.");
  let parsed: unknown;
  try {
    parsed = await readAuthoringJson(file, runtime);
  } catch (error) {
    throw usageError(`Cannot read the campaign draft JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("A campaign draft must be a JSON object.");
  }
  const draft = parsed as Record<string, unknown>;
  const fail = (field: string, expectation: string): never => {
    throw usageError(`Campaign draft field ${field} ${expectation}`);
  };
  if (typeof draft.name !== "string" || draft.name.trim().length === 0) fail("name", "must be a non-empty string.");
  for (const field of ["daily_cap_mcr", "lifetime_cap_mcr"] as const) {
    if (!isDecimalMcr(draft[field])) fail(field, "must be a decimal mcr string, for example \"100000000\".");
  }
  // Chosen at drafting time: the image display duration inside the authoring
  // range, and an optional per-play price ceiling as a decimal mcr string.
  const imageDurationMs = draft.image_duration_ms;
  if (imageDurationMs !== undefined
    && (typeof imageDurationMs !== "number" || !Number.isInteger(imageDurationMs) || imageDurationMs < 5000 || imageDurationMs > 30000)) {
    fail("image_duration_ms", "must be a whole number of milliseconds from 5000 to 30000 when present.");
  }
  if (draft.max_play_price_mcr !== undefined && !isPositiveMcr(draft.max_play_price_mcr)) {
    fail("max_play_price_mcr", "must be a positive decimal mcr string when present; omit it for no extra price ceiling.");
  }
  for (const field of ["flight_start", "flight_end"] as const) {
    if (typeof draft[field] !== "string" || draft[field].trim().length === 0) fail(field, "must be a UTC timestamp string.");
  }
  if (!Array.isArray(draft.networks) || draft.networks.length === 0) {
    fail("networks", "must be a non-empty array of network configurations.");
  }
  for (const [index, value] of (draft.networks as unknown[]).entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`networks[${index}]`, "must be an object.");
    const network = value as Record<string, unknown>;
    if (typeof network.seller_project_id !== "string" || network.seller_project_id.length === 0) {
      fail(`networks[${index}].seller_project_id`, "must name the invited seller project.");
    }
    for (const field of ["screen_ids", "slot_ids", "creative_ids"] as const) {
      const list = network[field];
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
        fail(`networks[${index}].${field}`, "must be an array of string identifiers.");
      }
    }
    if (network.network_cap_mcr !== undefined && !isDecimalMcr(network.network_cap_mcr)) {
      fail(`networks[${index}].network_cap_mcr`, "must be a decimal mcr string when present.");
    }
  }
  return draft;
}

export const handleAdsNetworksList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/networks", "Invited networks"));

export const handleAdsNetworkInventoryShow = commandHandler(async (args, runtime, resolved) => {
  const seller = args.positionals[3];
  if (!seller) throw usageError("ads networks show requires <seller-project-id>.");
  return simpleGet(args, runtime, resolved, `/api/advertising/networks/${encodeURIComponent(seller)}/inventory`, "Permitted inventory");
});

export const handleAdsNetworkShow = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/network", "Advertising network"));

export const handleAdsNetworkCreate = commandHandler((args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/network",
    body: { name: flagString(args.flags, "name") },
    human: "Network created. Set the default rate before enabling paid supply.",
  }));

export const handleAdsNetworkRate = commandHandler((args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/network/rate",
    body: adsNetworkRateBody(args),
    ifMatch: flagString(args.flags, "expect-rev"),
    human: "Default rate updated. Affected campaigns are paused until each buyer accepts a fresh quote.",
  }));

export const handleAdsInventoryList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/inventory", "Advertising inventory"));

/**
 * Upsert one screen's advertising inventory. When the row already exists the
 * route replaces it, so the CLI reads the stored row, merges the supplied
 * changes, and writes the whole record with the current revision as its
 * precondition; an unsupplied field keeps its stored value.
 */
export const handleAdsInventoryUpdate = commandHandler(async (args, runtime, resolved) => {
  const screenId = args.positionals[3];
  if (!screenId) throw usageError("ads inventory update requires <screen-id>.");
  const requested = flagString(args.flags, "expect-rev");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const current = await adsExistingRow(client, "/api/advertising/inventory", "inventory", "screen_id", screenId);
  if (!current && requested) {
    throw usageError(`No advertising inventory row exists for ${screenId}, so --expect-rev has nothing to check. Omit it to create the row.`);
  }
  if (!current && !flagBool(args.flags, "enabled") && !flagBool(args.flags, "disabled")) {
    throw usageError(`No advertising inventory row exists for ${screenId} yet; a new row needs --enabled or --disabled so the write carries its ads_enabled field.`);
  }
  const currentRevision = typeof current?.revision === "number" ? String(current.revision) : undefined;
  return adsMutation(args, runtime, resolved, {
    method: "PUT",
    path: `/api/advertising/inventory/${encodeURIComponent(screenId)}`,
    body: adsInventoryWriteBody(current, args),
    ifMatch: requested ?? (current ? currentRevision : undefined),
    human: `Updated advertising inventory for ${screenId}. Fields you did not change keep their stored values.`,
  });
});

export const handleAdsSlotsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/slots", "Ad slots"));

export const handleAdsSlotsCreate = commandHandler((args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/slots",
    // The canonical slot write requires both duration limits; the values below
    // are the server's own normalization defaults for an omitted limit, so the
    // create body is complete without a second server round-trip.
    body: {
      enabled: true,
      max_image_duration_ms: 30000,
      max_video_duration_ms: 30000,
      ...adsSlotBody(args),
    },
    human: "Slot created. Place an adslot page in a playlist to give it an ad break.",
  }));

/**
 * Update one slot. The route replaces the stored definition, so the CLI reads
 * it first and writes the merged record; a rename alone keeps the accepted
 * formats, duration limits, and the rate override.
 */
export const handleAdsSlotsUpdate = commandHandler(async (args, runtime, resolved) => {
  const slotId = args.positionals[3];
  if (!slotId) throw usageError("ads slots update requires <slot-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const current = await adsExistingRow(client, "/api/advertising/slots", "slots", "id", slotId);
  if (!current) {
    throw usageError(`No slot ${slotId} exists for this project, so there is nothing to update. Create it with ads slots create.`);
  }
  const currentRevision = typeof current.revision === "number" ? String(current.revision) : undefined;
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/slots/${encodeURIComponent(slotId)}`,
    body: adsSlotWriteBody(current, args),
    ifMatch: flagString(args.flags, "expect-rev") ?? currentRevision,
    human: "Slot updated. A changed effective rate pauses affected campaigns until each buyer accepts a fresh quote.",
  });
});

export const handleAdsMembershipsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/memberships", "Memberships"));

/**
 * Update one membership. The route takes the policy and both scope lists, so an
 * unspecified list keeps the stored scope rather than clearing the buyer's
 * access, and the stored policy is reused when --policy is omitted.
 */
export const handleAdsMembershipsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads memberships update requires <membership-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const current = await adsExistingRow(client, "/api/advertising/memberships", "memberships", "id", id);
  const currentRevision = typeof current?.revision === "number" ? String(current.revision) : undefined;
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/memberships/${encodeURIComponent(id)}`,
    body: adsMembershipWriteBody(current, args),
    ifMatch: flagString(args.flags, "expect-rev") ?? currentRevision,
    human: `Updated membership ${id}. Scope changes stop new selections and invalidate unstarted decisions.`,
  });
});

export const handleAdsMembershipsRevoke = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads memberships revoke requires <membership-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/memberships/${encodeURIComponent(id)}/revoke`,
    human: `Revoked membership ${id}. The buyer's advertiser flag and other networks are unchanged.`,
  });
});

export const handleAdsCreativesList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/creatives", "Creatives"));

export const handleAdsCreativesCreate = commandHandler(async (args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/creatives",
    body: { media_id: flagString(args.flags, "media-id"), copy: flagString(args.flags, "copy") },
    human: "Creative created. It binds the ready media revision; the media is neither charged nor uploaded again.",
  }));

export const handleAdsCreativesShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads creatives show requires <creative-id>.");
  const result = await simpleGet(args, runtime, resolved, `/api/advertising/creatives/${encodeURIComponent(id)}`, "Creative");
  // Each seller's review of this creative, with the reason a seller gave for
  // a rejection or the changes it asked for.
  const reviews = (result.envelope.data as { reviews?: AdvertisingCreativeReview[] } | undefined)?.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) return result;
  const lines = reviews.map((review) => [
    `review ${review.id} ${review.state}`,
    `seller ${review.seller_project_id}`,
    `revision ${review.creative_revision}`,
    ...(review.campaign_id ? [`campaign ${review.campaign_id}`] : []),
  ].join(" ") + (review.reason ? `: ${plainText(review.reason)}` : ""));
  const [title, ...rest] = (result.human ?? "").split("\n");
  return { ...result, human: [title, ...lines, ...rest].join("\n") };
});

export const handleAdsCampaignsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/campaigns", "Campaigns"));

export const handleAdsCampaignsCreate = commandHandler(async (args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/campaigns",
    body: await campaignDraft(args.positionals[3], runtime),
    human: "Campaign draft created. A draft reserves no credits and cannot deliver until an accepted quote activates it.",
  }));

export const handleAdsCampaignsShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns show requires <campaign-id>.");
  return simpleGet(args, runtime, resolved, `/api/advertising/campaigns/${encodeURIComponent(id)}`, "Campaign");
});
/**
 * Quote a campaign. The route requires the current campaign revision as its
 * precondition: the operator can override it with --expect-rev, otherwise the
 * CLI reads that one campaign and uses the revision it just saw.
 */
export const handleAdsCampaignsPreview = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns preview requires <campaign-id>.");
  let ifMatch = flagString(args.flags, "expect-rev");
  if (ifMatch === undefined) {
    const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
    const campaign = (await client.call({ method: "GET", path: `/api/advertising/campaigns/${encodeURIComponent(id)}` })).body;
    const revision = campaign !== null && typeof campaign === "object" && !Array.isArray(campaign) && "revision" in campaign
      ? campaign.revision : undefined;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw usageError(`Campaign ${id} did not report a usable revision, so its quote cannot be revision-checked.`);
    }
    ifMatch = String(revision);
  }
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/quote`,
    ifMatch,
    human: "Quote priced for current inventory and rates. Preview reserves and spends nothing; activate with --quote-id only after the user accepts this quote.",
  });
});

export const handleAdsCampaignsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns update requires <campaign-id> <file>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}`,
    body: await campaignDraft(args.positionals[4], runtime),
    ifMatch: flagString(args.flags, "expect-rev"),
    human: `Campaign ${id} draft replaced. Changing accepted scope requires a fresh quote and explicit acceptance.`,
  });
});

export const handleAdsCampaignsActivate = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns activate requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/activate`,
    body: { quote_id: flagString(args.flags, "quote-id") },
    ifMatch: flagString(args.flags, "expect-rev"),
    human: "Campaign activation accepted the quote. No wallet debit happens here: a per-occurrence hold is placed when the runtime resolves a play and it settles only on the verified completion. Activation is not proof that a screen displayed anything.",
  });
});

export const handleAdsCampaignsPause = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns pause requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/pause`,
    ifMatch: flagString(args.flags, "expect-rev"),
    human: `Paused campaign ${id}. New reservations stop; already-started valid plays settle at their reserved price.`,
  });
});

export const handleAdsCampaignsResume = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns resume requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/resume`,
    ifMatch: flagString(args.flags, "expect-rev"),
    human: `Resumed campaign ${id} after a manual pause. Resume cannot clear a price-change pause; that needs a fresh quote accepted with campaigns accept-rates.`,
  });
});

export const handleAdsCampaignsAcceptRates = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns accept-rates requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/accept-rates`,
    body: { quote_id: flagString(args.flags, "quote-id") },
    ifMatch: flagString(args.flags, "expect-rev"),
    human: `Accepted the fresh quote for campaign ${id}. Delivery resumes only if every other blocker, such as review or funds, is also clear.`,
  });
});

export const handleAdsReviewsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/reviews", "Creative reviews"));

/**
 * The seller's preview of one submission: the dedicated review metadata route
 * returns the review and the exact creative it decided on, and nothing from the
 * buyer's wider media library.
 */
export const handleAdsReviewsShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews show requires <review-id>.");
  return simpleGet(args, runtime, resolved, `/api/advertising/reviews/${encodeURIComponent(id)}`, "Review");
});

export const handleAdsReviewsApprove = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews approve requires <review-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/reviews/${encodeURIComponent(id)}/approve`,
    human: `Approved review ${id} for that exact creative version.`,
  });
});

export const handleAdsReviewsRequestChanges = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews request-changes requires <review-id>.");
  const note = flagString(args.flags, "note");
  if (!note) throw usageError("ads reviews request-changes requires --note TEXT naming the changes.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/reviews/${encodeURIComponent(id)}/request-changes`,
    body: { note },
    human: `Asked the buyer for changes on review ${id}; the buyer reads the note on the creative and resubmits.`,
  });
});

export const handleAdsReviewsReject = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews reject requires <review-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/reviews/${encodeURIComponent(id)}/reject`,
    body: { reason: flagString(args.flags, "reason") },
    human: `Rejected review ${id}; the buyer sees the supplied reason.`,
  });
});

/**
 * One report body as readable columns. Money is printed exactly as the server
 * sends it (a decimal mcr string), a missing field is simply absent, and the
 * whole body stays in the JSON envelope unchanged.
 */
export function reportLines(title: string, body: unknown, fields: readonly string[], rows?: readonly string[]): string {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const lines = humanLines(title, fields.map((field) => {
    const value = record[field];
    return [field, typeof value === "string" || typeof value === "number" ? String(value) : undefined] as [string, string | undefined];
  })).split("\n");
  const rowValues = rows ? record.rows : undefined;
  if (!rows || !Array.isArray(rowValues)) {
    return lines.join("\n");
  }
  lines.push("rows:");
  for (const value of rowValues) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    lines.push(`  ${rows.map((field) => `${field}=${typeof row[field] === "string" || typeof row[field] === "number" ? String(row[field]) : ""}`).join(" ")}`);
  }
  return lines.join("\n");
}

export const handleAdsReportsSpend = commandHandler(async (args, runtime, resolved) => {
  const spendFile = await reportFileOf(args, runtime, resolved, "/api/advertising/reports/spend", { campaign_id: flagString(args.flags, "campaign-id") }, "ad-spend", "ad spend report");
  if (spendFile) return spendFile;
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/advertising/reports/spend",
    query: { campaign_id: flagString(args.flags, "campaign-id") },
  });
  requirePrivateNoStore(response.headers, "Advertising report response");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportLines("Ad spend", response.body, ["campaign_id", "spent_mcr", "reserved_mcr", "completed", "unbillable", "pending", "estimated_impressions"]),
  };
});

export const handleAdsReportsDelivery = commandHandler(async (args, runtime, resolved) => {
  const deliveryFile = await reportFileOf(args, runtime, resolved, "/api/advertising/reports/delivery", { from: flagString(args.flags, "from"), to: flagString(args.flags, "to") }, "ad-delivery", "ad delivery report");
  if (deliveryFile) return deliveryFile;
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/advertising/reports/delivery",
    query: { from: flagString(args.flags, "from"), to: flagString(args.flags, "to") },
  });
  requirePrivateNoStore(response.headers, "Advertising report response");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportLines("Delivery statement", response.body,
      ["gross_mcr", "fee_mcr", "net_mcr", "completed", "interrupted", "unbillable", "estimated_impressions"],
      ["screen_id", "slot_id", "reservation_id", "gross_mcr", "fee_mcr", "net_mcr", "estimated_impressions", "completed_at"]),
  };
});

export const DIRECT_CAMPAIGNS = "/api/advertising/direct-campaigns";
/** Fill statistics cover at most this many days of the seller's ad slots. */
export const FILL_MAX_RANGE_MS = 35 * 86_400_000;

export function directCampaignPath(args: ParsedArgs, command: string): string {
  const id = args.positionals[3];
  if (!id) throw usageError(`ads direct ${command} requires <campaign-id>.`);
  return `${DIRECT_CAMPAIGNS}/${encodeURIComponent(id)}`;
}

/**
 * Read one JSON document for the direct commands, `-` for stdin. The server
 * validates every field, including the category list, goal and price; this only
 * refuses what is not a JSON object or lacks the fields every draft needs.
 */
export async function directDocument(file: string | undefined, runtime: CliRuntime, what: string): Promise<Record<string, unknown>> {
  if (!file) throw usageError(`ads direct requires a ${what} JSON document.`);
  let parsed: unknown;
  try {
    parsed = await readAuthoringJson(file, runtime);
  } catch (error) {
    throw usageError(`Cannot read the ${what} JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`A ${what} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export async function directDraft(file: string | undefined, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const draft = await directDocument(file, runtime, "direct campaign draft");
  const fail = (field: string, expectation: string): never => {
    throw usageError(`Direct campaign draft field ${field} ${expectation}`);
  };
  for (const field of ["name", "advertiser", "flight_start", "flight_end"] as const) {
    if (typeof draft[field] !== "string" || draft[field].trim().length === 0) {
      fail(field, field === "name" || field === "advertiser" ? "must be a non-empty string." : "must be an RFC 3339 timestamp string.");
    }
  }
  if (!Array.isArray(draft.media_ids) || draft.media_ids.length === 0 || draft.media_ids.some((item) => typeof item !== "string")) {
    fail("media_ids", "must be a non-empty array of media identifiers.");
  }
  if (draft.goal_plays !== undefined && (typeof draft.goal_plays !== "number" || !Number.isSafeInteger(draft.goal_plays) || draft.goal_plays < 0)) {
    fail("goal_plays", "must be a whole number of plays when present; 0 or omitted takes every eligible slot during the flight.");
  }
  if (draft.overbook !== undefined && typeof draft.overbook !== "boolean") {
    fail("overbook", "must be true or false when present.");
  }
  return draft;
}

/** --from/--to of the direct reports: RFC 3339, now or an age such as 7d, sent as RFC 3339. Each is optional. */
export function adsWindow(args: ParsedArgs, runtime: CliRuntime, maxMs?: number): { from?: string; to?: string } {
  requireFlagValue(args, "from", "7d");
  requireFlagValue(args, "to", "now");
  const now = runtime.now();
  const from = flagString(args.flags, "from");
  const to = flagString(args.flags, "to");
  const fromMs = from === undefined ? undefined : playsInstant(from, "--from", now);
  const toMs = to === undefined ? undefined : playsInstant(to, "--to", now);
  if (fromMs !== undefined && toMs !== undefined) {
    if (fromMs >= toMs) throw usageError("--from must be before --to.");
    if (maxMs !== undefined && toMs - fromMs > maxMs) {
      throw usageError(`--from to --to must span at most ${maxMs / 86_400_000} days.`);
    }
  }
  return { ...(fromMs === undefined ? {} : { from: isoUtc(fromMs) }), ...(toMs === undefined ? {} : { to: isoUtc(toMs) }) };
}

export const handleAdsDirectList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, DIRECT_CAMPAIGNS, "Direct campaigns"));

export const handleAdsDirectShow = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, directCampaignPath(args, "show"), "Direct campaign"));

export const handleAdsDirectCreate = commandHandler(async (args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: DIRECT_CAMPAIGNS,
    body: await directDraft(args.positionals[3], runtime),
    human: "Direct campaign created. It fills this project's own ad slots before marketplace campaigns and moves no money through screenRIG: you bill the advertiser.",
  }));

export const handleAdsDirectUpdate = commandHandler(async (args, runtime, resolved) => {
  const target = directCampaignPath(args, "update");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: target,
    body: await directDraft(args.positionals[4], runtime),
    ifMatch: flagString(args.flags, "expect-rev"),
    human: `Direct campaign ${args.positionals[3]} replaced from the draft. Every writable field now holds the draft's value.`,
  });
});

export const directTransition = (verb: "pause" | "resume" | "end", human: (id: string) => string) =>
  commandHandler(async (args, runtime, resolved) => {
    const target = directCampaignPath(args, verb);
    return adsMutation(args, runtime, resolved, {
      method: "POST",
      path: `${target}/${verb}`,
      ifMatch: flagString(args.flags, "expect-rev"),
      human: human(args.positionals[3]!),
    });
  });

export const handleAdsDirectPause = directTransition("pause", (id) => `Paused direct campaign ${id}. It stops taking ad slots until it is resumed.`);
export const handleAdsDirectResume = directTransition("resume", (id) => `Resumed direct campaign ${id}. It takes eligible ad slots again within its flight.`);
export const handleAdsDirectEnd = directTransition("end", (id) => `Ended direct campaign ${id}. Ending is final: create a new direct campaign to run it again. Its report stays readable.`);

/** Availability is a read: the POST carries the query document and changes nothing. */
export const handleAdsDirectAvailability = commandHandler(async (args, runtime, resolved) => {
  const query = await directDocument(args.positionals[3], runtime, "availability query");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/advertising/availability", body: query });
  requirePrivateNoStore(response.headers, "Advertising availability response");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportLines("Ad availability", response.body,
      ["estimated_plays", "booked_plays", "available_plays", "screens", "observed_from", "observed_to", "flight_start", "flight_end"]),
  };
});

export const DIRECT_REPORT_ROW_FIELDS = ["day", "screen_id", "slot_id", "media_id", "plays", "played_ms", "estimated_impressions"] as const;

/** The money value of a report, `12.50 USD (cpm)`, or undefined when the campaign records no price. */
export function directValueLine(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { amount, currency, model } = value as Record<string, unknown>;
  return typeof amount === "string" ? `${amount}${typeof currency === "string" ? ` ${currency}` : ""}${typeof model === "string" ? ` (${model})` : ""}` : undefined;
}

export const handleAdsDirectReport = commandHandler(async (args, runtime, resolved) => {
  const target = directCampaignPath(args, "report");
  const id = args.positionals[3]!;
  const window = adsWindow(args, runtime);
  const directFile = await reportFileOf(args, runtime, resolved, `${target}/report`, window, `direct-report-${id}`, "direct campaign report", true);
  if (directFile) return directFile;
  const format = playbackFormat(args, "ads direct report");
  const toStdout = flagString(args.flags, "output") === "-";
  const outputPath = format === "csv" && !toStdout
    ? await resolveDownloadOutput(runtime.cwd(), `./direct-report-${id}.csv`, args.flags)
    : undefined;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${target}/report`, query: window });
  requirePrivateNoStore(response.headers, "Advertising report response");
  const report = response.body && typeof response.body === "object" && !Array.isArray(response.body) ? response.body as Record<string, unknown> : {};
  const rows = (Array.isArray(report.rows) ? report.rows : []).filter((row): row is Record<string, unknown> =>
    !!row && typeof row === "object" && !Array.isArray(row));
  const truncated = report.truncated === true;
  const truncation: Warning = { code: "direct_report_truncated", message: "The report holds only part of the rows for this period. Narrow --from and --to and run it again for the rest." };

  if (format === "json") {
    const envelope = jsonBody(response, client.requestId, undefined, truncated ? [truncation] : []);
    const lines = humanLines("Direct campaign report", [
      ["campaign_id", typeof report.campaign_id === "string" ? report.campaign_id : undefined],
      ["name", typeof report.name === "string" ? report.name : undefined],
      ["advertiser", typeof report.advertiser === "string" ? report.advertiser : undefined],
      ["period", typeof report.from === "string" && typeof report.to === "string" ? `${report.from} to ${report.to}` : undefined],
      ...(["goal_plays", "delivered_plays", "plays", "played_ms", "not_played", "estimated_impressions"] as const).map((field): [string, string | undefined] =>
        [field, typeof report[field] === "number" ? String(report[field]) : undefined]),
      ["value", directValueLine(report.value)],
    ]).split("\n");
    if (rows.length > 0) {
      lines.push("rows:");
      for (const row of rows) lines.push(`  ${DIRECT_REPORT_ROW_FIELDS.map((field) => `${field}=${row[field] ?? ""}`).join(" ")}`);
    }
    if (truncated) lines.push(`warning: ${truncation.message}`);
    return { envelope, exitCode: ExitCode.Success, human: lines.join("\n") };
  }

  const csv = [
    csvRecord(DIRECT_REPORT_ROW_FIELDS),
    ...rows.map((row) => csvRecord(DIRECT_REPORT_ROW_FIELDS.map((field) => row[field] as string | number | undefined))),
  ].join("");
  const what = "direct campaign report";
  if (toStdout) {
    if (formatResultContext(runtime)) runtime.stderr.write(`${formatResultContext(runtime)}\n`);
    await writeCsvStdout(csvByteStream(csv), runtime.stdout, what, client.requestId);
    if (truncated) runtime.stderr.write(`warning: ${truncation.message}\n`);
    return { envelope: successEnvelope({}), exitCode: ExitCode.Success, human: "", output: "stream" };
  }
  const file = await writeCsvFile(csvByteStream(csv), outputPath!, what, client.requestId);
  const data = {
    path: file.path, bytes: file.bytes, rows: file.rows, sha256: file.sha256, content_type: "text/csv",
    campaign_id: id,
    ...(typeof report.from === "string" ? { from: report.from } : {}),
    ...(typeof report.to === "string" ? { to: report.to } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: truncated ? [truncation] : [] }),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Direct campaign report exported", [
        ["path", file.path], ["rows", String(file.rows)], ["bytes", String(file.bytes)], ["sha256", file.sha256],
      ]),
      ...(truncated ? [`warning: ${truncation.message}`] : []),
    ].join("\n"),
  };
});

export const handleAdsReportsFill = commandHandler(async (args, runtime, resolved) => {
  const window = adsWindow(args, runtime, FILL_MAX_RANGE_MS);
  const fillFile = await reportFileOf(args, runtime, resolved, "/api/advertising/reports/fill", window, "ad-fill", "ad fill report");
  if (fillFile) return fillFile;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/advertising/reports/fill", query: window });
  requirePrivateNoStore(response.headers, "Advertising report response");
  const report = response.body && typeof response.body === "object" && !Array.isArray(response.body) ? response.body as Record<string, unknown> : {};
  const lines = humanLines("Ad slot fill", [
    ["period", typeof report.from === "string" && typeof report.to === "string" ? `${report.from} to ${report.to}` : undefined],
    ...(["occurrences", "direct", "marketplace", "vast", "unfilled", "fill_rate"] as const).map((field): [string, string | undefined] =>
      [field, typeof report[field] === "number" ? String(report[field]) : undefined]),
  ]).split("\n");
  const reasons = report.unfilled_reasons;
  if (reasons && typeof reasons === "object" && !Array.isArray(reasons)) {
    lines.push(`unfilled_reasons: ${Object.entries(reasons).map(([reason, count]) => `${reason}=${count}`).join(" ")}`);
  }
  if (Array.isArray(report.days)) {
    lines.push("days:");
    for (const value of report.days) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const day = value as Record<string, unknown>;
      lines.push(`  ${["day", "occurrences", "direct", "marketplace", "vast", "unfilled", "fill_rate"].map((field) => `${field}=${day[field] ?? ""}`).join(" ")}`);
    }
  }
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: lines.join("\n") };
});
