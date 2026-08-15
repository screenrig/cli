const TOKEN_RE = /\bsr_live_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+\b/g;
const BEARER_RE = /Bearer\s+\S+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function tokenLookupId(token: string): string | undefined {
  const match = /^sr_live_([A-Za-z0-9_-]+)_/.exec(token);
  return match?.[1];
}

export function redactToken(token: string): string {
  const id = tokenLookupId(token);
  if (!id) {
    return "sr_live_***";
  }
  return `sr_live_${id}_***`;
}

export function redactText(value: string): string {
  return value
    .replace(TOKEN_RE, (token) => redactToken(token))
    .replace(BEARER_RE, "Bearer ***")
    .replace(EMAIL_RE, "[redacted-email]");
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/(token|secret|authorization|password|cookie)/i.test(key)) {
        out[key] = typeof nested === "string" ? redactToken(nested) : "***";
        continue;
      }
      out[key] = redactValue(nested);
    }
    return out;
  }
  return value;
}
