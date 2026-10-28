import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  BI_FITS, BI_THEMES, biAddress, biAppClientId, biClientId, biConnectionOption, biDashboardUid, biName, biOrgId, biPage, biPanelId, biPixels, biRefreshOption,
  biReportId, biRotateOption, biSecretId, biSite, biTableauAddress, biTenantId, biTime, biUsername, biVar, biViewPath, biWorkspaceId,
  handleBiConnectionBrowse, handleBiConnectionCreate, handleBiConnectionCreatePowerBI, handleBiConnectionCreateTableau, handleBiConnectionDelete, handleBiConnectionList,
  handleBiConnectionShow, handleBiConnectionTest, handleBiConnectionUpdate, handleBiViewCreate, handleBiViewDelete, handleBiViewList,
  handleBiViewShow, handleBiViewTest, handleBiViewUpdate,
} from "../bi.js";

const TOKEN_FILE = "Read the service-account token from this file, or - for stdin (never an argument)";
const SECRET_FILE = "Read the secret value from this file, or - for stdin (never an argument)";

export function registerBiCommands(root: Command, bind: CommandActionBinder): void {
  const bi = root.command("bi").description("Show live BI dashboards (Grafana, Power BI, Tableau) on screens");
  addCommandNotes(bi, [
    "BI dashboards:",
    "  A connection is a project's access to a BI system it owns: for Grafana its",
    "  address and a service-account token, for Power BI a Microsoft Entra app",
    "  (service principal) and its client secret, for Tableau a connected app and a",
    "  user; the secret is sealed on the server and never shown again. A view is one",
    "  dashboard or panel of a Grafana connection, one report of a Power BI",
    "  workspace, one view of a Tableau site, or a public link that needs no",
    "  connection (a Grafana public dashboard, a Power BI Publish to web link, a",
    "  Tableau Public viz). A view plays through an iframe primitive that shows its",
    "  embed_url.",
    "  Grafana: the server draws the dashboard as a PNG through the Image Renderer,",
    "  every --refresh (30s to 24h, default 5m), shared among screens of the same",
    "  size; the screen never talks to Grafana. Power BI: the page embeds the",
    "  report with a view-only token the server generates and renews; the screen",
    "  never holds the client secret. --rotate turns the report's pages. Tableau:",
    "  the page embeds the view with the Embedding API and a five-minute token the",
    "  server signs with the connected app (embed scope only); --rotate-sheets with",
    "  --rotate turns the workbook's sheets. A public link plays live from its host.",
    "  Connections and views belong to one project.",
  ].join("\n"));

  const connection = bi.command("connection").description("Add, test and manage a project's BI connections");
  const create = connection.command("create").description("Add a connection to a BI system");
  const grafana = create.command("grafana").description("Add a Grafana connection: its address and a service-account token")
    .requiredOption("--url <URL>", "Grafana's address, such as https://grafana.example.com or https://example.com/grafana (a public host)", biAddress)
    .requiredOption("--token-file <FILE>", `${TOKEN_FILE}; the file holds only the token`)
    .option("--name <NAME>", "Name the connection, 1 to 80 characters (default: the host name)", biName)
    .option("--org-id <N>", "The Grafana organization the token belongs to (default 1)", biOrgId)
    .action(bind(handleBiConnectionCreate));
  void grafana;
  create.command("tableau").description("Add a Tableau connection: a connected app (direct trust), the user the screens show, and the app's secret value")
    .requiredOption("--url <URL>", "The https address of Tableau Server, or of your Tableau Cloud pod such as https://10ay.online.tableau.com", biTableauAddress)
    .option("--site <SITE>", "The site's content URL, the part after /site/ or /t/ in a view's address (omit for Tableau Server's default site)", biSite)
    .requiredOption("--client-id <ID>", "The connected app's Client ID", biAppClientId)
    .requiredOption("--secret-id <ID>", "The Secret ID of a secret generated for the connected app", biSecretId)
    .requiredOption("--username <USER>", "The Tableau user the screens' views are shown as (an email address on Tableau Cloud)", biUsername)
    .requiredOption("--secret-file <FILE>", `${SECRET_FILE}; the file holds only the secret value`)
    .option("--name <NAME>", "Name the connection, 1 to 80 characters (default: the host name)", biName)
    .action(bind(handleBiConnectionCreateTableau));
  create.command("powerbi").description("Add a Power BI connection: a Microsoft Entra app (service principal) and its client secret")
    .requiredOption("--tenant-id <ID>", "Your Microsoft Entra Directory (tenant) ID, or its domain such as contoso.onmicrosoft.com", biTenantId)
    .requiredOption("--client-id <ID>", "The Application (client) ID of the app registration", biClientId)
    .requiredOption("--secret-file <FILE>", `${SECRET_FILE}; the file holds only the secret value`)
    .option("--name <NAME>", "Name the connection, 1 to 80 characters (default: Power BI)", biName)
    .action(bind(handleBiConnectionCreatePowerBI));
  connection.command("list").description("List this project's BI connections").action(bind(handleBiConnectionList));
  connection.command("show").description("Inspect one connection and its last test")
    .argument("<id>", "Connection identifier").action(bind(handleBiConnectionShow));
  connection.command("update").description("Change a connection's name, address, organization, tenant, app, site, user or secret")
    .argument("<id>", "Connection identifier")
    .option("--name <NAME>", "Rename the connection", biName)
    .option("--url <URL>", "The new address of Grafana, or of the Tableau server or pod (https)", biAddress)
    .option("--org-id <N>", "The Grafana organization the token belongs to", biOrgId)
    .option("--tenant-id <ID>", "The Power BI connection's Microsoft Entra tenant", biTenantId)
    .option("--client-id <ID>", "The Power BI connection's Application (client) ID, or the Tableau connected app's Client ID", biAppClientId)
    .addOption(new Option("--site <SITE>", "The Tableau connection's site content URL").argParser(biSite).conflicts(["defaultSite"]))
    .addOption(new Option("--default-site", "Tableau Server: sign in to the default site").conflicts(["site"]))
    .option("--secret-id <ID>", "The Tableau connected app's Secret ID", biSecretId)
    .option("--username <USER>", "The Tableau user the screens' views are shown as", biUsername)
    .addOption(new Option("--token-file <FILE>", `${TOKEN_FILE}; it replaces the stored token`).conflicts(["secretFile"]))
    .addOption(new Option("--secret-file <FILE>", `${SECRET_FILE}; it replaces the stored secret`).conflicts(["tokenFile"]))
    .option("--expect-rev <REVISION>", "Optionally require this connection revision", revision)
    .action(bind(handleBiConnectionUpdate));
  connection.command("test").description("Check the credentials: Grafana's token and Image Renderer, Power BI's app and its workspaces, or Tableau's sign-in")
    .argument("<id>", "Connection identifier").action(bind(handleBiConnectionTest));
  connection.command("browse").description("List what a connection can show: Grafana dashboards and panels, Power BI workspaces and reports, Tableau views")
    .argument("<id>", "Connection identifier")
    .option("--query <TEXT>", "Only dashboards, workspaces, reports or views whose name matches")
    .option("--dashboard <UID>", "Grafana: list this dashboard's panels instead", biDashboardUid)
    .option("--workspace <ID>", "Power BI: list this workspace's reports instead", biWorkspaceId)
    .action(bind(handleBiConnectionBrowse));
  connection.command("delete").description("Delete a connection no view uses")
    .argument("<id>", "Connection identifier")
    .option("--expect-rev <REVISION>", "Optionally require this connection revision", revision)
    .action(bind(handleBiConnectionDelete));

  const view = bi.command("view").description("Add, test and manage the dashboards, reports and views that play on screens");
  const viewCreate = view.command("create").description("Add a view of a connection's dashboard, panel, report or Tableau view, or of a public link")
    .option("--connection-id <ID>", "The connection to show something of (not with --public-url)", biConnectionOption)
    .addOption(new Option("--url <URL>", "A dashboard address on the connection's Grafana host, a Power BI report address or a Tableau view address; the rest of the target is read from it").conflicts(["dashboard", "workspace", "view", "publicUrl"]))
    .addOption(new Option("--dashboard <UID>", "Grafana: the dashboard's uid, the part after /d/ in its address").argParser(biDashboardUid).conflicts(["url", "workspace", "view", "publicUrl"]))
    .addOption(new Option("--workspace <ID>", "Power BI: the workspace id, with --report").argParser(biWorkspaceId).conflicts(["url", "dashboard", "view", "publicUrl"]))
    .addOption(new Option("--report <ID>", "Power BI: the report id, with --workspace").argParser(biReportId).conflicts(["url", "dashboard", "view", "publicUrl"]))
    .addOption(new Option("--view <WORKBOOK/VIEW>", "Tableau: the view, the names after /views/ in its address (bi connection browse lists them)").argParser(biViewPath).conflicts(["url", "dashboard", "workspace", "report", "publicUrl"]))
    .option("--rotate-sheets", "Tableau: turn the workbook's published sheets (with --rotate)")
    .option("--page <NAME>", "Power BI: a page to show, by name or display name (repeatable, in this order)", biPage)
    .option("--all-pages", "Power BI: rotate through every visible page (with --rotate)")
    .option("--rotate <DURATION>", "Power BI: how long each page shows, 10s to 1h (needed with two or more pages or --all-pages). Tableau: how long each sheet shows (needed with --rotate-sheets)", biRotateOption)
    .option("--panel <ID>", "Grafana: show this one panel instead of the whole dashboard", biPanelId)
    .option("--from <TIME>", "Grafana: start of the time range, such as now-6h", biTime)
    .option("--to <TIME>", "Grafana: end of the time range, such as now", biTime)
    .option("--var <NAME=VALUE>", "Grafana: a dashboard variable (repeatable)", biVar)
    .addOption(new Option("--theme <THEME>", "Grafana theme (default dark)").choices(BI_THEMES))
    .option("--timezone <ZONE>", "Grafana: time zone for the dashboard, such as Europe/Paris, utc or browser")
    .addOption(new Option("--public-url <URL>", "A Grafana public dashboard link, a Power BI Publish to web link or a Tableau Public viz address; it needs no connection and plays live from its host").conflicts(["url", "dashboard", "workspace", "report", "view", "connectionId"]))
    .option("--name <NAME>", "Name the view, 1 to 80 characters (default: from the target)", biName)
    .option("--refresh <DURATION>", "Grafana: how often the image is drawn again, 30s to 24h (default 5m). Power BI and Tableau: how often the report or view refreshes its data, 60s to 24h (default 5m), or 0 for none", biRefreshOption)
    .addOption(new Option("--fit <FIT>", "Grafana: how the image fills the screen (default contain)").choices(BI_FITS))
    .action(bind(handleBiViewCreate));
  requireOptionGroup(viewCreate, "exactlyOne", ["--url", "--dashboard", "--workspace", "--view", "--public-url"]);
  requireOptionGroup(viewCreate, "together", ["--workspace", "--report"]);
  view.command("list").description("List this project's BI views").action(bind(handleBiViewList));
  view.command("show").description("Inspect one view, its embed_url and how it last fared on glass")
    .argument("<id>", "View identifier").action(bind(handleBiViewShow));
  view.command("update").description("Change a view's name, target, cadence or fit")
    .argument("<id>", "View identifier")
    .option("--name <NAME>", "Rename the view", biName)
    .addOption(new Option("--url <URL>", "A dashboard, report or Tableau view address; replaces the whole target").conflicts(["dashboard", "workspace", "report", "view", "publicUrl"]))
    .addOption(new Option("--dashboard <UID>", "Grafana: show this dashboard; replaces the whole target").argParser(biDashboardUid).conflicts(["url", "workspace", "report", "view", "publicUrl"]))
    .addOption(new Option("--workspace <ID>", "Power BI: show a report of this workspace (with --report); replaces the whole target").argParser(biWorkspaceId).conflicts(["url", "dashboard", "view", "publicUrl"]))
    .addOption(new Option("--report <ID>", "Power BI: show this report (in --workspace, or the current one)").argParser(biReportId).conflicts(["url", "dashboard", "view", "publicUrl"]))
    .addOption(new Option("--view <WORKBOOK/VIEW>", "Tableau: show this view; replaces the whole target").argParser(biViewPath).conflicts(["url", "dashboard", "workspace", "report", "publicUrl"]))
    .option("--rotate-sheets", "Tableau: turn the workbook's published sheets (with --rotate)")
    .option("--page <NAME>", "Power BI: the pages to show, by name or display name (repeatable); replaces the current pages", biPage)
    .option("--all-pages", "Power BI: rotate through every visible page")
    .option("--rotate <DURATION>", "Power BI: how long each page shows, 10s to 1h, or 0 for one page. Tableau: how long each sheet shows, or 0 to stop turning them", biRotateOption)
    .option("--panel <ID>", "Grafana: show this one panel", biPanelId)
    .option("--from <TIME>", "Grafana: start of the time range", biTime)
    .option("--to <TIME>", "Grafana: end of the time range", biTime)
    .option("--var <NAME=VALUE>", "Grafana: set a dashboard variable (repeatable)", biVar)
    .addOption(new Option("--theme <THEME>", "Grafana theme").choices(BI_THEMES))
    .option("--timezone <ZONE>", "Grafana: time zone for the dashboard")
    .addOption(new Option("--public-url <URL>", "A public link; replaces the whole target").conflicts(["url", "dashboard", "workspace", "report", "view"]))
    .option("--refresh <DURATION>", "How often the image is drawn again or the report refreshes (Power BI and Tableau: 60s to 24h, or 0 for none)", biRefreshOption)
    .addOption(new Option("--fit <FIT>", "Grafana: how the image fills the screen").choices(BI_FITS))
    .option("--expect-rev <REVISION>", "Optionally require this view revision", revision)
    .action(bind(handleBiViewUpdate));
  view.command("test").description("Check a view for real: a Grafana render, a Power BI embed token, a Tableau lookup, or a public link")
    .argument("<id>", "View identifier")
    .option("--output <FILE>", "Grafana: save the rendered PNG here instead of running the checks")
    .option("--width <PIXELS>", "Width of the saved image (default 1920)", biPixels)
    .option("--height <PIXELS>", "Height of the saved image (default 1080)", biPixels)
    .action(bind(handleBiViewTest));
  view.command("delete").description("Delete a view")
    .argument("<id>", "View identifier")
    .option("--expect-rev <REVISION>", "Optionally require this view revision", revision)
    .action(bind(handleBiViewDelete));
}
