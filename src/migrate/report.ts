import { createHash } from "node:crypto";
import {
  allocateTags, buildLayout, buildPlaylist, campaignTiming, DEFAULT_CANVAS, placeholderBody, tagAudience,
  type Built, type BuildContext, type CampaignTiming, type MediaRef, type PlaceholderBody, type TagWant,
} from "./map.js";
import type { ScannedCatalog } from "./state.js";
import type { ReportEntry, SourceCatalog, SourceLayout, SourcePlaylist, SourceSchedule, SourceScreen } from "./types.js";

export const REPORT_SCHEMA = "screenrig.migration-report/v1";

export interface Counts {
  media: number;
  playlists: number;
  layouts: number;
  schedules: number;
  groups: number;
  screens: number;
}

export interface LossyEntry {
  kind: ReportEntry["kind"];
  source_id: string;
  name: string;
  change: string;
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  vendor: string;
  label: string;
  scanned_at: string;
  found: Counts;
  importable: Counts;
  not_imported: ReportEntry[];
  lossy: LossyEntry[];
  notes: string[];
}

export function countsOf(catalog: Pick<SourceCatalog, "media" | "playlists" | "layouts" | "schedules" | "groups" | "screens">): Counts {
  return {
    media: catalog.media.length,
    playlists: catalog.playlists.length,
    layouts: catalog.layouts.length,
    schedules: catalog.schedules.length,
    groups: catalog.groups.length,
    screens: catalog.screens.length,
  };
}

/** A stand-in for a media id that does not exist yet: it only has to look like one. */
export function standInMediaId(sourceId: string): string {
  return `med_${createHash("sha256").update(sourceId).digest("hex").slice(0, 22)}`;
}

export function buildContext(catalog: ScannedCatalog, canvas: { width: number; height: number }, media: ReadonlyMap<string, MediaRef>): BuildContext {
  return {
    media,
    playlists: new Map(catalog.playlists.map((playlist) => [playlist.id, playlist])),
    layouts: new Map(catalog.layouts.map((layout) => [layout.id, layout])),
    canvas,
  };
}

export type ContentKey = `playlist:${string}` | `layout:${string}`;

export function contentKey(content: { playlist_id: string } | { layout_id: string }): ContentKey {
  return "playlist_id" in content ? `playlist:${content.playlist_id}` : `layout:${content.layout_id}`;
}

export interface Classified {
  /** Per `playlist:ID` and `layout:ID`: whether it can become a playlist, and what changes. */
  content: Map<ContentKey, Built>;
  /** Tags wanted by groups and by screens a schedule names, in the order they are allocated. */
  wants: TagWant[];
  /** Screens a schedule targets by id: they carry an own tag. */
  ownTagScreens: Set<string>;
  schedules: Map<string, { timing: CampaignTiming; targets: { groups: string[]; screens: string[] }; content: ContentKey } | { reason: string }>;
}

/** The screens a schedule names by id that the vendor listed. */
function targetedScreens(catalog: ScannedCatalog, schedule: SourceSchedule): SourceScreen[] {
  const known = new Map(catalog.screens.map((screen) => [screen.id, screen]));
  return schedule.targets.screen_ids.flatMap((id) => known.get(id) ?? []);
}

/**
 * What can come over, from the scan alone. Playlists and layouts are built with
 * stand-in media ids, so a refusal here is a refusal at apply too. Schedules are
 * judged on their timing, their targets and their content.
 */
export function classify(catalog: ScannedCatalog, canvas: { width: number; height: number } = DEFAULT_CANVAS): Classified {
  const media = new Map<string, MediaRef>(catalog.media.map((item) => [item.id, { id: standInMediaId(item.id), kind: item.kind }]));
  const ctx = buildContext(catalog, canvas, media);
  const content = new Map<ContentKey, Built>();
  for (const playlist of catalog.playlists) content.set(`playlist:${playlist.id}`, buildPlaylist(playlist, ctx));
  for (const layout of catalog.layouts) content.set(`layout:${layout.id}`, buildLayout(layout, { ...ctx, canvas }));
  const groupIds = new Set(catalog.groups.map((group) => group.id));
  const ownTagScreens = new Set<string>();
  const schedules: Classified["schedules"] = new Map();
  for (const schedule of catalog.schedules) {
    const timing = campaignTiming(schedule);
    const key = contentKey(schedule.content);
    const groups = schedule.targets.group_ids.filter((id) => groupIds.has(id));
    const screens = targetedScreens(catalog, schedule).map((screen) => screen.id);
    if (!timing.ok) schedules.set(schedule.id, { reason: timing.reason });
    else if (content.get(key)?.ok !== true) schedules.set(schedule.id, { reason: "The playlist it plays could not be imported." });
    else if (groups.length + screens.length === 0) schedules.set(schedule.id, { reason: "None of the groups or screens it targets came over." });
    else {
      schedules.set(schedule.id, { timing, targets: { groups, screens }, content: key });
      for (const id of screens) ownTagScreens.add(id);
    }
  }
  const wants: TagWant[] = [
    ...catalog.groups.map((group): TagWant => ({ key: `group:${group.id}`, name: group.name, fallback: "Group", id: group.id })),
    ...catalog.screens.filter((screen) => ownTagScreens.has(screen.id)).map((screen): TagWant => ({ key: `screen:${screen.id}`, name: screen.name, fallback: "Screen", id: screen.id })),
  ];
  return { content, wants, ownTagScreens, schedules };
}

/** The content a screen shows by default, when it can come over. */
export function screenContent(screen: SourceScreen, classified: Classified): ContentKey | undefined {
  if (!screen.content) return undefined;
  const key = contentKey(screen.content);
  return classified.content.get(key)?.ok === true ? key : undefined;
}

export function placeholderFor(screen: SourceScreen, tags: Readonly<Record<string, string>>, classified: Classified): PlaceholderBody {
  return placeholderBody(
    screen,
    (id) => tags[`group:${id}`],
    classified.ownTagScreens.has(screen.id) ? tags[`screen:${screen.id}`] : undefined,
  );
}

/** Builds the report from the catalog as it will be applied. `found` and `notImported` describe the vendor account as listed. */
export function buildReport(input: {
  vendor: string;
  label: string;
  scannedAt: string;
  catalog: ScannedCatalog;
  found: Counts;
  notImported: ReportEntry[];
  lossy: LossyEntry[];
  notes: string[];
  timezone?: string;
}): Report {
  const { catalog } = input;
  const classified = classify(catalog);
  const tags = allocateTags(classified.wants, []);
  const notImported = [...input.notImported];
  const lossy = [...input.lossy];
  const addLossy = (kind: ReportEntry["kind"], source_id: string, name: string, changes: readonly string[]): void => {
    for (const change of new Set(changes)) lossy.push({ kind, source_id, name, change });
  };
  let playlists = 0;
  let layouts = 0;
  const describe = (item: SourcePlaylist | SourceLayout, key: ContentKey, kind: "playlist" | "layout"): void => {
    const built = classified.content.get(key)!;
    if (built.ok) {
      if (kind === "playlist") playlists += 1;
      else layouts += 1;
    } else {
      notImported.push({ kind, source_id: item.id, name: item.name, reason: built.reason });
    }
    addLossy(kind, item.id, item.name, [...item.notes, ...built.lossy]);
  };
  for (const playlist of catalog.playlists) describe(playlist, `playlist:${playlist.id}`, "playlist");
  for (const layout of catalog.layouts) describe(layout, `layout:${layout.id}`, "layout");
  for (const group of catalog.groups) {
    const tag = tags[`group:${group.id}`]!;
    if (tag !== group.name) addLossy("group", group.id, group.name, [`The group is now the tag ${tag}.`]);
  }
  let noZone = 0;
  let noDefault = 0;
  for (const screen of catalog.screens) {
    const body = placeholderFor(screen, tags, classified);
    const wanted = screen.content ? contentKey(screen.content) : undefined;
    const changes = [...screen.notes, ...body.lossy];
    if (wanted !== undefined && screenContent(screen, classified) === undefined) {
      changes.push("The playlist it showed could not be imported, so it has no default playlist.");
    }
    if (screenContent(screen, classified) === undefined) noDefault += 1;
    if (screen.timezone === undefined && input.timezone === undefined) noZone += 1;
    addLossy("screen", screen.id, screen.name, changes);
  }
  const zoneOf = (screen: SourceScreen): string | undefined => screen.timezone ?? input.timezone;
  let schedules = 0;
  for (const schedule of catalog.schedules) {
    const verdict = classified.schedules.get(schedule.id)!;
    if ("reason" in verdict) {
      notImported.push({ kind: "schedule", source_id: schedule.id, name: schedule.name, reason: verdict.reason });
      continue;
    }
    schedules += 1;
    const changes = [...schedule.notes, ...verdict.timing.lossy];
    const reached = catalog.screens.filter((screen) => verdict.targets.screens.includes(screen.id) || screen.group_ids.some((id) => verdict.targets.groups.includes(id)));
    if (schedule.timezone !== undefined && reached.some((screen) => zoneOf(screen) !== schedule.timezone)) {
      changes.push(`Its times were read in ${schedule.timezone}; the campaign reads them in each screen's own time zone.`);
    }
    addLossy("schedule", schedule.id, schedule.name, changes);
  }
  const notes = [...input.notes];
  if (noZone > 0) notes.push(`No time zone was known for ${noZone} screen${noZone === 1 ? "" : "s"}; pass --timezone or set ${noZone === 1 ? "it" : "them"} after pairing (screen set-timezone). Campaigns with dates or hours wait for one (no_timezone).`);
  if (noDefault > 0) notes.push(`${noDefault} screen${noDefault === 1 ? " has" : "s have"} no default playlist; campaigns need one (no_default_playlist), so set it after pairing (screen assign).`);
  return {
    schema: REPORT_SCHEMA,
    vendor: input.vendor,
    label: input.label,
    scanned_at: input.scannedAt,
    found: input.found,
    importable: {
      media: catalog.media.length,
      playlists,
      layouts,
      schedules,
      groups: catalog.groups.length,
      screens: catalog.screens.length,
    },
    not_imported: notImported,
    lossy,
    notes,
  };
}

function group<T>(items: readonly T[], reasonOf: (item: T) => string): Array<{ reason: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(reasonOf(item), [...(groups.get(reasonOf(item)) ?? []), item]);
  return [...groups].map(([reason, list]) => ({ reason, items: list }));
}

function names(items: ReadonlyArray<{ name: string }>): string {
  const shown = items.slice(0, 5).map((item) => item.name).join(", ");
  return items.length > 5 ? `${shown}, and ${items.length - 5} more` : shown;
}

/** The counts, then each reason group with its count and up to five names. */
export function reportLines(report: Report, directory: string): string[] {
  const row = (label: string, found: number, importable: number): string => `${label}: ${importable} of ${found}`;
  const lines = [
    `Scan of ${report.label} (${report.vendor})`,
    "Can come over:",
    `  ${row("media", report.found.media, report.importable.media)}`,
    `  ${row("playlists", report.found.playlists, report.importable.playlists)}`,
    ...(report.found.layouts > 0 ? [`  ${row("layouts", report.found.layouts, report.importable.layouts)}`] : []),
    `  ${row("schedules", report.found.schedules, report.importable.schedules)}`,
    `  ${row("groups", report.found.groups, report.importable.groups)}`,
    `  ${row("screens", report.found.screens, report.importable.screens)}`,
  ];
  if (report.not_imported.length > 0) {
    lines.push("Cannot come over:");
    for (const entry of group(report.not_imported, (item) => item.reason)) {
      lines.push(`  ${entry.reason} (${entry.items.length}): ${names(entry.items)}`);
      const next = entry.items.find((item) => item.next)?.next;
      if (next) lines.push(`    next: ${next}`);
    }
  }
  if (report.lossy.length > 0) {
    lines.push("Changes on the way:");
    for (const entry of group(report.lossy, (item) => item.change)) lines.push(`  ${entry.reason} (${entry.items.length}): ${names(entry.items)}`);
  }
  for (const note of report.notes) lines.push(`note: ${note}`);
  lines.push(`full list: ${directory}/scan.json`);
  return lines;
}
