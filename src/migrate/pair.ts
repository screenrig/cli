import type { PairingClaim } from "../adapters/protocol.js";
import type { ApiClient } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { placeholderKey, sourceRef } from "./apply.js";
import { cleanName, truncate } from "./map.js";
import { classify, placeholderFor, screenContent } from "./report.js";
import { fingerprintOf, migrationKey, type MigrationDir, type ScanFile } from "./state.js";
import type { SourceScreen } from "./types.js";

export interface PairResult {
  data: {
    source_id: string;
    name: string;
    screen_id: string;
    public_url?: string;
    steps: string[];
    next: { command: string; reason: string };
  };
  human: string;
}

/** A placeholder by its source id, else by its exact old name; an ambiguous name lists the ids. */
export function findPlaceholder(scan: ScanFile, wanted: string): SourceScreen {
  const screens = scan.catalog.screens;
  const byId = screens.find((screen) => screen.id === wanted);
  if (byId) return byId;
  const named = screens.filter((screen) => screen.name === wanted);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw usageError(`${named.length} screens are named ${JSON.stringify(wanted)}: ${named.map((screen) => JSON.stringify(screen.id)).join(", ")}. Pass the source id of the one you mean.`);
  }
  throw usageError(`No screen in the scan has the source id or the exact name ${JSON.stringify(wanted)}.`, {
    command: "screenrig migrate scan --from VENDOR",
    reason: "The scan in this directory lists the vendor's screens; scan again if the list is out of date.",
  });
}

/**
 * Claims a Player code for one placeholder: pairs the screen under its old name,
 * gives it its playlist, time zone and tags, deletes the placeholder's link, and
 * records it. Each step is recorded as it lands, so a rerun finishes what an
 * interrupted pair left.
 */
export async function runPair(input: {
  runtime: CliRuntime;
  client: ApiClient;
  dir: MigrationDir;
  scan: ScanFile;
  apiUrl: string;
  projectId: string;
  code: string;
  screen: string;
}): Promise<PairResult> {
  const { client, dir, scan } = input;
  const release = await dir.lock();
  try {
    const map = await dir.readMap();
    if (!map) {
      throw usageError(`${dir.dir} has no map, so no placeholder has been made. Run migrate apply first.`, {
        command: `screenrig migrate apply --dir ${dir.dir}`,
        reason: "Imports the media and playlists and makes the placeholders; migrate pair then claims a Player code for one of them.",
      });
    }
    dir.checkBinding(map, { api_url: input.apiUrl, project_id: input.projectId, vendor: scan.vendor, account: scan.account });
    const source = findPlaceholder(scan, input.screen);
    const key = placeholderKey(source.id);
    const entry = map.items[key];
    if (entry?.finished) {
      throw new CliError(makeProblem("resource_conflict", "Placeholder already paired", 409,
        `${source.name} is already screen ${entry.screen_id ?? "(unknown)"}. A placeholder pairs once.`, {
          next: entry.screen_id ? { command: `screenrig screen show ${entry.screen_id}`, reason: "Shows the screen this placeholder became." } : undefined,
        }), ExitCode.Conflict);
    }
    const classified = classify(scan.catalog);
    const content = screenContent(source, classified);
    const playlistId = content === undefined ? undefined : map.items[content]?.id;
    if (content !== undefined && playlistId === undefined) {
      throw usageError(`${source.name} shows a playlist that has not been imported. Run migrate apply first, then pair.`, {
        command: `screenrig migrate apply --dir ${dir.dir}`,
        reason: "Imports the playlists the placeholders show.",
      });
    }
    const body = placeholderFor(source, map.tags, classified);
    const steps: string[] = [];
    const stamp = (): string => input.runtime.now().toISOString();
    let screenId = entry?.screen_id;
    let publicUrl: string | undefined;
    if (screenId === undefined) {
      const claim = await client.call({
        method: "POST", path: "/api/screens/pair", idempotent: true,
        idempotencyKey: migrationKey(map.seed, key, "pair", input.code),
        body: { code: input.code, label: body.label },
      });
      const paired = claim.body as PairingClaim;
      if (!paired.screen?.id) throw usageError("The pairing answer did not name a screen.");
      screenId = paired.screen.id;
      publicUrl = paired.public_url;
      map.items[key] = { ...entry, screen_id: screenId, at: stamp() };
      await dir.writeMap(map);
      steps.push("paired");
    }
    const timezone = source.timezone ?? scan.inputs.timezone;
    const update = {
      ...(playlistId !== undefined ? { playlist_id: playlistId } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      fields: { migrated_from: sourceRef(scan.vendor, source.id) },
    };
    await client.call({
      method: "PATCH", path: `/api/screens/${screenId}`, idempotent: true,
      idempotencyKey: migrationKey(map.seed, key, "pair-update", fingerprintOf(update)), body: update,
    });
    steps.push("updated");
    await client.call({
      method: "PATCH", path: `/api/screens/${screenId}`, idempotent: true,
      idempotencyKey: migrationKey(map.seed, key, "pair-tags", fingerprintOf(body.tags)), body: { tags: body.tags },
    });
    steps.push("tagged");
    if (entry?.fleet_link_id !== undefined) {
      try {
        await client.call({ method: "DELETE", path: `/api/fleet-links/${entry.fleet_link_id}`, idempotent: true, idempotencyKey: migrationKey(map.seed, key, "unlink", entry.fleet_link_id) });
        steps.push("link deleted");
      } catch (error) {
        if (!(error instanceof CliError && error.problem.status === 404)) throw error;
      }
    }
    map.items[key] = { ...map.items[key], screen_id: screenId, finished: true, at: stamp() };
    await dir.writeMap(map);
    steps.push("recorded");
    const label = truncate(cleanName(source.name) || "Imported screen", 80).text;
    const next = { command: `screenrig screen show ${screenId}`, reason: "The Player finishes pairing the next time it contacts the service; screen show reports state active and online true once it has. screen screenshot shows what it plays." };
    return {
      data: { source_id: source.id, name: label, screen_id: screenId, ...(publicUrl !== undefined ? { public_url: publicUrl } : {}), steps, next },
      human: [`Paired ${label} as screen ${screenId}`, `steps: ${steps.join(", ")}`, `next: ${next.command}`].join("\n"),
    };
  } finally {
    await release();
  }
}

