import { type Command, Option } from "commander";
import { cardUid } from "../cards.js";
import { addCommandExamples, addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  accumulate, handleSourceCreate, handleSourceDelete, handleSourceList, handleSourceRefresh, handleSourceRooms, handleSourceShow, handleSourceTest, handleSourceUpdate,
  secretPairCheck, setPairCheck, SOURCE_KINDS, sourceName, sourceRefreshOption, sourceStaleAfterOption, unsetSecretCheck,
} from "../sources.js";

const nameOption = (value: string): string => sourceName(value);

const CONFIG_HELP = "The source's config (the kind's settings) as a JSON object, @FILE to read it from a file, or - for stdin";
const SET_HELP = "Set one top-level config member (repeatable): the value is JSON when it parses (days=14, calendars='[{\"key\":\"lobby\"}]'), else text (time_zone=America/Vancouver)";
const STALE_HELP = "How long the card keeps the last good data when the source cannot refresh, 1m to 7d, or none to keep it until the next refresh. After that the data expires on every screen and pages that depend on it fall back (momentus defaults to 30m)";
const SECRET_HELP = "A credential by name (repeatable): NAME=@FILE reads it from a file, NAME=- from stdin (at most one option reads stdin), NAME=VALUE is the literal value. Stored sealed and shown back only as a masked hint";

export function registerSourceCommands(root: Command, bind: CommandActionBinder): void {
  const source = root.command("source").description("Keep a card live from an outside address, such as a calendar");
  addCommandNotes(source, [
    "Data sources:",
    "  A data source reads an outside address on a schedule and writes the result to",
    "  one card's dynamic properties, so the card stays current without anyone",
    "  republishing: screens refetch the document when it changes. One source writes",
    "  one card, and a project has at most 200. Kinds: ics (iCalendar and webcal://",
    "  addresses: Google, Outlook, iCloud and Nextcloud calendars into an events card,",
    "  or a study-rooms card with one room per calendar), sheets, csv, json,",
    "  microsoft365, google_calendar, momentus, square and shopify.",
    "  Create the card first (card create), preview with source test, then source",
    "  create. A fetch or validation failure never writes and keeps the last good documents;",
    "  the status shows the error. Status ok means the last fetch succeeded and the card",
    "  accepted the document; it does not judge whether the upstream data is right or",
    "  current, nor whether any screen shows the card.",
    "  A calendar address is a credential. Give it as --secret calendar_url.KEY=@FILE",
    "  (or - for stdin) so it stays out of your shell history and process list; it is",
    "  stored sealed and shown back only as scheme and host.",
    "  A sheets, csv or json source fills any card: its settings carry a mapping that",
    "  builds the card's data from the rows (rows, columns, by_key) or the JSON answer",
    "  (body, by_key). A Google Sheet needs no key: share it with Anyone with the link, or",
    "  publish it to the web. A token or API key for a csv or json address goes as",
    "  --secret token=@FILE and is sent only to the address's own origin. Preview a",
    "  mapping with source test before source create. Set key_template to, for example,",
    "  room-{screen.field.room} to write a mapped documents array of {fields,document}",
    "  objects. Use the same template as the card placement data; each screen reads",
    "  only the key filled from its own fields. A failed storage write can leave a",
    "  partial batch; refresh again to resume.",
    "  A microsoft365 or google_calendar source reads meeting-room calendars into a room",
    "  or room-board card with your own Microsoft Entra app (--secret client_secret=@FILE)",
    "  or Google service account (--secret service_account_key=@FILE, the JSON key file).",
    "  They only read: source test shows the bookings and per-room counts it read.",
    "  A momentus source reads the functions and spaces of a Momentus Enterprise venue",
    "  (formerly Ungerboeck, EBMS) with an API user (--secret api_key=@FILE and",
    "  --secret api_secret=@FILE, both GUIDs; settings base_url, organization, api_user).",
    "  It fills an events, room-board or room card, and with room_key_prefix it also",
    "  writes a document per room for each screen to read through its own room field;",
    "  source rooms lists the rooms no screen shows and the screens that name no room.",
    "  A source that cannot refresh keeps its last good data for --stale-after (30m for",
    "  momentus), then the data expires on every screen and pages that depend on it",
    "  fall back; notifications on source_failed and source_stale say when.",
    "  A square or shopify source reads a till's menu into a menu or price-matrix card",
    "  with the merchant's token (--secret access_token=@FILE; shopify also takes",
    "  client_secret with a client_id setting). Sold-out items follow the till.",
    "  The settings of each kind, the status codes and the privacy rules are at",
    "  https://screenrig.ai/docs/sources.",
  ].join("\n"));

  const list = source.command("list").description("List this project's data sources with their status")
    .option("--after <CURSOR>", "Continue from the data.next_cursor of the previous page")
    .action(bind(handleSourceList));
  addCommandExamples(list, "screenrig source list");

  const show = source.command("show").description("Inspect one data source: settings, masked secrets, last run and last error")
    .argument("<source_id>", "Data source identifier (src_...)")
    .action(bind(handleSourceShow));
  addCommandExamples(show, "screenrig source show src_SOURCE");

  const create = source.command("create").description("Create a data source that keeps one card live; it runs within seconds")
    .addOption(new Option("--kind <KIND>", "Where the data comes from").choices([...SOURCE_KINDS]).makeOptionMandatory())
    .requiredOption("--card <CARD_ID>", "The card instance to write (crd_...); one source per card", cardUid)
    .requiredOption("--name <NAME>", "Name the source, 1 to 80 characters", nameOption)
    .option("--settings <JSON|@FILE|->", CONFIG_HELP)
    .option("--set <KEY=VALUE>", SET_HELP, accumulate(setPairCheck))
    .option("--secret <NAME=VALUE>", SECRET_HELP, accumulate(secretPairCheck))
    .option("--refresh <DURATION>", "How often to sync, 30s to 24h (default and floor depend on the kind; ics is 5m, momentus 1m)", sourceRefreshOption)
    .option("--stale-after <DURATION|none>", STALE_HELP, sourceStaleAfterOption)
    .option("--disabled", "Create it disabled; nothing is fetched until source update --enable")
    .action(bind(handleSourceCreate));
  addCommandExamples(create,
    "screenrig source create --kind ics --card crd_CARD --name \"Lobby calendar\" --set calendars='[{\"key\":\"lobby\"}]' --set time_zone=America/Vancouver --secret calendar_url.lobby=@lobby.url",
    "screenrig source create --kind ics --card crd_ROOMS --name \"Study rooms\" --settings @rooms.json --secret calendar_url.room1=@room1.url --secret calendar_url.room2=@room2.url --refresh 2m",
    "screenrig source create --kind sheets --card crd_MENU --name \"Cafe menu\" --settings @menu-sheet.json",
    "screenrig source create --kind json --card crd_KPI --name \"Daily numbers\" --settings @kpi-api.json --secret token=@api.token",
    "screenrig source create --kind momentus --card crd_EVENTS --name \"Venue events\" --settings @momentus.json --secret api_key=@key.guid --secret api_secret=@secret.guid --stale-after 30m",
  );

  const update = source.command("update").description("Change a data source; a change other than a rename resets its failures and runs it again")
    .argument("<source_id>", "Data source identifier (src_...)")
    .option("--name <NAME>", "Rename the source", nameOption)
    .option("--card <CARD_ID>", "Write another card instead", cardUid)
    .option("--settings <JSON|@FILE|->", `Replace the whole config. ${CONFIG_HELP}`)
    .option("--set <KEY=VALUE>", `Change one top-level config member of the saved config (repeatable). ${SET_HELP}`, accumulate(setPairCheck))
    .option("--secret <NAME=VALUE>", `Set or replace a secret (repeatable). ${SECRET_HELP}`, accumulate(secretPairCheck))
    .option("--unset-secret <NAME>", "Remove a secret (repeatable)", accumulate(unsetSecretCheck))
    .option("--refresh <DURATION>", "How often to sync, 30s to 24h", sourceRefreshOption)
    .option("--stale-after <DURATION|none>", STALE_HELP, sourceStaleAfterOption)
    .option("--enable", "Resume the schedule")
    .option("--disable", "Stop the schedule; the card keeps its last document")
    .option("--expect-rev <REVISION>", "Require this source revision; --set guards the revision it read unless you name another", revision)
    .action(bind(handleSourceUpdate));
  requireOptionGroup(update, "atMostOne", ["--enable", "--disable"]);
  addCommandExamples(update,
    "screenrig source update src_SOURCE --set days=14",
    "screenrig source update src_SOURCE --secret calendar_url.lobby=@new.url --refresh 10m",
    "screenrig source update src_SOURCE --stale-after 1h",
    "screenrig source update src_SOURCE --disable",
  );

  const test = source.command("test").description("Preview a source: fetch, shape and validate against the card, without saving or writing anything")
    .argument("[source_id]", "A saved source to test; the other options override it")
    .addOption(new Option("--kind <KIND>", "Where the data comes from (required without source_id)").choices([...SOURCE_KINDS]))
    .option("--card <CARD_ID>", "The card instance to fill (required without source_id)", cardUid)
    .option("--settings <JSON|@FILE|->", CONFIG_HELP)
    .option("--set <KEY=VALUE>", SET_HELP, accumulate(setPairCheck))
    .option("--secret <NAME=VALUE>", SECRET_HELP, accumulate(secretPairCheck))
    .action(bind(handleSourceTest));
  addCommandNotes(test, "Prints the document the source would write, whether the card accepts it, and what the run noticed (a time zone it could not place, events cut at a limit). At most 30 previews a minute per project.");
  addCommandExamples(test,
    "screenrig source test --kind ics --card crd_CARD --set calendars='[{\"key\":\"lobby\"}]' --secret calendar_url.lobby=@lobby.url",
    "screenrig source test src_SOURCE",
    "screenrig source test --kind momentus --card crd_EVENTS --settings @momentus.json --secret api_key=@key.guid --secret api_secret=@secret.guid",
  );

  const refresh = source.command("refresh").description("Sync a source now and show the result; a failed sync never changes the card")
    .argument("<source_id>", "Data source identifier (src_...)")
    .action(bind(handleSourceRefresh));
  addCommandNotes(refresh, "Runs inline (up to 60 seconds), resets the failure count and reads the address in full. source_busy (exit 5) while a scheduled sync is running. At most 6 a minute per source.");
  addCommandExamples(refresh, "screenrig source refresh src_SOURCE");

  const rooms = source.command("rooms").description("Room mapping: rooms the source offers that no screen shows, and screens that name no room")
    .argument("<source_id>", "Data source identifier (src_...) of a source that reads a booking system's rooms")
    .action(bind(handleSourceRooms));
  addCommandNotes(rooms, [
    "Reads the rooms of the source's last good refresh (nothing is fetched) and the project's screens.",
    "A screen shows a room through its room field: a playlist card whose data key is the source's",
    "room_key_prefix followed by {screen.field.room} reads the document of the room the field names.",
    "Areas, for a hallway display, work the same through area_key_prefix and the area field.",
    "Each screen that has a value or whose playlist reads the key is listed as mapped, missing (the",
    "playlist reads the field and the screen has none) or unknown (the value names no room; a",
    "suggestion says the room it probably meant). Fix a screen with screen update SCREEN_ID --field room=KEY.",
  ].join("\n"));
  addCommandExamples(rooms, "screenrig source rooms src_SOURCE");

  const remove = source.command("delete").description("Delete a data source; the card keeps the last document it was given")
    .argument("<source_id>", "Data source identifier (src_...)")
    .option("--expect-rev <REVISION>", "Optionally require this source revision", revision)
    .action(bind(handleSourceDelete));
  addCommandExamples(remove, "screenrig source delete src_SOURCE", "screenrig source delete src_SOURCE --expect-rev 3");
}
