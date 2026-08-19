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

export interface Account {
  content_limit_bytes: number;
  created_at: string;
  credit_remaining: number;
  id: string;
  reserved_bytes: number;
  revision: number;
  screen_count: number;
  screen_limit: number;
  status: "active" | "cancelled" | "deleted";
  updated_at: string;
  used_bytes: number;
}

export interface CLIEnrollment {
  account: Account;
  issuance_expires_at: string;
  issuance_id: string;
  token: string;
}

export interface CLIEnrollmentRequest {
  client_id: string;
  /** Present only when the operator supplies --beta-key or SCREENRIG_BETA_KEY. */
  beta_key?: string;
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
   * contract now requires it. It is the only handle a playlist placement
   * accepts, so report it rather than making the caller poll the operation.
   */
  release_id: string;
  operation_id: string;
}

export interface EventResource {
  [key: string]: unknown;
}

export interface AccountEvent {
  cursor: string;
  sequence: number;
  type: string;
  severity: string;
  resource?: EventResource;
  request_id?: string;
  operation_id?: string;
  message: string;
  details?: Record<string, unknown>;
  at: string;
}

export interface EventPage {
  items: AccountEvent[];
  next_cursor: string;
}

export interface Capabilities {
  /** Default-plan storage cap. Zero means no product storage cap. */
  account_content_bytes: 0;
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
  screens_per_account: 100;
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
 * JSON unchanged. Templated pages are the exception — the CLI expands
 * `template` + `slots` into an ordinary write page in `playlist-templates.ts`
 * and never sends `template` to the server. The contract's page, placement,
 * and content schemas are still not mirrored here except for the fields that
 * expander writes. Mirror a schema only when the CLI builds or reads its
 * fields.
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
 * report. Read-only on the account API; ScreenPatch cannot write it.
 */
export interface ScreenObservation {
  observed_at: string;
  surfaces: ScreenObservationSurface[];
}

export interface Screen {
  content_access_generation: number;
  created_at: string;
  id: string;
  label: string;
  manifest_revision: number;
  observation?: ScreenObservation;
  playlist_id?: string;
  public_id: string;
  revision: number;
  state: "pairing_pending" | "active";
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
 * for rather than sending undefined placeholders. Observation is not a
 * patchable field.
 */
export interface ScreenPatch {
  name?: string;
  playlist_id?: string;
  timezone?: string;
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

/** shot_ plus 16 to 64 unpadded base64url characters. */
export type ScreenshotCaptureID = string;

/** Accepted POST /api/v1/screens/{id}/screenshot. */
export interface ScreenScreenshotAccepted {
  capture_id: ScreenshotCaptureID;
  expires_at: string;
}

export type ScreenScreenshotState = "idle" | "pending" | "ready" | "timed_out";

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
  content_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "video/mp4" | "video/webm";
  sha256: string;
}

export interface MediaUploadDeclaration {
  bytes: number;
  content_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "video/mp4" | "video/webm";
  filename: string;
  sha256: string;
  /** Optional mutable query tag. Stored on the ready object, not redeclared at commit. */
  tag?: string;
}

/** PATCH /api/v1/media/{id}. tag is required; null clears it. */
export interface MediaTagPatch {
  tag: string | null;
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
