import { vendorBadResponse, offsetPages } from "../http.js";
import { addDays } from "../map.js";
import type {
  ReportEntry, SourceCatalog, SourceGroup, SourceItem, SourceMedia, SourcePlaylist, SourceSchedule, SourceScreen, VendorAdapter, VendorClient, VendorSession, Weekday,
} from "../types.js";

/**
 * Screenly (cloud), API v4.1. Screenly has no layouts. A screen plays every
 * enabled playlist its labels reach, one after another, each playlist held by a
 * predicate over weekday, time of day and date. So:
 * - a screen's always-on playlists are its default content (several of them play
 *   as one combined playlist, in name order);
 * - every other predicate rule that campaigns can express becomes a campaign for
 *   the label's screens, exactly; the rest is listed with its reason.
 */

const NAME = "Screenly";
const BASE = "https://api.screenlyapp.com/api/v4.1";
const DAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PAGE = 100;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const END_OF_DAY = MS_PER_DAY - 1;

interface Row {
  id?: string;
  team_id?: string;
}
interface ScreenlyAsset extends Row {
  title?: string;
  type?: string;
  mimetype?: string;
  asset_url?: string;
  source_url?: string;
  status?: string;
  duration?: number;
}
interface ScreenlyPlaylist extends Row {
  title?: string;
  predicate?: string | null;
  is_enabled?: boolean;
  priority?: boolean;
}
interface ScreenlyItem extends Row {
  playlist_id: string;
  asset_id: string;
  position?: number;
  duration?: number;
  effective_duration?: number;
}
interface ScreenlyLabel extends Row {
  name?: string;
  human_name?: string;
  type?: string;
}
interface ScreenlyScreen extends Row {
  name?: string;
  timezone?: string;
  is_enabled?: boolean;
}
interface LabelLink {
  label_id: string;
  screen_id?: string;
  playlist_id?: string;
}

// ---- predicates ---------------------------------------------------------------------------------

/** One AND-joined alternative of a predicate: what must all hold. Absent members do not restrict. */
interface Term {
  /** Allowed weekdays, 0 = Monday. */
  days?: number[];
  /** Milliseconds since local midnight, inclusive. */
  lo?: number;
  hi?: number;
  /** Epoch milliseconds of a day, inclusive. */
  dlo?: number;
  dhi?: number;
}

type Parsed = { ok: true; terms: Term[] } | { ok: false; reason: string };

class Unsupported extends Error {}

const TOKEN = /\s*(\$[A-Za-z]+|<=|>=|=|<|>|\(|\)|\{|\}|,|-?\d+|[A-Za-z]+)/y;

function tokens(text: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text.slice(at).trim() === "") break;
      throw new Unsupported("It uses a form this CLI does not read.");
    }
    out.push(match[1]!);
    at = TOKEN.lastIndex;
  }
  return out;
}

function intersect(a: Term, b: Term): Term | undefined {
  const days = a.days && b.days ? a.days.filter((day) => b.days!.includes(day)) : (a.days ?? b.days);
  const pick = (x: number | undefined, y: number | undefined, wider: (p: number, q: number) => number): number | undefined => (x === undefined ? y : y === undefined ? x : wider(x, y));
  const term: Term = {
    ...(days ? { days } : {}),
    ...(pick(a.lo, b.lo, Math.max) !== undefined ? { lo: pick(a.lo, b.lo, Math.max)! } : {}),
    ...(pick(a.hi, b.hi, Math.min) !== undefined ? { hi: pick(a.hi, b.hi, Math.min)! } : {}),
    ...(pick(a.dlo, b.dlo, Math.max) !== undefined ? { dlo: pick(a.dlo, b.dlo, Math.max)! } : {}),
    ...(pick(a.dhi, b.dhi, Math.min) !== undefined ? { dhi: pick(a.dhi, b.dhi, Math.min)! } : {}),
  };
  const empty = (term.days !== undefined && term.days.length === 0)
    || (term.dlo !== undefined && term.dhi !== undefined && dayOf(term.dlo) > dayOf(term.dhi));
  return empty ? undefined : term;
}

/** The calendar day an epoch-millisecond `$DATE` names: the nearest UTC midnight, which is the value itself for a UTC-midnight stamp and the screen's local midnight for any zone within 12 hours of UTC. */
function dayOf(ms: number): string {
  return new Date(Math.round(ms / MS_PER_DAY) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** AND-joined clauses, grouped and OR-ed, over the three documented variables. Anything else is Unsupported. */
export function parsePredicate(predicate: string | null | undefined): Parsed {
  const text = (predicate ?? "").trim();
  if (text === "") return { ok: true, terms: [{}] };
  let list: string[];
  try {
    list = tokens(text);
  } catch (error) {
    return { ok: false, reason: error instanceof Unsupported ? error.message : "It could not be read." };
  }
  let at = 0;
  const peek = (): string | undefined => list[at]?.toUpperCase();
  const take = (): string => list[at++] ?? "";
  const expect = (word: string): void => {
    if (peek() !== word) throw new Unsupported("It uses a form this CLI does not read.");
    at += 1;
  };
  const number = (): number => {
    const value = take();
    if (!/^-?\d+$/.test(value)) throw new Unsupported("It uses a form this CLI does not read.");
    return Number(value);
  };
  const set = (): number[] => {
    expect("{");
    const values = [number()];
    while (peek() === ",") {
      at += 1;
      values.push(number());
    }
    expect("}");
    return values;
  };
  const weekdays = (negate: boolean): Term[] => {
    const values = set();
    if (values.some((day) => day < 0 || day > 6)) throw new Unsupported("A weekday is outside 0 (Monday) to 6 (Sunday).");
    const chosen = [...new Set(values)].sort((x, y) => x - y);
    return [{ days: negate ? [0, 1, 2, 3, 4, 5, 6].filter((day) => !chosen.includes(day)) : chosen }];
  };
  const clause = (): Term[] => {
    const word = peek();
    if (word === "TRUE") {
      at += 1;
      return [{}];
    }
    if (word === "FALSE") {
      at += 1;
      return [];
    }
    if (word === "(") {
      at += 1;
      const inner = orExpr();
      expect(")");
      return inner;
    }
    if (word === "NOT") {
      at += 1;
      const grouped = peek() === "(";
      if (grouped) at += 1;
      if (peek() !== "$WEEKDAY") throw new Unsupported("It negates something other than a weekday list, which campaigns cannot express.");
      at += 1;
      expect("IN");
      const result = weekdays(true);
      if (grouped) expect(")");
      return result;
    }
    if (word === "$WEEKDAY") {
      at += 1;
      let negate = false;
      if (peek() === "NOT") {
        negate = true;
        at += 1;
      }
      expect("IN");
      return weekdays(negate);
    }
    if (word === "$TIME") {
      at += 1;
      const operator = peek();
      if (operator === "BETWEEN") {
        at += 1;
        const pair = set();
        if (pair.length !== 2) throw new Unsupported("Its time rule does not hold exactly a start and an end.");
        return [{ lo: pair[0]!, hi: pair[1]! }];
      }
      if (operator === ">=") {
        at += 1;
        return [{ lo: number() }];
      }
      if (operator === "<=") {
        at += 1;
        return [{ hi: number() }];
      }
      throw new Unsupported("Its time rule uses an operator other than BETWEEN, >= or <=.");
    }
    if (word === "$DATE") {
      at += 1;
      const operator = peek();
      if (operator === "<=" || operator === ">=" || operator === "=") {
        at += 1;
        const value = number();
        return [operator === "<=" ? { dhi: value } : operator === ">=" ? { dlo: value } : { dlo: value, dhi: value }];
      }
      throw new Unsupported("Its date rule uses an operator other than <=, = or >=.");
    }
    throw new Unsupported("It uses a form this CLI does not read.");
  };
  const andExpr = (): Term[] => {
    let terms = clause();
    while (peek() === "AND") {
      at += 1;
      const right = clause();
      terms = terms.flatMap((left) => right.flatMap((other) => intersect(left, other) ?? []));
    }
    return terms;
  };
  const orExpr = (): Term[] => {
    const terms = andExpr();
    while (peek() === "OR") {
      at += 1;
      terms.push(...andExpr());
    }
    return terms;
  };
  try {
    const terms = orExpr();
    if (at < list.length) throw new Unsupported("It uses a form this CLI does not read.");
    const alive = terms.flatMap((term) => intersect(term, {}) ?? []);
    if (alive.length === 0) return { ok: false, reason: "Its rule is never true, so the playlist never plays." };
    if (alive.some((term) => isAlways(term))) return { ok: true, terms: [{}] };
    const seen = new Set<string>();
    return { ok: true, terms: alive.filter((term) => !seen.has(JSON.stringify(term)) && seen.add(JSON.stringify(term))) };
  } catch (error) {
    return { ok: false, reason: error instanceof Unsupported ? error.message : "It could not be read." };
  }
}

function isAlways(term: Term): boolean {
  return term.dlo === undefined && term.dhi === undefined && !restrictsDays(term) && !restrictsTime(term);
}
function restrictsDays(term: Term): boolean {
  return term.days !== undefined && term.days.length < 7;
}
function restrictsTime(term: Term): boolean {
  return (term.lo !== undefined && term.lo > 0) || (term.hi !== undefined && term.hi < END_OF_DAY);
}

type Timing = { ok: true; schedule: Pick<SourceSchedule, "always" | "start" | "end" | "repeat">; notes: string[] } | { ok: false; reason: string };

/** The campaign timing of one term, in each screen's own zone: exact, or the reason it cannot be. */
export function termTiming(term: Term, today: string): Timing {
  const notes: string[] = [];
  const dlo = term.dlo === undefined ? undefined : dayOf(term.dlo);
  const dhi = term.dhi === undefined ? undefined : dayOf(term.dhi);
  for (const stamp of [term.dlo, term.dhi]) {
    if (stamp !== undefined && stamp % MS_PER_DAY !== 0) {
      notes.push("Screenly gives a date as a time stamp without a zone; it was read as the calendar day nearest the stamp.");
      break;
    }
  }
  if (isAlways(term)) return { ok: true, schedule: { always: true }, notes };
  if (!restrictsDays(term) && !restrictsTime(term)) {
    return {
      ok: true,
      schedule: { ...(dlo ? { start: `${dlo}T00:00` } : {}), ...(dhi ? { end: `${addDays(dhi, 1)}T00:00` } : {}) },
      notes,
    };
  }
  const weekdays = restrictsDays(term) ? term.days!.map((day) => DAYS[day]!) : undefined;
  // A rule on days alone runs midnight to the next midnight on those days.
  let start = "00:00";
  let end = "00:00";
  let endsNextDay = true;
  if (restrictsTime(term)) {
    const from = term.lo ?? 0;
    const to = Math.min(term.hi ?? END_OF_DAY, END_OF_DAY);
    if (from < 0 || from > END_OF_DAY || to < 0) return { ok: false, reason: "Its time window is outside the day." };
    if (to < from) return { ok: false, reason: "Its time window ends before it starts." };
    const startMinute = Math.floor(from / MS_PER_MINUTE);
    const endMinute = Math.ceil(to / MS_PER_MINUTE);
    if (from % MS_PER_MINUTE !== 0 || (to % MS_PER_MINUTE !== 0 && to !== END_OF_DAY)) notes.push("Its times were rounded outward to the minute.");
    if (endMinute <= startMinute) return { ok: false, reason: "Its time window is shorter than a minute." };
    const clock = (minute: number): string => `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    start = clock(startMinute);
    end = clock(endMinute);
    endsNextDay = endMinute >= 1440;
  }
  const first = dlo ?? today;
  return {
    ok: true,
    schedule: {
      start: `${first}T${start}`,
      end: `${endsNextDay ? addDays(first, 1) : first}T${end}`,
      repeat: { every: weekdays ? "week" : "day", ...(weekdays ? { weekdays } : {}), ...(dhi ? { until: dhi } : {}) },
    },
    notes,
  };
}

// ---- assets ---------------------------------------------------------------------------------------

const EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/mpeg": "mpg", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/aac": "aac", "audio/flac": "flac",
};

function filenameOf(asset: ScreenlyAsset, title: string): string {
  const extension = EXTENSION[(asset.mimetype ?? "").toLowerCase().split(";")[0]!.trim()];
  return extension ? `${title}.${extension}` : title;
}

const NOT_MEDIA: Record<string, [string, string?]> = {
  streaming: ["It is a live stream.", "Add the stream address as a stream page in a playlist."],
  "edge-app": ["It is a Screenly Edge App.", "Rebuild it as a built-in card or an iframe page in a playlist."],
  "edge-app-file": ["It is a file of a Screenly Edge App.", "Rebuild it as a built-in card or an iframe page in a playlist."],
  pdf: ["It is a PDF document, which is not an image, video or audio file.", "Export its pages as images and upload them with media upload."],
  "pdf-page": ["It is a page of a PDF document, which is not an image, video or audio file.", "Export the pages as images and upload them with media upload."],
};

// ---- the session ------------------------------------------------------------------------------------

class ScreenlySession implements VendorSession {
  constructor(private readonly client: VendorClient, private readonly now: () => Date) {}

  /** Rows are asked for 100 at a time and the listing ends on an empty page: a PostgREST server may return fewer rows than the limit when it caps them, and a short page is then not the end. */
  private list<T>(path: string, order: string): Promise<T[]> {
    return offsetPages<T>(
      async (start) => {
        const body = await this.client.json<unknown>(path, { query: { limit: PAGE, offset: start, order } });
        if (!Array.isArray(body)) throw vendorBadResponse(NAME, `${path} did not answer with a list`);
        return { items: body as T[] };
      },
      { pageSize: 1 },
    );
  }

  async scan(): Promise<SourceCatalog> {
    const assets = await this.list<ScreenlyAsset>("/assets", "id");
    const playlists = await this.list<ScreenlyPlaylist>("/playlists", "id");
    const items = await this.list<ScreenlyItem>("/playlist-items", "id");
    const labels = await this.list<ScreenlyLabel>("/labels", "id");
    const labelScreens = await this.list<LabelLink>("/labels/screens", "label_id,screen_id");
    const labelPlaylists = await this.list<LabelLink>("/labels/playlists", "label_id,playlist_id");
    const screens = await this.list<ScreenlyScreen>("/screens", "id");
    requireIds("/assets", assets);
    requireIds("/playlists", playlists);
    requireIds("/labels", labels);
    requireIds("/screens", screens);
    items.forEach((row, index) => {
      if (typeof row.playlist_id !== "string" || typeof row.asset_id !== "string") throw vendorBadResponse(NAME, `/playlist-items[${index}] has no playlist_id or asset_id`);
    });
    const today = this.now().toISOString().slice(0, 10);

    // ---- media and web pages
    const media: SourceMedia[] = [];
    const notImported: ReportEntry[] = [];
    const webPages = new Map<string, { url: string; title: string }>();
    const importedMedia = new Set<string>();
    for (const asset of assets) {
      const title = (asset.title ?? "").trim() || `Asset ${asset.id!.slice(0, 8)}`;
      const type = asset.type ?? "";
      const entry = (reason: string, next?: string): void => {
        notImported.push({ kind: type === "web" || type === "streaming" || type.startsWith("edge-app") ? "item" : "media", source_id: asset.id!, name: title, reason, ...(next ? { next } : {}) });
      };
      if (NOT_MEDIA[type]) {
        entry(...NOT_MEDIA[type]!);
      } else if (type === "web") {
        const url = (asset.source_url ?? asset.asset_url ?? "").trim();
        if (/^https?:\/\//i.test(url)) webPages.set(asset.id!, { url, title });
        else entry("Its address is not an http or https address.");
      } else if (type === "image" || type === "video" || type === "audio") {
        if (asset.status !== undefined && asset.status !== "finished") entry("Screenly has not finished processing it.");
        else if (!asset.asset_url) entry("Screenly gave no address for the file.");
        else {
          media.push({ id: asset.id!, name: title, filename: filenameOf(asset, title), kind: type, fetch: { url: asset.asset_url }, original: true });
          importedMedia.add(asset.id!);
        }
      } else {
        entry(`Screenly asset type "${type || "unknown"}" is not an image, video, audio file or web page.`);
      }
    }
    const assetById = new Map(assets.map((asset) => [asset.id!, asset]));

    // ---- playlists
    const byPlaylist = new Map<string, ScreenlyItem[]>();
    for (const item of items) byPlaylist.set(item.playlist_id, [...(byPlaylist.get(item.playlist_id) ?? []), item]);
    const catalogPlaylists: SourcePlaylist[] = playlists.map((playlist) => {
      const ordered = [...(byPlaylist.get(playlist.id!) ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.id ?? "").localeCompare(b.id ?? ""));
      const out: SourceItem[] = [];
      let left = 0;
      for (const item of ordered) {
        const asset = assetById.get(item.asset_id);
        const played = item.effective_duration !== undefined && item.effective_duration > 0 ? item.effective_duration : item.duration;
        if (importedMedia.has(item.asset_id)) {
          const kind = asset!.type;
          if (kind === "image") out.push({ media_id: item.asset_id, ...(played !== undefined && played > 0 ? { duration_s: played } : {}) });
          else if (kind === "video") {
            const own = typeof asset!.duration === "number" ? asset!.duration : undefined;
            out.push({ media_id: item.asset_id, ...(played !== undefined && played > 0 && (own === undefined || Math.abs(played - own) > 0.5) ? { duration_s: played } : {}) });
          } else out.push({ media_id: item.asset_id });
        } else if (webPages.has(item.asset_id)) {
          const page = webPages.get(item.asset_id)!;
          out.push({ url: page.url, title: page.title, ...(played !== undefined && played > 0 ? { duration_s: played } : {}) });
        } else left += 1;
      }
      const notes: string[] = [];
      if (left > 0) notes.push(`${left} item${left === 1 ? " was" : "s were"} left out because ${left === 1 ? "its" : "their"} asset is listed under Cannot come over.`);
      if (playlist.is_enabled === false) notes.push("It was switched off in Screenly.");
      return { id: playlist.id!, name: (playlist.title ?? "").trim() || `Playlist ${playlist.id!.slice(0, 8)}`, items: out, notes };
    });
    const playlistById = new Map(catalogPlaylists.map((playlist) => [playlist.id, playlist]));

    // ---- labels: screens' own, and groups
    const screenIds = new Set(screens.map((screen) => screen.id!));
    const members = new Map<string, string[]>();
    for (const link of labelScreens) {
      if (typeof link.label_id !== "string" || typeof link.screen_id !== "string") throw vendorBadResponse(NAME, "/labels/screens has a row without label_id or screen_id");
      if (screenIds.has(link.screen_id)) members.set(link.label_id, [...(members.get(link.label_id) ?? []), link.screen_id]);
    }
    const screenName = new Map(screens.map((screen) => [screen.id!, (screen.name ?? "").trim()]));
    const groups: SourceGroup[] = [];
    const ownLabel = new Map<string, string>();
    const groupMembers = new Map<string, string[]>();
    for (const label of labels) {
      const names = [label.human_name, label.name].map((value) => (value ?? "").trim()).filter(Boolean);
      const reached = label.type === "all-screens" ? [...screenIds] : [...new Set(members.get(label.id!) ?? [])];
      const only = reached.length === 1 ? reached[0]! : undefined;
      const own = only !== undefined && (label.type === "screen" || (label.type === undefined && names.includes(screenName.get(only) ?? "\u0000")));
      if (own) {
        ownLabel.set(label.id!, only!);
      } else if (label.type === "screen") {
        continue;
      } else {
        groups.push({ id: label.id!, name: names[0] ?? `Label ${label.id!.slice(0, 8)}` });
        groupMembers.set(label.id!, reached);
      }
    }
    const groupIds = new Set(groups.map((group) => group.id));

    // ---- which playlists reach which labels, and how each plays
    const labelsOf = new Map<string, string[]>();
    for (const link of labelPlaylists) {
      if (typeof link.label_id !== "string" || typeof link.playlist_id !== "string") throw vendorBadResponse(NAME, "/labels/playlists has a row without label_id or playlist_id");
      labelsOf.set(link.playlist_id, [...(labelsOf.get(link.playlist_id) ?? []), link.label_id]);
    }
    const schedules: SourceSchedule[] = [];
    const base = new Map<string, Set<string>>();
    const addBase = (screen: string, playlist: string): void => {
      if (!base.has(screen)) base.set(screen, new Set());
      base.get(screen)!.add(playlist);
    };
    for (const playlist of playlists) {
      const reach = [...new Set(labelsOf.get(playlist.id!) ?? [])].filter((id) => ownLabel.has(id) || groupIds.has(id));
      if (reach.length === 0) continue;
      const title = playlistById.get(playlist.id!)!.name;
      const problem = (reason: string): void => {
        notImported.push({ kind: "schedule", source_id: playlist.id!, name: title, reason });
      };
      if (playlist.is_enabled === false) {
        problem("The playlist is switched off in Screenly, so its labels play nothing.");
        continue;
      }
      const parsed = parsePredicate(playlist.predicate);
      if (!parsed.ok) {
        problem(parsed.reason);
        continue;
      }
      const priority = playlist.priority === true ? 10 : 0;
      const alwaysOn = parsed.terms.length === 1 && isAlways(parsed.terms[0]!);
      if (alwaysOn && priority === 0) {
        for (const label of reach) for (const screen of ownLabel.has(label) ? [ownLabel.get(label)!] : groupMembers.get(label) ?? []) addBase(screen, playlist.id!);
        continue;
      }
      parsed.terms.forEach((term, index) => {
        const timing = termTiming(term, today);
        if (!timing.ok) {
          problem(timing.reason);
          return;
        }
        const suffix = parsed.terms.length > 1 ? ` (${index + 1})` : "";
        for (const label of reach) {
          const own = ownLabel.get(label);
          schedules.push({
            id: `${playlist.id}:${label}${parsed.terms.length > 1 ? `:${index + 1}` : ""}`,
            name: `${title}${suffix}`,
            targets: own ? { group_ids: [], screen_ids: [own] } : { group_ids: [label], screen_ids: [] },
            content: { playlist_id: playlist.id! },
            ...timing.schedule,
            priority,
            notes: [
              ...timing.notes,
              ...(parsed.terms.length > 1 ? ["Its rule had several alternatives; each became its own campaign."] : []),
              // A priority playlist replaces the others while its rule is true, as a campaign does; any other plays beside them.
              ...(priority === 0 ? ["In Screenly it played alongside the screen's other playlists during its hours; the campaign shows it instead of them."] : []),
            ],
          });
        }
      });
    }

    // ---- screens: an always-on playlist is the default; several play as one combined playlist
    const combined = new Map<string, SourcePlaylist>();
    const catalogScreens: SourceScreen[] = screens.map((screen) => {
      const wanted = [...(base.get(screen.id!) ?? [])].sort((a, b) => playlistById.get(a)!.name.localeCompare(playlistById.get(b)!.name) || (a < b ? -1 : 1));
      let content: SourceScreen["content"];
      if (wanted.length === 1) content = { playlist_id: wanted[0]! };
      else if (wanted.length > 1) {
        const id = `combined:${wanted.join("+")}`;
        if (!combined.has(id)) {
          const names = wanted.map((playlistId) => playlistById.get(playlistId)!.name);
          combined.set(id, {
            id,
            name: names.join(" + ").slice(0, 100),
            items: wanted.map((playlist_id): SourceItem => ({ playlist_id })),
            notes: [`Screenly plays every active playlist of a screen one after another, in an order it does not publish; this one plays ${names.join(", ")} in that order.`],
          });
        }
        content = { playlist_id: id };
      }
      const timezone = screen.timezone && validZone(screen.timezone) ? screen.timezone : undefined;
      return {
        id: screen.id!,
        name: (screen.name ?? "").trim() || `Screen ${screen.id!.slice(0, 8)}`,
        group_ids: groups.filter((group) => groupMembers.get(group.id)?.includes(screen.id!)).map((group) => group.id),
        ...(content ? { content } : {}),
        ...(timezone ? { timezone } : {}),
        notes: screen.is_enabled === false ? ["It was switched off in Screenly."] : [],
      };
    });

    // ---- the account is the team most rows belong to (a shared playlist can carry another team's id)
    const teams = new Map<string, number>();
    for (const row of [...assets, ...labels, ...screens, ...playlists]) if (row.team_id) teams.set(row.team_id, (teams.get(row.team_id) ?? 0) + 1);
    const team = [...teams].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
    return {
      account: team ?? "screenly",
      label: "Screenly",
      media,
      playlists: [...catalogPlaylists, ...combined.values()],
      layouts: [],
      groups,
      screens: catalogScreens,
      schedules,
      not_imported: notImported,
      notes: [],
    };
  }

  async fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }> {
    const url = (media.fetch as { url?: string } | undefined)?.url;
    if (!url) throw vendorBadResponse(NAME, "a media entry has no file address");
    return this.client.download(url, destination);
  }
}

function requireIds(path: string, rows: Row[]): void {
  rows.forEach((row, index) => {
    if (typeof row.id !== "string" || row.id === "") throw vendorBadResponse(NAME, `${path}[${index}].id is missing`);
  });
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const screenly: VendorAdapter = {
  id: "screenly",
  name: NAME,
  inputs: {},
  credentials: [{ env: "SCREENLY_API_TOKEN", secret: true, required: true, help: "An API token from your Screenly workspace settings." }],
  connect: [
    "In Screenly open Settings (the workspace settings, not your account), then Security, then Tokens, and add a token. It is shown once.",
    "A token can do what its creator can do, and Screenly has no read-only token: make it from a User-role account made for this, and delete the token when the import is done.",
    "Put SCREENLY_API_TOKEN=... in a file and pass it with --credentials.",
  ],
  maps: [
    "Image, video and audio assets become media, and web assets become web page items; playlists keep their item order and durations.",
    "Labels become groups; a screen's own label stays with that screen. Screens become waiting screens with their time zone.",
    "A screen's always-on playlist is its default content (several play as one combined playlist). Every other playlist rule on a label (weekdays, time of day, dates, alternatives joined by OR) becomes campaigns for that label's screens.",
  ],
  skips: [
    "Streaming, Edge App and PDF assets are listed.",
    "Rules campaigns cannot express (an operator or form the Screenly predicate reference does not list, a window that ends before it starts) and playlists switched off are listed.",
    "Shared playlists from other workspaces and playlist transitions do not come over.",
  ],
  docs: [
    "https://developer.screenly.io/api_v4_1/",
    "https://www.screenly.io/docs/scheduling/advanced/predicates/",
    "https://www.screenly.io/docs/developers/overview/api-tokens/",
  ],
  example: "screenrig migrate scan --from screenly",
  async open(input) {
    const token = input.credentials.SCREENLY_API_TOKEN;
    const client = input.http.client({ base: BASE, auth: { Authorization: `Token ${token}` } });
    return new ScreenlySession(client, input.now);
  },
};
