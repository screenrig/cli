import type { Screen, ScreenHealth } from "./adapters/protocol.js";

/** Backend hysteresis start (hot at or above 80 °C) and the crash count that reads as crashing. */
export const HEALTH_HOT_C = 80;
export const HEALTH_CRASHING_24H = 3;

function duration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The problems `screen list` flags: a disconnected display, a hot device
 * (80 °C or more), crashing (3 or more crashes in 24 hours), or a stale report.
 */
export function healthIssues(health: ScreenHealth | undefined): string[] {
  if (!health || typeof health !== "object") return [];
  const issues: string[] = [];
  if (health.stale === true) issues.push("stale");
  if (health.display?.connected === false) issues.push("display disconnected");
  if (number(health.temperature_c) && health.temperature_c >= HEALTH_HOT_C) issues.push(`hot ${Math.round(health.temperature_c)}°C`);
  if (number(health.crashes_24h) && health.crashes_24h >= HEALTH_CRASHING_24H) issues.push(`crashing ${health.crashes_24h}/24h`);
  return issues;
}

export function screenHealthIssues(screen: Screen | undefined): string[] {
  return healthIssues(screen?.health);
}

/** The compact `Health` block of `screen show --human`; nothing when the Player never reported. */
export function healthLines(health: ScreenHealth | undefined): string[] {
  if (!health || typeof health !== "object" || typeof health.reported_at !== "string") return [];
  const lines = [health.stale ? "Health (stale: no report for over 15 minutes)" : "Health"];
  const add = (key: string, value: string | undefined) => { if (value) lines.push(`${key}: ${value}`); };
  add("reported_at", health.reported_at);
  const uptime = [
    number(health.uptime_s) ? `device ${duration(health.uptime_s)}` : undefined,
    number(health.app_uptime_s) ? `player ${duration(health.app_uptime_s)}` : undefined,
  ].filter(Boolean).join(", ");
  add("uptime", uptime);
  const memory = health.memory;
  if (number(memory?.used_bytes) && number(memory?.total_bytes) && memory.total_bytes > 0) {
    add("memory", `${Math.round((memory.used_bytes / memory.total_bytes) * 100)}% of ${(memory.total_bytes / 1024 ** 3).toFixed(1)} GiB`);
  }
  const cpu = health.cpu;
  add("cpu", [number(cpu?.load_1m) ? `load ${cpu.load_1m.toFixed(2)}` : undefined, number(cpu?.cores) ? `${cpu.cores} cores` : undefined].filter(Boolean).join(", "));
  if (number(health.temperature_c)) add("temperature", `${health.temperature_c.toFixed(1)} °C${health.temperature_c >= HEALTH_HOT_C ? " (hot)" : ""}`);
  const display = health.display;
  if (display) {
    add("display", [
      display.connected === true ? "connected" : display.connected === false ? "disconnected" : undefined,
      display.power ? `power ${display.power}` : undefined,
    ].filter(Boolean).join(", "));
  }
  const network = health.network;
  if (network) {
    add("network", [network.kind, number(network.wifi_rssi_dbm) ? `${network.wifi_rssi_dbm} dBm` : undefined].filter(Boolean).join(", "));
  }
  const crashes = [
    number(health.crashes_24h) ? `${health.crashes_24h} crashes` : undefined,
    number(health.renderer_restarts_24h) ? `${health.renderer_restarts_24h} renderer restarts` : undefined,
  ].filter(Boolean).join(", ");
  add("last 24h", crashes);
  const issues = healthIssues(health).filter((issue) => issue !== "stale");
  add("attention", issues.join(", "));
  return lines;
}

const CHANGE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:+-]{1,64}$/;

/**
 * screen.health_changed details.changes as one logfmt value:
 * `display_disconnected,display_power from=on to=standby,temperature_high temperature_c=82`.
 */
export function healthChangesText(changes: unknown): string | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of changes) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.change !== "string" || !CHANGE_NAME.test(record.change)) continue;
    const fields = Object.keys(record).filter((key) => key !== "change" && CHANGE_NAME.test(key)).sort()
      .filter((key) => number(record[key]) || (typeof record[key] === "string" && SAFE_VALUE.test(record[key] as string)))
      .map((key) => `${key}=${String(record[key])}`);
    parts.push([record.change, ...fields].join(" "));
  }
  return parts.length ? parts.join(",") : undefined;
}
