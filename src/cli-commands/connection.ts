import { type Command, Option } from "commander";
import { biClientId, biName, biTenantId } from "../bi.js";
import {
  CONNECTION_MODES, handleConnectionConnect, handleConnectionCreateGoogle, handleConnectionCreateMicrosoft, handleConnectionDelete, handleConnectionList,
  handleConnectionShow, handleConnectionTest, handleConnectionUpdate,
} from "../connections.js";
import { addCommandExamples, addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";

const SECRET_FILE = "Read the client secret's Value from this file, or - for stdin (never an argument); the file holds only the Value";
const KEY_FILE = "Read the service account's JSON key file from this file, or - for stdin (never an argument)";
const MICROSOFT_MODE_HELP = "own_app: your own application, a Microsoft Entra app registration with a client secret (--tenant-id, --client-id, --secret-file). screenrig_app: screenRIG's application, which a Microsoft 365 administrator consents to through a one-time link that this command prints";
const GOOGLE_MODE_HELP = "own_app: your own service account key (--service-account-key-file). screenrig_app: screenRIG's application, which the holder of a Google account signs in to and grants read-only calendar access through a one-time link that this command prints";

export function registerConnectionCommands(root: Command, bind: CommandActionBinder): void {
  const connection = root.command("connection").description("Share Microsoft 365 or Google access with sources, Power BI and syncs");
  addCommandNotes(connection, [
    "Connections:",
    "  A connection is the project's reusable access to Microsoft or Google for things",
    "  that run unattended: a microsoft365 or google_calendar data source",
    "  (source create --connection-id pcn_...), a Power BI connection",
    "  (bi connection create powerbi --connection-id) and a SharePoint media sync",
    "  account (media sync account add microsoft365 --connection-id) read through one",
    "  instead of each carrying a tenant, a client id and a secret. Credentials you",
    "  enter keep working unchanged.",
    "  Mode own_app holds your own application: for Microsoft a Microsoft Entra app",
    "  registration (--tenant-id, --client-id and the Value of a client secret), for",
    "  Google a service account's JSON key; the secret is sealed and never shown again.",
    "  Mode screenrig_app uses screenRIG's own application and needs no secret: create",
    "  prints a one-time consent link (data.consent_url) for the person who completes it,",
    "  a Microsoft 365 administrator who consents for the tenant, or the holder of a",
    "  Google account who grants read-only access to the calendars it can see. Send the",
    "  link to that person only, then read status and last_error with connection show;",
    "  connection connect makes a new link, to renew one or to move it to another tenant",
    "  or account. A Power BI connection takes only an own_app connection.",
    "  connection test signs in and reports what the credentials and permissions allow;",
    "  it does not judge a calendar's sharing, a mailbox access policy or a site grant.",
    "  connection delete is refused while anything reads through the connection, and does",
    "  not end the vendor's side. An organization has at most 50 connections across its",
    "  projects. Needs Manage access to change; reading needs Read access.",
  ].join("\n"));

  const list = connection.command("list").description("List this project's connections with their status")
    .action(bind(handleConnectionList));
  addCommandExamples(list, "screenrig connection list");

  const show = connection.command("show").description("Inspect one connection: its status, last error and last test")
    .argument("<id>", "Connection identifier (pcn_...)")
    .action(bind(handleConnectionShow));
  addCommandExamples(show, "screenrig connection show pcn_CONNECTION");

  const create = connection.command("create").description("Add a connection to Microsoft 365 or Google");
  const microsoft = create.command("microsoft").description("Add a Microsoft 365 connection: your own Entra app, or screenRIG's application with a consent link")
    .addOption(new Option("--mode <MODE>", MICROSOFT_MODE_HELP).choices([...CONNECTION_MODES]).makeOptionMandatory())
    .option("--name <NAME>", "Name the connection, 1 to 80 characters (default: Microsoft 365)", biName)
    .option("--tenant-id <ID>", "own_app: your Microsoft Entra Directory (tenant) ID, or its primary domain such as contoso.onmicrosoft.com", biTenantId)
    .option("--client-id <ID>", "own_app: the Application (client) ID of the app registration", biClientId)
    .option("--secret-file <FILE>", `own_app: ${SECRET_FILE}`)
    .action(bind(handleConnectionCreateMicrosoft));
  requireOptionGroup(microsoft, "together", ["--tenant-id", "--client-id", "--secret-file"]);
  addCommandNotes(microsoft, "own_app needs --tenant-id, --client-id and --secret-file; screenrig_app takes none of them and prints the consent link (data.consent_url) for the Microsoft 365 administrator, who consents to screenRIG's application for the tenant. The app registration lists Calendars.Read for meeting-room calendars, Sites.Selected or Files.Read.All for SharePoint media sync and, for Power BI, tenant settings and workspace membership instead of Graph permissions; connection test reports which permissions the token carries. A server without screenRIG's application answers connection_app_not_configured: own_app still works.");
  addCommandExamples(microsoft,
    "screenrig connection create microsoft --mode own_app --tenant-id contoso.onmicrosoft.com --client-id 0b1d2f3a-4c5e-4f60-8a7b-9c0d1e2f3a4b --secret-file secret.txt",
    "screenrig connection create microsoft --mode screenrig_app --name \"Contoso rooms\"",
  );
  const google = create.command("google").description("Add a Google connection: your own service account key, or screenRIG's application with a sign-in link")
    .addOption(new Option("--mode <MODE>", GOOGLE_MODE_HELP).choices([...CONNECTION_MODES]).makeOptionMandatory())
    .option("--name <NAME>", "Name the connection, 1 to 80 characters (default: Google Calendar)", biName)
    .option("--service-account-key-file <FILE>", `own_app: ${KEY_FILE}`)
    .action(bind(handleConnectionCreateGoogle));
  addCommandNotes(google, "own_app needs --service-account-key-file; share each room calendar with the service account's address, or give the source a subject (domain-wide delegation). screenrig_app takes no key and prints the sign-in link (data.consent_url) for the holder of the Google account, who grants read-only calendar access: the account must see every room calendar a source lists, and such a source cannot name a subject. A server without screenRIG's application answers connection_app_not_configured: own_app still works.");
  addCommandExamples(google,
    "screenrig connection create google --mode own_app --service-account-key-file key.json",
    "screenrig connection create google --mode screenrig_app --name \"Venue calendars\"",
  );

  const update = connection.command("update").description("Rename a connection or, in mode own_app, change its tenant, app or secret")
    .argument("<id>", "Connection identifier (pcn_...)")
    .option("--name <NAME>", "Rename the connection", biName)
    .option("--tenant-id <ID>", "Microsoft own_app: the Directory (tenant) ID or primary domain", biTenantId)
    .option("--client-id <ID>", "Microsoft own_app: the Application (client) ID", biClientId)
    .option("--secret-file <FILE>", `Microsoft own_app: ${SECRET_FILE}; it replaces the stored secret`)
    .option("--service-account-key-file <FILE>", `Google own_app: ${KEY_FILE}; it replaces the stored key`)
    .option("--expect-rev <REVISION>", "Optionally require this connection revision", revision)
    .action(bind(handleConnectionUpdate));
  requireOptionGroup(update, "atLeastOne", ["--name", "--tenant-id", "--client-id", "--secret-file", "--service-account-key-file"]);
  addCommandNotes(update, "A change to the credentials returns the connection to ready, clears its last error and last test, and retires every token minted for the old ones; test it again. A screenrig_app connection can only be renamed: connection connect makes a new consent link to change who consented. An omitted secret is kept.");
  addCommandExamples(update,
    "screenrig connection update pcn_CONNECTION --secret-file new-secret.txt",
    "screenrig connection update pcn_CONNECTION --name \"Contoso rooms\" --expect-rev 2",
  );

  const test = connection.command("test").description("Sign in with a connection and check what its credentials allow")
    .argument("<id>", "Connection identifier (pcn_...)")
    .action(bind(handleConnectionTest));
  addCommandNotes(test, "Microsoft: credentials (an app token for the tenant) and permissions (which of Calendars.Read, Sites.Selected, Files.Read.All, Sites.Read.All and Place.Read.All the token carries; none fails, Sites.Selected alone is a warning because each site needs its own grant). Google: credentials, naming the account the calendars must be visible to. A refusal moves the connection to error with last_error; a success returns it to ready. At most 30 a minute per organization.");
  addCommandExamples(test, "screenrig connection test pcn_CONNECTION");

  const connect = connection.command("connect").description("Make a new one-time consent link for a screenrig_app connection")
    .argument("<id>", "Connection identifier (pcn_...)")
    .action(bind(handleConnectionConnect));
  addCommandNotes(connect, "Prints data.consent_url for the person who completes the consent: the Microsoft 365 administrator, or the holder of the Google account. It replaces any earlier link. A connection that works stays as it is until the new consent completes, so this also renews one that moved to error (consent removed, access revoked) or moves it to another tenant or account. A connection in mode own_app has no consent step. At most 20 a minute per organization.");
  addCommandExamples(connect, "screenrig connection connect pcn_CONNECTION");

  const remove = connection.command("delete").description("Delete a connection that nothing reads through")
    .argument("<id>", "Connection identifier (pcn_...)")
    .option("--expect-rev <REVISION>", "Optionally require this connection revision", revision)
    .action(bind(handleConnectionDelete));
  addCommandNotes(remove, "While a data source, a Power BI connection or a media sync account reads through the connection the answer is resource_conflict (exit 5), naming them. Deleting does not end the vendor's side: a Microsoft 365 tenant keeps screenRIG's application until its administrator removes it, and a Google account keeps its grant until its holder revokes it.");
  addCommandExamples(remove, "screenrig connection delete pcn_CONNECTION", "screenrig connection delete pcn_CONNECTION --expect-rev 2");
}
