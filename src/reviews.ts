import type { AccessLevel, AccessLimitedBy, Review, ReviewList, ReviewMediaChange, ReviewMediaFields, ReviewMediaPlaylist, ReviewPending, ReviewPlaylistChange, ReviewSummary } from "./adapters/protocol.js";
import type { ProblemNext, Warning } from "./envelope.js";
import { accessLabel } from "./oauth.js";
import { unexpectedResponseError, usageError } from "./problems.js";

/**
 * Reviews. Under Propose access a review-class write (playlist create and
 * update; screen assign, playlist schedule, takeover, and those fleet actions)
 * answers HTTP 202 `pending_review`: the change waits for a person to approve
 * it in the dashboard and is not on glass. That answer is a success.
 */

/** The proposer's note on a review-class write. Ignored when the write applies live. */
export const REVIEW_NOTE_HEADER = "screenrig-review-note";
export const REVIEW_NOTE_MAX = 280;
/** A reject reason or requested changes. */
export const DECISION_NOTE_MAX = 500;

/** Plain text of 1 to max characters after trimming, without control characters or invalid Unicode. */
function plainNote(value: string, flag: string, max: number): string {
  const note = value.trim();
  const scalars = [...note];
  if (!note || scalars.length > max || /\p{Cc}/u.test(note)
    || scalars.some((char) => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) {
    throw usageError(`${flag} takes plain text of 1 to ${max} characters, without control characters.`);
  }
  return note;
}

/** --note on a review-class write: the note a person reads beside the proposed change. */
export function reviewNote(value: string): string {
  return plainNote(value, "--note", REVIEW_NOTE_MAX);
}

/** --note on a decision: the changes a seller asks the buyer for. */
export function decisionNote(value: string): string {
  return plainNote(value, "--note", DECISION_NOTE_MAX);
}

/**
 * The note header. Header values are ASCII here: the note travels
 * percent-encoded as UTF-8 (encodeURIComponent), and the server decodes it.
 */
export function reviewNoteHeaders(note: string | undefined): Record<string, string> {
  return note === undefined ? {} : { [REVIEW_NOTE_HEADER]: encodeURIComponent(note) };
}

/**
 * The review a 202 answer opened, or undefined when the write applied live.
 * POST /api/screens/actions also answers 202 for a fleet continuation page;
 * only `status: "pending_review"` marks a review.
 */
export function pendingReviewOf(response: { status: number; body: unknown }): ReviewPending | undefined {
  if (response.status !== 202) return undefined;
  const body = response.body as Partial<ReviewPending> | undefined;
  if (!body || typeof body !== "object" || body.status !== "pending_review") return undefined;
  const review = body.review as Partial<ReviewSummary> | undefined;
  if (!review || typeof review.id !== "string" || !review.id || typeof review.url !== "string" || !review.url
    || typeof review.kind !== "string" || !review.subject || typeof review.subject.id !== "string") {
    throw unexpectedResponseError("A pending_review answer does not match the generated ReviewPending contract.", undefined,
      "The write may have become a review. List reviews with screenrig reviews list before writing again.");
  }
  return body as ReviewPending;
}

export function reviewNext(id: string): ProblemNext {
  return { command: `screenrig reviews show ${id}`, argv: ["reviews", "show", id], reason: "Check the decision after the person reviews it." };
}

export function pendingReviewWarning(review: Pick<ReviewSummary, "url">): Warning {
  return { code: "pending_review", message: `Waiting for a person to approve: ${review.url}` };
}

export const PENDING_REVIEW_SENTENCE = "Nothing changes on glass until a person approves it; they can also reject it or ask for changes. Do not repeat the write: check the decision later.";

/** Server text in a terminal: control characters (escape sequences, line breaks) become spaces. */
export function plainText(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

const KIND_LABELS: Record<string, string> = {
  playlist_change: "Playlist change",
  screen_change: "Screen change",
  ad_creative: "Ad creative",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/**
 * A selector_refresh review approves one pending media item (subject type
 * media): a new upload, or a change of approved media's tags or folder
 * (media_change.before is what was last approved).
 */
function reviewLabel(review: Pick<Review, "kind" | "subject" | "playlist_change">): string {
  if (review.subject?.type !== "media") return kindLabel(review.kind);
  return review.playlist_change?.media_change?.before ? "Media change" : "New media";
}

function subjectText(subject: Review["subject"] | undefined): string | undefined {
  if (!subject) return undefined;
  return `${subject.type} ${plainText(subject.name)} (${subject.id})`;
}

function screensText(count: number): string {
  return `${count} screen${count === 1 ? "" : "s"}`;
}

/** Human lines for a write that became a review. */
export function pendingReviewLines(review: ReviewSummary): string[] {
  return [
    `${kindLabel(review.kind)} waiting for review`,
    `review_id: ${review.id}`,
    ...(review.subject ? [`subject: ${subjectText(review.subject)}`] : []),
    ...(typeof review.impact?.screens === "number" ? [`impact: approving changes ${screensText(review.impact.screens)}`] : []),
    `url: ${review.url}`,
    `next: screenrig reviews show ${review.id}`,
    PENDING_REVIEW_SENTENCE,
  ];
}

function proposerText(proposer: Review["proposer"] | undefined): string | undefined {
  if (!proposer) return undefined;
  const who = proposer.kind === "agent" ? `agent ${plainText(proposer.agent_name ?? proposer.agent_id ?? "")}`
    : proposer.kind === "client" ? `service client ${plainText(proposer.client_name ?? proposer.client_id ?? "")}`
    : `buyer ${plainText(proposer.organization_name ?? proposer.project_id ?? "")}`;
  return proposer.person ? `${who.trim()}, for ${plainText(proposer.person.name)}` : who.trim();
}

function deciderText(review: Review): string | undefined {
  const by = review.decided_by;
  const name = by ? plainText(by.name ?? by.agent_name ?? by.user_id ?? by.agent_id ?? "") : "";
  if (!review.decided_at && !name) return undefined;
  return [review.state, name ? `by ${name}` : "", review.decided_at ? `at ${review.decided_at}` : ""].filter(Boolean).join(" ");
}

function count(items: string[] | undefined): number {
  return Array.isArray(items) ? items.length : 0;
}

/** One line from a playlist change's diff, such as "pages: 2 changed, 1 added; soundtrack unchanged". */
export function playlistChangeText(change: NonNullable<Review["playlist_change"]>): string {
  const diff = change.diff;
  const operation = change.operation === "create" ? "new playlist"
    : change.operation === "selector_refresh"
      ? `${change.media_change?.before ? "changed tags or folder of approved media" : "new media"} for the tag, folder or all selectors of approved playlists`
    : `update of revision ${change.base_revision}`;
  if (!diff) return operation;
  const pages = [
    count(diff.pages_changed) ? `${count(diff.pages_changed)} changed` : "",
    count(diff.pages_added) ? `${count(diff.pages_added)} added` : "",
    count(diff.pages_removed) ? `${count(diff.pages_removed)} removed` : "",
  ].filter(Boolean);
  const media = [
    count(diff.media_added) ? `${count(diff.media_added)} added` : "",
    count(diff.media_removed) ? `${count(diff.media_removed)} removed` : "",
  ].filter(Boolean);
  return [
    operation,
    pages.length ? `pages ${pages.join(", ")}` : "pages unchanged",
    ...(diff.name_changed ? ["name changed"] : []),
    diff.soundtrack_changed ? "soundtrack changed" : "soundtrack unchanged",
    ...(media.length ? [`media ${media.join(", ")}`] : []),
  ].join("; ");
}

const SCREEN_ACTION_LABELS: Record<string, string> = {
  assign: "assign a playlist",
  set_playlist_schedule: "set the playlist schedule",
  clear_playlist_schedule: "clear the playlist schedule",
  takeover: "take over",
  takeover_clear: "clear the takeover",
};

function screenChangeLines(change: NonNullable<Review["screen_change"]>): string[] {
  const screens = change.screens ?? { count_at_request: 0 };
  const target = screens.tag !== undefined ? `tag ${plainText(screens.tag)}`
    : Array.isArray(screens.ids) ? screens.ids.join(", ") : undefined;
  const result = change.result;
  return [
    `action: ${SCREEN_ACTION_LABELS[change.action] ?? change.action}`,
    ...(target ? [`screens: ${target} (${screensText(screens.count_at_request ?? 0)} when proposed)`] : []),
    ...(Array.isArray(change.playlist_ids) && change.playlist_ids.length ? [`playlists: ${change.playlist_ids.join(", ")}`] : []),
    ...(result ? [`result: ${result.matched} matched, ${result.succeeded} succeeded, ${result.failed} failed${result.applying ? "; still applying to the rest" : ""}`] : []),
  ];
}

/**
 * previously_rejected_media: pending media this playlist review names whose
 * latest media review a person rejected. Approving the playlist approves it.
 */
function previouslyRejectedText(change: ReviewPlaylistChange | undefined): string | undefined {
  const listed = change?.previously_rejected_media;
  const ids = Array.isArray(listed) ? listed.filter((id) => typeof id === "string" && id) : [];
  if (!ids.length) return undefined;
  return `${ids.join(", ")} ${ids.length === 1 ? "was" : "were"} rejected before`;
}

function tagList(tags: string[] | undefined): string {
  return Array.isArray(tags) && tags.length ? tags.map(plainText).join(", ") : "none";
}

function folderText(folderId: string | undefined): string {
  return folderId ? `folder ${plainText(folderId)}` : "library root";
}

function sameTags(a: string[] | undefined, b: string[] | undefined): boolean {
  const left = [...(a ?? [])].sort(), right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

/**
 * A media review's change: "new upload; tags Lobby; library root", or
 * "tags Lobby → Cafe; folder fld_A unchanged" for approved media.
 */
export function mediaChangeText(change: ReviewMediaChange): string {
  const after: Partial<ReviewMediaFields> = change.after ?? {};
  if (!change.before) return `new upload; tags ${tagList(after.tags)}; ${folderText(after.folder_id)}`;
  const before = change.before;
  const tags = sameTags(before.tags, after.tags) ? `tags ${tagList(after.tags)} unchanged` : `tags ${tagList(before.tags)} → ${tagList(after.tags)}`;
  const folder = (before.folder_id ?? "") === (after.folder_id ?? "") ? `${folderText(after.folder_id)} unchanged` : `${folderText(before.folder_id)} → ${folderText(after.folder_id)}`;
  return `${tags}; ${folder}`;
}

/**
 * One approved playlist, or open playlist proposal, whose selection approving
 * the review changes, with the screens showing it and the media it starts and
 * stops playing.
 */
function mediaPlaylistText(playlist: ReviewMediaPlaylist): string {
  const ids = (list: string[] | undefined) => (Array.isArray(list) ? list.filter((id) => typeof id === "string" && id) : []);
  const added = ids(playlist.media_added), removed = ids(playlist.media_removed);
  const changes = [
    ...(added.length ? [`starts playing ${added.join(", ")}`] : []),
    ...(removed.length ? [`stops playing ${removed.join(", ")}`] : []),
  ];
  return `${plainText(playlist.name)} (${playlist.id}, ${screensText(playlist.screens)})${changes.length ? `: ${changes.join("; ")}` : ""}`;
}

/** Human detail of one review (reviews show, withdraw). */
export function reviewDetailLines(review: Review): string[] {
  // A list value prints as indented lines under its key.
  const fields: Array<[string, string | string[] | undefined]> = [
    ["subject", subjectText(review.subject)],
    ["proposed_by", proposerText(review.proposer)],
    ["note", review.note === undefined ? undefined : plainText(review.note)],
    ["created_at", review.created_at],
    ["decision", deciderText(review)],
    ["decision_note", review.decision_note === undefined ? undefined : plainText(review.decision_note)],
    ["impact", typeof review.impact?.screens === "number" ? `approving changes ${screensText(review.impact.screens)}` : undefined],
    ["change", review.playlist_change ? playlistChangeText(review.playlist_change) : undefined],
    ["media_change", review.playlist_change?.media_change ? mediaChangeText(review.playlist_change.media_change) : undefined],
    ["applied_revision", review.playlist_change?.applied_revision === undefined ? undefined : String(review.playlist_change.applied_revision)],
    ["creative", review.ad_creative ? `${review.ad_creative.creative_id} revision ${review.ad_creative.creative_revision}` : undefined],
    ["media_playlists", review.playlist_change?.media_playlists?.length ? review.playlist_change.media_playlists.map(mediaPlaylistText) : undefined],
    ...(review.blockers?.length
      ? [["blockers", review.blockers.map((blocker) => `${blocker.id} ${blocker.state} (${subjectText(blocker.subject) ?? "-"})`).join("; ")] as [string, string]]
      : [["blocked_by", review.blocked_by?.length ? review.blocked_by.join(", ") : undefined] as [string, string | undefined]]),
    ["dependents", review.dependents?.length ? review.dependents.join(", ") : undefined],
    ["previously_rejected_media", previouslyRejectedText(review.playlist_change)],
    ["previous_review_id", review.previous_review_id],
    ["superseded_by", review.superseded_by],
    ["url", review.url],
  ];
  return [
    `Review ${review.id}: ${reviewLabel(review)}, ${review.state}`,
    ...fields.flatMap(([key, value]) => Array.isArray(value) ? [`${key}:`, ...value.map((line) => `  ${line}`)] : value ? [`${key}: ${value}`] : []),
    ...(review.screen_change ? screenChangeLines(review.screen_change) : []),
  ];
}

/** Human rows of one page of reviews. */
export function reviewListLines(list: ReviewList): string[] {
  const items = Array.isArray(list.items) ? list.items : [];
  return [
    `Reviews (${items.length}; ${list.pending_count ?? 0} pending)`,
    ...items.map((review) => [review.id, review.kind, review.state, subjectText(review.subject) ?? "-", review.created_at,
      ...(review.playlist_change?.media_change ? [mediaChangeText(review.playlist_change.media_change)] : [])].join("  ")),
  ];
}

const LIMITED_BY: Record<AccessLimitedBy, string> = {
  project: "the project requires review for agent changes",
  person: "the responsible person cannot approve reviews",
};

/** access, effective_access and access_limited_by from GET /api/agents/self, for envelopes and human lines. */
export function accessFields(self: { access?: AccessLevel; effective_access?: AccessLevel; access_limited_by?: AccessLimitedBy }): {
  data: { access?: AccessLevel; effective_access?: AccessLevel; access_limited_by?: AccessLimitedBy };
  lines: Array<[string, string | undefined]>;
} {
  const effective = self.effective_access ?? self.access;
  const limited = self.access_limited_by && effective !== self.access ? self.access_limited_by : undefined;
  return {
    data: {
      ...(self.access ? { access: self.access } : {}),
      ...(effective ? { effective_access: effective } : {}),
      ...(limited ? { access_limited_by: limited } : {}),
    },
    lines: [
      ["access", self.access ? accessLabel(self.access) : undefined],
      ["effective_access", effective && limited ? `${accessLabel(effective)} (${LIMITED_BY[limited]})` : undefined],
    ],
  };
}

/** Why a project or person cap refused a write, and what a person changes to allow it. */
export function accessLimitHint(limitedBy: AccessLimitedBy): string {
  return limitedBy === "project"
    ? "This project requires review for agent changes, so this credential acts with Propose access whatever its sign-in grants: it proposes playlist and screen changes for review and cannot do this. A person does it in the dashboard, or turns off Require review for agent changes there."
    : "The person responsible for this agent cannot approve reviews in this project, so the agent acts with Propose access: it proposes playlist and screen changes for review and cannot do this. The project owner can turn on Can approve for that person in the dashboard, or a person does it there.";
}
