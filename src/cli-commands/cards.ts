import { type Command, Argument } from "commander";
import { cardId, cardDataKey } from "../cards.js";
import { handleCardsList, handleCardsShow, handleCardDataGet, handleCardDataPut, handleCardDataList, handleCardDataDelete, handleFeedsGet } from "../commands.js";
import { revision } from "./options.js";
import { requireOptionGroup } from "./notes.js";
import type { CommandActionBinder } from "./types.js";

export function registerCardsCommands(root: Command, bind: CommandActionBinder): void {
  const cards = root.command("cards").description("Discover built-in cards and their property schemas");
  cards.command("list").description("List built-in cards, optionally matching a tag and category")
    .option("--tag <TAG>", "Match a catalogue tag")
    .option("--category <CATEGORY>", "Match a catalogue category")
    .action(bind(handleCardsList));
  cards.command("show").description("Inspect static and dynamic properties, views, feed and an example placement")
    .argument("<id>", "Catalogue card id", cardId).action(bind(handleCardsShow));

  const data = root.command("card-data").description("Read and write dynamic data for built-in cards");
  data.command("get").description("Read a card data document and its revision")
    .argument("<key>", "Card data key", cardDataKey).action(bind(handleCardDataGet));
  data.command("put").description("Create or replace a card data document")
    .argument("<key>", "Card data key", cardDataKey)
    .requiredOption("--file <FILE>", "Read a JSON object from a file, or - for stdin")
    .option("--expect-rev <REVISION>", "Require the current document revision (If-Match)", revision)
    .action(bind(handleCardDataPut));
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
