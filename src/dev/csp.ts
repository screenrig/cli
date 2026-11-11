/**
 * The Content-Security-Policy every served release file carries, the same
 * policy the release host sends: a copy of the backend's `releaseAssetPolicy`.
 * The application may be framed by its own Player (the external ancestor) and
 * by itself; a page that needs a looser or stricter policy than this cannot ship.
 */
export function releaseCsp(playerOrigin: string): string {
  return "default-src 'self' https: http: data: blob:; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http: blob:; " +
    "style-src 'self' 'unsafe-inline' https: http:; " +
    "img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; font-src 'self' data: https: http:; " +
    "connect-src 'self' https: http: wss: ws: data: blob:; frame-src https: http:; worker-src 'self' blob:; " +
    "object-src 'none'; base-uri 'self'; form-action 'self' https:; frame-ancestors 'self' " + playerOrigin;
}

/** The policy of the harness page itself: same-origin script, style and events, and the application's origin as its one frame. */
export function harnessCsp(appOrigin: string): string {
  return "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-src " + appOrigin + "; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}
