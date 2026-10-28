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
  if (!/^\s*<iframe\b/i.test(input)) return undefined;
  const match = /<iframe\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/is.exec(input);
  const source = match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
  if (source === undefined || source.trim() === "") throw usageError("The iframe embed code has no src address to show.");
  return decodeAttributeEntities(source).trim();
}
