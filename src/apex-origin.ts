/** Each public API origin's apex host, where the dashboard and the browser handoff live. */
const APEX_HOSTS = new Map([
  ["api.screenrig.ai", "screenrig.ai"],
  ["api.stage.screenrig.ai", "stage.screenrig.ai"],
  ["api.screenrig.localhost", "screenrig.localhost"],
]);

export function apexHost(apiHostname: string): string | undefined {
  return APEX_HOSTS.get(apiHostname);
}
