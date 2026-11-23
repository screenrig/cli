// `app releases` and `app use-release`: an application's releases, and pinning every placement to one of them.
import { requireToken } from "./client.js";
import { flagBool, flagString } from "./command-input.js";
import { clientFor, commandHandler, jsonBody } from "./commands.js";
import type { Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { usageError } from "./problems.js";
import { plainText } from "./reviews.js";
import { table } from "./webhooks.js";

/** ApplicationRelease (vendor/openapi.yaml): one immutable upload of an application. */
export interface ApplicationReleaseRow {
  id: string;
  state: "publishing" | "ready" | "failed";
  latest: boolean;
  created_at: string;
  ready_at?: string;
  error_code?: string;
  compressed_bytes: number;
  expanded_bytes?: number;
  placements: number;
  expires_at?: string;
  actor?: { display_name?: string };
  agent?: { name?: string };
}
export interface ApplicationReleasePage { items: ApplicationReleaseRow[]; next_cursor?: string | null }

/** ApplicationReleaseUse: what pinning every placement to one release changed, or would change, per playlist. */
export interface ApplicationReleaseUse {
  release_id: string;
  dry_run: boolean;
  already: number;
  screens: number;
  playlists: Array<{
    playlist_id: string;
    playlist_name: string;
    placements: number;
    screen_count: number;
    outcome: "would_change" | "applied" | "unchanged" | "refused";
    revision?: number;
    problem?: { code: string; detail: string };
  }>;
}

const releasesPath = (id: string) => `/api/applications/${encodeURIComponent(id)}/releases`;

function senderText(row: ApplicationReleaseRow): string {
  const name = row.agent?.name ?? row.actor?.display_name;
  return name ? plainText(name) : "-";
}

function stateText(row: ApplicationReleaseRow): string {
  return `${row.state}${row.latest ? " (latest)" : ""}${row.error_code ? ` ${plainText(row.error_code)}` : ""}`;
}

/** The human page of `app releases`: one row per release, the newest first, and the command that reads the next page. */
export function applicationReleaseLines(applicationId: string, page: ApplicationReleasePage | undefined): string[] {
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  return [
    `Application ${applicationId} releases (${items.length})`,
    ...(items.length
      ? table(["RELEASE", "STATE", "PLACEMENTS", "BYTES", "BY", "CREATED", "EXPIRES"], items.map((item) => [
        item.id, stateText(item), String(item.placements), String(item.expanded_bytes ?? item.compressed_bytes),
        senderText(item), item.created_at, item.expires_at ?? "",
      ]))
      : ["No releases"]),
    ...(next ? [`next: screenrig app releases ${applicationId} --cursor ${next}`] : []),
  ];
}

export const handleAppReleases = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("app releases requires <id>.");
  const limit = flagString(args.flags, "limit");
  const cursor = flagString(args.flags, "cursor");
  if (limit !== undefined && (Number(limit) < 1 || Number(limit) > 100)) throw usageError("--limit must be 1 to 100.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // --limit or --cursor asks for one page; otherwise every page is read, so the list is never silently cut.
  const response = limit !== undefined || cursor !== undefined
    ? await client.call({ method: "GET", path: releasesPath(id), query: { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) } })
    : await client.listAll(releasesPath(id), undefined, { cursorParam: "cursor" });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: applicationReleaseLines(id, response.body as ApplicationReleasePage | undefined).join("\n"),
  };
}, true);

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** The human answer of `app use-release`: totals first, then every playlist that was refused, with its problem. */
export function applicationReleaseUseLines(applicationId: string, answer: ApplicationReleaseUse): string[] {
  const playlists = Array.isArray(answer.playlists) ? answer.playlists : [];
  const of = (outcome: string) => playlists.filter((playlist) => playlist.outcome === outcome);
  const refused = of("refused");
  const applied = of("applied");
  const unchanged = of("unchanged");
  const pending = of("would_change");
  const screens = `${count(answer.screens, "screen")}`;
  const lines = answer.dry_run
    ? [
      `Preview: ${answer.release_id} would replace the release of ${applicationId} in ${count(pending.length, "playlist")} (${screens})`,
      ...(answer.already > 0 ? [`already on ${answer.release_id}: ${count(answer.already, "placement")}`] : []),
    ]
    : [
      `${applicationId} moved to ${answer.release_id}: ${applied.length} applied, ${unchanged.length} unchanged, ${refused.length} refused (${screens})`,
      ...(answer.already > 0 ? [`already on ${answer.release_id}: ${count(answer.already, "placement")}`] : []),
    ];
  const rows = playlists.filter((playlist) => playlist.outcome !== "unchanged");
  if (rows.length) {
    lines.push(...table(["PLAYLIST", "NAME", "PLACEMENTS", "SCREENS", "OUTCOME"], rows.map((playlist) => [
      playlist.playlist_id, plainText(playlist.playlist_name), String(playlist.placements), String(playlist.screen_count),
      playlist.outcome === "applied" && playlist.revision !== undefined ? `applied (revision ${playlist.revision})` : playlist.outcome,
    ])));
  }
  for (const playlist of refused) {
    lines.push(`refused ${playlist.playlist_id}: ${playlist.problem?.code ?? "refused"}: ${plainText(playlist.problem?.detail ?? "")}`.trimEnd());
  }
  return lines;
}

export const handleAppUseRelease = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const releaseId = args.positionals[3];
  if (!id || !releaseId) throw usageError("app use-release requires <id> <release_id>.");
  const apply = flagBool(args.flags, "apply");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // The preview writes nothing; the apply carries an idempotency key, so an interrupted rerun repeats the same write.
  const response = await client.call({
    method: "POST", path: `${releasesPath(id)}/${encodeURIComponent(releaseId)}/use`,
    body: { dry_run: !apply }, idempotent: apply,
  });
  const answer = response.body as ApplicationReleaseUse;
  const playlists = Array.isArray(answer?.playlists) ? answer.playlists : [];
  const refused = playlists.filter((playlist) => playlist.outcome === "refused");
  const base = `screenrig app use-release ${id} ${releaseId}`;
  const next = !apply
    ? (playlists.some((playlist) => playlist.outcome === "would_change")
      ? { command: `${base} --apply`, reason: "Pins every placement of the application to this release." }
      : undefined)
    : refused.length
      ? { command: `${base} --apply`, reason: "Retries the refused playlists; the ones already moved are skipped. Fix what each problem names first." }
      : undefined;
  const warnings: Warning[] = refused.length
    ? [{ code: "playlists_refused", message: `${count(refused.length, "playlist")} not moved to ${releaseId}: ${refused.map((playlist) => playlist.playlist_id).join(", ")}.` }]
    : [];
  return {
    envelope: jsonBody(response, client.requestId, next ? { next } : undefined, warnings),
    exitCode: ExitCode.Success,
    human: [...applicationReleaseUseLines(id, answer), ...(next ? [`next: ${next.command}`] : [])].join("\n"),
  };
}, true);
