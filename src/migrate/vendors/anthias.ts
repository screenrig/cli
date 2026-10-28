import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { CliError, usageError } from "../../problems.js";
import { vendorBadResponse, vendorRefused } from "../http.js";
import type { MediaKind, ReportEntry, SourceCatalog, SourceItem, SourceMedia, VendorAdapter, VendorClient, VendorSession } from "../types.js";

/**
 * Anthias (the open-source Screenly player): the device's own REST API, v2. Each
 * device holds its own assets and one loop, so a device becomes one playlist and
 * one waiting screen. Read against the project's API guide and OpenAPI schema
 * (see `docs`). Authentication is off by default; when it is on, HTTP Basic goes
 * to that device only.
 */

const NAME = "Anthias";
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const HEAD_LIMIT = 1 << 20;
const CONTENT_KEY = /"content"\s*:\s*"/;

interface AnthiasAsset {
  asset_id: string;
  name?: string | null;
  uri?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  duration?: number | null;
  mimetype?: string | null;
  is_enabled?: boolean;
  is_processing?: boolean;
  play_order?: number;
  play_days?: number[];
  play_time_from?: string | null;
  play_time_to?: string | null;
}

interface AnthiasSettings {
  player_name?: string;
  timezone?: string;
  default_duration?: number;
  shuffle_playlist?: boolean;
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

function joined(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function clock(value: string | null | undefined): string | undefined {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? "");
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]}` : undefined;
}

/** The device address without a trailing slash or an API prefix. */
function deviceBase(url: string | undefined): string {
  const base = (url ?? "").trim().replace(/\/+$/, "").replace(/\/api(\/v2)?$/i, "");
  try {
    const parsed = new URL(base);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw usageError("--url must be the address of the Anthias device, such as http://192.168.1.50.", {
      command: "screenrig migrate vendors anthias",
      reason: "Shows what Anthias takes and how to read it.",
    });
  }
  return base;
}

function nameOf(asset: AnthiasAsset): string {
  return (asset.name ?? "").trim() || `Asset ${asset.asset_id.slice(0, 8)}`;
}

/** Streams the base64 `content` of an asset envelope into `destination`, whatever the file's size. */
async function decodeEnvelope(envelope: string, destination: string): Promise<number> {
  const out = await open(destination, "wx", 0o600);
  let bytes = 0;
  try {
    let phase: "head" | "body" = "head";
    let head = "";
    let pending = "";
    let closed = false;
    for await (const chunk of createReadStream(envelope, { highWaterMark: 1 << 20 })) {
      let piece = (chunk as Buffer).toString("latin1");
      if (phase === "head") {
        head += piece;
        const found = CONTENT_KEY.exec(head);
        if (!found) {
          if (head.length > HEAD_LIMIT) throw vendorBadResponse(NAME, "an asset's content answer has no content field");
          continue;
        }
        const kind = /"type"\s*:\s*"([^"\\]*)"/.exec(head.slice(0, found.index))?.[1];
        if (kind !== "file") throw vendorBadResponse(NAME, "an asset's content answer is not a file");
        piece = head.slice(found.index + found[0].length);
        phase = "body";
        head = "";
      }
      const end = piece.indexOf('"');
      const data = pending + (end < 0 ? piece : piece.slice(0, end));
      const usable = end < 0 ? data.length - (data.length % 4) : data.length;
      const decoded = Buffer.from(data.slice(0, usable), "base64");
      if (decoded.length > 0) {
        await out.write(decoded);
        bytes += decoded.length;
      }
      pending = data.slice(usable);
      if (end >= 0) {
        closed = true;
        break;
      }
    }
    if (!closed || pending.length > 0) {
      throw vendorBadResponse(NAME, phase === "head" ? "an asset's content answer holds no file" : "an asset's content answer ended before its file did");
    }
    return bytes;
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    await out.close().catch(() => undefined);
  }
}

class AnthiasSession implements VendorSession {
  constructor(
    private readonly client: VendorClient,
    private readonly base: string,
    private readonly hasCredentials: boolean,
    private readonly now: () => Date,
  ) {}

  private async list(path: string): Promise<unknown> {
    try {
      return await this.client.json(path);
    } catch (error) {
      // An Anthias device with authentication on answers a request without credentials by redirecting to its sign-in page.
      if (!this.hasCredentials && error instanceof CliError && error.problem.code === "vendor_bad_response") {
        throw vendorRefused(NAME, 302, ["ANTHIAS_USERNAME", "ANTHIAS_PASSWORD"]);
      }
      throw error;
    }
  }

  async scan(): Promise<SourceCatalog> {
    const assets = await this.list("/api/v2/assets");
    if (!Array.isArray(assets)) throw vendorBadResponse(NAME, "the asset list is not an array");
    const settings = (await this.client.json<AnthiasSettings>("/api/v2/device_settings")) ?? {};
    const host = new URL(this.base).host;
    const device = (settings.player_name ?? "").trim() || host;
    const now = this.now().getTime();
    const defaultSeconds = typeof settings.default_duration === "number" && settings.default_duration > 0 ? settings.default_duration : undefined;

    const rows: AnthiasAsset[] = assets.map((row, index) => {
      if (!row || typeof row !== "object" || typeof (row as AnthiasAsset).asset_id !== "string" || (row as AnthiasAsset).asset_id === "") {
        throw vendorBadResponse(NAME, `assets[${index}].asset_id is missing`);
      }
      return row as AnthiasAsset;
    });
    rows.sort((a, b) => (a.play_order ?? 0) - (b.play_order ?? 0) || (a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0));

    const media: SourceMedia[] = [];
    const items: SourceItem[] = [];
    const notes: string[] = [];
    const notImported: ReportEntry[] = [];
    let endDates = 0;
    const skip = (kind: ReportEntry["kind"], asset: AnthiasAsset, reason: string, next?: string): void => {
      notImported.push({ kind, source_id: asset.asset_id, name: nameOf(asset), reason, ...(next ? { next } : {}) });
    };

    for (const asset of rows) {
      const name = nameOf(asset);
      const type = (asset.mimetype ?? "").toLowerCase();
      const web = type.includes("web");
      const stream = type.startsWith("stream");
      const kind: MediaKind | undefined = type.startsWith("image") ? "image" : type.startsWith("video") ? "video" : undefined;
      if (asset.is_enabled !== true) {
        skip(web || stream ? "item" : "media", asset, "It is switched off on the device.");
        continue;
      }
      const end = asset.end_date ? Date.parse(asset.end_date) : NaN;
      if (Number.isFinite(end) && end < now) {
        skip(web || stream ? "item" : "media", asset, "It has passed its end date.");
        continue;
      }
      const uri = (asset.uri ?? "").trim();
      const seconds = typeof asset.duration === "number" && asset.duration > 0 ? asset.duration : defaultSeconds;
      let item: SourceItem | undefined;
      if (stream) {
        skip("item", asset, "It is a live stream.", "Add the stream address as a stream page in a playlist.");
      } else if (web) {
        if (/^https?:\/\//i.test(uri)) item = { url: uri, title: name, ...(seconds !== undefined ? { duration_s: seconds } : {}) };
        else skip("item", asset, "Its address is not an http or https address.");
      } else if (kind === undefined) {
        skip("media", asset, "Its type is not image, video, webpage or streaming.");
      } else if (asset.is_processing === true) {
        skip("media", asset, "The device is still processing it.", "Run the same command again when the device has finished.");
      } else if (!uri.startsWith("/")) {
        skip("media", asset, "It plays from a web address, not from a file on the device.", "Upload the file with media upload, or add the address as a web page in a playlist.");
      } else {
        media.push({ id: asset.asset_id, name, filename: uri.split("/").pop() || name, kind, fetch: { asset: asset.asset_id }, original: true });
        item = { media_id: asset.asset_id, ...(kind === "image" && seconds !== undefined ? { duration_s: seconds } : {}) };
      }
      if (!item) continue;
      items.push(item);

      const start = asset.start_date ? Date.parse(asset.start_date) : NaN;
      if (Number.isFinite(start) && start > now) notes.push(`${name} was set to start on ${new Date(start).toISOString().slice(0, 10)}; it now plays at once.`);
      if (Number.isFinite(end)) endDates += 1;
      const days = Array.isArray(asset.play_days) ? [...new Set(asset.play_days)].filter((day) => day >= 1 && day <= 7).sort((a, b) => a - b) : [];
      if (days.length > 0 && days.length < 7) notes.push(`${name} played only on ${joined(days.map((day) => DAY_NAMES[day - 1]!))}; it now plays every day.`);
      const from = clock(asset.play_time_from);
      const to = clock(asset.play_time_to);
      if (from !== undefined && to !== undefined) notes.push(`${name} played only from ${from} to ${to}; it now plays all day.`);
    }
    if (endDates > 0) notes.push(`${endDates} item${endDates === 1 ? " had" : "s had"} an end date; ${endDates === 1 ? "it now stays" : "they now stay"} in the playlist until you remove ${endDates === 1 ? "it" : "them"}.`);

    const timezone = validZone(settings.timezone) ? settings.timezone : undefined;
    return {
      account: this.base.toLowerCase(),
      label: host,
      media,
      playlists: [{ id: "loop", name: `${device} loop`, items, ...(settings.shuffle_playlist === true ? { shuffle: true } : {}), notes }],
      layouts: [],
      groups: [],
      screens: [{ id: "device", name: device, group_ids: [], content: { playlist_id: "loop" }, ...(timezone ? { timezone } : {}), notes: [] }],
      schedules: [],
      not_imported: notImported,
      notes: [],
    };
  }

  async fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }> {
    const id = (media.fetch as { asset?: string } | undefined)?.asset;
    if (!id) throw vendorBadResponse(NAME, "a media entry has no asset id");
    const envelope = `${destination}.json`;
    try {
      await this.client.download(`/api/v2/assets/${encodeURIComponent(id)}/content`, envelope);
      return { bytes: await decodeEnvelope(envelope, destination) };
    } finally {
      await rm(envelope, { force: true });
    }
  }
}

export const anthias: VendorAdapter = {
  id: "anthias",
  name: NAME,
  inputs: { url: "required" },
  credentials: [
    { env: "ANTHIAS_USERNAME", secret: false, required: false, help: "The device's operator name, only when authentication is on." },
    { env: "ANTHIAS_PASSWORD", secret: true, required: false, help: "The device's operator password, only when authentication is on." },
  ],
  connect: [
    "Use the device's address, such as http://192.168.1.50 (the same address you open in a browser).",
    "A new Anthias install has authentication off: no username or password is needed.",
    "With authentication on, put the operator ANTHIAS_USERNAME and ANTHIAS_PASSWORD in a file and pass it with --credentials. Both go to that device only.",
  ],
  maps: [
    "The enabled loop, in play order, becomes one playlist; image and video files become media, web pages become web page items, and the shuffle setting is kept as a note.",
    "The device becomes one waiting screen named after its player name, with its time zone and the loop as its content.",
  ],
  skips: [
    "Switched-off and expired assets, live streams, assets that play from a remote file address, and assets still processing are listed.",
    "An asset's start date, weekdays and daily hours come over as plays-always, and each is listed.",
    "The backup archive is not read: the API lists the same content.",
  ],
  docs: [
    "https://github.com/Screenly/Anthias/blob/master/website/content/agents.md",
    "https://github.com/Screenly/Anthias/blob/master/website/data/openapi.json",
  ],
  example: "screenrig migrate scan --from anthias --url http://192.168.1.50",
  async open(input) {
    const base = deviceBase(input.url);
    const user = input.credentials.ANTHIAS_USERNAME;
    const password = input.credentials.ANTHIAS_PASSWORD;
    if ((user === undefined) !== (password === undefined)) {
      throw usageError("Anthias needs both ANTHIAS_USERNAME and ANTHIAS_PASSWORD, or neither.", {
        command: "screenrig migrate vendors anthias",
        reason: "Shows what Anthias takes and where each value goes.",
      });
    }
    const client = input.http.client({
      base,
      ...(user !== undefined && password !== undefined ? { auth: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } } : {}),
    });
    return new AnthiasSession(client, base, user !== undefined, input.now);
  },
};
