import { usageError } from "./problems.js";

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the character references an HTML attribute value carries. */
export function decodeAttributeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (match, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? "", 16);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

/**
 * The src of the first iframe of a pasted embed code (Google's Publish to web
 * and Microsoft's Embed dialog give one), with its entities decoded. Input that
 * does not start with an iframe tag is not an embed code: undefined.
 */
export function iframeSnippetSource(input: string): string | undefined {
  const opening = /^\s*<iframe(?=[\t\n\f\r />])/i.exec(input);
  if (opening === null) return undefined;
  // Consume whole attributes, including quoted values. The sticky match stops
  // at the first tag's end instead of finding src text inside a value or later tag.
  const attribute = /[\t\n\f\r /]*([^\t\n\f\r />=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >"']+)))?/y;
  attribute.lastIndex = opening[0].length;
  let source: string | undefined;
  for (let match; (match = attribute.exec(input)) !== null;) {
    if (match[1]!.toLowerCase() !== "src") continue;
    source = match[2] ?? match[3] ?? match[4];
    break;
  }
  if (source === undefined || source.trim() === "") throw usageError("The iframe embed code has no src address to show.");
  return decodeAttributeEntities(source).trim();
}
