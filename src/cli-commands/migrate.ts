import { type Command, Option } from "commander";
import { handleMigrateApply, handleMigratePair, handleMigrateScan, handleMigrateVendors } from "../commands.js";
import { usageError } from "../problems.js";
import { ONLY_KINDS } from "../migrate/apply.js";
import { sortedVendors } from "../migrate/cli.js";
import { addCommandNotes } from "./notes.js";
import { positiveInteger } from "./options.js";
import type { CommandActionBinder } from "./types.js";

function only(value: string): string {
  const kinds = value.split(",").map((kind) => kind.trim());
  const bad = kinds.find((kind) => !(ONLY_KINDS as readonly string[]).includes(kind));
  if (bad !== undefined || new Set(kinds).size !== kinds.length) {
    throw usageError(`--only takes a comma-separated list of ${ONLY_KINDS.join(", ")}, each at most once.`);
  }
  return kinds.join(",");
}

function canvas(value: string): string {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value);
  if (!match || Number(match[1]) < 16 || Number(match[2]) < 16) throw usageError("--canvas takes WIDTHxHEIGHT in pixels, such as 1920x1080.");
  return value;
}

export function registerMigrateCommands(root: Command, bind: CommandActionBinder): void {
  const migrate = root.command("migrate").description("Import media, playlists and screens from another signage system");
  addCommandNotes(migrate, "Migration:\n  migrate runs in this CLI, on this machine. The vendor's key is read from the environment or a --credentials FILE, goes only to that vendor, and is never stored, printed or sent to screenRIG. Steps: migrate vendors (what each system takes), migrate scan (read the account and report what can and cannot come over; needs no sign-in), migrate apply --dry-run, migrate apply, then migrate pair for each display.");

  migrate.command("vendors").description("List the systems migrate reads, what each takes and how to make its read-only key")
    .argument("[vendor]", "One system's id")
    .action(bind(handleMigrateVendors));

  migrate.command("scan").description("Read a signage account and report what can and cannot come over; writes scan.json, sends nothing to screenRIG")
    .addOption(new Option("--from <VENDOR>", "The system to read").choices(sortedVendors().map((vendor) => vendor.id)).makeOptionMandatory())
    .option("--url <ADDRESS>", "The address of a self-hosted system")
    .option("--region <REGION>", "The region of a hosted account, where the system has regions")
    .option("--timezone <ZONE>", "An IANA time zone for screens that have none, such as America/Toronto")
    .option("--files <PATH>", "A folder or .zip of the originals the system's API cannot hand out")
    .option("--credentials <FILE>", "NAME=VALUE lines holding the vendor's key, instead of the environment")
    .option("--dir <DIR>", "The migration directory (default ./screenrig-migration-VENDOR)")
    .action(bind(handleMigrateScan));

  migrate.command("apply").description("Import what the scan found: media, playlists, waiting screens and campaigns; safe to rerun")
    .option("--dir <DIR>", "The migration directory holding scan.json (default ./screenrig-migration-VENDOR when one exists)")
    .option("--dry-run", "Read the project and print the plan; writes nothing and needs no vendor key")
    .option("--only <KINDS>", "Only these, comma-separated: media, playlists, screens, schedules", only)
    .option("--folder <ID>", "Put the media in this existing folder (mfd_...) instead of one made for the import")
    .option("--canvas <WIDTHxHEIGHT>", "The canvas of plain playlists (default 1920x1080); layouts keep their own size", canvas)
    .option("--credentials <FILE>", "NAME=VALUE lines holding the vendor's key, for downloads from the vendor")
    .option("--concurrency <N>", "Media imported at once, 1 to 8 (default 4)", positiveInteger("concurrency"))
    .option("--no-transcode", "Upload accepted source bytes unchanged")
    .action(bind(handleMigrateApply));

  migrate.command("pair").description("Pair a Player code to one waiting screen, under its old name, playlist, time zone and tags")
    .argument("<code...>", "The code the Player shows, such as ABC 234")
    .requiredOption("--screen <ID_OR_NAME>", "The waiting screen: its source id or its exact old name")
    .option("--dir <DIR>", "The migration directory (default ./screenrig-migration-VENDOR when one exists)")
    .action(bind(handleMigratePair));
}
