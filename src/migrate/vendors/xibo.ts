import { CliError, usageError } from "../../problems.js";
import { vendorBadResponse } from "../http.js";
import { asRow, flag, idOf as idIn, num, rows, text, zoneOf, type Row } from "./xy-rows.js";
import type {
  ReportEntry, SourceCatalog, SourceGroup, SourceItem, SourceLayout, SourceMedia, SourcePlaylist, SourceSchedule, SourceScreen, SourceZone,
  VendorAdapter, VendorClient, VendorSession, Weekday,
} from "../types.js";

/**
 * Xibo CMS (self-hosted or Xibo Cloud), read through its documented REST API:
 * OAuth 2 client credentials, start/length paging with X-Total-Count, and the
 * library download route. Nothing is written to the CMS.
 */

const NAME = "Xibo";
const idOf = (row: Row, field: string, where: string): string => idIn(NAME, row, field, where);
const PAGE = 100;
/** Xibo stores "no end" on a widget as the largest 32-bit Unix time. */
const DATE_MAX = 2_147_483_647;
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MEDIA_KINDS: Readonly<Record<string, "image" | "video" | "audio">> = { image: "image", video: "video", audio: "audio" };
const RECURRENCE: Readonly<Record<string, NonNullable<SourceSchedule["repeat"]>["every"]>> = {
  Minute: "minute", Hour: "hour", Day: "day", Week: "week", Month: "month", Year: "year",
};
const EVENT_REASONS: Readonly<Record<number, string>> = {
  2: "Command events run a command on the display.",
  3: "Overlay events draw a layout over the one that is playing.",
  4: "Interrupt events take a share of each hour from the running schedule.",
  6: "Action events wait for a trigger code from a web hook.",
  7: "Media events show one library item full screen, and Xibo's API does not say which item.",
  8: "Playlist events show one playlist full screen, and Xibo's API does not say which playlist.",
  9: "Synchronised events drive several displays together as a video wall.",
  10: "Data connector events feed a dataset.",
};
const FILE_LABELS: Readonly<Record<string, string>> = {
  font: "A font", pdf: "A PDF", powerpoint: "A PowerPoint file", htmlpackage: "An HTML package", flash: "A Flash file", genericfile: "A generic file",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Civil YYYY-MM-DDTHH:MM of a Unix time (seconds) in a zone. */
function civil(seconds: number, zone: string): string {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(zone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(seconds * 1000))) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The CMS address a person gives, as the API root and the account it identifies. */
function cmsAddress(url: string | undefined): { api: string; account: string; label: string } {
  let parsed: URL;
  try {
    parsed = new URL((url ?? "").trim());
  } catch {
    throw usageError("--url must be the address of the Xibo CMS, such as https://cms.example.com (add the folder if it is installed in one).");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw usageError("--url must start with http:// or https://.");
  const folder = parsed.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  const root = `${parsed.origin}${folder}`;
  return { api: `${root}/api`, account: root, label: `${parsed.host}${folder}` };
}

function widgetOption(widget: Row, option: string): string {
  const found = rows(widget.widgetOptions).find((candidate) => text(candidate.option) === option);
  return text(found?.value);
}

interface Gathered {
  items: SourceItem[];
  notes: string[];
}

/** The importable items of a playlist's widgets, in order; every widget that cannot come over is listed. */
function itemsOf(widgets: unknown, where: string, entries: ReportEntry[], nowSeconds: number): Gathered {
  const ordered = rows(widgets).map((widget, index) => ({ widget, index }))
    .sort((a, b) => (num(a.widget.displayOrder) ?? a.index) - (num(b.widget.displayOrder) ?? b.index) || a.index - b.index);
  const items: SourceItem[] = [];
  let expired = 0;
  let dated = 0;
  for (const { widget, index } of ordered) {
    const type = text(widget.type).toLowerCase();
    const fromDt = num(widget.fromDt) ?? 0;
    const toDt = num(widget.toDt);
    const hasEnd = toDt !== undefined && toDt > 0 && toDt !== DATE_MAX;
    if (hasEnd && toDt <= nowSeconds) {
      expired += 1;
      continue;
    }
    if (fromDt > 0 || hasEnd) dated += 1;
    // A video without a chosen duration plays to its end, and audio has no page to time.
    let seconds: number | undefined;
    if (type !== "audio") {
      if (flag(widget.useDuration) && (num(widget.duration) ?? 0) > 0) seconds = num(widget.duration);
      else if (type !== "video" && (num(widget.calculatedDuration) ?? 0) > 0) seconds = num(widget.calculatedDuration);
    }
    const name = widgetOption(widget, "name");
    const entry = (reason: string, next?: string): void => {
      entries.push({ kind: "item", source_id: `${where} item ${text(widget.widgetId) || index + 1}`, name: name || `${type || "unknown"} widget`, reason, ...(next ? { next } : {}) });
    };
    if (type in MEDIA_KINDS) {
      const media = Array.isArray(widget.mediaIds) ? widget.mediaIds[0] : undefined;
      if (typeof media === "number" || (typeof media === "string" && media !== "")) items.push({ media_id: String(media), ...(seconds !== undefined ? { duration_s: seconds } : {}) });
      else entry(`A ${type} widget with no library file in it.`);
    } else if (type === "webpage") {
      const address = widgetOption(widget, "uri");
      if (/^https?:\/\//i.test(address)) items.push({ url: address, ...(seconds !== undefined ? { duration_s: seconds } : {}) });
      else entry("A web page widget whose address is not an http or https address.");
    } else {
      const label = type === "" ? "Widgets of an unknown type" : `${type[0]!.toUpperCase()}${type.slice(1)} widgets`;
      entry(`${label} are not images, video, audio or web pages.`, "Rebuild it as a built-in card, or as a web page if it shows one.");
    }
  }
  const notes: string[] = [];
  if (expired > 0) notes.push(`${expired} item${expired === 1 ? " was" : "s were"} left out because ${expired === 1 ? "its" : "their"} play dates had passed.`);
  if (dated > 0) notes.push(`${dated} item${dated === 1 ? " had" : "s had"} play dates; ${dated === 1 ? "it now plays" : "they now play"} whenever the list does.`);
  return { items, notes };
}

class XiboSession implements VendorSession {
  private authorized: Promise<void> | undefined;
  private renewal: Promise<void> | undefined;

  constructor(
    private readonly client: VendorClient,
    private readonly credentials: { id: string; secret: string },
    private readonly options: { timezone?: string; now: () => Date; account: string; label: string },
  ) {}

  private async authorize(): Promise<void> {
    // A renewed token must not travel with the expired one.
    this.client.setAuth(undefined);
    const answer = asRow(await this.client.json("/authorize/access_token", {
      method: "POST",
      form: { grant_type: "client_credentials", client_id: this.credentials.id, client_secret: this.credentials.secret },
    }));
    const token = answer.access_token;
    if (typeof token !== "string" || token === "") throw vendorBadResponse(NAME, "its token answer has no access_token");
    this.client.setAuth({ Authorization: `Bearer ${token}` });
  }

  /** Runs one request with a token; a 401 gets a fresh token and one more try. */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    await (this.authorized ??= this.authorize());
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof CliError) || error.problem.code !== "vendor_refused" || error.problem.status !== 401) throw error;
      await (this.renewal ??= this.authorize().finally(() => {
        this.renewal = undefined;
      }));
      return run();
    }
  }

  /** Every row of a grid. The total comes from X-Total-Count, so a CMS that caps the page size is still read to the end. */
  private async list(path: string, idField: string, query: Record<string, string> = {}): Promise<Row[]> {
    const all: Row[] = [];
    const seen = new Set<string>();
    for (let start = 0; ;) {
      const page = await this.call(() => this.client.response<unknown>(path, { query: { ...query, start, length: PAGE } }));
      if (!Array.isArray(page.body)) throw vendorBadResponse(NAME, `GET ${path} did not answer with a list`);
      let added = 0;
      for (const row of page.body.map(asRow)) {
        const id = idOf(row, idField, `GET ${path}`);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(row);
        added += 1;
      }
      start += page.body.length;
      const total = num(page.headers["x-total-count"]);
      if (page.body.length === 0 || added === 0) return all;
      if (total !== undefined ? start >= total : page.body.length < PAGE) return all;
    }
  }

  async scan(): Promise<SourceCatalog> {
    const nowSeconds = Math.floor(this.options.now().getTime() / 1000);
    const library = await this.list("/library", "mediaId");
    const playlistRows = await this.list("/playlist", "playlistId", { embed: "widgets" });
    const layoutRows = await this.list("/layout", "layoutId", { embed: "regions,playlists,widgets" });
    const groupRows = await this.list("/displaygroup", "displayGroupId");
    const displayRows = await this.list("/display", "displayId", { embed: "displaygroups" });
    const campaignRows = await this.list("/campaign", "campaignId", { embed: "layouts" });
    const eventRows = await this.list("/schedule", "eventId");

    const entries: ReportEntry[] = [];
    const notes: string[] = [];

    const media: SourceMedia[] = [];
    for (const row of library) {
      const id = idOf(row, "mediaId", "GET /library");
      const type = text(row.mediaType);
      const filename = text(row.fileName) || text(row.storedAs);
      const name = text(row.name) || filename || `Media ${id}`;
      const kind = MEDIA_KINDS[type.toLowerCase()];
      if (flag(row.retired)) {
        entries.push({ kind: "media", source_id: id, name, reason: "It is retired in Xibo, so no screen plays it." });
      } else if (!kind) {
        const label = FILE_LABELS[type.toLowerCase()] ?? `A ${type || "unknown"} item`;
        const next = /^(pdf|powerpoint)$/i.test(type) ? "Export its pages as images, or the deck as a video, and add them with media upload-batch."
          : /^htmlpackage$/i.test(type) ? "Host the page on a web server and add it as an iframe page." : undefined;
        entries.push({ kind: "media", source_id: id, name, reason: `${label} is not an image, video or audio file.`, ...(next ? { next } : {}) });
      } else {
        const bytes = num(row.fileSize);
        media.push({ id, name, filename: filename || name, kind, ...(bytes !== undefined && bytes > 0 ? { bytes } : {}), fetch: { id, type }, original: true });
      }
    }

    const playlists: SourcePlaylist[] = [];
    for (const row of playlistRows) {
      // A playlist that belongs to a layout region comes with that layout.
      if ((num(row.regionId) ?? 0) > 0) continue;
      const id = idOf(row, "playlistId", "GET /playlist");
      const gathered = itemsOf(row.widgets, `playlist ${id}`, entries, nowSeconds);
      const itemNotes = [...gathered.notes];
      if (flag(row.isDynamic)) itemNotes.push("It was a dynamic playlist that picks its media by name or tag; it now holds only the media it listed at scan time.");
      playlists.push({ id, name: text(row.name) || `Playlist ${id}`, items: gathered.items, notes: itemNotes });
    }

    const layouts: SourceLayout[] = [];
    const layoutOfCampaign = new Map<string, { id: string; retired: boolean }>();
    for (const row of layoutRows) {
      // A draft carries the id of the published layout it was checked out from.
      if ((num(row.parentId) ?? 0) > 0) continue;
      const id = idOf(row, "layoutId", "GET /layout");
      const name = text(row.layout) || `Layout ${id}`;
      const retired = flag(row.retired);
      const campaign = num(row.campaignId);
      if (campaign !== undefined) layoutOfCampaign.set(String(campaign), { id, retired });
      if (retired) {
        entries.push({ kind: "layout", source_id: id, name, reason: "It is retired in Xibo, so no screen plays it." });
        continue;
      }
      const layoutNotes = new Set<string>();
      const zones: SourceZone[] = [];
      let position = 0;
      for (const region of rows(row.regions)) {
        position += 1;
        const regionId = text(region.regionId) || String(position);
        const widgets = asRow(region.regionPlaylist).widgets;
        if (flag(region.isDrawer)) {
          if (rows(widgets).length > 0) layoutNotes.add("The items in its drawer, which actions bring up, do not come over.");
          continue;
        }
        const gathered = itemsOf(widgets, `layout ${id} zone ${regionId}`, entries, nowSeconds);
        for (const note of gathered.notes) layoutNotes.add(note);
        zones.push({
          id: regionId, name: text(region.name) || `Zone ${position}`,
          x: num(region.left) ?? 0, y: num(region.top) ?? 0, width: num(region.width) ?? 0, height: num(region.height) ?? 0, z: num(region.zIndex) ?? 0,
          items: gathered.items,
        });
      }
      if ((num(row.backgroundImageId) ?? 0) > 0) layoutNotes.add("Its background image does not come over.");
      const width = num(row.width);
      const height = num(row.height);
      layouts.push({ id, name, ...(width !== undefined && width > 0 ? { width } : {}), ...(height !== undefined && height > 0 ? { height } : {}), zones, notes: [...layoutNotes] });
    }
    const importableLayouts = new Set(layouts.map((layout) => layout.id));

    const adCampaigns = new Set<string>();
    const campaignPlaylist = new Map<string, string>();
    for (const row of campaignRows) {
      const id = idOf(row, "campaignId", "GET /campaign");
      if (flag(row.isLayoutSpecific)) continue;
      const type = text(row.type).toLowerCase();
      const name = text(row.campaign) || `Campaign ${id}`;
      if (type === "ad") {
        adCampaigns.add(id);
        entries.push({ kind: "playlist", source_id: `campaign:${id}`, name, reason: "It is an ad campaign, which Xibo schedules by a target of plays, spend or impressions." });
        continue;
      }
      // Full screen media and playlist campaigns are made by Xibo for its own events.
      if (type !== "" && type !== "list") continue;
      const repeats = flag(row.cyclePlaybackEnabled) ? Math.max(1, Math.floor(num(row.playCount) ?? 1)) : 1;
      const items: SourceItem[] = [];
      const ordered = rows(row.layouts).map((layout, index) => ({ layout, index }))
        .sort((a, b) => (num(a.layout.displayOrder) ?? a.index) - (num(b.layout.displayOrder) ?? b.index) || a.index - b.index);
      for (const { layout } of ordered) {
        const layoutId = text(layout.layoutId);
        if (layoutId === "" || !importableLayouts.has(layoutId)) continue;
        for (let copy = 0; copy < repeats; copy += 1) items.push({ layout_id: layoutId });
      }
      campaignPlaylist.set(id, `campaign:${id}`);
      playlists.push({ id: `campaign:${id}`, name, items, notes: [] });
    }

    const groups: SourceGroup[] = [];
    let dynamicGroups = 0;
    for (const row of groupRows) {
      const id = idOf(row, "displayGroupId", "GET /displaygroup");
      if (flag(row.isDisplaySpecific)) continue;
      if (flag(row.isDynamic)) dynamicGroups += 1;
      groups.push({ id, name: text(row.displayGroup) || `Group ${id}` });
    }
    const groupIds = new Set(groups.map((group) => group.id));
    if (dynamicGroups > 0) {
      notes.push(`${dynamicGroups} display group${dynamicGroups === 1 ? " picks its displays" : "s pick their displays"} by name or tag; ${dynamicGroups === 1 ? "it" : "they"} came over with the displays held now.`);
    }

    const screens: SourceScreen[] = [];
    const displayOfOwnGroup = new Map<string, string>();
    const membersOfGroup = new Map<string, string[]>();
    for (const row of displayRows) {
      const id = idOf(row, "displayId", "GET /display");
      const own = num(row.displayGroupId);
      if (own !== undefined) displayOfOwnGroup.set(String(own), id);
      const memberOf: string[] = [];
      for (const group of rows(row.displayGroups)) {
        const groupId = text(group.displayGroupId);
        if (!groupIds.has(groupId) || memberOf.includes(groupId)) continue;
        memberOf.push(groupId);
        membersOfGroup.set(groupId, [...(membersOfGroup.get(groupId) ?? []), id]);
      }
      const layout = num(row.defaultLayoutId);
      const timezone = zoneOf(row.timeZone);
      screens.push({
        id, name: text(row.display) || `Display ${id}`, group_ids: memberOf,
        ...(layout !== undefined && layout > 0 ? { content: { layout_id: String(layout) } } : {}),
        ...(timezone ? { timezone } : {}),
        notes: [],
      });
    }
    const screenZone = new Map(screens.map((screen) => [screen.id, screen.timezone]));

    const schedules: SourceSchedule[] = [];
    for (const row of eventRows) {
      const eventId = idOf(row, "eventId", "GET /schedule");
      const typeId = num(row.eventTypeId) ?? 1;
      const name = text(row.name) || text(row.campaign) || `Event ${eventId}`;
      const refuse = (reason: string, next?: string): void => {
        entries.push({ kind: "schedule", source_id: eventId, name, reason, ...(next ? { next } : {}) });
      };
      if (typeId !== 1 && typeId !== 5) {
        refuse(EVENT_REASONS[typeId] ?? `Event type ${typeId} is not one that campaigns can express.`, "Recreate it with campaign create once the screens are paired, if you still need it.");
        continue;
      }
      if (flag(row.isGeoAware)) {
        refuse("It plays only inside a map area (geo-fencing), which campaigns cannot express.");
        continue;
      }
      if (rows(row.criteria).length > 0) {
        refuse("It plays only while a condition holds (schedule criteria), which campaigns cannot express.");
        continue;
      }
      const campaignId = text(row.campaignId);
      let content: SourceSchedule["content"];
      if (typeId === 1) {
        const layout = layoutOfCampaign.get(campaignId);
        if (!layout) {
          refuse("The layout it plays was not found among the layouts this key can read.");
          continue;
        }
        if (layout.retired) {
          refuse("The layout it plays is retired in Xibo.");
          continue;
        }
        content = { layout_id: layout.id };
      } else {
        const playlist = campaignPlaylist.get(campaignId);
        if (!playlist) {
          refuse(adCampaigns.has(campaignId) ? "It plays an ad campaign, which Xibo schedules by a target of plays, spend or impressions." : "The campaign it plays was not found among the campaigns this key can read.");
          continue;
        }
        content = { playlist_id: playlist };
      }

      const always = flag(row.isAlways);
      const fromDt = num(row.fromDt);
      const toDt = num(row.toDt);
      const range = num(row.recurrenceRange);
      const every = RECURRENCE[text(row.recurrenceType)];
      const repeating = !always && every !== undefined;
      const lastSecond = repeating ? (range !== undefined && range > 0 ? range : undefined) : toDt;
      if (!always && lastSecond !== undefined && lastSecond > 0 && lastSecond <= nowSeconds) {
        refuse("It has already ended.");
        continue;
      }

      // Targets: a display's own group is the display; the other groups are groups.
      const groupTargets: string[] = [];
      const screenTargets: string[] = [];
      for (const group of rows(row.displayGroups)) {
        const groupId = text(group.displayGroupId);
        const display = displayOfOwnGroup.get(groupId);
        if (display !== undefined) {
          if (!screenTargets.includes(display)) screenTargets.push(display);
        } else if (groupIds.has(groupId) && !groupTargets.includes(groupId)) {
          groupTargets.push(groupId);
        }
      }
      const reached = [...new Set([...screenTargets, ...groupTargets.flatMap((group) => membersOfGroup.get(group) ?? [])])];

      // Times are Unix times. An event synced to each display's zone ("syncTimezone") is one moment that every
      // display formats in its own zone, so it is made civil in the zone of each display that plays it. Any
      // other event shows the CMS clock's digits, and each display plays those digits on its own clock: they are
      // read in the CMS zone, which is the model campaigns use too. An always-on event has no times.
      const cmsZone = this.options.timezone;
      const cms = { zone: cmsZone ?? "UTC", known: cmsZone !== undefined };
      const synced = flag(row.syncTimezone) && !always;
      const parts: Array<{ zone: string; known: boolean; groups: string[]; screens: string[] }> = [];
      const byZone = new Map<string, { known: boolean; screens: string[] }>();
      if (synced) {
        for (const display of reached) {
          const own = screenZone.get(display);
          const zone = own !== undefined ? { zone: own, known: true } : cms;
          const bucket = byZone.get(zone.zone) ?? { known: zone.known, screens: [] };
          bucket.screens.push(display);
          byZone.set(zone.zone, bucket);
        }
      }
      if (byZone.size > 1) {
        for (const [zone, bucket] of byZone) parts.push({ zone, known: bucket.known, groups: [], screens: bucket.screens });
      } else {
        const only = [...byZone][0];
        parts.push({ ...(only ? { zone: only[0], known: only[1].known } : cms), groups: groupTargets, screens: screenTargets });
      }

      const baseNotes: string[] = [];
      if ((num(row.dayPartId) ?? 0) > 0 && !always && !flag(row.isCustom)) baseNotes.push("It used a Xibo daypart; its times were taken as the event stores them.");
      if ((num(row.maxPlaysPerHour) ?? 0) > 0) baseNotes.push(`It was limited to ${num(row.maxPlaysPerHour)} plays an hour; it now has no limit.`);
      const isoDays = (value: unknown): Weekday[] => {
        const wanted = new Set(text(value).split(",").map((day) => Number(day.trim())));
        return WEEKDAYS.filter((_, index) => wanted.has(index + 1));
      };
      const priority = Math.min(100, Math.max(0, Math.trunc(num(row.isPriority) ?? 0) * 10));
      for (const part of parts) {
        const partNotes = [...baseNotes];
        if (parts.length > 1) partNotes.push("It reached displays in several time zones, so it became one schedule per zone.");
        if (!part.known && !always) partNotes.push("No time zone was known, so its times were read as UTC. Check them, or scan again with --timezone.");
        let repeat: SourceSchedule["repeat"];
        if (repeating && every !== undefined) {
          const interval = num(row.recurrenceDetail);
          const weekdays = every === "week" ? isoDays(row.recurrenceRepeatsOn) : [];
          repeat = {
            every,
            ...(interval !== undefined && interval > 1 ? { interval: Math.floor(interval) } : {}),
            ...(weekdays.length > 0 ? { weekdays } : {}),
            ...(every === "month" && flag(row.recurrenceMonthlyRepeatsOn) ? { nth_weekday: true } : {}),
            ...(range !== undefined && range > 0 ? { until: civil(range, part.zone).slice(0, 10) } : {}),
          };
        }
        schedules.push({
          id: parts.length > 1 ? `${eventId}@${part.zone}` : eventId,
          name,
          targets: { group_ids: part.groups, screen_ids: part.screens },
          content,
          ...(always ? { always: true } : {
            ...(fromDt !== undefined && fromDt > 0 ? { start: civil(fromDt, part.zone) } : {}),
            ...(toDt !== undefined && toDt > 0 ? { end: civil(toDt, part.zone) } : {}),
            // Only a synced event is read in a zone of its own; the rest read on each display's clock, as campaigns do.
            ...(synced ? { timezone: part.zone } : {}),
          }),
          ...(repeat ? { repeat } : {}),
          priority,
          notes: partNotes,
        });
      }
    }

    return { account: this.options.account, label: this.options.label, media, playlists, layouts, groups, screens, schedules, not_imported: entries, notes };
  }

  async fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }> {
    const ref = asRow(media.fetch);
    const id = text(ref.id);
    const type = text(ref.type);
    if (id === "" || type === "") throw vendorBadResponse(NAME, "a library file has no download reference");
    return this.call(() => this.client.download(`/library/download/${encodeURIComponent(id)}/${encodeURIComponent(type)}`, destination));
  }
}

export const xibo: VendorAdapter = {
  id: "xibo",
  name: NAME,
  inputs: { url: "required", timezone: true },
  credentials: [
    { env: "XIBO_CLIENT_ID", secret: false, required: true, help: "The Client ID of a Xibo Application that uses the Client Credentials grant (Administration, Applications)." },
    { env: "XIBO_CLIENT_SECRET", secret: true, required: true, help: "The Client Secret of that Application." },
  ],
  connect: [
    "Make a dedicated CMS user that can view the library, layouts, campaigns, displays and schedule. A Client Credentials token acts as the user that owns the Application, so give that user nothing more.",
    "Signed in as that user, open Administration, then Applications, and add an Application. Enable the Client Credentials grant, save, then edit it to read the Client ID and Client Secret. The secret is shown once; reset it if it is lost.",
    "Write XIBO_CLIENT_ID=... and XIBO_CLIENT_SECRET=... as two lines in a file only you can read, and pass it with --credentials FILE.",
    "--url is the address you sign in at, including the folder when the CMS is installed in one (https://example.org/xibo). --timezone is the CMS's own time zone, used to read the hours of events that play at the same clock time on every display.",
  ],
  maps: [
    "Library images, video and audio become media, downloaded from the CMS.",
    "Library playlists become playlists: image, video and audio widgets by their media and duration, web page widgets by their address.",
    "Published layouts become layouts, each region a zone with its position, size and layer.",
    "A campaign that lists layouts becomes a playlist of those layouts, in order, each repeated for its play count.",
    "Display groups become groups; a display's own group is the display. Displays become waiting screens with their default layout, groups and time zone.",
    "Layout and campaign events become schedules: dates and hours, daily and weekly repeats on chosen days, an end date, and priority.",
  ],
  skips: [
    "Overlay, command, interrupt, action, synchronised, data connector, media and playlist events, events with geo-fencing or criteria, repeats by the minute, hour, month or year, ad campaigns, and events that have ended are listed.",
    "Widgets that are not images, video, audio or web pages (text, clock, ticker, RSS, weather, embedded HTML) are listed per item; so are library files of other kinds (fonts, PDFs, packages).",
    "Draft and retired layouts, a layout's background image, transitions, and the day or daypart limits of a layout inside a campaign are not read.",
    "Events that use a daypart come over with the dates and hours they store.",
  ],
  docs: [
    "https://docs.xibosignage.com/developer/integrate/authentication",
    "https://docs.xibosignage.com/developer/integrate/openapi",
    "https://docs.xibosignage.com/scheduling/scheduling_repeats",
    "https://raw.githubusercontent.com/xibosignage/xibo-cms/develop/web/swagger.json",
    "https://github.com/xibosignage/xibo-cms/blob/develop/lib/Entity/Schedule.php",
  ],
  example: "screenrig migrate scan --from xibo --url https://cms.example.com --timezone America/Toronto --credentials ./xibo.env",
  async open(input) {
    const address = cmsAddress(input.url);
    const id = input.credentials.XIBO_CLIENT_ID;
    const secret = input.credentials.XIBO_CLIENT_SECRET;
    if (id === undefined || secret === undefined) throw usageError("Xibo needs XIBO_CLIENT_ID and XIBO_CLIENT_SECRET.");
    const client = input.http.client({ base: address.api });
    return new XiboSession(client, { id, secret }, { ...(input.timezone !== undefined ? { timezone: input.timezone } : {}), now: input.now, account: address.account, label: address.label });
  },
};
