import { type Command, Option } from "commander";
import { addCommandNotes, requireOptionGroup } from "./notes.js";
import { revision } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import {
  BI_FITS, BI_THEMES, biAddress, biConnectionOption, biDashboardUid, biName, biOrgId, biPanelId, biPixels, biRefreshOption, biTime, biVar,
  handleBiConnectionBrowse, handleBiConnectionCreate, handleBiConnectionDelete, handleBiConnectionList, handleBiConnectionShow,
  handleBiConnectionTest, handleBiConnectionUpdate, handleBiViewCreate, handleBiViewDelete, handleBiViewList, handleBiViewShow,
  handleBiViewTest, handleBiViewUpdate,
} from "../bi.js";

const TOKEN_FILE = "Read the service-account token from this file, or - for stdin (never an argument)";

export function registerBiCommands(root: Command, bind: CommandActionBinder): void {
  const bi = root.command("bi").description("Show live BI dashboards (Grafana) on screens");
  addCommandNotes(bi, [
    "BI dashboards:",
    "  A connection is a project's access to a BI system it owns: for Grafana its",
    "  address and a service-account token, sealed on the server and never shown",
    "  again. A view is one dashboard or panel of a connection, or a Grafana public",
    "  dashboard link that needs no connection. A view plays through an iframe",
    "  primitive that shows its embed_url. For a connection view the server draws",
    "  the dashboard as a PNG through Grafana's image renderer, every --refresh",
    "  (30s to 24h, default 5m), and shares one render among screens of the same",
    "  size; the screen never talks to Grafana, and keeps the last image if Grafana",
    "  fails. A public dashboard plays live from Grafana, which must allow",
    "  embedding. Connections and views belong to one project.",
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
  connection.command("list").description("List this project's BI connections").action(bind(handleBiConnectionList));
  connection.command("show").description("Inspect one connection and its last test")
    .argument("<id>", "Connection identifier").action(bind(handleBiConnectionShow));
  connection.command("update").description("Change a connection's name, address, organization or token")
    .argument("<id>", "Connection identifier")
    .option("--name <NAME>", "Rename the connection", biName)
    .option("--url <URL>", "Grafana's new address", biAddress)
    .option("--org-id <N>", "The Grafana organization the token belongs to", biOrgId)
    .option("--token-file <FILE>", `${TOKEN_FILE}; it replaces the stored token`)
    .option("--expect-rev <REVISION>", "Optionally require this connection revision", revision)
    .action(bind(handleBiConnectionUpdate));
  connection.command("test").description("Check the token and Grafana's Image Renderer plugin")
    .argument("<id>", "Connection identifier").action(bind(handleBiConnectionTest));
  connection.command("browse").description("List the dashboards a connection can show, or one dashboard's panels")
    .argument("<id>", "Connection identifier")
    .option("--query <TEXT>", "Only dashboards whose title matches")
    .option("--dashboard <UID>", "List this dashboard's panels instead", biDashboardUid)
    .action(bind(handleBiConnectionBrowse));
  connection.command("delete").description("Delete a connection no view uses")
    .argument("<id>", "Connection identifier")
    .option("--expect-rev <REVISION>", "Optionally require this connection revision", revision)
    .action(bind(handleBiConnectionDelete));

  const view = bi.command("view").description("Add, test and manage the dashboards that play on screens");
  const viewCreate = view.command("create").description("Add a view of a connection's dashboard or panel, or of a public dashboard link")
    .option("--connection-id <ID>", "The connection to show a dashboard of (not with --public-url)", biConnectionOption)
    .addOption(new Option("--url <URL>", "A dashboard address on the connection's Grafana host; its panel, time range, variables and theme are read from it").conflicts(["dashboard", "publicUrl"]))
    .addOption(new Option("--dashboard <UID>", "The dashboard's uid, the part after /d/ in its address").argParser(biDashboardUid).conflicts(["url", "publicUrl"]))
    .option("--panel <ID>", "Show this one panel instead of the whole dashboard", biPanelId)
    .option("--from <TIME>", "Start of the time range, such as now-6h", biTime)
    .option("--to <TIME>", "End of the time range, such as now", biTime)
    .option("--var <NAME=VALUE>", "A dashboard variable (repeatable)", biVar)
    .addOption(new Option("--theme <THEME>", "Grafana theme (default dark)").choices(BI_THEMES))
    .option("--timezone <ZONE>", "Time zone for the dashboard, such as Europe/Paris, utc or browser")
    .addOption(new Option("--public-url <URL>", "A Grafana public dashboard link; it needs no connection and plays live from Grafana").conflicts(["url", "dashboard", "connectionId"]))
    .option("--name <NAME>", "Name the view, 1 to 80 characters (default: from the dashboard)", biName)
    .option("--refresh <DURATION>", "How often the image is drawn again, 30s to 24h (default 5m)", biRefreshOption)
    .addOption(new Option("--fit <FIT>", "How the image fills the screen (default contain)").choices(BI_FITS))
    .action(bind(handleBiViewCreate));
  requireOptionGroup(viewCreate, "exactlyOne", ["--url", "--dashboard", "--public-url"]);
  view.command("list").description("List this project's BI views").action(bind(handleBiViewList));
  view.command("show").description("Inspect one view, its embed_url and how it last fared on glass")
    .argument("<id>", "View identifier").action(bind(handleBiViewShow));
  view.command("update").description("Change a view's name, target, cadence or fit")
    .argument("<id>", "View identifier")
    .option("--name <NAME>", "Rename the view", biName)
    .addOption(new Option("--url <URL>", "A dashboard address on the connection's Grafana host; replaces the whole target").conflicts(["dashboard", "publicUrl"]))
    .addOption(new Option("--dashboard <UID>", "Show this dashboard; replaces the whole target").argParser(biDashboardUid).conflicts(["url", "publicUrl"]))
    .option("--panel <ID>", "Show this one panel", biPanelId)
    .option("--from <TIME>", "Start of the time range", biTime)
    .option("--to <TIME>", "End of the time range", biTime)
    .option("--var <NAME=VALUE>", "Set a dashboard variable (repeatable)", biVar)
    .addOption(new Option("--theme <THEME>", "Grafana theme").choices(BI_THEMES))
    .option("--timezone <ZONE>", "Time zone for the dashboard")
    .addOption(new Option("--public-url <URL>", "A Grafana public dashboard link; replaces the whole target").conflicts(["url", "dashboard"]))
    .option("--refresh <DURATION>", "How often the image is drawn again, 30s to 24h", biRefreshOption)
    .addOption(new Option("--fit <FIT>", "How the image fills the screen").choices(BI_FITS))
    .option("--expect-rev <REVISION>", "Optionally require this view revision", revision)
    .action(bind(handleBiViewUpdate));
  view.command("test").description("Render a view for real, or check a public link may be framed")
    .argument("<id>", "View identifier")
    .option("--output <FILE>", "Save the rendered PNG here instead of running the checks")
    .option("--width <PIXELS>", "Width of the saved image (default 1920)", biPixels)
    .option("--height <PIXELS>", "Height of the saved image (default 1080)", biPixels)
    .action(bind(handleBiViewTest));
  view.command("delete").description("Delete a view")
    .argument("<id>", "View identifier")
    .option("--expect-rev <REVISION>", "Optionally require this view revision", revision)
    .action(bind(handleBiViewDelete));
}
