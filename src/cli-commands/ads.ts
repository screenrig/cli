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
  handleAdsReportsSpend,
  handleAdsReviewsApprove,
  handleAdsReviewsList,
  handleAdsReviewsReject,
  handleAdsReviewsShow,
  handleAdsSlotsCreate,
  handleAdsSlotsList,
  handleAdsSlotsUpdate,
} from "../commands.js";
import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { positiveInteger, revision } from "./options.js";

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
    .action(bind(handleAdsInventoryUpdate));
  requireOptionGroup(inventoryUpdate, "atLeastOne", [
    "--enabled", "--disabled", "--site-name", "--city", "--region", "--venue-type",
    "--audience-tags", "--placement", "--public-description", "--rate-mcr-per-15s", "--clear-rate",
  ]);
  addCommandNotes(inventoryUpdate, "The stored row is read first, then written as a whole record: flags you omit keep the current opt-in flag, price override, and public metadata, and the row's current revision is sent as the precondition. When no row exists yet the supplied fields create it (a new row requires --enabled or --disabled) and --expect-rev has nothing to check.");

  const slots = ads.command("slots").description("Manage the reusable ad slots this seller offers");
  slots.command("list").description("List this seller project's slot definitions")
    .action(bind(handleAdsSlotsList));
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
    .addOption(new Option("--clear-rate", "Remove this slot's rate override and inherit the screen or project rate").conflicts("rateMcrPer15s"));
  const slotsCreate = slotFields(slots.command("create").description("Create a reusable slot definition")
    .action(bind(handleAdsSlotsCreate)), true);
  const slotsUpdate = slotFields(slots.command("update").description("Update a reusable slot definition")
    .argument("<slot-id>", "Slot identifier")
    .requiredOption("--expect-rev <REVISION>", "Current slot revision (required)", revision)
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
  creatives.command("show").description("Inspect one creative and its review state")
    .argument("<creative-id>", "Creative identifier")
    .action(bind(handleAdsCreativesShow));
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
    addCommandNotes(command, "A saved draft authorizes nothing: no credits are reserved and no ad can play until an accepted, unexpired quote activates it. The draft chooses the image display duration (`image_duration_ms`, 5000–30000 ms, ten seconds when omitted) and an optional per-play price ceiling (`max_play_price_mcr`, a decimal mcr string; omit it for no extra ceiling). Money fields are decimal mcr strings, never numbers.");
  }
  addCommandNotes(campaignPreview, "Preview is the acceptance artifact: it prices the current inventory and rates and spends, reserves, and activates nothing. The quote is revision-checked against the campaign revision the CLI just read, or the one you pass with --expect-rev. Rates can change before activation: accept the quote you were shown, never a silent replacement.");
  addCommandNotes(campaignActivate, "Activation requires explicit acceptance of this exact quote. It atomically checks ownership, current invitation authority, quote expiry, and pricing revisions; no wallet debit or seller revenue happens just from accepting terms.");
  addCommandNotes(campaignAcceptRates, "Only the buyer's explicit acceptance resumes a campaign paused by a seller rate change. A top-up, price ceiling, schedule tick, or ordinary resume cannot supply that consent, and a stale quote is rejected rather than accepted at another price.");
  addCommandNotes(campaignPause, "Pausing stops new reservations. Already-started valid plays normally finish and settle at their reserved price.");

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
  for (const command of [reviewApprove, reviewReject]) {
    addCommandNotes(command, "Approval covers the exact submitted version only. It does not choose the buyer's budget or grant access to its media library; editing the pixels requires a new version and a new decision.");
  }

  const reports = ads.command("reports").description("Read delivery and spend for this project");
  const reportSpend = reports.command("spend").description("Read buyer ad spend for one campaign")
    .requiredOption("--campaign-id <ID>", "Campaign to report")
    .action(bind(handleAdsReportsSpend));
  const reportDelivery = reports.command("delivery").description("Read seller delivery and gross/fee/net for a period")
    .requiredOption("--from <TIMESTAMP>", "Inclusive RFC 3339 start of the reporting period")
    .requiredOption("--to <TIMESTAMP>", "Exclusive RFC 3339 end of the reporting period")
    .action(bind(handleAdsReportsDelivery));
  addCommandNotes(reportSpend, "A buyer report shows this project's own debit and campaign evidence, never a seller's other income or project-wide usage. Money is reported as decimal mcr strings.");
  addCommandNotes(reportDelivery, "A seller report shows gross ad income, the serving-fee debit, and net credits for this project's own delivery, with one row per completed occurrence. Normal project costs consume the shared balance.");
}
