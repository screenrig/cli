import { type Command, Option } from "commander";

const handlers = new WeakMap<Option, string>();
const aliases = new WeakMap<Option, string[]>();

/** Both spellings share one Commander value and validation; handlers keep their contract. */
export function addValueAlias(command: Command, canonical: string, legacy: string, description: string, required = false): void {
  const placeholder = canonical === "--name" ? "NAME" : "ID";
  const option = new Option(`${canonical} <${placeholder}>`, `${description} (${legacy} alias)`);
  if (required) option.makeOptionMandatory();
  const alias = new Option(`${legacy} <${placeholder}>`, `Alias for ${canonical}`).hideHelp();
  alias.attributeName = () => option.attributeName();
  handlers.set(option, legacy.slice(2));
  handlers.set(alias, legacy.slice(2));
  aliases.set(option, [legacy]);
  command.addOption(option).addOption(alias);
}

export function handlerOptionName(option: Option): string {
  return handlers.get(option) ?? (option.long === "--expect-rev" ? "if-match" : option.long!.slice(2));
}
export function optionAliases(option: Option): string[] { return aliases.get(option) ?? []; }
