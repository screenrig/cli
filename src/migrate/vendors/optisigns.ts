import { usageError } from "../../problems.js";
import { cursorPages, vendorBadResponse } from "../http.js";
import { kindOf } from "../map.js";
import type { LocalFiles } from "../local-files.js";
import type {
  MediaKind, ReportEntry, SourceCatalog, SourceGroup, SourceItem, SourceMedia, SourcePlaylist, SourceSchedule, SourceScreen, VendorAdapter, VendorClient, VendorSession, Weekday,
} from "../types.js";

/**
 * OptiSigns, GraphQL API. The API lists devices, assets, playlists and schedules
 * but documents no way to download a file, so every media has no address here:
 * its bytes come from the files the person downloaded (`--files`), matched on
 * the asset's file name. Playlists, schedules and screens come from the API
 * either way. A device shows an asset, a playlist or a schedule; a schedule's
 * events (an RRULE and a time range each) become campaigns for the devices that
 * use it, and need --timezone because the API gives them as UTC instants.
 */

const NAME = "OptiSigns";
const ENDPOINT = "https://graphql-gateway.optisigns.com/graphql";
const PAGE = 100;
const WEEKDAYS: Record<string, Weekday> = { MO: "mon", TU: "tue", WE: "wed", TH: "thu", FR: "fri", SA: "sat", SU: "sun" };
const NO_DOWNLOAD = "Download your files from OptiSigns into one folder and rerun migrate scan with --files DIR.";
const APP_NEXT = "Rebuild it as a built-in card, an iframe page or a stream page in a playlist.";

interface Connection<T> {
  page?: { edges?: Array<{ node?: T }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
}
interface Asset {
  _id: string;
  accountId?: string | null;
  name?: string | null;
  filename?: string | null;
  originalFileName?: string | null;
  fileType?: string | null;
  type?: string | null;
  appType?: string | null;
  webLink?: string | null;
  AWSS3ID?: string | null;
  screenZones?: unknown;
}
interface PlaylistItem {
  _id?: string | null;
  filename?: string | null;
  fileType?: string | null;
  type?: string | null;
  appType?: string | null;
  webLink?: string | null;
  duration?: number | null;
  srcDuration?: number | null;
  AWSS3ID?: string | null;
}
interface Playlist {
  _id: string;
  accountId?: string | null;
  name?: string | null;
  options?: { shuffle?: boolean | null; backgroundAudio?: string | null; backgroundAudioName?: string | null } | null;
  assets?: PlaylistItem[] | null;
}
interface Device {
  _id: string;
  accountId?: string | null;
  deviceName?: string | null;
  name?: string | null;
  tags?: string[] | null;
  currentType?: string | null;
  currentAssetId?: string | null;
  currentPlaylistId?: string | null;
  currentScheduleId?: string | null;
}
interface Schedule {
  _id: string;
  accountId?: string | null;
  name?: string | null;
  defaultAssetId?: string | null;
}
interface ScheduleItem {
  _id: string;
  name?: string | null;
  type?: string | null;
  assetId?: string | null;
  playlistId?: string | null;
  single?: boolean | null;
  parentScheduleId?: string | null;
  range?: { startDate?: string | null; endDate?: string | null } | null;
  repeatObject?: { rrule?: string | null } | null;
}

function validZone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const isHttp = (value: string | null | undefined): value is string => typeof value === "string" && /^https?:\/\//i.test(value.trim());

/** A civil YYYY-MM-DDTHH:MM, read from an instant in a zone. */
export function civil(instant: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(instant).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

type Repeat = NonNullable<SourceSchedule["repeat"]>;
type RuleResult = { ok: true; repeat?: Repeat } | { ok: false; reason: string };

const FREQUENCY: Record<string, Repeat["every"]> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year", HOURLY: "hour", MINUTELY: "minute" };

/** An RRULE (with or without its DTSTART line) as the repeat a campaign can express, or the reason it cannot be. */
export function parseRule(text: string | null | undefined, zone: string): RuleResult {
  let rule: string | undefined;
  for (const line of (text ?? "").split(/\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("DTSTART")) continue;
    if (/^(EXDATE|RDATE|EXRULE)/.test(upper)) return { ok: false, reason: "It skips or adds single dates, which campaigns cannot express." };
    rule = line.replace(/^RRULE:/i, "");
  }
  if (rule === undefined || rule === "") return { ok: true };
  const parts = new Map<string, string>();
  for (const part of rule.split(";")) {
    const cut = part.indexOf("=");
    if (cut > 0) parts.set(part.slice(0, cut).trim().toUpperCase(), part.slice(cut + 1).trim());
  }
  for (const key of parts.keys()) {
    if (!["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"].includes(key)) return { ok: false, reason: `It repeats by ${key}, which campaigns cannot express: they repeat on days of the week.` };
  }
  const every = FREQUENCY[(parts.get("FREQ") ?? "").toUpperCase()];
  if (!every) return { ok: false, reason: "Its repeat rule has no frequency campaigns can express." };
  const repeat: Repeat = { every };
  const interval = parts.get("INTERVAL");
  if (interval !== undefined) {
    if (!/^[1-9]\d*$/.test(interval)) return { ok: false, reason: "Its repeat interval could not be read." };
    repeat.interval = Number(interval);
  }
  const count = parts.get("COUNT");
  if (count !== undefined) {
    if (!/^[1-9]\d*$/.test(count)) return { ok: false, reason: "Its repeat count could not be read." };
    repeat.count = Number(count);
  }
  const byDay = parts.get("BYDAY");
  if (byDay !== undefined) {
    const weekdays: Weekday[] = [];
    for (const token of byDay.split(",")) {
      const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(token.trim());
      if (!match) return { ok: false, reason: "Its weekdays could not be read." };
      if (match[1] !== undefined) repeat.nth_weekday = true;
      weekdays.push(WEEKDAYS[match[2]!.toUpperCase()]!);
    }
    repeat.weekdays = weekdays;
  }
  const until = parts.get("UNTIL");
  if (until !== undefined) {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(until);
    if (!match) return { ok: false, reason: "The date its repeat ends on could not be read." };
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    repeat.until = match[7] ? civil(new Date(`${day}T${match[4]}:${match[5]}:${match[6]}Z`), zone).slice(0, 10) : day;
  }
  if (repeat.count === 1) return { ok: true };
  return { ok: true, repeat };
}

class OptiSignsSession implements VendorSession {
  constructor(private readonly client: VendorClient, private readonly files: LocalFiles | undefined, private readonly timezone: string | undefined) {}

  private all<T>(field: string, args: string, node: string, extra: { declare?: string; variables?: Record<string, unknown> } = {}): Promise<T[]> {
    const text = `query($first:Int,$after:String${extra.declare ?? ""}){ ${field}(${args}first:$first, after:$after){ page{ edges{ cursor node{ ${node} } } pageInfo{ hasNextPage endCursor } } } }`;
    return cursorPages<T>(
      this.client,
      text,
      (data: Record<string, Connection<T> | undefined>) => {
        const page = data[field]?.page;
        if (!page || !Array.isArray(page.edges) || !page.pageInfo) throw vendorBadResponse(NAME, `${field}.page.edges or ${field}.page.pageInfo is missing`);
        return {
          items: page.edges.map((edge, index) => {
            if (!edge?.node) throw vendorBadResponse(NAME, `${field}.page.edges[${index}].node is missing`);
            return edge.node;
          }),
          hasNextPage: page.pageInfo.hasNextPage === true,
          endCursor: page.pageInfo.endCursor ?? null,
        };
      },
      { first: PAGE, ...(extra.variables ?? {}) },
    );
  }

  async scan(): Promise<SourceCatalog> {
    const devices = await this.all<Device>("devices", "query:{}, ", "_id accountId deviceName name tags currentType currentAssetId currentPlaylistId currentScheduleId");
    const assets = await this.all<Asset>("assets", "query:{}, ", "_id accountId name filename originalFileName fileType type appType webLink AWSS3ID screenZones{ id }");
    const playlists = await this.all<Playlist>(
      "playlists", "query:{}, ",
      "_id accountId name options{ shuffle backgroundAudio backgroundAudioName } assets{ _id filename fileType type appType webLink duration srcDuration AWSS3ID }",
    );
    const schedules = await this.all<Schedule>("schedules", "query:{}, ", "_id accountId name defaultAssetId");
    for (const [path, rows] of [["devices", devices], ["assets", assets], ["playlists", playlists], ["schedules", schedules]] as const) {
      (rows as Array<{ _id?: unknown }>).forEach((row, index) => {
        if (typeof row._id !== "string" || row._id === "") throw vendorBadResponse(NAME, `${path}.page.edges[${index}].node._id is missing`);
      });
    }

    const notImported: ReportEntry[] = [];
    const notes: string[] = [];
    const media: SourceMedia[] = [];
    const mediaKinds = new Map<string, MediaKind>();
    const webPages = new Map<string, { url: string; title: string }>();
    const assetName = new Map<string, string>();

    // ---- assets
    const byStorage = new Map<string, string>();
    const byName = new Map<string, string[]>();
    for (const asset of assets) {
      const candidates = [...new Set([asset.originalFileName, asset.filename].map((value) => (value ?? "").trim()).filter(Boolean))];
      const name = (asset.name ?? "").trim() || candidates[0] || `Asset ${asset._id.slice(0, 8)}`;
      assetName.set(asset._id, name);
      const skip = (reason: string, next?: string): void => {
        notImported.push({ kind: "media", source_id: asset._id, name, reason, ...(next ? { next } : {}) });
      };
      if (asset.screenZones) {
        skip("It is a multi-zone screen layout, which the OptiSigns API does not describe fully enough to rebuild.", "Rebuild it as a layout playlist.");
        continue;
      }
      const kind = fileKind(asset.fileType, candidates[0]);
      if (kind && candidates.length > 0) {
        const filename = candidates.find((candidate) => (this.files?.match(candidate) ?? []).length > 0) ?? candidates[0]!;
        media.push({ id: asset._id, name, filename, kind, original: true });
        mediaKinds.set(asset._id, kind);
        if (asset.AWSS3ID) byStorage.set(asset.AWSS3ID, asset._id);
        for (const candidate of candidates) byName.set(candidate.toLowerCase(), [...(byName.get(candidate.toLowerCase()) ?? []), asset._id]);
      } else if (isHttp(asset.webLink)) {
        webPages.set(asset._id, { url: asset.webLink.trim(), title: name });
      } else if ((asset.fileType ?? "").toLowerCase() === "document") {
        skip("It is a document, not an image, video or audio file.", "Export its pages as images and upload them with media upload.");
      } else {
        notImported.push({ kind: "item", source_id: asset._id, name, reason: "It is an OptiSigns app with no web address in the API.", next: APP_NEXT });
      }
    }

    // ---- playlists
    let sawDuration = false;
    const catalogPlaylists: SourcePlaylist[] = playlists.map((playlist) => {
      const name = (playlist.name ?? "").trim() || `Playlist ${playlist._id.slice(0, 8)}`;
      const items: SourceItem[] = [];
      (playlist.assets ?? []).forEach((item, index) => {
        const label = (item.filename ?? "").trim() || (item.appType ?? "").trim() || "item";
        const skip = (reason: string, next?: string): void => {
          notImported.push({ kind: "item", source_id: `${playlist._id}:${item._id ?? index}`, name: `${name}: ${label}`, reason, ...(next ? { next } : {}) });
        };
        const kind = fileKind(item.fileType, item.filename ?? undefined);
        const seconds = typeof item.duration === "number" && item.duration > 0 ? item.duration : undefined;
        if (kind && (item.filename ?? "") !== "") {
          const named = byName.get(item.filename!.trim().toLowerCase()) ?? [];
          let id = (item.AWSS3ID ? byStorage.get(item.AWSS3ID) : undefined) ?? named[0];
          if (id === undefined) {
            // The file is in no asset the API listed: it still names a file to match in --files.
            id = `item:${item.filename!.trim().toLowerCase()}`;
            const filename = item.filename!.trim();
            media.push({ id, name: filename.replace(/\.[A-Za-z0-9]{1,8}$/, "") || filename, filename, kind, original: true });
            mediaKinds.set(id, kind);
            byName.set(filename.toLowerCase(), [id]);
          }
          const own = kind === "audio" ? undefined
            : kind === "video" ? (seconds !== undefined && (typeof item.srcDuration !== "number" || Math.abs(seconds - item.srcDuration) > 0.5) ? seconds : undefined)
              : seconds;
          if (own !== undefined) sawDuration = true;
          items.push({ media_id: id, ...(own !== undefined ? { duration_s: own } : {}) });
        } else if (isHttp(item.webLink)) {
          if (seconds !== undefined) sawDuration = true;
          items.push({ url: item.webLink.trim(), title: label === "item" ? item.webLink.trim() : label, ...(seconds !== undefined ? { duration_s: seconds } : {}) });
        } else if ((item.fileType ?? "").toLowerCase() === "document") {
          skip("It is a document, not an image, video or audio file.", "Export its pages as images and upload them with media upload.");
        } else {
          skip("It is an OptiSigns app with no web address in the API.", APP_NEXT);
        }
      });
      const playlistNotes: string[] = [];
      if (playlist.options?.backgroundAudio || playlist.options?.backgroundAudioName) playlistNotes.push("Its background audio does not come over.");
      return { id: playlist._id, name, items, ...(playlist.options?.shuffle === true ? { shuffle: true } : {}), notes: playlistNotes };
    });
    const playlistIds = new Set(catalogPlaylists.map((playlist) => playlist.id));

    // ---- content a device or an event names: a playlist, or one asset made into a playlist of its own
    const single = new Map<string, SourcePlaylist>();
    const contentOf = (id: string | null | undefined): { playlist_id: string } | undefined => {
      if (!id) return undefined;
      if (playlistIds.has(id)) return { playlist_id: id };
      const key = `asset:${id}`;
      if (single.has(key)) return { playlist_id: key };
      const name = assetName.get(id) ?? "Asset";
      if (mediaKinds.has(id)) single.set(key, { id: key, name, items: [{ media_id: id }], notes: [] });
      else if (webPages.has(id)) single.set(key, { id: key, name, items: [{ url: webPages.get(id)!.url, title: webPages.get(id)!.title }], notes: [] });
      else return undefined;
      return { playlist_id: key };
    };

    // ---- schedules: each one used by a device is a group of those devices, and its events target the group
    const usedBy = new Map<string, string[]>();
    for (const device of devices) {
      if ((device.currentType ?? "").toLowerCase() === "schedule" && device.currentScheduleId) usedBy.set(device.currentScheduleId, [...(usedBy.get(device.currentScheduleId) ?? []), device._id]);
    }
    const scheduleIds = new Set(schedules.map((schedule) => schedule._id));
    const groups: SourceGroup[] = [];
    const sourceSchedules: SourceSchedule[] = [];
    const scheduleDefault = new Map<string, { playlist_id: string } | undefined>();
    for (const schedule of schedules) {
      const name = (schedule.name ?? "").trim() || `Schedule ${schedule._id.slice(0, 8)}`;
      scheduleDefault.set(schedule._id, contentOf(schedule.defaultAssetId));
      if (!usedBy.has(schedule._id)) {
        notImported.push({ kind: "schedule", source_id: schedule._id, name, reason: "No screen uses this schedule." });
        continue;
      }
      groups.push({ id: `schedule:${schedule._id}`, name });
      const events = await this.all<ScheduleItem>(
        "scheduleItems", "query:{scheduleId:$scheduleId}, ",
        "_id name type assetId playlistId single parentScheduleId range{ startDate endDate } repeatObject{ rrule }",
        { declare: ",$scheduleId:String!", variables: { scheduleId: schedule._id } },
      );
      events.forEach((event, index) => {
        if (typeof event._id !== "string" || event._id === "") throw vendorBadResponse(NAME, `scheduleItems.page.edges[${index}].node._id is missing`);
        const title = (event.name ?? "").trim() || name;
        const problem = (reason: string, next?: string): void => {
          notImported.push({ kind: "schedule", source_id: event._id, name: title, reason, ...(next ? { next } : {}) });
        };
        const content = (event.type ?? "").toLowerCase() === "playlist" ? contentOf(event.playlistId) : contentOf(event.assetId);
        if (!content) return problem("The playlist or asset it plays did not come over.");
        if (!this.timezone) return problem("OptiSigns gives event times as exact instants without a time zone.", "Rerun migrate scan with --timezone ZONE, the zone your OptiSigns schedules use.");
        const start = event.range?.startDate ? new Date(event.range.startDate) : undefined;
        const end = event.range?.endDate ? new Date(event.range.endDate) : undefined;
        if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return problem("Its time range could not be read.");
        const rule = parseRule(event.repeatObject?.rrule, this.timezone);
        if (!rule.ok) return problem(rule.reason);
        const replaces = event.single === true && !!event.parentScheduleId;
        sourceSchedules.push({
          id: event._id,
          name: title,
          targets: { group_ids: [`schedule:${schedule._id}`], screen_ids: [] },
          content,
          start: civil(start, this.timezone),
          end: civil(end, this.timezone),
          timezone: this.timezone,
          ...(rule.repeat ? { repeat: rule.repeat } : {}),
          priority: replaces ? 10 : 0,
          notes: replaces ? ["It replaced one occurrence of a repeating event; it now takes priority over that event at its own time."] : [],
        });
      });
    }

    // ---- screens
    const tagGroups = new Map<string, string>();
    const catalogScreens: SourceScreen[] = devices.map((device): SourceScreen => {
      const ids: string[] = [];
      for (const tag of Array.isArray(device.tags) ? device.tags : []) {
        const text = typeof tag === "string" ? tag.trim() : "";
        if (!text) continue;
        const key = text.toLowerCase();
        if (!tagGroups.has(key)) {
          tagGroups.set(key, `tag:${key}`);
          groups.push({ id: `tag:${key}`, name: text });
        }
        if (!ids.includes(tagGroups.get(key)!)) ids.push(tagGroups.get(key)!);
      }
      const type = (device.currentType ?? "").toLowerCase();
      let content: SourceScreen["content"];
      if (type === "playlist") content = contentOf(device.currentPlaylistId);
      else if (type === "asset") content = contentOf(device.currentAssetId);
      else if (type === "schedule" && device.currentScheduleId) {
        if (scheduleIds.has(device.currentScheduleId)) ids.push(`schedule:${device.currentScheduleId}`);
        content = scheduleDefault.get(device.currentScheduleId);
      }
      return { id: device._id, name: (device.deviceName ?? device.name ?? "").trim() || `Device ${device._id.slice(0, 8)}`, group_ids: ids, ...(content ? { content } : {}), notes: [] };
    });

    if (!this.files) notes.push(`OptiSigns documents no way to download a file, so none of its media comes over from the API. ${NO_DOWNLOAD} Playlists, schedules and screens come over from the API either way.`);
    if (sawDuration) notes.push("OptiSigns documents item durations without a unit; they were read as seconds.");

    const account = [...devices, ...assets, ...playlists, ...schedules].map((row) => row.accountId).find((id): id is string => typeof id === "string" && id !== "");
    return {
      account: account ?? "optisigns",
      label: NAME,
      media,
      playlists: [...catalogPlaylists, ...single.values()],
      layouts: [],
      groups,
      screens: catalogScreens,
      schedules: sourceSchedules,
      not_imported: notImported,
      notes,
    };
  }

  async fetchMedia(): Promise<{ bytes: number }> {
    throw usageError("OptiSigns hands out no files: they come from --files.");
  }
}

/** The kind of file an OptiSigns `fileType` (image, video, document, ...) or a file name names. */
function fileKind(fileType: string | null | undefined, filename: string | undefined): MediaKind | undefined {
  const type = (fileType ?? "").toLowerCase();
  if (type === "image" || type === "video" || type === "audio") return type;
  if (type !== "") return undefined;
  return kindOf({ filename });
}

export const optisigns: VendorAdapter = {
  id: "optisigns",
  name: NAME,
  inputs: { timezone: true, files: "optional" },
  credentials: [{ env: "OPTISIGNS_API_KEY", secret: true, required: true, help: "An API key from OptiSigns, API Key settings." }],
  connect: [
    "In OptiSigns open API Keys (app.optisigns.com/app/s/apikeys), click New API Key, name it, and turn on the Screens, Files/Assets, Playlists and Schedules scopes with read access. The key is shown once.",
    "Making a key needs the Pro Plus plan or above, an Account Owner or Super Admin sign-in, and a portal that is not white-labeled.",
    "Put OPTISIGNS_API_KEY=... in a file and pass it with --credentials.",
    "OptiSigns has no way to download files through its API: download your files from OptiSigns into one folder and pass it with --files. Playlists, schedules and screens come from the API either way.",
    "Pass --timezone with the zone your OptiSigns schedules use: the API gives event times as exact instants without one.",
  ],
  maps: [
    "Image, video and audio assets become media once their files are in --files, matched on the asset's file name; web assets become web page items.",
    "Playlists keep their item order, durations and shuffle setting. A device that shows one asset gets a playlist of that asset.",
    "Devices become waiting screens; their tags become groups. A device on a schedule joins a group named after the schedule, and its default content is the schedule's default asset or playlist.",
    "Schedule events become campaigns for that group: daily and weekly repeats, with COUNT and UNTIL, exactly.",
  ],
  skips: [
    "Without --files every media is listed, and the playlists that need them wait.",
    "Documents, apps with no web address and multi-zone layouts are listed.",
    "Events that repeat by month or year or by another rule, events that skip single dates, and events without --timezone are listed with the reason.",
    "A playlist's background audio does not come over.",
  ],
  docs: [
    "https://docs.optisigns.com/generate-api-key",
    "https://support.optisigns.com/hc/en-us/articles/4414563797139-Generate-Manage-OptiSigns-API-Key",
    "https://docs.optisigns.com/fundamental/pagination",
    "https://docs.optisigns.com/quickstart",
    "https://api-doc.optisigns.com/",
  ],
  example: "screenrig migrate scan --from optisigns --files ./optisigns-downloads --timezone America/Toronto",
  async open(input) {
    const key = input.credentials.OPTISIGNS_API_KEY;
    const zone = input.timezone;
    return new OptiSignsSession(input.http.client({ base: ENDPOINT, auth: { Authorization: `Bearer ${key}` } }), input.files, validZone(zone) ? zone : undefined);
  },
};
