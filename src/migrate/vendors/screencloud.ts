import { cursorPages, vendorBadResponse } from "../http.js";
import { kindOf } from "../map.js";
import type {
  MediaKind, ReportEntry, SourceCatalog, SourceGroup, SourceItem, SourceLayout, SourceMedia, SourcePlaylist, SourceScreen, SourceZone, VendorAdapter, VendorClient, VendorSession,
} from "../types.js";

/**
 * ScreenCloud Studio, GraphQL API. ScreenCloud has no schedule object: what plays
 * when lives in rules on the items of a channel or playlist, and those rules do
 * not come over (they are listed per channel and playlist). A channel becomes a
 * layout, its zones placed from the layout's CSS. Read against the Studio API
 * reference (see `docs`).
 */

const NAME = "ScreenCloud";
const HOSTS: Record<string, string> = { eu: "https://graphql.eu.screencloud.com/graphql", us: "https://graphql.us.screencloud.com/graphql" };
const PAGE = 100;
const DEFAULT_CANVAS = { width: 1920, height: 1080 };

type Json = Record<string, unknown>;

interface Connection<T> {
  nodes?: T[];
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
}
interface ScFile {
  id: string;
  name?: string | null;
  mimetype?: string | null;
  size?: string | number | null;
  source?: string | null;
  deletedAt?: string | null;
  fileOutputsByFileId?: Connection<{ url?: string | null; mimetype?: string | null }> | null;
}
interface ScPlaylist {
  id: string;
  name?: string | null;
  content?: unknown;
  draftOf?: string | null;
}
interface ScLayout {
  id: string;
  width?: number | null;
  height?: number | null;
  config?: unknown;
}
interface ScChannel {
  id: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  layoutId?: string | null;
  content?: unknown;
  draftOf?: string | null;
  type?: string | null;
}
interface ScScreen {
  id: string;
  name?: string | null;
  screenGroupId?: string | null;
  tags?: string[] | null;
  content?: unknown;
  timezone?: string | null;
  playerTimezone?: string | null;
  timezoneOverride?: string | null;
}
interface ScGroup {
  id: string;
  name?: string | null;
}
interface ScLink {
  id: string;
  name?: string | null;
  url?: string | null;
}

interface Entry {
  list_id?: string;
  content?: { _ref?: { type?: string; id?: string }; props?: { duration?: number } };
  rules?: unknown;
}
interface Defaults {
  image?: number;
  link?: number;
  document?: number;
}

/** A JSON column arrives as an object, or as text holding one. */
function jsonOf(value: unknown): Json | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function validZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const query = (field: string, nodes: string): string =>
  `query($first:Int!,$after:Cursor){ ${field}(first:$first, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ${nodes} } } }`;

/** `#zone1 { position:absolute; width:70vw; height:100vh; top:0; left:0; z-index:10 }` as pixel rectangles on a W by H canvas. */
export function zoneRects(css: string, width: number, height: number): Map<string, Pick<SourceZone, "x" | "y" | "width" | "height" | "z">> {
  const rects = new Map<string, Pick<SourceZone, "x" | "y" | "width" | "height" | "z">>();
  const unit = (value: string | undefined, axis: "x" | "y"): number | undefined => {
    const match = /^(-?\d*\.?\d+)\s*(vw|vh|%|px)?$/.exec((value ?? "").trim());
    if (!match) return undefined;
    const n = Number(match[1]);
    if (match[2] === "vw") return (n / 100) * width;
    if (match[2] === "vh") return (n / 100) * height;
    if (match[2] === "%") return (n / 100) * (axis === "x" ? width : height);
    return n;
  };
  const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = /#([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;
  for (let match = rule.exec(sheet); match; match = rule.exec(sheet)) {
    const props: Record<string, string> = {};
    for (const declaration of match[2]!.split(";")) {
      const cut = declaration.indexOf(":");
      if (cut > 0) props[declaration.slice(0, cut).trim().toLowerCase()] = declaration.slice(cut + 1).trim();
    }
    const x = unit(props.left, "x") ?? 0;
    const y = unit(props.top, "y") ?? 0;
    const w = unit(props.width, "x");
    const h = unit(props.height, "y");
    if (w === undefined || h === undefined) continue;
    rects.set(match[1]!, { x, y, width: w, height: h, z: Number(props["z-index"]) || 0 });
  }
  return rects;
}

interface Context {
  /** Imported media (not audio only) by file id. */
  media: Map<string, MediaKind>;
  links: Map<string, ScLink>;
  playlistIds: Set<string>;
  channelIds: Set<string>;
  notImported: ReportEntry[];
}

class ScreenCloudSession implements VendorSession {
  constructor(private readonly client: VendorClient, private readonly region: string) {}

  private all<T>(field: string, nodes: string): Promise<T[]> {
    return cursorPages<T>(
      this.client,
      query(field, nodes),
      (data: Record<string, Connection<T> | undefined>) => {
        const connection = data[field];
        if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) throw vendorBadResponse(NAME, `${field}.nodes or ${field}.pageInfo is missing`);
        return { items: connection.nodes, hasNextPage: connection.pageInfo.hasNextPage === true, endCursor: connection.pageInfo.endCursor ?? null };
      },
      { first: PAGE },
    );
  }

  /** The items of one list, with nested playlists and channels as references the mapper inlines. */
  private items(list: unknown, defaults: Defaults, ctx: Context, owner: { kind: "playlist" | "channel"; id: string; name: string }, zone?: string): { items: SourceItem[]; ruled: number; audio: number } {
    const out: SourceItem[] = [];
    let ruled = 0;
    let audio = 0;
    if (!Array.isArray(list)) return { items: out, ruled, audio };
    (list as Entry[]).forEach((entry, index) => {
      const ref = entry?.content?._ref;
      if (!ref || typeof ref.type !== "string" || typeof ref.id !== "string") return;
      if (Array.isArray(entry.rules) && entry.rules.length > 0) ruled += 1;
      const ms = entry.content?.props?.duration;
      const where = `${owner.name}${zone ? ` / ${zone}` : ""}`;
      const skip = (name: string, reason: string, next?: string): void => {
        ctx.notImported.push({ kind: "item", source_id: `${owner.kind}:${owner.id}:${entry.list_id ?? index}`, name: `${where}: ${name}`, reason, ...(next ? { next } : {}) });
      };
      const own = typeof ms === "number" && ms > 0 ? ms / 1000 : undefined;
      const fallback = (value: number | undefined): number | undefined => (typeof value === "number" && value > 0 ? value / 1000 : undefined);
      switch (ref.type.toLowerCase()) {
        case "file": {
          const kind = ctx.media.get(ref.id);
          if (kind === undefined) {
            // The file is listed on its own (or was deleted); the mapper counts the item as left out.
            out.push({ media_id: ref.id });
            break;
          }
          if (kind === "audio" && zone !== undefined) {
            audio += 1;
            break;
          }
          const duration = kind === "audio" ? undefined : kind === "video" ? own : own ?? fallback(defaults.image);
          out.push({ media_id: ref.id, ...(duration !== undefined ? { duration_s: duration } : {}) });
          break;
        }
        case "playlist":
          if (ctx.playlistIds.has(ref.id)) out.push({ playlist_id: ref.id });
          break;
        case "channel":
          if (ctx.channelIds.has(ref.id)) out.push({ layout_id: ref.id });
          break;
        case "link": {
          const link = ctx.links.get(ref.id);
          if (!link?.url) skip(`link ${ref.id.slice(0, 8)}`, "ScreenCloud gave no address for the link.");
          else {
            const duration = own ?? fallback(defaults.link);
            out.push({ url: link.url, title: (link.name ?? "").trim() || link.url, ...(duration !== undefined ? { duration_s: duration } : {}) });
          }
          break;
        }
        default:
          skip(`${ref.type.toLowerCase()} ${ref.id.slice(0, 8)}`, `A ScreenCloud ${ref.type.toLowerCase()} is not media, a web link or a playlist.`, "Rebuild it as a built-in card, an iframe page or a stream page in a playlist.");
      }
    });
    return { items: out, ruled, audio };
  }

  async scan(): Promise<SourceCatalog> {
    const org = await this.client.graphql<{ currentOrgId?: string }>("query{ currentOrgId }");
    if (typeof org.currentOrgId !== "string" || org.currentOrgId === "") throw vendorBadResponse(NAME, "currentOrgId is missing");
    const files = await this.all<ScFile>("allFiles", "id name mimetype size source deletedAt fileOutputsByFileId(first:20){ nodes{ url mimetype } }");
    const playlists = await this.all<ScPlaylist>("allPlaylists", "id name content draftOf");
    const layouts = await this.all<ScLayout>("allLayouts", "id width height config");
    const channels = await this.all<ScChannel>("allChannels", "id name width height layoutId content draftOf type");
    const screens = await this.all<ScScreen>("allScreens", "id name screenGroupId tags content timezone playerTimezone timezoneOverride");
    const groups = await this.all<ScGroup>("allScreenGroups", "id name");
    const links = await this.all<ScLink>("allLinks", "id name url");
    for (const [path, rows] of [["allFiles", files], ["allPlaylists", playlists], ["allLayouts", layouts], ["allChannels", channels], ["allScreens", screens], ["allScreenGroups", groups], ["allLinks", links]] as const) {
      (rows as Array<{ id?: unknown }>).forEach((row, index) => {
        if (typeof row?.id !== "string" || row.id === "") throw vendorBadResponse(NAME, `${path}.nodes[${index}].id is missing`);
      });
    }

    const notImported: ReportEntry[] = [];
    const notes: string[] = [];

    // ---- files
    const media: SourceMedia[] = [];
    const kinds = new Map<string, MediaKind>();
    const fileNames = new Map<string, string>();
    for (const file of files) {
      if (file.deletedAt) continue;
      const name = (file.name ?? "").trim() || `File ${file.id.slice(0, 8)}`;
      fileNames.set(file.id, name);
      const kind = kindOf({ mime: file.mimetype ?? undefined, filename: file.name ?? undefined });
      if (!kind) {
        notImported.push({ kind: "media", source_id: file.id, name, reason: "It is not an image, video or audio file." });
        continue;
      }
      const size = Number(file.size);
      let url: string | undefined;
      let original = true;
      if (typeof file.source === "string" && /^https:\/\//i.test(file.source)) {
        url = file.source;
      } else {
        const output = (file.fileOutputsByFileId?.nodes ?? []).find((node) => node?.url && /^https:\/\//i.test(node.url) && kindOf({ mime: node.mimetype ?? undefined }) === kind);
        url = output?.url ?? undefined;
        original = false;
      }
      if (!url) {
        notImported.push({ kind: "media", source_id: file.id, name, reason: "ScreenCloud gave no address for the file." });
        continue;
      }
      media.push({ id: file.id, name, filename: name, kind, ...(original && Number.isFinite(size) && size > 0 ? { bytes: size } : {}), fetch: { url }, original });
      kinds.set(file.id, kind);
    }

    const linkById = new Map(links.map((link) => [link.id, link]));
    const ctx: Context = {
      media: kinds,
      links: linkById,
      playlistIds: new Set(playlists.filter((playlist) => !playlist.draftOf).map((playlist) => playlist.id)),
      channelIds: new Set(),
      notImported,
    };

    // ---- channels: the layout each one uses decides the zones
    const layoutById = new Map(layouts.map((layout) => [layout.id, layout]));
    const publishedChannels = channels.filter((channel) => !channel.draftOf && channel.type !== "BLANK" && channel.type !== "SPLASH");
    if (publishedChannels.length < channels.filter((channel) => !channel.draftOf).length) notes.push("ScreenCloud's built-in blank and splash channels are not imported.");
    for (const channel of publishedChannels) ctx.channelIds.add(channel.id);

    const ruledNote = (kind: "channel" | "playlist", id: string, name: string, count: number): void => {
      if (count === 0) return;
      notImported.push({
        kind: "schedule",
        source_id: `${kind}:${id}`,
        name: `${name} (${count} item${count === 1 ? "" : "s"})`,
        reason: `Its items carry time, weekday or date rules, which do not come over: they play whenever the ${kind} plays.`,
        next: "After the screen is paired, make a campaign for those hours (campaign create), or set visibility on the playlist's pages.",
      });
    };
    // ---- playlists (drafts are copies of a published one)
    const catalogPlaylists: SourcePlaylist[] = [];
    for (const playlist of playlists) {
      if (playlist.draftOf) continue;
      const name = (playlist.name ?? "").trim() || `Playlist ${playlist.id.slice(0, 8)}`;
      const content = jsonOf(playlist.content) ?? {};
      const defaults = (jsonOf(jsonOf(content.props)?.default_durations) ?? {}) as Defaults;
      const built = this.items(content.list, defaults, ctx, { kind: "playlist", id: playlist.id, name });
      ruledNote("playlist", playlist.id, name, built.ruled);
      catalogPlaylists.push({ id: playlist.id, name, items: built.items, notes: [] });
    }
    const playlistIds = new Set(catalogPlaylists.map((playlist) => playlist.id));
    const playlistItems = new Map(catalogPlaylists.map((playlist) => [playlist.id, playlist.items]));

    /** A layout's zones cannot play audio, so a playlist inside a zone is inlined here, without its audio. */
    const flatten = (list: SourceItem[], stack: readonly string[], dropped: { audio: number }): SourceItem[] =>
      list.flatMap((item): SourceItem[] => {
        if ("playlist_id" in item) {
          const inner = playlistItems.get(item.playlist_id);
          return inner && !stack.includes(item.playlist_id) ? flatten(inner, [...stack, item.playlist_id], dropped) : [];
        }
        if ("media_id" in item && kinds.get(item.media_id) === "audio") {
          dropped.audio += 1;
          return [];
        }
        return [item];
      });

    const catalogLayouts: SourceLayout[] = [];
    for (const channel of publishedChannels) {
      const name = (channel.name ?? "").trim() || `Channel ${channel.id.slice(0, 8)}`;
      const layout = channel.layoutId ? layoutById.get(channel.layoutId) : undefined;
      const config = jsonOf(layout?.config) ?? {};
      const width = Number(config.width) || layout?.width || channel.width || DEFAULT_CANVAS.width;
      const height = Number(config.height) || layout?.height || channel.height || DEFAULT_CANVAS.height;
      const content = jsonOf(channel.content) ?? {};
      const zoneContent = (jsonOf(content.zones) ?? {}) as Record<string, unknown>;
      const channelDefaults = (jsonOf(jsonOf(content.props)?.default_durations) ?? {}) as Defaults;
      const defined = Array.isArray(config.zones) && config.zones.length > 0
        ? (config.zones as Array<{ id?: unknown; name?: unknown }>).filter((zone) => typeof zone?.id === "string").map((zone) => ({ id: zone.id as string, name: typeof zone.name === "string" && zone.name.trim() ? zone.name.trim() : (zone.id as string) }))
        : Object.keys(zoneContent).filter((id) => id !== "hidden").sort().map((id) => ({ id, name: id }));
      const rects = zoneRects(typeof config.css === "string" ? config.css : "", width, height);
      const layoutNotes: string[] = [];
      let ruled = 0;
      let audioDropped = 0;
      const zones: SourceZone[] = defined.map((zone): SourceZone => {
        const holder = jsonOf(zoneContent[zone.id]);
        const zoneDefaults = { ...channelDefaults, ...((jsonOf(jsonOf(holder?.props)?.default_durations) ?? {}) as Defaults) };
        const built = this.items(holder?.list, zoneDefaults, ctx, { kind: "channel", id: channel.id, name }, zone.name);
        const dropped = { audio: built.audio };
        built.items = flatten(built.items, [], dropped);
        ruled += built.ruled;
        audioDropped += dropped.audio;
        const rect = rects.get(zone.id);
        if (!rect && defined.length > 1) layoutNotes.push(`The position of ${zone.name} could not be read from the layout, so it fills the screen.`);
        return { id: zone.id, name: zone.name, ...(rect ?? { x: 0, y: 0, width, height, z: 0 }), items: built.items };
      });
      const hidden = jsonOf(zoneContent.hidden)?.list;
      if (Array.isArray(hidden) && hidden.length > 0) layoutNotes.push(`Its hidden zone held ${hidden.length} item${hidden.length === 1 ? ", which does" : "s, which do"} not come over.`);
      if (audioDropped > 0) layoutNotes.push(`${audioDropped} audio file${audioDropped === 1 ? " is" : "s are"} not played: audio comes over only as a playlist's soundtrack, not inside a layout.`);
      ruledNote("channel", channel.id, name, ruled);
      catalogLayouts.push({ id: channel.id, name, width: Math.round(width), height: Math.round(height), zones, notes: layoutNotes });
    }

    // ---- screens and groups
    const catalogGroups: SourceGroup[] = groups.map((group) => ({ id: `g:${group.id}`, name: (group.name ?? "").trim() || `Group ${group.id.slice(0, 8)}` }));
    const tagGroups = new Map<string, string>();
    const synthetic = new Map<string, SourcePlaylist>();
    const catalogScreens: SourceScreen[] = screens.map((screen): SourceScreen => {
      const ids: string[] = screen.screenGroupId ? [`g:${screen.screenGroupId}`] : [];
      for (const tag of Array.isArray(screen.tags) ? screen.tags : []) {
        const text = typeof tag === "string" ? tag.trim() : "";
        if (!text) continue;
        const key = text.toLowerCase();
        if (!tagGroups.has(key)) {
          tagGroups.set(key, `tag:${key}`);
          catalogGroups.push({ id: `tag:${key}`, name: text });
        }
        if (!ids.includes(tagGroups.get(key)!)) ids.push(tagGroups.get(key)!);
      }
      const screenNotes: string[] = [];
      let content: SourceScreen["content"];
      const raw = jsonOf(screen.content);
      if (raw) {
        // The API describes a screen's content only as the JSON for a channel id: it is read in the _ref shape the playlist and channel content use.
        const ref = (jsonOf(raw._ref) ?? raw) as { type?: unknown; id?: unknown };
        const type = typeof ref.type === "string" ? ref.type.toLowerCase() : "";
        const id = typeof ref.id === "string" ? ref.id : "";
        if (type === "channel" && ctx.channelIds.has(id)) content = { layout_id: id };
        else if (type === "playlist" && playlistIds.has(id)) content = { playlist_id: id };
        else if (type === "file" && kinds.has(id) && kinds.get(id) !== "audio") {
          const key = `file:${id}`;
          if (!synthetic.has(key)) synthetic.set(key, { id: key, name: fileNames.get(id) ?? "File", items: [{ media_id: id }], notes: [] });
          content = { playlist_id: key };
        } else if (type === "link" && linkById.get(id)?.url) {
          const key = `link:${id}`;
          const link = linkById.get(id)!;
          if (!synthetic.has(key)) synthetic.set(key, { id: key, name: (link.name ?? "").trim() || link.url!, items: [{ url: link.url!, title: (link.name ?? "").trim() || link.url! }], notes: [] });
          content = { playlist_id: key };
        } else if (type === "app" || type === "site") {
          screenNotes.push(`It showed ${type === "app" ? "an app" : "a site"}, which does not come over.`);
        } else if (type === "") {
          screenNotes.push("Its current content could not be read.");
        }
      }
      const timezone = [screen.timezoneOverride, screen.timezone, screen.playerTimezone].find(validZone);
      return { id: screen.id, name: (screen.name ?? "").trim() || `Screen ${screen.id.slice(0, 8)}`, group_ids: ids, ...(content ? { content } : {}), ...(timezone ? { timezone } : {}), notes: screenNotes };
    });

    return {
      account: org.currentOrgId,
      label: `ScreenCloud (${this.region.toUpperCase()})`,
      media,
      playlists: [...catalogPlaylists, ...synthetic.values()],
      layouts: catalogLayouts,
      groups: catalogGroups,
      screens: catalogScreens,
      schedules: [],
      not_imported: notImported,
      notes,
    };
  }

  async fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }> {
    const url = (media.fetch as { url?: string } | undefined)?.url;
    if (!url) throw vendorBadResponse(NAME, "a media entry has no file address");
    return this.client.download(url, destination);
  }
}

export const screencloud: VendorAdapter = {
  id: "screencloud",
  name: NAME,
  inputs: { regions: ["eu", "us"], files: "optional" },
  credentials: [{ env: "SCREENCLOUD_API_TOKEN", secret: true, required: true, help: "An API token from ScreenCloud Studio, Account Settings, Developer." }],
  connect: [
    "In Studio open Account Settings, then the Developer tab, and click New Token. Choose read permissions for files, playlists, channels, layouts, screens, screen groups and links (full access also works), and copy the key once.",
    "The Developer tab names your GraphQL endpoint; its region is eu or us, and goes to --region.",
    "Put SCREENCLOUD_API_TOKEN=... in a file and pass it with --credentials.",
  ],
  maps: [
    "Files become media (images, video and audio), and web links become web page items.",
    "Playlists keep their items and durations. Channels become layouts: each zone is placed from the layout's CSS, and a channel's own playlists are inlined.",
    "Screen groups and screen tags become groups. Screens become waiting screens with their time zone and, when it is a channel, playlist, file or link, their content.",
  ],
  skips: [
    "ScreenCloud has no schedule object, so none are created. Time, weekday and date rules on items are listed per channel and playlist; the items play whenever the channel does.",
    "Apps, sites, a channel's hidden zone, and drafts are listed or left out; files that are not images, video or audio are listed.",
  ],
  docs: [
    "https://screencloud.github.io/signage-next-graphql-docs/get-an-api-token",
    "https://screencloud.github.io/signage-next-graphql-docs/graphql-reference/content-json-reference/playlist-content",
    "https://screencloud.github.io/signage-next-graphql-docs/graphql-reference/content-json-reference/channel-content",
    "https://screencloud.github.io/signage-next-graphql-docs/graphql-reference/content-json-reference/custom-layout-config",
    "https://screencloud.github.io/signage-next-graphql-docs/graphql-reference",
  ],
  example: "screenrig migrate scan --from screencloud --region eu",
  async open(input) {
    const host = HOSTS[input.region ?? ""];
    if (!host) throw vendorBadResponse(NAME, "the region is not eu or us");
    const token = (input.credentials.SCREENCLOUD_API_TOKEN ?? "").trim().replace(/^Bearer\s+/i, "");
    return new ScreenCloudSession(input.http.client({ base: host, auth: { Authorization: `Bearer ${token}` } }), input.region!);
  },
};
