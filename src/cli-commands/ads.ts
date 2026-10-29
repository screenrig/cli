import type { CommandActionBinder } from "./types.js";
import {
  handleAdsCampaignsAcceptRates,
  handleAdsCampaignsActivate,
  handleAdsCampaignsCreate,
  handleAdsCampaignsList,
  handleAdsCampaignsPause,
  handleAdsCampaignsPreview,
  handleAdsCampaignsResume,
  handleAdsCampaignsShow,
  handleAdsCampaignsUpdate,
  handleAdsCreativesCreate,
  handleAdsCreativesList,
  handleAdsCreativesShow,
  handleAdsDirectAvailability,
  handleAdsDirectCreate,
  handleAdsDirectEnd,
  handleAdsDirectList,
  handleAdsDirectPause,
  handleAdsDirectReport,
  handleAdsDirectResume,
  handleAdsDirectShow,
  handleAdsDirectUpdate,
  handleAdsInventoryList,
  handleAdsInventoryUpdate,
  handleAdsMembershipsList,
  handleAdsMembershipsRevoke,
  handleAdsMembershipsUpdate,
  handleAdsNetworkCreate,
  handleAdsNetworkInventoryShow,
  handleAdsNetworkRate,
  handleAdsNetworkShow,
  handleAdsNetworksList,
  handleAdsReportsDelivery,
  handleAdsReportsFill,
  handleAdsReportsSpend,
  handleAdsReviewsApprove,
  handleAdsReviewsList,
  handleAdsReviewsReject,
  handleAdsReviewsRequestChanges,
  handleAdsReviewsShow,
  handleAdsSlotsCreate,
  handleAdsSlotsList,
  handleAdsSlotsUpdate,
} from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { decisionNoteOption, nonnegativeNumber, positiveInteger, revision, vastTagUrl } from "./options.js";
import { playsInstantOption } from "../playback-export.js";

/**
 * Advertising commands. Buyer operations act through invited memberships;
 * seller operations act on the calling project's own network and inventory. No
 * command here mutates a wallet: a draft is not spending, and a campaign only
 * becomes deliverable through an explicitly accepted, unexpired quote.
 */
export function registerAdsCommands(root: Command, bind: CommandActionBinder): void {
  const ads = root.command("ads").description("Buy advertising and sell owned inventory");

  const networks = ads.command("networks").description("Inspect the networks this project may buy ads in");
  networks.command("list").description("List invited networks this project has joined")
    .action(bind(handleAdsNetworksList));
  networks.command("show").description("Inspect one joined network's permitted inventory and slots")
    .argument("<seller-project-id>", "Seller project that owns the network")
    .action(bind(handleAdsNetworkInventoryShow));

  const network = ads.command("network").description("Inspect or configure this project's own seller network");
  network.command("show").description("Inspect this seller project's network")
    .action(bind(handleAdsNetworkShow));
  network.command("create").description("Create this seller project's network")
    .requiredOption("--name <NAME>", "Network display name")
    .action(bind(handleAdsNetworkCreate));
  const rate = network.command("rate").description("Set the network default rate per 15 seconds")
    .requiredOption("--rate-mcr-per-15s <MCR>", "Positive integer mcr rate per 15 seconds of completed playback", positiveInteger("rate-mcr-per-15s"))
    .requiredOption("--expect-rev <REVISION>", "Current network revision (required)", revision)
    .action(bind(handleAdsNetworkRate));
  addCommandNotes(rate, "Changing the effective rate for accepted inventory pauses every affected campaign with price_change_pending. Each buyer must accept a fresh quote before delivery resumes; a top-up, schedule tick, or ordinary resume cannot supply that consent.");

  const inventory = ads.command("inventory").description("Opt this project's screens in or out of advertising and describe them");
  inventory.command("list").description("List this seller project's advertising inventory")
    .action(bind(handleAdsInventoryList));
  const inventoryUpdate = inventory.command("update").description("Update one screen's advertising inventory")
    .argument("<screen-id>", "Owned screen identifier")
    .addOption(new Option("--enabled", "Enable paid advertising on this screen").conflicts("disabled"))
    .addOption(new Option("--disabled", "Stop offering paid advertising on this screen").conflicts("enabled"))
    .option("--site-name <NAME>", "Public site name")
    .option("--city <CITY>", "City")
    .option("--region <REGION>", "Region or province")
    .option("--venue-type <TYPE>", "Venue type")
    .option("--audience-tags <TOKENS>", "Comma-separated public audience tags (at most 20 tokens, 32 characters each)")
    .option("--placement <TEXT>", "Physical placement of this screen at the venue")
    .option("--expect-rev <REVISION>", "Override the precondition with this inventory revision", revision)
    .option("--public-description <TEXT>", "Public description shown to invited buyers")
    .addOption(new Option("--rate-mcr-per-15s <MCR>", "Positive integer mcr rate override per 15 seconds").argParser(positiveInteger("rate-mcr-per-15s")).conflicts("clearRate"))
    .addOption(new Option("--clear-rate", "Remove this screen's rate override and inherit the project default").conflicts("rateMcrPer15s"))
    .addOption(new Option("--impressions-per-hour <N>", "Estimated impressions this screen delivers per hour (0 or more)").argParser(nonnegativeNumber("impressions-per-hour")).conflicts("clearImpressionsPerHour"))
    .addOption(new Option("--clear-impressions-per-hour", "Remove this screen's impressions estimate").conflicts("impressionsPerHour"))
    .action(bind(handleAdsInventoryUpdate));
  requireOptionGroup(inventoryUpdate, "atLeastOne", [
    "--enabled", "--disabled", "--site-name", "--city", "--region", "--venue-type",
    "--audience-tags", "--placement", "--public-description", "--rate-mcr-per-15s", "--clear-rate",
    "--impressions-per-hour", "--clear-impressions-per-hour",
  ]);
  addCommandNotes(inventoryUpdate, "The stored row is read first, then written as a whole record: flags you omit keep the current opt-in flag, price override, impressions estimate, and public metadata, and the row's current revision is sent as the precondition. When no row exists yet the supplied fields create it (a new row requires --enabled or --disabled) and --expect-rev has nothing to check. --impressions-per-hour sets the screen's estimate of impressions per hour; reports count each completed play as that estimate times the seconds played over 3600 in estimated_impressions, and --clear-impressions-per-hour removes the estimate.");

  const slots = ads.command("slots").description("Manage the reusable ad slots this seller offers");
  slots.command("list").description("List this seller project's slot definitions")
    .action(bind(handleAdsSlotsList));
  const VAST_HELP = "The seller's own VAST 2-4 ad tag (HTTPS), tried when no invited campaign fills this slot; the slot must accept video";
  const slotFields = (command: Command, create: boolean): Command => command
    .addOption(new Option("--enabled", "Enable this slot (the default for a new slot)").conflicts("disabled"))
    .addOption(new Option("--disabled", "Keep this slot unavailable for paid playback").conflicts("enabled"))
    .addOption(create
      ? new Option("--name <NAME>", "Slot display name (required)").makeOptionMandatory()
      : new Option("--name <NAME>", "Slot display name"))
    .addOption(create
      ? new Option("--accepted-media <KINDS>", "Comma-separated accepted media: image, video (required)").makeOptionMandatory()
      : new Option("--accepted-media <KINDS>", "Comma-separated accepted media: image, video"))
    .option("--max-image-duration-ms <MS>", "Longest accepted image duration", positiveInteger("max-image-duration-ms"))
    .option("--max-video-duration-ms <MS>", "Longest accepted finite video duration", positiveInteger("max-video-duration-ms"))
    .addOption(new Option("--rate-mcr-per-15s <MCR>", "Positive integer mcr rate override for this slot").argParser(positiveInteger("rate-mcr-per-15s")).conflicts("clearRate"))
    .addOption(new Option("--clear-rate", "Remove this slot's rate override and inherit the screen or project rate").conflicts("rateMcrPer15s"))
    .addOption(create
      ? new Option("--vast-tag-url <URL>", VAST_HELP).argParser(vastTagUrl)
      : new Option("--vast-tag-url <URL>", VAST_HELP).argParser(vastTagUrl).conflicts("clearVastTagUrl"));
  const slotsCreate = slotFields(slots.command("create").description("Create a reusable slot definition")
    .action(bind(handleAdsSlotsCreate)), true);
  const slotsUpdate = slotFields(slots.command("update").description("Update a reusable slot definition")
    .argument("<slot-id>", "Slot identifier")
    .requiredOption("--expect-rev <REVISION>", "Current slot revision (required)", revision)
    .addOption(new Option("--clear-vast-tag-url", "Remove this slot's VAST tag").conflicts("vastTagUrl"))
    .action(bind(handleAdsSlotsUpdate)), false);
  addCommandNotes(slotsCreate, "Creating a slot definition does not put an ad break into any playlist: place an adslot page through playlist authoring. Omitted duration limits adopt the server defaults: images up to 30000 ms and finite videos up to 30000 ms.");
  addCommandNotes(slotsUpdate, "The stored definition is read first, then written as a whole record: flags you omit keep the current accepted formats, duration limits, and rate override. A changed effective rate installs a pricing barrier that pauses affected campaigns with price_change_pending until each buyer accepts a fresh quote.");

  const memberships = ads.command("memberships").description("Manage buyers admitted to this seller's network");
  memberships.command("list").description("List this seller project's memberships")
    .action(bind(handleAdsMembershipsList));
  memberships.command("update").description("Change one membership's policy or inventory scope")
    .argument("<membership-id>", "Membership identifier")
    .addOption(new Option("--policy <POLICY>", "Review policy").choices(["trusted", "review_required"]))
    .option("--screen-id <IDS>", "Comma-separated allowed screen identifiers (empty means no screen)")
    .option("--slot-id <IDS>", "Comma-separated allowed slot identifiers (empty means no slot)")
    .requiredOption("--expect-rev <REVISION>", "Current membership revision (required)", revision)
    .action(bind(handleAdsMembershipsUpdate));
  addCommandNotes(memberships.commands.find((command) => command.name() === "update")!, "The stored membership is read first: an omitted --policy keeps the current review policy, and an omitted scope list keeps the buyer's stored screen and slot access instead of clearing it.");
  memberships.command("revoke").description("Revoke a membership")
    .argument("<membership-id>", "Membership identifier")
    .action(bind(handleAdsMembershipsRevoke));

  const creatives = ads.command("creatives").description("Bind ready owned media to an immutable advertising creative");
  creatives.command("list").description("List this buyer project's creatives")
    .action(bind(handleAdsCreativesList));
  const creativeCreate = creatives.command("create").description("Create a creative from ready owned media")
    .requiredOption("--media-id <ID>", "Ready media identifier owned by this project")
    .requiredOption("--copy <TEXT>", "Approved copy shown with the creative")
    .action(bind(handleAdsCreativesCreate));
  const creativeShow = creatives.command("show").description("Inspect one creative and its review state")
    .argument("<creative-id>", "Creative identifier")
    .action(bind(handleAdsCreativesShow));
  addCommandNotes(creativeShow, "reviews lists each seller network's decision on a revision of this creative (pending, approved, rejected or changes_requested) with the seller's reason for a rejection or a change request. Human output prints one line per review.");
  addCommandNotes(creativeCreate, "Binding a creative neither charges nor uploads the media again. An approved creative never changes pixels in place: edit the source media and bind a new creative version.");

  const campaigns = ads.command("campaigns").description("Draft, price, activate, and operate buyer campaigns");
  campaigns.command("list").description("List this buyer project's campaigns")
    .action(bind(handleAdsCampaignsList));
  campaigns.command("show").description("Inspect one campaign")
    .argument("<campaign-id>", "Campaign identifier")
    .action(bind(handleAdsCampaignsShow));
  const campaignCreate = campaigns.command("create").description("Create a campaign draft from a JSON document")
    .argument("<file>", "Campaign draft JSON file, or - for stdin")
    .action(bind(handleAdsCampaignsCreate));
  const campaignUpdate = campaigns.command("update").description("Replace a campaign draft from a JSON document")
    .argument("<campaign-id>", "Campaign identifier")
    .argument("<file>", "Campaign draft JSON file, or - for stdin")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsCampaignsUpdate));
  const campaignActivate = campaigns.command("activate").description("Activate a campaign under an accepted quote")
    .argument("<campaign-id>", "Campaign identifier")
    .requiredOption("--quote-id <ID>", "Quote identifier returned by campaigns preview")
    .requiredOption("--expect-rev <REVISION>", "Campaign revision the quote priced (required)", revision)
    .action(bind(handleAdsCampaignsActivate));
  const campaignPreview = campaigns.command("preview").description("Quote the campaign's current inventory and prices")
    .argument("<campaign-id>", "Campaign identifier")
    .option("--expect-rev <REVISION>", "Override the precondition with this campaign revision", revision)
    .action(bind(handleAdsCampaignsPreview));
  const campaignPause = campaigns.command("pause").description("Pause a campaign")
    .argument("<campaign-id>", "Campaign identifier")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsCampaignsPause));
  campaigns.command("resume").description("Resume a manually paused campaign")
    .argument("<campaign-id>", "Campaign identifier")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsCampaignsResume));
  const campaignAcceptRates = campaigns.command("accept-rates").description("Accept a fresh quote and resume after a seller rate change")
    .argument("<campaign-id>", "Campaign identifier")
    .requiredOption("--quote-id <ID>", "Fresh quote identifier for the changed rates")
    .requiredOption("--expect-rev <REVISION>", "Campaign revision the fresh quote priced (required)", revision)
    .action(bind(handleAdsCampaignsAcceptRates));
  for (const command of [campaignCreate, campaignUpdate]) {
    addCommandNotes(command, "The draft JSON needs name, daily_cap_mcr, lifetime_cap_mcr, flight_start and flight_end (RFC 3339), and networks: [{\"seller_project_id\", \"screen_ids\": [...], \"slot_ids\": [...], \"creative_ids\": [...]}], one per seller network this buyer was admitted to. A saved draft authorizes nothing: no credits are reserved and no ad can play until an accepted, unexpired quote activates it. The draft chooses the image display duration (`image_duration_ms`, 5000–30000 ms, ten seconds when omitted) and an optional per-play price ceiling (`max_play_price_mcr`, a decimal mcr string; omit it for no extra ceiling). Money fields are decimal mcr strings, never numbers. An optional `category` (the values are listed under ads direct create) keeps competitors apart: two ads of one category never play in the same ad break on a screen.");
  }
  addCommandNotes(campaignPreview, "Preview is the acceptance artifact: it prices the current inventory and rates and spends, reserves, and activates nothing. The quote is revision-checked against the campaign revision the CLI just read, or the one you pass with --expect-rev. Rates can change before activation: accept the quote you were shown, never a silent replacement.");
  addCommandNotes(campaignActivate, "Activation requires explicit acceptance of this exact quote. It atomically checks ownership, current invitation authority, quote expiry, and pricing revisions; no wallet debit or seller revenue happens just from accepting terms.");
  addCommandNotes(campaignAcceptRates, "Only the buyer's explicit acceptance resumes a campaign paused by a seller rate change. A top-up, price ceiling, schedule tick, or ordinary resume cannot supply that consent, and a stale quote is rejected rather than accepted at another price.");
  addCommandNotes(campaignPause, "Pausing stops new reservations. Already-started valid plays normally finish and settle at their reserved price.");

  const direct = ads.command("direct").description("Run direct campaigns for outside advertisers on this project's own ad slots");
  addCommandNotes(direct, "A direct campaign is this seller's own deal for an outside advertiser on the seller's own ad inventory. It moves no money through screenRIG: the seller bills the advertiser, and the recorded price (cpm per thousand plays, or a flat fee) only values the delivery report. Direct campaigns fill ad slots before marketplace campaigns. A campaign with goal_plays is paced evenly across its flight and plays first while it is behind pace; one without a goal takes every eligible slot during its flight. An optional category keeps competitors apart: two ads of one category never play in the same ad break on a screen.");
  direct.command("list").description("List this seller project's direct campaigns")
    .action(bind(handleAdsDirectList));
  direct.command("show").description("Inspect one direct campaign, its state and pace")
    .argument("<campaign-id>", "Direct campaign identifier")
    .action(bind(handleAdsDirectShow));
  const directCreate = direct.command("create").description("Create a direct campaign from a JSON document")
    .argument("<file>", "Direct campaign draft JSON file, or - for stdin")
    .action(bind(handleAdsDirectCreate));
  const directUpdate = direct.command("update").description("Replace a direct campaign from a JSON document")
    .argument("<campaign-id>", "Direct campaign identifier")
    .argument("<file>", "Direct campaign draft JSON file, or - for stdin")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsDirectUpdate));
  const directPause = direct.command("pause").description("Pause a direct campaign")
    .argument("<campaign-id>", "Direct campaign identifier")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsDirectPause));
  const directResume = direct.command("resume").description("Resume a paused direct campaign")
    .argument("<campaign-id>", "Direct campaign identifier")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsDirectResume));
  const directEnd = direct.command("end").description("End a direct campaign for good")
    .argument("<campaign-id>", "Direct campaign identifier")
    .requiredOption("--expect-rev <REVISION>", "Current campaign revision (required)", revision)
    .action(bind(handleAdsDirectEnd));
  const directReport = direct.command("report").description("Read a direct campaign's delivery and value, or export its rows as CSV")
    .argument("<campaign-id>", "Direct campaign identifier")
    .option("--from <TIME>", "Inclusive start: RFC 3339, now, or an age such as 7d, 12h, 30m (default: the start of the flight)", playsInstantOption("--from"))
    .option("--to <TIME>", "Exclusive end: RFC 3339, now, or an age (default: the end of the flight)", playsInstantOption("--to"))
    .addOption(new Option("--format <FORMAT>", "json (default) or csv").choices(["json", "csv"]))
    .addOption(new Option("--output <FILE>", "CSV file to write (with --format csv; default ./direct-report-CAMPAIGN_ID.csv); - writes the CSV to stdout instead of the envelope"))
    .action(bind(handleAdsDirectReport));
  const directAvailability = direct.command("availability").description("Estimate the plays still available for a targeting and flight")
    .argument("<file>", "Availability query JSON file, or - for stdin")
    .action(bind(handleAdsDirectAvailability));
  for (const command of [directCreate, directUpdate]) {
    addCommandNotes(command, "Writes this project's own direct campaign. The draft JSON needs name, advertiser, flight_start and flight_end (RFC 3339) and media_ids (this project's ready images or videos); it may add category, goal_plays, price {\"model\": \"cpm\" | \"flat\", \"amount\": \"12.50\", \"currency\": \"USD\"}, image_duration_ms, screen_ids, slot_ids, venue_types, cities, tags, dayparts [{\"days\": [\"mon\"], \"start\": \"11:00\", \"end\": \"14:00\"}] and overbook. Targeting lists left empty match every screen and slot. category is one of: alcohol, apparel, automotive, beauty, cannabis, consumer_electronics, education, entertainment, financial_services, food_and_beverage, gambling, government, grocery, health_and_pharma, home_and_garden, insurance, jobs, legal, media, political, quick_service_restaurants, real_estate, restaurants, retail, sports_and_fitness, technology, telecom, tobacco_and_vaping, travel, utilities. Booking a goal_plays larger than the availability estimate is refused with problem goal_overbooked (HTTP 409) unless the draft sets \"overbook\": true; estimate first with ads direct availability.");
  }
  addCommandNotes(directUpdate, "The draft replaces every writable field, so send the whole document, not only the fields that change. The write is checked against --expect-rev.");
  addCommandNotes(directPause, "Writes the campaign's state. A paused campaign takes no ad slots until it is resumed.");
  addCommandNotes(directResume, "Writes the campaign's state. The campaign takes eligible ad slots again within its flight.");
  addCommandNotes(directEnd, "Writes the campaign's state. Ending is final: an ended campaign cannot be resumed, and its report stays readable. Create a new direct campaign to run the ad again.");
  addCommandNotes(directReport, "Reads delivery for one direct campaign: plays, played_ms, plays not played, estimated_impressions, pace, and value, the recorded price applied to the delivery for the seller to bill the advertiser. --format csv writes the rows as day,screen_id,slot_id,media_id,plays,played_ms,estimated_impressions (empty when the screen had no estimate). A report that holds only part of the rows carries the warning direct_report_truncated: narrow --from and --to for the rest.");
  addCommandNotes(directAvailability, "Reads only; nothing is booked. The query JSON takes screen_ids, slot_ids, venue_types, cities, tags, dayparts, flight_start, flight_end and exclude_campaign_id (the campaign being edited, so its own bookings are not counted against it). The answer gives estimated_plays, booked_plays and available_plays for the selected screens.");

  const reviews = ads.command("reviews").description("Decide exact submitted creative versions");
  reviews.command("list").description("List creative versions awaiting this seller's decision")
    .action(bind(handleAdsReviewsList));
  reviews.command("show").description("Inspect one submission's review and its exact creative")
    .argument("<review-id>", "Review identifier")
    .action(bind(handleAdsReviewsShow));
  const reviewApprove = reviews.command("approve").description("Approve one exact creative version")
    .argument("<review-id>", "Review identifier")
    .action(bind(handleAdsReviewsApprove));
  const reviewReject = reviews.command("reject").description("Reject one exact creative version")
    .argument("<review-id>", "Review identifier")
    .requiredOption("--reason <TEXT>", "Reason shown to the buyer")
    .action(bind(handleAdsReviewsReject));
  const reviewRequestChanges = reviews.command("request-changes").description("Ask the buyer for changes to one exact creative version")
    .argument("<review-id>", "Review identifier")
    .requiredOption("--note <TEXT>", "The changes the buyer should make, at most 500 characters (required)", decisionNoteOption)
    .action(bind(handleAdsReviewsRequestChanges));
  for (const command of [reviewApprove, reviewReject, reviewRequestChanges]) {
    addCommandNotes(command, "Approval covers the exact submitted version only. It does not choose the buyer's budget or grant access to its media library; editing the pixels requires a new version and a new decision.");
  }
  addCommandNotes(reviewRequestChanges, "The review becomes changes_requested with the note in reason. The buyer reads it on the creative (ads creatives show), and the campaign's next submission to this network opens a new review that links previous_review_id. Deciding needs Manage, and a person deciding in the dashboard needs to be an approver.");

  const reports = ads.command("reports").description("Read delivery and spend for this project");
  const reportSpend = reports.command("spend").description("Read buyer ad spend for one campaign")
    .requiredOption("--campaign-id <ID>", "Campaign to report")
    .action(bind(handleAdsReportsSpend));
  const reportDelivery = reports.command("delivery").description("Read seller delivery and gross/fee/net for a period")
    .requiredOption("--from <TIMESTAMP>", "Inclusive RFC 3339 start of the reporting period")
    .requiredOption("--to <TIMESTAMP>", "Exclusive RFC 3339 end of the reporting period")
    .action(bind(handleAdsReportsDelivery));
  const reportFill = reports.command("fill").description("Read how this seller's ad slots were filled")
    .option("--from <TIME>", "Inclusive start: RFC 3339, now, or an age such as 7d, 12h, 30m (default 7 days before --to)", playsInstantOption("--from"))
    .option("--to <TIME>", "Exclusive end: RFC 3339, now, or an age (default now); at most 35 days after --from", playsInstantOption("--to"))
    .action(bind(handleAdsReportsFill));
  addCommandNotes(reportFill, "Fill statistics count this project's ad-slot occurrences over up to 35 days: how many were filled by direct campaigns, marketplace campaigns and the slot's VAST tag, how many stayed unfilled and why (no_demand, ineligible, separated, capped), the fill_rate, and the same by day.");
  addCommandNotes(reportSpend, "A buyer report shows this project's own debit and campaign evidence, never a seller's other income or project-wide usage. Money is reported as decimal mcr strings; estimated_impressions appears when a screen carries an impressions estimate.");
  addCommandNotes(reportDelivery, "A seller report shows gross ad income, the serving-fee debit, and net credits for this project's own delivery, with one row per completed occurrence. Normal project costs consume the shared balance. estimated_impressions appears when a screen carries an impressions estimate.");
}
