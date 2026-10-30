// Change control for campaigns and playlist schedules: revision history, restore, promote and preview.
import { isDeepStrictEqual } from "node:util";
import type { CalendarGroup, CampaignRevision, RevisionAuthor, RevisionPage, ScheduleCalendar, SchedulePreview, SchedulePreviewReach, ScreenScheduleRevision } from "./adapters/protocol.js";
import { instantInZone } from "./screen-control.js";
import { usageError } from "./problems.js";
import { table } from "./webhooks.js";

/** Screen ids a preview prints before pointing at the JSON for the rest. */
const REACH_IDS_SHOWN = 10;
/** Groups and stretches a calendar side prints before pointing at the JSON for the rest. */
const GROUPS_SHOWN = 5;
const STRETCHES_SHOWN = 12;
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** --calendar-from and --calendar-to are instants with a zone, as the preview routes read from and to. */
export function calendarInstantOption(flag: "--calendar-from" | "--calendar-to"): (value: string) => string {
  return (value) => {
    if (!RFC3339_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
      throw usageError(`${flag} takes an instant with a zone, such as 2026-12-01T00:00:00Z or 2026-12-01T00:00:00-05:00.`);
    }
    return value;
  };
}

function authorText(author: RevisionAuthor | undefined): string {
  return author ? `${author.name} (${author.type})` : "—";
}

/** A restore or promote copies a revision forward, so the row names the one it copied. */
function changeText(item: { change: string; restored_from?: number }): string {
  return (item.change === "restored" || item.change === "promoted") && item.restored_from !== undefined ? `${item.change} from ${item.restored_from}` : item.change;
}

function nextPageLine(command: string, page: RevisionPage<unknown> | undefined): string[] {
  const next = typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return next ? [`next: ${command} --after ${next}`] : [];
}

/** The human page of `campaign revisions`: one row per revision, and the command that reads the next page. */
export function campaignRevisionLines(id: string, page: RevisionPage<CampaignRevision> | undefined): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  const last = !(typeof page?.next_cursor === "string" && page.next_cursor);
  return [
    `Campaign ${id} revisions (${items.length})`,
    ...(items.length
      ? table(["REVISION", "CHANGE", "STATE", "CREATED", "AUTHOR", "NAME", "PLAYLIST"], items.map((item) => [
        `${item.revision}${item.current ? " (current)" : ""}`, changeText(item), item.campaign?.paused ? "paused" : "live",
        item.created_at, authorText(item.author), item.campaign?.name ?? "", item.campaign?.playlist_id ?? "",
      ]))
      : ["No revisions"]),
    ...(items.length && last && items.every((item) => item.campaign?.paused) ? ["No revision has been published: this campaign is a draft."] : []),
    ...nextPageLine(`screenrig campaign revisions ${id}`, page),
  ];
}

/** The human page of `screen schedule revisions`. */
export function screenScheduleRevisionLines(id: string, page: RevisionPage<ScreenScheduleRevision> | undefined): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  return [
    `Screen ${id} playlist schedule revisions (${items.length})`,
    ...(items.length
      ? table(["REVISION", "CHANGE", "ENTRIES", "DRAFTS", "CREATED", "AUTHOR"], items.map((item) => {
        const entries = Array.isArray(item.entries) ? item.entries : [];
        return [`${item.revision}${item.current ? " (current)" : ""}`, changeText(item), String(entries.length), String(entries.filter((entry) => entry.paused).length), item.created_at, authorText(item.author)];
      }))
      : ["No revisions"]),
    ...nextPageLine(`screenrig screen schedule revisions ${id}`, page),
  ];
}

function reachLine(verb: "Gains" | "Loses", reach: SchedulePreviewReach | undefined): string {
  const count = reach?.count ?? 0;
  if (!count) return `${verb} no screens`;
  const ids = Array.isArray(reach?.screen_ids) ? reach.screen_ids : [];
  const shown = ids.slice(0, REACH_IDS_SHOWN).join(", ");
  const more = count > REACH_IDS_SHOWN ? ` and ${count - REACH_IDS_SHOWN} more (the JSON lists up to ${ids.length} ids)` : "";
  return `${verb} ${count} screen${count === 1 ? "" : "s"}: ${shown}${more}`;
}

/** A minute in the group's zone, without the zone name (the group line carries it). */
function localMinute(value: string, timezone: string | undefined): string {
  return instantInZone(value, timezone).slice(0, 16);
}

function levelText(group: CalendarGroup, id: string | undefined): string {
  if (!id) return "nothing plays";
  const level = [...(group.levels ?? []), ...(group.paused_levels ?? [])].find((item) => item.id === id);
  return level ? `${id} (${level.playlist_id})` : id;
}

/** What plays on the group's first display, page only, as consecutive stretches, then the drafts that would hold. */
function groupLines(group: CalendarGroup): string[] {
  const zone = group.timezone || undefined;
  const onScreen = (Array.isArray(group.on_screen) ? group.on_screen : []).filter((item) => !item.region);
  const display = Math.min(...onScreen.map((item) => item.display));
  const stretches: Array<{ from: string; to: string; level_id: string | undefined }> = [];
  for (const item of onScreen.filter((candidate) => candidate.display === display)) {
    const previous = stretches.at(-1);
    if (previous && previous.to === item.from && previous.level_id === item.level_id) previous.to = item.to;
    else stretches.push({ from: item.from, to: item.to, level_id: item.level_id });
  }
  const drafts = (Array.isArray(group.spans) ? group.spans : []).filter((span) => span.state === "paused");
  const row = (from: string, to: string, text: string) => `    ${localMinute(from, zone)} → ${localMinute(to, zone)}  ${text}`;
  return [
    `  ${group.screens} screen${group.screens === 1 ? "" : "s"}, ${zone ?? "UTC"}${group.displays > 1 ? `, display ${display}` : ""}`,
    ...(stretches.length ? stretches.slice(0, STRETCHES_SHOWN).map((item) => row(item.from, item.to, levelText(group, item.level_id))) : ["    nothing is scheduled"]),
    ...(stretches.length > STRETCHES_SHOWN ? [`    … ${stretches.length - STRETCHES_SHOWN} more stretches (see the JSON)`] : []),
    ...drafts.slice(0, STRETCHES_SHOWN).map((span) => row(span.from, span.to, `draft ${levelText(group, span.level_id)}`)),
    ...(drafts.length > STRETCHES_SHOWN ? [`    … ${drafts.length - STRETCHES_SHOWN} more draft stretches (see the JSON)`] : []),
  ];
}

function calendarSideLines(label: string, calendar: ScheduleCalendar | undefined): string[] {
  const groups = Array.isArray(calendar?.groups) ? calendar.groups : [];
  return [
    label,
    ...(groups.length ? groups.slice(0, GROUPS_SHOWN).flatMap(groupLines) : ["  no screens"]),
    ...(groups.length > GROUPS_SHOWN ? [`  … ${groups.length - GROUPS_SHOWN} more groups (see the JSON)`] : []),
    ...(calendar?.truncated ? ["  (the calendar was cut short; ask for a shorter window)"] : []),
  ];
}

/** The human view of a preview: who gains and loses the write, then the calendar before and after (one line when it does not change). */
export function schedulePreviewLines(title: string, preview: SchedulePreview | undefined): string[] {
  const before = preview?.calendar?.before;
  const after = preview?.calendar?.after;
  const window = `${before?.from ?? after?.from ?? ""} to ${before?.to ?? after?.to ?? ""}`;
  return [
    `Preview of ${title}. Nothing was changed.`,
    reachLine("Gains", preview?.gained),
    reachLine("Loses", preview?.lost),
    ...(isDeepStrictEqual(before, after)
      ? [`Calendar ${window}: no change`]
      : [`Calendar ${window}`, ...calendarSideLines("Before", before), ...calendarSideLines("After", after)]),
  ];
}
