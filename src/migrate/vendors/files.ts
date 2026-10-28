import { sniffMediaContainer } from "../../media/sniff.js";
import { usageError } from "../../problems.js";
import { csvTable } from "../csv.js";
import { baseName, type LocalEntry, type LocalFiles } from "../local-files.js";
import type { ReportEntry, SourceCatalog, SourceGroup, SourceItem, SourceMedia, SourcePlaylist, SourceScreen, VendorAdapter, VendorSession } from "../types.js";

/**
 * The fallback for any signage system: a folder or .zip of media with an optional
 * playlists.csv and screens.csv at its root. It reads nothing but those files.
 */

const COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const PLAYLIST_COLUMNS = {
  playlist: [],
  file: ["filename", "path"],
  duration: ["seconds"],
  order: ["position"],
} as const;

const SCREEN_COLUMNS = {
  name: [],
  group: ["groups", "tags"],
  playlist: [],
  timezone: [],
} as const;

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function stemOf(filename: string): string {
  return filename.replace(/\.[A-Za-z0-9]{1,8}$/, "") || filename;
}

function folderOf(entryPath: string): string {
  const cut = entryPath.lastIndexOf("/");
  return cut < 0 ? "" : entryPath.slice(0, cut);
}

/** A name that has not been used: the second use of "Lobby" is "Lobby (2)". */
function uniquely(name: string, used: Set<string>): string {
  let candidate = name;
  for (let n = 2; used.has(candidate); n += 1) candidate = `${name} (${n})`;
  used.add(candidate);
  return candidate;
}

class FilesSession implements VendorSession {
  constructor(private readonly files: LocalFiles) {}

  async scan(): Promise<SourceCatalog> {
    const notImported: ReportEntry[] = [];
    const notes: string[] = [];
    const entries = this.files.entries();
    const rootCsv = (name: string): LocalEntry | undefined => entries.find((entry) => entry.path.toLowerCase() === name);
    const playlistsCsv = rootCsv("playlists.csv");
    const screensCsv = rootCsv("screens.csv");

    const media: SourceMedia[] = [];
    for (const entry of entries) {
      if (entry === playlistsCsv || entry === screensCsv) continue;
      const name = baseName(entry.path);
      if (entry.unreadable) {
        notImported.push({ kind: "file", source_id: entry.path, name, reason: entry.unreadable });
        continue;
      }
      const sniffed = sniffMediaContainer(await this.files.head(entry));
      if (!sniffed) {
        notImported.push({ kind: "file", source_id: entry.path, name, reason: "It is not an image, video or audio file." });
        continue;
      }
      media.push({ id: entry.path, name: stemOf(name), filename: name, kind: sniffed.kind, bytes: entry.bytes, fetch: { entry: entry.path }, original: true });
    }

    const byPath = new Map(media.map((item) => [item.id.toLowerCase(), item]));
    const byName = new Map<string, SourceMedia[]>();
    for (const item of media) byName.set(item.filename.toLowerCase(), [...(byName.get(item.filename.toLowerCase()) ?? []), item]);
    const resolve = (cell: string): SourceMedia | "many" | undefined => {
      const exact = byPath.get(cell.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase());
      if (exact) return exact;
      const named = byName.get(baseName(cell).toLowerCase()) ?? [];
      return named.length === 1 ? named[0] : named.length > 1 ? "many" : undefined;
    };

    const playlists: SourcePlaylist[] = [];
    if (playlistsCsv) {
      const table = csvTable((await this.files.read(playlistsCsv)).toString("utf8"), PLAYLIST_COLUMNS, { label: "playlists.csv", required: ["playlist", "file"] });
      const grouped = new Map<string, Array<{ item: SourceItem; order: number; row: number }>>();
      for (const { row, values } of table.rows) {
        const playlist = values.playlist ?? "";
        const file = values.file ?? "";
        if (!playlist && !file) continue;
        const entry: ReportEntry = { kind: "item", source_id: `playlists.csv row ${row}`, name: file || "(no file)", reason: "" };
        if (!playlist) {
          notImported.push({ ...entry, reason: "The row has no playlist name." });
          continue;
        }
        if (!grouped.has(playlist)) grouped.set(playlist, []);
        if (!file) {
          notImported.push({ ...entry, reason: "The row has no file." });
          continue;
        }
        const found = resolve(file);
        if (found === undefined) {
          notImported.push({ ...entry, reason: "No such media file was found in --files.", next: "Add the file to the folder or zip and rerun migrate scan, or correct the name in playlists.csv." });
          continue;
        }
        if (found === "many") {
          notImported.push({ ...entry, reason: "More than one file has this name; give its path from the root of --files.", next: "Write the file's path in playlists.csv and rerun migrate scan." });
          continue;
        }
        const seconds = values.duration === undefined || values.duration === "" ? undefined : Number(values.duration);
        if (seconds !== undefined && !(seconds > 0)) notes.push(`playlists.csv row ${row}: the duration "${values.duration}" is not a number of seconds; the default is used.`);
        const order = values.order === undefined || values.order === "" ? undefined : Number(values.order);
        grouped.get(playlist)!.push({
          item: { media_id: found.id, ...(seconds !== undefined && seconds > 0 ? { duration_s: seconds } : {}) },
          order: order !== undefined && Number.isFinite(order) ? order : row,
          row,
        });
      }
      for (const [name, rows] of grouped) {
        rows.sort((a, b) => a.order - b.order || a.row - b.row);
        playlists.push({ id: name, name, items: rows.map((row) => row.item), notes: [] });
      }
    } else {
      const folders = new Map<string, SourceMedia[]>();
      for (const item of media) folders.set(folderOf(item.id), [...(folders.get(folderOf(item.id)) ?? []), item]);
      for (const [folder, list] of [...folders].sort(([a], [b]) => COLLATOR.compare(a, b))) {
        const name = folder === "" ? this.files.label : folder.split("/").join(" / ");
        const ordered = [...list].sort((a, b) => COLLATOR.compare(a.filename, b.filename) || COLLATOR.compare(a.id, b.id));
        playlists.push({ id: folder === "" ? "(root)" : folder, name, items: ordered.map((item): SourceItem => ({ media_id: item.id })), notes: [] });
      }
    }

    const groups: SourceGroup[] = [];
    const screens: SourceScreen[] = [];
    if (screensCsv) {
      const table = csvTable((await this.files.read(screensCsv)).toString("utf8"), SCREEN_COLUMNS, { label: "screens.csv", required: ["name"] });
      const groupByName = new Map<string, SourceGroup>();
      const used = new Set<string>();
      const playlistByName = (cell: string): SourcePlaylist | undefined => {
        const wanted = cell.trim().toLowerCase();
        const exact = playlists.find((playlist) => playlist.name.toLowerCase() === wanted || playlist.id.toLowerCase() === wanted);
        if (exact) return exact;
        const tail = playlists.filter((playlist) => (playlist.name.split(" / ").pop() ?? "").toLowerCase() === wanted);
        return tail.length === 1 ? tail[0] : undefined;
      };
      for (const { row, values } of table.rows) {
        const name = values.name ?? "";
        if (!name) {
          if (Object.values(values).some((value) => value)) notImported.push({ kind: "screen", source_id: `screens.csv row ${row}`, name: "(no name)", reason: "The row has no name." });
          continue;
        }
        const screenNotes: string[] = [];
        const groupIds: string[] = [];
        for (const cell of (values.group ?? "").split(";").map((part) => part.trim()).filter(Boolean)) {
          let group = groupByName.get(cell.toLowerCase());
          if (!group) {
            group = { id: cell, name: cell };
            groupByName.set(cell.toLowerCase(), group);
            groups.push(group);
          }
          if (!groupIds.includes(group.id)) groupIds.push(group.id);
        }
        let content: SourceScreen["content"];
        if (values.playlist) {
          const playlist = playlistByName(values.playlist);
          if (playlist) content = { playlist_id: playlist.id };
          else screenNotes.push(`The playlist "${values.playlist}" is not among the playlists, so it has no default playlist.`);
        }
        let timezone: string | undefined;
        if (values.timezone) {
          if (validZone(values.timezone)) timezone = values.timezone;
          else screenNotes.push(`The time zone "${values.timezone}" is not an IANA name such as America/Toronto, so none is set.`);
        }
        screens.push({ id: uniquely(name, used), name, group_ids: groupIds, ...(content ? { content } : {}), ...(timezone ? { timezone } : {}), notes: screenNotes });
      }
    }

    return { account: "files", label: this.files.label, media, playlists, layouts: [], groups, screens, schedules: [], not_imported: notImported, notes };
  }

  async fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }> {
    const entry = this.files.entries().find((candidate) => candidate.path === (media.fetch as { entry?: string } | undefined)?.entry);
    if (!entry) throw usageError(`${media.filename} is no longer in --files. Put it back and run the same command again.`);
    return this.files.extract(entry, destination);
  }
}

export const files: VendorAdapter = {
  id: "files",
  name: "Files",
  inputs: { files: "required", timezone: true },
  credentials: [],
  connect: [
    "Put the media in one folder, or one .zip: images, video and audio, in folders if you like.",
    "Optional: playlists.csv at the root with columns playlist, file, duration (seconds) and order.",
    "Optional: screens.csv at the root with columns name, group (separate several with ;), playlist and timezone.",
  ],
  maps: [
    "Each image, video and audio file becomes media, found by what is in the file, not its extension.",
    "playlists.csv rows become playlists, in order; without it each folder that holds media becomes a playlist in natural file-name order, and files at the root form a playlist named after the folder or zip.",
    "screens.csv rows become one waiting screen each, with their groups as tags, their playlist and their time zone.",
  ],
  skips: [
    "Files that are not images, video or audio, and zip entries that are encrypted, are listed.",
    "There are no schedules: create them with campaign create once the playlists exist.",
  ],
  docs: ["https://datatracker.ietf.org/doc/html/rfc4180"],
  example: "screenrig migrate scan --from files --files ./signage-media",
  async open(input) {
    if (!input.files) throw usageError("--from files needs --files PATH: a folder or a .zip of media.");
    return new FilesSession(input.files);
  },
};
