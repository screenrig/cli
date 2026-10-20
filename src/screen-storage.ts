import type { Screen, ScreenStorageForecastDryRun } from "./adapters/protocol.js";
import type { Warning } from "./envelope.js";

const STORAGE_CODES = new Set(["storage_full", "none_fit", "transition_blocked", "capacity"]);

export function isStorageFailureCode(code: string | undefined): boolean {
  return code !== undefined && STORAGE_CODES.has(code);
}

/** A saved assignment is not proof that the Player can load its content. */
export function storageFullWarning(screenId: string, fit: string): Warning {
  const impact = fit === "partial"
    ? "Some playlist pages can't be loaded."
    : fit === "transition_blocked"
      ? "Can't load the playlist update."
      : "Can't load this playlist.";
  return {
    code: "storage_full",
    message: `Screen ${screenId}: Storage full. ${impact} Ask the user to free up storage on the device running this Player, then retry the playlist.`,
  };
}

function limited(fit: string | undefined): fit is "partial" | "none_fit" | "transition_blocked" {
  return fit === "partial" || fit === "none_fit" || fit === "transition_blocked";
}

function withReportAge(warning: Warning, receivedAt: string | null | undefined, now: Date): Warning {
  const received = receivedAt ? Date.parse(receivedAt) : Number.NaN;
  return Number.isFinite(received) && now.getTime() - received > 86_400_000
    ? { ...warning, message: `${warning.message} This storage report is more than 24 hours old; check the device's current storage.` }
    : warning;
}

/** Prefer the requested playlist's forecast over an older playlist's report. */
export function screenStorageWarnings(screenId: string, screen: Screen | undefined, now: Date): Warning[] {
  if (!screen) return [];
  const upgrade = screen.manifest_upgrade;
  if (upgrade && ["blocked", "failed", "retrying", "partial"].includes(upgrade.state)
    && isStorageFailureCode(upgrade.code ?? undefined)) {
    const updating = upgrade.active_playlist?.id !== undefined
      && upgrade.active_playlist.id === upgrade.desired_playlist?.id;
    const fit = upgrade.state === "partial" ? "partial" : updating ? "transition_blocked" : "none_fit";
    return [storageFullWarning(screenId, fit)];
  }
  const forecast = screen.storage_forecast;
  const shortfall = screen.storage_shortfall;
  const sameRevision = !forecast || screen.storage?.plan?.manifest_revision === forecast.manifest_revision;
  if (shortfall && limited(shortfall.fit) && sameRevision) {
    return [withReportAge(storageFullWarning(screenId, shortfall.fit), screen.storage?.received_at, now)];
  }
  if (forecast) {
    return limited(forecast.fit)
      ? [withReportAge(storageFullWarning(screenId, forecast.fit), screen.storage?.received_at ?? forecast.received_at, now)]
      : [];
  }
  if (shortfall && limited(shortfall.fit)) {
    return [withReportAge(storageFullWarning(screenId, shortfall.fit), screen.storage?.received_at, now)];
  }
  return [];
}

export function forecastStorageWarnings(screenId: string, forecast: ScreenStorageForecastDryRun, now: Date): Warning[] {
  return limited(forecast.fit)
    ? [withReportAge(storageFullWarning(screenId, forecast.fit), forecast.received_at, now)]
    : [];
}
