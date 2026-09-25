/** Optional enrollment purpose. Omitted means signage, the existing default. */
export type EnrollmentIntent = "advertising" | "signage";

/**
 * Temporary compile-time adapter for the generated `packages/protocol` API.
 *
 * The generated package is currently private and exports TypeScript source,
 * which cannot be consumed by this independently built package without pulling
 * shared source outside `rootDir`. These definitions mirror OpenAPI v0.2.0;
 * replace them with package imports once `@screenrig/protocol` publishes JS and
 * declarations.
 */

export type OperationState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Project {
  content_limit_bytes: number;
  created_at: string;
  credit_remaining: number;
  email: string;
  email_verified: false;
  feature_revision?: number;
  features?: ProjectFeatures;
  id: string;
  name: string;
  reserved_bytes: number;
  revision: number;
  screen_count: number;
  screen_limit: number;
  status: "active" | "cancelled" | "deleted";
  updated_at: string;
  used_bytes: number;
}

export type InvitationStatus = "queued" | "sent" | "issued" | "accepted" | "revoked" | "expired" | "failed";

export interface EnrollmentInvitation {
  expires_at: string;
  id: string;
  status: InvitationStatus;
}

export interface InvitationAdvertising {
  policy: "trusted" | "review_required";
  screen_ids: string[];
  slot_ids: string[];
}

export interface Invitation {
  advertising?: InvitationAdvertising;
  created_at: string;
  delivery: "email" | "link";
  expires_at: string;
  id: string;
  kind: "project_member" | "ad_buyer";
  project_id: string;
  recipient_email?: string;
  status: InvitationStatus;
}

export interface InvitationCreate {
  advertising?: InvitationAdvertising;
  delivery?: "email" | "link";
  emails?: string[];
  kind: "project_member" | "ad_buyer";
}

/** Only the creation response may carry the explicitly requested link. */
export interface InvitationIssued extends Invitation {
  url?: string;
}

export interface InvitationCreated {
  invitations: InvitationIssued[];
}

export interface InvitationList {
  items: Invitation[];
  next_cursor: string;
}

export interface SignInResetRequest {
  email: string;
}

export interface SignInResetAccepted {
  status: "accepted";
}

/** Independent project product features. Neither flag is a billing plan. */
export interface ProjectFeatures {
  advertiser: boolean;
  screens: boolean;
}

/** The server-derived capability set for the authenticated project. */
export interface ProjectCapabilities {
  project_id: string;
  plan_id: string;
  features: ProjectFeatures;
  feature_revision: number;
  capabilities: string[];
}

export interface CLIEnrollment {
  project: Project;
  invitation: EnrollmentInvitation;
  agent: Agent;
  connection_ready: false;
  issuance_expires_at: string;
  issuance_id: string;
  token: string;
}

export interface CLIEnrollmentRequest {
  client_id: string;
  email: string;
  project_name?: string;
  /** Present only when the operator supplies --beta-key or SCREENRIG_BETA_KEY. */
  beta_key?: string;
  /**
   * Advertising-purpose enrollment sets advertiser=true/screens=false without
   * changing billing-plan assignment. Omitted means signage (screens=true).
   */
  intent?: EnrollmentIntent;
  name?: string;
  agent_type?: string;
  platform?: string;
  version?: string;
}

export interface Agent {
  agent_type: string;
  authenticated_requests: number;
  connected_at?: string;
  created_at: string;
  id: string;
  last_used_at?: string;
  metered_credits: number;
  name: string;
  platform?: string;
  public_key_kid?: string;
  revoked_at?: string;
  state: "pending" | "active" | "revoked" | "cancelled" | "expired";
  version?: string;
}

export interface AgentSelfStatus {
  agent: Agent;
  connection_ready: boolean;
}

export interface X25519PublicJWK {
  kty: "OKP";
  crv: "X25519";
  x: string;
}

export interface AgentConnectionRequest {
  agent_type?: string;
  name?: string;
  platform?: string;
  recipient_public_key: X25519PublicJWK;
  version?: string;
}

export interface AgentConnectionStart {
  approval_url: string;
  connection_id: string;
  connection_token: string;
  expires_at: string;
}

export interface AgentConnection {
  agent_type: string;
  connection_id: string;
  created_at: string;
  expires_at: string;
  name: string;
  platform?: string;
  status: "pending" | "approved" | "connected" | "denied" | "expired" | "cancelled";
  version?: string;
}

export interface AgentCredentialEnvelope {
  algorithm: "X25519-HKDF-SHA256-A256GCM";
  ciphertext: string;
  ephemeral_public_key: X25519PublicJWK;
  nonce: string;
}

export interface AgentCredentialCollection {
  agent: Agent;
  credential_envelope: AgentCredentialEnvelope;
  issuance_expires_at: string;
}

export interface AgentDisconnectRequest {
  allow_last_agent?: boolean;
}

export interface Operation {
  created_at: string;
  error?: Record<string, unknown>;
  id: string;
  kind: string;
  request_id?: string;
  result?: Record<string, unknown>;
  state: OperationState;
  updated_at: string;
  [key: string]: unknown;
}

export interface OperationAccepted {
  /** Application identifier the upload was attributed to. */
  id: string;
  /**
   * Release created by this upload. The server has always returned it and the
   * contract now requires it. It is the only handle an application primitive
   * accepts, so report it rather than making the caller poll the operation.
   */
  release_id: string;
  operation_id: string;
}

export interface EventResource {
  [key: string]: unknown;
}

/**
 * Dashboard user that caused one mutation. Descriptive attribution only; it is
 * never authorization.
 */
export interface EventActor {
  user_id: string;
  display_name: string;
}

/** Safe agent principal attribution on directly caused project events. */
export interface EventAgent {
  agent_id: string;
  name: string;
  agent_type: string;
}

export interface ProjectEvent {
  cursor: string;
  sequence: number;
  type: string;
  severity: string;
  resource?: EventResource;
  request_id?: string;
  operation_id?: string;
  message: string;
  details?: Record<string, unknown>;
  /**
   * Absent on every event an agent, the CLI, a player, or a worker produced, so
   * its presence distinguishes a dashboard mutation rather than labelling all
   * traffic.
   */
  actor?: EventActor;
  agent?: EventAgent;
  at: string;
}

export interface EventPage {
  items: ProjectEvent[];
  /**
   * Cursor of the last returned event while newer events already exist; pass
   * it back as `after`. `null` marks the end of the history and is not an error.
   */
  next_cursor: string | null;
}

export interface Capabilities {
  /** Default-plan storage cap. Zero means no product storage cap. */
  project_content_bytes: 0;
  api_version: string;
  application_compressed_bytes: 104857600;
  application_expanded_bytes: 262144000;
  application_file_bytes: 33554432;
  application_file_count: 5000;
  application_path_bytes: 255;
  application_path_depth: 16;
  features: Record<string, unknown>;
  /** Maximum declared byte size of one image upload, 20 MiB. */
  media_image_bytes: 20971520;
  playlist_max_items_per_page: 24;
  playlist_max_media_per_selector: 32;
  playlist_max_pages: 100;
  protocol_version: string;
  screens_per_project: 100;
  transition_max_duration_ms: 60000;
}

export interface ArchiveLimits {
  application_archive_bytes: number;
  application_expanded_bytes: number;
  application_file_count: number;
  application_file_bytes: number;
  application_path_depth: number;
  application_path_bytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  application_archive_bytes: 100 * 1024 * 1024,
  application_expanded_bytes: 250 * 1024 * 1024,
  application_file_count: 5000,
  application_file_bytes: 32 * 1024 * 1024,
  application_path_depth: 16,
  application_path_bytes: 255,
};

export function limitsFromCapabilities(capabilities: Capabilities): ArchiveLimits {
  return {
    application_archive_bytes: capabilities.application_compressed_bytes,
    application_expanded_bytes: capabilities.application_expanded_bytes,
    application_file_count: capabilities.application_file_count,
    application_file_bytes: capabilities.application_file_bytes,
    application_path_depth: capabilities.application_path_depth,
    application_path_bytes: capabilities.application_path_bytes,
  };
}

/**
 * Full playlist pages stay opaque: the CLI forwards author-supplied playlist
 * JSON unchanged, including `transition.type` swipe variants, optional
 * object `enter`, and optional object `motion`. Templated pages are the
 * exception — the CLI expands `template` + `slots` into an ordinary write page
 * in `playlist-templates.ts` and never sends `template` to the server. Omitted
 * templated transitions stay `{ type: "crossfade", duration_ms: 200 }` with no
 * `enter` and no `motion`. The contract's page and primitive schemas are still
 * not mirrored here except for the fields that expander writes. Mirror a schema
 * only when the CLI builds or reads its fields.
 *
 * Page `visibility` is inspected only for key presence. That is exactly what
 * decides whether a playlist needs the target screen to carry a timezone, so
 * no member of the schedule object is mirrored either.
 */

export type ScreenObservationPresentation = "output" | "windowed";

export interface ScreenObservationSurface {
  height: number;
  id: string;
  pixel_ratio: number;
  presentation: ScreenObservationPresentation;
  width: number;
}

/**
 * Player-reported playback surface. Absent until the first accepted player
 * report. Read-only on the project API; ScreenPatch cannot write it.
 */
export interface ScreenObservation {
  observed_at: string;
  surfaces: ScreenObservationSurface[];
}

/** Last durable page failure reported for a screen. Read-only on the project API. */
export interface PageFailure {
  at: string;
  code: string;
  page_id: string;
}

/**
 * Optional hardware identifiers a player reported. duid and serial are the
 * only two the recovery hint consults. A failed read on the player omits the
 * field. Never authorization.
 */
export interface HostDevice {
  duid?: string;
  serial?: string;
  mac?: string;
  model?: string;
  firmware?: string;
  manufacturer?: string;
}

/**
 * The shell and hardware a player runs on, as the player reported it. A hint
 * that names a device; never a credential. Read-only on the project API and
 * returned only to the owning project.
 */
export interface HostContext {
  platform: "tizen" | "android" | "windows" | "qt" | "apple" | "chromeos" | "browser";
  host_version?: string;
  device?: HostDevice;
  capabilities?: string[];
}

/**
 * What the display asking to reconnect reported about itself: platform,
 * model, firmware, and manufacturer only. No identifiers. Mirrors the vendored
 * `ScreenRecoveryHost`; the CLI prints whichever fields are present so an
 * operator can compare them with the display they expect.
 */
export interface ScreenRecoveryPendingHost {
  platform?: HostContext["platform"];
  model?: string;
  firmware?: string;
  manufacturer?: string;
}

/**
 * Present while a native pairing session that presented this screen's
 * hardware identity waits for the owning project to confirm with
 * `screen recover`. Carries the pairing session's deadline and, when the
 * server reports it, a description of the display asking to reconnect.
 */
export interface ScreenRecoveryPending {
  expires_at: string;
  host?: ScreenRecoveryPendingHost;
}

/** Screen health: the paired Player cannot show application or iframe primitives. */
export interface ScreenApplicationsUnsupported {
  at: string;
}

/** Breakdown of the player's content-cache capacity, in bytes. */
export interface ScreenStorageCache {
  ad_headroom_bytes: number;
  capacity_bytes: number;
  fallback_bytes: number;
  house_used_bytes: number;
  protected_bytes: number;
  reserve_bytes: number;
  warm_bytes: number;
}

/** A page the player's storage plan keeps out of its target, with the reason. */
export interface ScreenStorageExcludedPage {
  page_id: string;
  reason: "object_exceeds_capacity" | "page_exceeds_capacity" | "capacity_excluded" | "descriptor_conflict" | "not_local" | "anchor_unavailable";
}

/** The player's storage plan for the manifest revision it named. */
export interface ScreenStoragePlan {
  excluded_pages: ScreenStorageExcludedPage[];
  fit: "fits" | "fits_after_eviction" | "retention_reduced" | "partial" | "transition_blocked" | "none_fit";
  headroom_needed_bytes?: number;
  manifest_revision: string;
  required_bytes: number;
  target_bytes: number;
  transition: "direct" | "staged" | "blocked";
}

/** Bytes received on content fetches in the last 24 hours, by reason. */
export interface ScreenStorageTransfer {
  failed: number;
  new: number;
  refetch: number;
  repair: number;
}

/**
 * Sanitized player storage report. Absent until the first accepted
 * PUT /runtime/v1/storage. Cleared on identity reset, unpair, and archive.
 * received_at is the server receipt time, not the player clock. Read-only.
 */
export interface ScreenStorage {
  cache: ScreenStorageCache;
  durability: "durable" | "purgeable";
  observed_at: string;
  plan: ScreenStoragePlan;
  received_at: string;
  transfer_24h: ScreenStorageTransfer;
  volume: ScreenStorageVolume;
}

/** Device volume backing the content cache, in bytes. */
export interface ScreenStorageVolume {
  available_bytes: number;
  total_bytes: number;
}

/** Approximate steady-state target selection (no transition) for the screen's desired manifest. Absent without a storage report. */
export interface ScreenStorageForecast {
  basis: "reported_capacity";
  excluded_page_count: number;
  fit: "fits" | "partial" | "none_fit";
  manifest_revision: string;
  received_at: string;
}

/** Body of the pre-assignment fit dry run. playlist_id is a playlist of the authenticated project; another project's or an unknown id is not_found. */
export interface ScreenStorageForecastRequest {
  playlist_id: string;
  /** Optional expected playlist revision. A different stored revision is revision_conflict and no forecast is returned. */
  playlist_revision?: number;
}

/**
 * Pre-assignment fit dry run for one playlist against the screen's last
 * reported capacity. fit unknown means the screen has no storage report, or
 * the playlist's content references are not ready; the byte counts and
 * received_at are null then. A report older than 24 hours is stale but still
 * forecast from. Read-only; it writes nothing and is never authorization or
 * admission.
 */
export interface ScreenStorageForecastDryRun {
  basis: "reported_capacity";
  capacity_bytes: number | null;
  excluded_page_count: number;
  fit: "fits" | "partial" | "none_fit" | "unknown";
  received_at: string | null;
  required_bytes: number | null;
}

/**
 * Present while the player's reported fit is partial, transition_blocked, or
 * none_fit. at is when the condition began. Read-only project health metadata.
 */
export interface ScreenStorageShortfall {
  at: string;
  capacity_bytes: number;
  excluded_page_count: number;
  fit: "partial" | "transition_blocked" | "none_fit";
  required_bytes: number;
}

export interface Screen {
  content_access_generation: number;
  created_at: string;
  /** Player-reported host hint. Absent until a native player sends one. */
  host?: HostContext;
  /** Instant the stored host hint was last replaced. Project cannot write it. */
  host_updated_at?: string;
  id: string;
  label: string;
  /**
   * Last client IP at a paired runtime events connect. Absent until the first
   * connect. Operational metadata; IDs and IPs are never authorization.
   */
  last_ip?: string;
  /**
   * Instant a paired runtime events stream last became connected. Present
   * after the first connect. When offline, last time the screen was online.
   */
  last_online_at?: string;
  last_page_failure?: PageFailure;
  manifest_revision: number;
  observation?: ScreenObservation;
  /**
   * True while at least one paired runtime events stream is connected,
   * including a short reconnect window. Always present; false until first
   * connect. Read-only; not a player heartbeat.
   */
  online: boolean;
  /** Assigned default playlist. A takeover or a matching schedule entry takes precedence; effective_playlist names what is shown. */
  playlist_id?: string;
  /** Server-evaluated playlist schedule (never on the runtime manifest). */
  playlist_schedule?: ScreenPlaylistSchedule;
  /** The playlist that wins over the schedule and the assignment. */
  takeover?: ScreenTakeover;
  /** What the runtime manifest is built from; absent when the screen shows no playlist. */
  effective_playlist?: ScreenEffectivePlaylist;
  /**
   * Opaque agent JSON object. Absent when unset. ScreenRig never reads or uses
   * it. Not on the runtime manifest and never authorization.
   */
  comments?: Record<string, unknown>;
  public_id: string;
  /** Read-only recovery offer awaiting confirmation. Absent once confirmed, lapsed, or claimed as a new screen. */
  recovery_pending?: ScreenRecoveryPending;
  /**
   * Present only while archived: what archived the screen. Known values are
   * project, device_reset, and device_unpair; readers keep a value they do
   * not know. Every reason keeps the device binding, so unarchive resumes the
   * display with no re-pairing. Absent on screens archived before reasons
   * were recorded. Read-only.
   */
  archive_reason?: string;
  /** Present only while archived with archive_reason. Instant the screen was archived. Read-only. */
  archived_at?: string;
  /**
   * Present while the paired Player cannot show the application or iframe
   * primitives its manifest carries. at is when the condition began. The
   * manifest is unchanged; the Player drops those primitives. Read-only
   * project health metadata.
   */
  applications_unsupported?: ScreenApplicationsUnsupported;
  /**
   * Sanitized player storage report. Absent until the first accepted
   * PUT /runtime/v1/storage. Cleared on identity reset, unpair, and archive.
   * Readers treat received_at older than 24 hours as stale. Read-only.
   */
  storage?: ScreenStorage;
  /**
   * Approximate steady-state target selection (no transition) from the last
   * reported capacity and the screen's desired manifest. Absent without a
   * storage report, which readers take as unknown. Read-only.
   */
  storage_forecast?: ScreenStorageForecast;
  /**
   * Present while the player's reported fit is partial, transition_blocked,
   * or none_fit. at is when the condition began. Read-only.
   */
  storage_shortfall?: ScreenStorageShortfall;
  revision: number;
  state: "pairing_pending" | "active" | "archived";
  /**
   * Fleet selector tags: 0 to 16 unique exact tags matching ^[A-Za-z0-9]{1,32}$.
   * Absent or empty when untagged. Never on the runtime manifest and never
   * authorization.
   */
  tags?: ScreenTags;
  /**
   * IANA time zone identifier. Absent until it is set. Page visibility rules
   * are civil, so they are evaluated in this zone.
   */
  timezone?: string;
  updated_at: string;
}

/**
 * The screen patch body. Every member is optional and the server requires at
 * least one, which is why each command builds only the members it was asked
 * for rather than sending undefined placeholders. Observation, online,
 * last_online_at, last_ip, comments, host, host_updated_at,
 * recovery_pending, archive_reason, archived_at, and applications_unsupported,
 * storage, storage_forecast, and storage_shortfall are not patchable fields.
 */
export interface ScreenPatch {
  name?: string;
  playlist_id?: string;
  timezone?: string;
  /** Replaces the whole tag set; an empty array clears it. Bumps the screen revision. */
  tags?: ScreenTags;
}

export type ScreenTags = string[];

/** POST /api/v1/screens/actions selector: explicit ids (any state) or every active screen with a tag. */
export type ScreenActionSelector =
  | { by: "ids"; screen_ids: string[] }
  | { by: "tag"; tag: string };

/** One fleet action, discriminated by type. New action types are additive. */
export type ScreenAction =
  | { type: "assign"; playlist_id: string }
  | { type: "reload" }
  | ({ type: "toast" } & ScreenToastWrite)
  | { type: "set_tags"; tags: ScreenTags }
  | { type: "add_tags"; tags: string[] }
  | { type: "remove_tags"; tags: string[] }
  | { type: "takeover"; playlist_id: string; until?: string | null; reason?: string }
  | { type: "takeover_clear" }
  | { type: "set_playlist_schedule"; entries: ScreenScheduleEntryWrite[] }
  | { type: "clear_playlist_schedule" };

export type ScreenActionType = ScreenAction["type"];

export interface ScreenActionRequest {
  selector: ScreenActionSelector;
  action: ScreenAction;
}

/** One screen's outcome: ok carries the single-screen result, failed carries that screen's problem. */
export interface ScreenActionScreenResult {
  screen_id: string;
  status: "ok" | "failed";
  revision?: number;
  tags?: string[];
  reload?: ScreenReloadAccepted;
  toast?: ScreenToastAccepted;
  problem?: { type?: string; title?: string; status?: number; detail?: string; code?: string; [key: string]: unknown };
}

/** 200 answer of POST /api/v1/screens/actions. Partial success is a normal answer. */
export interface ScreenActionResult {
  action: ScreenActionType;
  matched: number;
  succeeded: number;
  failed: number;
  results: ScreenActionScreenResult[];
}

/** PUT /api/v1/comment/... body. Compact UTF-8 JSON of comments must be ≤ 1024 bytes. */
export interface CommentsWrite {
  comments: Record<string, unknown>;
}

/** GET/PUT /api/v1/comment/... body. Null when the target exists and comments are unset. */
export interface Comments {
  comments: Record<string, unknown> | null;
}

export interface PairScreen {
  code: string;
  label?: string;
}

export interface ProvisionScreen {
  label?: string;
}

export interface ScreenProvisioning {
  screen: Screen;
  public_url: string;
  provisioning_url: string;
  expires_at: string;
}

export type ScreenToastLevel = "error" | "alert" | "info";

/**
 * Write body for POST /api/v1/screens/{id}/toast. Colours are player chrome
 * and are never sent. duration_ms is omitted so the server can default it.
 */
export interface ScreenToastWrite {
  level: ScreenToastLevel;
  text: string;
  duration_ms?: number;
}

/** Accepted toast write. The toast itself lives on the durable screen.toast event. */
export interface ScreenToastAccepted {
  expires_at: string;
}

/**
 * Accepted POST /api/v1/screens/{id}/reload. The reload itself is the durable
 * per-screen player.reload event; a Player acts on one reload_id at most once
 * and ignores it after expires_at.
 */
export interface ScreenReloadAccepted {
  reload_id: string;
  expires_at: string;
}

/** shot_ plus 16 to 64 unpadded base64url characters. */
export type ScreenshotCaptureID = string;

/** Accepted POST /api/v1/screens/{id}/screenshot. */
export interface ScreenScreenshotAccepted {
  capture_id: ScreenshotCaptureID;
  expires_at: string;
}

export type ScreenScreenshotState = "idle" | "pending" | "ready" | "timed_out" | "unavailable";

/** GET /api/v1/screens/{id}/screenshot/status. Image bytes are never present. */
export interface ScreenScreenshotStatus {
  bytes?: number;
  capture_id?: ScreenshotCaptureID;
  captured_at?: string;
  expires_at?: string;
  height?: number;
  sha256?: string;
  state: ScreenScreenshotState;
  width?: number;
}

export interface PairingClaim {
  public_url: string;
  screen: Screen;
}

export interface BrowserLinkClaimRequest {
  code: string;
}

export interface BrowserLinkClaimScreen {
  id: string;
  public_id: string;
  state: "pairing_pending";
  public_url: string;
}

export interface BrowserLinkClaim {
  session_id: string;
  status: "claimed";
  screen: BrowserLinkClaimScreen;
}

export interface MediaCommit {
  bytes: number;
  content_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "video/mp4" | "video/webm" | "audio/mpeg";
  sha256: string;
}

export interface MediaUploadDeclaration {
  bytes: number;
  content_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "video/mp4" | "video/webm" | "audio/mpeg";
  /** Name of the bytes being uploaded, as they will be sent. */
  filename: string;
  /**
   * Caller's original file name before any client-side transcode. Bare file
   * name only. The server stores it verbatim and derives the ready `filename`
   * from it, so photo.png uploaded as WebP is stored as photo.png.webp.
   */
  source_filename?: string;
  sha256: string;
  /** Optional mutable query tag. Stored on the ready object, not redeclared at commit. */
  tag?: string;
}

/** The subset of a ready Media row that `media download` verifies against. */
export interface MediaRecord {
  id: string;
  filename: string;
  /** Present when the upload declared one; absent for generated stills. */
  source_filename?: string;
  primitive: "image" | "video" | "audio";
  content_type: string;
  sha256: string;
  bytes: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

/** PATCH /api/v1/media/{id}. tag is required; null clears it. */
export interface MediaTagPatch {
  tag: string | null;
}

export type MediaGenerationAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
export type MediaGenerationQuality = "low" | "medium" | "high";

/** POST /api/v1/media/generations. prompt is required; aspect_ratio and quality have server defaults. quality changes the image and the price. */
export interface MediaGenerationRequest {
  prompt: string;
  aspect_ratio?: MediaGenerationAspectRatio;
  quality?: MediaGenerationQuality;
  tag?: string;
}

export interface MediaGenerationUsage {
  credits: number;
  usd: string;
  quality?: MediaGenerationQuality;
  aspect_ratio?: MediaGenerationAspectRatio;
}

/** 201 body. media.id is med_…. Never image bytes. */
export interface MediaGeneration {
  media: { id: string; [key: string]: unknown };
  usage: MediaGenerationUsage;
}

export interface MediaUploadSession {
  expires_at: string;
  headers: Record<string, unknown>;
  id: string;
  method: "PUT";
  operation: Operation;
  upload_url: string;
}

export interface KVWrite {
  value_base64: string;
  content_type: string;
}

interface KVMetadata {
  application_id: string;
  key: string;
  content_type: string;
  bytes: number;
  sha256: string;
  revision: number;
}

export interface KVSummary extends KVMetadata {
  created_at?: string;
  updated_at?: string;
}

export interface KVEntry extends KVMetadata {
  value_base64: string;
}

export type FeedbackKind = "bug" | "feature";

/**
 * Closed diagnostic envelope. Every member is an optional constrained scalar and
 * the server rejects an unknown member, so nothing free-form can be persisted
 * through it. `command` is a command path only; the pattern rejects flags and
 * argument values.
 */
export interface FeedbackContext {
  cli_version?: string;
  command?: string;
  platform?: string;
}

export interface FeedbackWrite {
  title: string;
  body: string;
  context?: FeedbackContext;
}

/** Immutable once written, which is why it carries no revision. */
export interface FeedbackSubmission {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  context?: FeedbackContext;
  created_at: string;
}

export interface FeedbackList {
  items: FeedbackSubmission[];
}

export const TEMPORARY_PROTOCOL_VERSION = "screenrig.cli.adapter/0";

/** GET/PATCH /api/v1/webhooks/{id}. The signing secret is never part of this shape. */
export interface Webhook {
  created_at: string;
  description?: string;
  disabled_at?: string;
  disabled_reason?: "delivery_failures";
  enabled: boolean;
  event_types: string[];
  failing_since?: string;
  id: string;
  last_failure_at?: string;
  last_success_at?: string;
  revision: number;
  status: "active" | "failing" | "disabled";
  updated_at: string;
  url: string;
}

/** Returned only by create and rotate-secret (and their exact idempotent replay for 24 hours). */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}

export interface WebhookList {
  items: Webhook[];
}

export interface WebhookWrite {
  url: string;
  event_types: string[];
  enabled?: boolean;
  description?: string;
}

export interface WebhookPatch {
  url?: string;
  event_types?: string[];
  enabled?: boolean;
  /** An empty string clears the description. */
  description?: string;
}

export interface WebhookDelivery {
  attempts: number;
  completed_at?: string;
  created_at: string;
  event_id: string;
  event_type: string;
  id: string;
  last_attempt_at?: string;
  last_duration_ms?: number;
  last_error?: "http_status" | "timeout" | "connection_failed" | "tls_failed" | "dns_failed" | "url_rejected" | "payment_required" | "webhook_disabled" | "webhook_deleted" | "event_expired" | "secret_unavailable";
  last_status?: number;
  next_attempt_at?: string;
  state: "pending" | "succeeded" | "failed";
  test?: boolean;
  webhook_id: string;
}

export interface WebhookDeliveryList {
  items: WebhookDelivery[];
  next_cursor: string | null;
}

export type ScreenScheduleDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** screenrig.schedule/v1 window in the screen timezone; omit start and end for the whole day. */
export interface ScreenScheduleWindow {
  days: ScreenScheduleDay[];
  start?: string;
  end?: string;
}

export interface ScreenScheduleEntryWrite {
  id?: string;
  playlist_id: string;
  from?: string;
  until?: string;
  windows: ScreenScheduleWindow[];
}

export interface ScreenScheduleEntry extends ScreenScheduleEntryWrite {
  id: string;
}

export interface ScreenPlaylistSchedule {
  entries: ScreenScheduleEntry[];
  updated_at: string;
}

export interface ScreenPlaylistScheduleView {
  entries: ScreenScheduleEntry[];
  updated_at?: string;
  effective_playlist?: ScreenEffectivePlaylist;
}

export interface ScreenPlaylistScheduleWrite {
  entries: ScreenScheduleEntryWrite[];
}

export interface ScreenTakeover {
  playlist_id: string;
  until: string | null;
  reason?: string;
  set_at: string;
}

export interface ScreenTakeoverWrite {
  playlist_id: string;
  until?: string | null;
  reason?: string;
}

export interface ScreenEffectivePlaylist {
  id: string;
  source: "takeover" | "schedule" | "default";
  entry_id?: string;
  until?: string;
}
