const TOKEN_RE = /\bsr_live_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+\b/g;
const AGENT_CONNECTION_TOKEN_RE = /\bsac_[A-Za-z0-9_-]{43}\b/g;
const BEARER_RE = /Bearer\s+\S+/gi;
const AGENT_CONNECTION_AUTH_RE = /ScreenRig-Agent-Connect\s+\S+/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
/**
 * Single-use tokens ScreenRig delivers in a URL fragment. The whole URL is the
 * credential, so a link that reaches an error detail, an event, or a message
 * must lose its fragment rather than be echoed back.
 */
const URL_FRAGMENT_TOKEN_RE = /#(link|provision)=[A-Za-z0-9_-]{8,}/gi;

const SENSITIVE_KEY_RE =
  /(authorization|access_token|token|password|secret|private|ciphertext|nonce|cookie|object_key|signed_url|completion_nonce|upload_url|image_bytes|pixels)/i;
const SENSITIVE_VALUE_RE =
  /(sr_live_|sac_|Bearer\s|ScreenRig-Agent-Connect\s|data:image\/|#(link|provision)=|[?&](X-Amz-Signature|X-Goog-Signature|signature)=)/i;

/**
 * Lookup segment of a credential, for internal correlation only. A redacted
 * credential never carries it: the segment identifies the live token, so
 * printing it hands an observer a usable half of the secret.
 */
export function tokenLookupId(token: string): string | undefined {
  const match = /^sr_live_([A-Za-z0-9_-]+)_/.exec(token);
  return match?.[1];
}

/** What a live credential looks like once redacted: the shape, and nothing else. */
export const REDACTED_TOKEN = "sr_live_***";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_RE.test(value);
}

export function redactText(value: string): string {
  return value
    .replace(TOKEN_RE, REDACTED_TOKEN)
    .replace(AGENT_CONNECTION_TOKEN_RE, "sac_***")
    .replace(AGENT_CONNECTION_AUTH_RE, "ScreenRig-Agent-Connect ***")
    .replace(BEARER_RE, "Bearer ***")
    .replace(URL_FRAGMENT_TOKEN_RE, (_match, name: string) => `#${name.toLowerCase()}=***`)
    .replace(EMAIL_RE, "[redacted-email]");
}

function redactSensitive(nested: unknown): unknown {
  if (typeof nested === "string" && tokenLookupId(nested)) {
    return REDACTED_TOKEN;
  }
  return "***";
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
      if (isSensitiveKey(key)) {
        out[key] = redactSensitive(nested);
        continue;
      }
      out[key] = redactValue(nested);
    }
    return out;
  }
  return value;
}

/** Omit sensitive keys and credential-shaped values; redact remaining strings. */
export function redactEvent(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactEvent);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      if (typeof nested === "string" && isSensitiveValue(nested)) continue;
      out[key] = redactEvent(nested);
    }
    return out;
  }
  return value;
}
