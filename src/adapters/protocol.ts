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

/** receiving: an upload's archive has not arrived yet (a direct upload waits for its PUT and commit). */
export type OperationState = "receiving" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Project {
  content_limit_bytes: number;
  created_at: string;
  credit_remaining: number;
  email: string;
  feature_revision?: number;
  features?: ProjectFeatures;
  id: string;
  name: string;
  reserved_bytes: number;
  revision: number;
  screen_count: number;
  screen_limit: number;
  organization_id?: string;
  organization_name?: string;
  owner_user_id?: string;
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

/** What an uploader may use: the playlists it changes pages of and the media folders it uploads into. */
export interface UploadScope {
  playlist_ids: string[];
  folder_ids: string[];
  /** A member's level: propose (the default) or manage. Absent on a service client. */
  access?: "propose" | "manage";
}

export interface Invitation {
  advertising?: InvitationAdvertising;
  /** An uploader invitation: the scope the accepting person receives. */
  upload_scope?: UploadScope;
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
  upload_scope?: UploadScope;
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

/** Enrollment delivers the grant's first token pair. */
export interface CLIEnrollmentOAuth {
  project: Project;
  invitation: EnrollmentInvitation;
  agent: Agent;
  connection_ready: false;
  issuance_expires_at: string;
  issuance_id: string;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_expires_at: number;
  scope: string;
}

export interface CLIEnrollmentRequest {
  organization?: string;
  client_id: string;
  /** The token pair the enrollment delivers; the only format the server issues. */
  credential_format: "oauth";
  /** Exactly one of `email` or `agentid_claim` is present. */
  email?: string;
  /**
   * AgentID claim code redeemed by the server; exactly one of `email` or
   * `agentid_claim`. The server derives the contact address from the verified
   * AgentID owner. Never echoed back to the operator.
   */
  agentid_claim?: string;
  project_name?: string;
  /**
   * Advertising-purpose enrollment sets advertiser=true/screens=false without
   * changing billing-plan assignment. Omitted means signage (screens=true).
   */
  intent?: EnrollmentIntent;
  /**
   * Website setup code, upper-case XXXX-XXXX, from the setup prompt the person
   * copied. It names their website visit so the server can link the new
   * project to it; it grants nothing, and an unknown or expired code never
   * fails enrollment.
   */
  setup_code?: string;
  name?: string;
  agent_type?: string;
  platform?: string;
  version?: string;
}

export const AGENT_CAPABILITIES = ["screens", "content", "playlists", "advertising", "reports", "project"] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export interface Agent {
  agent_type: string;
  authenticated_requests: number;
  capabilities: AgentCapability[];
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

/** read (Read only) < propose < manage. */
export type AccessLevel = "read" | "propose" | "manage";
/** Why effective_access is lower than the credential's access. */
export type AccessLimitedBy = "project" | "person";

export interface AgentSelfStatus {
  agent: Agent;
  connection_ready: boolean;
  /** The credential's access level. */
  access?: AccessLevel;
  /** The level this credential acts with now, after the project and person caps. */
  effective_access?: AccessLevel;
  access_limited_by?: AccessLimitedBy;
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
 * JSON unchanged, including all page transition types and their members, optional
 * object `enter`, and optional object `motion`. The contract's page and
 * primitive schemas are not mirrored here. Mirror a schema only when the CLI
 * builds or reads its fields.
 *
 * The backend-owned playlist semantics decide whether page visibility has
 * civil-time bounds and needs a screen timezone. Data-only rules need no zone;
 * no member of the schedule object is mirrored here.
 */

export type ScreenObservationPresentation = "output" | "windowed";

export interface ScreenObservationSurface {
  height: number;
  /** Player-local label; for a video wall output, the output name. */
  id: string;
  pixel_ratio: number;
  presentation: ScreenObservationPresentation;
  rotation?: ScreenWallRotation;
  width: number;
}

export type ScreenWallArrangement = "row" | "column" | "grid";
export type ScreenWallRotation = 0 | 90 | 180 | 270;

/**
 * The video wall a screen's Player lays out: two to twelve outputs that show
 * one canvas. `outputs` are output names as the Player reports them
 * (observation surface ids) in physical order: left to right, then top to
 * bottom. `columns` is the outputs per row of a grid, given for a grid only.
 * `rotation` is clockwise degrees on every output (default 0); 90 and 270
 * mean portrait panels.
 */
export interface ScreenWall {
  outputs: string[];
  arrangement: ScreenWallArrangement;
  columns?: number;
  rotation?: ScreenWallRotation;
}

/** The video wall a playlist is authored for: 2 to 12 displays, tiles of 1920 x 1080 (landscape) or 1080 x 1920 (portrait); `columns` for a grid only. */
export interface PlaylistFormat {
  displays: number;
  arrangement: ScreenWallArrangement;
  orientation: "landscape" | "portrait";
  columns?: number;
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
  /** Administrator labels from device management (ChromeOS Admin console); display only. */
  asset_id?: string;
  location?: string;
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
 * PUT /screen/storage. Cleared on identity reset, unpair, and archive.
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

/**
 * Screen.health: the latest PUT /screen/health report, sanitized, with
 * server reported_at. stale is true after 35 minutes without a report. A
 * member the Player did not send is absent.
 */
export interface ScreenHealth {
  reported_at: string;
  stale: boolean;
  uptime_s?: number;
  app_uptime_s?: number;
  memory?: { used_bytes?: number; total_bytes?: number };
  cpu?: { load_1m?: number; cores?: number; utilization_percent?: number; app_percent?: number };
  temperature_c?: number;
  display?: { connected?: boolean; power?: "on" | "off" | "standby" | "unknown" };
  network?: { kind?: "ethernet" | "wifi" | "cellular" | "unknown"; wifi_rssi_dbm?: number };
  crashes_24h?: number;
  renderer_restarts_24h?: number;
}

/**
 * Screen.last_outage: the screen's latest presence outage and, once the first
 * health report after it decided one, why the screen was gone. likely_cause is
 * absent when unknown; a value this CLI does not know reads as unknown.
 * evidence is open: device_uptime_s, app_uptime_s, report_at,
 * crashes_24h_before and crashes_24h_after, reboot_command,
 * stream_down_during_outage, observer_impaired.
 */
export interface ScreenOutage {
  offline_since: string;
  back_at?: string;
  duration_s?: number;
  likely_cause?: string;
  evidence?: Record<string, unknown>;
}

export interface ScreenDisplaySchedule {
  enabled: boolean;
  windows: ScreenScheduleWindow[];
  updated_at: string;
}

export interface ScreenDisplayOverride {
  override_id: string;
  power: "on" | "off";
  until: string | null;
  ends_at: string | null;
  set_at: string;
}

/** Screen.display: requested power now, why, until when, and the Player's reported power. */
export interface ScreenDisplay {
  requested: "on" | "off";
  source: "override" | "schedule" | "default";
  until?: string;
  schedule?: ScreenDisplaySchedule;
  override?: ScreenDisplayOverride;
  reported?: { power?: "on" | "off" | "standby" | "unknown"; connected?: boolean; reported_at: string; stale: boolean };
}

export interface ScreenDisplayScheduleView {
  display_schedule: ScreenDisplaySchedule | null;
  display?: ScreenDisplay;
}

/** sent: the screen was online and its Player was handed the command at once. queued: the screen was offline; the command is sent when it comes online before expires_at. */
export type ScreenCommandDelivery = "queued" | "sent";

export interface ScreenRebootAccepted {
  reboot_id: string;
  expires_at: string;
  state: ScreenCommandDelivery;
}

/** The optional body of POST /api/screens/{id}/reboot and /reload: how long the command stays actionable, 60 to 86400 seconds (default 86400). */
export interface ScreenCommandWrite {
  expires_in_s?: number;
}

/**
 * One reboot or reload asked of a screen, in Screen.commands (oldest first, at
 * most 10). expired is derived by the server on read for a queued command past
 * expires_at; a reload never reaches done.
 */
export interface ScreenCommand {
  id: string;
  type: "reboot" | "reload";
  state: "queued" | "sent" | "done" | "expired" | "cancelled" | "superseded";
  requested_at: string;
  expires_at: string;
  sent_at?: string;
  done_at?: string;
}

/** Screen.glass: the backend's conclusions about the picture. Readers keep a member and a verdict they do not know. */
export interface ScreenGlass {
  /** The loop_stalled check; absent for a screen it never found stalled. */
  playback?: ScreenGlassPlayback;
  /** The glass_blank and glass_frozen check; absent for a screen it never found blank or frozen. */
  picture?: ScreenGlassPicture;
}

export interface ScreenGlassPicture {
  /** blank: every screenshot of a run that covers the loop was one flat tone. frozen: every one was the same picture. verified: two good screenshots in a row followed. unjudged: the screen stopped meeting the conditions under which the check judges. */
  verdict: "verified" | "blank" | "frozen" | "unjudged";
  /** When the verdict began; for blank and frozen, the first screenshot of the run that confirmed it. */
  since: string;
  judged_at: string;
}

export interface ScreenGlassPlayback {
  /** stalled: no media start arrived for longer than the loop allows. playing: one arrived after. unjudged: the screen stopped meeting the conditions under which the check judges. */
  verdict: "playing" | "stalled" | "unjudged";
  /** When the verdict began; for stalled, the instant the loop's allowance ran out. */
  since: string;
  /** Server receipt time of the latest media start the check had seen. */
  last_media_start_at?: string;
  /** The silence in seconds the loop allowed. Present with a stalled verdict. */
  threshold_s?: number;
  judged_at: string;
}

/** Screen.suspension: present while the screen shows a notice instead of its content. */
export interface ScreenSuspension {
  message: string;
  since: string;
}

/** Write body for POST /api/screens/{id}/identify; duration_ms is omitted so the server can default it (60000). */
export interface ScreenIdentifyWrite {
  duration_ms?: number;
}

/** Accepted POST /api/screens/{id}/identify. A Player acts on one identify_id at most once and ignores it after expires_at. */
export interface ScreenIdentifyAccepted {
  identify_id: string;
  duration_ms: number;
  expires_at: string;
}

/** Write body for POST /api/screens/{id}/suspend. */
export interface ScreenSuspendWrite {
  message: string;
}

/** Write body for POST /api/screens/{id}/replace: the screen whose paired device takes over the screen in the path. */
export interface ScreenReplaceWrite {
  with: string;
}

/** Write body for POST /api/screens/{id}/play-page. */
export interface ScreenPlayPageWrite {
  page_id: string;
}

/** Accepted POST /api/screens/{id}/play-page. The Player ignores the command after expires_at. */
export interface ScreenPlayPageAccepted {
  screen_id: string;
  playlist_id: string;
  page_id: string;
  manifest_revision: string;
  expires_at: string;
}

export type LiveState = "idle" | "requested" | "publishing" | "ended";

/** The Player's last live view report. connected is its own word, at most 45 seconds old. */
export interface LivePublisher {
  connected: boolean;
  connection: string;
  reported_at: string;
  width?: number;
  height?: number;
  fps?: number;
}

/** GET|POST /api/screens/{id}/live: the screen's live view session. Open schema. */
export interface LiveSession {
  state: LiveState;
  screen_id: string;
  live_id?: string;
  created_at?: string;
  lease_until?: string;
  max_until?: string;
  publisher?: LivePublisher;
  ended_at?: string;
  /** stopped, expired, consent_denied, consent_timeout, capture_failed, connection_failed or player_stopped; an open enum. */
  ended_reason?: string;
  /** The dashboard page that shows the live view of the screen. */
  viewer_url: string;
}

/** Write body for POST /api/screens/{id}/live; duration_s is omitted so the server can default it (300). */
export interface LiveStartRequest {
  duration_s?: number;
}

export type LiveFramesState = "starting" | "streaming" | "silent";

/** Accepted POST /api/screens/{id}/live/frames: how far the live session's frame adapter has come. Open schema. */
export interface LiveFrames {
  live_id: string;
  state: LiveFramesState;
  /** When a frame last arrived. Absent while starting. */
  last_frame_at?: string;
}

/**
 * Nested playlist identity for the manifest upgrade read model. `name` is
 * resolved by playlist id; null when unknown. revision is >= 1 and is the
 * user-facing version (Target v42 / Playing v41); the man_ revision strings
 * stay machine identity and diagnostics.
 */
export interface ScreenManifestUpgradePlaylist {
  id: string;
  name: string | null;
  revision: number;
}

/**
 * The screen's manifest upgrade read model, computed by the server on every
 * screen response. `desired_playlist` is the playlist identity and revision
 * the screen is moving to; `active_playlist` is the LAST SERVER-ACKNOWLEDGED
 * activation. The player's latest upgrade report drives
 * `state` (none when the screen has no desired manifest, pending before any
 * report); `code` is a safe static failure token, `retry_at` the actually
 * scheduled retry for `retrying` (failed never schedules one), and
 * `missing_page_count` counts whole excluded pages while `partial`. Offline is
 * never inferred as failure. Read-only.
 */
export interface ScreenManifestUpgrade {
  desired_revision: string | null;
  active_revision: string | null;
  desired_playlist: ScreenManifestUpgradePlaylist | null;
  active_playlist: ScreenManifestUpgradePlaylist | null;
  state: "none" | "pending" | "downloading" | "preparing" | "activating" | "retrying" | "failed" | "blocked" | "partial" | "current";
  code: string | null;
  attempt: number | null;
  retry_at: string | null;
  missing_page_count: number | null;
  state_since: string | null;
  reported_at: string | null;
}

export interface Screen {
  content_access_generation: number;
  created_at: string;
  /** The screen's link, when it has one. Never carries the url. */
  link?: ScreenLinkSummary;
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
  last_outage?: ScreenOutage;
  last_page_failure?: PageFailure;
  manifest_revision: number;
  observation?: ScreenObservation;
  /**
   * Manifest upgrade read model. Always present on screen responses once the
   * backend ships the feature; older backends omit it and readers render
   * defensively. `desired_revision` is the manifest the screen is moving to
   * and `active_revision` the last server-acknowledged activation. Read-only.
   */
  manifest_upgrade?: ScreenManifestUpgrade;
  /**
   * True while at least one paired runtime events stream is connected,
   * including a short reconnect window. Always present; false until first
   * connect. Read-only; not a player heartbeat.
   */
  online: boolean;
  /** Assigned default playlist. A takeover, a campaign that holds or a matching schedule entry takes precedence, in that order; effective_playlist names what is shown. */
  playlist_id?: string;
  /** Server-evaluated playlist schedule (never on the runtime manifest). */
  playlist_schedule?: ScreenPlaylistSchedule;
  /** The playlist that wins over campaigns, the schedule and the assignment. */
  takeover?: ScreenTakeover;
  /** What the runtime manifest is built from; absent when the screen shows no playlist. */
  effective_playlist?: ScreenEffectivePlaylist;
  /**
   * Opaque agent JSON object. Absent when unset. ScreenRig never reads or uses
   * it. Not on the runtime manifest and never authorization.
   */
  comments?: Record<string, unknown>;
  /** The fleet link that created this screen. Read-only; it stays after the link is deleted. */
  fleet_link_id?: string;
  /** The screen folder holding this screen (screen folder list); absent at the project root. Moved with POST /api/screens/move. */
  folder_id?: string;
  /**
   * The project's own values for this screen, such as a store number or a
   * region: up to 32 fields, names matching ^[a-z0-9_]{1,32}$, values of 1 to
   * 200 characters. Absent when none are set. Set by ScreenPatch. Card
   * placements read them through {screen.field.NAME} tokens. Never
   * authorization.
   */
  fields?: Record<string, string>;
  /**
   * Where the screen is. Absent when unset. Set by ScreenPatch. A card
   * placement reads it through the {screen.location} token, and screen list
   * filters by distance from a point. Never authorization.
   */
  location?: ScreenLocation;
  public_id: string;
  /** Read-only recovery offer awaiting confirmation. Absent once confirmed, lapsed, or claimed as a new screen. */
  recovery_pending?: ScreenRecoveryPending;
  /**
   * Present only while archived: what archived the screen. Known values are
   * project, device_reset, device_unpair, and replaced; readers keep a value
   * they do not know. Every reason but replaced keeps the device binding, so
   * unarchive resumes the display with no re-pairing; a replaced screen keeps
   * none and is deleted, not restored. Absent on screens archived before
   * reasons were recorded. Read-only.
   */
  archive_reason?: string;
  /** Present only while archived with archive_reason. Instant the screen was archived. Read-only. */
  archived_at?: string;
  /** Present when archive_reason is replaced: the screen this screen's device moved to (screen replace). Read-only. */
  replaced_by?: string;
  /** The reboots and reloads asked of this screen, oldest first, at most 10. Absent when it has none. Read-only: screen reboot and reload add to it, screen command cancel cancels a queued entry. */
  commands?: ScreenCommand[];
  /** Present while the screen shows a notice instead of its content (screen suspend). Read-only. */
  suspension?: ScreenSuspension;
  /** What the backend concluded about the screen's picture from the reports it received. A check with nothing to say is absent. Read-only. */
  glass?: ScreenGlass;
  /**
   * Present while the paired Player cannot show the application or iframe
   * primitives its manifest carries. at is when the condition began. The
   * manifest is unchanged; the Player drops those primitives. Read-only
   * project health metadata.
   */
  applications_unsupported?: ScreenApplicationsUnsupported;
  /**
   * Sanitized player storage report. Absent until the first accepted
   * PUT /screen/storage. Cleared on identity reset, unpair, and archive.
   * Readers treat received_at older than 24 hours as stale. Read-only.
   */
  storage?: ScreenStorage;
  health?: ScreenHealth;
  display?: ScreenDisplay;
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
   * IANA time zone identifier. Absent until it is set. Civil-time page visibility
   * bounds are evaluated in this zone; data-only predicates need no zone.
   */
  timezone?: string;
  updated_at: string;
  /** The video wall the screen's Player lays out. Absent when none. Set by ScreenPatch. */
  wall?: ScreenWall;
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
  /** An object sets the screen's video wall, null clears it. Needs a Player that declared display.wall (409 wall_unsupported otherwise). */
  wall?: ScreenWall | null;
  /**
   * Merges into the screen's fields: a string sets one, null removes it. A null
   * fields clears every field. Changing fields remints the manifest revision of
   * a screen that shows a playlist.
   */
  fields?: Record<string, string | null> | null;
  /** Replaces the whole location; null clears it. Changing it remints the manifest revision of a screen that shows a playlist. */
  location?: ScreenLocation | null;
}

/** Where a screen is, in decimal degrees: Screen.location and the ScreenPatch location. */
export interface ScreenLocation {
  /** -90 to 90. */
  latitude: number;
  /** -180 to 180. */
  longitude: number;
  /** The short place name a card shows, at most 40 characters. Absent when empty. */
  name?: string;
  /** Free text for people and agents, at most 200 characters. Absent when empty. */
  address?: string;
}

export type ScreenTags = string[];

/** POST /api/screens/actions selector: explicit ids (any state), every active screen with a tag, or every active screen in a folder and the folders inside it. */
export type ScreenActionSelector =
  | { by: "ids"; screen_ids: string[] }
  | { by: "tag"; tag: string }
  | { by: "folder"; folder_id: string };

/** One fleet action, discriminated by type. New action types are additive. */
export type ScreenAction =
  | { type: "assign"; playlist_id: string }
  | ({ type: "reload" } & ScreenCommandWrite)
  | ({ type: "toast" } & ScreenToastWrite)
  | { type: "set_tags"; tags: ScreenTags }
  | { type: "add_tags"; tags: string[] }
  | { type: "remove_tags"; tags: string[] }
  | { type: "takeover"; playlist_id: string; until?: string | null; reason?: string }
  | { type: "takeover_clear" }
  | { type: "set_playlist_schedule"; entries: ScreenScheduleEntryWrite[] }
  | { type: "clear_playlist_schedule" }
  | ({ type: "reboot" } & ScreenCommandWrite)
  | { type: "display"; power: "on" | "off"; until?: string | null }
  | { type: "display_clear" }
  | { type: "set_display_schedule"; enabled: boolean; windows: ScreenScheduleWindow[] }
  | { type: "clear_display_schedule" };

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
  reboot?: ScreenRebootAccepted;
  problem?: { type?: string; title?: string; status?: number; detail?: string; code?: string; [key: string]: unknown };
}

/** 200 answer of POST /api/screens/actions. Partial success is a normal answer. */
export interface ScreenActionResult {
  action: ScreenActionType;
  matched: number;
  succeeded: number;
  failed: number;
  results: ScreenActionScreenResult[];
  /** Continuation metadata from the backend-owned ScreenActionResult contract. */
  offset?: number;
  total?: number;
  next_cursor?: string;
}

/** PUT /api/comment/... body. Compact UTF-8 JSON of comments must be ≤ 1024 bytes. */
export interface CommentsWrite {
  comments: Record<string, unknown>;
}

/** GET/PUT /api/comment/... body. Null when the target exists and comments are unset. */
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
 * Write body for POST /api/screens/{id}/toast. Colours are player chrome
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
 * Accepted POST /api/screens/{id}/reload. The reload itself is the durable
 * per-screen player.reload event; a Player acts on one reload_id at most once
 * and ignores it after expires_at.
 */
export interface ScreenReloadAccepted {
  reload_id: string;
  expires_at: string;
  state: ScreenCommandDelivery;
}

/** shot_ plus 16 to 64 unpadded base64url characters. */
export type ScreenshotCaptureID = string;

/** Accepted POST /api/screens/{id}/screenshot. */
export interface ScreenScreenshotAccepted {
  capture_id: ScreenshotCaptureID;
  expires_at: string;
}

export type ScreenScreenshotState = "idle" | "pending" | "ready" | "timed_out" | "unavailable";

/** GET /api/screens/{id}/screenshot/status. Image bytes are never present. */
export interface ScreenScreenshotStatus {
  bytes?: number;
  capture_id?: ScreenshotCaptureID;
  captured_at?: string;
  expires_at?: string;
  /** What the backend read of this ready image: one frame, not a verdict about the screen. Absent when the image could not be read. */
  frame?: ScreenScreenshotFrame;
  height?: number;
  /** Present when state is unavailable. */
  reason?: "unsupported_surface" | "capture_failed";
  sha256?: string;
  state: ScreenScreenshotState;
  width?: number;
}

export interface ScreenScreenshotFrame {
  /** True when the image is one flat tone. A transition, or a page that is black on purpose, reads flat too. */
  flat: boolean;
  analyzed_at: string;
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
  /** The media folder the ready file lands in; omitted lands it at the library root. An uploader must send one of its folders. */
  folder_id?: string;
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

/** PATCH /api/media/{id}. Replace the tag set; null or [] clears it. */
export type MediaTagPatch = { tag: string | null } | { tags: string[] };

export type MediaGenerationAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
export type MediaGenerationQuality = "low" | "medium" | "high";

/** POST /api/media/generations. prompt is required; aspect_ratio and quality have server defaults. quality changes the image and the price. */
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

/**
 * POST /api/applications/uploads (a new application) and
 * POST /api/applications/{id}/uploads (a new release): the metadata a
 * streamed upload sends as headers. A release declaration carries no name.
 */
export interface ApplicationUploadDeclaration {
  name?: string;
  sha256: string;
  compressed_bytes: number;
  expanded_bytes: number;
  file_count: number;
  sdk_version?: string;
}

/**
 * 201 answer to an application upload declaration: one signed PUT of the
 * archive. `id` is the upload (and its operation); commit it with
 * POST /api/applications/uploads/{id}/commit.
 */
export interface ApplicationUploadSession extends MediaUploadSession {
  application_id: string;
  release_id: string;
}

/** POST /api/applications/uploads/{id}/commit names the declared archive again. */
export interface ApplicationUploadCommit {
  sha256: string;
  compressed_bytes: number;
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

/**
 * GET /api/applications/{application_id}/kv-webhooks: an incoming K/V
 * webhook. url is not secret; the secret is returned only by create and
 * rotate-secret.
 */
export interface KVWebhook {
  id: string;
  application_id: string;
  key: string;
  description: string;
  url: string;
  created_at: string;
  last_used_at?: string;
}

export interface KVWebhookWithSecret extends KVWebhook {
  secret: string;
}

export interface KVWebhookList {
  items: KVWebhook[];
}

export interface KVWebhookCreate {
  key: string;
  description?: string;
}

/**
 * /api/cards/{id}/kv-webhooks: an incoming webhook that writes a card's data
 * document. mapping is the template that builds the document from the posted
 * body, or null when the posted object is the document. The secret and the
 * signing secret are returned only by create, rotate-secret and the update that
 * turns signing on.
 */
export interface CardKVWebhook {
  id: string;
  card_id: string;
  description: string;
  mapping: Record<string, unknown> | null;
  enabled: boolean;
  signing: boolean;
  url: string;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
}

export interface CardKVWebhookWithSecrets extends CardKVWebhook {
  secret?: string;
  signing_secret?: string;
}

export interface CardKVWebhookList {
  items: CardKVWebhook[];
}

export interface CardKVWebhookCreate {
  description?: string;
  mapping?: Record<string, unknown> | null;
  signing?: boolean;
}

export interface CardKVWebhookUpdate {
  description?: string;
  mapping?: Record<string, unknown> | null;
  enabled?: boolean;
  signing?: boolean;
}

/** One post to a card webhook: how it ended and why, never what it carried. */
export interface KVWebhookDelivery {
  at: string;
  outcome: "written" | "unchanged" | "refused" | "invalid";
  reason?: "credentials" | "signature" | "disabled" | "body" | "mapping" | "card_data_invalid" | "rate_limited" | "payment_required" | "internal";
  detail?: string;
  status: number;
  bytes: number;
  revision?: number;
  request_id: string;
}

export interface KVWebhookDeliveryList {
  items: KVWebhookDelivery[];
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

/** Where staff stand on a submission; `open` until the first response. */
export type FeedbackStatus = "open" | "planned" | "waiting_on_user" | "fixed" | "declined" | "duplicate";

/** One immutable reply. An absent author identifies a staff reply. */
export interface FeedbackResponse {
  id: string;
  text: string;
  status: FeedbackStatus;
  /** The version that fixes it; present only with status fixed, when staff name one. */
  fixed_in?: string;
  created_at: string;
  author?: "staff" | "agent";
  author_id?: string;
}

/**
 * The submission's own fields never change after they are written, which is why
 * it carries no revision. `status` and `responses` track the conversation
 * appended beside them.
 */
export interface FeedbackSubmission {
  id: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  context?: FeedbackContext;
  created_at: string;
  status?: FeedbackStatus;
  responses?: FeedbackResponse[];
}

export interface FeedbackList {
  items: FeedbackSubmission[];
}

/**
 * GET /api/playback/plays JSON row. primitive_id and started_at are present
 * only when the Player reported them.
 */
export interface PlaybackPlay {
  media_id: string;
  page_id: string;
  playlist_id?: string;
  primitive: "image" | "video";
  primitive_id?: string;
  received_at: string;
  screen_id: string;
  started_at?: string;
}

export interface PlaybackPlayList {
  items: PlaybackPlay[];
  next_cursor: string | null;
}

export const TEMPORARY_PROTOCOL_VERSION = "screenrig.cli.adapter/0";

/** GET/PATCH /api/webhooks/{id}. The signing secret is never part of this shape. */
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
  /** True when url was withheld (empty) from a Read only credential: a receiver URL is often its only credential. */
  url_redacted?: boolean;
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

/** The screen state changes a notification fires on (NotificationCondition). */
export type NotificationCondition = "screen_offline" | "display_disconnected" | "running_hot" | "storage_full" | "content_stuck" | "not_playing" | "loop_stalled" | "glass_blank" | "glass_frozen" | "crashing";

/**
 * GET/PATCH /api/notifications/{id}: an email, webhook, Slack, Teams, PagerDuty
 * or Telegram notification. The signing secret and a chat or pager destination
 * are never part of this shape. Readers treat a channel they do not know as one
 * they cannot edit.
 */
export interface Notification {
  channel: string;
  conditions: string[];
  created_at: string;
  description?: string;
  disabled_at?: string;
  disabled_reason?: "delivery_failures";
  /** Slack, Teams, PagerDuty and Telegram only: the destination masked to its host and last four characters. */
  destination_hint?: string;
  enabled: boolean;
  /** Webhook only. */
  event_types?: string[];
  failing_since?: string;
  hold_minutes: number;
  id: string;
  last_failure_at?: string;
  last_success_at?: string;
  /** Email only: owner, or the user ids of project members. */
  recipients?: string[];
  revision: number;
  /** Empty means every screen. */
  screen_tags: string[];
  snoozed_until?: string;
  status: "active" | "failing" | "disabled";
  /** Telegram only: the chat messages go to. */
  telegram_chat_id?: string;
  /** Email only, and only while not empty: the people who stopped this notification's email with the unsubscribe link in it. They stay in recipients. */
  unsubscribed?: NotificationUnsubscription[];
  updated_at: string;
  /** Webhook only; empty with url_redacted true below effective Manage. */
  url?: string;
  url_redacted?: boolean;
}

/** A person who stopped an email notification's mail with the unsubscribe link in it. */
export interface NotificationUnsubscription {
  /** When the person stopped the notification's mail. */
  at: string;
  user_id: string;
}

/** Returned for a webhook only by create and rotate-secret (and their exact idempotent replay for 24 hours). */
export interface NotificationWithSecret extends Notification {
  secret: string;
}

export interface NotificationList {
  items: Notification[];
}

export interface NotificationWrite {
  channel: "email" | "webhook" | "slack" | "teams" | "pagerduty" | "telegram";
  conditions?: string[];
  description?: string;
  /** Slack, Teams, PagerDuty and Telegram only: the write-only webhook URL, routing key or bot token. */
  destination?: string;
  enabled?: boolean;
  event_types?: string[];
  hold_minutes?: number;
  recipients?: string[];
  screen_tags?: string[];
  /** Telegram only: the chat id or @channelname. */
  telegram_chat_id?: string;
  url?: string;
}

export interface NotificationPatch {
  conditions?: string[];
  /** An empty string clears the description. */
  description?: string;
  /** Slack, Teams, PagerDuty and Telegram only: replaces the credential. */
  destination?: string;
  enabled?: boolean;
  event_types?: string[];
  hold_minutes?: number;
  recipients?: string[];
  screen_tags?: string[];
  /** null ends the snooze. */
  snoozed_until?: string | null;
  /** Telegram only: replaces the chat. */
  telegram_chat_id?: string;
  url?: string;
}

export interface NotificationDelivery {
  attempts: number;
  completed_at?: string;
  /** A screen notice's condition; absent for an event delivery. */
  condition?: string;
  created_at: string;
  /** Email only: how many people the email reached. */
  emailed?: number;
  event_id: string;
  event_type: string;
  /** The group of screens this notice said: on the notice that opened it and the one that resolved it. */
  group?: NotificationDeliveryGroup;
  /** The group a notice belongs to, on every other notice of the group; those are skipped as grouped. */
  group_id?: string;
  id: string;
  last_attempt_at?: string;
  last_duration_ms?: number;
  /** A failure class, or why a skipped notice was not sent. */
  last_error?: string;
  last_status?: number;
  next_attempt_at?: string;
  notification_id: string;
  phase?: "opened" | "resolved";
  screen_id?: string;
  screen_name?: string;
  /** Email only: the delivery whose email carried this notice. */
  sent_with?: string;
  since?: string;
  state: "pending" | "succeeded" | "failed" | "skipped";
  test?: boolean;
}

/** A group of screens one notice stands for. Readers treat an attribute they do not know as one they cannot name. */
export interface NotificationDeliveryGroup {
  attribute: string;
  count: number;
  id: string;
  value: string;
}

export interface NotificationDeliveryList {
  items: NotificationDelivery[];
  next_cursor: string | null;
}

/** Who acknowledged an alert or created a mute. Readers treat a kind other than person or agent as unnamed. */
export interface AlertActor {
  id: string;
  kind: string;
  name?: string;
}

/** GET /api/alerts/{id}: one screen and one condition while it lasts. */
export interface Alert {
  acknowledged_at?: string;
  acknowledged_by?: AlertActor;
  /** Open, and not acknowledged, snoozed or muted. */
  attention: boolean;
  /** A NotificationCondition other than crashing. */
  condition: string;
  id: string;
  /** A current mute covers the screen. */
  muted: boolean;
  project_id?: string;
  resolved_at?: string;
  screen_id: string;
  screen_name?: string;
  since: string;
  /** Present on a snoozed alert; it needs attention again at this instant if still open. */
  snoozed_until?: string;
  state: "open" | "resolved";
}

/** GET /api/alerts: counts cover the whole project's open alerts, whatever the page and filters. */
export interface AlertList {
  counts: { attention: number; open: number };
  items: Alert[];
  next_cursor: string | null;
}

/** POST /api/alerts/{id}/acknowledge: until snoozes; absent, the alert stays acknowledged until it resolves. */
export interface AlertAcknowledge {
  until?: string;
}

export interface AlertMute {
  created_at: string;
  created_by?: AlertActor;
  id: string;
  note?: string;
  project_id?: string;
  screen_ids: string[];
  tags: string[];
  until: string;
}

export interface AlertMuteList {
  items: AlertMute[];
}

/** POST /api/alert-mutes: at least one screen id or tag, and until at most 30 days ahead. */
export interface AlertMuteWrite {
  note?: string;
  screen_ids?: string[];
  tags?: string[];
  until: string;
}

/**
 * GET/PATCH /api/fleet-links/{id}. url is a credential that creates screens;
 * a Read only credential receives it empty with url_redacted true.
 */
export interface FleetLink {
  created_at: string;
  enabled: boolean;
  /** When the link expires (UTC RFC 3339); absent means never. From then it creates and recovers no screens. */
  expires_at?: string;
  id: string;
  label: string;
  last_used_at?: string;
  max_screens?: number;
  playlist_id?: string;
  revision: number;
  /** Screens this link has created; recoveries are not counted. */
  screens_created: number;
  tags: ScreenTags;
  updated_at: string;
  url?: string;
  /** Present and true when url was withheld from a Read only credential. */
  url_redacted?: boolean;
  /** Fields each screen the link creates starts with; absent when none. */
  fields?: Record<string, string>;
}

/** The screen's link without its url (Screen.link). */
export interface ScreenLinkSummary {
  hint: string;
  created_at: string;
  last_used_at?: string;
}

/** A Player URL that opens one screen in a browser that keeps no storage. */
export interface ScreenLink extends ScreenLinkSummary {
  url?: string;
  /** Present and true when url was withheld from a Read only credential. */
  url_redacted?: boolean;
  /** Only on the answer to create: true when the new link replaced an earlier one. */
  replaced?: boolean;
}

export interface FleetLinkList {
  items: FleetLink[];
}

export interface FleetLinkWrite {
  label: string;
  enabled?: boolean;
  tags?: ScreenTags;
  playlist_id?: string;
  max_screens?: number;
  expires_at?: string;
  fields?: Record<string, string>;
}

export interface FleetLinkPatch {
  label?: string;
  enabled?: boolean;
  tags?: ScreenTags;
  /** null clears the playlist. */
  playlist_id?: string | null;
  /** null removes the cap. */
  max_screens?: number | null;
  /** null removes the expiry. */
  expires_at?: string | null;
  /** Replaces the whole preset; null clears it. */
  fields?: Record<string, string> | null;
}

/** Exactly one of tag and screen_ids. */
export interface TriggerTarget {
  tag?: string;
  screen_ids?: string[];
}

/** What the latest takeover change did; failed screens are retried. */
export interface TriggerAlertScreens {
  targeted: number;
  taken_over: number;
  cleared: number;
  skipped: number;
  failed: number;
  pending: boolean;
}

/** The trigger's latest alert, from the CAP message fields. */
export interface TriggerAlert {
  id: string;
  revision: number;
  state: "active" | "ended";
  ended_reason?: "cancelled" | "all_clear" | "cleared" | "expired";
  status: "Actual" | "Exercise";
  msg_type: "Alert" | "Update" | "Cancel";
  sender: string;
  identifier: string;
  event?: string;
  headline?: string;
  severity?: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown";
  urgency?: string;
  certainty?: string;
  until: string;
  media_id?: string;
  screens: TriggerAlertScreens;
  started_at: string;
  updated_at: string;
  ended_at?: string;
}

/** What an overlay trigger draws: the text card's static params (theme, accent, colours, alignment). */
export interface TriggerOverlayStyle {
  theme?: string;
  accent?: string | null;
  background?: "theme" | "none";
  backgroundColor?: string | null;
  textColor?: string | null;
  align?: "start" | "center";
}

/** One alert an overlay trigger holds; until is null when it is held until cleared. */
export interface TriggerOverlayAlert {
  id: string;
  label?: string;
  title?: string;
  message?: string;
  note?: string;
  until: string | null;
  started_at: string;
  updated_at: string;
  revision: number;
}

/** What the latest overlay fan-out did to the target screens. */
export interface TriggerOverlayScreens {
  targeted: number;
  holding: number;
  taken_over: number;
  removed: number;
  edge_taken: number;
  skipped: number;
  failed: number;
}

/** An overlay trigger's configuration and state. */
export interface TriggerOverlay {
  show: "bar" | "takeover";
  edge?: "top" | "bottom";
  style: TriggerOverlayStyle;
  mapping?: Record<string, unknown>;
  enabled: boolean;
  signing: boolean;
  card_id?: string;
  alerts: TriggerOverlayAlert[];
  screens: TriggerOverlayScreens;
  pending: boolean;
}

/**
 * GET /api/triggers/{id}: a CAP alert trigger or an overlay trigger. url and
 * username are not secret; the password is returned only by create and
 * rotate-secret.
 */
export interface Trigger {
  id: string;
  kind: "cap" | "overlay";
  label: string;
  target: TriggerTarget;
  default_for_seconds: number;
  pull?: TriggerPull;
  url: string;
  username: string;
  playlist_id?: string;
  alert?: TriggerAlert;
  overlay?: TriggerOverlay;
  last_received_at?: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface TriggerWithPassword extends Trigger {
  password: string;
  /** An overlay trigger that signs: shown once. */
  signing_secret?: string;
}

/** The answer of an update or a rotation: whichever secret it issued. */
export interface TriggerWithSecrets extends Trigger {
  password?: string;
  signing_secret?: string;
}

export interface TriggerList {
  items: Trigger[];
}

/** CapPull: the CAP sources the platform reads for a trigger and which alerts count; the server validates every member. */
export type TriggerPull = Record<string, unknown>;

export interface TriggerOverlayWrite {
  show: "bar" | "takeover";
  edge?: "top" | "bottom";
  style?: TriggerOverlayStyle;
  mapping?: Record<string, unknown>;
  signing?: boolean;
}

export interface TriggerWrite {
  kind?: "cap" | "overlay";
  label: string;
  target: TriggerTarget;
  default_for_seconds?: number;
  pull?: TriggerPull;
  overlay?: TriggerOverlayWrite;
}

/** PATCH /api/triggers/{id}: the members it carries change; pull, style and mapping take null to remove. */
export interface TriggerPatch {
  label?: string;
  target?: TriggerTarget;
  default_for_seconds?: number;
  pull?: TriggerPull | null;
  overlay?: {
    edge?: "top" | "bottom";
    style?: TriggerOverlayStyle | null;
    mapping?: Record<string, unknown> | null;
    enabled?: boolean;
    signing?: boolean;
  };
}

/** POST /api/triggers/{id}/test answers the receipt a CAP message gets. */
export interface TriggerReceipt {
  outcome: "shown" | "updated" | "ended" | "ignored" | "duplicate";
  trigger_id: string;
  alert?: TriggerAlert;
}

/** POST /api/triggers/{id}/test on an overlay trigger answers what a post to its URL gets. */
export interface TriggerOverlayReceipt {
  outcome: "shown" | "updated" | "unchanged" | "ended" | "ignored";
  trigger_id: string;
  alert_id?: string;
  until: string | null;
  active: number;
}

/** One post to an overlay trigger, as its seven-day log keeps it: never the body, headers or credentials. */
export interface TriggerDelivery {
  at: string;
  outcome: string;
  reason?: string;
  detail?: string;
  status: number;
  bytes: number;
  alert_id?: string;
  request_id: string;
}

export interface TriggerDeliveryList {
  items: TriggerDelivery[];
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
  source: "takeover" | "campaign" | "schedule" | "default" | "folder";
  /** The campaign id for source campaign, the schedule entry id for source schedule, the folder id for source folder. */
  entry_id?: string;
  until?: string;
}

/** A screen folder: screens sit in at most one (Screen.folder_id), and a folder targets its screens and those of every folder inside it. */
export interface ScreenFolder {
  project_id?: string;
  id: string;
  name: string;
  /** The folder holding this one; null at the project root. */
  parent_id: string | null;
  /** The playlist this folder's screens show when they have none of their own, unless a nearer folder sets one. Absent when unset. */
  default_playlist_id?: string;
  /** Live screens directly inside this folder. Present in the list. */
  screens?: number;
  /** Present in the answer of a PATCH that moved the folder or changed its default playlist. */
  levels?: ScreenLevelChanges;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ScreenFolderList {
  items: ScreenFolder[];
}

export interface ScreenFolderCreate {
  name: string;
  parent_id?: string | null;
  default_playlist_id?: string;
}

export interface ScreenFolderPatch {
  name?: string;
  /** null moves the folder to the project root. */
  parent_id?: string | null;
  /** null clears the default playlist. */
  default_playlist_id?: string | null;
}

/** One campaign (source campaign) or folder default playlist (source folder, id the folder) that screens enter or leave by moving. */
export interface ScreenLevelChange {
  source: "campaign" | "folder";
  id: string;
  name?: string;
  playlist_id: string;
  screens: number;
}

export interface ScreenLevelChanges {
  gained: ScreenLevelChange[];
  lost: ScreenLevelChange[];
}

/** POST /api/screens/move: at least one id across screen_ids and folder_ids, at most 1000 in all. */
export interface ScreenMove {
  /** Destination folder; null for the project root. */
  folder_id: string | null;
  screen_ids?: string[];
  folder_ids?: string[];
}

export interface ScreenMoveResult {
  screens: number;
  folders: number;
  levels: ScreenLevelChanges;
}

/**
 * CampaignAudience: exactly one member. all (every rule matches) and any (at
 * least one matches) nest at most 3 deep; {"all": []} is every screen.
 */
export interface CampaignAudience {
  all?: CampaignAudience[];
  any?: CampaignAudience[];
  tag?: string;
  screen_id?: string;
  /** The screens in this screen folder and every folder inside it. */
  folder?: string;
}

/** GET /api/campaigns/{id}: a content campaign. from and until are civil YYYY-MM-DDTHH:MM in each screen's timezone. */
export interface Campaign {
  project_id?: string;
  id: string;
  name: string;
  playlist_id: string;
  audience: CampaignAudience;
  from?: string;
  until?: string;
  windows?: ScreenScheduleWindow[];
  priority: number;
  paused: boolean;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface CampaignList {
  items: Campaign[];
}

export interface CampaignWrite {
  name: string;
  playlist_id: string;
  audience: CampaignAudience;
  from?: string;
  until?: string;
  windows?: ScreenScheduleWindow[];
  priority?: number;
  paused?: boolean;
}

export interface CampaignPatch {
  name?: string;
  playlist_id?: string;
  audience?: CampaignAudience;
  /** null clears from, until or windows. */
  from?: string | null;
  until?: string | null;
  windows?: ScreenScheduleWindow[] | null;
  priority?: number;
  paused?: boolean;
}

export type CampaignStanding = "playing" | "pending" | "waiting" | "ended" | "outranked" | "paused" | "blocked" | "not_in_audience";

/** One campaign's standing on one screen. */
export interface CampaignStatus {
  campaign_id: string;
  screen_id: string;
  screen_name?: string;
  status: CampaignStanding;
  /** Why a campaign is outranked (takeover, campaign) or blocked (no_default_playlist, no_timezone, playlist_unavailable). */
  reason?: "takeover" | "campaign" | "no_default_playlist" | "no_timezone" | "playlist_unavailable";
  /** The campaign that outranks this one. */
  by?: string;
  next_start?: string;
}

/** GET /api/campaigns/{id}/screens: counts cover the whole audience, items one page of it. */
export interface CampaignScreens {
  campaign_id: string;
  /** "audience", then one count per standing present. */
  counts: Record<string, number>;
  items: CampaignStatus[];
  next_cursor?: string;
}

/** GET /api/screens/{id}/campaigns: every campaign's standing on one screen, in precedence order. */
export interface ScreenCampaigns {
  screen_id: string;
  effective_playlist?: ScreenEffectivePlaylist | null;
  items: CampaignStatus[];
  /** Present with ?at= or ?to=: the screen explained at that instant. */
  at?: ScreenExplainAt;
}

export type ScreenVerdictName = "won" | "outranked" | "not_started" | "ended" | "outside_hours" | "off";

/** One takeover, campaign or schedule entry at the explained instant. */
export interface ScreenVerdict {
  kind: "takeover" | "campaign" | "schedule";
  /** The campaign id or schedule entry id; absent for a takeover. */
  id?: string;
  playlist_id: string;
  verdict: ScreenVerdictName;
  /** Why an off candidate does not apply. */
  reason?: "paused" | "not_in_audience" | "no_default_playlist" | "no_timezone" | "playlist_unavailable";
  /** The candidate that won over an outranked one. */
  by?: { kind: "takeover" | "campaign" | "schedule"; id?: string };
  /** When a takeover ends. */
  until?: string;
  next_start?: string;
}

/** A span of the timeline in which the playlist does not change. */
export interface ScreenTimelineSegment {
  from: string;
  to: string;
  playlist_id?: string;
  source: "takeover" | "campaign" | "schedule" | "default";
  entry_id?: string;
}

/** What an explanation declines to judge. */
export interface ScreenNotJudged {
  code: "configuration_history" | "playlist_content" | "page_rules" | "player_state" | "archived";
  detail: string;
}

/** The screen explained at one instant. */
export interface ScreenExplainAt {
  instant: string;
  timezone?: string;
  /** The instant on the screen's clock, YYYY-MM-DDTHH:MM. */
  local?: string;
  effective_playlist: ScreenEffectivePlaylist | null;
  verdicts: ScreenVerdict[];
  timeline?: ScreenTimelineSegment[];
  timeline_truncated?: boolean;
  not_judged: ScreenNotJudged[];
}

/** Backend-owned principals contracts mirrored from the reviewed snapshot. */
export interface OrganizationSummary { id: string; name: string }
export interface ProjectContext { in_token?: boolean; organization: OrganizationSummary; project: Project; owner_user_id?: string }
export interface ProjectContextList { projects: ProjectContext[] }
export interface ProjectCreate { name: string; organization_id?: string; organization_name?: string }
export type CreatedProject = ProjectContext;

/** Reviews: playlist and screen changes proposed under Propose access, and ad creatives. */
export type ReviewKind = "playlist_change" | "screen_change" | "ad_creative";
export type ReviewState = "pending" | "approved" | "rejected" | "changes_requested" | "withdrawn" | "superseded" | "stale";
/** media is the pending media item of a selector_refresh review. */
export interface ReviewSubject { type: "playlist" | "screen" | "creative" | "media"; id: string; name: string }
export interface ReviewImpact { screens: number }
export interface ReviewPerson { user_id: string; name: string }
export interface ReviewProposer {
  kind: "agent" | "client" | "buyer";
  agent_id?: string;
  agent_name?: string;
  client_id?: string;
  client_name?: string;
  project_id?: string;
  organization_name?: string;
  person?: ReviewPerson;
}
export interface ReviewDecider { user_id?: string; name?: string; agent_id?: string; agent_name?: string }
export interface ReviewPlaylistDiff {
  name_changed: boolean;
  pages_added: string[];
  pages_removed: string[];
  pages_changed: string[];
  soundtrack_changed: boolean;
  media_added: string[];
  media_removed: string[];
}
/** An approved playlist, or an open create or update proposal, whose tag, folder or all selectors start or stop playing pending media once approved. */
export interface ReviewMediaPlaylist { id: string; name: string; screens: number; media_added: string[]; media_removed: string[] }
/** A media item's tags (tag and tags as one sorted set) and folder; folder_id is empty at the library root. */
export interface ReviewMediaFields { tags: string[]; folder_id: string }
/** A media review's change: before is what was last approved, null for a new upload. */
export interface ReviewMediaChange { media_id: string; filename: string; before: ReviewMediaFields | null; after: ReviewMediaFields }
export interface ReviewPlaylistChange {
  operation: "create" | "update" | "selector_refresh";
  base_revision: number;
  applied_revision?: number;
  proposed: Record<string, unknown>;
  diff: ReviewPlaylistDiff;
  media_playlists?: ReviewMediaPlaylist[];
  /** selector_refresh only. */
  media_change?: ReviewMediaChange;
  previously_rejected_media?: string[];
}
export interface ReviewScreenChange {
  action: "assign" | "set_playlist_schedule" | "clear_playlist_schedule" | "takeover" | "takeover_clear";
  screens: { ids?: string[]; tag?: string; count_at_request: number };
  request: Record<string, unknown>;
  playlist_ids: string[];
  /** applying is true while some matched screens have no outcome yet. */
  result?: { matched: number; succeeded: number; failed: number; applying?: boolean };
}
/** A playlist review a screen change was proposed behind, as it stands now. */
export interface ReviewBlocker { id: string; state: ReviewState; subject: ReviewSubject }
export interface Review {
  id: string;
  kind: ReviewKind;
  state: ReviewState;
  subject: ReviewSubject;
  proposer: ReviewProposer;
  note?: string;
  url: string;
  created_at: string;
  updated_at: string;
  decided_at?: string;
  decided_by?: ReviewDecider;
  decision_note?: string;
  previous_review_id?: string;
  superseded_by?: string;
  blocked_by?: string[];
  /** GET /api/reviews/{id} only: each blocked_by review as it stands now. */
  blockers?: ReviewBlocker[];
  dependents?: string[];
  impact: ReviewImpact;
  playlist_change?: ReviewPlaylistChange;
  screen_change?: ReviewScreenChange;
  ad_creative?: { creative_id: string; creative_revision: number; campaign_id?: string; buyer_project_id?: string; content_path: string };
  preview?: { live: Record<string, unknown> | null; proposed: Record<string, unknown> };
}
export interface ReviewList { items: Review[]; next_cursor: string | null; pending_count: number }
export interface ReviewSummary { id: string; kind: "playlist_change" | "screen_change"; state: "pending"; url: string; subject: ReviewSubject; impact: ReviewImpact }
/** HTTP 202 from a review-class write under Propose access: the change is not on glass. */
export interface ReviewPending { status: "pending_review"; review: ReviewSummary; playlist?: Record<string, unknown>;
  /** A playlist write's warnings (PlaylistWarning items); the CLI lifts them into the envelope. */
  warnings?: unknown[] }
export interface ReviewDecisionResult { review: Review; dependents?: Array<{ id: string; state: ReviewState; problem?: Record<string, unknown> }> }
/** One seller's decision on one creative revision, as the buyer reads it on the creative. */
export interface AdvertisingCreativeReview {
  id: string;
  seller_project_id: string;
  creative_revision: number;
  campaign_id?: string;
  state: "pending" | "approved" | "rejected" | "changes_requested";
  reason?: string;
  created_at: string;
  decided_at?: string;
}
