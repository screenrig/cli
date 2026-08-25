/** Compact snake_case display keys for operation-log events. */

const API_PREFIXES = ["/api/v1/", "/runtime/v1/", "/content/v1/"] as const;

const KEEP = new Set([
  "api",
  "v1",
  "runtime",
  "native",
  "screens",
  "playlists",
  "media",
  "applications",
  "account",
  "agents",
  "operations",
  "events",
  "feedback",
  "comment",
  "playback",
  "capabilities",
  "enrollments",
  "uploads",
  "commit",
  "content",
  "pair",
  "provision",
  "archive",
  "unarchive",
  "toast",
  "screenshot",
  "status",
  "public-id",
  "rotate",
  "kv",
  "bugs",
  "features",
  "self",
  "activate",
  "dashboard-links",
  "browser-links",
  "claim",
  "agent-connections",
  "credential",
  "pairing-sessions",
  "pairing-events",
  "complete",
  "identity",
  "reset",
  "sessions",
  "challenges",
  "observation",
  "reports",
  "manifest",
  "manifests",
  "releases",
  "launch",
  "page",
  "stream",
  "health",
  "ready",
  "version",
  ".health",
  ".ready",
  ".version",
]);

const SINGULAR: Record<string, string> = {
  screens: "screen",
  playlists: "playlist",
  applications: "application",
  operations: "operation",
  uploads: "upload",
  enrollments: "enrollment",
  agent_connections: "agent_connection",
  dashboard_links: "dashboard_link",
  browser_links: "browser_link",
  pairing_sessions: "pairing_session",
  pairing_events: "pairing_event",
  sessions: "session",
  challenges: "challenge",
  manifests: "manifest",
  releases: "release",
  bugs: "bug",
  features: "feature",
  events: "event",
};

function stripQuery(path: string): string {
  const query = path.indexOf("?");
  return query >= 0 ? path.slice(0, query) : path;
}

function stripKnownPrefix(path: string): string {
  for (const prefix of API_PREFIXES) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path.startsWith("/") ? path.slice(1) : path;
}

function keepToken(segment: string): string {
  // Kept tokens like `.health` drop the leading dot after hyphen folding.
  const folded = segment.replaceAll("-", "_");
  return folded.startsWith(".") ? folded.slice(1) : folded;
}

function pathSegments(path: string): string[] {
  return stripKnownPrefix(stripQuery(path))
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** First path segment that is not a kept route token (`scr_…`, `pl_…`, `med_…`, …). */
export function httpResourceId(path: string): string | undefined {
  for (const segment of pathSegments(path)) {
    if (!KEEP.has(segment)) {
      return segment;
    }
  }
  return undefined;
}

export function httpTag(method: string, path: string): string {
  const methodPart = method.toLowerCase();
  const segments = pathSegments(path);
  const tokens: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined || !KEEP.has(segment)) {
      continue;
    }
    const token = keepToken(segment);
    const next = segments[i + 1];
    if (next !== undefined && !KEEP.has(next)) {
      const singular = SINGULAR[token] ?? token;
      tokens.push(singular === token ? `${token}_id` : singular);
      i += 1;
      continue;
    }
    tokens.push(token);
  }
  return tokens.length > 0 ? `${methodPart}_${tokens.join("_")}` : methodPart;
}

export function localTag(op: string): string {
  return op.replaceAll(".", "_").replaceAll("-", "_").toLowerCase();
}
