import { type Command, Option } from "commander";
import { cardUid } from "../cards.js";
import { connectionIdOption } from "../connection-ids.js";
import { addCommandExamples, addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  accumulate, handleSourceCreate, handleSourceDelete, handleSourceList, handleSourceRefresh, handleSourceRooms, handleSourceShow, handleSourceTest, handleSourceUpdate,
  secretPairCheck, setPairCheck, SOURCE_KINDS, sourceName, sourceRefreshOption, sourceStaleAfterOption, unsetSecretCheck,
} from "../sources.js";
import { handleSourcePresets, sourcePresetOption } from "../source-presets.js";

const nameOption = (value: string): string => sourceName(value);

const CONFIG_HELP = "The source's config (the kind's settings) as a JSON object, @FILE to read it from a file, or - for stdin. With --preset: the preset's fields (source presets NAME)";
const SET_HELP = "Set one top-level config member (repeatable): the value is JSON when it parses (days=14, calendars='[{\"key\":\"lobby\"}]'), else text (time_zone=America/Vancouver). With --preset: one field of the preset, text as written unless it is a JSON array or object (a list field's items)";
const PRESET_HELP = "Make the source from a ready-made, tested preset (source presets lists them): --set and --settings then give the preset's fields and --secret its credentials, instead of --kind and a config";
const CONNECTION_HELP = "microsoft365 and google_calendar: read through a project connection (pcn_..., screenrig connection list) instead of tenant, client_id and a secret of this source's own; sets the connection_id member";
const STALE_HELP = "How long the card keeps the last good data when the source cannot refresh, 1m to 7d, or none to keep it until the next refresh. After that the data expires on every screen and pages that depend on it fall back (momentus defaults to 30m)";
const SECRET_HELP = "A credential by name (repeatable): NAME=@FILE reads it from a file, NAME=- from stdin (at most one option reads stdin), NAME=VALUE is the literal value. Stored sealed and shown back only as a masked hint";

export function registerSourceCommands(root: Command, bind: CommandActionBinder): void {
  const source = root.command("source").description("Keep a card live from an outside address, such as a calendar");
  addCommandNotes(source, [
    "Data sources:",
    "  A data source reads an outside address on a schedule and writes the result to",
    "  one card's dynamic properties, so the card stays current without anyone",
    "  republishing: screens refetch the document when it changes. One source writes",
    "  one card, and an organization has at most 200 across its projects. Kinds: ics (iCalendar and webcal://",
    "  addresses: Google, Outlook, iCloud and Nextcloud calendars into an events card,",
    "  or a study-rooms card with one room per calendar), sheets, csv, json,",
    "  microsoft365, google_calendar, momentus, square, shopify and toast.",
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
    "  partial batch; refresh again to resume. A key_template (and a room_key_prefix",
    "  or area_key_prefix) is per-screen keyed data, which needs the",
    "  Premium plan: source create or update that sets one the source does not hold",
    "  answers feature_not_in_plan (exit 8); keeping or clearing it stays open.",
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
    "  A toast source reads a restaurant's menus the same way (settings restaurant, the",
    "  location's GUID that Toast e-mails with its API credentials, client_id and",
    "  environment; --secret client_secret=@FILE) into a menu or price-matrix card.",
    "  A csv or json source can send the request an API expects. Its settings: method",
    "  (GET or POST), body (a JSON object, or text; body_format json or form) or graphql",
    "  {query, variables}, headers (up to 8 plain ones), auth (none, bearer, header,",
    "  basic, oauth2 or token_request), pagination {type link_header, next_url, cursor",
    "  or page, max_pages}, time_zone, and for json format auto, json, csv or xml (an",
    "  RSS or Atom feed also gives body.items). {{now}}, {{today}} and {{unix}}, with an",
    "  offset such as {{today-1d}}, fill in the address, body and headers on every run.",
    "  Secrets are named for what they are: token (bearer or header auth), password",
    "  (basic auth, with a username setting), client_secret (oauth2, and what a",
    "  token_request body reads as {{secrets.client_secret}}), header.NAME (a secret",
    "  request header, such as header.X-Api-Key) and query.NAME (a secret query",
    "  parameter, sent as NAME=value and shown in a preview as NAME=***). source test",
    "  shows the request that went out as data.request: its address, the header names",
    "  and the start of the body, never a secret.",
    "  ics, microsoft365, google_calendar and momentus sources take include and exclude:",
    "  1 to 20 keywords each, matched against event titles only, without regard to case",
    "  or accents. An event stays when it matches an include keyword (if any is set)",
    "  and no exclude keyword; stats.filtered counts the ones removed.",
    "  A microsoft365 or google_calendar source may read through a project connection",
    "  (--connection-id pcn_...; connection create) instead of credentials of its own.",
    "  A preset is a ready-made, tested json source for one service (a Slack channel, a",
    "  job board, a build board): source presets lists them with the card each fills,",
    "  source presets NAME shows its fields, its secrets and how to get them, and",
    "  source create --preset NAME --card crd_... --name N --set FIELD=VALUE",
    "  --secret NAME=@FILE makes the source (source test --preset previews it first).",
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

  const presets = source.command("presets").description("List the ready-made source presets, or show one with its fields, secrets and how to get them")
    .argument("[name]", "A preset's name (slack-channel); without it every preset is listed", sourcePresetOption)
    .action(bind(handleSourcePresets));
  addCommandNotes(presets, "A preset is a named, tested configuration of the json source, so a person fills in a few fields instead of writing a config and a mapping. The list shows each preset's title, the card types it fills (the first is the one it is made for) and its category. A name shows the fields to set (--set NAME=VALUE: text with its pattern and an example, a choice, or a list that takes a JSON array), the secrets to enter (--secret NAME=@FILE) with where the vendor issues each, how often it refreshes, how long a card keeps its last data, and whose data it reads under which terms. Read only: nothing is created.");
  addCommandExamples(presets, "screenrig source presets", "screenrig source presets slack-channel");

  const create = source.command("create").description("Create a data source that keeps one card live; it runs within seconds")
    .addOption(new Option("--kind <KIND>", "Where the data comes from").choices([...SOURCE_KINDS]))
    .addOption(new Option("--preset <NAME>", PRESET_HELP).argParser(sourcePresetOption))
    .requiredOption("--card <CARD_ID>", "The card instance to write (crd_...); one source per card", cardUid)
    .requiredOption("--name <NAME>", "Name the source, 1 to 80 characters", nameOption)
    .option("--settings <JSON|@FILE|->", CONFIG_HELP)
    .option("--set <KEY=VALUE>", SET_HELP, accumulate(setPairCheck))
    .addOption(new Option("--connection-id <ID>", CONNECTION_HELP).argParser(connectionIdOption))
    .option("--secret <NAME=VALUE>", SECRET_HELP, accumulate(secretPairCheck))
    .option("--refresh <DURATION>", "How often to sync, 30s to 24h (default and floor depend on the kind; ics is 5m, momentus 1m; a preset sets its own)", sourceRefreshOption)
    .option("--stale-after <DURATION|none>", STALE_HELP, sourceStaleAfterOption)
    .option("--disabled", "Create it disabled; nothing is fetched until source update --enable")
    .action(bind(handleSourceCreate));
  requireOptionGroup(create, "exactlyOne", ["--kind", "--preset"]);
  addCommandExamples(create,
    "screenrig source create --kind ics --card crd_CARD --name \"Lobby calendar\" --set calendars='[{\"key\":\"lobby\"}]' --set time_zone=America/Vancouver --secret calendar_url.lobby=@lobby.url",
    "screenrig source create --kind ics --card crd_ROOMS --name \"Study rooms\" --settings @rooms.json --secret calendar_url.room1=@room1.url --secret calendar_url.room2=@room2.url --refresh 2m",
    "screenrig source create --kind ics --card crd_EVENTS --name \"Public events\" --set calendars='[{\"key\":\"main\"}]' --set exclude='[\"Private\",\"Holiday\"]' --secret calendar_url.main=@main.url",
    "screenrig source create --kind sheets --card crd_MENU --name \"Cafe menu\" --settings @menu-sheet.json",
    "screenrig source create --kind json --card crd_KPI --name \"Daily numbers\" --settings @kpi-api.json --secret token=@api.token",
    "screenrig source create --kind json --card crd_ORDERS --name \"Open orders\" --settings @graphql-orders.json --secret header.X-Api-Key=@orders.key",
    "screenrig source create --kind json --card crd_STATUS --name \"Status board\" --settings @oauth-status.json --secret client_secret=@client.secret",
    "screenrig source create --kind momentus --card crd_EVENTS --name \"Venue events\" --settings @momentus.json --secret api_key=@key.guid --secret api_secret=@secret.guid --stale-after 30m",
    "screenrig source create --kind toast --card crd_MENU --name \"Toast menu\" --settings @toast.json --secret client_secret=@toast.secret",
    "screenrig source create --kind microsoft365 --card crd_ROOMS --name \"Meeting rooms\" --settings @rooms.json --connection-id pcn_CONNECTION",
    "screenrig source create --preset slack-channel --card crd_WALL --name \"Team wall\" --set channel=C0123456789 --secret token=@slack.token",
  );
  addCommandNotes(create, [
    "Request settings of a csv or json source, as --settings JSON beside its mapping (a secret goes by name with --secret, never in the JSON):",
    "  secret header and query:  {\"url\":\"https://api.example.com/v1/items\"}  --secret header.X-Api-Key=@FILE --secret query.account=@FILE",
    "  POST a GraphQL query:     {\"url\":\"https://api.example.com/graphql\",\"graphql\":{\"query\":\"{ orders { id } }\",\"variables\":{}}}  --secret token=@FILE",
    "  basic auth:               {\"url\":\"https://api.example.com/v1/items\",\"auth\":\"basic\",\"username\":\"screens\"}  --secret password=@FILE",
    "  OAuth client credentials: {\"url\":\"https://api.example.com/v1/stats\",\"auth\":\"oauth2\",\"token_url\":\"https://auth.example.com/token\",\"client_id\":\"ID\",\"scope\":\"read\"}  --secret client_secret=@FILE",
    "  log in for a token:       {\"url\":\"https://api.example.com/v1/items\",\"auth\":\"token_request\",\"token_url\":\"https://api.example.com/login\",\"token_body\":{\"user\":\"screens\",\"pass\":\"{{secrets.login_password}}\"},\"token_path\":\"token\"}  --secret login_password=@FILE",
    "  pages:                    \"rows_path\":\"data.items\",\"pagination\":{\"type\":\"cursor\",\"param\":\"after\",\"path\":\"page.next\",\"max_pages\":5}",
    "  a dated address:          {\"url\":\"https://api.example.com/events?from={{today}}&to={{today+7d}}\",\"time_zone\":\"America/Vancouver\"}",
    "  an RSS or Atom feed:      {\"url\":\"https://example.com/feed.xml\",\"format\":\"xml\"} with a mapping that reads {{body.items}}",
  ].join("\n"));

  const update = source.command("update").description("Change a data source; a change other than a rename resets its failures and runs it again")
    .argument("<source_id>", "Data source identifier (src_...)")
    .option("--name <NAME>", "Rename the source", nameOption)
    .option("--card <CARD_ID>", "Write another card instead", cardUid)
    .option("--settings <JSON|@FILE|->", `Replace the whole config; for a source made from a preset, merge these fields into its settings. ${CONFIG_HELP}`)
    .option("--set <KEY=VALUE>", `Change one top-level config member of the saved config, or one field of a preset's settings (repeatable). ${SET_HELP}`, accumulate(setPairCheck))
    .addOption(new Option("--connection-id <ID>", `${CONNECTION_HELP}. Moving a source off its own credentials takes --settings without tenant and client_id, and --unset-secret client_secret`).argParser(connectionIdOption))
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
    "screenrig source update src_SOURCE --set include='[\"Board\",\"Training\"]'",
    "screenrig source update src_PRESETSOURCE --set channel=C0123456789 --secret token=@new.token",
  );

  const test = source.command("test").description("Preview a source: fetch, shape and validate against the card, without saving or writing anything")
    .argument("[source_id]", "A saved source to test; the other options override it")
    .addOption(new Option("--kind <KIND>", "Where the data comes from (required without source_id, unless --preset names it)").choices([...SOURCE_KINDS]).conflicts(["preset"]))
    .addOption(new Option("--preset <NAME>", "Preview a source made from this preset (source presets), with --set and --settings as its fields and --secret as its credentials, instead of --kind").argParser(sourcePresetOption).conflicts(["kind"]))
    .option("--card <CARD_ID>", "The card instance to fill (required without source_id)", cardUid)
    .option("--settings <JSON|@FILE|->", CONFIG_HELP)
    .option("--set <KEY=VALUE>", SET_HELP, accumulate(setPairCheck))
    .addOption(new Option("--connection-id <ID>", CONNECTION_HELP).argParser(connectionIdOption))
    .option("--secret <NAME=VALUE>", SECRET_HELP, accumulate(secretPairCheck))
    .action(bind(handleSourceTest));
  addCommandNotes(test, "Prints the document the source would write, whether the card accepts it, and what the run noticed (a time zone it could not place, events cut at a limit). A csv or json source also shows the request that went out as data.request: its address with placeholders filled in and secret query parameters masked, the names of the headers sent and the start of the body, and how many pages it read. At most 30 previews a minute per organization.");
  addCommandExamples(test,
    "screenrig source test --kind ics --card crd_CARD --set calendars='[{\"key\":\"lobby\"}]' --secret calendar_url.lobby=@lobby.url",
    "screenrig source test src_SOURCE",
    "screenrig source test --kind momentus --card crd_EVENTS --settings @momentus.json --secret api_key=@key.guid --secret api_secret=@secret.guid",
    "screenrig source test --kind json --card crd_ORDERS --settings @graphql-orders.json --secret header.X-Api-Key=@orders.key",
    "screenrig source test --preset slack-channel --card crd_WALL --set channel=C0123456789 --secret token=@slack.token",
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
