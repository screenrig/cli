import { type Command, Option } from "commander";
import { addCommandNotes } from "./notes.js";
import { reportFormatOption, reportOutputOption } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleAuditExport, handleAuditHead, handleAuditList, handleAuditShow, handleAuditVerify } from "../handlers/audit.js";
import { AUDIT_ACTOR_KINDS, AUDIT_SOURCES, auditAction, auditAnchor, auditField, auditInstant } from "../audit.js";

const filterOptions = (command: Command): Command => command
  .option("--actor <ID>", "Only changes made by this person, agent or service client (its id)")
  .addOption(new Option("--actor-kind <KIND>", "Only changes made by this kind of actor").choices(AUDIT_ACTOR_KINDS))
  .addOption(new Option("--source <SOURCE>", "Only changes that came through this surface").choices(AUDIT_SOURCES))
  .option("--resource-type <TYPE>", "Only changes to this kind of resource, such as screen, playlist, webhook or member")
  .option("--resource-id <ID>", "Only changes to this resource")
  .option("--action <CODE>", "An action such as screen.update, or a prefix ending in * such as playlist.*", auditAction)
  .option("--field <POINTER>", "Only changes that touched this member or one below it, as a JSON Pointer such as /label", auditField)
  .option("--since <TIME>", "Only changes at or after this RFC 3339 instant", auditInstant("--since"))
  .option("--until <TIME>", "Only changes before this RFC 3339 instant", auditInstant("--until"));

export function registerAuditCommands(root: Command, bind: CommandActionBinder): void {
  const audit = root.command("audit").description("Read the project's audit log: every configuration change with who, what, when, source and the before and after of each field");
  addCommandNotes(audit, [
    "Audit log:",
    "  Every change to the project's configuration (screens, playlists, media,",
    "  schedules, campaigns, notifications, webhooks, sources, members, settings,",
    "  commands sent to screens) is recorded when it is made: who made it (person,",
    "  agent, service client, staff), through which surface (dashboard, api, cli,",
    "  mcp, ...), when, and the value of each changed field before and after.",
    "  Secrets read (redacted); every other value is the stored value. Card data,",
    "  K/V values and Player telemetry are not configuration and are not recorded.",
    "  Entries are kept 400 days. Nothing writes, edits or deletes an entry, and",
    "  each entry is chained to the one before it: audit verify recomputes the",
    "  chain, and an export prints the chain head so a copy you keep proves later",
    "  that nothing before it was rewritten or removed. Reading needs the project",
    "  capability.",
  ].join("\n"));

  filterOptions(audit.command("list").description("List audit entries, newest first"))
    .option("--limit <N>", "Entries per page, 1 to 200 (default 50)", (value) => {
      if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 200) throw new Error("--limit must be 1 to 200.");
      return value;
    })
    .option("--after <CURSOR>", "next_cursor of the previous page")
    .action(bind(handleAuditList));

  audit.command("show").description("Show one audit entry with every changed field's before and after")
    .argument("<id>", "Audit entry identifier").action(bind(handleAuditShow));

  audit.command("head").description("Show the audit chain head to keep as an anchor").action(bind(handleAuditHead));

  audit.command("verify").description("Recompute the audit hash chain and report anything that does not match")
    .option("--from-seq <N>", "First chain position to check (default the oldest kept)", (value) => {
      if (!/^\d{1,18}$/.test(value)) throw new Error("--from-seq must be a chain position.");
      return value;
    })
    .option("--limit <N>", "Entries to check in this call, at most 5000")
    .option("--anchor <SEQ:HASH>", "A chain head you kept: also proves the history up to it is unchanged", auditAnchor)
    .action(bind(handleAuditVerify));

  filterOptions(audit.command("export").description("Write the filtered audit log as a CSV, XLSX or PDF file, one row per changed field, with the chain head in it"))
    .addOption(reportFormatOption().makeOptionMandatory())
    .addOption(reportOutputOption("audit-log.FORMAT"))
    .action(bind(handleAuditExport));
}
