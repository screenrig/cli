import type { DashboardLink } from "./adapters/protocol.js";
import { usageError } from "./problems.js";

export interface ValidatedDashboardLink {
  /** Absolute link URL. The fragment holds the single-use token. */
  url: string;
  expiresAt: string;
}

/**
 * Dashboard origin the configured control-plane origin implies.
 *
 * The link is opened in a browser, so the CLI must not accept whatever origin
 * the response names. Binding it to the configured origin keeps a substituted
 * or tampered response from steering the browser somewhere else with a live
 * token in the fragment.
 */
export function dashboardOriginFor(apiUrl: string): string {
  const api = new URL(apiUrl);
  const documentedLocalHttp = api.protocol === "http:" && api.hostname === "api.screenrig.localhost";
  if (api.protocol !== "https:" && !documentedLocalHttp) {
    throw usageError("dashboard requires HTTPS or the documented HTTP api.screenrig.localhost development origin.");
  }
  const host = api.hostname === "api.screenrig.ai"
    ? "dashboard.screenrig.ai"
    : api.hostname === "api.screenrig.localhost"
      ? "dashboard.screenrig.localhost"
      : undefined;
  if (!host) throw usageError("dashboard requires api.screenrig.ai as the configured origin.");
  return `${host}${api.port ? `:${api.port}` : ""}`;
}

/**
 * Accept only `<dashboard-origin>/#link=<43 base64url characters>`.
 *
 * A query, a path, or credentials in the authority would put the token
 * somewhere a server log, a proxy, or a `Referer` header can see it, so any of
 * those is a rejection rather than something to strip and continue with.
 */
export function validateDashboardLink(value: DashboardLink, apiUrl: string): ValidatedDashboardLink {
  const expectedHostPort = dashboardOriginFor(apiUrl);
  if (typeof value?.url !== "string" || typeof value?.expires_at !== "string"
    || Number.isNaN(Date.parse(value.expires_at))) {
    throw usageError("Dashboard link response does not match the generated DashboardLink contract.");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw usageError("Dashboard link response contains an invalid URL.");
  }
  const localHttp = url.protocol === "http:" && url.hostname.endsWith(".localhost");
  if (
    (url.protocol !== "https:" && !localHttp)
    || url.host !== expectedHostPort
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.pathname !== "/"
    || !/^#link=[A-Za-z0-9_-]{43}$/.test(url.hash)
  ) {
    throw usageError("Dashboard link response contains an unsafe URL.");
  }
  return { url: url.href, expiresAt: value.expires_at };
}
