import type { Command } from "commander";
import { positiveInteger } from "./options.js";
import type { CommandActionBinder } from "./types.js";
import { handleDocsSearch, handleDocsShow } from "../handlers/docs.js";

export function registerDocsCommands(root: Command, bind: CommandActionBinder): void {
  const docs = root.command("docs").description("Search and read the official documentation before guessing");
  docs.command("search").description("Search the official documentation")
    .argument("<query...>", "Words, a command or flag, or an error code")
    .option("--limit <N>", "Hits to return, 1-25 (default 8)", positiveInteger("limit"))
    .action(bind(handleDocsSearch));
  docs.command("show").description("Read an official documentation page or one section of it")
    .argument("<url>", "Page address as docs search prints it, or only its path")
    .option("--section <NAME>", "Read one section: a heading or anchor from the sections list")
    .action(bind(handleDocsShow));
}
