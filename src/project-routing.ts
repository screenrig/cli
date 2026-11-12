import type { TransportRequest } from "./transport/types.js";

const PROJECT_ROUTES = new Set([
  "project", "project/deletion-preview", "project/owner", "project/move", "project/moves",
  "project/capabilities", "project/browser-links/claim", "invitations", "applications", "applications/uploads", "playlists",
  "screens", "screens/pair", "screens/provision", "screens/actions", "screens/move", "screen-folders", "triggers", "campaigns", "events",
  "billing/balance", "billing/statement", "billing/usage", "advertising/network", "advertising/network/rate",
  "advertising/inventory", "advertising/slots", "advertising/memberships", "advertising/networks",
  "advertising/creatives", "advertising/campaigns", "advertising/reviews", "advertising/reports/spend",
  "advertising/reports/delivery", "advertising/reports/fill", "advertising/direct-campaigns", "advertising/availability", "playback", "playback/plays", "playback/totals", "playback/completeness", "health/trend", "uptime/daily",
  "card-types", "card-data", "cards", "media", "media-folders", "media/move", "media/uploads",
  "backgrounds/categories", "backgrounds/sets",
  "selectors/preview", "feedback/bugs", "feedback/features", "service-clients", "fleet-links", "webhooks", "notifications", "alerts", "alert-mutes",
  "notes", "support/status", "support/conversations", "reviews", "agents/self", "agents/self/disconnect",
]);
const GLOBAL_LISTS = new Set(["screens", "applications", "playlists", "media", "cards", "media-folders", "screen-folders", "notes"]);

/** Apply selection to collections, local names, object-less operations and Library playlist reads. */
export function projectRequest<T extends Pick<TransportRequest, "method" | "path" | "query">>(request: T, projectId?: string): T {
  if (!projectId) return request;
  const route = request.path.startsWith("/api/") ? request.path.slice(5) : "";
  const read = request.method === "GET" || request.method === "HEAD";
  // A Library source is owned elsewhere, but its copies and preview values
  // belong to the selected branch. Mutations keep their global object scope.
  if (read && /^playlists\/[^/]+(?:\/instances)?$/.test(route)
    || request.method === "POST" && /^playlists\/[^/]+\/expand$/.test(route)) {
    return { ...request, query: { ...request.query, project: projectId } };
  }
  if (read && GLOBAL_LISTS.has(route)) return { ...request, query: { ...request.query, project: projectId } };
  // Catalogue details are public type IDs; instance IDs remain global.
  if (route === "card-types" || route.startsWith("card-types/")) return { ...request, query: { ...request.query, project: projectId } };
  // A background set and an image have no project path form; the catalog is platform-owned, so only the selection travels.
  if (/^backgrounds\/(?:sets\/[^/]+|bg_[^/]+)$/.test(route)) return { ...request, query: { ...request.query, project: projectId } };
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
