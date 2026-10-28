import { usageError } from "../../problems.js";
import { vendorBadResponse } from "../http.js";
import { asRow, flag, idOf as idIn, num, rows, text, zoneOf, type Row } from "./xy-rows.js";
import type {
  ReportEntry, SourceCatalog, SourceGroup, SourceItem, SourceLayout, SourceMedia, SourcePlaylist, SourceSchedule, SourceScreen, SourceZone,
  VendorAdapter, VendorClient, VendorSession, Weekday,
} from "../types.js";

/**
 * Yodeck, read through its documented REST API v2 with an API token. Its API
 * never hands out the originals of files that were uploaded (only a thumbnail,
 * which is never used here), so those come from --files. Nothing is written.
 */

const NAME = "Yodeck";
const idOf = (row: Row, field: string, where: string): string => idIn(NAME, row, field, where);
const BASE = "https://app.yodeck.com/api/v2";
const PAGE = 100;
/** Yodeck allows 21 requests per 10 seconds for each token on its list endpoints. */
const RATE = { requests: 21, perMs: 10_000 } as const;
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MEDIA_KINDS: Readonly<Record<string, "image" | "video" | "audio">> = { image: "image", video: "video", audio: "audio" };
const STREAM_NEXT = "Add it to a playlist after the import: a YouTube link goes in an iframe page, an HLS or RTSP address in a stream page.";
const CARD_NEXT = "Rebuild it as a built-in card, or as a web page if it shows one.";
const HTTP = /^https?:\/\//i;
const CIVIL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/;
/** An event that ended less than this long ago may still be running in a zone far from UTC. */
const ENDED_SLACK_MS = 36 * 3_600_000;

/** `label:token` as Yodeck shows it; a pasted `Token ` prefix is dropped. The value is never repeated in a message. */
function tokenOf(raw: string | undefined): string {
  const token = (raw ?? "").trim().replace(/^Token\s+/i, "");
  if (!/^[^\s:]+:\S+$/.test(token)) {
    throw usageError("YODECK_API_TOKEN must be the token as label:token, the label being the name you gave the token in Yodeck.");
  }
  return token;
}

const civilOf = (value: unknown): string | undefined => {
  const found = CIVIL.exec(text(value));
  return found ? `${found[1]}T${found[2]}:${found[3]}` : undefined;
};

function plusMinutes(at: string, minutes: number): string {
  const moment = new Date(`${at}:00Z`);
  moment.setUTCMinutes(moment.getUTCMinutes() + minutes);
  return moment.toISOString().slice(0, 16);
}

const priorityOrder = (a: { row: Row; index: number }, b: { row: Row; index: number }): number =>
  (num(a.row.priority) ?? a.index) - (num(b.row.priority) ?? b.index) || a.index - b.index;

const ordered = (value: unknown): Row[] => rows(value).map((row, index) => ({ row, index })).sort(priorityOrder).map((entry) => entry.row);

class YodeckSession implements VendorSession {
  constructor(private readonly client: VendorClient, private readonly options: { now: () => Date }) {}

  /** Every row of a limit/offset listing. The total is the listing's own count, so a server that caps the page is still read to the end. */
  private async list(path: string, query: Record<string, string> = {}): Promise<Row[]> {
    const all: Row[] = [];
    const seen = new Set<string>();
    for (let offset = 0; ;) {
      const page = asRow(await this.client.json<unknown>(path, { query: { ...query, limit: PAGE, offset } }));
      if (!Array.isArray(page.results)) throw vendorBadResponse(NAME, `GET ${path} has no results list`);
      let added = 0;
      for (const row of page.results.map(asRow)) {
        const id = idOf(row, "id", `GET ${path}`);
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(row);
        added += 1;
      }
      offset += page.results.length;
      if (page.results.length === 0 || added === 0) return all;
      const count = num(page.count);
      if (count !== undefined ? offset >= count : page.next === null || page.next === undefined) return all;
    }
  }

  async scan(): Promise<SourceCatalog> {
    const mediaRows = await this.list("/media/");
    const playlistRows = await this.list("/playlists/");
    const layoutRows = await this.list("/layouts/");
    const scheduleRows = await this.list("/schedules/");
    // The listing without a subset carries what a screen shows; subset=basic adds its tags and time zone.
    const screenRows = await this.list("/screens/");
    const basicRows = await this.list("/screens/", { subset: "basic" });

    const entries: ReportEntry[] = [];
    const notes: string[] = [];

    const media: SourceMedia[] = [];
    const pages = new Map<string, { url: string; title: string }>();
    const naturalSeconds = new Map<string, number>();
    const audio = new Set<string>();
    const mediaNames = new Map<string, string>();
    const availability: string[] = [];
    for (const row of mediaRows) {
      const id = idOf(row, "id", "GET /media/");
      const origin = asRow(row.media_origin);
      const type = text(origin.type).toLowerCase();
      const source = text(origin.source).toLowerCase();
      const args = asRow(row.arguments);
      const name = text(row.name) || `Media ${id}`;
      mediaNames.set(id, name);
      if (flag(asRow(row.availability_schedule).enable)) availability.push(name);
      const refuse = (reason: string, next?: string): void => {
        entries.push({ kind: "media", source_id: id, name, reason, ...(next ? { next } : {}) });
      };
      if (type === "webpage") {
        const url = text(args.play_from_url);
        if (HTTP.test(url)) pages.set(id, { url, title: name });
        else refuse("A web page with no http or https address.");
        continue;
      }
      if (type === "app") {
        refuse("Apps (clocks, weather, RSS and other widgets) are not media files.", CARD_NEXT);
        continue;
      }
      if (type === "document") {
        refuse("Documents (PDF, Word, Excel, PowerPoint) are not images, video or audio.", "Export its pages as images, or a deck as a video, and add them with media upload-batch.");
        continue;
      }
      const kind = MEDIA_KINDS[type];
      if (!kind) {
        refuse(`A ${type || "unknown"} item is not an image, video or audio file.`);
        continue;
      }
      const status = text(row.status);
      if (status !== "" && status !== "finished") {
        refuse("Yodeck has not finished processing it.", "Wait for Yodeck to finish it, then scan again.");
        continue;
      }
      if (source === "stream" || source === "usb_stream") {
        refuse("It is a live stream or a capture input, not a file.", STREAM_NEXT);
        continue;
      }
      const download = text(args.download_from_url);
      const play = text(args.play_from_url);
      let fetch: { url: string } | undefined;
      let original = true;
      if (HTTP.test(download)) {
        fetch = { url: download };
      } else if (kind === "video" && source === "local" && HTTP.test(play)) {
        // Yodeck's playable copy of an upload: a derivative, so a same-name original in --files wins.
        fetch = { url: play };
        original = false;
      } else if (source === "url" && play !== "") {
        refuse("It is a hosted video or audio link (YouTube, Vimeo), not a file.", STREAM_NEXT);
        continue;
      }
      const seconds = num(args.duration);
      if (kind === "video" && seconds !== undefined && seconds > 0) naturalSeconds.set(id, seconds);
      if (kind === "audio") audio.add(id);
      const extension = text(row.file_extension).replace(/^\./, "");
      const named = extension !== "" && !name.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? `${name}.${extension}` : name;
      media.push({ id, name, filename: named.replace(/[\\/]/g, "_"), kind, ...(fetch ? { fetch } : {}), original });
    }
    if (availability.length > 0) {
      const shown = availability.slice(0, 3).join(", ");
      notes.push(`${availability.length} media ${availability.length === 1 ? "has" : "have"} availability dates or hours in Yodeck (${shown}${availability.length > 3 ? ", and more" : ""}); they now play whenever their playlist does.`);
    }

    /** One item showing a media: a web page by its address, a video without a duration to its end. */
    const mediaItem = (id: string, seconds: number | undefined): SourceItem => {
      const page = pages.get(id);
      // Audio has no page to time.
      const wanted = seconds !== undefined && seconds > 0 && !audio.has(id) ? seconds : undefined;
      if (page) return { url: page.url, title: page.title, ...(wanted !== undefined ? { duration_s: wanted } : {}) };
      const natural = naturalSeconds.get(id);
      // Yodeck gives a video its own length as the item duration; only a different one is a choice.
      const explicit = wanted !== undefined && !(natural !== undefined && Math.abs(wanted - natural) <= 1) ? wanted : undefined;
      return { media_id: id, ...(explicit !== undefined ? { duration_s: explicit } : {}) };
    };
    const synthetic = new Map<string, SourcePlaylist>();
    /** A schedule event or a screen can show one media directly: that is a playlist of one item. */
    const mediaPlaylist = (id: string): string => {
      const key = `media:${id}`;
      if (!synthetic.has(key)) synthetic.set(key, { id: key, name: mediaNames.get(id) ?? `Media ${id}`, items: [mediaItem(id, undefined)], notes: [] });
      return key;
    };
    const contentOf = (source: Row): SourceScreen["content"] => {
      const type = text(source.source_type);
      const id = text(source.source_id);
      if (id === "") return undefined;
      if (type === "playlist") return { playlist_id: id };
      if (type === "layout") return { layout_id: id };
      if (type === "media") return { playlist_id: mediaPlaylist(id) };
      return undefined;
    };

    const playlists: SourcePlaylist[] = [];
    for (const row of playlistRows) {
      const id = idOf(row, "id", "GET /playlists/");
      const playlistNotes = new Set<string>();
      const items: SourceItem[] = [];
      for (const item of ordered(row.items)) {
        const type = text(item.type);
        const itemId = text(item.id);
        if (type === "media" && itemId !== "") {
          items.push(mediaItem(itemId, num(item.duration)));
        } else if (type === "layout" && itemId !== "") {
          items.push({ layout_id: itemId });
        } else if (type === "subplaylist" && itemId !== "") {
          items.push({ playlist_id: itemId });
          if ((num(item.max_items) ?? 0) > 0 || (num(item.max_time) ?? 0) > 0) {
            playlistNotes.add(`Its sub-playlist ${text(item.name) || itemId} was limited to a number of items or a time; it now plays in full.`);
          }
        } else {
          playlistNotes.add(`An item of type ${/^[A-Za-z0-9_-]{1,30}$/.test(type) ? type : "unknown"} was left out.`);
        }
      }
      playlists.push({ id, name: text(row.name) || `Playlist ${id}`, items, ...(flag(asRow(row.playback_options).random_playback) ? { shuffle: true } : {}), notes: [...playlistNotes] });
    }

    const layouts: SourceLayout[] = [];
    for (const row of layoutRows) {
      const id = idOf(row, "id", "GET /layouts/");
      const layoutNotes = new Set<string>();
      const zones: SourceZone[] = [];
      let position = 0;
      for (const region of rows(row.regions).sort((a, b) => (num(a.order) ?? 0) - (num(b.order) ?? 0))) {
        if (flag(region.hidden)) continue;
        position += 1;
        const regionId = text(region.id) || String(position);
        const where = `layout ${id} zone ${regionId}`;
        const item = asRow(region.item);
        const type = text(item.type);
        const itemId = text(item.id);
        const entry = (reason: string): void => {
          entries.push({ kind: "item", source_id: where, name: `Zone ${position}`, reason, next: CARD_NEXT });
        };
        const seconds = num(region.duration);
        const items: SourceItem[] = [];
        if (type === "playlist" && itemId !== "") items.push({ playlist_id: itemId });
        else if (/^(image|video|audio|pdf|url)$/.test(type) && itemId !== "") items.push(mediaItem(itemId, seconds));
        else if (type === "widget") entry("Apps (clocks, weather, RSS and other widgets) are not media files.");
        else if (type === "integration") entry("Integrations with other services are not media files.");
        else if (type === "" && Object.keys(asRow(region.content_data)).length > 0) entry("Text and clipart zones are not media files.");
        if ((num(region.rotation) ?? 0) !== 0) layoutNotes.add("A rotated zone comes over unrotated.");
        zones.push({
          id: regionId, name: `Zone ${position}`,
          x: num(region.left) ?? 0, y: num(region.top) ?? 0, width: num(region.width) ?? 0, height: num(region.height) ?? 0, z: num(region.zindex) ?? 0,
          items,
        });
      }
      if (row.background_audio !== null && row.background_audio !== undefined && Object.keys(asRow(row.background_audio)).length > 0) layoutNotes.add("Its background audio does not come over.");
      const width = num(row.resolution_width);
      const height = num(row.resolution_height);
      layouts.push({ id, name: text(row.name) || `Layout ${id}`, ...(width !== undefined && width > 0 ? { width } : {}), ...(height !== undefined && height > 0 ? { height } : {}), zones, notes: [...layoutNotes] });
    }

    // What each schedule shows between its events, and which screens show it.
    const scheduleById = new Map(scheduleRows.map((row) => [idOf(row, "id", "GET /schedules/"), row]));
    const screensOfSchedule = new Map<string, string[]>();
    const merged = new Map<string, Row>();
    for (const row of screenRows) merged.set(idOf(row, "id", "GET /screens/"), row);
    for (const row of basicRows) {
      const id = idOf(row, "id", "GET /screens/?subset=basic");
      merged.set(id, { ...merged.get(id), ...row });
    }
    const groups = new Map<string, SourceGroup>();
    const screens: SourceScreen[] = [];
    for (const [id, row] of merged) {
      const basic = asRow(row.basic);
      const screenNotes: string[] = [];
      const groupIds: string[] = [];
      for (const tag of Array.isArray(basic.tags) ? basic.tags.map(text).filter((name) => name !== "") : []) {
        const groupId = `tag:${tag.toLowerCase()}`;
        if (!groups.has(groupId)) groups.set(groupId, { id: groupId, name: tag });
        if (!groupIds.includes(groupId)) groupIds.push(groupId);
      }
      // Yodeck keeps the zone as an area ("America") and a place ("Toronto").
      const area = text(basic.time_zone);
      const place = text(basic.time_subzone);
      const timezone = area === "" ? undefined : zoneOf(place !== "" ? `${area}/${place}` : area);
      if (area !== "" && timezone === undefined) screenNotes.push(`Its time zone ${area}${place !== "" ? `/${place}` : ""} is not one this CLI knows, so none is set.`);
      const shown = asRow(row.screen_content);
      const shownType = text(shown.source_type);
      let content: SourceScreen["content"];
      if (shownType === "schedule") {
        const scheduleId = text(shown.source_id);
        screensOfSchedule.set(scheduleId, [...(screensOfSchedule.get(scheduleId) ?? []), id]);
        const filler = asRow(scheduleById.get(scheduleId)?.filler_content);
        content = contentOf(filler);
        if (content === undefined && text(filler.source_type) === "turned_off") screenNotes.push("Its schedule turns the screen off between events; set a default playlist after pairing.");
      } else if (shownType === "turned_off") {
        screenNotes.push("It was turned off in Yodeck, so it has no default content.");
      } else {
        content = contentOf(shown);
      }
      screens.push({ id, name: text(row.name) || `Screen ${id}`, group_ids: groupIds, ...(content ? { content } : {}), ...(timezone ? { timezone } : {}), notes: screenNotes });
    }

    const schedules: SourceSchedule[] = [];
    const nowMs = this.options.now().getTime();
    for (const [scheduleId, row] of scheduleById) {
      const scheduleName = text(row.name) || `Schedule ${scheduleId}`;
      const targets = screensOfSchedule.get(scheduleId) ?? [];
      if (targets.length === 0) {
        entries.push({ kind: "schedule", source_id: scheduleId, name: scheduleName, reason: "No screen shows it, so there is nothing to aim it at." });
        continue;
      }
      const events = rows(row.events);
      for (const event of events) {
        const eventId = `${scheduleId}:${idOf(event, "id", "GET /schedules/")}`;
        const source = asRow(event.source);
        const sourceName = text(source.source_name);
        const name = events.length > 1 && sourceName !== "" ? `${scheduleName}: ${sourceName}` : scheduleName;
        const refuse = (reason: string, next?: string): void => {
          entries.push({ kind: "schedule", source_id: eventId, name, reason, ...(next ? { next } : {}) });
        };
        if (text(source.source_type) === "turned_off") {
          refuse("It turns the screen off, and campaigns show content.", "After pairing, set when the display is on with screen display-schedule.");
          continue;
        }
        const content = contentOf(source);
        if (content === undefined) {
          refuse("It shows something other than a playlist, a layout or a media item.");
          continue;
        }
        const start = civilOf(event.start);
        if (start === undefined) {
          refuse("Its start time could not be read.");
          continue;
        }
        const minutes = num(event.duration);
        const end = minutes !== undefined && minutes > 0 ? plusMinutes(start, minutes) : undefined;
        const kind = text(event.recurrence) || "o";
        const bits = /^[01]{7}$/.test(text(event.days_of_week)) ? text(event.days_of_week) : "";
        const weekdays = WEEKDAYS.filter((_, index) => bits[index] === "1");
        let repeat: SourceSchedule["repeat"];
        if (kind !== "o") {
          const interval = num(event.every);
          const occurrences = num(event.occurrences);
          const last = /^(\d{4}-\d{2}-\d{2})/.exec(text(event.end))?.[1];
          // A daily event with days chosen is a weekly one.
          const every = kind === "d" ? (weekdays.length > 0 ? "week" : "day") : kind === "w" ? "week" : kind === "m" ? "month" : kind === "y" ? "year" : undefined;
          if (every === undefined) {
            refuse("Its repeat is not one Yodeck documents.");
            continue;
          }
          repeat = {
            every,
            ...(interval !== undefined && interval > 1 ? { interval: Math.floor(interval) } : {}),
            ...(every === "week" && weekdays.length > 0 ? { weekdays } : {}),
            ...(last !== undefined ? { until: last } : {}),
            ...(occurrences !== undefined && occurrences > 0 ? { count: Math.floor(occurrences) } : {}),
          };
        }
        const finished = repeat === undefined ? end : repeat.until !== undefined ? `${repeat.until}T23:59` : undefined;
        if (finished !== undefined && Date.parse(`${finished}:00Z`) + ENDED_SLACK_MS < nowMs) {
          refuse("It has already ended.");
          continue;
        }
        schedules.push({
          id: eventId, name, targets: { group_ids: [], screen_ids: targets }, content,
          start, ...(end ? { end } : {}),
          ...(repeat ? { repeat } : {}),
          priority: Math.min(100, Math.max(0, Math.trunc(num(event.priority) ?? 0))),
          notes: [],
        });
      }
    }

    // Yodeck workspace ids tell two accounts apart; the lowest one stays the same when a workspace is added later.
    const workspaces = [mediaRows, playlistRows, layoutRows, scheduleRows, screenRows, basicRows].flat()
      .map((row) => num(asRow(row.workspace).id)).filter((id): id is number => id !== undefined);
    const account = workspaces.length > 0 ? `yodeck:${Math.min(...workspaces)}` : "yodeck";
    return {
      account, label: "Yodeck", media,
      playlists: [...playlists, ...synthetic.values()], layouts, groups: [...groups.values()], screens, schedules,
      not_imported: entries, notes,
    };
  }

  async fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }> {
    const url = text(asRow(media.fetch).url);
    if (!HTTP.test(url)) throw vendorBadResponse(NAME, "a media file has no download address");
    return this.client.download(url, destination);
  }
}

export const yodeck: VendorAdapter = {
  id: "yodeck",
  name: NAME,
  inputs: { timezone: true, files: "optional" },
  credentials: [
    { env: "YODECK_API_TOKEN", secret: true, required: true, help: "A Yodeck API token as label:token, the label being the name you gave the token." },
  ],
  connect: [
    "Yodeck's API is available on the Premium and Enterprise plans.",
    "Open Account, then Account Settings, then Advanced Settings, then API Tokens, and choose Generate Token. Name it, and give it a role that can view media, playlists, layouts, schedules and screens: the token acts as a user with that role.",
    "Copy the token when it is shown; it cannot be shown again. It reads label:token. Write YODECK_API_TOKEN=label:token as a line in a file only you can read, and pass it with --credentials FILE.",
    "Yodeck's API does not hand out files you uploaded. Download those originals from Yodeck into one folder (or a .zip) and pass it with --files; the playlists, layouts, schedules and screens still come from the API.",
    "--timezone is used for screens that have no time zone in Yodeck.",
  ],
  maps: [
    "Images, video and audio become media. Ones Yodeck imported from a web address are downloaded from it; a video Yodeck holds only as its playable copy comes from that copy, marked lossy, unless the original is in --files; the rest are matched by file name in --files.",
    "Web page media become web page items.",
    "Playlists become playlists, with sub-playlists inlined. Layouts become layouts, each region a zone with its position, size and layer.",
    "Screen tags become groups. Screens become waiting screens with their default content and time zone.",
    "The schedule a screen shows becomes one campaign per event for that screen: dates and hours, daily and weekly repeats on chosen days, an end date, a count, and priority. The schedule's filler content becomes the screen's default.",
  ],
  skips: [
    "Uploaded images, audio and documents are never replaced by thumbnails: without the original in --files they are listed.",
    "Apps, integrations, text and clipart zones, documents, live streams and capture inputs are listed.",
    "Events that turn the screen off (next: screen display-schedule), events that repeat monthly or yearly, events that have ended and schedules no screen shows are listed.",
    "Random play order, playlist transitions, a media's availability dates and hours and a sub-playlist's limits do not carry over; tag-based playlists, emergency alerts, takeovers and working hours are not read.",
  ],
  docs: [
    "https://app.yodeck.com/api-docs/",
    "https://app.yodeck.com/api-docs/bundle.yaml",
    "https://www.yodeck.com/academy/api-token/",
  ],
  example: "screenrig migrate scan --from yodeck --files ./yodeck-downloads --timezone America/Toronto --credentials ./yodeck.env",
  async open(input) {
    const token = tokenOf(input.credentials.YODECK_API_TOKEN);
    const client = input.http.client({ base: BASE, auth: { Authorization: `Token ${token}` }, rate: RATE });
    return new YodeckSession(client, { now: input.now });
  },
};
