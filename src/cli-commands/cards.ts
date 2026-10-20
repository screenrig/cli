import { type Command, Argument } from "commander";
import { cardId, cardUid, cardDataKey } from "../cards.js";
import { handleCardPreview, handleCardCreate, handleCardList, handleCardShow, handleCardParams, handleCardDelete, handleCardInstanceDataGet, handleCardInstanceDataPut, handleCardsList, handleCardsShow, handleCardDataGet, handleCardDataPut, handleCardDataList, handleCardDataDelete, handleFeedsGet } from "../commands.js";
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

  const data = root.command("card-data").description("Read and write dynamic data for cards");
  data.command("get").description("Read a card data document and its revision")
    .argument("<key>", "Card data key", cardDataKey).action(bind(handleCardDataGet));
  const dataPut = data.command("put").description("Create or replace a card data document")
    .argument("<key>", "Card data key", cardDataKey)
    .requiredOption("--file <FILE>", "Read a JSON object from a file, or - for stdin")
    .option("--ttl <DURATION>", "Blank data after this long: 30m, 12h or 1d", cardTtl)
    .option("--expires-at <INSTANT>", "Blank data at this ISO timestamp with timezone")
    .option("--expect-rev <REVISION>", "Require the current document revision (If-Match)", revision)
    .action(bind(handleCardDataPut));
  requireOptionGroup(dataPut, "atMostOne", ["--ttl", "--expires-at"]);
  data.command("list").description("List card data keys and revisions across all pages")
    .action(bind(handleCardDataList));
  data.command("delete").description("Delete a card data document at its current revision")
    .argument("<key>", "Card data key", cardDataKey)
    .requiredOption("--expect-rev <REVISION>", "Require the revision read with card-data get (If-Match)", revision)
    .action(bind(handleCardDataDelete));

  const feeds = root.command("feeds").description("Read third-party data fetched and cached by screenRIG");
  const get = feeds.command("get").description("Read a feed once; report pending and its retry time")
    .addArgument(new Argument("<family>", "Feed family").choices(["weather", "airquality", "alerts", "rates", "crypto", "earthquakes", "headlines"]))
    .option("--lat <DEGREES>", "Latitude for weather, airquality, alerts or earthquakes")
    .option("--lon <DEGREES>", "Longitude for weather, airquality, alerts or earthquakes")
    .option("--radius-km <KM>", "Earthquake radius, 10–20000 km (default 500)")
    .option("--base <CODE>", "Rates base currency (default EUR)")
    .option("--symbols <IDS>", "Comma-separated crypto ids or tickers, at most 20")
    .option("--currency <CODE>", "Crypto quote currency (default usd)")
    .option("--url <URL>", "RSS or Atom feed URL for headlines")
    .action(bind(handleFeedsGet));
  requireOptionGroup(get, "together", ["--lat", "--lon"]);
  requireOptionGroup(get, "requires", ["--radius-km", "--lat", "--lon"]);
}
