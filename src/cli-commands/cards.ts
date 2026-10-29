import { type Command, Argument, Option } from "commander";
import {
  cardId, cardUid, feedListOption, FEED_AREA_UNKNOWN, FEED_CERTAINTIES, FEED_FAMILIES, FEED_SCOPES, FEED_SEVERITIES, FEED_STATUSES, FEED_URGENCIES,
} from "../cards.js";
import { handleCardPreview, handleCardCreate, handleCardList, handleCardShow, handleCardParams, handleCardDelete, handleCardInstanceDataGet, handleCardInstanceDataPut, handleCardsList, handleCardsShow, handleFeedsGet } from "../handlers/cards.js";
import { positiveInteger, revision } from "./options.js";
import { requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";
import { cardTtl } from "../card-expiry.js";

export function registerCardsCommands(root: Command, bind: CommandActionBinder): void {
  const cards = root.command("cards").description("Discover cards and their property schemas");
  cards.command("list").description("List cards, optionally matching a tag and category")
    .option("--tag <TAG>", "Match a catalogue tag")
    .option("--category <CATEGORY>", "Match a catalogue category")
    .action(bind(handleCardsList));
  cards.command("show").description("Inspect static and dynamic properties, tier, layouts, feed and an example placement")
    .argument("<id>", "Catalogue card id", cardId).action(bind(handleCardsShow));

  const card = root.command("card").description("Create and manage card instances");
  card.command("preview").description("Render a card locally with Chromium; inspect the PNG before publishing")
    .argument("<type|id>", "Catalogue type or card instance ID")
    .requiredOption("--output <FILE>", "Write the local PNG")
    .option("--params <FILE>", "Static properties as JSON")
    .option("--data <FILE>", "Dynamic document as JSON")
    .option("--feed <FILE>", "Host feed document as JSON; omitted feeds are reported")
    .option("--width <PX>", "Image width (default 1920)", positiveInteger("width"))
    .option("--height <PX>", "Image height (default 1080)", positiveInteger("height"))
    .option("--layout <LAYOUT>", "Card layout to draw")
    .option("--anchor <ANCHOR>", "Corner or strip edge")
    .option("--now <ISO>", "Freeze the clock at this instant")
    .option("--timezone <ZONE>", "Render in this IANA timezone")
    .action(bind(handleCardPreview));
  card.command("create").description("Create a card instance in the selected project")
    .requiredOption("--type <ID>", "Catalogue type from cards list", cardId)
    .option("--major <N>", "Select a catalogue major version", positiveInteger("major"))
    .requiredOption("--file <FILE>", "Read static params as a JSON object, or - for stdin")
    .action(bind(handleCardCreate));
  card.command("list").description("List card instances across all pages").action(bind(handleCardList));
  card.command("show").description("Read a card instance by its global ID").argument("<id>", "Card instance ID (crd_...)", cardUid).action(bind(handleCardShow));
  card.command("params").description("Replace a card instance's static params")
    .argument("<id>", "Card instance ID (crd_...)", cardUid)
    .requiredOption("--file <FILE>", "Read static params as a JSON object, or - for stdin").action(bind(handleCardParams));
  card.command("delete").description("Delete a card instance that no playlist uses")
    .argument("<id>", "Card instance ID (crd_...)", cardUid).action(bind(handleCardDelete));
  const instanceData = card.command("data").description("Read and replace a card instance's dynamic data");
  instanceData.command("get").description("Read dynamic data and its revision")
    .argument("<id>", "Card instance ID (crd_...)", cardUid).action(bind(handleCardInstanceDataGet));
  const instancePut = instanceData.command("put").description("Create or replace dynamic data")
    .argument("<id>", "Card instance ID (crd_...)", cardUid)
    .requiredOption("--file <FILE>", "Read a JSON object, or - for stdin")
    .option("--ttl <DURATION>", "Blank data after this long, including offline: 30m, 12h or 1d", cardTtl)
    .option("--expires-at <INSTANT>", "Blank data at this ISO timestamp with timezone")
    .option("--expect-rev <REVISION>", "Require the current data revision (If-Match)", revision).action(bind(handleCardInstanceDataPut));
  requireOptionGroup(instancePut, "atMostOne", ["--ttl", "--expires-at"]);

  const feeds = root.command("feeds").description("Read third-party data fetched and cached by screenRIG");
  const get = feeds.command("get").description("Read a feed once; report pending and its retry time")
    .addArgument(new Argument("<family>", "Feed family").choices([...FEED_FAMILIES]))
    .option("--lat <DEGREES>", "Latitude for weather, airquality, alerts, earthquakes, cyclones or cap")
    .option("--lon <DEGREES>", "Longitude for weather, airquality, alerts, earthquakes, cyclones or cap")
    .option("--radius-km <KM>", "Earthquake radius (default 500) or cyclone area, 10–20000 km")
    .option("--min-magnitude <MAGNITUDE>", "Earthquakes: least magnitude, 0–9 (default 2.5)")
    .option("--hours <HOURS>", "Earthquakes: window in hours, 1–168 (default 24)")
    .option("--basins <LIST>", "Cyclones: comma-separated basins at, ep, cp, wp (default all)")
    .option("--base <CODE>", "Rates base currency (default EUR)")
    .option("--symbols <IDS>", "Comma-separated crypto ids or tickers, at most 20")
    .option("--currency <CODE>", "Crypto quote currency (default usd)")
    .addOption(new Option("--url <URL>", "RSS or Atom feed URL for headlines; for cap, a CAP alert or ATOM/RSS index URL (repeatable, at most 5)").argParser(feedListOption("url", 2048)))
    .option("--public", "Cap: also read the public alert feeds that cover --lat and --lon (the default without --url)")
    .addOption(new Option("--geocode <NAME:VALUE>", "Cap: an area code of the location, such as UGC:WAC033 (repeatable)").argParser(feedListOption("geocode", 140)))
    .addOption(new Option("--min-severity <LEVEL>", "Cap: only alerts at or above this severity").choices([...FEED_SEVERITIES]))
    .addOption(new Option("--max-severity <LEVEL>", "Cap: only alerts at or below this severity").choices([...FEED_SEVERITIES]))
    .addOption(new Option("--min-urgency <LEVEL>", "Cap: only alerts at least this urgent").choices([...FEED_URGENCIES]))
    .addOption(new Option("--min-certainty <LEVEL>", "Cap: only alerts at least this certain").choices([...FEED_CERTAINTIES]))
    .addOption(new Option("--event <NAME>", "Cap: only this event, * matches any run of characters (repeatable)").argParser(feedListOption("event", 120)))
    .addOption(new Option("--exclude-event <NAME>", "Cap: leave out this event (repeatable)").argParser(feedListOption("exclude-event", 120)))
    .addOption(new Option("--sender <NAME>", "Cap: only alerts from this sender (repeatable)").argParser(feedListOption("sender", 120)))
    .addOption(new Option("--status <STATUS>", "Cap: alert status to read, default Actual (repeatable)").choices([...FEED_STATUSES]).argParser(feedListOption("status", 16, FEED_STATUSES)))
    .addOption(new Option("--scope <SCOPE>", "Cap: alert scope to read, default Public (repeatable)").choices([...FEED_SCOPES]).argParser(feedListOption("scope", 16, FEED_SCOPES)))
    .addOption(new Option("--language <TAG>", "Cap: language preference, the first present wins (repeatable)").argParser(feedListOption("language", 35)))
    .addOption(new Option("--area-unknown <MODE>", "Cap: an alert told only by area codes the location lacks: hide (default) or show").choices([...FEED_AREA_UNKNOWN]))
    .action(bind(handleFeedsGet));
  requireOptionGroup(get, "together", ["--lat", "--lon"]);
  requireOptionGroup(get, "requires", ["--radius-km", "--lat", "--lon"]);
  requireOptionGroup(get, "requires", ["--public", "--lat", "--lon"]);
  requireOptionGroup(get, "requires", ["--geocode", "--lat", "--lon"]);
}
