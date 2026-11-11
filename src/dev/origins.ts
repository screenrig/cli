import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The one port on which the runtime trusts the development harness as a parent
 * (the 18890 row of its trusted-origin table). The application document must be
 * served from `http://r-<40 hex>.apps.screenrig.localhost:18890` and the
 * harness page from `http://play.screenrig.localhost:18890`; on any other port
 * the runtime would refuse the parent and the application would stay inert.
 */
export const DEV_PORT = 18890;
export const PLAYER_HOST = "play.screenrig.localhost";
export const APP_HOST_SUFFIX = ".apps.screenrig.localhost";

const APP_HOST = /^r-[a-f0-9]{40}\.apps\.screenrig\.localhost$/;

export function playerOrigin(port: number): string {
  return `http://${PLAYER_HOST}:${port}`;
}

/** The release host of a directory: stable for the same directory, so the page keeps its browser storage between runs. */
export function releaseHostFor(directory: string): string {
  return `r-${createHash("sha1").update(path.resolve(directory)).digest("hex")}${APP_HOST_SUFFIX}`;
}

export function appOrigin(host: string, port: number): string {
  return `http://${host}:${port}`;
}

export function isReleaseHost(host: string): boolean {
  return APP_HOST.test(host);
}

/** Splits a Host header into a lower-case hostname and its port; undefined when it is not `name:port` or `name`. */
export function parseHostHeader(value: string | undefined): { hostname: string; port: string } | undefined {
  if (!value) return undefined;
  const match = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return undefined;
  return { hostname: match[1]!.toLowerCase(), port: match[2] ?? "" };
}
