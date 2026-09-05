import { usageError } from "./problems.js";

/** ApplicationName is limited after trimming, in Unicode scalar values. */
export function applicationNameHeaders(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  const name = value.trim();
  const scalars = [...name];
  if (scalars.length > 120 || /\p{Cc}/u.test(value) || scalars.some((char) => {
    const code = char.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff;
  })) {
    throw usageError("--name must be at most 120 Unicode characters and must not contain control characters or invalid Unicode.");
  }
  if (!name) return {};
  if (/^[\x20-\x7e]+$/.test(name)) return { "screenrig-application-name": name };
  // RFC 8187 ext-value: HTTP header values stay ASCII; the server decodes UTF-8.
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return { "screenrig-application-name*": `UTF-8''${encoded}` };
}
