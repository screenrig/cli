import type { LocalFiles } from "./local-files.js";

export type { LocalEntry, LocalFiles } from "./local-files.js";

export type MediaKind = "image" | "video" | "audio";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface SourceMedia {
  id: string;
  name: string;
  filename: string;
  kind: MediaKind;
  bytes?: number;
  /** The adapter's reference for fetchMedia; absent when the API has no file to hand out. */
  fetch?: unknown;
  /** False when the API copy is a derivative (a vendor's video transcode). */
  original: boolean;
}

export type SourceItem =
  | { media_id: string; duration_s?: number }
  /** A web page: becomes an iframe page. */
  | { url: string; duration_s?: number; title?: string }
  /** Inlined by the mapper. */
  | { playlist_id: string }
  | { layout_id: string };

export interface SourcePlaylist {
  id: string;
  name: string;
  items: SourceItem[];
  shuffle?: boolean;
  notes: string[];
}

export interface SourceZone {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  items: SourceItem[];
}

export interface SourceLayout {
  id: string;
  name: string;
  width?: number;
  height?: number;
  zones: SourceZone[];
  notes: string[];
}

export interface SourceGroup {
  id: string;
  name: string;
}

export interface SourceScreen {
  id: string;
  name: string;
  group_ids: string[];
  content?: { playlist_id: string } | { layout_id: string };
  timezone?: string;
  notes: string[];
}

export interface SourceSchedule {
  id: string;
  name: string;
  targets: { group_ids: string[]; screen_ids: string[] };
  content: { playlist_id: string } | { layout_id: string };
  always?: boolean;
  /** Civil YYYY-MM-DDTHH:MM of the first occurrence. */
  start?: string;
  end?: string;
  /** The zone the civil times were read in. Report only. */
  timezone?: string;
  repeat?: {
    every: "day" | "week" | "month" | "year" | "hour" | "minute";
    interval?: number;
    weekdays?: Weekday[];
    /** YYYY-MM-DD, inclusive. */
    until?: string;
    count?: number;
    nth_weekday?: boolean;
  };
  /** 0 to 100. */
  priority: number;
  notes: string[];
}

export interface ReportEntry {
  kind: "media" | "playlist" | "layout" | "schedule" | "group" | "screen" | "item" | "file";
  source_id: string;
  name: string;
  reason: string;
  next?: string;
}

export interface SourceCatalog {
  /** Stable per source account: the Xibo or Anthias origin, a workspace id, `files`. */
  account: string;
  label: string;
  media: SourceMedia[];
  playlists: SourcePlaylist[];
  layouts: SourceLayout[];
  groups: SourceGroup[];
  screens: SourceScreen[];
  schedules: SourceSchedule[];
  not_imported: ReportEntry[];
  notes: string[];
}

/** One HTTP request the vendor transport made, for the operation log: never a URL, header or body. */
export interface VendorRequestLog {
  vendor: string;
  method: string;
  status: number;
  ms: number;
}

export interface VendorRequestInit {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface VendorResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

export interface VendorClient {
  /** The vendor's base origin, which is the only origin that receives its credential. */
  readonly origin: string;
  /** GET (default) or another method on a path under the base; the body must be JSON. */
  json<T = unknown>(path: string, init?: VendorRequestInit): Promise<T>;
  /** Like json, with the status and lower-cased headers (a total count header, say). */
  response<T = unknown>(path: string, init?: VendorRequestInit): Promise<VendorResponse<T>>;
  /** POSTs to the base itself and returns `data`; an errors array is refused or a bad response. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** Writes the body to `destination` (created exclusively, mode 0600). Auth goes along only to the base origin. */
  download(url: string, destination: string): Promise<{ bytes: number }>;
  /** Replaces the headers sent to the base origin (a renewed bearer token), or removes them. */
  setAuth(headers: Record<string, string> | undefined): void;
}

export interface VendorClientOptions {
  base: string;
  auth?: Record<string, string>;
  /** At most `requests` requests in any `perMs` window, shared by every request of this client. */
  rate?: { requests: number; perMs: number };
}

export interface VendorHttp {
  client(options: VendorClientOptions): VendorClient;
}

export interface VendorSession {
  scan(): Promise<SourceCatalog>;
  fetchMedia(media: SourceMedia, destination: string): Promise<{ bytes: number }>;
}

export interface VendorCredential {
  env: string;
  secret: boolean;
  required: boolean;
  help: string;
}

export interface VendorOpenInput {
  url?: string;
  region?: string;
  timezone?: string;
  credentials: Readonly<Record<string, string>>;
  http: VendorHttp;
  files?: LocalFiles;
  now: () => Date;
}

export interface VendorAdapter {
  id: string;
  name: string;
  inputs: { url?: "required" | "optional"; regions?: readonly string[]; timezone?: boolean; files?: "required" | "optional" };
  credentials: readonly VendorCredential[];
  /** How the person makes a read-only key. */
  connect: readonly string[];
  maps: readonly string[];
  skips: readonly string[];
  docs: readonly string[];
  /** A working `screenrig migrate scan` command line. */
  example: string;
  open(input: VendorOpenInput): Promise<VendorSession>;
}
