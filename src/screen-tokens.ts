/**
 * Screen tokens in an iframe address ({screen.id}, {screen.field.NAME}, ...), as the
 * backend reads them. The canonical rules ship in generated/playlist-write-semantics.ts
 * (which `playlist validate` and every playlist write run); this module holds the same
 * address rules for the offline bundle validator and `playlist init`, which build an
 * address outside that document. A template is stored as written: the braces stay.
 */

const SCREEN_TOKEN = /\{screen\.(?:id|name|timezone|field\.[a-z0-9_]{1,32}|location\.(?:lat|lon|name|address))\}/g;

/** Whether the text carries a screen token. */
export function hasScreenToken(value: string): boolean {
  return value.includes("{screen.") && new RegExp(SCREEN_TOKEN.source).test(value);
}

/** The text with one letter in each token's place: the stand-in the server checks. */
export function screenTokenStandIn(value: string): string {
  return value.replace(SCREEN_TOKEN, "x");
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const DOCUMENT_HOSTS = new Set(["docs.google.com", "onedrive.live.com", "view.officeapps.live.com", "1drv.ms"]);

/**
 * Why an iframe address with screen tokens cannot be a template, or undefined: tokens
 * stand only in the path, query and fragment of an http(s) address, never in the scheme,
 * credentials, host or port, and never in a YouTube, Google or Microsoft document or BI
 * view address, which the server rewrites or appends to.
 */
export function screenTemplateRefusal(source: string): string | undefined {
  const origin = /^https?:\/\/[^/?#]*/i.exec(source)?.[0];
  if (origin === undefined) return "must start with http:// or https:// to carry {screen.…} tokens";
  if (hasScreenToken(origin)) return "{screen.…} tokens may stand only in the path, query or fragment, not in the scheme, credentials, host or port";
  let host: string;
  try { host = new URL(screenTokenStandIn(source)).hostname.toLowerCase().replace(/\.$/, ""); } catch { return undefined; }
  if (YOUTUBE_HOSTS.has(host)) return "cannot carry {screen.…} tokens: a YouTube link is rewritten to its embed form";
  if (DOCUMENT_HOSTS.has(host) || /^[a-z0-9-]+\.sharepoint\.com$/.test(host) || host.startsWith("doc.apps.")) return "cannot carry {screen.…} tokens: a Google or Microsoft document link is rebuilt for the screen";
  if (/^bi-[0-9a-f]{20}\.apps\./.test(host)) return "cannot carry {screen.…} tokens: a BI view's address carries the screen's embed ticket";
  return undefined;
}
