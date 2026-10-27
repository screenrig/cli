import type { TransportRequest } from "./transport/types.js";

const PROJECT_ROUTES = new Set([
  "project", "project/deletion-preview", "project/owner", "project/move", "project/moves",
  "project/capabilities", "project/browser-links/claim", "invitations", "applications", "playlists",
  "screens", "screens/pair", "screens/provision", "screens/actions", "triggers", "campaigns", "events",
  "billing/balance", "billing/statement", "billing/usage", "advertising/network", "advertising/network/rate",
  "advertising/inventory", "advertising/slots", "advertising/memberships", "advertising/networks",
  "advertising/creatives", "advertising/campaigns", "advertising/reviews", "advertising/reports/spend",
  "advertising/reports/delivery", "playback", "playback/plays", "playback/totals", "health/trend", "uptime/daily",
  "card-types", "card-data", "cards", "media", "media/generations", "media-folders", "media/move", "media/uploads",
  "selectors/preview", "feedback/bugs", "feedback/features", "service-clients", "fleet-links", "webhooks",
  "notes", "support/status", "support/conversations", "reviews", "agents/self", "agents/self/disconnect",
]);
const GLOBAL_LISTS = new Set(["screens", "applications", "playlists", "media", "cards", "media-folders", "notes"]);

/** Apply selection only to collections, local names and object-less operations. */
export function projectRequest<T extends Pick<TransportRequest, "method" | "path" | "query">>(request: T, projectId?: string): T {
  if (!projectId) return request;
  const route = request.path.startsWith("/api/") ? request.path.slice(5) : "";
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && GLOBAL_LISTS.has(route)) return { ...request, query: { ...request.query, project: projectId } };
  // Catalogue details are public type IDs; instance IDs remain global.
  if (route === "card-types" || route.startsWith("card-types/")) return { ...request, query: { ...request.query, project: projectId } };
  if (PROJECT_ROUTES.has(route) || route.startsWith("card-data/") || route.startsWith("feeds/")
    || /^advertising\/networks\/[^/]+\/inventory$/.test(route)) {
    return { ...request, path: `/api/projects/${encodeURIComponent(projectId)}/${route}` };
  }
  return request;
}

/** Streams select a project in the query; no ambient project header. */
export function projectStreamQuery(projectId?: string): Record<string, string> {
  return projectId ? { project: projectId } : {};
}
