import { requireCapability, validateProjectCapabilities } from "./project-capabilities.js";
import { cardExpiry } from "./card-expiry.js";
import { withCardPreview } from "./card-preview.js";
import { RESOURCE_ID_PATTERNS, isResourceID } from "./generated/resource-ids.js";
import { newIdempotencyKey } from "./ids.js";
import { apexHost } from "./apex-origin.js";
import { replacePlaylistRelease } from "./playlist-release.js";
import { assertOutputAvailable, readAuthoringJson, readAuthoringText, writeAuthoringJson, writeOutputFile } from "./authoring-input.js";
import { publishScreen } from "./screen-publish.js";
import { fleetHumanLines, fleetOutcome, rejectFleetRevision, screenActionResult, SCREEN_FOLDER_ID_PATTERN, screenFolderId, screenTag, screenTagList, screenTarget, selectorFlags, folderSubtree, SCREEN_TAGS_MAX, type FleetItem } from "./screen-fleet.js";
import { canonicalPairingCode } from "./pairing-code.js";
import { playlistAnswerWarnings, playlistWarnings, hasFramingRefusal, withoutAnswerWarnings } from "./playlist-warnings.js";
import { editablePlaylist, isAdSlotPage, preparePlaylist, shortApplicationPageWarning, targetDimensions } from "./playlist-authoring.js";
import { callPlaylist } from "./playlist-api.js";
import { WriteRecovery } from "./write-recovery.js";
import { cacheProjectContexts, clearResultContext, contextFromProject, formatResultContext, projectName as validateDisplayName, resultContext, setResultContext, validateProjectContext } from "./project-context.js";
import { projectConfigFor, withProjectConfig, assertProjectCredential } from "./project-state.js";
import { instantInZone, LEVEL_IDLE_DEFAULT_S, normalizeInstant, assignmentLine, playlistInUseProblem, scheduleEntries, scheduleTableLines, screenControlProblem, takeoverForProblem, takeoverLine, takeoverReason, takeoverUntil, effectivePlaylistText } from "./screen-control.js";
import { AGGREGATE_MAX_DAYS, CsvStreamFailure, PLAYBACK_CSV_IDLE_TIMEOUT_MS, PLAYS_SETTLE_MS, unusedPath, PLAYS_ALL_MAX_PAGES, PLAYS_LIMIT_MAX, csvByteStream, csvRecord, isoUtc, playbackExportBudget, playsCursor, playsInstant, playsLimit, playsRange, requireCsvResponse, writeCsvFile, writeCsvStdout } from "./playback-export.js";
import { wallCanvas, wallFromFlags, wallLine, wallProblem } from "./screen-wall.js";
import { fieldMap, screenFactsLines, screenFactsPatch, screenFieldsCell, screenListFacts, screenLocationCell } from "./screen-facts.js";
import { displayLines, displayPower, displayProblem, displayScheduleWrite, displayUntil, playPageProblem, rebootProblem } from "./screen-display.js";
import { commandCancelProblem, commandLines, commandResultText, expiresInSeconds, identifyDurationMs, identifyProblem, replaceProblem, replacedByLines, suspendMessage, suspendProblem, suspensionLines } from "./screen-commands.js";
import { flatFrameNote, frameRow, glassLines } from "./screen-glass.js";
import { LIVE_WAIT_DEFAULT_MS, liveDurationSeconds, liveEndedError, liveHumanLines, liveNotReadyWarning, liveProblem, liveScreenId, liveSessionBody, liveWaitMs, settleLive } from "./screen-live.js";
import { LIVE_FRAME_INTERVAL_DEFAULT_MS, captureLiveFrames, liveFrameIntervalMs, liveFrameLeaseSeconds, liveFramesHumanLines, resolveFrameOutput } from "./screen-live-frame.js";
import type { LiveSession, LiveStartRequest } from "./adapters/protocol.js";
import { healthChangesText, healthLines, screenHealthIssues } from "./screen-health.js";
import { outageLines } from "./screen-outage.js";
import { anyManifestUpgrade, manifestUpgradeCell, manifestUpgradeLines } from "./screen-manifest-upgrade.js";
import { forecastStorageWarnings, isStorageFailureCode, screenStorageWarnings, storageFullWarning } from "./screen-storage.js";
import { openTempFile, removeOnSignal, shellQuote, tempPathFor } from "./temp-file.js";
import { KV_WEBHOOK_ID_PATTERN, KV_WEBHOOK_MAPPING_MAX_BYTES, KV_WEBHOOK_SECRET_PATTERN, KV_WEBHOOK_SIGNING_SECRET_PATTERN, type KvWebhookTarget, cardWebhookExample, cardWebhookLines, cardWebhookSigningWarning, cardWebhookTableLines, kvWebhookDeliveryTableLines, kvWebhookDescription, kvWebhookExample, kvWebhookId, kvWebhookKey, kvWebhookLines, kvWebhookMapping, kvWebhookProblem, kvWebhookSecretWarning, kvWebhookTableLines, kvWebhookTargetFlag, kvWebhooksPath } from "./kv-webhooks.js";
import {
  TRIGGER_ID_PATTERN, TRIGGER_MAPPING_MAX_BYTES, TRIGGER_PASSWORD_PATTERN, TRIGGER_SIGNING_SECRET_PATTERN, alertLines, overlayLines, triggerDeliveryTableLines, triggerExample,
  triggerHoldSeconds, triggerId, triggerLines, triggerMapping, triggerName, triggerPasswordWarning, triggerProblem, triggerScreenIds, triggerSigningWarning, triggerStyle,
  triggerTableLines, triggerTag,
} from "./triggers.js";
import { CAMPAIGN_AUDIENCE_INPUT_MAX_BYTES, campaignAllScreensAudience, campaignAnyTagAudience, campaignAudienceJson, campaignFolder, campaignFolderAudience, campaignBounds, campaignExplainLines, campaignId, campaignLines, campaignName, campaignPlaylistId, campaignProblem, campaignScreenAudience, campaignScreenId, campaignScreensLines, campaignTableLines, campaignTagAudience, campaignWindowList, campaignDateList, campaignDisplayList, campaignMonthlyList } from "./campaigns.js";
import { androidProvisioning, fetchManagedArtifact, fleetLinkSecret, PROVISIONING_NOTICE, siteOrigin, unsupportedSiteError } from "./android-provisioning.js";
import { fleetLinkExpiresAt, fleetLinkId, fleetLinkLines, fleetLinkMaxScreens, fleetLinkName, fleetLinkPlaylistId, fleetLinkProblem, fleetLinkRedactedNote, fleetLinkTableLines, fleetLinkUrlLines, fleetLinkUrlProblem, guardFleetLink, guardFleetLinks } from "./fleet-links.js";
import { WEBHOOK_ID_PATTERN, deliveryTableLines, webhookDeliveriesLimit, webhookDeliveryCursor, webhookDescription, webhookEventTypes, webhookId, webhookLines, webhookProblem, webhookSecretWarning, webhookTableLines, webhookUrl } from "./webhooks.js";
import { NOTIFICATION_CHAT_CHANNELS, NOTIFICATION_ID_PATTERN, notificationConditions, notificationDeliveryCursor, notificationDeliveryTableLines, notificationDestination, notificationHold, notificationId, notificationLines, notificationProblem, notificationRecipients, notificationUserId, notificationSecretWarning, notificationTableLines, snoozedUntil } from "./notifications.js";
import { alertEnd, alertId, alertMuteId, alertMuteLines, alertMuteTableLines, alertNote, alertProblem, alertScreenId, alertsCursor, alertsLimit, screenAlertLines, screenAlertListLines } from "./alerts.js";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { memoryConfigFs } from "./memory-config.js";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  limitsFromCapabilities,
  TEMPORARY_PROTOCOL_VERSION,
  type Alert,
  type AlertAcknowledge,
  type AlertList,
  type AlertMute,
  type AlertMuteList,
  type AlertMuteWrite,
  type Project,
  type ProjectEvent,
  type Invitation,
  type InvitationIssued,
  type Agent,
  type AgentDisconnectRequest,
  type Capabilities,
  type CLIEnrollmentOAuth,
  type CLIEnrollmentRequest,
  type ProjectContextList,
  type ProjectCreate,
  type CreatedProject,
  type EventPage,
  type MediaRecord,
  type FeedbackContext,
  type FeedbackKind,
  type FeedbackList,
  type FeedbackSubmission,
  type FeedbackWrite,
  type KVEntry,
  type MediaGeneration,
  type MediaGenerationAspectRatio,
  type MediaGenerationQuality,
  type MediaGenerationRequest,
  type MediaTagPatch,
  type Operation,
  type OperationAccepted,
  type PairScreen,
  type PairingClaim,
  type BrowserLinkClaim,
  type BrowserLinkClaimRequest,
  type EnrollmentIntent,
  type HostContext,
  type ProvisionScreen,
  type Screen,
  type ScreenAction,
  type ScreenActionRequest,
  type ScreenActionSelector,
  type ScreenFolder,
  type ScreenCommandWrite,
  type ScreenIdentifyAccepted,
  type ScreenIdentifyWrite,
  type ScreenPatch,
  type ScreenProvisioning,
  type ScreenReloadAccepted,
  type ScreenReplaceWrite,
  type ScreenSuspendWrite,
  type ScreenScreenshotAccepted,
  type ScreenScreenshotFrame,
  type ScreenScreenshotStatus,
  type ScreenStorageForecastDryRun,
  type ScreenStorageForecastRequest,
  type ScreenToastAccepted,
  type ScreenToastLevel,
  type ScreenToastWrite,
  type ScreenPlaylistScheduleView,
  type ScreenPlaylistScheduleWrite,
  type ScreenTakeoverWrite,
  type PlaybackPlay,
  type ScreenDisplayScheduleView,
  type ScreenRebootAccepted,
  type ScreenPlayPageAccepted,
  type ScreenPlayPageWrite,
  type PlaybackPlayList,
  type FleetLink,
  type FleetLinkList,
  type FleetLinkPatch,
  type FleetLinkWrite,
  type Trigger,
  type TriggerDeliveryList,
  type TriggerList,
  type TriggerOverlayReceipt,
  type TriggerPatch,
  type TriggerPull,
  type TriggerReceipt,
  type TriggerTarget,
  type TriggerWithSecrets,
  type TriggerWrite,
  type Campaign,
  type CampaignAudience,
  type CampaignList,
  type CampaignPatch,
  type CampaignScreens,
  type CampaignWrite,
  type ScreenCampaigns,
  type CardKVWebhook,
  type CardKVWebhookCreate,
  type CardKVWebhookList,
  type CardKVWebhookUpdate,
  type CardKVWebhookWithSecrets,
  type KVWebhook,
  type KVWebhookCreate,
  type KVWebhookDeliveryList,
  type KVWebhookList,
  type KVWebhookWithSecret,
  type Notification,
  type NotificationDelivery,
  type NotificationDeliveryList,
  type NotificationList,
  type NotificationPatch,
  type NotificationWithSecret,
  type NotificationWrite,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryList,
  type WebhookList,
  type WebhookPatch,
  type WebhookWithSecret,
  type WebhookWrite,
  type AdvertisingCreativeReview,
  type Review,
  type ReviewDecisionResult,
  type ReviewList,
  type ReviewPending,
} from "./adapters/protocol.js";
import { SDK_PROTOCOL_VERSION } from "./adapters/sdk-injection.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "./command-input.js";
import { projectStreamQuery } from "./project-routing.js";
import { ApiClient, RequestIds, requireToken, type ListAllOptions } from "./client.js";
import { HEALTH_DEFAULT_WINDOW_MS, HEALTH_HOURLY_MAX_DAYS, HEALTH_RAW_MAX_DAYS, PRESENCE_DEFAULT_WINDOW_MS, PRESENCE_MAX_DAYS, SERIES_PAGE_SIZE, UPTIME_MAX_DAYS, seriesWindow } from "./series.js";
import {
  preserveLogSocket,
  resolveConfig,
  describeTokenPresence,
  hasToken,
  isRetiredCredential,
  readConfigFile,
  sameCredential,
  withConfigLock,
  writeConfigAtomic,
  type ScreenRigConfig,
} from "./config.js";
import { attachOperationLogger, loggerOf, loggingTransport } from "./log/index.js";
import { accessClaims, accessFromScope, accessLabel, ACCESS_LEVELS, isServiceClientId, isSessionJwt, readKeyFile, SCOPE_IDENTITY, serviceCredentialsFromEnv, type AccessLevel, type ServiceClientCredentials } from "./oauth.js";
import {
  accessFields,
  PENDING_REVIEW_SENTENCE,
  pendingReviewLines,
  pendingReviewOf,
  pendingReviewWarning,
  plainText,
  reviewDetailLines,
  reviewListLines,
  reviewNext,
  reviewNoteHeaders,
} from "./reviews.js";
import { OAuthSession, refreshExpiryDays, type SessionRuntime } from "./oauth-session.js";
import { DeviceLogin, type LoginOutcome } from "./login.js";
import { ensureCredential } from "./enrollment.js";
import {
  headerValue,
  CREDITS_REMAINING_HEADER,
  observeCreditsRemaining,
  parseCreditsInteger,
} from "./credits.js";
import { successEnvelope, type ProblemNext, type Warning } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { iframeSnippetSource } from "./iframe-snippet.js";
import { CliError, configError, fileError, makeProblem, networkError, notEnrolledError, parseRetryAfter, unexpectedResponseError, usageError } from "./problems.js";
import type { HttpMethod, Transport } from "./transport/types.js";
import { packDirectory } from "./pack/index.js";
import type { CliRuntime } from "./runtime.js";
import { FetchTransport } from "./transport/http.js";
import { parseSse } from "./sse.js";
import { kvWriteFromArgs } from "./kv-write.js";
import { commentsWriteFromArgs } from "./comments-write.js";
import { quotedRevision } from "./if-match.js";
import { screenLinkSummaryLines } from "./screen-link-format.js";
import { applicationNameHeaders, normalizeApplicationName } from "./application-name.js";
import { directApplicationUploads, uploadApplicationDirect } from "./app-upload.js";
import { assertPlaylistValid, PLAYLIST_SERVER_CHECKS, playlistLint } from "./playlist-validate.js";
import { assertWirePages } from "./playlist-write-validation.js";
import { playlistNeedsTimezone } from "./generated/playlist-write-semantics.js";
import { uploadMediaFile, type MediaUploadTiming } from "./media-upload.js";
import { runMediaUploadBatch, UPLOAD_BATCH_DEFAULT_CONCURRENCY, UPLOAD_BATCH_MAX_CONCURRENCY, UPLOAD_BATCH_MIN_CONCURRENCY } from "./media-upload-batch.js";
import { clearProvisionRetryState, provisionRetryState } from "./provisioning-state.js";
import { clearGenerateRetryState, generateRequestHash, generateRetryState } from "./media-generate-retry.js";
import { formatBytes } from "./media/progress.js";
import {
  reportCatalogLines, reportFilters, reportKind, reportQuery, reportRecipients, reportSchedule, reportSubscriptionId, reportTableLines, subscriptionLines, subscriptionListLines,
} from "./reports.js";
import { runProjectExport, type ExportApi } from "./project-export.js";
import { downloadReportFile, downloadToFile, reportFileResult, reportFormat, wantsReportFile, type ReportFormat } from "./report-export.js";
import { isPlayerScreenPath, validateProvisioningUrls } from "./provisioning-url.js";
import { aspectMismatchWarnings } from "./aspect-mismatch.js";
import {
  browserHandoffUrl,
  browserSetupRetryState,
  clearBrowserSetupRetryState,
  normalizeBrowserSetupCode,
} from "./browser-setup.js";
import { isSensitiveKey, isSensitiveValue, redactEvent, redactText } from "./redact.js";
import {
  cwebpLookup,
  ffmpegLookup,
  resolveCwebpToolchain,
  resolveFfmpegToolchain,
  type CwebpToolchain,
  type FfmpegToolchain,
} from "./media/ffmpeg.js";
import { createProgressReporter, silentProgressReporter, type ProgressReporter } from "./media/progress.js";
import {
  DEFAULT_CODEC,
  DEFAULT_MAX_FPS,
  DEFAULT_WEBP_QUALITY,
  MAX_EDGE,
  type TranscodeCodec,
  type TranscodeOptions,
} from "./media/transcode.js";
import { exportPlaylistBundle, importPlaylistBundle } from "./playlist-bundle.js";
import { agentPlatform, validateAgent, validateAgentSelfStatus } from "./agent-identity.js";
import {
  AGENT_SELF_PATH,
  NOTE_INPUT_MAX_BYTES,
  NOTE_MATCHED_OPEN,
  NotesApi,
  matchedOpenNote,
  noteBody,
  noteDetailLines,
  noteId,
  noteListLines,
  noteReason,
  notesHint,
  notesHintWarning,
  parseNoteAbout,
  parseNoteTtl,
  resourceNoteLines,
  resourceNotesWarning,
  reviewWarning,
  selfNoteCounts,
  selfNotesField,
  type Note,
  type NoteAboutType,
  type NoteCounts,
  type NoteList,
  type NoteState,
} from "./agent-notes.js";
import { CLI_VERSION, cliDistribution } from "./version.js";
import { cardId, cardUid, cardProperties, cardDetailsHuman, validatePlaylistCards, feedQuery, type CardDetails, type CardSummary } from "./cards.js";
import { runApply, ONLY_KINDS, type ApplyOptions, type OnlyKind } from "./migrate/apply.js";
import { chooseDir, describeVendor, findVendor, sortedVendors, vendorHttpFor, vendorLines } from "./migrate/cli.js";
import { loadCredentials } from "./migrate/credentials.js";
import { openLocalFiles } from "./migrate/local-files.js";
import { runPair } from "./migrate/pair.js";
import { reportLines as migrationReportLines } from "./migrate/report.js";
import { runScan } from "./migrate/scan.js";

export { CLI_VERSION };

export interface CommandResult {
  envelope: ReturnType<typeof successEnvelope<unknown>>;
  exitCode: ExitCode;
  human: string;
  /** Help defaults to text; streams have already emitted their output. */
  output?: "help" | "stream";
  /**
   * Set when the answer cannot be fetched again except by replay (a webhook
   * signing secret). The saved write key is kept until the output boundary has
   * flushed this result; it then calls afterOutput to clear it.
   */
  keepRecoveryUntilOutput?: boolean;
  afterOutput?: () => Promise<void>;
}

function nonemptyEnv(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One plain ASCII addr-spec with an unquoted local part and dotted DNS domain. */
function isPlainContactEmail(email: string): boolean {
  const parts = email.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  const localValid = local.length > 0 && local.length <= 64
    && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..")
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local);
  const labels = domain.split(".");
  const domainValid = labels.length >= 2 && labels.every((label) => label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
  return email.length >= 3 && email.length <= 254 && parts.length === 2 && localValid && domainValid;
}

function enrollmentEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("agent enroll requires --email ADDRESS for unverified project contact metadata.");
  }
  if (!isPlainContactEmail(email)) {
    throw usageError("agent enroll --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}

/**
 * One AgentID claim code: `agid_` plus at least 128 bits of base32 or
 * base64url. The code is never echoed back, so errors name only the flag.
 */
function agentidClaim(value: string | undefined): string {
  const claim = value?.trim();
  if (!claim) {
    throw usageError("agent enroll requires --agentid-claim CODE.");
  }
  if (!/^agid_[A-Za-z0-9_-]{43}$/.test(claim)) {
    throw usageError("agent enroll --agentid-claim must be an AgentID claim code: agid_ followed by 43 base64url characters.");
  }
  return claim;
}

/**
 * The AgentID sign-in route lives on the configured API host, derived from the
 * configured API URL the way the dashboard and browser-setup helpers derive
 * their origins. An unsupported origin yields no URL rather than a broken next
 * action.
 */
function agentidSignInUrl(apiUrl: string): string | undefined {
  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return undefined;
  }
  const supported = api.protocol === "https:" || (api.protocol === "http:" && api.hostname.endsWith(".localhost"));
  return supported ? `${api.origin}/agentid/start` : undefined;
}

/** invitations create targets an existing project and never enrolls as a side effect. */
function invitationEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("invitations create requires --email ADDRESS.");
  }
  if (!isPlainContactEmail(email)) {
    throw usageError("invitations create --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}
/** dashboard reset-sign-in is unauthenticated and targets the project's owner contact address. */
function signInResetEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("dashboard reset-sign-in requires --email ADDRESS.");
  }
  if (!isPlainContactEmail(email)) {
    throw usageError("dashboard reset-sign-in --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}

/** agent enroll --intent names the project purpose; omitted keeps the signage default. */
function enrollmentPurpose(value: string | undefined): EnrollmentIntent | undefined {
  const intent = value?.trim();
  if (!intent) return undefined;
  if (intent !== "signage" && intent !== "advertising") {
    throw usageError("agent enroll --intent must be signage or advertising.");
  }
  return intent;
}

/**
 * agent enroll --setup-code: the code the website shows with its setup prompt,
 * two groups of four letters and digits. It only names a website visit and
 * grants nothing, so any case and a missing hyphen are accepted and the server
 * receives upper-case XXXX-XXXX. Errors name the shape, never the input.
 */
function enrollmentSetupCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const code = value.trim();
  if (!/^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code)) {
    throw usageError("agent enroll --setup-code must be a setup code: two groups of four letters and digits, such as K7QX-2MPD.");
  }
  const bare = code.replace("-", "").toUpperCase();
  return `${bare.slice(0, 4)}-${bare.slice(4)}`;
}

function transportFor(runtime: CliRuntime, apiUrl: string, token?: string): Transport {
  const base = runtime.transport ?? new FetchTransport(apiUrl, token);
  return loggingTransport(base, loggerOf(runtime));
}

/** The invocation's OAuth session: access-token renewal and logout. */
const oauthSessions = new WeakMap<CliRuntime, OAuthSession>();

function sessionRuntime(runtime: CliRuntime): SessionRuntime {
  return { fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }, now: runtime.now, sleep: runtime.sleep, logger: loggerOf(runtime) };
}

function oauthSessionFor(runtime: CliRuntime, resolved: { configPath: string; apiUrl: string }): OAuthSession {
  let session = oauthSessions.get(runtime);
  if (!session) {
    session = new OAuthSession(resolved.configPath, resolved.apiUrl, transportFor(runtime, resolved.apiUrl), sessionRuntime(runtime), serviceCredentials.get(runtime));
    oauthSessions.set(runtime, session);
  }
  return session;
}

/** A stream's bearer, renewed before each (re)connect: an agent stream closes when its access token expires. */
async function streamToken(runtime: CliRuntime, token: string): Promise<string> {
  const claims = accessClaims(token);
  const session = oauthSessions.get(runtime);
  if (!session || !claims?.sid) return token;
  return (await session.accessFor(undefined)) ?? token;
}

/**
 * Commands that read credentials without requiring a project credential up
 * front. They renew credentials like authenticated ones; local commands never
 * touch the network for it.
 */
const CREDENTIAL_COMMANDS = new Set(["project list", "project use", "agent status"]);

/** Commands that send a stored credential, besides authenticated and credential commands. */
const STORED_CREDENTIAL_COMMANDS = new Set(["logout", "agent enroll", "agent disconnect", "agent revoke-identity"]);

/** A config that holds only a token from before sign-in: no request accepts it, so nothing is sent. */
function credentialRetiredError(): CliError {
  return new CliError(makeProblem("credential_retired", "Credential retired", 401,
    "This installation's stored credential is no longer accepted. Run screenrig login to sign it in; a person approves it in the dashboard. To create a new project instead, screenrig agent enroll --email ADDRESS --organization NAME replaces it. Nothing was sent.", {
      next: { command: "screenrig login", reason: "Signs this installation in; a person approves it in the dashboard." },
    }), ExitCode.Auth);
}

/** Commands that act on the identity rather than the selected project. */
const IDENTITY_COMMANDS = new Set(["project list", "project use", "project create", "project token"]);

const writeRecoveries = new WeakMap<CliRuntime, WriteRecovery>();

const invocationRequestIds = new WeakMap<CliRuntime, RequestIds>();
const invocationTargets = new WeakMap<CliRuntime, ResolvedCommandConfig>();

/** One RequestIds per invocation, so `--request-id` reaches only the first HTTP request however many clients a command builds. */
function requestIdsFor(runtime: CliRuntime, args: ParsedArgs): RequestIds {
  let ids = invocationRequestIds.get(runtime);
  if (!ids) {
    ids = new RequestIds(flagString(args.flags, "request-id"));
    invocationRequestIds.set(runtime, ids);
  }
  return ids;
}

export function clientFor(runtime: CliRuntime, args: ParsedArgs, apiUrl: string, token?: string, recovery?: WriteRecovery): ApiClient {
  return new ApiClient({
    transport: transportFor(runtime, apiUrl, token),
    token,
    auth: oauthSessions.get(runtime),
    projectId: token && token === invocationTargets.get(runtime)?.token ? invocationTargets.get(runtime)?.projectId : undefined,
    requestIds: requestIdsFor(runtime, args),
    idempotencyKey: flagString(args.flags, "idempotency-key"),
    timeoutMs: flagNumber(args.flags, "timeout"),
    writeRecovery: recovery ?? (token ? writeRecoveries.get(runtime) : undefined),
    creditsOwner: runtime,
    logger: loggerOf(runtime),
  });
}

export function jsonBody(
  response: { body: unknown; headers: Record<string, string> },
  requestId: string,
  extra?: Record<string, unknown>,
  warnings: Warning[] = [],
) {
  const body = (response.body ?? {}) as Record<string, unknown>;
  return successEnvelope(
    extra ? { ...body, ...extra } : body,
    {
      request_id: (body.request_id as string | undefined) ?? response.headers["x-request-id"] ?? requestId,
      operation_id: body.operation_id as string | undefined,
      warnings: [...warnings, ...(response.headers.warning ? [{ code: "server_warning", message: response.headers.warning }] : [])],
    },
  );
}

/** The --note of a review-class write as its request header. */
export function reviewNoteFrom(args: ParsedArgs): Record<string, string> {
  return reviewNoteHeaders(flagString(args.flags, "note"));
}

/**
 * A review-class write that became a review under Propose access (HTTP 202
 * pending_review): a success, exit 0, data is the answer plus next.
 */
export function pendingReviewResult(response: { body: unknown; headers: Record<string, string> }, pending: ReviewPending, requestId: string, extra?: Record<string, unknown>): CommandResult {
  const lifted = playlistAnswerWarnings(response.body);
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, requestId, { ...extra, next: reviewNext(pending.review.id) }, [pendingReviewWarning(pending.review), ...lifted]),
    exitCode: ExitCode.Success,
    human: [...pendingReviewLines(pending.review), ...lifted.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}

/**
 * A playlist write that applied live. The answer's warnings (a page the
 * Player web app cannot frame) move from data into the envelope's warnings and
 * the human output, so an agent reads them like every other warning.
 */
export function playlistWriteResult(response: { body: unknown; headers: Record<string, string> }, requestId: string, title: string): CommandResult {
  const lifted = playlistAnswerWarnings(response.body);
  return {
    envelope: jsonBody({ ...response, body: withoutAnswerWarnings(response.body) }, requestId, undefined, lifted),
    exitCode: ExitCode.Success,
    human: [title, ...lifted.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}

function humanLines(title: string, fields: Array<[string, string | undefined]>): string {
  const lines = [title];
  for (const [key, value] of fields) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

function streamEnvelope(runtime: CliRuntime, data: unknown, requestId: string) {
  const context = resultContext(runtime);
  return { ...successEnvelope(data, { request_id: requestId }), ...(context ? { context } : {}) };
}

export type CommandHandler = (args: ParsedArgs, runtime: CliRuntime) => Promise<CommandResult>;
type ResolvedCommandConfig = Awaited<ReturnType<typeof resolveConfig>>;

/** A service client's credentials for this invocation (SCREENRIG_CLIENT_ID mode). */
const serviceCredentials = new WeakMap<CliRuntime, ServiceClientCredentials>();

/** Commands that act as an agent installation; a service-client run has none. */
const AGENT_ONLY_COMMANDS = new Set(["login", "logout", "project token", "agent enroll", "agent connect", "agent disconnect", "agent revoke-identity"]);

/**
 * SCREENRIG_CLIENT_ID mode: the run authenticates as a service client. Its
 * config, lock and token live in memory for this invocation only, so the
 * stored config is neither read nor written.
 */
function withServiceClient(run: CommandHandler): CommandHandler {
  return async (args, runtime) => {
    const service = await serviceCredentialsFromEnv(runtime.env, (file) => readFile(file, "utf8"));
    if (!service) return run(args, runtime);
    const command = args.command.slice(0, 2).join(" ");
    if (AGENT_ONLY_COMMANDS.has(command) || AGENT_ONLY_COMMANDS.has(args.command[0] ?? "")) {
      throw usageError(`${command} acts as an agent installation; this run is a service client because SCREENRIG_CLIENT_ID is set. Nothing was sent.`);
    }
    const root = path.join(tmpdir(), `screenrig-service-${process.pid}-${randomBytes(8).toString("hex")}`);
    const stored = runtime.fs;
    runtime.fs = memoryConfigFs(stored, root);
    serviceCredentials.set(runtime, service);
    try {
      return await run({ ...args, flags: { ...args.flags, config: path.join(root, "config.json") } }, runtime);
    } finally {
      runtime.fs = stored;
      serviceCredentials.delete(runtime);
    }
  };
}

/** The next step for an installation without a credential: sign in, enroll, or resume a pending enrollment. */
function missingCredentialError(resolved: ResolvedCommandConfig): CliError {
  if (resolved.signedOut) {
    return notEnrolledError("This installation is signed out.", {
      command: "screenrig login",
      reason: "Sign this installation in again; a person approves it in the dashboard.",
    });
  }
  if (resolved.lastAgent) {
    return notEnrolledError("This installation is disconnected and cannot run project commands.", {
      command: "screenrig agent enroll --email ADDRESS --organization NAME",
      reason: "Ask the user for their contact email, then create a new project agent. Use screenrig login only when the user asked to join an existing project.",
    });
  }
  return notEnrolledError("This installation is not enrolled. Enrollment is an explicit step and is never a side effect of another command.", {
    command: resolved.enrollment
      ? "screenrig agent enroll"
      : "screenrig agent enroll --email ADDRESS --organization NAME",
    reason: resolved.enrollment
      ? "Resume the exact pending enrollment before running pairing or another project command."
      : "Create the first agent with unverified contact metadata, then retry the original command.",
  });
}

/** Bind context to the selected project, or the token's sole project. */
async function resolveProjectContext(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<ResolvedCommandConfig> {
  const projects = accessClaims(resolved.token)?.projects;
  if (projects && !resolved.projectId) {
    const ids = Object.keys(projects);
    if (ids.length !== 1) return resolved;
    resolved = { ...resolved, projectId: ids[0], projectName: undefined, organizationId: undefined, organizationName: undefined };
  }
  // clientFor must route the context read and subsequent work to this target.
  invocationTargets.set(runtime, resolved);
  if (!resolved.projectName || !resolved.organizationName) {
    const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
    const response = await client.call({ method: "GET", path: "/api/project" });
    const context = contextFromProject(response.body as Project);
    if (resolved.projectId && context.project.id !== resolved.projectId) throw configError("Project credential resolved to a different project.");
    resolved = await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
    invocationTargets.set(runtime, resolved);
  }
  return resolved;
}

/** Prepare configuration, logging and credential guidance once for a bound leaf. */
export function commandHandler(
  handler: (args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig) => Promise<CommandResult>,
  authenticated = true,
): CommandHandler {
  const run: CommandHandler = async (args, runtime) => {
    const repair = flagBool(args.flags, "repair-config");
    let resolved = await resolveConfig({ flags: args.flags, fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }, repair });
    if (args.command[0] === "project" && args.command[1] === "create" && resolved.identityToken && !flagString(args.flags, "project-id")) {
      const current = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
      if (!resolved.projectId || Object.keys(current?.identity_writes ?? {}).length) {
        resolved = { ...resolved, token: resolved.identityToken, projectId: undefined, projectName: undefined,
          organizationId: undefined, organizationName: undefined, identityWriteScope: true };
      }
    }
    await attachOperationLogger(runtime, args, resolved);
    const commandName = args.command.slice(0, 2).join(" ");
    // agent enroll replaces a retired credential itself (agentEnroll).
    if (resolved.retiredCredential && commandName !== "agent enroll" && (authenticated || CREDENTIAL_COMMANDS.has(commandName)
      || STORED_CREDENTIAL_COMMANDS.has(commandName) || STORED_CREDENTIAL_COMMANDS.has(args.command[0] ?? ""))) {
      throw credentialRetiredError();
    }
    const session = oauthSessionFor(runtime, resolved);
    if (authenticated || CREDENTIAL_COMMANDS.has(commandName)) {
      try {
        resolved = await session.prepare(resolved, { identity: IDENTITY_COMMANDS.has(commandName) });
      } catch (error) {
        oauthSessions.delete(runtime);
        throw error;
      }
    }
    invocationTargets.set(runtime, resolved);
    setResultContext(runtime, resolved);
    if (authenticated && !resolved.token) {
      oauthSessions.delete(runtime);
      throw missingCredentialError(resolved);
    }
    // Specialized enrollment, generation, upload/bundle, and handoff flows own
    // their recovery. Ordinary mutations share the durable request ledger.
    const [group, action] = args.command;
    // Sign-in reset is unauthenticated but still retains a durable retry key.
    const ordinary = (group === "dashboard" && action === "reset-sign-in")
      || Boolean(authenticated && resolved.token && (
        ["kv", "card", "comment", "feedback", "support", "operations", "notes"].includes(group ?? "") ||
        (group === "app" && ["upload", "update", "rename"].includes(action ?? "")) ||
        (group === "playlist" && ["create", "update", "patch", "rename", "delete", "promote"].includes(action ?? "")) ||
        (group === "reviews" && action === "withdraw") ||
        (group === "media" && ["update", "delete", "restore", "version"].includes(action ?? "")) ||
        // A screenshot is an observation: every run requests a new capture.
        (group === "screen" && !["provision", "publish", "screenshot"].includes(action ?? "")) ||
        group === "invitations" || group === "webhooks" || group === "notifications" || group === "alerts" || group === "source" || group === "fleet-links" || group === "triggers" || group === "campaign" || (group === "project" && ["rename", "create"].includes(action ?? ""))
      ));
    let recovery: WriteRecovery | undefined;
    try {
      if (authenticated && resolved.token && args.command[0] !== "agent"
        && !(args.command[0] === "project" && ["list", "create", "use"].includes(args.command[1] ?? ""))) {
        resolved = await resolveProjectContext(args, runtime, resolved);
      }
      recovery = ordinary ? new WriteRecovery(resolved, runtime, args.command.slice(0, 2).join(" ")) : undefined;
      if (recovery) writeRecoveries.set(runtime, recovery);
      let result = await handler(args, runtime, resolved);
      const expiring = signInExpiryWarning((await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }).catch(() => undefined))?.oauth, runtime.now());
      if (expiring && result.output !== "stream") {
        result = { ...result, envelope: { ...result.envelope, warnings: [...(result.envelope.warnings ?? []), expiring] } };
      }
      const owner = (result.envelope.data as { project_id?: unknown } | undefined)?.project_id;
      if (typeof owner === "string" && owner !== resolved.projectId) clearResultContext(runtime);
      const context = resultContext(runtime);
      const contextual = context ? { ...result, envelope: { ...result.envelope, context }, human: result.output === "stream" ? result.human : `${formatResultContext(runtime)}${result.human ? "\n" + result.human : ""}` } : result;
      if (recovery && result.keepRecoveryUntilOutput) {
        const retainedRecovery = recovery;
        return { ...contextual, afterOutput: () => retainedRecovery.finish() };
      }
      await recovery?.finish();
      return contextual;
    } catch (caught) {
      const error = caught instanceof CliError && caught.problem.code === "insufficient_access" && serviceCredentials.get(runtime)
        ? serviceClientAccessRefusal(caught)
        : caught;
      if (recovery?.hasPending && error instanceof CliError) {
        // Only an unknown outcome (timeout, network, 5xx) keeps a replayable key.
        // A refusal or a local validation error means a rerun must start afresh.
        const status = error.problem.status;
        if (typeof status === "number" && status < 500 && status !== 408) {
          await recovery.finish();
          throw error;
        }
        throw new CliError(error.problem, error.exitCode, [...error.warnings, {
          code: "write_recovery_saved",
          message: "The outcome of this write is unknown, so its key is saved locally. Rerun the same command with unchanged input to reuse it; the server returns work that already happened instead of repeating it. screenrig recovery list shows writes still unresolved.",
        }]);
      }
      throw error;
    } finally {
      writeRecoveries.delete(runtime);
      invocationRequestIds.delete(runtime);
      invocationTargets.delete(runtime);
      oauthSessions.delete(runtime);
    }
  };
  return withServiceClient(run);
}

/**
 * 403 insufficient_access for a service client: it cannot sign in again, so
 * the login next action does not apply; its level is chosen when it is
 * created. A cap hint or a write's own hint (no login next) stays as it is.
 */
function serviceClientAccessRefusal(error: CliError): CliError {
  if (error.problem.next?.argv?.[0] !== "login") return error;
  const { next: _login, ...problem } = error.problem;
  return new CliError({ ...problem, hint: "This service client's access level cannot do this. Its access is chosen when it is created (service-client create --access manage)." }, error.exitCode, error.warnings);
}

export const handleVersion: CommandHandler = async () => {
  const distribution = cliDistribution();
  return {
    envelope: successEnvelope({ version: CLI_VERSION, protocol_adapter: TEMPORARY_PROTOCOL_VERSION, distribution }),
    exitCode: ExitCode.Success,
    human: `screenrig ${CLI_VERSION}\nDistribution: ${distribution.kind}\n${distribution.agent_setup}`,
  };

};

export const handlePlaylistValidate = commandHandler(async (args, runtime, resolved) => {
  const file = args.positionals[2];
  if (!file) throw usageError("playlist validate requires one JSON file.");
  let parsed: Record<string, unknown>;
  try { parsed = await readAuthoringJson(file, runtime); }
  catch { throw usageError("Cannot read playlist JSON."); }
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.pages)) assertWirePages(parsed.pages);
  const body = parsed;
  assertPlaylistValid(body);
  const lint = playlistLint(body);
  const shortApplication = shortApplicationPageWarning(body);
  return {
    envelope: successEnvelope({ valid: true, scope: "local_schema_and_semantics", server_checks: PLAYLIST_SERVER_CHECKS, lint }, { warnings: shortApplication ? [shortApplication] : [] }),
    exitCode: ExitCode.Success,
    human: [
      "Playlist passed local canonical validation. Reference authorization and runtime readiness require server checks.",
      ...(shortApplication ? [`warning: ${shortApplication.message}`] : []),
      ...lint.map((item) => `lint: ${item.page_id} ${item.code} ${item.id}`),
    ].join("\n"),
  };
}, false);

export const handleDoctor = commandHandler(doctor, false);

export const handleAppPack = commandHandler(appPack, false);

export const handleAgentStatus = commandHandler(agentStatus, false);

/** `agent connect` is an alias of `screenrig login` for one release. */
const AGENT_CONNECT_ALIAS: Warning = {
  code: "command_renamed",
  message: "agent connect is now screenrig login; this alias is kept for one release. Run screenrig login.",
};

export const handleAgentConnect = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "agent.connect", message: "agent connect" }, async () => {
    if (flagBool(args.flags, "cancel")) {
      const stored = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
      if (!stored?.login) {
        throw usageError("This installation has no pending sign-in to cancel; nothing was sent.", {
          command: "screenrig agent status", reason: "Shows this installation's credential state.",
        });
      }
      await new DeviceLogin(oauthSessionFor(runtime, resolved), resolved.configPath, sessionRuntime(runtime)).clear(stored.login.id);
      const result: CommandResult = { envelope: successEnvelope({ status: "cancelled" }), exitCode: ExitCode.Success, human: "Pending sign-in cancelled." };
      return { ...result, envelope: { ...result.envelope, warnings: [AGENT_CONNECT_ALIAS] } };
    }
    const warnings: Warning[] = [AGENT_CONNECT_ALIAS];
    if (flagString(args.flags, "capability") !== undefined) {
      warnings.push({ code: "capability_chosen_at_approval", message: "The person approving the sign-in chooses its capabilities; --capability was not sent." });
    }
    return login(args, runtime, resolved, {
      project: flagString(args.flags, "target-project-id"),
      access: "manage",
      // agent connect returns pending by default; --wait waits for approval.
      wait: flagBool(args.flags, "wait"),
      warnings,
    });
  });
}, false);

export const handleLogin = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "login", message: "login" }, () => {
    const access = (flagString(args.flags, "access") ?? "manage") as AccessLevel;
    if (!ACCESS_LEVELS.includes(access)) throw usageError("login --access must be read, propose or manage.");
    return login(args, runtime, resolved, {
      project: flagString(args.flags, "project"),
      access,
      wait: !flagBool(args.flags, "no-wait"),
      resume: flagString(args.flags, "resume"),
      warnings: [],
    });
  });
}, false);

export const handleLogout = commandHandler(logout, false);

interface ServiceClientView {
  id: string;
  name: string;
  access: AccessLevel;
  effective_access?: AccessLevel;
  access_limited_by?: "project" | "person";
  state: "active" | "revoked";
  capabilities: string[];
  keys: Array<{ kid: string; alg: string }>;
  secrets: Array<{ id: string; hint: string }>;
  last_used_at?: string;
  upload_scope?: { playlist_ids: string[]; folder_ids: string[] };
}

function serviceClientId(args: ParsedArgs, verb: string): string {
  const id = args.positionals[2];
  if (!isServiceClientId(id)) throw usageError(`service-client ${verb} requires a service client id (scl_...) from service-client list.`);
  return id;
}

function serviceClientLines(client: ServiceClientView): Array<[string, string | undefined]> {
  return [
    ["id", client.id],
    ["name", client.name],
    ...accessFields(client).lines,
    ["state", client.state],
    ["capabilities", client.capabilities.join(", ")],
    ["keys", client.keys.map((key) => `${key.kid} (${key.alg})`).join(", ") || undefined],
    ["secrets", client.secrets.map((secret) => `${secret.id} (…${secret.hint})`).join(", ") || undefined],
    ["last_used_at", client.last_used_at],
    ...(client.upload_scope ? [["uploader", `folders ${client.upload_scope.folder_ids.join(", ")}; playlists ${client.upload_scope.playlist_ids.join(", ") || "none"}`] as [string, string]] : []),
  ];
}

/** A public JWK from --key-file; a private key file contributes only its public half. */
async function serviceKeyFromFile(args: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown> | undefined> {
  const file = flagString(args.flags, "key-file");
  if (file === undefined) return undefined;
  let text: string;
  try { text = await readFile(path.resolve(runtime.cwd(), file), "utf8"); } catch (error) { throw fileError(`Cannot read --key-file ${file}.`, error); }
  return (await readKeyFile(text)).publicKey as Record<string, unknown>;
}

/**
 * A new secret goes to a new 0600 file, never to stdout. The file is created
 * before the request, so an unwritable path fails before a secret exists. The
 * handle that created it stays open and receives the secret, so a path swapped
 * for a link or another file in the meantime is never written through.
 */
async function reserveSecretFile(args: ParsedArgs, runtime: CliRuntime): Promise<{ path: string; write(secret: string): Promise<void>; discard(): Promise<void> } | undefined> {
  const file = flagString(args.flags, "secret-file");
  if (file === undefined) return undefined;
  const target = path.resolve(runtime.cwd(), file);
  let handle;
  try { handle = await open(target, "wx", 0o600); } catch (error) { throw fileError(`Cannot create --secret-file ${file}; it must not exist yet.`, error); }
  return {
    path: target,
    write: async (secret) => {
      try { await handle.writeFile(`${secret}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    },
    discard: async () => {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
    },
  };
}

async function serviceClientWrite(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, request: { path: string; body?: Record<string, unknown>; title: string },
  secretFile?: Awaited<ReturnType<typeof reserveSecretFile>>): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "POST", path: request.path, ...(request.body ? { body: request.body } : {}) });
  } catch (error) {
    await secretFile?.discard();
    throw error;
  }
  const result = response.body as { client: ServiceClientView; secret?: string; propagation?: string };
  if (secretFile) {
    if (typeof result.secret !== "string") {
      await secretFile.discard();
      throw unexpectedResponseError("The server created no secret.", client.requestId);
    }
    try {
      await secretFile.write(result.secret);
    } catch (error) {
      throw fileError(`The secret was created but could not be written to ${secretFile.path}. Remove it with service-client remove-secret and add another.`, error);
    }
  }
  return {
    envelope: successEnvelope({ client: result.client, ...(secretFile ? { secret_file: secretFile.path } : {}), ...(result.propagation ? { propagation: result.propagation } : {}) },
      { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(request.title, [...serviceClientLines(result.client), ["secret_file", secretFile?.path], ["propagation", result.propagation]]),
  };
}

export const handleServiceClientList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/service-clients" });
  const items = (response.body as { items?: ServiceClientView[] }).items ?? [];
  return { envelope: successEnvelope({ items }, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: items.map((item) => `${item.id}  ${item.name}  ${accessLabel(item.access)}${item.effective_access && item.effective_access !== item.access ? ` (acts as ${accessLabel(item.effective_access)})` : ""}  ${item.state}`).join("\n") || "No service clients." };
});

export const handleServiceClientShow = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/service-clients/${id}` });
  return { envelope: successEnvelope(response.body, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: humanLines("Service client", serviceClientLines(response.body as ServiceClientView)) };
});

export const handleServiceClientCreate = commandHandler(async (args, runtime, resolved) => {
  const name = flagString(args.flags, "name");
  if (!name || name.length > 80) throw usageError("service-client create requires --name with 1-80 characters.");
  const key = await serviceKeyFromFile(args, runtime);
  if (!key && flagString(args.flags, "secret-file") === undefined) {
    throw usageError("service-client create needs --key-file PATH (a public key, recommended) or --secret-file PATH (a generated secret), or both.");
  }
  const capabilities = flagString(args.flags, "capability")?.split(",");
  const access = flagString(args.flags, "access");
  const uploader = flagBool(args.flags, "uploader");
  if (!uploader && (flagString(args.flags, "folder-id") !== undefined || flagString(args.flags, "playlist-id") !== undefined)) {
    throw usageError("--folder-id and --playlist-id require --uploader.");
  }
  if (uploader && capabilities?.some((capability) => capability !== "content" && capability !== "playlists")) {
    throw usageError("An uploader client holds the content and playlists capabilities only.");
  }
  // The client's own access applies to an uploader client (Propose unless chosen), so --access is not part of the scope.
  const scope = uploader ? uploadScopeFromArgs(args, "service-client create --uploader", false) : undefined;
  const secretFile = await reserveSecretFile(args, runtime);
  return serviceClientWrite(args, runtime, resolved, { path: "/api/service-clients", title: "Service client created", body: {
    name, ...(capabilities ? { capabilities } : {}), ...(access ? { access } : {}), ...(key ? { key } : {}), ...(secretFile ? { secret: true } : {}),
    ...(scope ? { upload_scope: scope } : {}),
  } }, secretFile);
});

export const handleServiceClientAddKey = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "add-key");
  const key = await serviceKeyFromFile(args, runtime);
  if (!key) throw usageError("service-client add-key requires --key-file PATH.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/keys`, body: { key }, title: "Key added" });
});

export const handleServiceClientAddSecret = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "add-secret");
  if (flagString(args.flags, "secret-file") === undefined) throw usageError("service-client add-secret requires --secret-file PATH; the secret is written only there.");
  const secretFile = await reserveSecretFile(args, runtime);
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/secrets`, title: "Secret added" }, secretFile);
});

export const handleServiceClientRemoveKey = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "remove-key");
  const kid = flagString(args.flags, "kid");
  if (!kid || kid.length > 200) throw usageError("service-client remove-key requires --kid KID from service-client show.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/keys/${encodeURIComponent(kid)}/remove`, title: "Key removed" });
});

export const handleServiceClientRemoveSecret = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "remove-secret");
  const secretId = flagString(args.flags, "secret-id");
  if (!secretId || !/^css_[A-Za-z0-9_-]+$/.test(secretId)) throw usageError("service-client remove-secret requires --secret-id css_... from service-client show.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/secrets/${secretId}/remove`, title: "Secret removed" });
});

export const handleServiceClientRevoke = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "revoke");
  if (!flagBool(args.flags, "yes")) throw usageError("service-client revoke requires --yes. Revocation is permanent: the client's keys and secrets are deleted and its tokens end.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/revoke`, title: "Service client revoked" });
});

/** The device sign-in. */
async function login(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig,
  request: { project?: string; access: AccessLevel; wait: boolean; resume?: string; warnings: Warning[] }): Promise<CommandResult> {
  if (request.project !== undefined && !isResourceID(request.project, "project")) throw usageError("login --project must be a project ID (prj_...).");
  const name = flagString(args.flags, "name");
  if (name && name.length > 80) throw usageError("login --name is at most 80 characters.");
  const session = oauthSessionFor(runtime, resolved);
  const device = new DeviceLogin(session, resolved.configPath, sessionRuntime(runtime));
  const outcome: LoginOutcome = await device.run({
    access: request.access,
    ...(request.project ? { project: request.project } : {}),
    ...(name ? { name } : {}),
    platform: agentPlatform(),
    version: CLI_VERSION,
    wait: request.wait,
    ...(request.resume !== undefined ? { resume: request.resume } : {}),
  }, (pending, resumed) => {
    runtime.stderr.write(`${resumed ? "Still waiting" : "Sign-in started"}: open ${pending.verification_uri_complete} and confirm the code ${pending.user_code}. It expires at ${pending.expires_at}.\n`);
  });
  const pending = outcome.login;
  if (outcome.status === "pending") {
    const resume = ["login", "--resume", pending.id];
    return {
      envelope: successEnvelope({
        status: "pending",
        login_id: pending.id,
        user_code: pending.user_code,
        verification_uri: pending.verification_uri,
        verification_uri_complete: pending.verification_uri_complete,
        expires_at: pending.expires_at,
        access: pending.access,
        ...(pending.project_id ? { project_id: pending.project_id } : {}),
        next: { command: `screenrig ${resume.join(" ")}`, argv: resume, reason: "After the person approves the sign-in, this stores its tokens." },
      }, { warnings: request.warnings }),
      exitCode: ExitCode.Success,
      human: humanLines(outcome.resumed ? "Sign-in pending" : "Sign-in started", [
        ["open", pending.verification_uri_complete],
        ["code", pending.user_code],
        ["expires_at", pending.expires_at],
        ["next", `screenrig ${resume.join(" ")}`],
      ]),
    };
  }
  const signedIn = await resolveConfig({ flags: { ...(typeof args.flags.config === "string" ? { config: args.flags.config } : {}), ...(typeof args.flags["api-url"] === "string" ? { "api-url": args.flags["api-url"] } : {}) },
    fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir } });
  const token = requireToken(signedIn.token);
  const client = clientFor(runtime, args, signedIn.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/project" });
  const context = contextFromProject(response.body as Project);
  await cacheProjectContexts(runtime, signedIn, [context], { credential: token });
  const access = accessFromScope(outcome.scope);
  const self = await selfStatusFor(runtime, args, signedIn.apiUrl, token);
  // The grant's scope names the level; the server reports what caps it now.
  const levels = accessFields({ access, effective_access: self?.effective_access, access_limited_by: self?.access_limited_by });
  return withNotesHint({
    envelope: successEnvelope({
      status: "signed_in",
      project: context.project,
      organization: context.organization,
      ...levels.data,
      identity: outcome.scope.includes(SCOPE_IDENTITY),
      ...(outcome.agentId ? { agent_id: outcome.agentId } : {}),
    }, { request_id: client.requestId, warnings: request.warnings }),
    exitCode: ExitCode.Success,
    human: humanLines("Signed in", [
      ["project", `${context.organization.name} / ${context.project.name} (${context.project.id})`],
      ...levels.lines,
    ]),
  }, self ? selfNoteCounts(self) : undefined);
}

async function logout(_args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const { revoked } = await oauthSessionFor(runtime, resolved).logout();
  return {
    envelope: successEnvelope({ status: "signed_out", revoked }),
    exitCode: ExitCode.Success,
    human: revoked ? "Signed out. The sign-in is revoked and its tokens were removed from this config." : "Already signed out.",
  };
}

export const handleAgentEnroll = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "agent.enroll", message: "agent enroll" }, () =>
    agentEnroll(args, runtime, resolved),
  );
}, false);

export const handleAgentDisconnect = commandHandler(agentDisconnect, false);
export const handleAgentRevokeIdentity = commandHandler(agentRevokeIdentity, false);

export const handleProjectShow = commandHandler(projectShow);
export const handleProjectList = commandHandler(projectList, false);
export const handleProjectCreate = commandHandler(projectCreate);
export const handleProjectUse = commandHandler(projectUse, false);
export const handleProjectMoves = commandHandler(projectMoves);
export const handleProjectMove = commandHandler(projectMove);
export const handleProjectOwnerTransfer = commandHandler(projectOwnerTransfer);
export const handleProjectDeletionPreview = commandHandler(projectDeletionPreview);
export const handleProjectDelete = commandHandler(projectDelete);

export const handleProjectCapabilities = commandHandler(projectCapabilities);

export const handleProjectRename = commandHandler(projectRename);
export const handleOrganizationList = commandHandler(async (args, runtime, resolved) => {
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const response = await client.call({ method: "GET", path: "/api/organizations" });
  const body = response.body as { organizations?: Array<{ id: string; name: string; admin: boolean; free?: boolean; plan_required?: boolean }>; new_organization_allowed?: boolean };
  if (!Array.isArray(body?.organizations) || body.organizations.some(org => !org || !/^(?:(?:stage|qa|development)_)?org_[A-Za-z0-9_-]+$/.test(org.id) || typeof org.name !== "string" || typeof org.admin !== "boolean")) throw configError("Organization list does not match the contract.");
  const tags = (org: { admin: boolean; free?: boolean; plan_required?: boolean }) => [org.admin && "admin", org.free === true && "free", org.plan_required === true && "plan required"].filter(Boolean).join(", ");
  const lines = body.organizations.map(org => `${validateDisplayName(org.name, "Organization name")}: ${org.id}${tags(org) ? ` (${tags(org)})` : ""}`);
  if (body.new_organization_allowed === false) lines.push("New organization: add projects to an existing organization; another needs Premium or Enterprise.");
  return { envelope: successEnvelope(body, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: lines.join("\n") || "No visible organizations." };
}, false);
export const handleOrganizationRename = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id || !/^(?:(?:stage|qa|development)_)?org_[A-Za-z0-9_-]+$/.test(id)) throw usageError("organization rename requires an organization ID.");
  const name = validateDisplayName(args.positionals[3], "Organization name");
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const response = await client.call({ method: "PATCH", path: `/api/organizations/${encodeURIComponent(id)}`, body: { name } });
  const organization = response.body as { id: string; name: string };
  if (organization?.id !== id || validateDisplayName(organization.name, "Organization name") !== name) throw configError("Organization rename response does not match this request.");
  const listed = await accessibleProjects(args, runtime, identity);
  await cacheProjectContexts(runtime, identity, listed.projects, { identityToken: identity.identityToken });
  return { envelope: successEnvelope({ organization }, { request_id: client.requestId }), exitCode: ExitCode.Success, human: `Organization renamed: ${name} (${id})` };
}, false);
export const handleSignInReset = commandHandler(signInReset, false);

export const handleDashboard = commandHandler(dashboardCommand, false);

export const handleAppUpload = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "app.upload", message: "app upload" }, () =>
    appUpload(args, runtime, resolved, false),
  );
}, true);

export const handleAppUpdate = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "app.update", message: "app update" }, () =>
    appUpload(args, runtime, resolved, true),
  );
}, true);

export const handleAppList = commandHandler(async (args, runtime, resolved) => {
  return simpleList(args, runtime, resolved, "/api/applications", "Applications");
}, true);

export const handleAppShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("app show requires an application id.");
  return simpleGet(args, runtime, resolved, `/api/applications/${id}`, "Application");
}, true);

export const handleAppRename = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const name = normalizeApplicationName(flagString(args.flags, "name") ?? "");
  if (!id || !name) throw usageError("app rename requires <id> and a nonempty --name.");
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "PATCH", path: `/api/applications/${encodeURIComponent(id)}`,
    body: { name }, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  const application = response.body as { id: string; name: string; revision: number };
  return {
    envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: humanLines("Application renamed", [["id", application.id], ["name", application.name], ["revision", String(application.revision)]]),
  };
}, true);

export const handleAppDelete = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("app delete requires <id>.");
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "DELETE", path: `/api/applications/${encodeURIComponent(id)}`, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted application ${id}` };
}, true);

export const handleBrowserSetup = commandHandler(browserSetupCommand);

export const handleOperationsGet = commandHandler(operationsGet);

export const handleOperationsWait = commandHandler(operationsWait);

export const handleOperationsCancel = commandHandler(operationsCancel);

export const handleEventsList = commandHandler(eventsList);

export const handleEventsFollow = commandHandler(async (args, runtime, resolved) => {
  return loggerOf(runtime).withLocal({ op: "events.follow", message: "events follow" }, () =>
    eventsFollow(args, runtime, resolved),
  );
}, true);

export const handlePlaybackList = commandHandler(playbackList);
export const handlePlaybackPlays = commandHandler(playbackPlays);

function safeAgentSummary(agent: Agent) {
  return {
    id: agent.id,
    name: agent.name,
    agent_type: agent.agent_type,
    state: agent.state,
    capabilities: agent.capabilities,
    ...(agent.platform ? { platform: agent.platform } : {}),
    ...(agent.version ? { version: agent.version } : {}),
    ...(agent.connected_at ? { connected_at: agent.connected_at } : {}),
    ...(agent.last_used_at ? { last_used_at: agent.last_used_at } : {}),
    ...(agent.revoked_at ? { revoked_at: agent.revoked_at } : {}),
    authenticated_requests: agent.authenticated_requests,
    metered_credits: agent.metered_credits,
  };
}

/** New and due project notes: a notes_waiting warning in the envelope, and one line after human output. */
function withNotesHint(result: CommandResult, counts: NoteCounts | undefined): CommandResult {
  const warning = notesHintWarning(counts);
  const hint = notesHint(counts);
  if (!warning || !hint) return result;
  return {
    ...result,
    envelope: { ...result.envelope, warnings: [...result.envelope.warnings, warning] },
    human: result.human ? `${result.human}\n${hint}` : hint,
  };
}

/** The calling agent's self status (note counts, access levels). Any failure means none. */
async function selfStatusFor(runtime: CliRuntime, args: ParsedArgs, apiUrl: string, token: string | undefined): Promise<Record<string, unknown> & { access?: AccessLevel; effective_access?: AccessLevel; access_limited_by?: "project" | "person" } | undefined> {
  if (!token) return undefined;
  try {
    const response = await clientFor(runtime, args, apiUrl, token).call({ method: "GET", path: AGENT_SELF_PATH });
    const body = response.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const level = (value: unknown) => ACCESS_LEVELS.includes(value as AccessLevel) ? value as AccessLevel : undefined;
    const record = body as Record<string, unknown>;
    const limitedBy = record.access_limited_by === "project" || record.access_limited_by === "person" ? record.access_limited_by : undefined;
    return { ...record, access: level(record.access), effective_access: level(record.effective_access), access_limited_by: limitedBy };
  } catch {
    return undefined;
  }
}

async function agentStatus(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  if (!resolved.token) {
    const local = resolved.lastAgent;
    const status = local ? "disconnected" : "not_enrolled";
    return {
      envelope: successEnvelope({ status, path: "first_run_enroll", ...(local ? { agent: local } : {}) }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", status],
        ["id", local?.id],
        ["name", local?.name],
        ["capabilities", local?.capabilities.join(", ")],
      ]),
    };
  }

  const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  try {
    const response = await client.call({ method: "GET", path: AGENT_SELF_PATH });
    requirePrivateNoStore(response.headers, "Agent status response");
    const self = validateAgentSelfStatus(response.body);
    const agent = self.agent;
    const status = agent.state === "active" ? "active" : agent.state === "revoked" ? "disconnected" : "connecting";
    const notes = selfNotesField(response.body);
    const levels = accessFields(self);
    return withNotesHint({
      envelope: successEnvelope({ status, connection_ready: self.connection_ready, ...levels.data, agent: safeAgentSummary(agent), ...(notes ? { notes } : {}) }, { request_id: client.requestId }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", status],
        ["id", agent.id],
        ["name", agent.name],
        ["agent_type", agent.agent_type],
        ...levels.lines,
        ["capabilities", agent.capabilities.join(", ")],
        ["platform", agent.platform],
        ["version", agent.version],
        ["connection_ready", self.connection_ready ? "true" : "false"],
        ["last_used_at", agent.last_used_at],
      ]),
    }, selfNoteCounts(response.body));
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.code !== "unauthorized") throw err;
    const next = {
      command: "screenrig agent disconnect --yes",
      reason: "The stored credential is no longer accepted. Complete local cleanup before connecting or enrolling.",
    };
    return {
      envelope: successEnvelope({
        status: "disconnected",
        credential_accepted: false,
        local_cleanup_required: true,
        next,
      }),
      exitCode: ExitCode.Success,
      human: humanLines("Agent", [
        ["status", "disconnected"],
        ["credential_accepted", "false"],
        ["next", next.command],
      ]),
    };
  }
}


async function agentEnroll(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {

  requireFlagValue(args, "name", "Office MacBook Codex");
  const name = flagString(args.flags, "name");
  if (name && name.length > 80) throw usageError("agent enroll --name is at most 80 characters.");
  const enrollIntent = enrollmentPurpose(flagString(args.flags, "intent"));
  const setupCode = enrollmentSetupCode(flagString(args.flags, "setup-code"));
  let enrollmentConfig = resolved;
  // A stored credential the server no longer accepts has nothing left to lose:
  // with enrollment input, a new enrollment replaces it.
  let replacedCredential = false;
  if (resolved.retiredCredential) {
    if (!freshEnrollmentInput(args)) throw credentialRetiredError();
    enrollmentConfig = await dropDeadCredential(runtime, args, resolved);
    replacedCredential = true;
  } else if (resolved.enrollment && flagBool(args.flags, "force")) {
    const forceEmail = flagString(args.flags, "email");
    const forceClaim = flagString(args.flags, "agentid-claim");
    if (forceEmail !== undefined) enrollmentEmail(forceEmail);
    else if (forceClaim !== undefined) agentidClaim(forceClaim);
    else throw usageError("agent enroll --force requires --email ADDRESS or --agentid-claim CODE.");
    await clearPendingEnrollment(runtime, resolved);
    enrollmentConfig = await resolveConfig({
      flags: args.flags,
      fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
    });
  }
  const enrollOnce = async (config: Awaited<ReturnType<typeof resolveConfig>>) => {
    const enrolled = await enrollForCommand(args, runtime, config, {
      ...(name ? { name } : {}),
      ...(enrollIntent ? { intent: enrollIntent } : {}),
      ...(setupCode !== undefined ? { setupCode } : {}),
      explicit: true,
    });
    const token = requireToken(enrolled.token);
    setResultContext(runtime, enrolled);
    const client = clientFor(runtime, args, enrolled.apiUrl, token);
    const response = await client.call({ method: "GET", path: "/api/agents/self" });
    requirePrivateNoStore(response.headers, "Agent enrollment verification response");
    const self = validateAgentSelfStatus(response.body, "active");
    let project: Pick<Project, "id" | "name">;
    if (!config.token && enrolled.projectId && enrolled.projectName) {
      project = { id: enrolled.projectId, name: enrolled.projectName };
    } else {
      const projectResponse = await client.call({ method: "GET", path: "/api/project" });
      project = projectResponse.body as Project;
    }
    return { client, self, project };
  };
  let outcome: Awaited<ReturnType<typeof enrollOnce>>;
  try {
    outcome = await enrollOnce(enrollmentConfig);
  } catch (err) {
    // A stored credential the server refuses as dead is replaced; a live one keeps its project.
    if (!enrollmentConfig.token || enrollmentConfig.enrollment || !deadCredentialRefusal(err) || !freshEnrollmentInput(args)) throw err;
    enrollmentConfig = await dropDeadCredential(runtime, args, enrollmentConfig);
    replacedCredential = true;
    outcome = await enrollOnce(enrollmentConfig);
  }
  const { client, self, project } = outcome;
  const agent = self.agent;
  return {
    envelope: successEnvelope({
      status: "active",
      connection_ready: self.connection_ready,
      agent: safeAgentSummary(agent),
      project: { id: project.id, name: project.name },
      invitation: "emailed to the contact address",
      ...(replacedCredential ? { replaced_credential: true } : {}),
    }, { request_id: client.requestId, ...(replacedCredential ? { warnings: [CREDENTIAL_REPLACED] } : {}) }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent enrolled", [
      ...(replacedCredential ? [["replaced", "the retired stored credential; this installation now uses the new project"] as [string, string]] : []),
      ["status", "active"],
      ["id", agent.id],
      ["name", agent.name],
      ["capabilities", agent.capabilities.join(", ")],
      ["connection_ready", self.connection_ready ? "true" : "false"],
      ["project_id", project.id],
      ["project_name", project.name],
      ["invitation", "emailed to the contact address"],
    ]),
  };
}

const CREDENTIAL_REPLACED = {
  code: "credential_replaced",
  message: "The stored credential was retired (the server no longer accepts it), so this enrollment replaced it with the new project's credential.",
};

/** Whether this invocation names what a new enrollment needs: an email or AgentID claim. */
function freshEnrollmentInput(args: ParsedArgs): boolean {
  return flagString(args.flags, "email") !== undefined || flagString(args.flags, "agentid-claim") !== undefined;
}

/**
 * A refusal that says the stored credential itself is dead, not that a request
 * lacked access: a 401 credential_retired or unauthorized, or a sign-in the
 * server ended (its refresh refused, or a renewed token refused again).
 */
function deadCredentialRefusal(err: unknown): boolean {
  if (!(err instanceof CliError)) return false;
  return err.problem.code === "session_ended"
    || (err.problem.status === 401 && ["credential_retired", "unauthorized"].includes(err.problem.code));
}

/**
 * Drop a dead stored credential so enrollment starts a new installation, as
 * screenrig login does: nothing of it, its projects or its state carries over.
 * The enrollment input is checked first, so a usage error leaves the file as it was.
 */
async function dropDeadCredential(
  runtime: CliRuntime,
  args: ParsedArgs,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  const email = flagString(args.flags, "email");
  const claim = flagString(args.flags, "agentid-claim");
  if (email !== undefined) enrollmentEmail(email);
  if (claim !== undefined) agentidClaim(claim);
  const organization = flagString(args.flags, "organization");
  if (organization === undefined) throw usageError("agent enroll requires --organization NAME.");
  validateDisplayName(organization, "Organization name");
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (!current) return;
    // Another process may have signed this installation in meanwhile: keep a credential that is not the dead one.
    if (current.token && !isRetiredCredential(current.token) && !sameCredential(current.token, resolved.token)) {
      throw configError("The stored credential changed during enrollment. Run the command again.");
    }
    await writeConfigAtomic(resolved.configPath, preserveLogSocket(current, {
      api_url: current.api_url,
      ...(current.enrollment ? { enrollment: current.enrollment } : {}),
      updated_at: runtime.now().toISOString(),
    }), fsLike);
  });
  oauthSessions.delete(runtime);
  const next = await resolveConfig({ flags: args.flags, fs: fsLike });
  oauthSessionFor(runtime, next);
  return next;
}

async function clearPendingEnrollment(
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<void> {
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (!current?.enrollment) return;
    const { enrollment: _pending, token: _token, project_id: _project, project_name: _projectName, agent_id: _agent, ...rest } = current;
    await writeConfigAtomic(resolved.configPath, { ...rest, updated_at: runtime.now().toISOString() }, fsLike);
  });
}

async function removeLocalAgentCredential(
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  token: string,
  agent: Agent | undefined,
): Promise<void> {
  const fsLike = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fsLike, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fsLike);
    if (!current) {
      throw configError("The stored agent credential changed before local disconnect cleanup.");
    }
    const scoped = projectConfigFor(current, resolved);
    assertProjectCredential(scoped, { ...resolved, token });
    if (current.identity_token || current.projects) {
      const { token: _token, screen_provision: _provision, browser_setup: _browser, media_generate: _generate, pending_writes: _writes, ...withoutCredential } = scoped;
      const next = withProjectConfig(current, resolved, { ...withoutCredential, updated_at: runtime.now().toISOString() });
      if (!accessClaims(next.token)?.projects && resolved.projectId === accessClaims(next.token)?.prj) delete next.token;
      // An access token bound to the disconnected project is spent wherever it is stored.
      if (!accessClaims(next.identity_token)?.projects && resolved.projectId && accessClaims(next.identity_token)?.prj === resolved.projectId) delete next.identity_token;
      await writeConfigAtomic(resolved.configPath, next, fsLike);
      return;
    }
    const lastAgent = agent ? {
      id: agent.id,
      name: agent.name,
      agent_type: agent.agent_type,
      capabilities: agent.capabilities,
      state: "revoked" as const,
      revoked_at: runtime.now().toISOString(),
    } : current.last_agent;
    await writeConfigAtomic(resolved.configPath, preserveLogSocket(current, {
      api_url: current.api_url,
      ...(lastAgent ? { last_agent: lastAgent } : {}),
      updated_at: runtime.now().toISOString(),
    }), fsLike);
  });
}

async function agentDisconnect(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const invokedName = "agent disconnect";

  if (!flagBool(args.flags, "yes")) {
    throw usageError(`${invokedName} requires --yes. It revokes only this agent and preserves the project, screens, content, and other agents.`, {
      command: "screenrig agent disconnect --yes",
      reason: "Run only after explicitly accepting revocation of this installation.",
    });
  }
  if (!resolved.token) throw usageError("No stored ScreenRig agent credential exists; nothing was changed.");
  const token = resolved.token;
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  let agent: Agent | undefined;
  let credentialRejected = false;
  try {
    const current = await client.call({ method: "GET", path: "/api/agents/self" });
    requirePrivateNoStore(current.headers, "Agent status response");
    agent = validateAgentSelfStatus(current.body).agent;
  } catch (err) {
    if (!(err instanceof CliError) || err.problem.code !== "unauthorized") throw err;
    credentialRejected = true;
  }
  if (!credentialRejected) {
    const request: AgentDisconnectRequest = flagBool(args.flags, "allow-lockout") ? { allow_last_agent: true } : {};
    let response;
    try {
      response = await client.call({
        method: "POST",
        path: "/api/agents/self/disconnect",
        ...(request.allow_last_agent ? { body: request } : {}),
      });
    } catch (err) {
      if (err instanceof CliError && err.problem.code === "unauthorized") {
        credentialRejected = true;
      } else if (err instanceof CliError) {
        throw new CliError({
          ...err.problem,
          next: err.problem.code === "agent_lockout_risk"
            ? {
                command: "screenrig agent disconnect --yes --allow-lockout",
                reason: "Use only after confirming a registered dashboard passkey or explicitly accepting loss of this project.",
              }
            : {
                command: "screenrig agent disconnect --yes",
                reason: "Local credential state was retained. Retrying the exact disconnect is safe after an ambiguous response.",
              },
        }, err.exitCode);
      } else {
        throw err;
      }
    }
    if (!credentialRejected) {
      if (!response || response.status !== 204 || response.body !== undefined) {
        throw configError("The agent disconnect endpoint did not return the required empty 204 response; local credential state was retained.");
      }
      requirePrivateNoStore(response.headers, "Agent disconnect response");
    }
  }

  try {
    await removeLocalAgentCredential(runtime, resolved, token, agent);
  } catch (err) {
    const prefix = credentialRejected
      ? "The stored credential is no longer accepted, but atomic local cleanup failed"
      : "The server disconnected this agent, but atomic local cleanup failed";
    throw configError(
      `${prefix}: ${redactText(err instanceof Error ? err.message : "unknown filesystem error")}. The retained credential no longer authorizes project operations.`,
      {
        command: "screenrig agent disconnect --yes",
        reason: "Retrying with the retained exact credential safely completes local cleanup.",
      },
    );
  }
  return {
    envelope: successEnvelope({
      status: "disconnected",
      local_credential_removed: true,
      project_preserved: true,
      screens_preserved: true,
      other_agents_preserved: true,
      ...(credentialRejected ? { credential_accepted: false } : {}),
    }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Agent disconnected", [
      ["local_credential", "removed"],
      ["project_screens_and_other_agents", "preserved"],
      ["next", "screenrig agent enroll --email ADDRESS --organization NAME creates a new project; screenrig login joins an existing one only when the user asks"],
    ]),
  };
}

async function agentRevokeIdentity(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  if (!flagBool(args.flags, "yes")) throw usageError("agent revoke-identity requires --yes. It revokes this identity and all of its project memberships.");
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  let alreadyRejected = false;
  try {
    const response = await client.call({ method: "POST", path: "/api/agent-identity/revoke" });
    if (response.status !== 204 || response.body !== undefined) throw configError("Identity revocation did not return an empty 204; local credentials were retained.");
    requirePrivateNoStore(response.headers, "Identity revocation response");
  } catch (error) {
    if (!(error instanceof CliError) || error.problem.code !== "unauthorized") throw error;
    alreadyRejected = true;
  }
  const fs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  await withConfigLock(resolved.configPath, fs, { sleep: runtime.sleep, now: () => runtime.now().getTime() }, async () => {
    const current = await readConfigFile(resolved.configPath, fs);
    if (!current || !sameCredential(current.identity_token, identity.identityToken, "identity")) throw configError("Identity changed before revocation cleanup. Local credentials were retained.");
    const scrub = (value: ScreenRigConfig): ScreenRigConfig => {
      const { token: _token, token_projects: _subset, screen_provision: _provision, browser_setup: _browser, media_generate: _generate, pending_writes: _writes, ...rest } = value;
      return rest;
    };
    // Revoking the identity revokes every grant it holds, so the session goes too.
    const { identity_token: _identity, identity_writes: _writes, enrollment: _enrollment, oauth: _grant, login: _login, ...rest } = scrub(current);
    const projects = current.projects ? Object.fromEntries(Object.entries(current.projects).map(([id, value]) => [id, scrub({ api_url: current.api_url, ...value })])) : undefined;
    if (projects) for (const slot of Object.values(projects)) delete (slot as Partial<ScreenRigConfig>).api_url;
    await writeConfigAtomic(resolved.configPath, { ...rest, ...(projects ? { projects } : {}), updated_at: runtime.now().toISOString() }, fs);
  });
  return { envelope: successEnvelope({ status: "revoked", all_memberships_revoked: true, local_credentials_removed: true, ...(alreadyRejected ? { credential_accepted: false } : {}) }, { request_id: client.requestId }),
    exitCode: ExitCode.Success, human: "Agent identity and all project memberships revoked." };
}

async function browserSetupCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const rawCode = flagString(args.flags, "code");
  if (!rawCode) throw usageError("browser setup requires --code CODE.");
  const code = normalizeBrowserSetupCode(rawCode);
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const retryRuntime = {
    fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
    now: runtime.now,
    sleep: runtime.sleep,
  };
  const retry = await browserSetupRetryState({
    resolved,
    runtime: retryRuntime,
    code: code.canonical,
    ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
  });
  const request: BrowserLinkClaimRequest = { code: code.canonical };
  const response = await client.call({
    method: "POST",
    path: "/api/project/browser-links/claim",
    idempotent: true,
    idempotencyKey: retry.idempotency_key,
    body: request,
  });
  requirePrivateNoStore(response.headers, "Browser setup claim response");
  const claim = response.body as BrowserLinkClaim;
  const screen = claim.screen;
  if (!claim.session_id || claim.status !== "claimed" || !screen?.id || !screen.public_id || screen.state !== "pairing_pending" || !screen.public_url) {
    throw unexpectedResponseError("Browser setup response does not match the generated BrowserLinkClaim contract.", client.requestId,
      "The server may have claimed the code. Run screenrig screen list to find the screen before claiming again.");
  }
  // The claim is done whatever the URL check says: report it, and withhold only an unsafe URL.
  const withheld = playerPublicUrlProblem(resolved.apiUrl, screen.public_url, screen.public_id);
  const opened = flagBool(args.flags, "open")
    ? await (runtime.openUrl?.(browserHandoffUrl(resolved.apiUrl, code.display)) ?? Promise.resolve(false))
    : undefined;
  await clearBrowserSetupRetryState(resolved, retryRuntime, retry.idempotency_key);
  const playerPublicUrl = withheld ? undefined : new URL(screen.public_url).href;
  const data = {
    code: code.display,
    status: claim.status,
    screen_id: screen.id,
    ...(playerPublicUrl ? { player_public_url: playerPublicUrl } : { url_withheld: withheld }),
    ...(opened !== undefined ? { opened } : {}),
  };
  const warnings = withheld ? [{ code: "player_url_withheld", message: `The browser setup was claimed, but its Player public URL is not shown: ${withheld}` }] : [];
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: humanLines("Browser setup claimed", [
      ["code", code.display],
      ["status", claim.status],
      ["screen_id", screen.id],
      ["player_public_url", playerPublicUrl],
      ["url_withheld", withheld],
      ...(opened !== undefined ? [["opened", opened ? "true" : "false"] as [string, string]] : []),
    ]),
  };
}

/** Why a claimed screen's Player public URL is not safe to show, or undefined when it is. */
function playerPublicUrlProblem(apiUrl: string, value: string, publicId: string): string | undefined {
  const api = new URL(apiUrl);
  const apex = apexHost(api.hostname);
  let url: URL;
  try { url = new URL(value); } catch { return "public_url is not a valid URL."; }
  if (!apex || url.origin !== `https://play.${apex}${api.port ? `:${api.port}` : ""}`) return "public_url is not this API's Player origin.";
  if (url.username || url.password || url.hash || url.search) return "public_url carries credentials, a query or a fragment.";
  if (!isPlayerScreenPath(url.pathname, publicId)) return "public_url does not name this screen's Player path (/s/PUBLIC_ID).";
  return undefined;
}

/** Opens the ordinary dashboard origin; no credential is minted or transferred. */
async function dashboardCommand(
  _args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const api = new URL(resolved.apiUrl);
  const hostname = apexHost(api.hostname);
  if (!hostname || (api.protocol !== "https:" && !(api.protocol === "http:" && api.hostname.endsWith(".localhost")))) {
    throw usageError("dashboard requires a supported ScreenRig API origin.");
  }
  const origin = `${api.protocol}//${hostname}${api.port ? `:${api.port}` : ""}/dashboard/`;
  let opened = false;
  try { opened = await (runtime.openUrl?.(origin) ?? Promise.resolve(false)); } catch { /* Fall back to the ordinary origin. */ }
  return {
    envelope: successEnvelope({ opened, ...(!opened ? { url: origin } : {}) }),
    exitCode: ExitCode.Success,
    human: humanLines(opened ? "Dashboard opened" : "No browser could be opened", [
      ...(!opened ? [["url", origin] as [string, string]] : []),
    ]),
  };
}

function requirePrivateNoStore(headers: Record<string, string>, context: string): void {
  if (headers["cache-control"] !== "private, no-store") {
    throw usageError(`${context} did not return the required private, no-store cache policy.`);
  }
}

async function enrollForCommand(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  options: { name?: string; explicit?: boolean; intent?: EnrollmentIntent; setupCode?: string } = {},
): Promise<Awaited<ReturnType<typeof resolveConfig>>> {
  const suppliedEmail = flagString(args.flags, "email");
  const suppliedClaim = flagString(args.flags, "agentid-claim");
  const alreadyEnrolled = Boolean(resolved.token && !resolved.enrollment);
  const persistedEmail = resolved.enrollment?.email;
  const persistedClaim = resolved.enrollment?.agentid_claim;
  if (persistedEmail && suppliedEmail !== undefined && enrollmentEmail(suppliedEmail) !== persistedEmail) {
    throw usageError("The pending enrollment is bound to a different contact email. Resume it without changing --email.");
  }
  if (persistedClaim && suppliedClaim !== undefined && agentidClaim(suppliedClaim) !== persistedClaim) {
    throw usageError("The pending enrollment is bound to a different AgentID claim. Resume it without changing --agentid-claim, or discard it with agent enroll --force.");
  }
  // A pending enrollment blessed exactly one credential source. Switching it
  // would mutate the request behind an unchanged idempotency key, so refuse.
  if (resolved.enrollment && suppliedEmail !== undefined && persistedClaim !== undefined) {
    throw usageError("The pending enrollment redeems an AgentID claim, not a contact email. Resume it without --email, or discard it with agent enroll --force.");
  }
  if (resolved.enrollment && suppliedClaim !== undefined && persistedEmail !== undefined) {
    throw usageError("The pending enrollment redeems a contact email, not an AgentID claim. Resume it without --agentid-claim, or discard it with agent enroll --force.");
  }
  const email = alreadyEnrolled ? undefined : persistedEmail ?? (suppliedEmail !== undefined ? enrollmentEmail(suppliedEmail) : undefined);
  const claim = alreadyEnrolled ? undefined : persistedClaim ?? (suppliedClaim !== undefined ? agentidClaim(suppliedClaim) : undefined);
  if (!alreadyEnrolled && (email === undefined) === (claim === undefined)) {
    throw usageError("agent enroll requires --email ADDRESS or --agentid-claim CODE.");
  }
    requireFlagValue(args, "project-name", "Screens");
    const projectName = flagString(args.flags, "project-name")?.trim();
    if (projectName !== undefined && (!projectName || [...projectName].length > 60 || /[\p{Cc}\p{Cf}]/u.test(projectName))) {
      throw usageError("agent enroll --project-name must contain 1–60 characters.");
    }
    if (!resolved.token && !resolved.enrollment && projectName !== undefined && projectName !== "Screens") {
      throw usageError("Enrollment creates Screens. Use project create NAME for another named project.");
    }
    const organizationFlag = flagString(args.flags, "organization");
    const organization = organizationFlag !== undefined ? validateDisplayName(organizationFlag, "Organization name") : resolved.enrollment?.organization;
    if (!resolved.token && !resolved.enrollment && !organization) throw usageError("agent enroll requires --organization NAME.");
    return await ensureCredential({
      resolved,
      ...(email !== undefined ? { enrollmentEmail: email } : {}),
      ...(claim !== undefined ? { enrollmentAgentIdClaim: claim } : {}),
      ...(projectName !== undefined && resolved.enrollment ? { enrollmentProjectName: projectName } : {}),
      ...(organization !== undefined ? { enrollmentOrganization: organization } : {}),
      ...(options.intent ? { enrollmentIntent: options.intent } : {}),
      ...(options.setupCode !== undefined ? { enrollmentSetupCode: options.setupCode } : {}),
      runtime: {
        fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
        now: runtime.now,
        sleep: runtime.sleep,
      },
      enroll: async (state) => {
        const client = clientFor(runtime, args, resolved.apiUrl);
        const request: CLIEnrollmentRequest = {
          client_id: state.clientId,
          credential_format: state.credentialFormat,
          ...(state.email !== undefined ? { email: state.email } : {}),
          ...(state.agentidClaim !== undefined ? { agentid_claim: state.agentidClaim } : {}),
          ...(state.projectName !== undefined ? { project_name: state.projectName } : {}),
          ...(state.organization !== undefined ? { organization: state.organization } : {}),
          ...(state.intent ? { intent: state.intent } : {}),
          ...(state.setupCode !== undefined ? { setup_code: state.setupCode } : {}),
          ...(options.name ? { name: options.name } : {}),
          ...(options.explicit ? { agent_type: "cli", platform: agentPlatform(), version: CLI_VERSION } : {}),
        };
        let response;
        try {
          response = await client.call({
            method: "POST",
            path: "/api/enrollments",
            idempotent: true,
            idempotencyKey: state.idempotencyKey,
            body: request,
          });
        } catch (err) {
          if (err instanceof CliError) {
            // The server's own next action always wins; these two are the CLI's
            // documented recovery paths when the server leaves them empty.
            if (err.problem.code === "agentid_claim_invalid" && !err.problem.next) {
              const signIn = agentidSignInUrl(resolved.apiUrl);
              throw new CliError({
                ...err.problem,
                next: {
                  command: signIn ?? "screenrig agent enroll --email ADDRESS --organization NAME",
                  reason: signIn
                    ? `The AgentID claim code is missing, already redeemed, or expired. Sign in again at ${signIn} for a new claim code, or enroll with a contact email: screenrig agent enroll --email ADDRESS --organization NAME.`
                    : "The AgentID claim code is missing, already redeemed, or expired. Enroll with a contact email instead: screenrig agent enroll --email ADDRESS --organization NAME.",
                },
              }, err.exitCode, err.warnings);
            }
            if (err.problem.code === "agentid_already_enrolled" && !err.problem.next) {
              throw new CliError({
                ...err.problem,
                next: {
                  command: "screenrig login",
                  reason: "This AgentID already holds an enrolled agent. Sign this installation in to the existing project instead of enrolling a second agent.",
                },
              }, err.exitCode, err.warnings);
            }
          }
          throw err;
        }
        requirePrivateNoStore(response.headers, "Enrollment response");
        const delivered = response.body as CLIEnrollmentOAuth;
        const agent = validateAgent(delivered.agent, "active");
        if (!delivered.project?.id || !delivered.project.name || !delivered.invitation?.id
          || delivered.connection_ready !== false || !isSessionJwt(delivered.access_token) || (typeof delivered.refresh_token !== "string" || !delivered.refresh_token)
          || delivered.token_type !== "Bearer" || typeof delivered.scope !== "string"
          || !delivered.issuance_id || !delivered.issuance_expires_at) {
          throw usageError("Enrollment response does not match the generated CLIEnrollmentOAuth contract.");
        }
        const identity = delivered.scope.split(" ").includes(SCOPE_IDENTITY);
        return {
          token: delivered.access_token,
          projectId: delivered.project.id,
          projectName: delivered.project.name,
          agentId: agent.id,
          ...(identity ? { identityToken: delivered.access_token } : {}),
          organizationId: delivered.project.organization_id,
          organizationName: delivered.project.organization_name,
          oauth: {
            refreshToken: delivered.refresh_token,
            ...(typeof delivered.refresh_expires_at === "number" ? { refreshExpiresAt: delivered.refresh_expires_at } : {}),
            identity,
          },
        };
      },
      verify: async (token, projectId) => {
        const client = clientFor(runtime, args, resolved.apiUrl, token);
        const response = await client.call({ method: "GET", path: "/api/project" });
        const project = response.body as { id?: string };
        if (!project.id || (projectId && project.id !== projectId)) {
          throw usageError("Persisted enrollment credential did not verify against its project.");
        }
      },
    });
}

async function projectShow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/project" });
  // Presence only. The lookup segment of a credential identifies the live
  // token, so no part of the stored value is reported on stdout.
  const envelope = jsonBody(response, client.requestId, { token_present: hasToken(token) });
  const project = response.body as Project;
  const context = contextFromProject(project);
  if (resolved.projectId && context.project.id !== resolved.projectId) throw configError("Project response changed the command's target.");
  await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
  if (headerValue(response.headers, CREDITS_REMAINING_HEADER) === undefined) {
    observeCreditsRemaining(runtime, parseCreditsInteger(project.credit_remaining));
  }
  return {
    envelope,
    exitCode: ExitCode.Success,
    human: humanLines("Project", [
      ["id", project.id],
      ["name", project.name],
      ["revision", project.revision !== undefined ? String(project.revision) : undefined],
      ["credit_remaining", project.credit_remaining !== undefined ? String(project.credit_remaining) : undefined],
      ["token", describeTokenPresence(token)],
      ["request_id", client.requestId],
    ]),
  };
}

/** Identity is a scope of the sign-in's access token, renewed like any other. */
async function identityForCommand(runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<ResolvedCommandConfig> {
  const session = oauthSessionFor(runtime, resolved);
  const stored = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
  if (!stored?.oauth && !session.serviceMode) throw missingCredentialError(resolved);
  const identityToken = await session.identityToken();
  if (!identityToken) {
    throw new CliError(makeProblem("insufficient_access", "Insufficient access", 403,
      session.serviceMode
        ? "A service client acts on its own project and has no identity access, so it cannot list, select or create projects."
        : "This sign-in covers one project and has no identity access, so it cannot list or create projects.", {
        next: { command: "screenrig login", reason: "Sign in again; the approval grants identity access with the project capability." },
      }), ExitCode.Auth);
  }
  return { ...resolved, identityToken };
}

async function accessibleProjects(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<{ resolved: ResolvedCommandConfig; projects: ProjectContextList["projects"]; requestId: string }> {
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const response = await client.call({ method: "GET", path: "/api/projects" });
  const body = response.body as ProjectContextList;
  if (!Array.isArray(body?.projects)) throw configError("Project list does not match the generated contract.");
  const projects = body.projects.map(item => ({ ...validateProjectContext(item), ...(typeof item.in_token === "boolean" ? { in_token: item.in_token } : {}) }));
  if (new Set(projects.map(item => item.project.id)).size !== projects.length) throw configError("Project list contains duplicate project IDs.");
  return { resolved: identity, projects, requestId: client.requestId };
}

export const handleProjectToken = commandHandler(async (args, runtime, resolved) => {
  const stored = await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir });
  if (!stored?.oauth) throw missingCredentialError(resolved);
  const raw = flagString(args.flags, "projects") ?? "";
  const projects = raw.split(/[\s,]+/).filter(Boolean);
  if (projects.some(id => !isResourceID(id, "project"))) throw usageError("--projects requires project IDs separated by commas or spaces.");
  const token = await oauthSessionFor(runtime, resolved).selectProjects(projects);
  return { envelope: successEnvelope({ projects: token ? Object.keys(accessClaims(token)?.projects ?? {}) : [] }),
    exitCode: ExitCode.Success, human: "Current token project subset updated." };
}, false);

async function projectList(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const listed = await accessibleProjects(args, runtime, resolved);
  await cacheProjectContexts(runtime, listed.resolved, listed.projects, { identityToken: listed.resolved.identityToken });
  return { envelope: successEnvelope({ projects: listed.projects }, { request_id: listed.requestId }), exitCode: ExitCode.Success,
    human: listed.projects.map(item => `${item.organization.name} / ${item.project.name}: ${item.project.id}${typeof item.in_token === "boolean" ? ` (in token: ${item.in_token})` : ""}`).join("\n") || "No accessible projects." };
}

async function projectUse(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!isResourceID(id, "project")) throw usageError("project use requires a project ID from project list.");
  const listed = await accessibleProjects(args, runtime, resolved);
  const selected = listed.projects.find(item => item.project.id === id);
  if (!selected) {
    throw new CliError(makeProblem("not_found", "Project not available", 404, `${id} is not a project this identity belongs to.`, {
      hint: "Pick an ID from project list; to join another project, sign in to it with screenrig login --project ID.",
      next: { command: "screenrig project list", reason: "Lists the projects this identity can select." },
    }));
  }
  if (selected.in_token === false) throw new CliError(makeProblem("project_not_in_token", "Project outside token", 403, "This project is outside the current token subset.", { next: { command: `screenrig project token --projects ${id}`, reason: "Request a token for consented projects. Membership discovery does not grant access." } }));
  await cacheProjectContexts(runtime, listed.resolved, [selected], { identityToken: listed.resolved.identityToken, select: id });
  return { envelope: successEnvelope(selected, { request_id: listed.requestId }), exitCode: ExitCode.Success,
    human: `Selected ${selected.organization.name} / ${selected.project.name} (${id})` };
}

async function projectCreate(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const name = validateDisplayName(args.positionals[2]);
  const organizationId = flagString(args.flags, "organization-id");
  const organizationName = flagString(args.flags, "organization");
  if (organizationId && organizationName) throw usageError("Use one of --organization-id or --organization.");
  const identity = await identityForCommand(runtime, resolved);
  const client = clientFor(runtime, args, identity.apiUrl, identity.identityToken);
  const body: ProjectCreate = { name, ...(organizationId ? { organization_id: organizationId } : {}),
    ...(organizationName !== undefined ? { organization_name: validateDisplayName(organizationName, "Organization name") } : {}) };
  const response = await client.call({ method: "POST", path: "/api/projects", body, idempotent: true });
  if (!(headerValue(response.headers, "cache-control") ?? "").split(",").map(value => value.trim().toLowerCase()).includes("no-store")) {
    throw configError("The project create response did not prohibit storage.");
  }
  const context = validateProjectContext(response.body as CreatedProject);
  // Creating a project does not expand the current token subset.
  await cacheProjectContexts(runtime, identity, [context], { identityToken: identity.identityToken, select: context.project.id });
  return { envelope: successEnvelope({ project: context.project, organization: context.organization, ...(context.owner_user_id ? { owner_user_id: context.owner_user_id } : {}) }, { request_id: client.requestId }),
    exitCode: ExitCode.Success, human: `Created ${context.organization.name} / ${context.project.name} (${context.project.id})` };
}

async function projectMoves(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/project/moves" });
  const organizations = (response.body as { organizations?: { id: string; name: string }[] }).organizations;
  if (!Array.isArray(organizations)) throw configError("Project move destinations do not match the contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: organizations.map(item => `${item.name}: ${item.id}`).join("\n") || "No allowed destinations." };
}

async function projectLifecycleWrite(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, method: HttpMethod, path: string, body: object): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method, path, body });
  const context = validateProjectContext(response.body);
  if (context.project.id !== resolved.projectId) throw configError("Project lifecycle response changed the command's target.");
  await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: `${context.organization.name} / ${context.project.name} (${context.project.id})` };
}

async function projectMove(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const id = flagString(args.flags, "organization-id");
  if (!id) throw usageError("project move requires --organization-id from project moves.");
  return projectLifecycleWrite(args, runtime, resolved, "POST", "/api/project/move", { organization_id: id });
}

async function projectOwnerTransfer(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const id = flagString(args.flags, "user-id");
  if (!id) throw usageError("project transfer-owner requires --user-id for an existing verified project member.");
  return projectLifecycleWrite(args, runtime, resolved, "PUT", "/api/project/owner", { user_id: id });
}

async function projectDeletionPreview(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/project/deletion-preview" });
  const context = validateProjectContext(response.body);
  const preview = response.body as { allowed?: boolean; reason?: string; devices?: unknown[] };
  if (typeof preview.allowed !== "boolean" || !Array.isArray(preview.devices)) throw configError("Project deletion preview does not match the contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: humanLines("Project deletion preview", [["name", context.project.name], ["revision", String(context.project.revision)], ["allowed", String(preview.allowed)], ["reason", preview.reason]]) };
}

async function projectDelete(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const name = validateDisplayName(flagString(args.flags, "name"));
  const revision = flagNumber(args.flags, "revision");
  if (!flagBool(args.flags, "yes") || !Number.isInteger(revision) || !revision || revision < 1) {
    throw usageError("project delete requires --yes --name NAME --revision N matching project deletion-preview.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "DELETE", path: "/api/project", body: { name, revision } });
  if ((response.body as { id?: string })?.id !== resolved.projectId) throw configError("Project deletion response changed the command's target.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: "Deleted project " + resolved.projectName + " (" + resolved.projectId + ")" };
}

/**
 * Read the authenticated project's plan, feature flags and effective server
 * capabilities. The set is the server's current decision for this project and
 * actor: a plan label or a numeric quota never implies permission here, and a
 * route denial still wins over a cached capability.
 */
async function projectCapabilities(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/project/capabilities" });
  requirePrivateNoStore(response.headers, "Project capabilities response");
  const capabilities = validateProjectCapabilities(response.body);
  return {
    envelope: jsonBody(response, client.requestId, { token_present: hasToken(token) }),
    exitCode: ExitCode.Success,
    human: humanLines("Project capabilities", [
      ["project_id", capabilities.project_id],
      ["plan_id", capabilities.plan_id],
      ["features", `advertiser=${capabilities.features.advertiser} screens=${capabilities.features.screens}`],
      ["feature_revision", String(capabilities.feature_revision)],
      ["capabilities", [...capabilities.capabilities].sort().join(", ") || "(none)"],
      ["media_video_bytes", capabilities.media_video_bytes === undefined ? "(not stated)" : String(capabilities.media_video_bytes)],
      ["request_id", client.requestId],
    ]),
  };
}

async function projectRename(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig): Promise<CommandResult> {
  const name = args.positionals[2]?.trim();
  if (!name || [...name].length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw usageError("project rename requires NAME containing 1–60 characters without controls.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PATCH", path: "/api/project", body: { name }, idempotent: true });
  const project = response.body as Project;
  let context: ReturnType<typeof contextFromProject>;
  try {
    context = contextFromProject(project);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    // The rename succeeded; reconcile the cached context from a fresh read instead of failing on the response's shape.
    context = contextFromProject((await client.call({ method: "GET", path: "/api/project" })).body as Project);
  }
  if (context.project.id !== resolved.projectId) throw configError("Rename response changed the command's target.");
  await cacheProjectContexts(runtime, resolved, [context], { credential: resolved.token });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: humanLines("Project renamed", [["id", project.id], ["name", project.name]]) };
}

/** One comma-separated option expanded to values; no empty entry is allowed. */
function adsListOption(value: string | undefined, option: string): string[] {
  if (value === undefined) return [];
  const items = value.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw usageError(`--${option} must be a comma-separated list without empty entries.`);
  }
  return items;
}

/**
 * One advertising or billing mutation.
 *
 * Every mutation is idempotent by contract, revision-checked writes carry
 * If-Match, and no advertising or billing response may be cached. Nothing here
 * moves money: a draft authorizes nothing and activation is a separate,
 * explicitly quoted request.
 */
async function adsMutation(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: ResolvedCommandConfig,
  options: { method: "POST" | "PUT"; path: string; body?: unknown; ifMatch?: string; human: string },
): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: options.method,
    path: options.path,
    idempotent: true,
    ...(options.ifMatch ? { headers: { "if-match": quotedRevision(options.ifMatch) } } : {}),
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  requirePrivateNoStore(response.headers, "Advertising response");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: options.human };
}

/** Optional body member: the key is omitted entirely when the operator supplied nothing. */
function plugged(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}
/** mcr amounts travel as canonical decimal strings in both directions. */
function adsNetworkRateBody(args: ParsedArgs): Record<string, unknown> {
  return { rate_mcr_per_15s: flagString(args.flags, "rate-mcr-per-15s") };
}

function adsInventoryBody(args: ParsedArgs): Record<string, unknown> {
  const enabled = flagBool(args.flags, "enabled") ? true : flagBool(args.flags, "disabled") ? false : undefined;
  const rate = flagString(args.flags, "rate-mcr-per-15s");
  const tags = flagString(args.flags, "audience-tags");
  const impressions = flagNumber(args.flags, "impressions-per-hour");
  return {
    ...(enabled === undefined ? {} : { ads_enabled: enabled }),
    ...plugged("site_name", flagString(args.flags, "site-name")),
    ...plugged("city", flagString(args.flags, "city")),
    ...plugged("region", flagString(args.flags, "region")),
    ...plugged("venue_type", flagString(args.flags, "venue-type")),
    ...(tags === undefined ? {} : { audience_tags: adsListOption(tags, "audience-tags") }),
    ...plugged("placement", flagString(args.flags, "placement")),
    ...plugged("public_description", flagString(args.flags, "public-description")),
    ...(rate === undefined ? {} : { rate_override_mcr_per_15s: rate }),
    ...(flagBool(args.flags, "clear-rate") ? { rate_override_mcr_per_15s: null } : {}),
    ...plugged("impressions_per_hour", impressions),
    ...(flagBool(args.flags, "clear-impressions-per-hour") ? { impressions_per_hour: null } : {}),
  };
}

function adsSlotBody(args: ParsedArgs): Record<string, unknown> {
  const media = flagString(args.flags, "accepted-media");
  const rate = flagString(args.flags, "rate-mcr-per-15s");
  const enabled = flagBool(args.flags, "enabled") ? true : flagBool(args.flags, "disabled") ? false : undefined;
  return {
    ...plugged("enabled", enabled),
    ...plugged("name", flagString(args.flags, "name")),
    ...(media === undefined ? {} : { accepted_media: adsListOption(media, "accepted-media") }),
    ...plugged("max_image_duration_ms", flagNumber(args.flags, "max-image-duration-ms")),
    ...plugged("max_video_duration_ms", flagNumber(args.flags, "max-video-duration-ms")),
    ...(rate === undefined ? {} : { rate_override_mcr_per_15s: rate }),
    ...(flagBool(args.flags, "clear-rate") ? { rate_override_mcr_per_15s: null } : {}),
    ...plugged("vast_tag_url", flagString(args.flags, "vast-tag-url")),
    ...(flagBool(args.flags, "clear-vast-tag-url") ? { vast_tag_url: null } : {}),
  };
}

/** One row of a list route by key, or undefined when the project has none. */
async function adsExistingRow(
  client: ApiClient,
  path: string,
  collection: string,
  key: string,
  value: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await client.call({ method: "GET", path });
  const rows = (response.body as { [name: string]: unknown } | undefined)?.[collection];
  if (!Array.isArray(rows)) return undefined;
  const row = rows.find((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return key in item && item[key] === value;
  });
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : undefined;
}

/**
 * The full slot row the update route expects. The server replaces the whole
 * definition, so every field the operator did not change is carried over from
 * the stored row rather than dropped; only an explicit flag overrides it.
 */
function adsSlotWriteBody(current: Record<string, unknown> | undefined, args: ParsedArgs): Record<string, unknown> {
  const supplied = adsSlotBody(args);
  if (!current) return supplied;
  return {
    name: current.name,
    enabled: current.enabled,
    accepted_media: current.accepted_media,
    max_image_duration_ms: current.max_image_duration_ms,
    max_video_duration_ms: current.max_video_duration_ms,
    rate_override_mcr_per_15s: current.rate_override_mcr_per_15s ?? null,
    // An absent vast_tag_url clears the tag, so the stored one (shown to the owning seller) is sent back.
    ...(typeof current.vast_tag_url === "string" && current.vast_tag_url ? { vast_tag_url: current.vast_tag_url } : {}),
    ...supplied,
  };
}

/**
 * The full inventory row the update route expects, for the same reason: a
 * partial body would reset the opt-in flag, the price override, and the public
 * metadata the operator did not touch.
 */
function adsInventoryWriteBody(current: Record<string, unknown> | undefined, args: ParsedArgs): Record<string, unknown> {
  const supplied = adsInventoryBody(args);
  if (!current) return supplied;
  return {
    ads_enabled: typeof current.ads_enabled === "boolean" ? current.ads_enabled : false,
    site_name: current.site_name,
    city: current.city,
    region: current.region,
    venue_type: current.venue_type,
    audience_tags: current.audience_tags,
    placement: current.placement,
    public_description: current.public_description,
    rate_override_mcr_per_15s: current.rate_override_mcr_per_15s ?? null,
    // An absent estimate clears it, so the stored one is sent back.
    ...(typeof current.impressions_per_hour === "number" ? { impressions_per_hour: current.impressions_per_hour } : {}),
    ...supplied,
  };
}

/**
 * The full membership body. The route takes the policy and both scope lists, so
 * an unspecified list keeps the stored scope instead of clearing it. The policy
 * is always sent: the server replaces it rather than defaulting it.
 */
function adsMembershipWriteBody(current: Record<string, unknown> | undefined, args: ParsedArgs): Record<string, unknown> {
  const screenIds = flagString(args.flags, "screen-id");
  const slotIds = flagString(args.flags, "slot-id");
  const policy = flagString(args.flags, "policy")
    ?? (typeof current?.policy === "string" && current.policy.length > 0 ? current.policy : undefined);
  if (policy === undefined) {
    throw usageError(`The membership row was not found, so its current review policy cannot be carried over. Run ads memberships list, or pass --policy trusted|review_required explicitly.`);
  }
  const scope = current?.scope;
  if ((screenIds === undefined || slotIds === undefined)
    && (!scope || typeof scope !== "object" || Array.isArray(scope))) {
    throw usageError("The membership did not report its scope; refusing to replace an omitted list with an empty one.");
  }
  const storedScope = (scope ?? {}) as Record<string, unknown>;
  return {
    screen_ids: screenIds === undefined ? storedScope.screen_ids ?? [] : adsListOption(screenIds, "screen-id"),
    slot_ids: slotIds === undefined ? storedScope.slot_ids ?? [] : adsListOption(slotIds, "slot-id"),
    policy,
  };
}

/** Money in a campaign draft is a canonical decimal mcr string, never a number. */
function isDecimalMcr(value: unknown): boolean {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

/** A positive mcr amount for a price ceiling: a decimal string, never zero. */
function isPositiveMcr(value: unknown): boolean {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

/**
 * Read and preflight one campaign draft document.
 *
 * The required field set is the published draft contract. A malformed draft is
 * refused here so the operator learns which field is wrong instead of receiving
 * a server field error about a body the CLI wrote; the server still validates
 * everything, including fields this preflight does not name.
 */
async function campaignDraft(file: string | undefined, runtime: CliRuntime): Promise<Record<string, unknown>> {
  if (!file) throw usageError("ads campaigns requires a draft JSON document.");
  let parsed: unknown;
  try {
    parsed = await readAuthoringJson(file, runtime);
  } catch (error) {
    throw usageError(`Cannot read the campaign draft JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError("A campaign draft must be a JSON object.");
  }
  const draft = parsed as Record<string, unknown>;
  const fail = (field: string, expectation: string): never => {
    throw usageError(`Campaign draft field ${field} ${expectation}`);
  };
  if (typeof draft.name !== "string" || draft.name.trim().length === 0) fail("name", "must be a non-empty string.");
  for (const field of ["daily_cap_mcr", "lifetime_cap_mcr"] as const) {
    if (!isDecimalMcr(draft[field])) fail(field, "must be a decimal mcr string, for example \"100000000\".");
  }
  // Chosen at drafting time: the image display duration inside the authoring
  // range, and an optional per-play price ceiling as a decimal mcr string.
  const imageDurationMs = draft.image_duration_ms;
  if (imageDurationMs !== undefined
    && (typeof imageDurationMs !== "number" || !Number.isInteger(imageDurationMs) || imageDurationMs < 5000 || imageDurationMs > 30000)) {
    fail("image_duration_ms", "must be a whole number of milliseconds from 5000 to 30000 when present.");
  }
  if (draft.max_play_price_mcr !== undefined && !isPositiveMcr(draft.max_play_price_mcr)) {
    fail("max_play_price_mcr", "must be a positive decimal mcr string when present; omit it for no extra price ceiling.");
  }
  for (const field of ["flight_start", "flight_end"] as const) {
    if (typeof draft[field] !== "string" || draft[field].trim().length === 0) fail(field, "must be a UTC timestamp string.");
  }
  if (!Array.isArray(draft.networks) || draft.networks.length === 0) {
    fail("networks", "must be a non-empty array of network configurations.");
  }
  for (const [index, value] of (draft.networks as unknown[]).entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`networks[${index}]`, "must be an object.");
    const network = value as Record<string, unknown>;
    if (typeof network.seller_project_id !== "string" || network.seller_project_id.length === 0) {
      fail(`networks[${index}].seller_project_id`, "must name the invited seller project.");
    }
    for (const field of ["screen_ids", "slot_ids", "creative_ids"] as const) {
      const list = network[field];
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
        fail(`networks[${index}].${field}`, "must be an array of string identifiers.");
      }
    }
    if (network.network_cap_mcr !== undefined && !isDecimalMcr(network.network_cap_mcr)) {
      fail(`networks[${index}].network_cap_mcr`, "must be a decimal mcr string when present.");
    }
  }
  return draft;
}

export const handleAdsNetworksList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/networks", "Invited networks"));

export const handleAdsNetworkInventoryShow = commandHandler(async (args, runtime, resolved) => {
  const seller = args.positionals[3];
  if (!seller) throw usageError("ads networks show requires <seller-project-id>.");
  return simpleGet(args, runtime, resolved, `/api/advertising/networks/${encodeURIComponent(seller)}/inventory`, "Permitted inventory");
});

export const handleAdsNetworkShow = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/network", "Advertising network"));

export const handleAdsNetworkCreate = commandHandler((args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/network",
    body: { name: flagString(args.flags, "name") },
    human: "Network created. Set the default rate before enabling paid supply.",
  }));

export const handleAdsNetworkRate = commandHandler((args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/network/rate",
    body: adsNetworkRateBody(args),
    ifMatch: flagString(args.flags, "if-match"),
    human: "Default rate updated. Affected campaigns are paused until each buyer accepts a fresh quote.",
  }));

export const handleAdsInventoryList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/inventory", "Advertising inventory"));

/**
 * Upsert one screen's advertising inventory. When the row already exists the
 * route replaces it, so the CLI reads the stored row, merges the supplied
 * changes, and writes the whole record with the current revision as its
 * precondition; an unsupplied field keeps its stored value.
 */
export const handleAdsInventoryUpdate = commandHandler(async (args, runtime, resolved) => {
  const screenId = args.positionals[3];
  if (!screenId) throw usageError("ads inventory update requires <screen-id>.");
  const requested = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const current = await adsExistingRow(client, "/api/advertising/inventory", "inventory", "screen_id", screenId);
  if (!current && requested) {
    throw usageError(`No advertising inventory row exists for ${screenId}, so --expect-rev has nothing to check. Omit it to create the row.`);
  }
  if (!current && !flagBool(args.flags, "enabled") && !flagBool(args.flags, "disabled")) {
    throw usageError(`No advertising inventory row exists for ${screenId} yet; a new row needs --enabled or --disabled so the write carries its ads_enabled field.`);
  }
  const currentRevision = typeof current?.revision === "number" ? String(current.revision) : undefined;
  return adsMutation(args, runtime, resolved, {
    method: "PUT",
    path: `/api/advertising/inventory/${encodeURIComponent(screenId)}`,
    body: adsInventoryWriteBody(current, args),
    ifMatch: requested ?? (current ? currentRevision : undefined),
    human: `Updated advertising inventory for ${screenId}. Fields you did not change keep their stored values.`,
  });
});

export const handleAdsSlotsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/slots", "Ad slots"));

export const handleAdsSlotsCreate = commandHandler((args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/slots",
    // The canonical slot write requires both duration limits; the values below
    // are the server's own normalization defaults for an omitted limit, so the
    // create body is complete without a second server round-trip.
    body: {
      enabled: true,
      max_image_duration_ms: 30000,
      max_video_duration_ms: 30000,
      ...adsSlotBody(args),
    },
    human: "Slot created. Place an adslot page in a playlist to give it an ad break.",
  }));

/**
 * Update one slot. The route replaces the stored definition, so the CLI reads
 * it first and writes the merged record; a rename alone keeps the accepted
 * formats, duration limits, and the rate override.
 */
export const handleAdsSlotsUpdate = commandHandler(async (args, runtime, resolved) => {
  const slotId = args.positionals[3];
  if (!slotId) throw usageError("ads slots update requires <slot-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const current = await adsExistingRow(client, "/api/advertising/slots", "slots", "id", slotId);
  if (!current) {
    throw usageError(`No slot ${slotId} exists for this project, so there is nothing to update. Create it with ads slots create.`);
  }
  const currentRevision = typeof current.revision === "number" ? String(current.revision) : undefined;
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/slots/${encodeURIComponent(slotId)}`,
    body: adsSlotWriteBody(current, args),
    ifMatch: flagString(args.flags, "if-match") ?? currentRevision,
    human: "Slot updated. A changed effective rate pauses affected campaigns until each buyer accepts a fresh quote.",
  });
});

/** Link URLs are an explicit one-time output, never logging or recovery metadata. */
/** The scope an uploader invitation or service client carries: the folders and playlists it works in. */
function uploadScopeFromArgs(args: ParsedArgs, subject: string, withAccess: boolean): { playlist_ids: string[]; folder_ids: string[]; access?: string } {
  const folders = adsListOption(flagString(args.flags, "folder-id"), "folder-id");
  const playlists = adsListOption(flagString(args.flags, "playlist-id"), "playlist-id");
  if (!folders.length) throw usageError(`${subject} needs at least one --folder-id MFD_ID (comma-separated): an uploader works in media folders. media folder list shows them.`);
  for (const id of folders) mediaFolderId(id, "--folder-id");
  for (const id of playlists) if (!RESOURCE_ID_PATTERNS.playlist.test(id)) throw usageError("--playlist-id takes playlist IDs (pl_...); playlist list shows them.");
  const access = withAccess ? flagString(args.flags, "access") : undefined;
  return { playlist_ids: playlists, folder_ids: folders, ...(access !== undefined ? { access } : {}) };
}

export const handleInvitationsCreate = commandHandler(async (args, runtime, resolved) => {
  const uploader = flagString(args.flags, "kind") === "uploader";
  const kind = flagString(args.flags, "kind") === "ad-buyer" ? "ad_buyer" : "project_member";
  const link = flagBool(args.flags, "link");
  // A link names no recipient (the server refuses emails with it), so never accept and drop an address.
  if (link && flagString(args.flags, "email") !== undefined) throw usageError("--link cannot be used with --email: a link names no recipient. Use --email to invite by email, or --link alone.");
  const emails = link ? [] : adsListOption(flagString(args.flags, "email"), "email").map(invitationEmail);
  if (!link && (!emails.length || emails.length > 50)) throw usageError("invitations create requires --link, or --email with 1 to 50 addresses.");
  const screenIds = adsListOption(flagString(args.flags, "screen-id"), "screen-id");
  const slotIds = adsListOption(flagString(args.flags, "slot-id"), "slot-id");
  const policy = flagString(args.flags, "policy");
  if (kind === "ad_buyer" && link) throw usageError("--link is available only for member invitations.");
  if (kind === "project_member" && (screenIds.length || slotIds.length || policy !== undefined)) {
    throw usageError("Advertising scope and policy require --kind ad-buyer.");
  }
  if (!uploader && (flagString(args.flags, "folder-id") !== undefined || flagString(args.flags, "playlist-id") !== undefined || flagString(args.flags, "access") !== undefined)) {
    throw usageError("--folder-id, --playlist-id and --access require --kind uploader.");
  }
  const uploadScope = uploader ? uploadScopeFromArgs(args, "invitations create --kind uploader", true) : undefined;
  if (uploadScope?.access !== undefined && uploadScope.access !== "propose" && uploadScope.access !== "manage") throw usageError("--access takes propose or manage.");
  if (kind === "ad_buyer" && !screenIds.length && !slotIds.length) {
    throw usageError("Ad-buyer invitations require at least one --screen-id or --slot-id.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "POST", path: "/api/invitations", idempotent: true,
    body: { kind, delivery: link ? "link" : "email",
      ...(!link ? { emails } : {}),
      ...(uploadScope ? { upload_scope: uploadScope } : {}),
      ...(kind === "ad_buyer" ? { advertising: { screen_ids: screenIds, slot_ids: slotIds, policy: policy ?? "trusted" } } : {}),
    },
  });
  requirePrivateNoStore(response.headers, "Invitation response");
  const body = response.body as { invitations?: InvitationIssued[] };
  if (!Array.isArray(body?.invitations) || !body.invitations.length || (link && body.invitations.length !== 1)) {
    throw usageError("Invitation response does not match the generated invitation contract.");
  }
  const invitations = body.invitations.map((value) => {
    const invitation = validateInvitation(value);
    if (link) {
      if (typeof value.url !== "string" || !value.url) throw usageError("Link invitation response is missing its URL.");
      return { ...invitation, url: value.url };
    }
    return invitation;
  });
  return {
    envelope: successEnvelope({ invitations }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Invitations created", [
      ["invitations", String(invitations.length)],
      ["delivery", link ? "Deliver this link only to the intended person; do not store or log it." : "Email requested; delivery is not confirmed."],
      ...(link ? [["url", (invitations[0] as InvitationIssued).url] as [string, string]] : []),
    ]),
  };
});

export const handleInvitationsList = commandHandler(async (args, runtime, resolved) => {
  const kind = flagString(args.flags, "kind");
  const status = flagString(args.flags, "status");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/invitations", query: {
    ...(kind ? { kind: kind === "ad-buyer" ? "ad_buyer" : "project_member" } : {}),
    ...(status ? { status } : {}),
  } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: JSON.stringify(response.body, null, 2) };
});

export const handleInvitationsRevoke = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("invitations revoke requires ID.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // The route answers 204 with no body; report what happened rather than an empty object.
  await client.call({ method: "POST", path: `/api/invitations/${encodeURIComponent(id)}/revoke`, idempotent: true });
  return {
    envelope: successEnvelope({ id, status: "revoked" }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Invitation revoked", [["id", id], ["status", "revoked"]]),
  };
});

export const handleAdsMembershipsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/memberships", "Memberships"));

/**
 * Update one membership. The route takes the policy and both scope lists, so an
 * unspecified list keeps the stored scope rather than clearing the buyer's
 * access, and the stored policy is reused when --policy is omitted.
 */
export const handleAdsMembershipsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads memberships update requires <membership-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const current = await adsExistingRow(client, "/api/advertising/memberships", "memberships", "id", id);
  const currentRevision = typeof current?.revision === "number" ? String(current.revision) : undefined;
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/memberships/${encodeURIComponent(id)}`,
    body: adsMembershipWriteBody(current, args),
    ifMatch: flagString(args.flags, "if-match") ?? currentRevision,
    human: `Updated membership ${id}. Scope changes stop new selections and invalidate unstarted decisions.`,
  });
});

export const handleAdsMembershipsRevoke = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads memberships revoke requires <membership-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/memberships/${encodeURIComponent(id)}/revoke`,
    human: `Revoked membership ${id}. The buyer's advertiser flag and other networks are unchanged.`,
  });
});

export const handleAdsCreativesList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/creatives", "Creatives"));

export const handleAdsCreativesCreate = commandHandler(async (args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/creatives",
    body: { media_id: flagString(args.flags, "media-id"), copy: flagString(args.flags, "copy") },
    human: "Creative created. It binds the ready media revision; the media is neither charged nor uploaded again.",
  }));

export const handleAdsCreativesShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads creatives show requires <creative-id>.");
  const result = await simpleGet(args, runtime, resolved, `/api/advertising/creatives/${encodeURIComponent(id)}`, "Creative");
  // Each seller's review of this creative, with the reason a seller gave for
  // a rejection or the changes it asked for.
  const reviews = (result.envelope.data as { reviews?: AdvertisingCreativeReview[] } | undefined)?.reviews;
  if (!Array.isArray(reviews) || reviews.length === 0) return result;
  const lines = reviews.map((review) => [
    `review ${review.id} ${review.state}`,
    `seller ${review.seller_project_id}`,
    `revision ${review.creative_revision}`,
    ...(review.campaign_id ? [`campaign ${review.campaign_id}`] : []),
  ].join(" ") + (review.reason ? `: ${plainText(review.reason)}` : ""));
  const [title, ...rest] = (result.human ?? "").split("\n");
  return { ...result, human: [title, ...lines, ...rest].join("\n") };
});

export const handleAdsCampaignsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/campaigns", "Campaigns"));

export const handleAdsCampaignsCreate = commandHandler(async (args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: "/api/advertising/campaigns",
    body: await campaignDraft(args.positionals[3], runtime),
    human: "Campaign draft created. A draft reserves no credits and cannot deliver until an accepted quote activates it.",
  }));

export const handleAdsCampaignsShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns show requires <campaign-id>.");
  return simpleGet(args, runtime, resolved, `/api/advertising/campaigns/${encodeURIComponent(id)}`, "Campaign");
});
/**
 * Quote a campaign. The route requires the current campaign revision as its
 * precondition: the operator can override it with --expect-rev, otherwise the
 * CLI reads that one campaign and uses the revision it just saw.
 */
export const handleAdsCampaignsPreview = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns preview requires <campaign-id>.");
  let ifMatch = flagString(args.flags, "if-match");
  if (ifMatch === undefined) {
    const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
    const campaign = (await client.call({ method: "GET", path: `/api/advertising/campaigns/${encodeURIComponent(id)}` })).body;
    const revision = campaign !== null && typeof campaign === "object" && !Array.isArray(campaign) && "revision" in campaign
      ? campaign.revision : undefined;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw usageError(`Campaign ${id} did not report a usable revision, so its quote cannot be revision-checked.`);
    }
    ifMatch = String(revision);
  }
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/quote`,
    ifMatch,
    human: "Quote priced for current inventory and rates. Preview reserves and spends nothing; activate with --quote-id only after the user accepts this quote.",
  });
});

export const handleAdsCampaignsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns update requires <campaign-id> <file>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}`,
    body: await campaignDraft(args.positionals[4], runtime),
    ifMatch: flagString(args.flags, "if-match"),
    human: `Campaign ${id} draft replaced. Changing accepted scope requires a fresh quote and explicit acceptance.`,
  });
});

export const handleAdsCampaignsActivate = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns activate requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/activate`,
    body: { quote_id: flagString(args.flags, "quote-id") },
    ifMatch: flagString(args.flags, "if-match"),
    human: "Campaign activation accepted the quote. No wallet debit happens here: a per-occurrence hold is placed when the runtime resolves a play and it settles only on the verified completion. Activation is not proof that a screen displayed anything.",
  });
});

export const handleAdsCampaignsPause = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns pause requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/pause`,
    ifMatch: flagString(args.flags, "if-match"),
    human: `Paused campaign ${id}. New reservations stop; already-started valid plays settle at their reserved price.`,
  });
});

export const handleAdsCampaignsResume = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns resume requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/resume`,
    ifMatch: flagString(args.flags, "if-match"),
    human: `Resumed campaign ${id} after a manual pause. Resume cannot clear a price-change pause; that needs a fresh quote accepted with campaigns accept-rates.`,
  });
});

export const handleAdsCampaignsAcceptRates = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads campaigns accept-rates requires <campaign-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/campaigns/${encodeURIComponent(id)}/accept-rates`,
    body: { quote_id: flagString(args.flags, "quote-id") },
    ifMatch: flagString(args.flags, "if-match"),
    human: `Accepted the fresh quote for campaign ${id}. Delivery resumes only if every other blocker, such as review or funds, is also clear.`,
  });
});

export const handleAdsReviewsList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/advertising/reviews", "Creative reviews"));

/**
 * The seller's preview of one submission: the dedicated review metadata route
 * returns the review and the exact creative it decided on, and nothing from the
 * buyer's wider media library.
 */
export const handleAdsReviewsShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews show requires <review-id>.");
  return simpleGet(args, runtime, resolved, `/api/advertising/reviews/${encodeURIComponent(id)}`, "Review");
});

export const handleAdsReviewsApprove = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews approve requires <review-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/reviews/${encodeURIComponent(id)}/approve`,
    human: `Approved review ${id} for that exact creative version.`,
  });
});

export const handleAdsReviewsRequestChanges = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews request-changes requires <review-id>.");
  const note = flagString(args.flags, "note");
  if (!note) throw usageError("ads reviews request-changes requires --note TEXT naming the changes.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/reviews/${encodeURIComponent(id)}/request-changes`,
    body: { note },
    human: `Asked the buyer for changes on review ${id}; the buyer reads the note on the creative and resubmits.`,
  });
});

export const handleAdsReviewsReject = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("ads reviews reject requires <review-id>.");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: `/api/advertising/reviews/${encodeURIComponent(id)}/reject`,
    body: { reason: flagString(args.flags, "reason") },
    human: `Rejected review ${id}; the buyer sees the supplied reason.`,
  });
});

// Reviews of proposed changes: /api/reviews. Agents read them and withdraw
// their own proposals; only a person approves, rejects or asks for changes.
const REVIEW_LIST_MAX = 100;

export const handleReviewsList = commandHandler(async (args, runtime, resolved) => {
  const limit = flagString(args.flags, "limit");
  if (limit !== undefined && Number(limit) > REVIEW_LIST_MAX) throw usageError(`--limit must be at most ${REVIEW_LIST_MAX}.`);
  const state = flagString(args.flags, "state");
  const kind = flagString(args.flags, "kind");
  const cursor = flagString(args.flags, "cursor");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/reviews", query: { state, kind, limit, cursor } });
  const page = (response.body ?? {}) as ReviewList;
  const next = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  const nextArgv = next ? ["reviews", "list", ...(state ? ["--state", state] : []), ...(kind ? ["--kind", kind] : []), ...(limit ? ["--limit", limit] : []), "--cursor", next] : undefined;
  return {
    envelope: jsonBody(response, client.requestId, nextArgv ? { next: { command: `screenrig ${nextArgv.join(" ")}`, argv: nextArgv, reason: "Read the next page of reviews." } } : undefined),
    exitCode: ExitCode.Success,
    human: [...reviewListLines(page), ...(nextArgv ? [`next: screenrig ${nextArgv.join(" ")}`] : [])].join("\n"),
  };
});

export const handleReviewsShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("reviews show requires <review-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/reviews/${encodeURIComponent(id)}` });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reviewDetailLines(response.body as Review).join("\n"),
  };
});

export const handleReviewsWithdraw = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("reviews withdraw requires <review-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `/api/reviews/${encodeURIComponent(id)}/withdraw`, idempotent: true });
  const result = response.body as ReviewDecisionResult | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Withdrew review ${id}; nothing it proposed reaches the screens.`, ...(result?.review ? reviewDetailLines(result.review).slice(1) : [])].join("\n"),
  };
});

/**
 * One report body as readable columns. Money is printed exactly as the server
 * sends it (a decimal mcr string), a missing field is simply absent, and the
 * whole body stays in the JSON envelope unchanged.
 */
function reportLines(title: string, body: unknown, fields: readonly string[], rows?: readonly string[]): string {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const lines = humanLines(title, fields.map((field) => {
    const value = record[field];
    return [field, typeof value === "string" || typeof value === "number" ? String(value) : undefined] as [string, string | undefined];
  })).split("\n");
  const rowValues = rows ? record.rows : undefined;
  if (!rows || !Array.isArray(rowValues)) {
    return lines.join("\n");
  }
  lines.push("rows:");
  for (const value of rowValues) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    lines.push(`  ${rows.map((field) => `${field}=${typeof row[field] === "string" || typeof row[field] === "number" ? String(row[field]) : ""}`).join(" ")}`);
  }
  return lines.join("\n");
}

export const handleAdsReportsSpend = commandHandler(async (args, runtime, resolved) => {
  const spendFile = await reportFileOf(args, runtime, resolved, "/api/advertising/reports/spend", { campaign_id: flagString(args.flags, "campaign-id") }, "ad-spend", "ad spend report");
  if (spendFile) return spendFile;
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/advertising/reports/spend",
    query: { campaign_id: flagString(args.flags, "campaign-id") },
  });
  requirePrivateNoStore(response.headers, "Advertising report response");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportLines("Ad spend", response.body, ["campaign_id", "spent_mcr", "reserved_mcr", "completed", "unbillable", "pending", "estimated_impressions"]),
  };
});

export const handleAdsReportsDelivery = commandHandler(async (args, runtime, resolved) => {
  const deliveryFile = await reportFileOf(args, runtime, resolved, "/api/advertising/reports/delivery", { from: flagString(args.flags, "from"), to: flagString(args.flags, "to") }, "ad-delivery", "ad delivery report");
  if (deliveryFile) return deliveryFile;
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/advertising/reports/delivery",
    query: { from: flagString(args.flags, "from"), to: flagString(args.flags, "to") },
  });
  requirePrivateNoStore(response.headers, "Advertising report response");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportLines("Delivery statement", response.body,
      ["gross_mcr", "fee_mcr", "net_mcr", "completed", "interrupted", "unbillable", "estimated_impressions"],
      ["screen_id", "slot_id", "reservation_id", "gross_mcr", "fee_mcr", "net_mcr", "estimated_impressions", "completed_at"]),
  };
});

const DIRECT_CAMPAIGNS = "/api/advertising/direct-campaigns";
/** Fill statistics cover at most this many days of the seller's ad slots. */
const FILL_MAX_RANGE_MS = 35 * 86_400_000;

function directCampaignPath(args: ParsedArgs, command: string): string {
  const id = args.positionals[3];
  if (!id) throw usageError(`ads direct ${command} requires <campaign-id>.`);
  return `${DIRECT_CAMPAIGNS}/${encodeURIComponent(id)}`;
}

/**
 * Read one JSON document for the direct commands, `-` for stdin. The server
 * validates every field, including the category list, goal and price; this only
 * refuses what is not a JSON object or lacks the fields every draft needs.
 */
async function directDocument(file: string | undefined, runtime: CliRuntime, what: string): Promise<Record<string, unknown>> {
  if (!file) throw usageError(`ads direct requires a ${what} JSON document.`);
  let parsed: unknown;
  try {
    parsed = await readAuthoringJson(file, runtime);
  } catch (error) {
    throw usageError(`Cannot read the ${what} JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw usageError(`A ${what} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

async function directDraft(file: string | undefined, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const draft = await directDocument(file, runtime, "direct campaign draft");
  const fail = (field: string, expectation: string): never => {
    throw usageError(`Direct campaign draft field ${field} ${expectation}`);
  };
  for (const field of ["name", "advertiser", "flight_start", "flight_end"] as const) {
    if (typeof draft[field] !== "string" || draft[field].trim().length === 0) {
      fail(field, field === "name" || field === "advertiser" ? "must be a non-empty string." : "must be an RFC 3339 timestamp string.");
    }
  }
  if (!Array.isArray(draft.media_ids) || draft.media_ids.length === 0 || draft.media_ids.some((item) => typeof item !== "string")) {
    fail("media_ids", "must be a non-empty array of media identifiers.");
  }
  if (draft.goal_plays !== undefined && (typeof draft.goal_plays !== "number" || !Number.isSafeInteger(draft.goal_plays) || draft.goal_plays < 0)) {
    fail("goal_plays", "must be a whole number of plays when present; 0 or omitted takes every eligible slot during the flight.");
  }
  if (draft.overbook !== undefined && typeof draft.overbook !== "boolean") {
    fail("overbook", "must be true or false when present.");
  }
  return draft;
}

/** --from/--to of the direct reports: RFC 3339, now or an age such as 7d, sent as RFC 3339. Each is optional. */
function adsWindow(args: ParsedArgs, runtime: CliRuntime, maxMs?: number): { from?: string; to?: string } {
  requireFlagValue(args, "from", "7d");
  requireFlagValue(args, "to", "now");
  const now = runtime.now();
  const from = flagString(args.flags, "from");
  const to = flagString(args.flags, "to");
  const fromMs = from === undefined ? undefined : playsInstant(from, "--from", now);
  const toMs = to === undefined ? undefined : playsInstant(to, "--to", now);
  if (fromMs !== undefined && toMs !== undefined) {
    if (fromMs >= toMs) throw usageError("--from must be before --to.");
    if (maxMs !== undefined && toMs - fromMs > maxMs) {
      throw usageError(`--from to --to must span at most ${maxMs / 86_400_000} days.`);
    }
  }
  return { ...(fromMs === undefined ? {} : { from: isoUtc(fromMs) }), ...(toMs === undefined ? {} : { to: isoUtc(toMs) }) };
}

export const handleAdsDirectList = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, DIRECT_CAMPAIGNS, "Direct campaigns"));

export const handleAdsDirectShow = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, directCampaignPath(args, "show"), "Direct campaign"));

export const handleAdsDirectCreate = commandHandler(async (args, runtime, resolved) =>
  adsMutation(args, runtime, resolved, {
    method: "POST",
    path: DIRECT_CAMPAIGNS,
    body: await directDraft(args.positionals[3], runtime),
    human: "Direct campaign created. It fills this project's own ad slots before marketplace campaigns and moves no money through screenRIG: you bill the advertiser.",
  }));

export const handleAdsDirectUpdate = commandHandler(async (args, runtime, resolved) => {
  const target = directCampaignPath(args, "update");
  return adsMutation(args, runtime, resolved, {
    method: "POST",
    path: target,
    body: await directDraft(args.positionals[4], runtime),
    ifMatch: flagString(args.flags, "if-match"),
    human: `Direct campaign ${args.positionals[3]} replaced from the draft. Every writable field now holds the draft's value.`,
  });
});

const directTransition = (verb: "pause" | "resume" | "end", human: (id: string) => string) =>
  commandHandler(async (args, runtime, resolved) => {
    const target = directCampaignPath(args, verb);
    return adsMutation(args, runtime, resolved, {
      method: "POST",
      path: `${target}/${verb}`,
      ifMatch: flagString(args.flags, "if-match"),
      human: human(args.positionals[3]!),
    });
  });

export const handleAdsDirectPause = directTransition("pause", (id) => `Paused direct campaign ${id}. It stops taking ad slots until it is resumed.`);
export const handleAdsDirectResume = directTransition("resume", (id) => `Resumed direct campaign ${id}. It takes eligible ad slots again within its flight.`);
export const handleAdsDirectEnd = directTransition("end", (id) => `Ended direct campaign ${id}. Ending is final: create a new direct campaign to run it again. Its report stays readable.`);

/** Availability is a read: the POST carries the query document and changes nothing. */
export const handleAdsDirectAvailability = commandHandler(async (args, runtime, resolved) => {
  const query = await directDocument(args.positionals[3], runtime, "availability query");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/advertising/availability", body: query });
  requirePrivateNoStore(response.headers, "Advertising availability response");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportLines("Ad availability", response.body,
      ["estimated_plays", "booked_plays", "available_plays", "screens", "observed_from", "observed_to", "flight_start", "flight_end"]),
  };
});

const DIRECT_REPORT_ROW_FIELDS = ["day", "screen_id", "slot_id", "media_id", "plays", "played_ms", "estimated_impressions"] as const;

/** The money value of a report, `12.50 USD (cpm)`, or undefined when the campaign records no price. */
function directValueLine(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { amount, currency, model } = value as Record<string, unknown>;
  return typeof amount === "string" ? `${amount}${typeof currency === "string" ? ` ${currency}` : ""}${typeof model === "string" ? ` (${model})` : ""}` : undefined;
}

export const handleAdsDirectReport = commandHandler(async (args, runtime, resolved) => {
  const target = directCampaignPath(args, "report");
  const id = args.positionals[3]!;
  const window = adsWindow(args, runtime);
  const directFile = await reportFileOf(args, runtime, resolved, `${target}/report`, window, `direct-report-${id}`, "direct campaign report", true);
  if (directFile) return directFile;
  const format = playbackFormat(args, "ads direct report");
  const toStdout = flagString(args.flags, "output") === "-";
  const outputPath = format === "csv" && !toStdout
    ? await resolveDownloadOutput(runtime.cwd(), `./direct-report-${id}.csv`, args.flags)
    : undefined;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${target}/report`, query: window });
  requirePrivateNoStore(response.headers, "Advertising report response");
  const report = response.body && typeof response.body === "object" && !Array.isArray(response.body) ? response.body as Record<string, unknown> : {};
  const rows = (Array.isArray(report.rows) ? report.rows : []).filter((row): row is Record<string, unknown> =>
    !!row && typeof row === "object" && !Array.isArray(row));
  const truncated = report.truncated === true;
  const truncation: Warning = { code: "direct_report_truncated", message: "The report holds only part of the rows for this period. Narrow --from and --to and run it again for the rest." };

  if (format === "json") {
    const envelope = jsonBody(response, client.requestId, undefined, truncated ? [truncation] : []);
    const lines = humanLines("Direct campaign report", [
      ["campaign_id", typeof report.campaign_id === "string" ? report.campaign_id : undefined],
      ["name", typeof report.name === "string" ? report.name : undefined],
      ["advertiser", typeof report.advertiser === "string" ? report.advertiser : undefined],
      ["period", typeof report.from === "string" && typeof report.to === "string" ? `${report.from} to ${report.to}` : undefined],
      ...(["goal_plays", "delivered_plays", "plays", "played_ms", "not_played", "estimated_impressions"] as const).map((field): [string, string | undefined] =>
        [field, typeof report[field] === "number" ? String(report[field]) : undefined]),
      ["value", directValueLine(report.value)],
    ]).split("\n");
    if (rows.length > 0) {
      lines.push("rows:");
      for (const row of rows) lines.push(`  ${DIRECT_REPORT_ROW_FIELDS.map((field) => `${field}=${row[field] ?? ""}`).join(" ")}`);
    }
    if (truncated) lines.push(`warning: ${truncation.message}`);
    return { envelope, exitCode: ExitCode.Success, human: lines.join("\n") };
  }

  const csv = [
    csvRecord(DIRECT_REPORT_ROW_FIELDS),
    ...rows.map((row) => csvRecord(DIRECT_REPORT_ROW_FIELDS.map((field) => row[field] as string | number | undefined))),
  ].join("");
  const what = "direct campaign report";
  if (toStdout) {
    if (formatResultContext(runtime)) runtime.stderr.write(`${formatResultContext(runtime)}\n`);
    await writeCsvStdout(csvByteStream(csv), runtime.stdout, what, client.requestId);
    if (truncated) runtime.stderr.write(`warning: ${truncation.message}\n`);
    return { envelope: successEnvelope({}), exitCode: ExitCode.Success, human: "", output: "stream" };
  }
  const file = await writeCsvFile(csvByteStream(csv), outputPath!, what, client.requestId);
  const data = {
    path: file.path, bytes: file.bytes, rows: file.rows, sha256: file.sha256, content_type: "text/csv",
    campaign_id: id,
    ...(typeof report.from === "string" ? { from: report.from } : {}),
    ...(typeof report.to === "string" ? { to: report.to } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: truncated ? [truncation] : [] }),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Direct campaign report exported", [
        ["path", file.path], ["rows", String(file.rows)], ["bytes", String(file.bytes)], ["sha256", file.sha256],
      ]),
      ...(truncated ? [`warning: ${truncation.message}`] : []),
    ].join("\n"),
  };
});

export const handleAdsReportsFill = commandHandler(async (args, runtime, resolved) => {
  const window = adsWindow(args, runtime, FILL_MAX_RANGE_MS);
  const fillFile = await reportFileOf(args, runtime, resolved, "/api/advertising/reports/fill", window, "ad-fill", "ad fill report");
  if (fillFile) return fillFile;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/advertising/reports/fill", query: window });
  requirePrivateNoStore(response.headers, "Advertising report response");
  const report = response.body && typeof response.body === "object" && !Array.isArray(response.body) ? response.body as Record<string, unknown> : {};
  const lines = humanLines("Ad slot fill", [
    ["period", typeof report.from === "string" && typeof report.to === "string" ? `${report.from} to ${report.to}` : undefined],
    ...(["occurrences", "direct", "marketplace", "vast", "unfilled", "fill_rate"] as const).map((field): [string, string | undefined] =>
      [field, typeof report[field] === "number" ? String(report[field]) : undefined]),
  ]).split("\n");
  const reasons = report.unfilled_reasons;
  if (reasons && typeof reasons === "object" && !Array.isArray(reasons)) {
    lines.push(`unfilled_reasons: ${Object.entries(reasons).map(([reason, count]) => `${reason}=${count}`).join(" ")}`);
  }
  if (Array.isArray(report.days)) {
    lines.push("days:");
    for (const value of report.days) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const day = value as Record<string, unknown>;
      lines.push(`  ${["day", "occurrences", "direct", "marketplace", "vast", "unfilled", "fill_rate"].map((field) => `${field}=${day[field] ?? ""}`).join(" ")}`);
    }
  }
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: lines.join("\n") };
});

/**
 * Read this project's shared balance. The withdrawal section is reported as the
 * server states it: while payment rails are unconfigured the balance explains
 * that plainly instead of implying a payout path or a second wallet.
 */
export const handleBillingBalance = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/billing/balance" });
  requirePrivateNoStore(response.headers, "Billing balance response");
  const body = (response.body ?? {}) as {
    remaining_mcr?: unknown; reserved_mcr?: unknown; available_mcr?: unknown;
    withdrawal?: { allowed?: unknown; eligible_earned_mcr?: unknown; rails_available?: unknown; unavailable_reason?: unknown; blockers?: unknown };
  };
  const withdrawal = body.withdrawal ?? {};
  const blockers = Array.isArray(withdrawal.blockers) ? withdrawal.blockers.filter((item): item is string => typeof item === "string") : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Credit balance", [
      ["remaining_mcr", typeof body.remaining_mcr === "string" ? body.remaining_mcr : undefined],
      ["reserved_mcr", typeof body.reserved_mcr === "string" ? body.reserved_mcr : undefined],
      ["available_mcr", typeof body.available_mcr === "string" ? body.available_mcr : undefined],
      ["withdrawal_allowed", withdrawal.allowed === undefined ? undefined : String(withdrawal.allowed)],
      ["eligible_earned_mcr", typeof withdrawal.eligible_earned_mcr === "string" ? withdrawal.eligible_earned_mcr : undefined],
      ["rails", withdrawal.rails_available === false
        ? `unavailable (${typeof withdrawal.unavailable_reason === "string" ? withdrawal.unavailable_reason : "no payment rail"}); credits are spent in the dashboard and no payout can be requested from this CLI`
        : withdrawal.rails_available === true ? "available to the verified financial administrator in the dashboard" : undefined],
      ["blockers", blockers.length > 0 ? blockers.join(", ") : undefined],
      ["note", "purchased credits are not withdrawable, and promotional or included grants cannot fund paid ad spend"],
    ]),
  };
});

export const handleBillingStatement = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/billing/statement", "Credit statement", {
    cursor: flagString(args.flags, "cursor"),
    limit: flagString(args.flags, "limit"),
  }));

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Reject a body that does not match the generated project invitation contract. */
function validateInvitation(value: unknown): Invitation {
  const invitation = value as Partial<Invitation> | undefined;
  if (!invitation || typeof invitation.id !== "string" || !invitation.id
    || !["project_member", "ad_buyer"].includes(invitation.kind ?? "")
    || !["email", "link"].includes(invitation.delivery ?? "")
    || !["queued", "sent", "issued", "accepted", "revoked", "expired", "failed"].includes(invitation.status ?? "")
    || typeof invitation.project_id !== "string" || !invitation.project_id
    || !isDateTime(invitation.created_at) || !isDateTime(invitation.expires_at)) {
    throw usageError("Invitation response does not match the generated invitation contract.");
  }
  // Project onto the credential-free contract before the explicit link handoff.
  return {
    id: invitation.id, kind: invitation.kind!, delivery: invitation.delivery!, status: invitation.status!,
    project_id: invitation.project_id, created_at: invitation.created_at!, expires_at: invitation.expires_at!,
    ...(invitation.recipient_email ? { recipient_email: invitation.recipient_email } : {}),
    ...(invitation.advertising ? { advertising: invitation.advertising } : {}),
    ...(invitation.upload_scope ? { upload_scope: invitation.upload_scope } : {}),
  };
}

/** The contract is closed: only {status:"accepted"}, identically for enrolled and unknown addresses. */
function validateSignInResetAccepted(value: unknown): void {
  const body = value as { status?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || body.status !== "accepted") {
    throw usageError("Sign-in reset response does not match the accepted contract.");
  }
}

/** Unauthenticated, durable and neutral for known and unknown email addresses. */
async function signInReset(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const email = signInResetEmail(flagString(args.flags, "email"));
  const configFs = { ...runtime.fs, env: runtime.env, homedir: runtime.homedir };
  // The durable retry ledger lives in the user config, which an unenrolled
  // installation does not have yet. Seed a credential-free config; recovery
  // never writes a token, project, agent, or enrollment state into it.
  if (!(await readConfigFile(resolved.configPath, configFs))) {
    await withConfigLock(
      resolved.configPath,
      configFs,
      { sleep: runtime.sleep, now: () => runtime.now().getTime() },
      async () => {
        if (await readConfigFile(resolved.configPath, configFs)) return;
        await writeConfigAtomic(resolved.configPath, {
          api_url: resolved.apiUrl,
          updated_at: runtime.now().toISOString(),
        }, configFs);
      },
    );
  }
  const client = clientFor(runtime, args, resolved.apiUrl, undefined, writeRecoveries.get(runtime));
  const response = await client.call({
    method: "POST",
    path: "/api/sign-in-resets",
    idempotent: true,
    body: { email },
  });
  requirePrivateNoStore(response.headers, "Sign-in reset response");
  validateSignInResetAccepted(response.body);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Sign-in reset request accepted", [
      ["status", "accepted"],
      ["delivery", "If this address can receive sign-in instructions, check its inbox. Delivery is not confirmed."],
      ["request_id", client.requestId],
    ]),
  };
}

async function appPack(args: ParsedArgs, runtime: CliRuntime): Promise<CommandResult> {
  const dir = args.positionals[2];
  if (!dir) {
    throw usageError("app pack requires a directory.");
  }
  const result = await packDirectory(await requireAppDirectory(runtime, dir, "app pack ./DIRECTORY"), { logger: loggerOf(runtime) });
  const output = flagString(args.flags, "output");
  if (output) {
    await writeFile(path.resolve(runtime.cwd(), output), result.archive);
  }
  const data = {
    sha256: result.sha256,
    compressed_bytes: result.compressed_bytes,
    expanded_bytes: result.expanded_bytes,
    file_count: result.file_count,
    entries: result.entries,
    sdk_injection: result.sdk_injection,
    output,
  };
  return {
    envelope: successEnvelope(data),
    exitCode: ExitCode.Success,
    human: humanLines("Archive packed", [
      ["sha256", result.sha256],
      ["compressed_bytes", String(result.compressed_bytes)],
      ["expanded_bytes", String(result.expanded_bytes)],
      ["file_count", String(result.file_count)],
      ["sdk_injection", result.sdk_injection.injected ? "yes" : "deferred"],
    ]),
  };
}

/** Name a missing or unusable input file before any tool or request runs on it. */
export async function requireInputFile(resolved: string, given: string): Promise<void> {
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw usageError(`${given} does not exist.`);
    throw usageError(`${given} cannot be read.`);
  }
  if (info.isDirectory()) throw usageError(`${given} is a directory; pass a file.`);
}

/** app upload and update pack the built directory themselves; a packed archive or other file is a usage error. */
async function requireAppDirectory(runtime: CliRuntime, dir: string, usage: string): Promise<string> {
  const root = path.resolve(runtime.cwd(), dir);
  let isDirectory = false;
  try {
    isDirectory = (await stat(root)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw usageError(`${dir} does not exist. Pass the built application directory (the one with index.html).`,
      { command: `screenrig ${usage}`, reason: "Packs and uploads the directory in one step." });
  }
  if (!isDirectory) {
    throw usageError(`${dir} is a file. Pass the built application directory (the one with index.html), not a packed archive; the upload packs the directory itself.`,
      { command: `screenrig ${usage}`, reason: "Packs and uploads the directory in one step; app pack is only an optional local preview." });
  }
  return root;
}

async function appUpload(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>, update: boolean): Promise<CommandResult> {
  const id = update ? args.positionals[2] : undefined;
  const dir = args.positionals[update ? 3 : 2];
  requireFlagValue(args, "if-match", "1");
  const revision = flagString(args.flags, "if-match");
  if (!dir || (update && !id)) {
    throw usageError(update ? "app update requires <id> <directory>." : "app upload requires one directory.");
  }
  if (update && args.flags.name !== undefined) throw usageError("app update preserves the application name; use app rename <id> --name NAME to rename it.");
  const ifMatch = update && revision ? quotedRevision(revision) : undefined;
  requireFlagValue(args, "name", "Lobby board");
  const name = flagString(args.flags, "name");
  const nameHeaders = applicationNameHeaders(name);
  const root = await requireAppDirectory(runtime, dir, update ? `app update ${id} ./DIRECTORY` : "app upload ./DIRECTORY");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const capabilitiesResponse = await client.call({ method: "GET", path: "/api/capabilities" });
  const capabilities = capabilitiesResponse.body as Capabilities;
  const packed = await packDirectory(root, {
    limits: limitsFromCapabilities(capabilities),
    logger: loggerOf(runtime),
  });
  // Where the server takes them, the archive goes straight to the object
  // store (declare, signed PUT, commit), so a slow uplink is not cut off by
  // the API's proxy. Older servers take the streamed POST.
  const { accepted: body, response } = directApplicationUploads(capabilities)
    ? await uploadApplicationDirect({
      runtime, client, packed, sdkVersion: SDK_PROTOCOL_VERSION,
      ...(update ? { applicationId: id! } : {}),
      ...(ifMatch ? { ifMatch } : {}),
      ...(name !== undefined ? { name: normalizeApplicationName(name) } : {}),
    })
    : await client.call({
      method: "POST",
      path: update ? `/api/applications/${encodeURIComponent(id!)}/releases` : "/api/applications",
      idempotent: true,
      headers: {
        "content-type": "application/gzip",
        "screenrig-archive-sha256": packed.sha256,
        "screenrig-expanded-bytes": String(packed.expanded_bytes),
        "screenrig-file-count": String(packed.file_count),
        "screenrig-sdk-version": SDK_PROTOCOL_VERSION,
        ...(ifMatch ? { "if-match": ifMatch } : {}),
        ...nameHeaders,
      },
      body: packed.archive,
    }).then((streamed) => ({ accepted: streamed.body as OperationAccepted, response: streamed }));
  const operation = !flagBool(args.flags, "no-wait") && body.operation_id
    ? await client.waitForOperation(body.operation_id, {
      timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
      pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
      sleep: runtime.sleep,
    })
    : null;
  return {
    // The accepted body, whichever way the archive traveled: a direct upload's
    // commit answers the operation, not the accepted application.
    envelope: jsonBody({ body, headers: response.headers }, client.requestId, {
      // Keep the historical flat accepted fields and sha256 as aliases while
      // exposing the same canonical paths regardless of waiting mode.
      application: body,
      operation,
      pack: { sha256: packed.sha256, file_count: packed.file_count },
      sha256: packed.sha256,
    }),
    exitCode: ExitCode.Success,
    human: humanLines(
      operation
        ? (update ? "Application release uploaded" : "Application uploaded")
        : (update ? "Application release accepted" : "Application upload accepted"),
      [
        ["application_id", body.id],
        // Application primitives use the release id, not the application id.
        ["release_id", body.release_id],
        ["operation_id", body.operation_id],
        ["state", operation?.state],
        ["sha256", packed.sha256],
      ],
    ),
  };
}

/** The report commands that also write their route's rows as a file (--format csv, xlsx or pdf), by command and file name stem. */
const REPORT_FILE_COMMANDS: Record<string, string> = {
  "project uptime": "project-uptime",
  "project health-trend": "health-trend",
  "screen uptime": "screen-uptime",
  "screen health-history": "screen-health-history",
  "playback totals": "play-totals",
  "playback completeness": "play-completeness",
};

/**
 * `--format csv|xlsx|pdf` of a report command: the server writes the file (the
 * route's format member, every page of it) and this saves it to --output, by
 * default ./<name>.<format>; - is not accepted for a binary file. json (the
 * default) stays the command envelope. nativeCsv leaves csv to a command that
 * streams its own.
 */
async function reportFileOf(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  pathName: string,
  query: Record<string, string | undefined> | undefined,
  stem: string,
  what: string,
  nativeCsv = false,
): Promise<CommandResult | undefined> {
  requireFlagValue(args, "format", "xlsx");
  const format: ReportFormat = reportFormat(args);
  if (!wantsReportFile(format, nativeCsv)) {
    if (format === "json" && args.flags.output !== undefined) throw usageError("--output applies to --format csv, xlsx or pdf. JSON is the command envelope on stdout.");
    return undefined;
  }
  if (flagString(args.flags, "output") === "-") throw usageError("--output - writes only a CSV stream; give a file path.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const file = await downloadReportFile(client, { path: pathName, query, format, output: flagString(args.flags, "output"), stem, cwd: runtime.cwd(), what });
  const result = reportFileResult(file);
  return { envelope: result.envelope, exitCode: ExitCode.Success, human: result.human };
}

async function simpleGet(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  pathName: string,
  title: string,
  query?: Record<string, string | undefined>,
  paged: boolean | ListAllOptions = false,
): Promise<CommandResult> {
  const stem = REPORT_FILE_COMMANDS[args.command.slice(0, 2).join(" ")];
  if (stem !== undefined) {
    const file = await reportFileOf(args, runtime, resolved, pathName, query, stem, title.toLowerCase());
    if (file) return file;
  }
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = paged
    ? await client.listAll(pathName, query, paged === true ? undefined : paged)
    : await client.call({ method: "GET", path: pathName, query });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `${title}\n${JSON.stringify(response.body, null, 2)}`,
  };
}

/** simpleGet for a cursor-paged list: every page is read, and data holds all the items with next_cursor null. */
function simpleList(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: ResolvedCommandConfig,
  pathName: string,
  title: string,
  query?: Record<string, string | undefined>,
  options?: ListAllOptions,
): Promise<CommandResult> {
  return simpleGet(args, runtime, resolved, pathName, title, query, options ?? true);
}

const MEDIA_TAG_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const PLAYBACK_DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function requireFlagValue(args: ParsedArgs, name: string, example: string): void {
  if (args.flags[name] === true) {
    throw usageError(`--${name} requires a value, such as --${name} ${example}.`);
  }
}

function mediaTagFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "tag", "lobby");
  const tag = flagString(args.flags, "tag");
  if (tag === undefined) {
    return undefined;
  }
  if (!MEDIA_TAG_PATTERN.test(tag)) {
    throw usageError("--tag must be 1 to 32 letters or digits.");
  }
  return tag;
}

function mediaPrimitiveFromArgs(args: ParsedArgs): "image" | "video" | "audio" | undefined {
  requireFlagValue(args, "primitive", "image");
  const primitive = flagString(args.flags, "primitive");
  if (primitive === undefined) {
    return undefined;
  }
  if (primitive !== "image" && primitive !== "video" && primitive !== "audio") {
    throw usageError("--primitive must be image, video, or audio.");
  }
  return primitive;
}

function screenListQuery(args: ParsedArgs): { query: Record<string, string>; repeated?: Record<string, string[]> } {
  const state = screenListStateFromArgs(args);
  const tag = screenListTagFromArgs(args);
  const folder = screenListFolderFromArgs(args);
  const facts = screenListFacts(args.flags);
  return { query: { ...(state ? { state } : {}), ...(tag ? { tag } : {}), ...(folder ? { folder } : {}), ...facts.query }, ...(facts.repeated ? { repeated: facts.repeated } : {}) };
}

/** --folder: a screen folder ID, or root for the screens outside every folder. */
function screenListFolderFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "folder", "sfd_NORTH");
  const folder = flagString(args.flags, "folder");
  return folder === undefined || folder === "root" ? folder : screenFolderId(folder, "--folder");
}

function screenListTagFromArgs(args: ParsedArgs): string | undefined {
  requireFlagValue(args, "tag", "Lobby");
  const tag = flagString(args.flags, "tag");
  return tag === undefined ? undefined : screenTag(tag);
}

/** Printable tags: only grammar-shaped values, so server text never reaches a table cell unchecked. */
function screenTags(screen: Screen | undefined): string[] {
  const tags = screen?.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string" && /^[A-Za-z0-9]{1,32}$/.test(tag)) : [];
}

/** The screen folder holding a screen, when it sits in one; only an id-shaped value is printed. */
function screenFolderCell(screen: Screen | undefined): string {
  const folder = screen?.folder_id;
  return typeof folder === "string" && SCREEN_FOLDER_ID_PATTERN.test(folder) ? folder : "";
}

function screenFolderLine(screen: Screen | undefined): string[] {
  const folder = screenFolderCell(screen);
  return folder ? [`Folder: ${folder} (screen folder show ${folder})`] : [];
}

function screenListStateFromArgs(args: ParsedArgs): "archived" | undefined {
  requireFlagValue(args, "state", "archived");
  const state = flagString(args.flags, "state");
  if (state === undefined) {
    return undefined;
  }
  if (state !== "archived") {
    throw usageError("--state must be archived.");
  }
  return state;
}

export const handleMediaList = commandHandler(async (args, runtime, resolved) => {

  const folder = flagString(args.flags, "folder");
  return simpleList(args, runtime, resolved, "/api/media", "Media", {
    tag: mediaTagFromArgs(args),
    primitive: mediaPrimitiveFromArgs(args),
    ...(folder === undefined ? {} : { folder: folder === "root" ? folder : mediaFolderId(folder, "--folder") }),
  });
}, true);

export const handleMediaShow = commandHandler(async (args, runtime, resolved) => {

  const id = args.positionals[2];
  if (!id) throw usageError("media show requires an id.");
  return simpleGet(args, runtime, resolved, `/api/media/${id}`, "Media");
}, true);

export const handleSelectorPreview = commandHandler(async (args, runtime, resolved) => {
  const file = args.positionals[2];
  if (!file) throw usageError("media selector-preview requires <selector.json> and --primitive image|video.");
  const selector = await readAuthoringJson(file, runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const rect = flagString(args.flags, "rect");
  let rectBody: { width: number; height: number } | undefined;
  if (rect !== undefined) {
    const match = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(rect);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw usageError("media selector-preview --rect takes WIDTHxHEIGHT, both above 0, for example 1080x1920.");
    rectBody = { width: Number(match[1]), height: Number(match[2]) };
  }
  const timezone = flagString(args.flags, "timezone");
  const response = await client.call({ method: "POST", path: "/api/selectors/preview", body: { primitive: flagString(args.flags, "primitive"), selector, ...(rectBody ? { rect: rectBody } : {}), ...(timezone === undefined ? {} : { timezone }) } });
  const preview = response.body as { candidates?: Array<{ filename: string; media_id: string; weight?: number; share_percent?: number }>; excluded?: Array<{ filename: string; media_id: string; reason: string }>; cycle?: number };
  const shares = (preview.candidates ?? []).filter((item) => item.share_percent !== undefined).map((item) => `${item.share_percent}%\t${item.filename}\t${item.media_id}`);
  const left = (preview.excluded ?? []).map((item) => `left out (${item.reason})\t${item.filename}\t${item.media_id}`);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [JSON.stringify(response.body, null, 2), ...(shares.length > 0 ? [`Expected shares (one cycle is ${preview.cycle} plays):`, ...shares] : []), ...left].join("\n"),
  };
}, true);

export const handleMediaUpdate = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return mediaUpdate(args, client);
}, true);

export const handleMediaDownload = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "media.download", message: "media download" }, () =>
    mediaDownload(args, runtime, client),
  );
}, true);

export const handleMediaDelete = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const revision = flagString(args.flags, "if-match");
  if (!id) throw usageError("media delete requires <id>.");
  const response = await client.call({
    method: "DELETE",
    path: `/api/media/${id}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted media ${id}` };
}, true);

const MEDIA_FOLDER_ID_PATTERN = /^(?:(?:stage|qa|development)_)?mfd_[A-Za-z0-9]{1,64}$/;

function mediaFolderId(value: string | undefined, label: string): string {
  if (!value || !MEDIA_FOLDER_ID_PATTERN.test(value)) {
    throw usageError(`${label} must be a media folder ID (mfd_...); media folder list shows them.`);
  }
  return value;
}

/** `--folder` on an upload: the destination must exist before any transcode or transfer work starts. */
async function uploadFolderFromArgs(args: ParsedArgs, client: ApiClient): Promise<string | undefined> {
  const folder = flagString(args.flags, "folder");
  if (folder === undefined) return undefined;
  const id = mediaFolderId(folder, "--folder");
  await client.call({ method: "GET", path: `/api/media-folders/${id}` });
  return id;
}

export const handleMediaFolderList = commandHandler(async (args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/media-folders", "Media folders"), true);

export const handleMediaFolderShow = commandHandler(async (args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, `/api/media-folders/${mediaFolderId(args.positionals[3], "media folder show <id>")}`, "Media folder"), true);

export const handleMediaFolderCreate = commandHandler(async (args, runtime, resolved) => {
  const parent = flagString(args.flags, "parent");
  const body: { name: string; parent_id?: string } = { name: flagString(args.flags, "name")! };
  if (parent !== undefined) body.parent_id = mediaFolderId(parent, "--parent");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/media-folders", idempotent: true, body });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Created media folder ${(response.body as { id: string }).id}` };
}, true);

export const handleMediaFolderUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = mediaFolderId(args.positionals[3], "media folder update <id>");
  const name = flagString(args.flags, "name");
  const parent = flagString(args.flags, "parent");
  const root = flagBool(args.flags, "root");
  const revision = flagString(args.flags, "if-match");
  if (name === undefined && parent === undefined && !root) {
    throw usageError("media folder update requires --name NAME, --parent ID, or --root.");
  }
  const body: { name?: string; parent_id?: string | null } = {};
  if (name !== undefined) body.name = name;
  if (parent !== undefined) body.parent_id = mediaFolderId(parent, "--parent");
  if (root) body.parent_id = null;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "PATCH", path: `/api/media-folders/${id}`, idempotent: true, body,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Updated media folder ${id}` };
}, true);

export const handleMediaFolderDelete = commandHandler(async (args, runtime, resolved) => {
  const id = mediaFolderId(args.positionals[3], "media folder delete <id>");
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "DELETE", path: `/api/media-folders/${id}`, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted media folder ${id}; its contents moved up one level` };
}, true);

export const handleMediaMove = commandHandler(async (args, runtime, resolved) => {
  const destination = flagString(args.flags, "folder");
  const toRoot = flagBool(args.flags, "root");
  if ((destination === undefined) === !toRoot) throw usageError("media move requires exactly one of --folder ID or --root.");
  const media_ids: string[] = [];
  const folder_ids: string[] = [];
  for (const id of args.positionals.slice(2)) {
    if (MEDIA_FOLDER_ID_PATTERN.test(id)) folder_ids.push(id);
    else if (MEDIA_ID_PATTERN.test(id)) media_ids.push(id);
    else throw usageError(`media move takes media IDs (med_...) and folder IDs (mfd_...), not ${JSON.stringify(id)}.`);
  }
  if (!media_ids.length && !folder_ids.length) throw usageError("media move requires at least one media or folder ID.");
  const body = {
    folder_id: destination === undefined ? null : mediaFolderId(destination, "--folder"),
    ...(media_ids.length ? { media_ids } : {}),
    ...(folder_ids.length ? { folder_ids } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/media/move", idempotent: true, body });
  const moved = response.body as { media: number; folders: number };
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Moved ${moved.media} files and ${moved.folders} folders` };
}, true);

export const handleMediaGenerate = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "media.generate", message: "media generate" }, () =>
    mediaGenerate(args, runtime, client, resolved),
  );
}, true);

export const handleMediaUpload = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "media.upload", message: "media upload" }, () =>
    mediaUpload(args, runtime, client),
  );
}, true);

export const handleMediaUploadBatch = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return mediaUploadBatch(args, runtime, client, resolved);
}, true);

const GENERATE_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
const GENERATE_QUALITIES = ["low", "medium", "high"] as const;
const GENERATE_PROMPT_MAX = 4000;

/**
 * `media generate` asks the server to answer with the generation's operation
 * (`Prefer: respond-async`) and then waits on that operation. One request that
 * stays open while the image vendor works would be cut off by the proxy in front
 * of the API after 100 s without a byte. The server's own budget for the vendor,
 * the render, the store and the debit is 165 s, so the wait sits above it and the
 * CLI never abandons a still the project has already been billed for. `--timeout`
 * sets the wait, as it does for the other operations.
 */
const GENERATE_WAIT_MS = 180_000;

/** Measured durations per tier, for the up-front notice only. */
const GENERATE_TYPICAL_SECONDS: Record<MediaGenerationQuality, number> = {
  low: 15,
  medium: 35,
  high: 80,
};

function isGenerateAspectRatio(value: string): value is MediaGenerationAspectRatio {
  return (GENERATE_ASPECT_RATIOS as readonly string[]).includes(value);
}

function isGenerateQuality(value: string): value is MediaGenerationQuality {
  return (GENERATE_QUALITIES as readonly string[]).includes(value);
}

function mediaGenerationFromBody(body: unknown): MediaGeneration {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  const rec = body as Record<string, unknown>;
  const media = rec.media;
  const usage = rec.usage;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  const id = (media as { id?: unknown }).id;
  if (typeof id !== "string" || !isResourceID(id, "media")) {
    throw unexpectedResponseError("Media generation response is missing a med_… media id.");
  }
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  const credits = (usage as { credits?: unknown }).credits;
  const usd = (usage as { usd?: unknown }).usd;
  if (typeof credits !== "number" || !Number.isInteger(credits) || credits < 1) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  if (typeof usd !== "string" || usd.length < 1) {
    throw unexpectedResponseError("Media generation response does not match the MediaGeneration contract.");
  }
  return {
    media: media as MediaGeneration["media"],
    usage: usage as MediaGeneration["usage"],
  };
}

/**
 * A billed generation whose answer never arrived leaves the caller unable
 * to say whether the still exists. Name both ways to find out: the identical
 * re-run replays under the stored key, and the listing shows what the project
 * actually holds.
 */
/**
 * A generation answer the CLI cannot use (empty, not JSON, wrong status, not a
 * MediaGeneration) leaves the outcome unknown. Say how to check before an
 * agent generates, and pays for, a second still.
 */
function unusableGenerateAnswer(error: unknown, tag?: string): unknown {
  if (!(error instanceof CliError) || error.problem.code !== "unexpected_response") return error;
  const listCommand = tag ? `screenrig media list --tag ${tag}` : "screenrig media list --primitive image";
  return new CliError({
    ...error.problem,
    hint: `The server's answer did not describe a generated still, so it is unknown whether one was created. Check ${listCommand} before generating again; if no new still is there, create the image with your own tools and add it with screenrig media upload, and report the request_id with screenrig feedback bug.`,
    next: { command: listCommand, reason: "Lists this project's stills, newest first, so you can see whether the generation produced one." },
  }, error.exitCode, error.warnings);
}

function ambiguousGenerateError(error: unknown, options: { elapsedMs: number; tag?: string }): unknown {
  if (!(error instanceof CliError)) return error;
  if (error.problem.code !== "timeout" && error.problem.code !== "transport_error") return error;
  const seconds = Math.round(options.elapsedMs / 1000);
  const listCommand = options.tag
    ? `screenrig media list --tag ${options.tag}`
    : "screenrig media list --primitive image";
  return new CliError(
    makeProblem(
      error.problem.code,
      error.problem.title,
      error.problem.status,
      `media generate did not return a result after ${seconds} s. The still may or may not have been created, and a created still is billed. ` +
        "Re-run the identical media generate command: it retries with the same idempotency key, so a still that was created is returned instead of generating and billing a second one.",
      {
        request_id: error.problem.request_id,
        hint: "Run the identical media generate command again, unchanged: a still that was already created is returned and not billed twice. Changing the prompt or options starts a new, separately billed generation.",
        next: {
          command: listCommand,
          reason: "Lists this project's stills, newest first, so you can see whether the generation completed before you re-run it.",
        },
      },
    ),
    error.exitCode,
    error.warnings,
  );
}

function writeGenerateNotice(
  args: ParsedArgs,
  runtime: CliRuntime,
  quality: MediaGenerationQuality,
): void {
  if (flagBool(args.flags, "no-progress")) return;
  const seconds = GENERATE_TYPICAL_SECONDS[quality];
  if (!flagBool(args.flags, "human")) {
    runtime.stderr.write(
      `${JSON.stringify({
        event: "media_generate_started",
        quality,
        typical_seconds: seconds,
        timeout_ms: GENERATE_WAIT_MS,
      })}\n`,
    );
    return;
  }
  runtime.stderr.write(
    `screenrig: media generate waits until the still is ready; ${quality} quality usually takes about ${seconds} s.\n`,
  );
}

async function mediaGenerate(
  args: ParsedArgs,
  runtime: CliRuntime,
  client: ApiClient,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  requireFlagValue(args, "prompt", `"Finished event poster with title, facts, and type in the image"`);
  requireFlagValue(args, "aspect-ratio", "16:9");
  requireFlagValue(args, "quality", "medium");
  const promptFile = flagString(args.flags, "prompt-file");
  const prompt = promptFile ? await readAuthoringText(promptFile, runtime, GENERATE_PROMPT_MAX * 4) : flagString(args.flags, "prompt");
  if (prompt === undefined || prompt.length < 1 || prompt.length > GENERATE_PROMPT_MAX) {
    throw usageError("media generate requires --prompt TEXT or --prompt-file FILE containing 1 to 4000 characters.");
  }
  const aspectRatio = flagString(args.flags, "aspect-ratio") ?? "16:9";
  if (!isGenerateAspectRatio(aspectRatio)) {
    throw usageError("--aspect-ratio must be 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, or 2:3.");
  }
  const quality = flagString(args.flags, "quality") ?? "medium";
  if (!isGenerateQuality(quality)) {
    throw usageError("--quality must be low, medium, or high.");
  }
  const tag = mediaTagFromArgs(args);
  const body: MediaGenerationRequest = {
    prompt,
    aspect_ratio: aspectRatio,
    quality,
    ...(tag ? { tag } : {}),
  };
  const waitMs = flagNumber(args.flags, "timeout") ?? GENERATE_WAIT_MS;
  const retry = await generateRetryState({
    resolved,
    runtime,
    requestHash: generateRequestHash(body),
    ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
  });
  writeGenerateNotice(args, runtime, quality);
  const startedAt = runtime.now().getTime();
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: "/api/media/generations",
      idempotent: true,
      idempotencyKey: retry.state.idempotency_key,
      headers: { prefer: "respond-async" },
      body,
    });
  } catch (error) {
    const ambiguous = ambiguousGenerateError(error, {
      elapsedMs: runtime.now().getTime() - startedAt,
      ...(tag ? { tag } : {}),
    });
    if (ambiguous === error) {
      // The server answered, so there is nothing for a replay to recover.
      await clearGenerateRetryState(resolved, runtime, retry.state.idempotency_key);
    }
    throw unusableGenerateAnswer(ambiguous, tag);
  }
  let generated: MediaGeneration;
  let operationId: string | undefined;
  try {
    if (response.status === 202) {
      const accepted = acceptedGenerationOperation(response.body);
      operationId = accepted;
      const operation = await client.waitForOperation(accepted, {
        timeoutMs: waitMs,
        pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
        sleep: runtime.sleep,
      });
      generated = mediaGenerationFromBody({ media: { id: operation.result?.media_id }, usage: operation.result?.usage });
      generated = { ...generated, media: await generatedMedia(client, generated.media.id) };
    } else if (response.status === 201) {
      // A server that predates the operation answers with the finished still.
      generated = mediaGenerationFromBody(response.body);
    } else {
      throw unexpectedResponseError(
        `media generate expected HTTP 202 with an operation and got HTTP ${response.status}.`,
        response.headers["x-request-id"] ?? client.requestId,
      );
    }
  } catch (error) {
    // Only a wait that ended without an answer keeps the key: the operation is
    // still running, and the identical command resumes it. Anything the server
    // decided (a failed operation, a refusal, an unusable answer) has nothing
    // left to replay.
    if (!(error instanceof CliError && (error.problem.code === "timeout" || error.problem.code === "transport_error") && operationId !== undefined)) {
      await clearGenerateRetryState(resolved, runtime, retry.state.idempotency_key);
    }
    throw unusableGenerateAnswer(waitingForGeneration(error, operationId), tag);
  }
  const elapsedMs = runtime.now().getTime() - startedAt;
  const mediaId = generated.media.id;
  // The generation resolved, so the stored key has nothing left to replay.
  await clearGenerateRetryState(resolved, runtime, retry.state.idempotency_key);
  return {
    envelope: successEnvelope(
      { media: generated.media, usage: generated.usage, id: mediaId, media_id: mediaId, elapsed_ms: elapsedMs },
      {
        request_id: client.requestId,
        ...(operationId ? { operation_id: operationId } : {}),
        warnings: response.headers.warning ? [{ code: "server_warning", message: response.headers.warning }] : [],
      },
    ),
    exitCode: ExitCode.Success,
    human: humanLines("Generated media", [
      ["media_id", mediaId],
      ["quality", generated.usage.quality ?? quality],
      ["credits", String(generated.usage.credits)],
      ["usd", generated.usage.usd],
      ["elapsed_ms", String(elapsedMs)],
    ]),
  };
}

/**
 * The operation id of a 202 answer, or the unusable-answer error that says the
 * outcome is unknown. A random id may carry an environment marker (stage_op_…),
 * as the other resource ids do.
 */
function acceptedGenerationOperation(body: unknown): string {
  const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !/^(?:(?:stage|qa|development)_)?op_[A-Za-z0-9_-]+$/.test(id)) {
    throw unexpectedResponseError("media generate expected an op_… operation id in the HTTP 202 answer.");
  }
  return id;
}

/**
 * The finished still, for the envelope's `media`. The operation names only the
 * media id; the still is already stored and billed, so a failed read falls back
 * to the id instead of failing the command.
 */
async function generatedMedia(client: ApiClient, mediaId: string): Promise<MediaGeneration["media"]> {
  try {
    const response = await client.call({ method: "GET", path: `/api/media/${mediaId}` });
    return response.body as MediaGeneration["media"];
  } catch {
    // The client's operation log already holds the failed read.
    return { id: mediaId } as MediaGeneration["media"];
  }
}

/**
 * A wait that ended while the generation was still running leaves the still
 * unfinished, not lost: say that the identical command resumes it.
 */
function waitingForGeneration(error: unknown, operationId: string | undefined): unknown {
  if (operationId === undefined || !(error instanceof CliError)) return error;
  if (error.problem.code !== "timeout" && error.problem.code !== "transport_error") return error;
  return new CliError({
    ...error.problem,
    hint: `${error.problem.hint ?? ""} Or rerun the identical media generate command: it resumes operation ${operationId} under the same idempotency key and never bills a second still.`.trim(),
  }, error.exitCode, error.warnings);
}

async function mediaUpdate(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  const revision = flagString(args.flags, "if-match");
  const clearTag = flagBool(args.flags, "clear-tag");
  const tag = mediaTagFromArgs(args);
  if (!id) {
    throw usageError("media update requires <id> and --tag TAG, --tags TAG1,TAG2, or --clear-tag.");
  }
  if ([clearTag, Boolean(tag), flagString(args.flags, "tags") !== undefined].filter(Boolean).length !== 1) {
    throw usageError("media update requires exactly one of --tag TAG, --tags TAG1,TAG2, or --clear-tag.");
  }
  const tagsFlag = flagString(args.flags, "tags");
  const tags = tagsFlag?.split(",");
  if (tags !== undefined && (tags.length > 32 || new Set(tags).size !== tags.length || tags.some(value => !/^[A-Za-z0-9]{1,32}$/.test(value)))) throw usageError("--tags requires 1 through 32 unique alphanumeric tags separated by commas; use --clear-tag to clear the set.");
  const body: MediaTagPatch = tags === undefined ? { tag: clearTag ? null : tag ?? null } : { tags };
  const response = await client.call({
    method: "PATCH",
    path: `/api/media/${id}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
    body,
  });
  const done = clearTag ? `Cleared tags on media ${id}` : `Replaced tags on media ${id}`;
  // Under Propose a tag change waits for a person's review.
  if ((response.body as { review_state?: unknown } | undefined)?.review_state === "pending") return mediaReviewPendingResult(response, client.requestId, done);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: done,
  };
}

const MEDIA_AVAILABILITY_KEYS = ["from", "until", "windows", "monthly", "dates", "except"];

/** The availability rule of a media item: the schedule's clock grammar without data or interaction. The server checks every value; this refuses a file that cannot be a rule at all. */
function mediaAvailabilityRule(parsed: unknown, file: string): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw usageError(`${file} must hold one JSON object, for example {"from": "2026-11-27T00:00", "until": "2026-11-30T00:00"}.`);
  }
  const rule = parsed as Record<string, unknown>;
  const keys = Object.keys(rule);
  if (keys.length === 0) {
    throw usageError(`${file} holds an empty rule. Give at least one of ${MEDIA_AVAILABILITY_KEYS.join(", ")}, or use --clear to make the file always available.`);
  }
  for (const key of keys) {
    if (key === "data" || key === "interaction") {
      throw usageError(`An availability rule says when a file may play, not what plays: remove "${key}" from ${file}.`);
    }
    if (!MEDIA_AVAILABILITY_KEYS.includes(key)) {
      throw usageError(`${file} has "${key}", which an availability rule does not take. Use ${MEDIA_AVAILABILITY_KEYS.join(", ")}.`);
    }
  }
  return rule;
}

export const handleMediaAvailability = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const file = flagString(args.flags, "file");
  const clear = flagBool(args.flags, "clear");
  if (!id) throw usageError("media availability requires <id> and exactly one of --file RULE.json or --clear.");
  if (!MEDIA_ID_PATTERN.test(id)) throw usageError(`media availability takes a media ID (med_...), not ${JSON.stringify(id)}; media list shows them.`);
  if ((file === undefined) === !clear) throw usageError("media availability requires exactly one of --file RULE.json (or - for stdin) or --clear.");
  const rule = file === undefined ? null : mediaAvailabilityRule(await readAuthoringJson(file, runtime), file);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // The route requires the media revision: read it unless --expect-rev names it.
  let revision = flagString(args.flags, "if-match");
  if (revision === undefined) {
    const current = await client.call({ method: "GET", path: `/api/media/${id}` });
    const value = (current.body as { revision?: unknown } | undefined)?.revision;
    if (typeof value !== "number") throw usageError(`Media ${id} returned no revision; pass --expect-rev REVISION.`);
    revision = String(value);
  }
  const response = await client.call({
    method: "PATCH",
    path: `/api/media/${id}/availability`,
    idempotent: true,
    headers: { "if-match": quotedRevision(revision) },
    body: { availability: rule },
  });
  const done = rule === null ? `Cleared availability on media ${id}: the file is always available to dynamic selectors` : `Set availability on media ${id}`;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `${done}\n${JSON.stringify(response.body, null, 2)}`,
  };
}, true);

const MEDIA_REVIEW_PENDING_SENTENCE ="Screens keep playing what was approved until a person approves this change. Its review appears in screenrig reviews list within seconds; a change that alters no approved playlist or open proposal applies without one. Do not repeat the write.";

/**
 * Media a Propose write left pending (review_state pending): a success, exit
 * 0. The media review worker opens its review shortly after, so the answer
 * carries no review id; next lists reviews.
 */
function mediaReviewPendingResult(response: { body: unknown; headers: Record<string, string> }, requestId: string, done: string): CommandResult {
  const next: ProblemNext = { command: "screenrig reviews list", argv: ["reviews", "list"], reason: "Find this media's review and give the person its URL." };
  return {
    envelope: jsonBody(response, requestId, { next }, [{ code: "media_review_pending", message: "Waiting for a person to approve this media change; its review appears in screenrig reviews list within seconds." }]),
    exitCode: ExitCode.Success,
    human: [done, "review_state: pending", MEDIA_REVIEW_PENDING_SENTENCE, `next: ${next.command}`].join("\n"),
  };
}

const MEDIA_ID_PATTERN = RESOURCE_ID_PATTERNS.media;

/** Canonical file extension for each verified media content type, matching the server's Content-Disposition. */
const MEDIA_CONTENT_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
};

function mediaRecordFromBody(body: unknown, id: string): MediaRecord {
  const rec = (body ?? {}) as Partial<MediaRecord>;
  if (
    rec.id !== id ||
    typeof rec.content_type !== "string" ||
    typeof rec.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(rec.sha256) ||
    typeof rec.bytes !== "number" ||
    !Number.isInteger(rec.bytes) ||
    rec.bytes < 1
  ) {
    throw usageError(`Media ${id} metadata does not match the Media contract; cannot verify a download.`);
  }
  return rec as MediaRecord;
}

/**
 * `media download <id> [--output FILE]` binds `GET /api/media/{id}/content`.
 *
 * The metadata row is read first so the default name, the expected length,
 * and the expected SHA-256 come from the server; the streamed bytes are
 * verified against them before the file is moved into place. Bytes never
 * reach stdout, the envelope, or the log.
 */
async function mediaDownload(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id || !MEDIA_ID_PATTERN.test(id)) {
    throw usageError("media download requires <id> starting with med_.");
  }

  const metadataResponse = await client.call({ method: "GET", path: `/api/media/${id}` });
  const media = mediaRecordFromBody(metadataResponse.body, id);
  const extension = MEDIA_CONTENT_EXTENSIONS[media.content_type.toLowerCase()];
  if (!extension) {
    throw usageError(`Media ${id} has content type ${media.content_type}, which this CLI cannot write.`);
  }
  const outputPath = await resolveDownloadOutput(runtime.cwd(), `./${id}.${extension}`, args.flags);

  const response = await client.download({ method: "GET", path: `/api/media/${id}/content` });
  let temp: Awaited<ReturnType<typeof openTempFile>> | undefined;
  let digest = "";
  let written = 0;
  try {
    const contentType = (response.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== media.content_type.toLowerCase()) {
      throw usageError(`Media ${id} download Content-Type did not match its metadata.`);
    }
    const reportedLength = response.headers["content-length"];
    if (reportedLength !== undefined && reportedLength !== String(media.bytes)) {
      throw usageError(`Media ${id} download Content-Length did not match its metadata.`);
    }
    if (!response.body) {
      throw usageError(`Media ${id} download returned no body.`);
    }
    const hash = createHash("sha256");
    temp = await openTempFile(outputPath);
    const handle = temp.handle;
    try {
      for await (const chunk of response.body) {
        written += chunk.byteLength;
        if (written > media.bytes) {
          throw usageError(`Media ${id} download exceeded the declared length.`);
        }
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          offset += result.bytesWritten;
        }
        hash.update(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (written !== media.bytes) {
      throw usageError(`Media ${id} download ended before the declared length.`);
    }
    digest = hash.digest("hex");
    if (digest !== media.sha256) {
      throw usageError(`Media ${id} download SHA-256 did not match its metadata.`);
    }
    await rename(temp.path, outputPath);
  } catch (error) {
    if (temp) await rm(temp.path, { force: true });
    if (error instanceof CliError) {
      throw error;
    }
    throw usageError("Cannot write the media download to the output path.");
  } finally {
    temp?.release();
    await response.body?.cancel?.();
  }

  const data = {
    media_id: id,
    id,
    path: outputPath,
    bytes: written,
    sha256: digest,
    content_type: media.content_type,
    primitive: media.primitive,
    filename: media.filename,
    ...(typeof media.source_filename === "string" ? { source_filename: media.source_filename } : {}),
    ...(typeof media.width === "number" ? { width: media.width } : {}),
    ...(typeof media.height === "number" ? { height: media.height } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Media downloaded", [
      ["media_id", id],
      ["path", outputPath],
      ["bytes", String(written)],
      ["sha256", digest],
      ["content_type", media.content_type],
      ["filename", media.filename],
      ["source_filename", media.source_filename],
      ["size", typeof media.width === "number" && typeof media.height === "number" ? `${media.width}x${media.height}` : undefined],
    ]),
  };
}

function playbackFilterFlags(args: ParsedArgs): { screenId?: string; mediaId?: string } {
  requireFlagValue(args, "screen-id", "scr_01");
  requireFlagValue(args, "media-id", "med_01");
  const screenId = flagString(args.flags, "screen-id");
  const mediaId = flagString(args.flags, "media-id");
  if (screenId !== undefined && !isResourceID(screenId, "screen")) {
    throw usageError("--screen-id must be a screen identifier.");
  }
  if (mediaId !== undefined && !isResourceID(mediaId, "media")) {
    throw usageError("--media-id must start with med_.");
  }
  return { screenId, mediaId };
}

/** json (default) or csv; --output applies to csv only. */
function playbackFormat(args: ParsedArgs, command: string): "json" | "csv" {
  requireFlagValue(args, "format", "csv");
  const format = flagString(args.flags, "format") ?? "json";
  if (format !== "json" && format !== "csv") throw usageError("--format must be json or csv.");
  if (format === "json" && args.flags.output !== undefined) {
    throw usageError(`--output applies to ${command} --format csv. JSON is the command envelope on stdout.`);
  }
  return format;
}

async function playbackList(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const { screenId, mediaId } = playbackFilterFlags(args);
  for (const name of ["day", "day-from", "day-to"]) requireFlagValue(args, name, "2026-08-14");
  const day = flagString(args.flags, "day");
  if (day !== undefined && !PLAYBACK_DAY_PATTERN.test(day)) {
    throw usageError("--day must be a UTC calendar day as YYYY-MM-DD.");
  }
  const days = aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"));
  if (day !== undefined && (days.day_from !== undefined || days.day_to !== undefined)) {
    throw usageError("Use --day for one UTC day, or --day-from/--day-to for a range, not both.");
  }
  const query = { screen_id: screenId, media_id: mediaId, day, ...days };
  const aggregateFile = await reportFileOf(args, runtime, resolved, "/api/playback", query, "play-aggregates", "playback aggregates", true);
  if (aggregateFile) return aggregateFile;
  if (playbackFormat(args, "playback list") === "csv") {
    return playbackCsvExport(args, runtime, resolved, {
      path: "/api/playback", query, what: "playback aggregates", defaultFile: "./playback-aggregates.csv",
    });
  }
  return simpleGet(args, runtime, resolved, "/api/playback", "Playback", query);
}

/**
 * `playback plays` binds GET /api/playback/plays. The received_at window is
 * resolved locally (to = now, from = to - 24h by default, at most 31 days) and
 * sent explicitly, so every page of one export shares the same bounds.
 */
async function playbackPlays(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const { screenId, mediaId } = playbackFilterFlags(args);
  for (const [name, example] of [["from", "7d"], ["to", "now"], ["tag", "Lobby"], ["cursor", "pc_NEXT"], ["limit", "500"]] as const) {
    requireFlagValue(args, name, example);
  }
  const tagValue = flagString(args.flags, "tag");
  const tag = tagValue === undefined ? undefined : screenTag(tagValue);
  const cursorValue = flagString(args.flags, "cursor");
  const cursor = cursorValue === undefined ? undefined : playsCursor(cursorValue);
  const limitValue = flagString(args.flags, "limit") ?? (typeof args.flags.limit === "number" ? String(args.flags.limit) : undefined);
  const limit = limitValue === undefined ? undefined : playsLimit(limitValue);
  if (args.flags.all !== undefined && args.flags.all !== true) throw usageError("--all takes no value.");
  const all = flagBool(args.flags, "all");
  const range = playsRange(flagString(args.flags, "from"), flagString(args.flags, "to"), runtime.now());
  const filters = { screen_id: screenId, media_id: mediaId, tag };
  const query = { from: range.from, to: range.to, ...filters };
  const playsFile = await reportFileOf(args, runtime, resolved, "/api/playback/plays", query, "plays", "plays", true);
  if (playsFile) return playsFile;
  const format = playbackFormat(args, "playback plays");
  // The server never returns the newest 5 seconds: report the effective end.
  const now = runtime.now().getTime();
  const reported = { from: range.from, to: Date.parse(range.to) > now - PLAYS_SETTLE_MS ? new Date(now - PLAYS_SETTLE_MS).toISOString().replace(/\.000Z$/, "Z") : range.to };

  if (format === "csv") {
    if (limit !== undefined) throw usageError("--limit is JSON-only; --format csv streams the whole range in one request.");
    if (all) throw usageError("--all is JSON-only; --format csv already streams the whole range in one request.");
    return playbackCsvExport(args, runtime, resolved, {
      path: "/api/playback/plays", query: { ...query, cursor }, what: "playback plays", defaultFile: "./playback-plays.csv",
      range: reported, filters,
    });
  }

  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const pageLimit = limit ?? (all ? String(PLAYS_LIMIT_MAX) : undefined);
  const items: PlaybackPlay[] = [];
  const warnings: Warning[] = [];
  let next: string | null = cursor ?? null;
  let pages = 0;
  while (true) {
    let response: Awaited<ReturnType<ApiClient["call"]>>;
    try {
      response = await client.call({
        method: "GET", path: "/api/playback/plays",
        query: { ...query, ...(next ? { cursor: next } : {}), ...(pageLimit ? { limit: pageLimit } : {}) },
      });
    } catch (error) {
      // --all keeps the pages it already has when the export budget runs out.
      if (pages === 0 || !(error instanceof CliError) || error.problem.code !== "rate_limited") throw error;
      const wait = error.problem.retry_after_seconds;
      warnings.push({ code: "playback_export_rate_limited", message: `--all stopped after ${pages} pages: the playback export budget is spent${wait === undefined ? "" : ` for ${wait} s`}. Continue with data.next after that.` });
      break;
    }
    const page = response.body as Partial<PlaybackPlayList> | undefined;
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    next = typeof page?.next_cursor === "string" ? page.next_cursor : null;
    pages += 1;
    if (!all || !next) break;
    if (pages >= PLAYS_ALL_MAX_PAGES) {
      warnings.push({ code: "playback_plays_truncated", message: `--all stopped after ${PLAYS_ALL_MAX_PAGES} pages (${items.length} plays). Continue with data.next, or export the range with --format csv.` });
      break;
    }
    const budget = playbackExportBudget(response.headers.ratelimit);
    if (budget !== undefined && budget.remaining === 0) {
      warnings.push({ code: "playback_export_rate_limited", message: `--all stopped after ${pages} pages: the playback export budget is spent for ${budget.resetSeconds} s. Continue with data.next after that.` });
      break;
    }
  }

  const nextArgv = next ? playsNextArgv(reported, filters, next, limit, all) : undefined;
  const data = {
    items, next_cursor: next, from: reported.from, to: reported.to, pages,
    ...(nextArgv ? { next: { command: `screenrig ${shellQuote(nextArgv)}`, argv: nextArgv } } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: [
      `Playback plays ${reported.from} to ${reported.to} (${items.length}${pages > 1 ? ` in ${pages} pages` : ""})`,
      ...items.map((play) => [play.received_at, play.screen_id, play.media_id, play.primitive, play.page_id, play.playlist_id ?? "-"].join("  ")),
      ...(nextArgv ? [`next: screenrig ${shellQuote(nextArgv)}`] : []),
      ...warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

/**
 * `playback totals` binds GET /api/playback/totals. A day series spans at most
 * 366 days (92 narrowed to a screen or media), a ranking at most 92; top ranks
 * at most 100 screens or media (10 for screen_day) and never applies to a day series.
 */
export const handlePlaybackTotals = commandHandler(async (args, runtime, resolved) => {
  const { screenId, mediaId } = playbackFilterFlags(args);
  for (const [name, example] of [["by", "screen"], ["day-from", "2026-09-01"], ["day-to", "2026-09-30"], ["top", "5"]] as const) {
    requireFlagValue(args, name, example);
  }
  const by = flagString(args.flags, "by") ?? "day";
  if (by !== "day" && by !== "screen" && by !== "media" && by !== "screen_day") throw usageError("--by must be day, screen, media or screen_day.");
  const top = flagString(args.flags, "top");
  let maxDays = 92;
  let scope = " for a ranking";
  if (by === "day") {
    if (top !== undefined) throw usageError("--top ranks screens or media: use it with --by screen, media or screen_day.");
    if (screenId === undefined && mediaId === undefined) {
      maxDays = AGGREGATE_MAX_DAYS;
      scope = "";
    } else {
      scope = " with --screen-id or --media-id";
    }
  } else {
    if (screenId !== undefined || mediaId !== undefined) throw usageError("--screen-id and --media-id narrow only --by day.");
    const topMax = by === "screen_day" ? 10 : 100;
    if (top !== undefined && (!/^\d+$/.test(top) || Number(top) < 1 || Number(top) > topMax)) {
      throw usageError(`--top must be a whole number from 1 to ${topMax} with --by ${by}.`);
    }
  }
  const days = aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"), maxDays, scope);
  return simpleGet(args, runtime, resolved, "/api/playback/totals", "Playback totals", {
    by: flagString(args.flags, "by"), screen_id: screenId, media_id: mediaId, top, ...days,
  });
}, true);

/**
 * `playback completeness` binds GET /api/playback/completeness: how many of the
 * plays Players numbered reached screenRIG, per UTC day and for the window, and
 * the gaps where numbered plays went missing (newest first). A window spans at
 * most 92 days; --limit caps the gaps listed.
 */
export const handlePlaybackCompleteness = commandHandler(async (args, runtime, resolved) => {
  const { screenId } = playbackFilterFlags(args);
  for (const [name, example] of [["day-from", "2026-09-01"], ["day-to", "2026-09-30"], ["limit", "100"]] as const) {
    requireFlagValue(args, name, example);
  }
  const limit = flagString(args.flags, "limit");
  if (limit !== undefined && (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 500)) {
    throw usageError("--limit must be a whole number from 1 to 500.");
  }
  const days = aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"), 92, "");
  return simpleGet(args, runtime, resolved, "/api/playback/completeness", "Playback completeness", {
    screen_id: screenId, limit, ...days,
  });
}, true);

/** The id of `screen uptime|presence|health-history ID`, checked like the other screen reads. */
function screenSeriesId(args: ParsedArgs, command: string): string {
  const id = args.positionals[2];
  if (!id || !isScreenId(id)) throw usageError(`${command} requires a screen ID (scr_...); screen list shows them.`);
  return id;
}

/** --day-from/--day-to of the daily uptime reads. */
function uptimeDays(args: ParsedArgs): { day_from?: string; day_to?: string } {
  for (const [name, example] of [["day-from", "2026-09-01"], ["day-to", "2026-09-30"]] as const) requireFlagValue(args, name, example);
  return aggregateDays(flagString(args.flags, "day-from"), flagString(args.flags, "day-to"), UPTIME_MAX_DAYS);
}

export const handleScreenUptime = commandHandler(async (args, runtime, resolved) => {
  const id = screenSeriesId(args, "screen uptime");
  return simpleGet(args, runtime, resolved, `/api/screens/${id}/uptime`, "Screen uptime", uptimeDays(args));
}, true);

export const handleProjectUptime = commandHandler(async (args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/uptime/daily", "Project uptime", uptimeDays(args)), true);

export const handleScreenPresence = commandHandler(async (args, runtime, resolved) => {
  const id = screenSeriesId(args, "screen presence");
  requireFlagValue(args, "since", "7d");
  requireFlagValue(args, "until", "now");
  const range = seriesWindow({
    from: flagString(args.flags, "since"), to: flagString(args.flags, "until"), fromFlag: "--since", toFlag: "--until",
    now: runtime.now(), defaultMs: PRESENCE_DEFAULT_WINDOW_MS, maxDays: PRESENCE_MAX_DAYS,
  });
  return simpleList(args, runtime, resolved, `/api/screens/${id}/presence`, "Screen presence",
    { since: range.from, until: range.to, limit: SERIES_PAGE_SIZE }, { cursorParam: "before", uncapped: true });
}, true);

export const handleScreenHealthHistory = commandHandler(async (args, runtime, resolved) => {
  const id = screenSeriesId(args, "screen health-history");
  requireFlagValue(args, "resolution", "hour");
  requireFlagValue(args, "from", "7d");
  requireFlagValue(args, "to", "now");
  const resolution = flagString(args.flags, "resolution") ?? "raw";
  if (resolution !== "raw" && resolution !== "hour") throw usageError("--resolution must be raw or hour.");
  const range = seriesWindow({
    from: flagString(args.flags, "from"), to: flagString(args.flags, "to"), fromFlag: "--from", toFlag: "--to",
    now: runtime.now(), defaultMs: HEALTH_DEFAULT_WINDOW_MS,
    maxDays: resolution === "hour" ? HEALTH_HOURLY_MAX_DAYS : HEALTH_RAW_MAX_DAYS,
    advice: resolution === "raw" ? ` with --resolution raw; --resolution hour spans up to ${HEALTH_HOURLY_MAX_DAYS} days` : "",
  });
  return simpleList(args, runtime, resolved, `/api/screens/${id}/health/history`, "Screen health history",
    { from: range.from, to: range.to, resolution: flagString(args.flags, "resolution"), limit: SERIES_PAGE_SIZE },
    { cursorParam: "cursor", itemsKey: resolution === "hour" ? "hours" : "samples", uncapped: true });
}, true);

export const handleProjectHealthTrend = commandHandler(async (args, runtime, resolved) => {
  requireFlagValue(args, "from", "7d");
  requireFlagValue(args, "to", "now");
  const range = seriesWindow({
    from: flagString(args.flags, "from"), to: flagString(args.flags, "to"), fromFlag: "--from", toFlag: "--to",
    now: runtime.now(), defaultMs: HEALTH_DEFAULT_WINDOW_MS, maxDays: HEALTH_HOURLY_MAX_DAYS,
  });
  return simpleList(args, runtime, resolved, "/api/health/trend", "Project health trend",
    { from: range.from, to: range.to, limit: SERIES_PAGE_SIZE }, { cursorParam: "cursor", uncapped: true });
}, true);

/** --day-from/--day-to: real UTC days, from not after to, at most `maxDays` (366 by default) inclusive. */
function aggregateDays(from: string | undefined, to: string | undefined, maxDays = AGGREGATE_MAX_DAYS, scope = ""): { day_from?: string; day_to?: string } {
  const parse = (value: string, flag: string) => {
    const ms = PLAYBACK_DAY_PATTERN.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      throw usageError(`${flag} must be a UTC calendar day as YYYY-MM-DD.`);
    }
    return ms;
  };
  const fromMs = from === undefined ? undefined : parse(from, "--day-from");
  const toMs = to === undefined ? undefined : parse(to, "--day-to");
  if (fromMs !== undefined && toMs !== undefined) {
    if (toMs < fromMs) throw usageError("--day-from must not be after --day-to.");
    if (toMs - fromMs >= maxDays * 86_400_000) throw usageError(`--day-from to --day-to must span at most ${maxDays} days${scope}.`);
  }
  return { ...(from !== undefined ? { day_from: from } : {}), ...(to !== undefined ? { day_to: to } : {}) };
}

function playsNextArgv(
  range: { from: string; to: string },
  filters: { screen_id?: string; media_id?: string; tag?: string },
  cursor: string,
  limit: string | undefined,
  all: boolean,
): string[] {
  return [
    "playback", "plays", "--from", range.from, "--to", range.to,
    ...(filters.screen_id ? ["--screen-id", filters.screen_id] : []),
    ...(filters.media_id ? ["--media-id", filters.media_id] : []),
    ...(filters.tag ? ["--tag", filters.tag] : []),
    "--cursor", cursor,
    ...(limit ? ["--limit", limit] : []),
    ...(all ? ["--all"] : []),
  ];
}

/**
 * One CSV stream (one billed request) into a file via temp + rename, or to
 * stdout only with an explicit --output -. The envelope reports the path,
 * bytes, rows, and SHA-256, never the CSV itself. A stream that fails after
 * the 200 never lands on the target path.
 */
async function playbackCsvExport(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
  spec: {
    path: string; query: Record<string, string | undefined>; what: string; defaultFile: string;
    range?: { from: string; to: string }; filters?: { screen_id?: string; media_id?: string; tag?: string };
  },
): Promise<CommandResult> {
  const toStdout = flagString(args.flags, "output") === "-";
  const outputPath = toStdout ? undefined : await resolveDownloadOutput(runtime.cwd(), spec.defaultFile, args.flags);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // No whole-transfer deadline: the stream fails after --timeout (default 60 s) without a byte.
  const idle = flagNumber(args.flags, "timeout") ?? PLAYBACK_CSV_IDLE_TIMEOUT_MS;
  const response = await client.download({
    method: "GET", path: spec.path, query: { ...spec.query, format: "csv" }, timeout_ms: 0, idle_timeout_ms: idle, label: "Playback export",
  });
  try {
    requireCsvResponse(response.headers, spec.what, client.requestId);
    if (!response.body) throw networkError(`The ${spec.what} export returned no body.`, client.requestId);
  } catch (error) {
    await response.body?.cancel?.();
    throw error;
  }
  // The same export again, flag for query parameter (format and cursor included).
  const rerun = (output: string, from?: string): ProblemNext => {
    const query: Record<string, string | undefined> = { ...spec.query, ...(from ? { from, cursor: undefined } : {}) };
    const argv = [...args.command];
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && key !== "format") argv.push(`--${key.replaceAll("_", "-")}`, value);
    }
    argv.push("--format", "csv", "--output", output);
    return from
      ? { command: `screenrig ${shellQuote(argv)}`, argv, reason: `Export the rest of the range from ${from}, the last received_at received. Rows received at that instant appear in both files; drop the repeats when joining them.` }
      : { command: `screenrig ${shellQuote(argv)}`, argv, reason: "Rerun the same export; nothing was written." };
  };
  // A plays export resumes from the last received_at it wrote (inclusive, so
  // rows at that instant repeat). Aggregates have no cursor: rerun the command.
  const resume = (failure: CsvStreamFailure, output: string): ProblemNext => {
    const index = failure.header.indexOf("received_at");
    const last = index >= 0 ? failure.lastRow?.[index] : undefined;
    const from = spec.range && last !== undefined ? normalizeInstant(last) : undefined;
    return rerun(output, from);
  };
  if (toStdout) {
    try {
      if (formatResultContext(runtime)) runtime.stderr.write(`${formatResultContext(runtime)}\n`);
      await writeCsvStdout(response.body, runtime.stdout, spec.what, client.requestId);
    } catch (error) {
      // CSV bytes may already be on stdout; the error goes to stderr instead of an envelope.
      const lines = [`error: ${error instanceof CliError ? error.problem.detail : `the ${spec.what} CSV could not be written to stdout.`} stdout holds an incomplete export.`];
      if (error instanceof CsvStreamFailure) lines.push(`next: ${resume(error, "-").command}`);
      try {
        runtime.stderr.write(`${lines.join("\n")}\n`);
      } catch {
        // stderr may be gone too; the exit code still reports the failure.
      }
      return { envelope: successEnvelope({}), exitCode: error instanceof CliError ? error.exitCode : ExitCode.Unexpected, human: "", output: "stream" };
    }
    return { envelope: successEnvelope({}), exitCode: ExitCode.Success, human: "", output: "stream" };
  }
  let file: Awaited<ReturnType<typeof writeCsvFile>>;
  try {
    file = await writeCsvFile(response.body, outputPath!, spec.what, client.requestId, spec.range !== undefined);
  } catch (error) {
    if (!(error instanceof CsvStreamFailure)) throw error;
    const kept = error.partialPath
      ? ` The ${error.rows} complete rows received are in ${error.partialPath}; ${outputPath} was not written.`
      : ` Nothing was written to ${outputPath}.`;
    const next = error.partialPath
      ? resume(error, await unusedPath(`${outputPath!.replace(/\.csv$/i, "")}-rest.csv`, ".csv"))
      : rerun(outputPath!);
    throw new CliError(
      {
        ...error.problem,
        detail: `The ${spec.what} CSV stream failed after the export started: ${error.problem.detail}${kept}`,
        hint: error.partialPath
          ? "Run the next command to export the rows that were not received; the complete rows already received stay in the partial file."
          : "Run the next command to start the export again.",
        next,
      },
      error.exitCode,
      error.warnings,
    );
  }
  const receivedIndex = file.header.indexOf("received_at");
  const lastReceivedAt = receivedIndex >= 0 ? file.last?.[receivedIndex] : undefined;
  const data = {
    path: file.path,
    bytes: file.bytes,
    rows: file.rows,
    sha256: file.sha256,
    content_type: "text/csv",
    ...(spec.range ? { from: spec.range.from, to: spec.range.to } : {}),
    ...(lastReceivedAt ? { last_received_at: lastReceivedAt } : {}),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(`${spec.what[0]!.toUpperCase()}${spec.what.slice(1)} exported`, [
      ["path", file.path],
      ["rows", String(file.rows)],
      ["bytes", String(file.bytes)],
      ["sha256", file.sha256],
      ["range", spec.range ? `${spec.range.from} to ${spec.range.to}` : undefined],
      ["last_received_at", lastReceivedAt],
    ]),
  };
}

/** Flags that shape the pre-upload transcode. */
export function transcodeOptionsFromArgs(args: ParsedArgs): TranscodeOptions {
  const preset = flagString(args.flags, "preset");
  if (args.flags.preset !== undefined && preset !== "signage-1080p30" && preset !== "signage-4k30") {
    throw usageError("--preset accepts signage-1080p30 or signage-4k30.");
  }
  if (args.flags["no-audio"] !== undefined && args.flags["no-audio"] !== true) throw usageError("--no-audio takes no value.");
  const noAudio = flagBool(args.flags, "no-audio");
  if (flagBool(args.flags, "no-transcode") && (preset || noAudio)) {
    throw usageError("--preset and --no-audio require transcoding; remove --no-transcode.");
  }
  for (const flag of ["max-fps", "max-edge", "webp-quality"]) {
    const raw = args.flags[flag];
    if (raw !== undefined && (typeof raw !== "string" || !Number.isFinite(Number(raw)))) {
      throw usageError(`--${flag} requires a numeric value.`);
    }
  }
  const codecFlag = flagString(args.flags, "codec")?.toLowerCase();
  let codec: TranscodeCodec = DEFAULT_CODEC;
  if (codecFlag !== undefined) {
    if (codecFlag === "hevc" || codecFlag === "h265") {
      codec = "hevc";
    } else if (codecFlag === "h264" || codecFlag === "avc") {
      codec = "h264";
    } else {
      throw usageError("--codec accepts hevc or h264.");
    }
  }

  const maxFps = flagNumber(args.flags, "max-fps") ?? DEFAULT_MAX_FPS;
  if (!(maxFps > 0) || maxFps > 240) {
    throw usageError("--max-fps must be greater than 0 and at most 240.");
  }
  const maxEdge = flagNumber(args.flags, "max-edge") ?? MAX_EDGE;
  if (!Number.isInteger(maxEdge) || maxEdge < 16 || maxEdge > MAX_EDGE) {
    throw usageError(`--max-edge must be a whole number between 16 and ${MAX_EDGE}.`);
  }
  const webpQuality = flagNumber(args.flags, "webp-quality") ?? DEFAULT_WEBP_QUALITY;
  if (!Number.isInteger(webpQuality) || webpQuality < 1 || webpQuality > 100) {
    throw usageError("--webp-quality must be a whole number between 1 and 100.");
  }
  return { codec, maxFps, maxEdge, webpQuality,
    preset: preset === "signage-1080p30" || preset === "signage-4k30" ? preset : undefined, noAudio };
}

export function progressReporterFor(args: ParsedArgs, runtime: CliRuntime): ProgressReporter {
  if (flagBool(args.flags, "no-progress")) {
    return silentProgressReporter();
  }
  const json = !flagBool(args.flags, "human");
  return createProgressReporter({
    stderr: runtime.stderr,
    json,
    tty: !json && runtime.isStderrTty?.() === true,
    now: () => runtime.now().getTime(),
  });
}

async function mediaUpload(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const file = args.positionals[2];
  if (!file) throw usageError("media upload requires a file.");
  const sourcePath = path.resolve(runtime.cwd(), file);
  await requireInputFile(sourcePath, file);
  const explicitContentType = flagString(args.flags, "content-type");

  // Validate unconditionally so a typo such as --webp-quality 500 is rejected
  // whether or not transcoding runs. The result is unused under --no-transcode.
  const transcodeOptions = transcodeOptionsFromArgs(args);
  const folderId = await uploadFolderFromArgs(args, client);
  const uploaded = await uploadMediaFile({
    runtime,
    client,
    sourcePath,
    explicitContentType,
    tag: mediaTagFromArgs(args),
    ...(folderId ? { folderId } : {}),
    transcodeOptions,
    noTranscode: flagBool(args.flags, "no-transcode"),
    reporter: progressReporterFor(args, runtime),
    noWait: flagBool(args.flags, "no-wait"),
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
    resumable: flagString(args.flags, "idempotency-key") !== undefined,
  });
  const mediaId = uploaded.mediaId;
  const data = {
    ...(mediaId ? { media_id: mediaId, id: mediaId } : {}),
    ...(folderId ? { folder_id: folderId } : {}),
    operation: uploaded.operation,
    reused: uploaded.reused,
    upload: uploaded.upload,
    transcode: uploaded.transcode,
    timing: uploaded.timing,
  };
  return {
    envelope: successEnvelope(data, {
      request_id: client.requestId,
      operation_id: uploaded.operation.id,
      warnings: uploaded.warnings,
    }),
    exitCode: ExitCode.Success,
    human: humanLines(uploaded.reused ? "Media already uploaded" : flagBool(args.flags, "no-wait") ? "Media upload committed" : "Media uploaded", [
      ["media_id", mediaId],
      ["operation_id", uploaded.operation.id],
      ["state", uploaded.operation.state],
      ["filename", uploaded.upload.filename],
      ["source_filename", uploaded.upload.source_filename],
      ["content_type", uploaded.upload.content_type],
      ["tag", uploaded.upload.tag],
      ["folder_id", folderId],
      ["transcode", typeof uploaded.transcode.duration_ms === "number" ? `${uploaded.transcode.reason} in ${uploaded.transcode.duration_ms} ms` : "skipped"],
      ["sha256", uploaded.upload.sha256],
      ["timing", Object.entries(uploaded.timing).map(([stage, ms]) => `${stage.replace(/_ms$/, "")} ${ms} ms`).join(", ")],
      ...uploaded.warnings.map((warning): [string, string] => ["warning", warning.message]),
    ]),
  };
}

async function mediaUploadBatch(
  args: ParsedArgs,
  runtime: CliRuntime,
  client: ApiClient,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const manifest = args.positionals[2];
  if (!manifest) {
    throw usageError("media upload-batch requires one manifest JSON file.");
  }
  requireFlagValue(args, "state", "./upload-state.json");
  requireFlagValue(args, "concurrency", "4");
  const state = flagString(args.flags, "state") ?? path.join(path.dirname(resolved.configPath), "upload-batches", createHash("sha256").update(JSON.stringify([resolved.apiUrl, resolved.projectId ?? resolved.token, path.resolve(runtime.cwd(), manifest)])).digest("hex") + ".json");
  const concurrency = flagNumber(args.flags, "concurrency") ?? UPLOAD_BATCH_DEFAULT_CONCURRENCY;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < UPLOAD_BATCH_MIN_CONCURRENCY ||
    concurrency > UPLOAD_BATCH_MAX_CONCURRENCY
  ) {
    throw usageError(
      `--concurrency must be a whole number from ${UPLOAD_BATCH_MIN_CONCURRENCY} to ${UPLOAD_BATCH_MAX_CONCURRENCY}.`,
    );
  }
  const transcodeOptions = transcodeOptionsFromArgs(args);
  const folderId = await uploadFolderFromArgs(args, client);
  const result = await runMediaUploadBatch({
    runtime,
    client,
    manifestPath: path.resolve(runtime.cwd(), manifest),
    statePath: path.resolve(runtime.cwd(), state),
    apiUrl: resolved.apiUrl,
    projectId: resolved.projectId,
    concurrency,
    defaultTag: mediaTagFromArgs(args),
    ...(folderId ? { folderId } : {}),
    transcodeOptions,
    noTranscode: flagBool(args.flags, "no-transcode"),
    reporter: progressReporterFor(args, runtime),
    json: !flagBool(args.flags, "human"),
    noProgress: flagBool(args.flags, "no-progress"),
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
  });
  return {
    envelope: successEnvelope(folderId ? { ...result.data, folder_id: folderId } : result.data, {
      request_id: client.requestId,
      warnings: result.warnings,
    }),
    exitCode: result.exitCode,
    human: result.human,
  };
}

/**
 * The submission kind comes from the route, never from the request body, so the
 * CLI action selects the path and nothing in the payload can contradict it.
 */
const FEEDBACK_PATHS: Record<FeedbackKind, string> = {
  bug: "/api/feedback/bugs",
  feature: "/api/feedback/features",
};

/**
 * Exactly the contract pattern for `FeedbackContext.command`: up to four
 * lowercase words. It admits no flag, no uppercase, no separator, and no
 * punctuation, so an argument value cannot survive it.
 */
const FEEDBACK_COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}( [a-z][a-z0-9-]{0,31}){0,3}$/;
const FEEDBACK_TITLE_MAX = 120;
const FEEDBACK_BODY_MAX = 4000;

const TOAST_LEVELS = new Set<ScreenToastLevel>(["error", "alert", "info"]);
const TOAST_DEFAULT_LEVEL: ScreenToastLevel = "info";
const TOAST_TEXT_MAX = 120;
const TOAST_MAX_LINES = 3;
const TOAST_DURATION_MIN = 2000;
const TOAST_DURATION_MAX = 60000;

const SCREEN_ID_PATTERN = RESOURCE_ID_PATTERNS.screen;
const PLAYLIST_PAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SCREENSHOT_DEFAULT_WAIT_MS = 35_000;
const SCREENSHOT_DEFAULT_POLL_MS = 500;

function isScreenToastLevel(value: string): value is ScreenToastLevel {
  return TOAST_LEVELS.has(value as ScreenToastLevel);
}

function trimToastText(value: string): string {
  return value.replace(/^[ \t\r\n]+/, "").replace(/[ \t\r\n]+$/, "");
}

function toastTextHasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\n") {
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function toastLineCount(value: string): number {
  if (value === "") {
    return 0;
  }
  return value.split("\n").length;
}

/**
 * Built from the resolved command surface only. Nothing here is derived from
 * raw argv, so no argument value, path, identifier, or credential can reach the
 * server through the diagnostic envelope.
 */
export function feedbackContextFromArgs(
  args: ParsedArgs,
  platform: string,
): FeedbackContext | undefined {
  if (flagBool(args.flags, "no-context")) {
    return undefined;
  }
  const context: FeedbackContext = { cli_version: CLI_VERSION };
  if (/^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/.test(platform)) {
    context.platform = platform;
  }
  // `--command --json` parses as a valueless flag. Fail rather than silently
  // dropping the context the caller asked for.
  if (args.flags.command === true) {
    throw usageError('--command requires a value, such as --command "media upload".');
  }
  // Validated exactly as supplied. Normalizing first would let an uppercase
  // argument value such as "screen pair ABC234" be lowercased into a shape the
  // pattern accepts, which is precisely the leak the closed envelope prevents.
  const command = flagString(args.flags, "command")?.trim();
  if (command !== undefined) {
    if (!FEEDBACK_COMMAND_PATTERN.test(command)) {
      throw usageError(
        "--command accepts a command path only, as up to four lowercase words such as " +
          '"media upload". Option flags, identifiers, file paths, and argument values are rejected ' +
          "by the server and must not be placed here.",
      );
    }
    context.command = command;
  }
  return context;
}

async function readFeedbackBody(args: ParsedArgs, runtime: CliRuntime): Promise<string> {
  const inline = flagString(args.flags, "body");
  const file = flagString(args.flags, "body-file");
  if (inline !== undefined && file !== undefined) {
    throw usageError("Pass either --body or --body-file, not both.");
  }
  if (inline !== undefined) {
    return inline;
  }
  if (file === undefined) {
    throw usageError("feedback requires --body TEXT or --body-file FILE.");
  }
  try {
    return await readFile(path.resolve(runtime.cwd(), file), "utf8");
  } catch (error) {
    throw usageError(`Cannot read --body-file: ${error instanceof Error ? error.message : "read failed"}`);
  }
}

// Support messages are deliberately kept out of operation-log bodies.
export const handleSupportStatus = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/support/status" });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: JSON.stringify(response.body, null, 2) };
});

function supportConversation(args: ParsedArgs, required = false): string | undefined {
  const id = flagString(args.flags, "conversation-id");
  if ((required && !id) || (id && !/^sc_[A-Za-z0-9_-]+$/.test(id))) throw usageError("Supply a valid --conversation-id.");
  return id;
}
function supportSequence(value: string | undefined): string | undefined {
  if (value !== undefined && !/^\d+$/.test(value)) throw usageError("Support sequences must be nonnegative integers.");
  if (value !== undefined && !Number.isSafeInteger(Number(value))) throw usageError("Support sequence is out of range.");
  return value;
}
export const handleSupportSubmit = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args);
  const body = (await readFeedbackBody(args, runtime)).trim();
  if (!body || [...body].length > 4000) throw usageError("A support message must contain 1–4000 characters.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: id ? `/api/support/conversations/${id}/messages` : "/api/support/conversations", idempotent: true, body: { body, human_requested: flagBool(args.flags, "human-requested") } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: JSON.stringify(response.body, null, 2) };
});
export const handleSupportHistory = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args);
  const after = supportSequence(flagString(args.flags, "after"));
  if (after && !id) throw usageError("--after requires --conversation-id.");
  const before = flagString(args.flags, "before");
  if (before && (id || !/^sc_[A-Za-z0-9_-]+$/.test(before))) throw usageError("--before accepts a conversation cursor when listing conversations.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: id ? `/api/support/conversations/${id}/messages` : "/api/support/conversations", query: { after, before } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: JSON.stringify(response.body, null, 2) };
});
export const handleSupportClose = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args, true)!;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `/api/support/conversations/${id}/close`, body: {} });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: "Support conversation ended. Its history is saved." };
});
export const handleSupportRead = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args, true)!;
  const sequence = supportSequence(flagString(args.flags, "sequence"));
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PUT", path: `/api/support/conversations/${id}/read`, body: { sequence: Number(sequence) } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: "Support replies marked read." };
});
export const handleSupportFollow = commandHandler(async (args, runtime, resolved) => {
  const selected = supportConversation(args);
  let after = supportSequence(flagString(args.flags, "after")) ?? "0";
  let token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const transport = transportFor(runtime, resolved.apiUrl, token);
  const controller = new AbortController();
  const timeout = flagNumber(args.flags, "timeout");
  const timer = timeout && timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined;
  let delay = EVENT_STREAM_BACKOFF_MS;
  let printedContext = false;
  try {
    while (!controller.signal.aborted) {
      let buffer = "";
      try {
        token = await streamToken(runtime, token);
        const stream = await transport.stream({ method: "GET", path: "/stream/support", query: { after, ...projectStreamQuery(resolved.projectId) }, headers: { authorization: `Bearer ${token}`, "x-request-id": client.nextRequestId() }, signal: controller.signal });
        for await (const chunk of stream) {
          buffer += chunk;
          const parsed = parseSse(buffer); buffer = parsed.rest;
          if (buffer.length > 128 * 1024 || parsed.events.some((frame) => (frame.data?.length ?? 0) > 128 * 1024)) throw unexpectedResponseError("Support stream frame exceeded its size limit.");
          for (const frame of parsed.events) {
            if (frame.event !== "support.message" || !frame.data) continue;
            let message: { conversation_id: string; sequence: number; author: string; body: string };
            try { message = JSON.parse(frame.data); } catch { throw unexpectedResponseError("Support stream sent invalid JSON."); }
            if (!message || typeof message.body !== "string" || typeof message.author !== "string" || typeof message.conversation_id !== "string") throw unexpectedResponseError("Support stream sent an invalid message.");
            if (!frame.id || !/^\d+$/.test(frame.id) || !Number.isSafeInteger(message.sequence) || String(message.sequence) !== frame.id) throw unexpectedResponseError("Support stream sent an invalid sequence.");
            if (BigInt(frame.id) <= BigInt(after)) continue;
            after = frame.id;
            if (selected && message.conversation_id !== selected) continue;
            if (flagBool(args.flags, "human") && !printedContext) {
              if (formatResultContext(runtime)) runtime.stdout.write(`${formatResultContext(runtime)}\n`);
              printedContext = true;
            }
            runtime.stdout.write(flagBool(args.flags, "human") ? `${message.author}: ${redactText(message.body)}\n` : `${JSON.stringify(streamEnvelope(runtime, redactEvent(message), client.requestId))}\n`);
          }
          delay = EVENT_STREAM_BACKOFF_MS;
          if (controller.signal.aborted) break;
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) break;
        if (isHardFollowError(error) || (error instanceof CliError && error.problem.code === "unexpected_response")) throw error;
      }
      if (!controller.signal.aborted) await sleepWhileOpen(delay, controller.signal, runtime.sleep);
      delay = Math.min(delay * 2, EVENT_STREAM_BACKOFF_CAP_MS);
    }
  } finally { if (timer) clearTimeout(timer); }
  return { envelope: successEnvelope({ after }, { request_id: client.requestId }), exitCode: ExitCode.Success, human: "", output: "stream" };
});

export const handleFeedbackList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  return feedbackList(args, client);
});

export const handleFeedbackBug = commandHandler((args, runtime, resolved) => submitFeedback(args, runtime, resolved, "bug"));
export const handleFeedbackFeature = commandHandler((args, runtime, resolved) => submitFeedback(args, runtime, resolved, "feature"));

function feedbackID(args: ParsedArgs): string {
  const id = args.positionals[2];
  if (!id || !/^(?:(?:stage|qa|development)_)?fb_[A-Za-z0-9_-]{16,24}$/.test(id)) throw usageError("Supply a feedback ID from feedback list.");
  return id;
}

function feedbackThreadHuman(item: FeedbackSubmission): string {
  return [
    `${item.id}  ${item.status ?? "open"}  ${redactText(item.title)}`,
    redactText(item.body),
    ...(item.responses ?? []).map(reply => `${reply.created_at}  ${reply.author === "agent" ? "Agent" : "Staff"}  ${reply.status}${reply.fixed_in ? ` in ${reply.fixed_in}` : ""}\n${redactText(reply.text)}`),
  ].join("\n\n");
}

export const handleFeedbackShow = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/feedback/${feedbackID(args)}` });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: feedbackThreadHuman(response.body as FeedbackSubmission) };
});

export const handleFeedbackReply = commandHandler(async (args, runtime, resolved) => {
  const id = feedbackID(args);
  const text = (await readFeedbackBody(args, runtime)).trim();
  if (!text || [...text].length > 2000) throw usageError("A feedback reply must be 1 to 2000 characters.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `/api/feedback/${id}/responses`, body: { text }, idempotent: true });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: feedbackThreadHuman(response.body as FeedbackSubmission) };
});

async function submitFeedback(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, kind: FeedbackKind): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const title = args.positionals[2]?.trim();
  if (!title) {
    throw usageError(`feedback ${kind} requires a title.`);
  }
  if (title.length > FEEDBACK_TITLE_MAX) {
    throw usageError(`A feedback title is at most ${FEEDBACK_TITLE_MAX} characters.`);
  }
  const body = (await readFeedbackBody(args, runtime)).trim();
  if (!body) {
    throw usageError("A feedback body must not be empty.");
  }
  if (body.length > FEEDBACK_BODY_MAX) {
    throw usageError(`A feedback body is at most ${FEEDBACK_BODY_MAX} characters.`);
  }

  const context = feedbackContextFromArgs(args, `${process.platform}/${process.arch}`);
  const payload: FeedbackWrite = { title, body, ...(context ? { context } : {}) };

  // Submissions are immutable and the server deduplicates an exact retry under
  // the same key for 24 hours, so the ordinary idempotency key is what makes a
  // retry safe rather than duplicating a report.
  const response = await client.call({
    method: "POST",
    path: FEEDBACK_PATHS[kind],
    idempotent: true,
    body: payload,
  });
  const submission = response.body as FeedbackSubmission;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(kind === "bug" ? "Bug report submitted" : "Feature request submitted", [
      ["id", submission?.id],
      ["kind", submission?.kind],
      ["title", submission?.title],
      ["created_at", submission?.created_at],
      ["note", `Add details with screenrig feedback reply ${submission?.id} --body TEXT.`],
    ]),
  };
}

/**
 * The human view of staff responses: the latest reply under its submission,
 * one line, with the fixing version when staff named one. The full list, in
 * order, is `responses` in the JSON envelope.
 */
function feedbackReplyLines(item: FeedbackSubmission): string[] {
  const reply = item.responses?.at(-1);
  if (!reply) return [];
  const text = redactText(reply.text).replace(/\s+/g, " ").trim();
  const shown = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const fixed = reply.fixed_in ? ` in ${reply.fixed_in}` : "";
  return [`    ${reply.author === "agent" ? "agent · " : ""}${reply.status}${fixed}: ${shown}`];
}

async function feedbackList(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const kindFlag = flagString(args.flags, "kind")?.toLowerCase();
  if (kindFlag !== undefined && kindFlag !== "bug" && kindFlag !== "feature") {
    throw usageError("--kind accepts bug or feature.");
  }
  const kinds: FeedbackKind[] = kindFlag ? [kindFlag as FeedbackKind] : ["bug", "feature"];

  const items: FeedbackSubmission[] = [];
  for (const kind of kinds) {
    const response = await client.call({ method: "GET", path: FEEDBACK_PATHS[kind] });
    const page = (response.body ?? {}) as FeedbackList;
    // The route already fixes the kind; keep it on each item so a merged list
    // stays unambiguous even when the server omits it.
    for (const item of page.items ?? []) {
      items.push({ ...item, kind: item.kind ?? kind });
    }
  }
  items.sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0));

  return {
    envelope: successEnvelope({ items }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human:
      items.length === 0
        ? "No feedback submissions"
        : [
            `Feedback submissions (${items.length})`,
            ...items.flatMap((item) => [
              `${item.created_at}  ${item.kind.padEnd(7)}  ${item.id}  ${(item.status ?? "open").padEnd(9)}  ${item.title}`,
              ...feedbackReplyLines(item),
            ]),
          ].join("\n"),
  };
}

export const handlePlaylistList = commandHandler(async (args, runtime, resolved) => {

  const result = await simpleList(args, runtime, resolved, "/api/playlists", "Playlists");
  if (result.envelope.ok) {
    const data = result.envelope.data as { items?: Array<{ id: string; name: string; revision: number; updated_at?: string; fields?: unknown[] }> };
    if (Array.isArray(data.items) && flagBool(args.flags, "templates")) {
      data.items = data.items.filter((item) => Array.isArray(item.fields) && item.fields.length > 0);
    }
    if (Array.isArray(data.items)) {
      result.human = ["Playlists", "ID\tRevision\tUpdated\tName",
        ...data.items.map((item) => `${item.id}\t${item.revision}\t${item.updated_at ?? "—"}\t${item.name}`),
      ].join("\n");
    }
  }
  return result;
}, true);

export const handlePlaylistShow = commandHandler(async (args, runtime, resolved) => {

  const id = args.positionals[2];
  if (!id) throw usageError("playlist get requires an id.");
  const output = flagString(args.flags, "output");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await callPlaylist(client, { method: "GET", id });
  if (!output && !flagBool(args.flags, "editable")) {
    const requestId = client.requestId;
    const notes = await resourceNotes(runtime, client, "playlist", id);
    return { envelope: jsonBody(response, requestId, undefined, notes.warnings), exitCode: ExitCode.Success,
      human: [`Playlist\n${JSON.stringify(response.body, null, 2)}`, ...notes.lines].join("\n") };
  }
  const resource = response.body as { id: string; revision: number };
  if (resource.id !== id || !Number.isSafeInteger(resource.revision) || resource.revision < 1) throw usageError("Playlist response has invalid identity or revision.");
  const document = editablePlaylist(response.body);
  const file = output ? await writeAuthoringJson(output, document, runtime, flagBool(args.flags, "overwrite")) : undefined;
  return { envelope: successEnvelope({ playlist_id: id, revision: resource.revision, ...(file ? { output: file } : { document }) }, { request_id: client.requestId }), exitCode: ExitCode.Success, human: file ? `Editable playlist written to ${file}` : JSON.stringify(document, null, 2) };
}, true);

export const handlePlaylistExport = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  requireFlagValue(args, "output", "./playlist-bundle");
  const id = args.positionals[2];
  const output = flagString(args.flags, "output");
  if (!id || !output) {
    throw usageError("playlist export requires <id> --output <directory>.");
  }
  const result = await exportPlaylistBundle({
    playlistId: id,
    outputDirectory: path.resolve(runtime.cwd(), output),
    client,
    skipApplications: flagBool(args.flags, "skip-applications"),
  });
  const skipped = result.skipped_applications;
  return {
    envelope: successEnvelope(result, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Playlist exported", [
      ["playlist_id", result.playlist_id],
      ["directory", result.directory],
      ["media_count", String(result.media_count)],
      ["media_bytes", String(result.media_bytes)],
      ...(skipped.primitives.length > 0 ? [["skipped_application_primitives", skipped.primitives.join(", ")] as [string, string]] : []),
      ...(skipped.pages.length > 0 ? [["skipped_pages", skipped.pages.join(", ")] as [string, string]] : []),
    ]),
  };
}, true);

export const handlePlaylistImport = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  requireFlagValue(args, "update", "pl_01");
  requireFlagValue(args, "if-match", "1");
  requireFlagValue(args, "name", "Lobby loop (copy)");
  const directory = args.positionals[2];
  if (!directory) throw usageError("playlist import requires one <directory>.");
  const updateId = flagString(args.flags, "update");
  const ifMatch = flagString(args.flags, "if-match");
  const name = flagString(args.flags, "name");
  const result = await importPlaylistBundle({
    directory: path.resolve(runtime.cwd(), directory),
    client,
    runtime,
    updateId,
    ifMatch,
    name,
    timeoutMs: flagNumber(args.flags, "timeout"),
    pollMs: flagNumber(args.flags, "poll-ms"),
    note: flagString(args.flags, "note"),
    beforePlaylistWrite: async (playlist, targetId) => {
      if (targetId) await assertAssignedScreensHaveZone(client, targetId, playlist.pages);
    },
  });
  const media: Array<[string, string]> = [
    ["source_playlist_id", result.source_playlist_id],
    ["directory", result.directory],
    ["media_reused", String(result.media.reused)],
    ["media_uploaded", String(result.media.uploaded)],
  ];
  const lifted = releaseWarnings(result);
  const { warnings: _raw, ...rest } = result as typeof result & { warnings?: unknown };
  const data = { ...rest, playlist: withoutAnswerWarnings(result.playlist) };
  const warningLines = lifted.map((warning) => `warning: ${warning.message}`);
  if (result.review) {
    return {
      envelope: successEnvelope({ ...data, next: reviewNext(result.review.id) }, { request_id: client.requestId, warnings: [pendingReviewWarning(result.review), ...lifted] }),
      exitCode: ExitCode.Success,
      human: [...pendingReviewLines(result.review), ...media.map(([key, value]) => `${key}: ${value}`), ...warningLines].join("\n"),
    };
  }
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: lifted }),
    exitCode: ExitCode.Success,
    human: [humanLines(`Playlist ${result.mode === "create" ? "imported" : "updated from bundle"}`, media), ...warningLines].join("\n"),
  };
}, true);

/** The warnings a library result carried (its `warnings` member, or its playlist answer's), as envelope warnings. */
function releaseWarnings(result: { warnings?: unknown; playlist?: unknown }): Warning[] {
  const playlist = result.playlist as { id?: unknown } | undefined;
  const id = typeof playlist?.id === "string" ? playlist.id : undefined;
  return result.warnings !== undefined
    ? playlistWarnings(result.warnings, id, true)
    : playlistAnswerWarnings(result.playlist);
}

async function playlistCreateUpdateAction(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, action: "create" | "update"): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = action === "update" ? args.positionals[2] : undefined;
  const file = action === "update" ? args.positionals[3] : args.positionals[2];
  const ifMatch = flagString(args.flags, "if-match");
  if (!file || (action === "update" && !id)) {
    throw usageError(`playlist ${action} requires ${action === "update" ? "<id> <file>" : "<file>"}.`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = await readAuthoringJson(file, runtime) as Record<string, unknown>;
  } catch (err) {
    throw usageError(`Cannot read playlist JSON: ${err instanceof Error ? err.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string" || !Array.isArray(parsed.pages)) {
    throw usageError("Playlist JSON must contain string name and array pages.");
  }
  const extra = Object.keys(parsed).filter((key) => key !== "name" && key !== "audio" && key !== "format" && key !== "fields" && key !== "pages");
  if (extra.length > 0) {
    throw usageError(`Playlist JSON contains unsupported fields: ${extra.join(", ")}.`);
  }
  const pages = parsed.pages;
  assertWirePages(pages);
  const body = { name: parsed.name, ...(parsed.audio !== undefined ? { audio: parsed.audio } : {}), ...(parsed.format !== undefined ? { format: parsed.format } : {}), ...(parsed.fields !== undefined ? { fields: parsed.fields } : {}), pages };
  assertPlaylistValid(body);
  await validatePlaylistCards(client, body);
  // Only a signage-capable project may place adslot pages.
  if (pages.some(isAdSlotPage)) {
    await requireCapability(client, "signage.playlists", `playlist ${action} with adslot pages`, {
      command: "screenrig project capabilities",
      reason: "Read the project's effective capabilities before authoring an ad-bearing playlist; only a screens-capable project can place adslot pages.",
    });
  }
  // A create has no assigned screen yet, so there is nothing to check. An
  // update can add a schedule to a playlist screens are already running.
  if (action === "update" && id) {
    await assertAssignedScreensHaveZone(client, id, pages);
  }
  const note = reviewNoteFrom(args);
  const response = action === "create"
    ? await client.call({ method: "POST", path: "/api/playlists", idempotent: true, body, headers: note })
    : await callPlaylist(client, {
      method: "PUT",
      id: id!,
      body,
      headers: { ...note, ...(ifMatch ? { "if-match": quotedRevision(ifMatch) } : {}) },
    });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return playlistWriteResult(response, client.requestId, `Playlist ${action}d.`);

}

export const handlePlaylistCreate = commandHandler(async (args, runtime, resolved) => {
  if (flagString(args.flags, "from-template") !== undefined || flagString(args.flags, "starter") !== undefined) {
    // Loaded here: the module imports this one, so a static import would cycle.
    return (await import("./playlist-fields.js")).playlistCreateFromTemplate(args, runtime, resolved);
  }
  return playlistCreateUpdateAction(args, runtime, resolved, "create");
}, true);

export const handlePlaylistUpdate = commandHandler(async (args, runtime, resolved) => {
  return playlistCreateUpdateAction(args, runtime, resolved, "update");
}, true);

export const handlePlaylistPatch = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const file = args.positionals[3];
  if (!id) throw usageError("playlist patch requires <id> and at least one changed field.");
  let body: Record<string, unknown> = {};
  if (file) {
    const parsed = await readAuthoringJson(file, runtime);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usageError("Playlist patch JSON must be an object.");
    body = parsed as Record<string, unknown>;
  }
  const unknown = Object.keys(body).filter((key) => !["name", "pages", "audio", "format", "fields"].includes(key));
  if (unknown.length) throw usageError(`Playlist patch contains unsupported fields: ${unknown.join(", ")}.`);
  const name = flagString(args.flags, "name");
  if (name !== undefined) {
    if (Object.hasOwn(body, "name")) throw usageError("Supply name in the patch file or --name, not both.");
    body.name = name;
  }
  if (flagBool(args.flags, "clear-audio")) {
    if (Object.hasOwn(body, "audio")) throw usageError("Supply audio in the patch file or --clear-audio, not both.");
    body.audio = null;
  }
  if (!Object.keys(body).length) throw usageError("playlist patch requires a partial JSON file, --name, or --clear-audio.");
  if (Object.hasOwn(body, "name")) {
    if (typeof body.name !== "string" || !body.name.trim() || [...body.name.trim()].length > 120 || /[\p{Cc}]/u.test(body.name)) {
      throw usageError("name must contain 1 to 120 Unicode characters after trimming, with no control characters.");
    }
    body.name = body.name.trim();
  }
  if (Object.hasOwn(body, "pages")) {
    if (!Array.isArray(body.pages) || body.pages.length === 0) throw usageError("pages must be a non-empty array.");
    assertWirePages(body.pages);
  }
  if (body.audio !== undefined && body.audio !== null && (typeof body.audio !== "object" || Array.isArray(body.audio))) {
    throw usageError("audio must be a soundtrack object or null.");
  }
  if (body.format !== undefined && body.format !== null && (typeof body.format !== "object" || Array.isArray(body.format))) {
    throw usageError("format must be a video wall format object or null.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (Array.isArray(body.pages)) {
    await validatePlaylistCards(client, { pages: body.pages });
    await assertAssignedScreensHaveZone(client, id, body.pages);
  }
  const expected = flagString(args.flags, "if-match");
  const response = await callPlaylist(client, { method: "PATCH", id, body,
    headers: { ...reviewNoteFrom(args), ...(expected ? { "if-match": quotedRevision(expected) } : {}) },
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return playlistWriteResult(response, client.requestId, `Playlist ${id} updated.`);
}, true);

export const handlePlaylistReplaceRelease = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const result = await replacePlaylistRelease({ client, apiUrl: resolved.apiUrl,
    playlistId: args.positionals[2]!, pageId: flagString(args.flags, "page")!,
    primitiveId: flagString(args.flags, "primitive")!, releaseId: flagString(args.flags, "release-id")!,
    apply: flagBool(args.flags, "apply"), revision: flagString(args.flags, "if-match"),
    impact: flagString(args.flags, "expect-impact"), note: flagString(args.flags, "note"),
  });
  const answer = result as { warnings?: unknown; playlist?: unknown };
  const lifted = releaseWarnings(answer);
  const data = { ...result, ...(answer.playlist ? { playlist: withoutAnswerWarnings(answer.playlist) } : {}) };
  delete (data as { warnings?: unknown }).warnings;
  const warningLines = lifted.map((warning) => `warning: ${warning.message}`);
  if ("review" in result && result.review) {
    return {
      envelope: successEnvelope({ ...data, next: reviewNext(result.review.id) }, { request_id: client.requestId, warnings: [pendingReviewWarning(result.review), ...lifted] }),
      exitCode: ExitCode.Success,
      human: [...pendingReviewLines(result.review), ...warningLines].join("\n"),
    };
  }
  return { envelope: successEnvelope(data, { request_id: client.requestId, warnings: lifted }), exitCode: ExitCode.Success, human: [JSON.stringify(data, null, 2), ...warningLines].join("\n") };
}, true);

export const handlePlaylistDelete = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const ifMatch = flagString(args.flags, "if-match");
  if (!id) throw usageError("playlist delete requires <id>.");
  let response;
  try {
    response = await callPlaylist(client, {
      method: "DELETE",
      id,
      ...(ifMatch ? { headers: { "if-match": quotedRevision(ifMatch) } } : {}),
    });
  } catch (error) {
    throw playlistInUseProblem(error);
  }
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted playlist ${id}` };
}, true);

function scheduleZoneError(screenId: string): CliError {
  return usageError(
    `Screen ${screenId} has no timezone, and the playlist has civil-time visibility bounds. Set the screen's IANA timezone before assigning it.`,
    {
      command: `screenrig screen set-timezone ${screenId} --timezone America/Los_Angeles --expect-rev REVISION`,
      reason: "Set the screen timezone first, then assign the playlist. Read the current revision from screen show.",
    },
  );
}

/**
 * Refuse a scheduled playlist locally before the PATCH goes out. The server
 * rejects the same pair, but it answers about a body the operator did not
 * write; naming the screen and the fixing command here is the difference
 * between a clear message and an opaque rejection.
 */
async function assertScheduledPlaylistHasZone(client: ApiClient, screenId: string, playlistId: string): Promise<unknown> {
  const playlist = await callPlaylist(client, { method: "GET", id: playlistId });
  if (!playlistNeedsTimezone(playlist.body)) {
    return playlist.body;
  }
  const screen = await client.call({ method: "GET", path: `/api/screens/${screenId}` });
  if ((screen.body as Screen | undefined)?.timezone) {
    return playlist.body;
  }
  throw scheduleZoneError(screenId);
}

/**
 * The same rule reached from the playlist side. Adding civil-time bounds to a
 * playlist that screens already run breaks their manifests, so check every screen
 * the playlist is assigned to rather than waiting for rematerialize to refuse.
 */
async function assertAssignedScreensHaveZone(client: ApiClient, playlistId: string, pages: unknown): Promise<void> {
  if (!playlistNeedsTimezone({ pages })) {
    return;
  }
  const response = await client.listAll("/api/screens");
  const items = (response.body as { items?: Screen[] } | undefined)?.items;
  if (!Array.isArray(items)) {
    return;
  }
  const unzoned = items.find((screen) => screen?.playlist_id === playlistId && !screen?.timezone);
  if (unzoned) {
    throw scheduleZoneError(unzoned.id);
  }
}

export const handleScreenList = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const { query, repeated } = screenListQuery(args);
  const response = await client.listAll("/api/screens", query, repeated ? { queryRepeated: repeated } : undefined);
  const items = (response.body as { items?: Screen[] } | undefined)?.items;
  const warnings = Array.isArray(items) ? items.flatMap((screen) => screenStorageWarnings(screen.id, screen, runtime.now())) : [];
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: ["Screens", ...screenTableLines(Array.isArray(items) ? items : [], runtime.now()), JSON.stringify(response.body, null, 2), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

/**
 * One row per screen. The platform column appears only when at least one
 * screen reports a host, and the reason column only when at least one
 * archived screen reports why it was archived, and the tags column only when
 * at least one screen carries a tag, and the fields and location columns only
 * when at least one screen carries them, and the upgrade column only when at
 * least one screen has a manifest upgrade story, so a fleet without any
 * keeps the table it had. The JSON body follows unchanged in both output modes.
 */
function screenTableLines(items: Screen[], now: Date): string[] {
  if (!items.length) return [];
  const withPlatform = items.some((screen) => typeof screen?.host?.platform === "string");
  const withReason = items.some((screen) => archiveReason(screen) !== undefined);
  const withTags = items.some((screen) => screenTags(screen).length > 0);
  // Only when a listed screen sits in a screen folder, so a fleet without folders keeps its table.
  const withFolder = items.some((screen) => screenFolderCell(screen) !== "");
  // Only when a listed screen carries fields or a location, so plain fleets keep their table.
  const withFields = items.some((screen) => screenFieldsCell(screen) !== "");
  const withLocation = items.some((screen) => screenLocationCell(screen) !== "");
  // Only when something overrides the assigned default, so plain fleets keep their table.
  const withAssignment = items.some((screen) => screen?.effective_playlist && screen.effective_playlist.source !== "default");
  // Only when a listed screen has a manifest upgrade story: a target versus
  // acknowledged mismatch, a failed/retrying/partial report, or an overdue retry.
  const withUpgrade = anyManifestUpgrade(items, now);
  // Only when a listed screen needs attention: display disconnected, hot, crashing, or a stale report.
  const withHealth = items.some((screen) => screenHealthIssues(screen).length > 0);
  const rows = items.map((screen) => [
    screen?.id ?? "", screen?.label ?? "", screen?.state ?? "",
    ...(withPlatform ? [screen?.host?.platform ?? ""] : []),
    ...(withReason ? [archiveReason(screen) ?? ""] : []),
    ...(withTags ? [screenTags(screen).join(",")] : []),
    ...(withFolder ? [screenFolderCell(screen)] : []),
    ...(withFields ? [screenFieldsCell(screen)] : []),
    ...(withLocation ? [screenLocationCell(screen)] : []),
    ...(withAssignment ? [effectivePlaylistText(screen?.effective_playlist, screen?.takeover, screen?.timezone) ?? ""] : []),
    ...(withHealth ? [screenHealthIssues(screen).join(", ") || (screen?.health ? "ok" : "")] : []),
    ...(withUpgrade ? [manifestUpgradeCell(screen, now) ?? ""] : []),
    ...(screen?.recovery_pending?.expires_at ? [`recovery pending until ${screen.recovery_pending.expires_at}`] : []),
    ...(applicationsUnsupportedAt(screen) ? ["applications unsupported"] : []),
  ]);
  const header = ["ID", "LABEL", "STATE", ...(withPlatform ? ["PLATFORM"] : []), ...(withReason ? ["REASON"] : []), ...(withTags ? ["TAGS"] : []), ...(withFolder ? ["FOLDER"] : []), ...(withFields ? ["FIELDS"] : []), ...(withLocation ? ["LOCATION"] : []), ...(withAssignment ? ["ASSIGNED"] : []), ...(withHealth ? ["HEALTH"] : []), ...(withUpgrade ? ["UPGRADE"] : [])];
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)));
  const render = (row: string[]) => row.map((cell, index) => index < widths.length ? cell.padEnd(widths[index]!) : cell).join("  ").trimEnd();
  return [render(header), ...rows.map(render)];
}

const ARCHIVE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Why an archived screen was archived, when the server says so. Only a
 * token-shaped value is printed; the JSON body carries whatever the server
 * sent. Unknown tokens print as they are, without an explanation.
 */
function archiveReason(screen: Screen | undefined): string | undefined {
  const reason = screen?.state === "archived" ? screen.archive_reason : undefined;
  return typeof reason === "string" && ARCHIVE_REASON_PATTERN.test(reason) ? reason : undefined;
}

const ARCHIVE_REASON_TEXT: Record<string, string> = {
  project: "An project or dashboard request archived it.",
  device_reset: "The player was reset on the display. Its key is still bound to this screen. If the display now shows a pairing code, screen show may report recovery_pending: screen recover moves this screen to the display's new key and retires the old one, and the screen stays archived until screen unarchive.",
  device_unpair: "The paired browser unpaired itself. Its device credential is still bound to this screen.",
  replaced: "A screen replace moved this screen's device onto another screen, so this screen keeps no device binding.",
};

/**
 * The archive block `screen show` prints. Every archive keeps the device
 * binding: the display stays dark, and unarchive re-admits the same key so a
 * display that still holds it resumes with no re-pairing.
 */
function archivedLines(screen: Screen | undefined): string[] {
  if (screen?.state !== "archived") return [];
  const reason = archiveReason(screen);
  const at = serverInstant(screen.archived_at);
  const id = typeof screen.id === "string" && screen.id ? screen.id : "<id>";
  return [
    `Archived${reason ? ` (${reason})` : ""}${at ? ` at ${at}` : ""}`,
    ...(reason && ARCHIVE_REASON_TEXT[reason] ? [ARCHIVE_REASON_TEXT[reason]] : []),
    // A replaced screen holds no key, so there is nothing for unarchive to re-admit.
    reason === "replaced"
      ? `screen unarchive cannot restore it; screen delete ${id} removes it.`
      : `Restore with screen unarchive ${id}. It re-admits the same key, so a display that still holds it resumes without re-pairing.`,
  ];
}

function applicationsUnsupportedAt(screen: Screen | undefined): string | undefined {
  return serverInstant(screen?.applications_unsupported?.at);
}

/**
 * A server date-time that is safe to print on its own line: RFC 3339 shaped
 * and parseable. Anything else stays in the JSON body only.
 */
function serverInstant(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;
}

/** The screen health line for a Player that cannot host applications or web pages. */
function applicationsUnsupportedLines(screen: Screen | undefined): string[] {
  const at = applicationsUnsupportedAt(screen);
  if (!at) return [];
  return [
    `This player can't show applications or web pages (since ${at}).`,
    "Its manifest is unchanged: the player skips application and iframe primitives, and skips a page left with none.",
  ];
}

/** The `Host` block `screen show` prints. Absent fields are omitted; identifiers belong to the owning project. */
function hostLines(host: HostContext | undefined, updatedAt: string | undefined): string[] {
  if (!host || typeof host !== "object") return [];
  const device = host.device ?? {};
  return humanLines("Host", [
    ["platform", host.platform],
    ["asset_id", device.asset_id],
    ["location", device.location],
    ["host_version", host.host_version],
    ["model", device.model],
    ["manufacturer", device.manufacturer],
    ["firmware", device.firmware],
    ["serial", device.serial],
    ["duid", device.duid],
    ["mac", device.mac],
    ["capabilities", Array.isArray(host.capabilities) && host.capabilities.length ? host.capabilities.join(", ") : undefined],
    ["updated_at", updatedAt],
  ]).split("\n");
}

/**
 * The recovery offer `screen show` prints. When the server describes the
 * display asking to reconnect, its manufacturer, platform, model, and firmware
 * follow the deadline so the operator can compare them with the display they
 * expect before confirming. Absent fields are omitted.
 */
function recoveryPendingLine(screen: Screen | undefined): string[] {
  const pending = screen?.recovery_pending;
  const expiresAt = pending?.expires_at;
  if (!expiresAt) return [];
  const host = pending?.host && typeof pending.host === "object" ? pending.host : undefined;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const name = [text(host?.manufacturer), text(host?.platform), text(host?.model)].filter((part): part is string => part !== undefined).join(" ");
  const firmware = text(host?.firmware);
  const described = [name || undefined, firmware ? `firmware ${firmware}` : undefined].filter((part): part is string => part !== undefined).join(", ");
  return [
    `Recovery pending until ${expiresAt}${described ? `: ${described}` : ""}`,
    "Confirm with screen recover <id>; nothing is rebound until then.",
    ...(described ? ["Compare the reported model and firmware with the display you expect before confirming."] : []),
  ];
}

/** A storage report older than 24 hours is stale; consumers re-check before trusting it. */
const STORAGE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The `Storage` block `screen show` prints from the player's last storage
 * report. A report older than 24 hours (per received_at) is marked stale; a
 * screen that never reported prints no storage lines. Absent parts are
 * omitted: the forecast without a report, the shortfall while the plan fits.
 */
function storageLines(screen: Screen | undefined, now: Date): string[] {
  const storage = screen?.storage;
  if (!storage || typeof storage !== "object") return [];
  const receivedMs = Date.parse(storage.received_at);
  const stale = Number.isFinite(receivedMs) && now.getTime() - receivedMs > STORAGE_STALE_MS;
  const plan = storage.plan;
  const planSummary = [plan?.fit, plan?.transition ? `${plan.transition} transition` : undefined]
    .filter((part): part is string => part !== undefined)
    .join(", ");
  const excludedPages = Array.isArray(plan?.excluded_pages) ? plan.excluded_pages.length : undefined;
  const transfer = storage.transfer_24h;
  const transferred = transfer.new + transfer.refetch + transfer.repair + transfer.failed;
  const transferSummary = transferred === 0
    ? "0 B"
    : `${formatBytes(transferred)} (new ${formatBytes(transfer.new)}, refetch ${formatBytes(transfer.refetch)}, repair ${formatBytes(transfer.repair)}, failed ${formatBytes(transfer.failed)})`;
  const forecast = screen?.storage_forecast;
  const shortfall = screen?.storage_shortfall;
  return humanLines(stale ? "Storage (stale)" : "Storage", [
    ["received_at", storage.received_at],
    ["capacity", formatBytes(storage.cache.capacity_bytes)],
    ["used", formatBytes(storage.cache.house_used_bytes)],
    ["durability", storage.durability],
    ["plan", planSummary],
    ["excluded pages", excludedPages === undefined ? undefined : String(excludedPages)],
    ["transferred in 24h", transferSummary],
    ["forecast", forecast?.fit ? `${forecast.fit} (manifest ${forecast.manifest_revision})` : undefined],
    ["shortfall", shortfall
      ? `needs ${formatBytes(shortfall.required_bytes)}, capacity ${formatBytes(shortfall.capacity_bytes)}${serverInstant(shortfall.at) ? ` (since ${shortfall.at})` : ""}`
      : undefined],
  ]).split("\n");
}

export const handleScreenProvision = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const openMode = flagBool(args.flags, "open");
  const printMode = flagBool(args.flags, "print-url") || !openMode;
  if (openMode === printMode) {
    throw usageError("screen provision requires exactly one of --open or --print-url.");
  }
  const label = flagString(args.flags, "label");
  const enrollmentRuntime = {
    fs: { ...runtime.fs, env: runtime.env, homedir: runtime.homedir },
    now: runtime.now,
    sleep: runtime.sleep,
  };
  const retry = await provisionRetryState({
    resolved,
    runtime: enrollmentRuntime,
    ...(label ? { label } : {}),
    ...(flagString(args.flags, "idempotency-key") ? { requestedKey: flagString(args.flags, "idempotency-key") } : {}),
  });

  const request: ProvisionScreen = { ...(label ? { label } : {}) };
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: "/api/screens/provision",
      idempotent: true,
      idempotencyKey: retry.idempotency_key,
      body: request,
    });
  } catch (error) {
    if (error instanceof CliError && error.problem.code === "provisioning_expired") {
      await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
    }
    throw error;
  }
  requirePrivateNoStore(response.headers, "Browser provisioning response");
  const provisioned = response.body as ScreenProvisioning;
  if (!provisioned.screen?.id || !provisioned.screen.public_id || !provisioned.expires_at || Number.isNaN(Date.parse(provisioned.expires_at))) {
    throw unexpectedResponseError("Browser provisioning response does not match the generated ScreenProvisioning contract.", client.requestId,
      "The server may have created the screen. Run screenrig screen list to find it before provisioning again.");
  }
  const urls = validateProvisioningUrls(provisioned);
  if ("withheld" in urls) {
    // The screen exists now. Report it and say why the handoff is not shown;
    // a rerun would replay the same answer, so the retry key is done too.
    await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
    const warning = { code: "provisioning_url_withheld", message: `The screen was created, but its provisioning URL is not shown: ${urls.withheld} Report the request_id with screenrig feedback bug, and archive the screen if it is not needed.` };
    return {
      envelope: successEnvelope({ screen_id: provisioned.screen.id, expires_at: provisioned.expires_at, url_withheld: urls.withheld }, { request_id: client.requestId, warnings: [warning] }),
      exitCode: ExitCode.Success,
      human: humanLines("Screen created; provisioning URL withheld", [
        ["screen_id", provisioned.screen.id],
        ["expires_at", provisioned.expires_at],
        ["url_withheld", urls.withheld],
      ]),
    };
  }
  const opened = openMode ? await (runtime.openUrl?.(urls.provisioningUrl) ?? Promise.resolve(false)) : false;
  if (printMode || opened) await clearProvisionRetryState(resolved, enrollmentRuntime, retry.idempotency_key);
  const data = {
    screen_id: provisioned.screen.id,
    public_url: urls.publicUrl,
    expires_at: provisioned.expires_at,
    ...(openMode ? { opened } : { provisioning_url: urls.provisioningUrl }),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(openMode ? "Browser provisioning" : "Sensitive one-time browser provisioning URL", [
      ["screen_id", provisioned.screen.id],
      ["public_url", urls.publicUrl],
      ["expires_at", provisioned.expires_at],
      ...(openMode ? [["opened", opened ? "true" : "false"] as [string, string]] : [["provisioning_url", urls.provisioningUrl] as [string, string]]),
    ]),
  };
}, true);

/**
 * The `Storage forecast` block `screen storage-forecast` prints. A report
 * older than 24 hours (per received_at) is marked stale, exactly like the
 * Storage block, but the forecast is still shown. With fit unknown the byte
 * counts and report time are null and their lines are omitted.
 */
function forecastLines(screenId: string, playlistId: string, forecast: ScreenStorageForecastDryRun, now: Date): string {
  const receivedMs = forecast.received_at === null ? Number.NaN : Date.parse(forecast.received_at);
  const stale = Number.isFinite(receivedMs) && now.getTime() - receivedMs > STORAGE_STALE_MS;
  return humanLines(stale ? "Storage forecast (stale)" : "Storage forecast", [
    ["screen_id", screenId],
    ["playlist_id", playlistId],
    ["fit", forecast.fit],
    ["excluded pages", String(forecast.excluded_page_count)],
    ["required", forecast.required_bytes === null ? undefined : formatBytes(forecast.required_bytes)],
    ["capacity", forecast.capacity_bytes === null ? undefined : formatBytes(forecast.capacity_bytes)],
    ["basis", forecast.basis],
    ["received_at", forecast.received_at === null ? undefined : forecast.received_at],
  ]);
}

export const handleScreenPair = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  // The Player shows the code grouped ("ABC 234"), so an unquoted code
  // arrives as two arguments.
  const rawCode = args.positionals.slice(2).join(" ");
  if (!rawCode) throw usageError("screen pair requires CODE.");
  const code = canonicalPairingCode(rawCode, "screen pair CODE");
  const label = flagString(args.flags, "label");
  const request: PairScreen = { code, ...(label ? { label } : {}) };
  const response = await client.call({
    method: "POST",
    path: "/api/screens/pair",
    idempotent: true,
    body: request,
  });
  requirePrivateNoStore(response.headers, "Screen pairing response");
  const claim = response.body as PairingClaim;
  if (!claim.screen?.id || !claim.screen.label || !claim.public_url) {
    throw usageError("Screen pairing response does not match the generated PairingClaim contract.");
  }
  // The claim is done; the Player still has to pick it up. Say how to see that happen.
  const waiting = claim.screen.state === "pairing_pending" || claim.screen.online === false;
  const next = waiting ? {
    command: `screenrig screen show ${claim.screen.id}`,
    argv: ["screen", "show", claim.screen.id],
    reason: "The Player finishes pairing the next time it contacts the service, with nothing to do on the display. screen show reports state active and online true once it has; assign a playlist with screen assign meanwhile or after.",
  } : undefined;
  return {
    envelope: jsonBody(response, client.requestId, next ? { next } : undefined),
    exitCode: ExitCode.Success,
    human: humanLines("Screen paired", [
      ["code", code],
      ["screen_id", claim.screen.id],
      ["label", claim.screen.label],
      ["state", claim.screen.state],
      ["next", next ? `${next.command} (the Player finishes pairing when it next contacts the service)` : undefined],
    ]),
  };
}, true);

/**
 * `screen show` and `playlist show`: open notes about that resource, one extra
 * read. The envelope gains a notes_about_resource warning naming them, data
 * stays the resource, and human output lists them. A failed read adds nothing.
 */
async function resourceNotes(runtime: CliRuntime, client: ApiClient, type: NoteAboutType, id: string): Promise<{ warnings: Warning[]; lines: string[] }> {
  try {
    const response = await new NotesApi(client).list({ aboutId: id, limit: "5" });
    const list = (response.body ?? {}) as NoteList;
    const warning = resourceNotesWarning(list, type, id);
    const lines = resourceNoteLines(list, runtime.now(), id);
    return { warnings: warning ? [warning] : [], lines: lines.length ? ["", ...lines] : [] };
  } catch {
    return { warnings: [], lines: [] };
  }
}

export const handleScreenShow = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  if (!id) throw usageError("screen show requires an id.");
  const response = await client.call({ method: "GET", path: `/api/screens/${id}` });
  const screen = response.body as Screen | undefined;
  const requestId = client.requestId;
  const notes = await resourceNotes(runtime, client, "screen", id);
  const warnings = screenStorageWarnings(id, screen, runtime.now());
  return {
    envelope: jsonBody(response, requestId, undefined, [...notes.warnings, ...warnings]),
    exitCode: ExitCode.Success,
    human: [
      "Screen",
      JSON.stringify(response.body, null, 2),
      ...(screenTags(screen).length ? [`Tags: ${screenTags(screen).join(", ")}`] : []),
      ...screenFolderLine(screen),
      ...screenFactsLines(screen),
      ...(screen?.fleet_link_id ? [`Created by fleet link: ${screen.fleet_link_id}`] : []),
      ...screenLinkSummaryLines(screen?.link),
      ...assignmentLine(screen?.effective_playlist, screen?.takeover, screen?.timezone),
      ...takeoverLine(screen?.takeover, screen?.timezone),
      ...(screen?.playlist_schedule?.entries?.length
        ? [`Playlist schedule: ${screen.playlist_schedule.entries.length} entr${screen.playlist_schedule.entries.length === 1 ? "y" : "ies"} (screen schedule show ${screen.id})`] : []),
      ...suspensionLines(screen),
      ...glassLines(screen),
      ...hostLines(screen?.host, screen?.host_updated_at),
      ...archivedLines(screen),
      ...replacedByLines(screen),
      ...applicationsUnsupportedLines(screen),
      ...recoveryPendingLine(screen),
      ...warnings.map((warning) => `warning: ${warning.message}`),
      ...storageLines(screen, runtime.now()),
      ...manifestUpgradeLines(screen, runtime.now()),
      ...displayLines(screen?.display, screen?.timezone),
      ...healthLines(screen?.health),
      ...outageLines(screen),
      ...commandLines(screen),
      ...notes.lines,
    ].join("\n"),
  };
}, true);

export const handleScreenStorageForecast = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const playlistId = flagString(args.flags, "playlist-id");
  const playlistRevision = flagString(args.flags, "playlist-rev");
  if (!id || !playlistId) throw usageError("screen storage-forecast requires <id> --playlist-id.");
  // A read-only dry run: no idempotency key, because the route writes nothing
  // and has no replay semantics to make safe.
  const body: ScreenStorageForecastRequest = {
    playlist_id: playlistId,
    ...(playlistRevision ? { playlist_revision: Number(playlistRevision) } : {}),
  };
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/storage-forecast`,
    body,
  });
  const forecast = response.body as ScreenStorageForecastDryRun | undefined;
  if (!forecast
    || !["fits", "partial", "none_fit", "unknown"].includes(forecast.fit)
    || !Number.isSafeInteger(forecast.excluded_page_count)
    || forecast.excluded_page_count < 0
    || !(forecast.required_bytes === null || (Number.isSafeInteger(forecast.required_bytes) && forecast.required_bytes >= 0))
    || !(forecast.capacity_bytes === null || (Number.isSafeInteger(forecast.capacity_bytes) && forecast.capacity_bytes >= 0))
    || !(forecast.received_at === null || serverInstant(forecast.received_at) !== undefined)
    || forecast.basis !== "reported_capacity") {
    throw usageError("Screen storage forecast response does not match the generated ScreenStorageForecastDryRun contract.");
  }
  const warnings = forecastStorageWarnings(id, forecast, runtime.now());
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [forecastLines(id, playlistId, forecast, runtime.now()), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

export const handleScreenUpdate = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const ifMatch = flagString(args.flags, "if-match");
  const name = flagString(args.flags, "name");
  const playlistId = flagString(args.flags, "playlist-id");
  const timezone = flagString(args.flags, "timezone");
  const facts = screenFactsPatch(args.flags);
  const changesFacts = facts.fields !== undefined || facts.location !== undefined;
  if (!id || (!name && !playlistId && !timezone && !changesFacts)) {
    throw usageError("screen update requires <id>, and --name, --playlist-id, --timezone, --field, --unset-field, --clear-fields, --location, or --clear-location.");
  }
  // A patch that sets both a playlist and a timezone satisfies the schedule
  // rule in one request, so only check when the patch leaves the screen
  // without one.
  let playlist: unknown;
  if (playlistId && !timezone) {
    playlist = await assertScheduledPlaylistHasZone(client, id, playlistId);
  } else if (playlistId) {
    // This read exists only for advisory aspect warnings. A missing warning
    // must not block a patch that supplies the required timezone itself.
    try {
      playlist = (await callPlaylist(client, { method: "GET", id: playlistId })).body;
    } catch {
      playlist = undefined;
    }
  }
  const body: ScreenPatch = {
    ...(name ? { name } : {}),
    ...(playlistId ? { playlist_id: playlistId } : {}),
    ...(timezone ? { timezone } : {}),
    ...facts,
  };
  const response = await client.call({ method: "PATCH", path: `/api/screens/${id}`, idempotent: true, headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined, body });
  // A playlist-only change under Propose access waits for review.
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  const warnings = [
    ...(playlistId ? aspectMismatchWarnings(id, response.body, playlist) : []),
    ...screenStorageWarnings(id, response.body as Screen | undefined, runtime.now()),
  ];
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    // The merged fields and the location the screen now holds, when this update changed them.
    human: [`Updated screen ${id}`, ...(changesFacts ? screenFactsLines(response.body as Screen | undefined) : []), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

export const handleScreenAssign = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const playlistId = flagString(args.flags, "playlist-id");
  const ifMatch = flagString(args.flags, "if-match");
  if (!playlistId) throw usageError("screen assign requires <id> --playlist-id.");
  const target = screenTarget(args, "screen assign");
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen assign");
    // Each screen runs the single-screen PATCH on the server, including its
    // timezone rule for scheduled playlists; a refusal is that screen's result.
    return screenFleetAction(client, runtime, "Fleet assign", target.selector, { type: "assign", playlist_id: playlistId }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const playlist = await assertScheduledPlaylistHasZone(client, id, playlistId);
  const body: ScreenPatch = { playlist_id: playlistId };
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${id}`,
    idempotent: true,
    headers: { ...reviewNoteFrom(args), ...(ifMatch ? { "if-match": quotedRevision(ifMatch) } : {}) },
    body,
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  const warnings = [
    ...aspectMismatchWarnings(id, response.body, playlist),
    ...screenStorageWarnings(id, response.body as Screen | undefined, runtime.now()),
  ];
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [`Assigned playlist ${playlistId} to ${id}`, ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
}, true);

export const handleScreenSetTimezone = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const timezone = flagString(args.flags, "timezone");
  const ifMatch = flagString(args.flags, "if-match");
  if (!id || !timezone) throw usageError("screen set-timezone requires <id> --timezone.");
  // The zone database belongs to the server, which validates the identifier
  // against it. Sending the value unchanged keeps one authority for what a
  // real zone is, so the CLI never carries a list that can go stale.
  const body: ScreenPatch = { timezone };
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${id}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
    body,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Set timezone ${timezone} on ${id}` };
}, true);

/** screen wall set|clear: one ScreenPatch carrying only wall; null clears it. */
async function screenWallPatch(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, id: string, wall: ScreenPatch["wall"]) {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const ifMatch = flagString(args.flags, "if-match");
  const body: ScreenPatch = { wall };
  let response;
  try {
    response = await client.call({
      method: "PATCH",
      path: `/api/screens/${encodeURIComponent(id)}`,
      idempotent: true,
      headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
      body,
    });
  } catch (error) {
    throw wallProblem(error, id);
  }
  return { response, client, screen: response.body as Screen | undefined };
}

export const handleScreenWallSet = commandHandler(async (args, runtime, resolved) => {
  // positionals are [screen, wall, set, ID].
  const id = args.positionals[3];
  const outputs = flagString(args.flags, "outputs");
  const arrangement = flagString(args.flags, "arrangement");
  if (!id || !outputs || !arrangement) throw usageError("screen wall set requires <id> --outputs --arrangement.");
  const wall = wallFromFlags(outputs, arrangement, flagString(args.flags, "rotation"), flagString(args.flags, "columns"));
  const { response, client, screen } = await screenWallPatch(args, runtime, resolved, id, wall);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Set video wall on ${id}: ${wallLine(wall)}`,
      "Once the screen plays a playlist with a matching format, every display shows its number and name for 20 seconds after a change; playlist init --screen-id writes that format.",
      ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : []),
    ].join("\n"),
  };
}, true);

export const handleScreenWallClear = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen wall clear requires <id>.");
  const { response, client, screen } = await screenWallPatch(args, runtime, resolved, id, null);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Cleared the video wall on ${id}`, ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : [])].join("\n"),
  };
}, true);

async function screenArchiveUnarchiveAction(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, action: "archive" | "unarchive"): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const revision = flagString(args.flags, "if-match");
  if (!id) throw usageError(`screen ${action} requires <id>.`);
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/${action}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: action === "archive" ? `Archived screen ${id}` : `Unarchived screen ${id}`,
  };

}

export const handleScreenArchive = commandHandler(async (args, runtime, resolved) => {
  return screenArchiveUnarchiveAction(args, runtime, resolved, "archive");
}, true);

export const handleScreenUnarchive = commandHandler(async (args, runtime, resolved) => {
  return screenArchiveUnarchiveAction(args, runtime, resolved, "unarchive");
}, true);

export const handleScreenDelete = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const ifMatch = flagString(args.flags, "if-match");
  if (!id) throw usageError("screen delete requires <id>.");
  const response = await client.call({
    method: "DELETE",
    path: `/api/screens/${id}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted screen ${id}` };
}, true);

export const handleScreenRotatePublicId = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  const revision = flagString(args.flags, "if-match");
  if (!id) throw usageError("screen rotate-public-id requires <id>.");
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/public-id/rotate`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `Rotated public id for ${id}`,
  };
}, true);

const RECOVERY_PROBLEM_MESSAGES: Record<string, { detail: string; next: ProblemNext }> = {
  recovery_not_offered: {
    detail: "No recovery is pending for this screen. A display has to start pairing and report this screen's identifiers before recovery can be confirmed.",
    next: { command: "screenrig screen show <id>", reason: "Check recovery_pending. If the display is showing a pairing code, pair it as a new screen instead." },
  },
  recovery_expired: {
    detail: "The recovery offer for this screen has expired because the display's pairing session lapsed. Nothing was rebound.",
    next: { command: "screenrig screen show <id>", reason: "Restart pairing on the display; a new offer appears as recovery_pending." },
  },
  recovery_ambiguous: {
    detail: "The display's identifiers are attached to more than one screen, so recovery cannot be offered. Nothing was rebound.",
    next: { command: "screenrig screen pair <code>", reason: "Pair the display as a new screen, or archive the duplicate screens first." },
  },
};

export const handleScreenRecover = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const id = args.positionals[2];
  if (!id) throw usageError("screen recover requires <id>.");
  const revision = flagString(args.flags, "if-match");
  let response;
  try {
    // A fresh Idempotency-Key per invocation: the client mints one when the
    // operator did not pass --idempotency-key, and write recovery keeps it.
    response = await client.call({
      method: "POST",
      path: `/api/screens/${id}/recovery/confirm`,
      idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    const mapped = error instanceof CliError ? RECOVERY_PROBLEM_MESSAGES[error.problem.code] : undefined;
    if (!(error instanceof CliError) || !mapped) throw error;
    const next = { ...mapped.next, command: mapped.next.command.replace("<id>", id) };
    throw new CliError({ ...error.problem, detail: mapped.detail, next: error.problem.next ?? next }, error.exitCode, error.warnings);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Recovered screen ${id}`, [
        ["screen_id", screen?.id],
        ["label", screen?.label],
        ["state", screen?.state],
        ["revision", screen?.revision === undefined ? undefined : String(screen.revision)],
        ["public_id", screen?.public_id],
        ["platform", screen?.host?.platform],
      ]),
      "The display now runs this screen with its new key; the previous key retires after a fifteen-minute grace window.",
    ].join("\n"),
  };
}, true);

export const handleScreenReload = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const target = screenTarget(args, "screen reload");
  const lifetime = commandLifetime(args);
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen reload");
    return screenFleetAction(client, runtime, "Fleet reload", target.selector, { type: "reload", ...lifetime });
  }
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  let response;
  try {
    response = await client.call({
      method: "POST",
      path: `/api/screens/${encodeURIComponent(id)}/reload`,
      idempotent: true,
      ...(lifetime.expires_in_s === undefined ? {} : { body: lifetime }),
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    if (!(error instanceof CliError) || error.problem.next) throw error;
    // A pairing_pending screen has no Player to reload yet.
    if (error.problem.code === "resource_conflict") {
      throw new CliError({
        ...error.problem,
        next: { command: `screenrig screen show ${id}`, reason: "A screen still waiting to pair has no Player to reload. Pair it first." },
      }, error.exitCode, error.warnings);
    }
    // A server that predates the reload route answers a bare 404 or a 405
    // rather than a not_found problem for the screen.
    if ((error.problem.status === 404 && error.problem.code === "http_error") || error.problem.status === 405) {
      throw new CliError({
        ...error.problem,
        detail: "This API server does not offer screen reload. Nothing was sent to the screen's player.",
        next: { command: `screenrig screen show ${id}`, reason: "Confirm the screen exists; if it does, the server predates screen reload." },
      }, error.exitCode, error.warnings);
    }
    throw error;
  }
  const accepted = (response.body ?? {}) as Partial<ScreenReloadAccepted>;
  if (typeof accepted.reload_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(accepted.reload_id)
    || serverInstant(accepted.expires_at) === undefined || !validDelivery(accepted.state)) {
    throw usageError("Screen reload response does not match the generated ScreenReloadAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Reload accepted", [
        ["screen_id", id],
        ["reload_id", accepted.reload_id],
        ["state", accepted.state],
        ["expires_at", accepted.expires_at],
      ]),
      accepted.state === "queued"
        ? `The screen is offline, so the reload waits: it is sent when the screen comes online before expires_at. Cancel it with screen command cancel ${id} ${accepted.reload_id}.`
        : "The Player reloads once; a Player that reloaded in the last ten minutes ignores it.",
    ].join("\n"),
  };
}, true);

/** --expires-in as the expires_in_s of a reboot or reload; empty when the flag is absent, so the server's 24 hours applies. */
function commandLifetime(args: ParsedArgs): ScreenCommandWrite {
  const value = flagString(args.flags, "expires-in");
  return value === undefined ? {} : { expires_in_s: expiresInSeconds(value) };
}

/** The state of a reboot or reload answer: absent from a server that predates queueing, else queued or sent. */
function validDelivery(state: unknown): boolean {
  return state === undefined || state === "queued" || state === "sent";
}

/**
 * One fleet action for any number of screens: one metered action across
 * bounded continuations, paced against control budgets. Aggregate every
 * result page; partial success keeps `ok: true` and moves the exit code (see
 * fleetOutcome). An Idempotency-Key is always sent. The command's write
 * recovery keeps it only while the outcome is unknown: rerunning the
 * identical command after an interrupted or ambiguous request replays
 * finished screens without repeating their side effects. A returned answer,
 * including a partial failure, completes the write, so a later rerun is a new
 * request.
 */
async function screenFleetAction(client: ApiClient, runtime: CliRuntime, title: string, selector: ScreenActionSelector, action: ScreenAction, recoverySupersede?: string, headers?: Record<string, string>): Promise<CommandResult> {
  const body: ScreenActionRequest = { selector, action };
  let response;
  let after: string | undefined;
  const result: import("./adapters/protocol.js").ScreenActionResult = { action: action.type, matched: 0, succeeded: 0, failed: 0, results: [] };
  let total: number | undefined;
  while (true) {
    try {
      response = await client.call({ method: "POST", path: "/api/screens/actions", idempotent: true, body,
        ...(after === undefined ? {} : { query: { after } }), recoveryQuery: {}, retainRecoveryOnRefusal: true,
        ...(recoverySupersede ? { recoverySupersede } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}) });
    } catch (error) {
      if (error instanceof CliError && error.problem.status === 429 && error.problem.retry_after_seconds) {
        await runtime.sleep(error.problem.retry_after_seconds * 1000);
        continue;
      }
      if (error instanceof CliError && !error.problem.next
        && ((error.problem.status === 404 && error.problem.code === "http_error") || error.problem.status === 405)) {
        throw new CliError({ ...error.problem,
          detail: "This API server does not offer fleet screen actions. No screen was changed.",
          next: { command: "screenrig screen --help", reason: "Target one screen id at a time, or use a server that offers POST /api/screens/actions." },
        }, error.exitCode, error.warnings);
      }
      throw error;
    }
    // Under Propose access the whole fleet change is one review; a 202 is
    // otherwise a continuation page.
    const pending = pendingReviewOf(response);
    if (pending) {
      if (after !== undefined) throw unexpectedResponseError("A fleet continuation answered pending_review after screens already changed; rerun the identical command to resume safely.");
      return { ...pendingReviewResult(response, pending, client.requestId), keepRecoveryUntilOutput: true };
    }
    const page = screenActionResult(response.body, action.type);
    if ((page.offset ?? 0) !== result.matched || (total !== undefined && page.total !== total)) {
      throw unexpectedResponseError("Fleet continuation does not match the selected screens; rerun the identical command to resume safely.");
    }
    if (page.total !== undefined) total = page.total;
    result.matched += page.matched;
    result.succeeded += page.succeeded;
    result.failed += page.failed;
    result.results.push(...page.results);
    if (page.next_cursor === undefined) {
      if (response.status !== 200 || (total !== undefined && result.matched !== total)) {
        throw unexpectedResponseError("Fleet action ended without all selected screens; rerun the identical command to resume safely.");
      }
      break;
    }
    if (response.status !== 202 || page.next_cursor !== String(result.matched)) {
      throw unexpectedResponseError("Fleet continuation cursor does not match its results.");
    }
    after = page.next_cursor;
    const wait = Number(response.headers["retry-after"] ?? 0);
    if (!page.matched && (!Number.isFinite(wait) || wait <= 0)) {
      throw unexpectedResponseError("Fleet action made no progress and supplied no Retry-After; rerun the identical command to resume safely.");
    }
    if (wait > 0 && Number.isFinite(wait)) await runtime.sleep(wait * 1000);
  }
  const outcome = fleetOutcome(result);
  return {
    envelope: jsonBody({ ...response, body: result }, client.requestId, undefined, outcome.warnings),
    exitCode: outcome.exitCode,
    human: [
      fleetHumanLines(title, result, (item) => {
        if (Array.isArray(item.tags)) return `tags ${item.tags.filter((tag) => /^[A-Za-z0-9]{1,32}$/.test(tag)).join(",") || "(none)"}`;
        if (typeof item.revision === "number") return `revision ${item.revision}`;
        const command = commandResultText("reload", item.reload) ?? commandResultText("reboot", item.reboot);
        if (command) return command;
        if (item.toast && serverInstant(item.toast.expires_at)) return `toast expires ${item.toast.expires_at}`;
        return undefined;
      }),
      ...outcome.warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

/**
 * `screen tag`: exactly one of --set, --add, --remove, --clear.
 *
 * One screen id uses PATCH /api/screens/{id} with the whole tag set, the
 * same revision semantics as every other single-screen write. --set and
 * --clear send the set directly (If-Match only with --expect-rev). --add and
 * --remove read the screen, compute the new set, and PATCH it guarded by
 * --expect-rev or, when omitted, by the revision just read, so a concurrent
 * change fails with revision_conflict instead of being overwritten.
 *
 * Several ids or --tag use the fleet actions route (set_tags, add_tags,
 * remove_tags), which applies add/remove against each stored set atomically
 * and takes no revision guard.
 */
export const handleScreenTag = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  for (const flag of ["set", "add", "remove"]) requireFlagValue(args, flag, "Lobby");
  const set = flagString(args.flags, "set");
  const add = flagString(args.flags, "add");
  const remove = flagString(args.flags, "remove");
  const clear = flagBool(args.flags, "clear");
  if ([set, add, remove].filter((value) => value !== undefined).length + (clear ? 1 : 0) !== 1) {
    throw usageError("Provide exactly one of --set or --add or --remove or --clear.");
  }
  const tags = set !== undefined ? screenTagList(set, "--set")
    : add !== undefined ? screenTagList(add, "--add")
    : remove !== undefined ? screenTagList(remove, "--remove")
    : [];
  const target = screenTarget(args, "screen tag");
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen tag");
    const action: ScreenAction = add !== undefined ? { type: "add_tags", tags }
      : remove !== undefined ? { type: "remove_tags", tags }
      : { type: "set_tags", tags };
    return screenFleetAction(client, runtime, "Fleet tag", target.selector, action);
  }
  const id = target.id;
  let ifMatch = flagString(args.flags, "if-match");
  let next = tags;
  if (add !== undefined || remove !== undefined) {
    const current = (await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` })).body as Screen | undefined;
    if (!current || current.id !== id || !Number.isSafeInteger(current.revision) || current.revision < 1) {
      throw usageError("Screen response has invalid identity or revision.");
    }
    const stored = Array.isArray(current.tags) ? current.tags : [];
    next = add !== undefined ? [...stored, ...tags.filter((tag) => !stored.includes(tag))] : stored.filter((tag) => !tags.includes(tag));
    if (next.length > SCREEN_TAGS_MAX) {
      throw usageError(`Screen ${id} would carry ${next.length} tags; a screen carries at most ${SCREEN_TAGS_MAX}. Remove tags first or use --set.`);
    }
    ifMatch ??= String(current.revision);
  }
  const body: ScreenPatch = { tags: next };
  const derived = add !== undefined || remove !== undefined;
  const response = await client.call({
    method: "PATCH",
    path: `/api/screens/${encodeURIComponent(id)}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
    body,
    // The body and guard derive from the read, so a rerun after an ambiguous
    // failure fingerprints differently; it supersedes the obsolete entry.
    ...(derived ? { recoverySupersede: JSON.stringify(["screen tag", id, add !== undefined ? "add" : "remove", tags, flagString(args.flags, "if-match") ?? null]) } : {}),
  });
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(`Tagged screen ${id}`, [
      ["tags", screenTags(screen).join(", ") || "(none)"],
      ["revision", typeof screen?.revision === "number" ? String(screen.revision) : undefined],
    ]),
  };
}, true);

export const handleScreenToast = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return screenToast(args, runtime, client);
}, true);

export const handleScreenScreenshot = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  return loggerOf(runtime).withLocal({ op: "screenshot.capture", message: "screen screenshot" }, () =>
    screenScreenshot(args, runtime, client),
  );
}, true);

async function screenToast(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const body = toastWriteFromArgs(args);
  const target = screenTarget(args, "screen toast");
  if (target.kind === "fleet") {
    return screenFleetAction(client, runtime, "Fleet toast", target.selector, { type: "toast", ...body });
  }
  const id = target.id;
  const response = await client.call({
    method: "POST",
    path: `/api/screens/${id}/toast`,
    idempotent: true,
    body,
  });
  const accepted = (response.body ?? {}) as ScreenToastAccepted;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Toast accepted", [
      ["screen_id", id],
      ["level", body.level],
      ["expires_at", accepted.expires_at],
    ]),
  };
}

/** The validated toast write shared by the single-screen route and the fleet toast action. */
function toastWriteFromArgs(args: ParsedArgs): ScreenToastWrite {
  if (args.flags.level === true) {
    throw usageError("--level requires a value, such as --level info.");
  }
  if (args.flags.text === true) {
    throw usageError("--text requires a value.");
  }
  if (args.flags["duration-ms"] === true) {
    throw usageError("--duration-ms requires a value.");
  }
  const rawLevel = flagString(args.flags, "level");
  const rawText = flagString(args.flags, "text");
  if (rawText === undefined) {
    throw usageError("screen toast requires <id> and --text TEXT.");
  }
  const level = rawLevel ?? TOAST_DEFAULT_LEVEL;
  if (!isScreenToastLevel(level)) {
    throw usageError("--level must be error, alert, or info. Agent toasts use --level info.");
  }
  const text = trimToastText(rawText);
  const textLength = [...text].length;
  if (
    textLength < 1
    || textLength > TOAST_TEXT_MAX
    || toastTextHasDisallowedControl(text)
    || toastLineCount(text) > TOAST_MAX_LINES
  ) {
    throw usageError(
      "Toast text must be 1 to 120 characters, use only line feed as a line break, and have at most three lines.",
    );
  }
  const body: ScreenToastWrite = { level, text };
  if (args.flags["duration-ms"] !== undefined) {
    const durationMs = flagNumber(args.flags, "duration-ms");
    if (
      durationMs === undefined
      || !Number.isInteger(durationMs)
      || durationMs < TOAST_DURATION_MIN
      || durationMs > TOAST_DURATION_MAX
    ) {
      throw usageError("--duration-ms must be an integer between 2000 and 60000.");
    }
    body.duration_ms = durationMs;
  }
  return body;
}

function isScreenId(value: string): boolean {
  return SCREEN_ID_PATTERN.test(value);
}

type ScreenshotFailure = "timed_out" | "unsupported_surface" | "capture_failed" | "unavailable" | "deadline" | "offline";

const SCREENSHOT_FAILURE_DETAIL: Record<ScreenshotFailure, string> = {
  timed_out: "The Player did not upload the screenshot before the request expired (timed_out).",
  unsupported_surface: "The Player cannot capture the page it is showing now (unavailable: unsupported_surface).",
  capture_failed: "The Player tried to capture its screen and failed (unavailable: capture_failed).",
  unavailable: "The Player reported the screenshot as unavailable.",
  deadline: "No screenshot arrived before --timeout; the Player may still upload it (pending).",
  offline: "The screen is offline, so its Player cannot take a screenshot.",
};

const SCREENSHOT_FAILURE_HINT: Record<ScreenshotFailure, string> = {
  timed_out: "Check the screen is online with screenrig screen show ID, then run screen screenshot again; every run requests a new capture.",
  unsupported_surface: "Capture again while the screen shows an image, video or application page; screenrig screen show ID shows what it plays.",
  capture_failed: "Run screen screenshot again; every run requests a new capture.",
  unavailable: "Run screen screenshot again; every run requests a new capture.",
  deadline: "Run screen screenshot again with a larger --timeout; every run requests a new capture.",
  offline: "Bring the Player back online (screenrig screen show ID shows last_online_at), then run screen screenshot again.",
};

function screenshotUnavailable(requestId: string, failure: ScreenshotFailure, lastSeen?: string): CliError {
  const detail = failure === "offline" && lastSeen
    ? `The screen is offline (last online ${lastSeen}), so its Player cannot take a screenshot.`
    : SCREENSHOT_FAILURE_DETAIL[failure];
  return new CliError(
    makeProblem("screenshot_unavailable", "Screenshot is not available", 409, detail, {
      request_id: requestId,
      hint: SCREENSHOT_FAILURE_HINT[failure],
    }),
  );
}

function screenshotFailure(status: ScreenScreenshotStatus): ScreenshotFailure {
  if (status.state === "timed_out") return "timed_out";
  return status.reason === "unsupported_surface" || status.reason === "capture_failed" ? status.reason : "unavailable";
}

const READINESS_SENTENCE_MAX = 400;

/** One line, redacted, bounded: the sentence is server text shown to the operator. */
function redactedReadinessSentence(sentence: string): string {
  const flat = redactText(sentence).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return flat.length > READINESS_SENTENCE_MAX ? `${flat.slice(0, READINESS_SENTENCE_MAX)}...` : flat;
}

async function resolveScreenshotOutput(cwd: string, id: string, flags: ParsedArgs["flags"]): Promise<string> {
  return resolveDownloadOutput(cwd, `./${id}.webp`, flags);
}

/** `--output` is a file path, never a directory; the default is relative to cwd. */
async function resolveDownloadOutput(cwd: string, defaultRelative: string, flags: ParsedArgs["flags"]): Promise<string> {
  if (flags.output === true) {
    throw usageError("--output requires a file path.");
  }
  const specified = flagString(flags, "output");
  const relative = specified ?? defaultRelative;
  if (relative.endsWith("/") || relative.endsWith("\\")) {
    throw usageError("--output must be a file path, not a directory.");
  }
  const outputPath = path.resolve(cwd, relative);
  try {
    const existing = await stat(outputPath);
    if (existing.isDirectory()) {
      throw usageError("--output must be a file path, not a directory.");
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw usageError("--output must be a file path, not a directory.");
    }
  }
  return outputPath;
}

async function screenScreenshot(args: ParsedArgs, runtime: CliRuntime, client: ApiClient): Promise<CommandResult> {
  const target = screenTarget(args, "screen screenshot");
  if (target.kind === "fleet") return screenScreenshotFleet(args, runtime, client, target.selector);
  const id = target.id;
  if (!isScreenId(id)) {
    throw usageError("screen screenshot requires <id>.");
  }
  const outputPath = await resolveScreenshotOutput(runtime.cwd(), id, args.flags);
  const saved = await captureScreenshot(runtime, client, id, outputPath, screenshotOptions(args, runtime), client.idempotencyKey);
  // The screen's own picture verdict, if it has one, goes beside the image.
  const screen = await screenAfterScreenshot(client, id);
  const picture = screen?.glass?.picture;
  const data = { ...saved, ...(picture ? { picture } : {}) };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Screenshot saved", [
        ["screen_id", data.screen_id],
        ["capture_id", data.capture_id],
        ["path", data.path],
        ["bytes", String(data.bytes)],
        ["sha256", data.sha256],
        ["width", String(data.width)],
        ["height", String(data.height)],
        ["frame", frameRow(data.frame)],
      ]),
      ...flatFrameNote(data.frame, screen),
      ...glassLines(screen),
    ].join("\n"),
  };
}

/**
 * Read the screen once after its screenshot is saved, for the glass verdicts.
 * Best effort, as the explanation of a failed capture is: the screenshot is
 * already on disk, and a screen that cannot be read now prints without them.
 */
async function screenAfterScreenshot(client: ApiClient, id: string): Promise<Screen | undefined> {
  try {
    return (await client.call({ method: "GET", path: `/api/screens/${id}` })).body as Screen | undefined;
  } catch {
    return undefined;
  }
}

/** How one invocation's captures wait, retry and report progress. */
interface ScreenshotOptions {
  /** Whole wait per capture in ms; 0 leaves it to the server, which expires an unanswered request after 30 s. */
  timeoutMs: number;
  pollMs: number;
  /** Without an explicit --timeout, a Retry-After longer than the remaining wait is still honoured. */
  explicitTimeout: boolean;
  /** Shared by every capture of one invocation: no capture request goes out before this instant. */
  pace: { until: number };
  /** Progress lines for stderr, in human mode or when stderr is a terminal. */
  notify?: (line: string) => void;
}

function screenshotOptions(args: ParsedArgs, runtime: CliRuntime): ScreenshotOptions {
  const { timeoutMs, pollMs } = screenshotTiming(args);
  const visible = flagBool(args.flags, "human") || runtime.isStderrTty?.() === true;
  return {
    timeoutMs,
    pollMs,
    explicitTimeout: flagNumber(args.flags, "timeout") !== undefined,
    pace: { until: 0 },
    ...(visible ? { notify: (line: string) => { runtime.stderr.write(`${line}\n`); } } : {}),
  };
}

function screenshotTiming(args: ParsedArgs): { timeoutMs: number; pollMs: number } {
  const timeoutMs = flagNumber(args.flags, "timeout") ?? SCREENSHOT_DEFAULT_WAIT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw usageError("--timeout must be a non-negative number of milliseconds.");
  }
  if (args.flags["poll-ms"] !== undefined) {
    const pollMs = flagNumber(args.flags, "poll-ms");
    if (pollMs === undefined || !Number.isInteger(pollMs) || pollMs < 1) {
      throw usageError("--poll-ms must be a positive integer.");
    }
  }
  const pollMs = flagNumber(args.flags, "poll-ms") ?? SCREENSHOT_DEFAULT_POLL_MS;
  return { timeoutMs, pollMs };
}

interface ScreenshotSaved {
  screen_id: string;
  capture_id: string;
  path: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  /** What the backend read of this image; absent when it could not be read. */
  frame?: ScreenScreenshotFrame;
}

const SCREENSHOT_RETRY_MAX = 6;
const SCREENSHOT_BACKOFF_MS = 500;
const SCREENSHOT_BACKOFF_CAP_MS = 8000;
/** The longest Retry-After a capture honours past its default wait. */
const SCREENSHOT_RETRY_AFTER_CAP_MS = 120_000;

/** Network failures, timeouts, 429 and 5xx answers: the capture may still succeed on a later try. */
function transientScreenshotFailure(error: unknown): error is CliError {
  return error instanceof CliError && error.problem.code !== "file_error"
    && (error.problem.status >= 500 || error.problem.status === 408 || error.problem.status === 429);
}

/**
 * Bounded backoff shared by every step of one capture. Retry-After wins over
 * the exponential step; a wait that would pass the deadline ends the capture
 * with the last real failure.
 */
class ScreenshotRetry {
  private attempts = 0;
  deadline: number;
  constructor(private readonly runtime: CliRuntime, private readonly id: string, readonly options: ScreenshotOptions) {
    this.deadline = options.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  }

  async wait(error: CliError): Promise<void> {
    const after = error.problem.retry_after_seconds;
    const delay = typeof after === "number" ? after * 1000 : Math.min(SCREENSHOT_BACKOFF_MS * 2 ** this.attempts, SCREENSHOT_BACKOFF_CAP_MS);
    if (typeof after === "number" && error.problem.status === 429) {
      // A rate limit holds for every capture of this invocation, not just this one.
      this.options.pace.until = Math.max(this.options.pace.until, Date.now() + delay);
    }
    if (this.attempts >= SCREENSHOT_RETRY_MAX) throw this.exhausted(error);
    if (Date.now() + delay > this.deadline) {
      // The default wait honours one server-named wait, then allows a normal capture after it.
      if (this.options.explicitTimeout || typeof after !== "number" || delay > SCREENSHOT_RETRY_AFTER_CAP_MS) throw this.exhausted(error);
      this.deadline = Date.now() + delay + SCREENSHOT_DEFAULT_WAIT_MS;
    }
    this.attempts += 1;
    const reason = error.problem.code === "transport_error" || error.problem.code === "timeout"
      ? error.problem.code : `${error.problem.code} (HTTP ${error.problem.status})`;
    this.options.notify?.(`screen screenshot ${this.id}: ${reason}; retrying in ${Math.ceil(delay / 1000)} s${typeof after === "number" ? " as Retry-After asks" : ""} (retry ${this.attempts} of ${SCREENSHOT_RETRY_MAX}).`);
    await this.runtime.sleep(delay);
  }

  /** Sleep before the next poll, never past the deadline. */
  async poll(): Promise<void> {
    await this.runtime.sleep(Math.max(1, Math.min(this.options.pollMs, this.deadline - Date.now())));
  }

  /** Hold a new capture request until a shared Retry-After has passed. */
  async paced(): Promise<void> {
    const wait = this.options.pace.until - Date.now();
    if (wait <= 0) return;
    this.options.notify?.(`screen screenshot ${this.id}: waiting ${Math.ceil(wait / 1000)} s for the screenshot rate limit.`);
    if (Date.now() + wait > this.deadline && this.options.explicitTimeout) return;
    if (Date.now() + wait > this.deadline) this.deadline = Date.now() + wait + SCREENSHOT_DEFAULT_WAIT_MS;
    await this.runtime.sleep(wait);
  }

  private exhausted(error: CliError): CliError {
    const tried = this.attempts ? `screen screenshot retried this ${this.attempts} time${this.attempts === 1 ? "" : "s"} with backoff before giving up.` : "No retry fit before --timeout.";
    const hint = `${error.problem.hint ? `${error.problem.hint} ` : ""}${tried} Run screen screenshot again later; every run requests a new capture.`;
    return new CliError({ ...error.problem, hint }, error.exitCode, error.warnings);
  }
}

/**
 * Ask for a capture under one Idempotency-Key. After an ambiguous failure the
 * screen's status is read first: a pending capture is still in progress (ours,
 * or one requested elsewhere) and is adopted, because a new request would
 * replace it. Otherwise the same key is sent again, so a request the server
 * already accepted returns its original capture_id instead of starting another.
 */
async function requestScreenshotCapture(client: ApiClient, id: string, key: string, retry: ScreenshotRetry): Promise<string> {
  let lastFailure: CliError | undefined;
  while (true) {
    if (lastFailure) {
      await retry.wait(lastFailure);
      try {
        const current = (await client.call({ method: "GET", path: `/api/screens/${id}/screenshot/status` })).body as ScreenScreenshotStatus | undefined;
        if (current?.state === "pending" && typeof current.capture_id === "string" && current.capture_id.length > 0) return current.capture_id;
      } catch (error) {
        if (!transientScreenshotFailure(error)) throw error;
        lastFailure = error;
        continue;
      }
    }
    let acceptedResponse;
    try {
      await retry.paced();
      acceptedResponse = await client.call({ method: "POST", path: `/api/screens/${id}/screenshot`, idempotent: true, idempotencyKey: key });
    } catch (error) {
      if (!transientScreenshotFailure(error)) throw error;
      lastFailure = error;
      continue;
    }
    const captureId = ((acceptedResponse.body ?? {}) as ScreenScreenshotAccepted).capture_id;
    if (typeof captureId !== "string" || captureId.length === 0) {
      throw new CliError(
        makeProblem("invalid_request", "Request is invalid", 400, "Screenshot request did not return a capture_id.", {
          request_id: client.requestId,
        }),
      );
    }
    return captureId;
  }
}

/**
 * A capture that expired or outlived --timeout usually means the Player is not
 * connected. Read the screen once to say so instead of the bare state.
 */
async function explainedScreenshotFailure(client: ApiClient, id: string, failure: ScreenshotFailure): Promise<CliError> {
  if (failure === "timed_out" || failure === "deadline") {
    try {
      const screen = (await client.call({ method: "GET", path: `/api/screens/${id}` })).body as Partial<Screen> | undefined;
      if (screen?.online === false) return screenshotUnavailable(client.requestId, "offline", typeof screen.last_online_at === "string" ? screen.last_online_at : undefined);
    } catch {
      // The explanation is best effort; the capture's own state still stands.
    }
  }
  return screenshotUnavailable(client.requestId, failure);
}

/** One read, retried on transient failures until the shared retry budget runs out. */
async function retriedScreenshotRead<T>(retry: ScreenshotRetry, read: () => Promise<T>): Promise<T> {
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (!transientScreenshotFailure(error)) throw error;
      await retry.wait(error);
    }
  }
}

/**
 * Request, wait for, verify, and atomically write one screen's screenshot.
 * `key` is fresh for every run: a screenshot is an observation, so a stored
 * answer from an earlier run is never replayed.
 */
async function captureScreenshot(runtime: CliRuntime, client: ApiClient, id: string, outputPath: string, options: ScreenshotOptions, key: string): Promise<ScreenshotSaved> {
  const retry = new ScreenshotRetry(runtime, id, options);
  let captureId = await requestScreenshotCapture(client, id, key, retry);

  let status: ScreenScreenshotStatus | undefined;
  await loggerOf(runtime).withLocal(
    { op: "screenshot.wait", message: `wait for screenshot ${id}` },
    async (span) => {
      while (true) {
        const statusResponse = await retriedScreenshotRead(retry, () => client.call({
          method: "GET",
          path: `/api/screens/${id}/screenshot/status`,
        }));
        status = (statusResponse.body ?? {}) as ScreenScreenshotStatus;
        const currentId = status.capture_id;
        span.progress({ capture_id: currentId, state: status.state });
        if (typeof currentId === "string" && currentId.length > 0 && currentId !== captureId) {
          // A later request for this screen replaced ours. It captures the same
          // screen, so wait for it and return it rather than failing.
          span.progress({ adopted_capture_id: currentId, replaced_capture_id: captureId });
          options.notify?.(`screen screenshot ${id}: a later request replaced capture ${captureId}; waiting for ${currentId}.`);
          captureId = currentId;
        }
        if (status.state === "ready" && currentId === captureId) {
          span.finish({ capture_id: captureId, state: status.state });
          return;
        }
        if ((status.state === "timed_out" || status.state === "unavailable") && currentId === captureId) {
          throw await explainedScreenshotFailure(client, id, screenshotFailure(status));
        }
        if (Date.now() >= retry.deadline) {
          throw await explainedScreenshotFailure(client, id, "deadline");
        }
        await retry.poll();
      }
    },
  );

  const download = await retriedScreenshotRead(retry, () => client.call({
    method: "GET",
    path: `/api/screens/${id}/screenshot`,
    query: { capture_id: captureId },
    headers: { accept: "image/webp" },
    binary: true,
  }));
  const bytes = download.body;
  const contentType = download.headers["content-type"] ?? "";
  const digest = bytes instanceof Uint8Array ? createHash("sha256").update(bytes).digest("hex") : "";
  const reportedLength = download.headers["content-length"];
  const parsedLength = reportedLength !== undefined ? Number(reportedLength) : undefined;
  const lengthMatches =
    bytes instanceof Uint8Array
    && typeof status?.bytes === "number"
    && bytes.byteLength === status.bytes
    && (parsedLength === undefined || !Number.isFinite(parsedLength) || parsedLength === bytes.byteLength);
  const digestMatches = typeof status?.sha256 === "string" && status.sha256 === digest;
  const typeMatches = contentType.toLowerCase().startsWith("image/webp");
  if (
    !(bytes instanceof Uint8Array)
    || !typeMatches
    || !lengthMatches
    || !digestMatches
    || typeof status?.width !== "number"
    || typeof status.height !== "number"
  ) {
    throw new CliError(
      makeProblem(
        "invalid_request",
        "Request is invalid",
        400,
        "Screenshot download did not match the ready status metadata.",
        { request_id: client.requestId },
      ),
    );
  }

  const tempPath = tempPathFor(outputPath);
  const release = removeOnSignal(tempPath);
  try {
    await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(tempPath, outputPath);
  } catch {
    await rm(tempPath, { force: true });
    throw usageError("Cannot write screenshot to the output path.");
  } finally {
    release();
  }

  return {
    screen_id: id,
    capture_id: captureId,
    path: outputPath,
    bytes: bytes.byteLength,
    sha256: digest,
    width: status.width,
    height: status.height,
    ...(status.frame && typeof status.frame.flat === "boolean" ? { frame: { flat: status.frame.flat, analyzed_at: status.frame.analyzed_at } } : {}),
  };
}

const SCREENSHOT_FLEET_DEFAULT_CONCURRENCY = 4;
const SCREENSHOT_FLEET_MAX_CONCURRENCY = 8;

type ScreenshotFleetItem = FleetItem & Partial<Omit<ScreenshotSaved, "screen_id">>;

/**
 * Client-side screenshot fan-out: screenshots are unbilled per screen, so
 * there is no fleet screenshot action. --tag resolves through
 * GET /api/screens?tag=T and keeps active screens, matching the fleet
 * actions selector (one metered list request per page; captures are unbilled). Each
 * capture writes DIRECTORY/<screen_id>.webp; a failed capture is that
 * screen's result, never a transport error. An unexpected (non-CliError)
 * failure stops scheduling: the failing screen and every screen not yet
 * started are reported as failed, and the exit code is Unexpected.
 */
async function screenScreenshotFleet(args: ParsedArgs, runtime: CliRuntime, client: ApiClient, selector: ScreenActionSelector): Promise<CommandResult> {
  if (flagString(args.flags, "idempotency-key")) {
    throw usageError("screen screenshot with several screens or --tag does not take --idempotency-key; each capture uses its own key.");
  }
  requireFlagValue(args, "concurrency", "4");
  const concurrency = flagNumber(args.flags, "concurrency") ?? SCREENSHOT_FLEET_DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > SCREENSHOT_FLEET_MAX_CONCURRENCY) {
    throw usageError(`--concurrency must be a whole number from 1 to ${SCREENSHOT_FLEET_MAX_CONCURRENCY}.`);
  }
  if (selector.by === "ids") {
    const invalid = selector.screen_ids.find((id) => !isScreenId(id));
    if (invalid !== undefined) throw usageError("screen screenshot takes screen ids (scr_...); nothing was captured.");
  }
  if (args.flags.output === true) throw usageError("--output requires a directory path.");
  const directory = path.resolve(runtime.cwd(), flagString(args.flags, "output") ?? ".");
  try {
    if (!(await stat(directory)).isDirectory()) throw usageError("--output must be a directory with several screens or --tag.");
  } catch (error) {
    if (error instanceof CliError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw usageError("--output must be a directory with several screens or --tag.");
  }
  // One pace for the whole fleet: a 429's Retry-After holds every worker.
  const options = screenshotOptions(args, runtime);

  let ids: string[];
  const offline = new Map<string, string | undefined>();
  if (selector.by === "tag") {
    const listed = await client.listAll("/api/screens", { tag: selector.tag }, { uncapped: true });
    const items = (listed.body as { items?: Screen[] } | undefined)?.items;
    if (!Array.isArray(items)) throw usageError("Screen list response does not match the generated ScreenList contract.");
    const active = items.filter((screen) => screen?.state === "active" && typeof screen.id === "string");
    ids = active.map((screen) => screen.id);
    // The list already says which screens are offline; do not wait out their captures.
    for (const screen of active) if (screen.online === false) offline.set(screen.id, screen.last_online_at);
    if (ids.some((id) => !isScreenId(id))) throw usageError("Screen list response does not match the generated ScreenList contract.");
  } else if (selector.by === "folder") {
    // The folder and every folder inside it; GET /api/screens?folder lists only the screens directly in one folder.
    await client.call({ method: "GET", path: `/api/screen-folders/${selector.folder_id}` });
    const folders = ((await client.call({ method: "GET", path: "/api/screen-folders" })).body as { items?: ScreenFolder[] } | undefined)?.items;
    if (!Array.isArray(folders)) throw usageError("Screen folder list response does not match the generated ScreenFolderList contract.");
    const active: Screen[] = [];
    for (const folderId of folderSubtree(folders, selector.folder_id)) {
      const listed = await client.listAll("/api/screens", { folder: folderId }, { uncapped: true });
      const items = (listed.body as { items?: Screen[] } | undefined)?.items;
      if (!Array.isArray(items)) throw usageError("Screen list response does not match the generated ScreenList contract.");
      active.push(...items.filter((screen) => screen?.state === "active" && typeof screen.id === "string"));
    }
    ids = active.map((screen) => screen.id);
    for (const screen of active) if (screen.online === false) offline.set(screen.id, screen.last_online_at);
    if (ids.some((id) => !isScreenId(id))) throw usageError("Screen list response does not match the generated ScreenList contract.");
  } else {
    ids = selector.screen_ids;
  }
  if (ids.length) {
    try {
      await mkdir(directory, { recursive: true });
    } catch {
      throw usageError("Cannot create the --output directory.");
    }
  }

  const results: ScreenshotFleetItem[] = new Array(ids.length);
  // The exit code each failed capture would have had on its own; never serialized.
  const exitCodes = new Map<number, ExitCode>();
  const failure = (id: string, problem: Record<string, unknown>): ScreenshotFleetItem => ({ screen_id: id, status: "failed", problem: problem as FleetItem["problem"] });
  let next = 0;
  let fatal = false;
  const worker = async () => {
    while (!fatal && next < ids.length) {
      const index = next++;
      const id = ids[index]!;
      try {
        if (offline.has(id)) throw screenshotUnavailable(client.requestId, "offline", offline.get(id));
        const saved = await captureScreenshot(runtime, client, id, path.join(directory, `${id}.webp`), options, newIdempotencyKey());
        results[index] = { ...saved, status: "ok" };
      } catch (error) {
        if (error instanceof CliError) {
          exitCodes.set(index, error.exitCode);
          // A dropped connection or timeout has no HTTP status; do not report one.
          const local = error.problem.code === "transport_error" || error.problem.code === "timeout";
          results[index] = failure(id, {
            code: error.problem.code,
            ...(local ? {} : { status: error.problem.status }),
            title: error.problem.title,
            detail: error.problem.detail,
            ...(error.problem.hint ? { hint: error.problem.hint } : {}),
            ...(typeof error.problem.retry_after_seconds === "number" ? { retry_after_seconds: error.problem.retry_after_seconds } : {}),
            ...(error.problem.request_id ? { request_id: error.problem.request_id } : {}),
          });
        } else {
          fatal = true;
          exitCodes.set(index, ExitCode.Unexpected);
          results[index] = failure(id, { code: "unexpected_error", title: "Unexpected error", detail: "The capture failed unexpectedly; remaining captures were not started." });
        }
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  for (let index = 0; index < ids.length; index += 1) {
    if (results[index] === undefined) {
      exitCodes.set(index, ExitCode.Unexpected);
      results[index] = failure(ids[index]!, { code: "not_attempted", title: "Not attempted", detail: "Not captured because an earlier capture failed unexpectedly." });
    }
  }

  const failed = results.filter((item) => item.status === "failed").length;
  const data = {
    action: "screenshot" as const,
    selector,
    output: directory,
    matched: results.length,
    succeeded: results.length - failed,
    failed,
    results,
  };
  const outcome = fleetOutcome(data, (item) => exitCodes.get(results.indexOf(item as ScreenshotFleetItem)));
  if (fatal) outcome.exitCode = ExitCode.Unexpected;
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: outcome.warnings }),
    exitCode: outcome.exitCode,
    human: [
      fleetHumanLines("Fleet screenshot", data, (item) => item.path),
      ...outcome.warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

export const handleCardsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/card-types" });
  const tag = flagString(args.flags, "tag"), category = flagString(args.flags, "category");
  const cards = (response.body as { cards: CardSummary[] }).cards.filter(card =>
    (!tag || card.tags.includes(tag)) && (!category || card.category === category));
  return { envelope: jsonBody(response, client.requestId, { cards }), exitCode: ExitCode.Success,
    human: cards.length ? cards.map(card => `${card.id}: ${card.title} — ${card.short}\n  category: ${card.category}; tags: ${card.tags.join(", ")}; tier: ${card.tier}; layouts: ${card.layouts.join(", ") || "(none)"}; majors: ${card.majors.join(", ")}`).join("\n") : "No matching cards." };
});

export const handleCardsShow = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/card-types/${cardId(args.positionals[2]!)}` });
  const card = response.body as CardDetails;
  return { envelope: jsonBody(response, client.requestId, { properties: cardProperties(card) }), exitCode: ExitCode.Success, human: cardDetailsHuman(card) };
});

/** Global instance IDs are separate from catalogue type names. */
function cardInstanceId(args: ParsedArgs, index = 2): string {
  const id = args.positionals[index] ?? "";
  return cardUid(id);
}

async function cardObjectFile(args: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown>> {
  const value = await readAuthoringJson(flagString(args.flags, "file")!, runtime);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw usageError("Card input must be a JSON object.");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576) throw usageError("Card input must be at most 1 MiB.");
  return value as Record<string, unknown>;
}

export const handleCardPreview = commandHandler(async (args, runtime, resolved) => {
  const target = args.positionals[2];
  const output = flagString(args.flags, "output");
  if (!target || !output) throw usageError("card preview requires <type|id> and --output FILE.png.");
  const paramsFile = flagString(args.flags, "params");
  const dataFile = flagString(args.flags, "data");
  const feedFile = flagString(args.flags, "feed");
  const feed = feedFile ? await readAuthoringJson(feedFile, runtime) as Record<string, unknown> : undefined;
  const params = paramsFile ? await readAuthoringJson(paramsFile, runtime) as Record<string, unknown> : undefined;
  const data = dataFile ? await readAuthoringJson(dataFile, runtime) as Record<string, unknown> : undefined;
  const client = resolved.token ? clientFor(runtime, args, resolved.apiUrl, resolved.token) : undefined;
  const result = await withCardPreview({ apiUrl: resolved.apiUrl, runtime, client }, async (renderer) => {
    const placement = await renderer.placement({ card: target });
    const rendered = await renderer.render({ ...placement, ...(params ? { params } : {}), ...(data ? { data } : {}), ...(feed ? { feed } : {}),
      width: flagNumber(args.flags, "width") ?? 1920, height: flagNumber(args.flags, "height") ?? 1080,
      layout: flagString(args.flags, "layout"), anchor: flagString(args.flags, "anchor"),
      now: flagString(args.flags, "now"), timezone: flagString(args.flags, "timezone"),
    });
    const file = path.resolve(runtime.cwd(), output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rendered.png);
    return { ...rendered.result, file, local: true };
  });
  return { envelope: successEnvelope(result, { request_id: client?.requestId }), exitCode: ExitCode.Success,
    human: `Local card preview: ${result.file}\nOpen and inspect this image before publishing.` };
});

export const handleCardCreate = commandHandler(async (args, runtime, resolved) => {
  const params = await cardObjectFile(args, runtime);
  const type = cardId(flagString(args.flags, "type")!);
  const major = flagNumber(args.flags, "major");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: "/api/cards", idempotent: true,
    body: { type, params, ...(major !== undefined ? { major } : {}) } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Created card ${(response.body as { id: string }).id}` };
});

export const handleCardList = commandHandler(async (args, runtime, resolved) => simpleList(args, runtime, resolved, "/api/cards", "Card instances"));
export const handleCardShow = commandHandler(async (args, runtime, resolved) => simpleGet(args, runtime, resolved, `/api/cards/${cardInstanceId(args)}`, "Card instance"));
export const handleCardParams = commandHandler(async (args, runtime, resolved) => {
  const id = cardInstanceId(args);
  const params = await cardObjectFile(args, runtime);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PATCH", path: `/api/cards/${id}`, body: { params } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Card params replaced: ${id}` };
});
export const handleCardDelete = commandHandler(async (args, runtime, resolved) => {
  const id = cardInstanceId(args);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "DELETE", path: `/api/cards/${id}`, idempotent: true });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted card: ${id}` };
});
export const handleCardInstanceDataGet = commandHandler(async (args, runtime, resolved) => simpleGet(args, runtime, resolved, `/api/cards/${cardInstanceId(args, 3)}/data`, "Card instance data"));
export const handleCardInstanceDataPut = commandHandler(async (args, runtime, resolved) => {
  const id = cardInstanceId(args, 3);
  const document = await cardObjectFile(args, runtime);
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PUT", path: `/api/cards/${id}/data`, body: { document, ...cardExpiry(args.flags) }, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Card data written: ${id}\nrevision: ${(response.body as { revision: number }).revision}` };
});

export const handleFeedsGet = commandHandler(async (args, runtime, resolved) => {
  const { query, repeated } = feedQuery(args);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/feeds/${args.positionals[2]!}`, query, ...(Object.keys(repeated).length ? { queryRepeated: repeated } : {}) });
  const body = response.body as Record<string, unknown>;
  const key = response.headers["screenrig-feed-key"] ?? body.key;
  if (response.status === 202) {
    const now = runtime.now().getTime();
    const seconds = parseRetryAfter(response.headers["retry-after"], now) ?? body.retry_after_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(new Date(now + seconds * 1000).getTime())) {
      throw unexpectedResponseError("Pending feed response lacks a valid retry time.", client.requestId);
    }
    const retryAt = new Date(now + seconds * 1000).toISOString();
    return { envelope: jsonBody(response, client.requestId, { key, state: "pending", retry_after_seconds: seconds, retry_at: retryAt }), exitCode: ExitCode.Success,
      human: `Feed pending\nkey: ${key}\nretry after: ${seconds} seconds (${retryAt})` };
  }
  return { envelope: jsonBody(response, client.requestId, key ? { key } : undefined), exitCode: ExitCode.Success,
    human: `Feed\n${JSON.stringify(body, null, 2)}` };
});

export const handleKvList = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "application-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const key = args.positionals[2];

  return simpleList(args, runtime, resolved, `/api/applications/${applicationId}/kv`, "K/V");
}, true);

export const handleKvGet = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "application-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const key = args.positionals[2];

  if (!key) throw usageError("kv get requires a key.");
  return simpleGet(args, runtime, resolved, `/api/applications/${applicationId}/kv/${encodeURIComponent(key)}`, "K/V");
}, true);

export const handleKvSet = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "application-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const key = args.positionals[2];

  if (!key) throw usageError("kv set requires a key.");
  const body = await kvWriteFromArgs(args, runtime.cwd(), runtime);
  const revision = flagString(args.flags, "if-match");
  const response = await client.call({
    method: "PUT",
    path: `/api/applications/${applicationId}/kv/${encodeURIComponent(key)}`,
    idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
    body,
  });
  const entry = response.body as KVEntry;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("K/V value set", [
      ["key", entry.key],
      ["content_type", entry.content_type],
      ["bytes", String(entry.bytes)],
      ["sha256", entry.sha256],
      ["revision", String(entry.revision)],
    ]),
  };
}, true);

export const handleKvDelete = commandHandler(async (args, runtime, resolved) => {
  const applicationId = flagString(args.flags, "application-id");
  if (!applicationId) throw usageError("kv commands require --app-id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const key = args.positionals[2];

  if (!key) throw usageError("kv delete requires a key.");
  const ifMatch = flagString(args.flags, "if-match");
  const response = await client.call({
    method: "DELETE",
    path: `/api/applications/${applicationId}/kv/${encodeURIComponent(key)}`,
    idempotent: true,
    headers: ifMatch ? { "if-match": quotedRevision(ifMatch) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Deleted ${key}` };
}, true);

// Incoming K/V webhooks: /api/applications/{id}/kv-webhooks write one key of
// an application, /api/cards/{id}/kv-webhooks write a card's data document. url
// is not secret; the secrets are returned only by create, rotate-secret and the
// update that turns signing on, printed once, and kept out of the operation log
// (client.ts privateBodies).
function kvWebhookTarget(args: ParsedArgs, command: string): KvWebhookTarget {
  const applicationId = flagString(args.flags, "application-id");
  const card = flagString(args.flags, "card");
  if (applicationId && card) throw usageError("Pass --app-id or --card, not both.");
  if (card) return { kind: "card", id: cardUid(card) };
  if (!applicationId) throw usageError(`kv webhook ${command} requires --app-id (a key of an application) or --card (a card's data document).`);
  return { kind: "app", id: applicationId };
}

async function kvWebhookCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  target: KvWebhookTarget,
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw kvWebhookProblem(error, target, id);
  }
}

async function kvWebhookWithSecret(body: unknown, action: "create" | "rotate", target: KvWebhookTarget, runtime: CliRuntime, signing = false): Promise<KVWebhookWithSecret | CardKVWebhookWithSecrets> {
  const webhook = body as (KVWebhookWithSecret | CardKVWebhookWithSecrets) | undefined;
  const secret = webhook?.secret;
  const signingSecret = (webhook as CardKVWebhookWithSecrets | undefined)?.signing_secret;
  const secretOk = typeof secret === "string" && KV_WEBHOOK_SECRET_PATTERN.test(secret);
  const signingOk = signingSecret === undefined ? !signing : KV_WEBHOOK_SIGNING_SECRET_PATTERN.test(signingSecret);
  // A signing rotation answers the signing secret alone; every other create or
  // rotation answers the webhook secret.
  const shapeOk = signing && action === "rotate" ? typeof signingSecret === "string" && signingOk : secretOk && signingOk;
  if (!webhook || typeof webhook.id !== "string" || !shapeOk) {
    await writeRecoveries.get(runtime)?.finish();
    const id = webhook && typeof webhook.id === "string" && KV_WEBHOOK_ID_PATTERN.test(webhook.id) ? webhook.id : undefined;
    const flag = kvWebhookTargetFlag(target);
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "kv webhook create" : "rotate-secret"} request completed, but its answer did not carry a secret. Do not rerun it.`, {
        next: id
          ? { command: `screenrig kv webhook rotate-secret ${id} ${flag}${signing ? " --signing" : ""}`, reason: "Issue a new secret; it is shown once in the answer." }
          : { command: `screenrig kv webhook list ${flag}`, reason: "Find the webhook, then run screenrig kv webhook rotate-secret ID to receive a new secret." },
      }), ExitCode.Unexpected);
  }
  return webhook;
}

async function kvWebhookSecretResult(
  response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: "create" | "rotate", target: KvWebhookTarget, runtime: CliRuntime, signing = false,
): Promise<CommandResult> {
  const webhook = await kvWebhookWithSecret(response.body, action, target, runtime, signing);
  if (target.kind === "card") return cardWebhookSecretResult(response, client, webhook as CardKVWebhookWithSecrets, action, target, signing);
  const secretWebhook = webhook as KVWebhookWithSecret;
  const warning = kvWebhookSecretWarning(webhook.id, target, action);
  return {
    envelope: jsonBody(response, client.requestId, undefined, [warning]),
    exitCode: ExitCode.Success,
    human: [
      action === "create" ? `Created K/V webhook ${webhook.id}` : `Rotated the secret of K/V webhook ${webhook.id}`,
      ...kvWebhookLines(webhook as KVWebhookWithSecret),
      "",
      "Sensitive webhook secret (store it only in the system that posts to the url above)",
      `secret: ${secretWebhook.secret}`,
      `example: ${kvWebhookExample(webhook.url, secretWebhook.secret)}`,
      `warning: ${warning.message}`,
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

/** The answer of a card webhook request that issued a secret, a signing secret, or both. */
function cardWebhookSecretResult(
  response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, webhook: CardKVWebhookWithSecrets,
  action: "create" | "rotate" | "update", target: KvWebhookTarget, signingRotation = false,
): CommandResult {
  const warnings: Warning[] = [];
  if (webhook.secret) warnings.push(kvWebhookSecretWarning(webhook.id, target, action === "update" ? "create" : action, Boolean(webhook.signing_secret)));
  if (webhook.signing_secret) warnings.push(cardWebhookSigningWarning(webhook.id, target));
  const title = action === "create" ? `Created card webhook ${webhook.id}`
    : action === "update" ? `Updated card webhook ${webhook.id}`
    : signingRotation ? `Rotated the signing secret of card webhook ${webhook.id}` : `Rotated the secret of card webhook ${webhook.id}`;
  const lines = [title, ...cardWebhookLines(webhook)];
  if (webhook.secret || webhook.signing_secret) {
    lines.push("", "Sensitive webhook secrets (store them only in the system that posts to the url above)");
    if (webhook.secret) lines.push(`secret: ${webhook.secret}`);
    if (webhook.signing_secret) lines.push(`signing_secret: ${webhook.signing_secret}`);
    lines.push(`example: ${cardWebhookExample(webhook.url, webhook.secret, webhook.signing)}`);
    for (const warning of warnings) lines.push(`warning: ${warning.message}`);
  }
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings.length ? warnings : undefined),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
    ...(webhook.secret || webhook.signing_secret ? { keepRecoveryUntilOutput: true } : {}),
  };
}

export const handleKvWebhookCreate = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "create");
  const description = flagString(args.flags, "description");
  const key = args.positionals[3];
  let body: KVWebhookCreate | CardKVWebhookCreate;
  if (target.kind === "app") {
    if (flagString(args.flags, "map") !== undefined || flagBool(args.flags, "signing")) {
      throw usageError("--map and --signing apply to a card webhook: pass --card CARD_ID instead of --app-id.");
    }
    body = { key: kvWebhookKey(key), ...(description !== undefined ? { description: kvWebhookDescription(description) } : {}) };
  } else {
    if (key !== undefined) throw usageError("A card webhook writes the card's data document, not a key: omit <key>.");
    const map = flagString(args.flags, "map");
    body = {
      ...(description !== undefined ? { description: kvWebhookDescription(description) } : {}),
      ...(map !== undefined ? { mapping: kvWebhookMapping(await readAuthoringText(map, runtime, KV_WEBHOOK_MAPPING_MAX_BYTES)) } : {}),
      ...(flagBool(args.flags, "signing") ? { signing: true } : {}),
    };
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, { method: "POST", path: kvWebhooksPath(target), idempotent: true, body }, target);
  return kvWebhookSecretResult(response, client, "create", target, runtime, target.kind === "card" && flagBool(args.flags, "signing"));
}, true);

export const handleKvWebhookList = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "list");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, { method: "GET", path: kvWebhooksPath(target) }, target);
  const items = (response.body as KVWebhookList | CardKVWebhookList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: target.kind === "card"
      ? [`Card webhooks (${list.length})`, ...cardWebhookTableLines(list as CardKVWebhook[])].join("\n")
      : [`K/V webhooks (${list.length})`, ...kvWebhookTableLines(list as KVWebhook[])].join("\n"),
  };
}, true);

export const handleKvWebhookRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "rotate-secret");
  const id = kvWebhookId(args.positionals[3], "rotate-secret", target);
  const signing = flagBool(args.flags, "signing");
  if (signing && target.kind === "app") throw usageError("--signing rotates a card webhook's signing secret: pass --card CARD_ID.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, {
    method: "POST", path: `${kvWebhooksPath(target)}/${id}/rotate-secret`, idempotent: true,
    ...(signing ? { body: { signing: true } } : {}),
  }, target, id);
  return kvWebhookSecretResult(response, client, "rotate", target, runtime, signing);
}, true);

export const handleKvWebhookUpdate = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "update");
  if (target.kind !== "card") throw usageError("kv webhook update changes a card webhook: pass --card CARD_ID.");
  const id = kvWebhookId(args.positionals[3], "update", target);
  const description = flagString(args.flags, "description");
  const map = flagString(args.flags, "map");
  const body: CardKVWebhookUpdate = {
    ...(description !== undefined ? { description: kvWebhookDescription(description) } : {}),
    ...(map !== undefined ? { mapping: kvWebhookMapping(await readAuthoringText(map, runtime, KV_WEBHOOK_MAPPING_MAX_BYTES)) } : {}),
    ...(flagBool(args.flags, "clear-map") ? { mapping: null } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(flagBool(args.flags, "signing") ? { signing: true } : {}),
    ...(flagBool(args.flags, "no-signing") ? { signing: false } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, { method: "PATCH", path: `${kvWebhooksPath(target)}/${id}`, idempotent: true, body }, target, id);
  return cardWebhookSecretResult(response, client, response.body as CardKVWebhookWithSecrets, "update", target);
}, true);

export const handleKvWebhookDeliveries = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "deliveries");
  if (target.kind !== "card") throw usageError("kv webhook deliveries reads a card webhook's log: pass --card CARD_ID.");
  const id = kvWebhookId(args.positionals[3], "deliveries", target);
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, {
    method: "GET", path: `${kvWebhooksPath(target)}/${id}/deliveries`, ...(limit ? { query: { limit } } : {}),
  }, target, id);
  const items = (response.body as KVWebhookDeliveryList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Deliveries of ${id} (${list.length})`, ...kvWebhookDeliveryTableLines(list)].join("\n"),
  };
}, true);

export const handleKvWebhookDelete = commandHandler(async (args, runtime, resolved) => {
  const target = kvWebhookTarget(args, "delete");
  const id = kvWebhookId(args.positionals[3], "delete", target);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await kvWebhookCall(client, {
    method: "DELETE", path: `${kvWebhooksPath(target)}/${id}`, idempotent: true,
  }, target, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: target.kind === "card"
      ? `Deleted card webhook ${id}. Its URL stopped working; the card keeps its document.`
      : `Deleted K/V webhook ${id}. Its URL stopped working; the key it wrote keeps its value.`,
  };
}, true);

function commentPath(target: "screen" | "playlist", id: string, pageId: string | undefined): string {
  if (target === "screen") {
    return `/api/comment/screen/${encodeURIComponent(id)}`;
  }
  if (pageId) {
    return `/api/comment/playlist/${encodeURIComponent(id)}/page/${encodeURIComponent(pageId)}`;
  }
  return `/api/comment/playlist/${encodeURIComponent(id)}`;
}

function commentTarget(args: ParsedArgs, target: "screen" | "playlist") {
  const id = args.positionals[3];
  if (!id || (target === "screen" && !isScreenId(id))) {
    throw usageError(`comment ${target} requires <id>.`);
  }

  if (Object.hasOwn(args.flags, "if-match")) {
    throw usageError("comment commands do not take --expect-rev; last write wins and does not bump revision.");
  }
  requireFlagValue(args, "page", "poster");
  const pageId = flagString(args.flags, "page");
  if (target === "screen" && pageId !== undefined) {
    throw usageError("comment screen commands do not take --page; use comment playlist <id> --page PAGE_ID.");
  }
  if (pageId !== undefined && !PLAYLIST_PAGE_ID_PATTERN.test(pageId)) {
    throw usageError("--page must be a playlist page id: a letter, then up to 63 letters, digits, underscores, or hyphens.");
  }
  const pathName = commentPath(target, id, pageId);

  return { id, pageId, pathName };
}

async function showComment(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, target: "screen" | "playlist"): Promise<CommandResult> {
  const { pathName } = commentTarget(args, target);
  return simpleGet(args, runtime, resolved, pathName, "Comments");

}

export const handleCommentShowScreen = commandHandler((args, runtime, resolved) => showComment(args, runtime, resolved, "screen"));
export const handleCommentShowPlaylist = commandHandler((args, runtime, resolved) => showComment(args, runtime, resolved, "playlist"));

async function setComment(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, target: "screen" | "playlist"): Promise<CommandResult> {
  const { id, pageId, pathName } = commentTarget(args, target);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));

  const body = await commentsWriteFromArgs(args, runtime.cwd(), runtime);
  const response = await client.call({
    method: "PUT",
    path: pathName,
    idempotent: true,
    body,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Comments set", [
      [target, id],
      ["page", pageId],
    ]),
  };

}

export const handleCommentSetScreen = commandHandler((args, runtime, resolved) => setComment(args, runtime, resolved, "screen"));
export const handleCommentSetPlaylist = commandHandler((args, runtime, resolved) => setComment(args, runtime, resolved, "playlist"));

async function deleteComment(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, target: "screen" | "playlist"): Promise<CommandResult> {
  const { id, pageId, pathName } = commentTarget(args, target);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));

  const response = await client.call({
    method: "DELETE",
    path: pathName,
    idempotent: true,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: pageId
      ? `Deleted comments on playlist ${id} page ${pageId}`
      : `Deleted comments on ${target} ${id}`,
  };

}

export const handleCommentDeleteScreen = commandHandler((args, runtime, resolved) => deleteComment(args, runtime, resolved, "screen"));
export const handleCommentDeletePlaylist = commandHandler((args, runtime, resolved) => deleteComment(args, runtime, resolved, "playlist"));

function notesFor(runtime: CliRuntime, args: ParsedArgs, resolved: ResolvedCommandConfig): { client: ApiClient; notes: NotesApi } {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  return { client, notes: new NotesApi(client) };
}

export const handleNotesList = commandHandler(async (args, runtime, resolved) => {
  requireFlagValue(args, "limit", "50");
  requireFlagValue(args, "after", "CURSOR");
  const state: NoteState = flagBool(args.flags, "all") ? "all" : flagBool(args.flags, "resolved") ? "resolved" : "open";
  const about = flagString(args.flags, "about");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.list({
    // Open is the server's default.
    ...(state === "open" ? {} : { state }),
    aboutId: about === undefined ? undefined : parseNoteAbout(about).id,
    authorId: flagString(args.flags, "author"),
    after: flagString(args.flags, "after"),
    limit: flagString(args.flags, "limit"),
  });
  const list = (response.body ?? {}) as NoteList;
  const review = reviewWarning(list);
  return {
    envelope: jsonBody(response, client.requestId, undefined, review ? [review] : []),
    exitCode: ExitCode.Success,
    human: noteListLines(list, runtime.now(), state).join("\n"),
  };
});

export const handleNotesShow = commandHandler(async (args, runtime, resolved) => {
  const id = noteId(args.positionals[2], "show");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.show(id);
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: noteDetailLines(response.body as Note, runtime.now()).join("\n") };
});

export const handleNotesAdd = commandHandler(async (args, runtime, resolved) => {
  const text = args.positionals[2];
  const file = flagString(args.flags, "file");
  if ((text === undefined) === (file === undefined)) {
    throw usageError("notes add takes the note as TEXT, - for stdin, or --file FILE; supply exactly one.");
  }
  const source = file ?? (text === "-" ? "-" : undefined);
  const body = noteBody(source === undefined ? text! : await readAuthoringText(source, runtime, NOTE_INPUT_MAX_BYTES));
  const about = flagString(args.flags, "about");
  const ttl = flagString(args.flags, "ttl");
  const replaces = flagString(args.flags, "replaces");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.add({
    body,
    ...(about !== undefined ? { about: parseNoteAbout(about) } : {}),
    ...(ttl !== undefined ? { ttlSeconds: parseNoteTtl(ttl) } : {}),
    ...(replaces !== undefined ? { replaces } : {}),
  });
  const note = response.body as Note;
  const matched = matchedOpenNote(response);
  const message = matched
    ? `Matched open note ${note.id}; confirmed it.`
    : `Added note ${note.id}.${replaces ? ` ${replaces} is resolved as replaced.` : ""}`;
  return {
    envelope: jsonBody(response, client.requestId, undefined, matched ? [{ code: NOTE_MATCHED_OPEN, message }] : []),
    exitCode: ExitCode.Success,
    human: message,
  };
});

export const handleNotesConfirm = commandHandler(async (args, runtime, resolved) => {
  const id = noteId(args.positionals[2], "confirm");
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.confirm(id);
  const reviewAt = (response.body as Note | undefined)?.review_at;
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Confirmed ${id}.${reviewAt ? ` Next review ${reviewAt}.` : ""}` };
});

export const handleNotesResolve = commandHandler(async (args, runtime, resolved) => {
  const id = noteId(args.positionals[2], "resolve");
  const reason = noteReason(args.positionals.slice(3).join(" "));
  const { client, notes } = notesFor(runtime, args, resolved);
  const response = await notes.resolve(id, reason);
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: `Resolved ${id}.` };
});

async function operationsGet(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError("operations show requires an id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const operation = await client.getOperation(id);
  return {
    envelope: successEnvelope(operation, { request_id: client.requestId, operation_id: operation.id }),
    exitCode: ExitCode.Success,
    human: humanLines("Operation", [
      ["id", operation.id],
      ["state", operation.state],
      ["kind", operation.kind],
      ["request_id", operation.request_id ?? client.requestId],
    ]),
  };
}

async function operationsWait(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError("operations wait requires an id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const operation = await client.waitForOperation(id, {
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: flagNumber(args.flags, "poll-ms") ?? 1000,
    sleep: runtime.sleep,
  });
  return {
    envelope: successEnvelope(operation, { request_id: client.requestId, operation_id: operation.id }),
    exitCode: ExitCode.Success,
    human: humanLines("Operation complete", [
      ["id", operation.id],
      ["state", operation.state],
    ]),
  };
}

async function operationsCancel(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  const id = args.positionals[2];
  if (!id) throw usageError("operations cancel requires an id.");
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "POST", path: `/api/operations/${id}/cancel`, idempotent: true });
  const operation = response.body as Operation;
  return {
    envelope: successEnvelope(operation, { request_id: client.requestId, operation_id: operation.id }),
    exitCode: ExitCode.Success,
    human: humanLines("Operation cancelled", [["id", operation.id], ["state", operation.state]]),
  };
}

const CANNED_EVENT_MESSAGES = new Set([
  "Application emitted an event",
  "Runtime reported a bounded condition",
  "Player reported runtime status",
  "Screen screenshot requested",
  "Screen screenshot ready",
  "Screen screenshot failed",
  "Screenshot requested",
  "Screenshot ready",
  "Screenshot failed",
  "Stream cursor advanced",
  "Stream replay state is no longer retained",
  "Screen came online",
  "Screen went offline",
  "Screen effective playlist switched",
  "Screen takeover started",
  "Screen takeover ended",
  "A scheduled playlist cannot be shown; its entries were skipped",
  "Screen health changed",
  "Screen reboot requested",
  // screen.suspended carries the notice as details.message, so its own message must not repeat the key.
  "Screen suspended",
  "Screen resumed",
  "Screen replaced by another device",
  "Screen display override set",
  "Screen display schedule updated",
  "Screen display schedule cleared",
]);

/**
 * Effective-playlist events carry null for "no playlist" (playlist_switched)
 * and "until cleared" (takeover_started); render it as none rather than
 * dropping the field.
 */
const NULL_AS_NONE_EVENT_TYPES = new Set(["screen.display_changed", "screen.playlist_switched", "screen.takeover_started", "screen.takeover_ended", "screen.playlist_unavailable"]);

const SILENT_EVENT_TYPES = new Set(["application.event", "runtime.reported"]);

function isEventScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function formatLogfmtValue(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  if (!/[\s="]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

function pushLogfmtField(parts: string[], key: string, value: unknown): boolean {
  if (!isEventScalar(value)) return false;
  if (isSensitiveKey(key)) return false;
  if (typeof value === "string") {
    if (value.length === 0 || isSensitiveValue(value)) return false;
  }
  parts.push(`${key}=${formatLogfmtValue(value)}`);
  return true;
}

/** One logfmt line per event. Undefined when there is nothing to print. */
export function formatEventLine(event: ProjectEvent): string | undefined {
  const parts: string[] = [];
  const hasAt = pushLogfmtField(parts, "at", event.at);
  const hasType = pushLogfmtField(parts, "type", event.type);
  pushLogfmtField(parts, "severity", event.severity);

  let payload = 0;
  const resource = event.resource;
  if (resource) {
    if (pushLogfmtField(parts, "resource_type", resource.type)) payload += 1;
    if (pushLogfmtField(parts, "resource_id", resource.id)) payload += 1;
  }

  const details = event.details ?? {};
  const used = new Set<string>();
  for (const key of ["code", "primitive_id"]) {
    if (!pushLogfmtField(parts, key, details[key])) continue;
    used.add(key);
    payload += 1;
  }
  if (event.type === "screen.health_changed") {
    // changes[] is a list of objects; print it as one compact value.
    const changes = healthChangesText(details.changes);
    if (changes && pushLogfmtField(parts, "changes", changes)) payload += 1;
    used.add("changes");
  }
  const nullAsNone = NULL_AS_NONE_EVENT_TYPES.has(event.type);
  for (const key of Object.keys(details).sort()) {
    if (used.has(key)) continue;
    const raw = details[key];
    // entry_ids and similar short id lists print comma-joined.
    const value = nullAsNone && raw === null ? "none"
      : nullAsNone && Array.isArray(raw) && raw.length > 0 && raw.every((item) => typeof item === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(item)) ? raw.join(",")
      : raw;
    if (pushLogfmtField(parts, key, value)) payload += 1;
  }

  const message = event.message ?? "";
  const detailCode = details.code;
  const canned = CANNED_EVENT_MESSAGES.has(message);
  const duplicate = message === event.type || (typeof detailCode === "string" && message === detailCode);
  if (message && !canned && !duplicate && pushLogfmtField(parts, "message", message)) {
    payload += 1;
  }

  if (!hasAt && !hasType) return undefined;
  if (SILENT_EVENT_TYPES.has(event.type) && payload === 0) return undefined;
  return parts.join(" ");
}

function formatEventLines(events: ProjectEvent[]): string {
  return events
    .map((event) => formatEventLine(event))
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

const EVENT_APPLICATION_ID = /^(?:(?:stage|qa|development)_)?app_[A-Za-z0-9_-]+$/;

/**
 * events list resource filters. The project event source takes screen, playlist
 * and application ids; the Player log (--source log) belongs to a screen only.
 * Shapes are checked here with the same id patterns the backend enforces, so a
 * wrong kind of id fails before a request.
 */
function eventsListFilters(args: ParsedArgs): { source?: string; screen_id?: string; playlist_id?: string; application_id?: string } {
  requireFlagValue(args, "source", "log");
  requireFlagValue(args, "screen-id", "scr_01");
  requireFlagValue(args, "playlist-id", "pl_01");
  requireFlagValue(args, "application-id", "app_01");
  const source = flagString(args.flags, "source");
  const screenId = flagString(args.flags, "screen-id");
  const playlistId = flagString(args.flags, "playlist-id");
  const applicationId = flagString(args.flags, "application-id");
  if (source !== undefined && source !== "project" && source !== "log") throw usageError("--source must be project or log.");
  if (screenId !== undefined && !isResourceID(screenId, "screen")) throw usageError("--screen-id must be a screen identifier (scr_...).");
  if (playlistId !== undefined && !isResourceID(playlistId, "playlist")) throw usageError("--playlist-id must be a playlist identifier (pl_...).");
  if (applicationId !== undefined && !EVENT_APPLICATION_ID.test(applicationId)) throw usageError("--app-id must be an application identifier (app_...).");
  if (source === "log" && (playlistId !== undefined || applicationId !== undefined)) {
    const flag = playlistId !== undefined ? "--playlist-id" : "--app-id";
    throw usageError(`${flag} reads project events, and the Player log (--source log) holds screen records only. Drop --source log to read the project events of ${playlistId !== undefined ? "a playlist" : "an application"}, or use --screen-id to read one screen's Player log.`);
  }
  return {
    ...(source === undefined ? {} : { source }),
    ...(screenId === undefined ? {} : { screen_id: screenId }),
    ...(playlistId === undefined ? {} : { playlist_id: playlistId }),
    ...(applicationId === undefined ? {} : { application_id: applicationId }),
  };
}

async function eventsList(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  // `--limit` is forwarded verbatim: the server owns the 1..200 bound and
  // answers 400 invalid_request with errors[].field = "limit", which the
  // envelope surfaces. A null next_cursor is the end of the history, not an error.
  requireFlagValue(args, "limit", "50");
  requireFlagValue(args, "after", "ev1_0");
  const filters = eventsListFilters(args);
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({
    method: "GET",
    path: "/api/events",
    query: {
      after: flagString(args.flags, "after") ?? flagString(args.flags, "cursor"),
      limit: flagString(args.flags, "limit"),
      type: flagString(args.flags, "type"),
      ...filters,
    },
  });
  const page = response.body as EventPage;
  const items = page.items ?? [];
  const human = formatEventLines(items);
  const safePage = redactEvent({ ...page, items });
  return {
    envelope: jsonBody({ ...response, body: safePage }, client.requestId),
    exitCode: ExitCode.Success,
    human,
  };
}

/** First reconnect wait after a disconnect. Tests inject `runtime.sleep`. */
export const EVENT_STREAM_BACKOFF_MS = 250;
export const EVENT_STREAM_BACKOFF_CAP_MS = 15_000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** 401/403/404 and other non-transient 4xx. 408/429/5xx/network retry. */
function isHardFollowError(err: unknown): boolean {
  if (!(err instanceof CliError)) {
    return false;
  }
  if (err.problem.code === "transport_error") {
    return false;
  }
  const status = err.problem.status;
  if (status === 408 || status === 429 || status >= 500 || status < 400) {
    return false;
  }
  return true;
}

async function sleepWhileOpen(
  ms: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * `events follow --type`: the project stream takes no type filter, so the CLI
 * filters what it prints. An exact type, or a family prefix ending in a dot.
 * stream.* frames describe the stream itself and always pass.
 */
export function eventTypeMatches(type: unknown, filter: string | undefined): boolean {
  if (!filter) return true;
  if (typeof type !== "string") return false;
  if (type.startsWith("stream.")) return true;
  return filter.endsWith(".") ? type.startsWith(filter) : type === filter;
}

async function eventsFollow(args: ParsedArgs, runtime: CliRuntime, resolved: Awaited<ReturnType<typeof resolveConfig>>): Promise<CommandResult> {
  let token = requireToken(resolved.token);
  const typeFilter = flagString(args.flags, "type");
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const transport = transportFor(runtime, resolved.apiUrl, token);
  const json = !flagBool(args.flags, "human");
  let printed = 0;
  let after = flagString(args.flags, "after") ?? flagString(args.flags, "cursor");
  let delayMs = EVENT_STREAM_BACKOFF_MS;
  const controller = new AbortController();
  const timeoutMs = flagNumber(args.flags, "timeout");
  const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const emit = (event: ProjectEvent): void => {
    if (!eventTypeMatches(event?.type, typeFilter)) return;
    if (json) {
      printed += 1;
      runtime.stdout.write(`${JSON.stringify(streamEnvelope(runtime, redactEvent(event), client.requestId))}\n`);
      return;
    }
    const line = formatEventLine(event);
    if (!line) return;
    if (printed === 0) {
      if (formatResultContext(runtime)) runtime.stdout.write(`${formatResultContext(runtime)}\n`);
    }
    printed += 1;
    runtime.stdout.write(`${line}\n`);
  };
  try {
    while (!controller.signal.aborted) {
      let buffer = "";
      let connected = false;
      try {
        token = await streamToken(runtime, token);
        const stream = await transport.stream({
          method: "GET",
          path: "/stream/project",
          query: { after, ...projectStreamQuery(resolved.projectId) },
          headers: { "x-request-id": client.nextRequestId(), authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        connected = true;
        for await (const chunk of stream) {
          buffer += chunk;
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          for (const event of parsed.events) {
            if (event.id) {
              after = event.id;
            }
            if (!event.data) continue;
            try {
              emit(JSON.parse(event.data) as ProjectEvent);
            } catch {
              // Unstructured frames are not event data.
            }
          }
          if (controller.signal.aborted) {
            break;
          }
        }
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          break;
        }
        if (isHardFollowError(err)) {
          throw err;
        }
      }
      if (controller.signal.aborted) {
        break;
      }
      await sleepWhileOpen(delayMs, controller.signal, runtime.sleep);
      if (controller.signal.aborted) {
        break;
      }
      delayMs = connected
        ? EVENT_STREAM_BACKOFF_MS
        : Math.min(delayMs * 2, EVENT_STREAM_BACKOFF_CAP_MS);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (printed === 0 && json) {
    runtime.stdout.write(`${JSON.stringify(streamEnvelope(runtime, { items: [] }, client.requestId))}\n`);
  }
  return {
    envelope: successEnvelope({ items: [] }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: "",
    output: "stream",
  };
}

/**
 * `pass` is present and usable and `fail` is a defect the operator has to fix.
 * `warn` is an optional piece or degraded server dependency, reported without
 * moving the exit code: a host that is missing nothing required exits 0.
 */
type DoctorStatus = "pass" | "warn" | "fail";

interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  path?: "first_run_enroll" | "reconnect_existing";
  /** The command that clears a `warn` or `fail` row, when one exists. */
  next?: ProblemNext;
}

/**
 * A fresh install has no credential and nothing is broken, so the `token` row
 * warns and names the enrollment or connection command instead of failing.
 * `fail` is reserved for damage the operator must repair: bad permissions,
 * a missing toolchain piece a supported command needs, or an unreachable
 * control plane.
 */
function credentialCheck(resolved: Awaited<ReturnType<typeof resolveConfig>>): DoctorCheck {
  if (hasToken(resolved.token)) {
    return { name: "token", status: "pass", detail: describeTokenPresence(resolved.token) };
  }
  const detail = describeTokenPresence(resolved.token);
  if (resolved.signedOut) {
    return {
      name: "token",
      status: "warn",
      detail: `${detail}; this installation is signed out`,
      path: "reconnect_existing",
      next: { command: "screenrig login", reason: "Sign this installation in again; a person approves it in the dashboard." },
    };
  }
  if (resolved.retiredCredential) {
    return {
      name: "token",
      status: "warn",
      detail: `${detail}; the stored credential is no longer accepted`,
      path: "reconnect_existing",
      next: { command: "screenrig login", reason: "Sign this installation in; a person approves it in the dashboard. Then rerun doctor." },
    };
  }
  if (resolved.lastAgent) {
    return {
      name: "token",
      status: "warn",
      detail: `${detail}; this installation was disconnected`,
      path: "first_run_enroll",
      next: {
        command: "screenrig agent enroll --email ADDRESS --organization NAME",
        reason: "Ask the user for their contact email, enroll a new project agent, then rerun doctor. Use screenrig login only when the user asked to join an existing project.",
      },
    };
  }
  return {
    name: "token",
    status: "warn",
    detail: `${detail}; this installation is not enrolled`,
    path: "first_run_enroll",
    next: {
      command: resolved.enrollment ? "screenrig agent enroll" : "screenrig agent enroll --email ADDRESS --organization NAME",
      reason: resolved.enrollment
        ? "Resume the exact pending enrollment, then rerun doctor."
        : "Create the first agent with unverified contact metadata, then rerun doctor. Every authenticated command fails with not_enrolled until then.",
    },
  };
}

/** The session's last possible day: the refresh family ends at the idle or absolute expiry, whichever comes first. */
function signInCheck(grant: NonNullable<ScreenRigConfig["oauth"]>, now: Date): DoctorCheck {
  const ends = grant.refresh_expires_at ? new Date(grant.refresh_expires_at * 1000).toISOString() : undefined;
  const days = refreshExpiryDays(grant, now);
  if (days === undefined) {
    return { name: "sign_in", status: "pass", detail: ends ? `session ends by ${ends}; each use moves the idle end forward` : "session present" };
  }
  return {
    name: "sign_in",
    status: "warn",
    detail: `session ends ${ends} (${days} days)`,
    next: { command: "screenrig login", reason: "Sign in again before the session ends; a person approves it in the dashboard." },
  };
}

/** Warnings 30 and 7 days before the session ends: an installation that only enrolled cannot sign in unattended. */
function signInExpiryWarning(grant: ScreenRigConfig["oauth"], now: Date): Warning | undefined {
  const days = refreshExpiryDays(grant, now);
  if (days === undefined) return undefined;
  return {
    code: "sign_in_expiring",
    message: `This installation's session ends in ${days} day${days === 1 ? "" : "s"}. Run screenrig login before then; a person approves it in the dashboard.`,
  };
}

function probeFailureDetail(err: unknown, fallback: string): string {
  if (err instanceof CliError) {
    return err.problem.detail;
  }
  return err instanceof Error ? redactText(err.message) : fallback;
}

async function doctor(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const checks: DoctorCheck[] = [];
  const distribution = cliDistribution();
  checks.push({ name: "distribution", status: "pass", detail: `${distribution.kind}; ${distribution.agent_setup}` });
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    status: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 11) ? "pass" : "fail",
    detail: `node ${process.versions.node}`,
  });
  checks.push({
    name: "config_path",
    status: "pass",
    detail: resolved.configPath,
  });
  try {
    const st = await runtime.fs.stat(resolved.configPath);
    const mode = st.mode & 0o777;
    const ok = (mode & 0o077) === 0;
    checks.push({
      name: "config_permissions",
      status: ok ? "pass" : "fail",
      detail: `mode ${mode.toString(8)}`,
    });
  } catch {
    checks.push({ name: "config_permissions", status: "pass", detail: "config file not present" });
  }
  checks.push(credentialCheck(resolved));
  const grant = (await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }).catch(() => undefined))?.oauth;
  if (grant) checks.push(signInCheck(grant, runtime.now()));
  checks.push({
    name: "api_url",
    status: resolved.apiUrl.startsWith("https://") || resolved.apiUrl.startsWith("http://127.") || resolved.apiUrl.includes("localhost") ? "pass" : "fail",
    detail: resolved.apiUrl,
  });
  checks.push({
    name: "log_socket",
    status: "pass",
    detail: resolved.logSocket ?? "(none)",
  });
  const lookup = ffmpegLookup(runtime.env);
  const webpLookup = cwebpLookup(runtime.env);
  let toolchain: FfmpegToolchain | undefined;
  let toolchainDetail: string | undefined;
  try {
    toolchain = await resolveFfmpegToolchain(runtime);
  } catch (err) {
    toolchainDetail = probeFailureDetail(err, "ffmpeg probe failed");
  }
  let cwebp: CwebpToolchain | undefined;
  let cwebpDetail: string | undefined;
  try {
    cwebp = await resolveCwebpToolchain(runtime);
  } catch (err) {
    cwebpDetail = probeFailureDetail(err, "cwebp probe failed");
  }
  // WebP stills have two independent encoders: ffmpeg's libwebp, and the
  // `cwebp` binary the image planner falls back to. Neither is required on its
  // own, so each is a warning while the other is usable, and the pair fails
  // only when the CLI has no way to produce WebP at all. `undefined` means the
  // ffmpeg probe never answered, which the ffmpeg check already reports.
  const libwebp = toolchain?.encoders.has("libwebp");
  const webpEncodable = libwebp === true || cwebp !== undefined;

  if (toolchain) {
    checks.push({
      name: "ffmpeg",
      status: "pass",
      detail: `${toolchain.ffmpeg} ${toolchain.ffmpegVersion}${lookup.ffmpegFromEnv ? " (SCREENRIG_FFMPEG)" : ""}`,
    });
    checks.push({
      name: "ffprobe",
      status: "pass",
      detail: `${toolchain.ffprobe} ${toolchain.ffprobeVersion}${lookup.ffprobeFromEnv ? " (SCREENRIG_FFPROBE)" : ""}`,
    });
    const encoders = toolchain.encoders;
    checks.push({
      name: "encoder_libx264",
      status: encoders.has("libx264") ? "pass" : "fail",
      detail: encoders.has("libx264")
        ? "libx264 available"
        : "libx264 missing from this ffmpeg build; the default video profile cannot encode",
    });
    checks.push({
      name: "encoder_libx265",
      status: encoders.has("libx265") ? "pass" : "warn",
      detail: encoders.has("libx265")
        ? "libx265 available"
        : "libx265 missing from this ffmpeg build; --codec hevc is unavailable",
    });
    checks.push({
      name: "encoder_libwebp",
      status: encoders.has("libwebp") ? "pass" : webpEncodable ? "warn" : "fail",
      detail: encoders.has("libwebp")
        ? "libwebp available"
        : "libwebp missing from this ffmpeg build; animation cannot be encoded",
    });
    const tonemap = toolchain.filters.has("zscale") && toolchain.filters.has("tonemap");
    checks.push({
      name: "filter_hdr_tonemap",
      status: tonemap ? "pass" : "warn",
      detail: tonemap
        ? "zscale and tonemap available"
        : "zscale or tonemap missing; HDR sources convert without tone mapping",
    });
  } else {
    checks.push({ name: "ffmpeg", status: "fail", detail: toolchainDetail ?? "ffmpeg probe failed" });
  }

  if (cwebp) {
    checks.push({
      name: "cwebp",
      status: "pass",
      detail: `${cwebp.cwebp} ${cwebp.version}${cwebp.fromEnv ? " (SCREENRIG_CWEBP)" : ""}`,
    });
  } else {
    const missing =
      cwebpDetail ?? `${webpLookup.cwebp} not available${webpLookup.cwebpFromEnv ? " (SCREENRIG_CWEBP)" : ""}`;
    if (libwebp === true) {
      checks.push({
        name: "cwebp",
        status: "warn",
        detail: `${missing}; not required because this ffmpeg build has the libwebp encoder`,
      });
    } else if (libwebp === false) {
      checks.push({
        name: "cwebp",
        status: "fail",
        detail:
          `${missing}; this ffmpeg build has no libwebp encoder either, so image transcode cannot produce WebP. ` +
          "Install an ffmpeg built with libwebp, or install cwebp on PATH (or set SCREENRIG_CWEBP).",
      });
    } else {
      checks.push({
        name: "cwebp",
        status: "warn",
        detail: `${missing}; it is the fallback for an ffmpeg build without libwebp, so fix ffmpeg first`,
      });
    }
  }

  const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  for (const route of ["/.health", "/.ready", "/.version", "/api/capabilities"] as const) {
    try {
      const response = await client.call({ method: "GET", path: route });
      const name = route === "/api/capabilities" ? "capabilities" : route.slice(2);
      const body = response.body;
      const degraded = route === "/.ready" && body !== null && typeof body === "object"
        && "degraded" in body && Array.isArray(body.degraded) ? body.degraded : [];
      const degradedDetail = route === "/.ready" && body !== null && typeof body === "object"
        && "degraded_detail" in body && body.degraded_detail !== null && typeof body.degraded_detail === "object"
        && !Array.isArray(body.degraded_detail)
        ? (body.degraded_detail as Record<string, unknown>)
        : {};
      const guidance = [...new Set(degraded.map((dependency): string => {
        // The server's degraded_detail sentence is written for a client to show
        // verbatim (for example why app upload will answer 503). Prefer it, bounded
        // and redacted, over the local fallback text.
        const sentence = typeof dependency === "string" ? degradedDetail[dependency] : undefined;
        if (typeof sentence === "string" && sentence.trim().length > 0) {
          return `${dependency}: ${redactedReadinessSentence(sentence)}`;
        }
        switch (dependency) {
          case "application_processing":
            return "application_processing: new applications cannot become ready; ask the service operator to restore application workers, then rerun doctor";
          case "valkey":
            return "valkey: ask the service operator to restore Valkey connectivity, then rerun doctor";
          default:
            // Probe names are server input; do not echo arbitrary values into diagnostics.
            return "another optional dependency is unavailable; ask the service operator to inspect readiness diagnostics, then rerun doctor";
        }
      }))];
      checks.push({
        name,
        status: degraded.length > 0 ? "warn" : "pass",
        detail: `status ${response.status}${guidance.length > 0 ? `; service ready with degraded dependencies. ${guidance.join(". ")}` : ""}`,
      });
      if (route === "/api/capabilities") {
        // Probe feedback support from the advertised feature map rather than
        // assuming the routes exist on every deployment.
        const features = ((response.body ?? {}) as Capabilities).features ?? {};
        const supported = features.feedback === true;
        checks.push({
          name: "feedback",
          // An optional server feature, so its absence is not a local defect.
          status: supported ? "pass" : "warn",
          detail: supported
            ? "server advertises feedback support"
            : "server does not advertise feedback support; feedback commands are unavailable",
        });
      }
    } catch (err) {
      const name = route === "/api/capabilities" ? "capabilities" : route.slice(2);
      // An uploader works only in its playlists and folders: that answer is the credential doing its job.
      if (err instanceof CliError && err.problem.code === "outside_upload_scope") {
        checks.push({ name, status: "pass", detail: "uploader: these playlists and folders" });
        continue;
      }
      const detail = err instanceof CliError ? err.problem.detail : err instanceof Error ? err.message : `${route} failed`;
      checks.push({ name, status: "fail", detail });
    }
  }
  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  const status: DoctorStatus = failed ? "fail" : warned ? "warn" : "pass";
  // `data.next` is the one command that clears the worst row that has one.
  const next = checks.find((check) => check.status === "fail" && check.next)?.next
    ?? checks.find((check) => check.status === "warn" && check.next)?.next;
  return {
    envelope: successEnvelope({ status, checks, version: CLI_VERSION, distribution, ...(next ? { next } : {}) }),
    exitCode: failed ? ExitCode.Unexpected : ExitCode.Success,
    human: checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}${check.next ? `\n  next: ${check.next.command}` : ""}`).join("\n"),
  };
}

export type { Operation };

function sanitizedPreparationApiUrl(value: string): string {
  const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.toString().replace(/\/$/, "");
}

const PLAYLIST_INIT_UPLOAD_CONCURRENCY = 4;

export const handlePlaylistInit = commandHandler(async (args, runtime, resolved) => {
  let existingClient: ApiClient | undefined;
  let preparedClient: Promise<ApiClient> | undefined;
  const remote = () => preparedClient ??= (async () => {
    // Purely local preparation remains offline. Once this invocation reads
    // a screen/media or uploads a file, bind a config without cached project
    // names to its authenticated project before performing that remote work.
    requireToken(resolved.token);
    resolved = await resolveProjectContext(args, runtime, resolved);
    return existingClient = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  })();
  const screenId = flagString(args.flags, "screen");
  const width = flagNumber(args.flags, "target-width"), height = flagNumber(args.flags, "target-height");
  const screen = screenId ? (await (await remote()).call({ method: "GET", path: `/api/screens/${encodeURIComponent(screenId)}` })).body : undefined;
  const dimensions = targetDimensions(screen, width, height);
  const target = screen as { id: string; revision: number } | undefined;
  if (screenId && (!target || target.id !== screenId || !Number.isSafeInteger(target.revision) || target.revision < 1)) {
    throw usageError("Screen response has invalid identity or revision.");
  }
  const content: Record<string, any>[] = [];
  const files = new Map<number, string>();
  const warnings: Warning[] = [];
  for (const input of args.positionals.slice(2)) {
    if (RESOURCE_ID_PATTERNS.media.test(input)) {
      const record = (await (await remote()).call({ method: "GET", path: `/api/media/${input}` })).body as Record<string, any>;
      if (record?.id !== input) throw usageError("Media response identity did not match.");
      content.push(record);
    } else if (RESOURCE_ID_PATTERNS.release.test(input)) {
      content.push({ primitive: "application", release_id: input });
    } else if (iframeSnippetSource(input) !== undefined || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
      // A pasted <iframe> embed code gives its src; the server rebuilds a
      // Google or Microsoft document link when the playlist is written.
      let url: URL;
      try { url = new URL(iframeSnippetSource(input) ?? input); } catch { throw usageError("Provide a valid http or https iframe URL or embed code."); }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) throw usageError("Iframe URLs must use http or https.");
      content.push({ primitive: "iframe", src: url.href, title: url.hostname.slice(0, 200) });
    } else {
      const sourcePath = path.resolve(runtime.cwd(), input);
      try { if (!(await stat(sourcePath)).isFile()) throw new Error(); }
      catch { throw usageError("Each input must be a readable image/video/audio file, media ID, release ID, http(s) URL, or iframe embed code."); }
      files.set(content.length, sourcePath);
      // Audio files become soundtrack tracks, not pages, so the preflight
      // shape check must see them as audio before anything uploads.
      const audioFile = /\.(mp3|wav|wave|aac|m4a|m4b|ogg|oga|opus|flac|aif|aiff|wma)$/i.test(sourcePath);
      content.push({ primitive: audioFile ? "audio" : "image", state: "ready", id: "med_PENDING" });
    }
  }
  const options = { name: flagString(args.flags, "name")!, content, ...dimensions, durationMs: flagNumber(args.flags, "duration-ms"), fit: flagString(args.flags, "fit") ?? "contain" };
  // Validate the entire authoring shape and check the output before uploading.
  const validated = preparePlaylist(options);
  const shortApplication = shortApplicationPageWarning(validated);
  if (shortApplication) warnings.push(shortApplication);
  const output = path.resolve(runtime.cwd(), flagString(args.flags, "output")!);
  const overwrite = flagBool(args.flags, "overwrite");
  await assertOutputAvailable(output, overwrite);
  // Upload a few files at once; each one's content slot keeps page order.
  const queue = [...files];
  const uploads: { index: number; media_id: string; reused: boolean; timing: MediaUploadTiming }[] = [];
  const uploadNext = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [index, sourcePath] = next;
      // Scope each occurrence to the invocation key, including repeated files.
      // An identical retry with --idempotency-key reproduces both declare and commit keys.
      const idempotencyKey = createHash("sha256")
        .update(JSON.stringify(["screenrig.playlist.init.upload", (await remote()).idempotencyKey, index]))
        .digest("base64url");
      const client = await remote();
      const uploaded = await loggerOf(runtime).withLocal({ op: "media.upload", message: "media upload" }, () => uploadMediaFile({ runtime, client, sourcePath, idempotencyKey,
        transcodeOptions: transcodeOptionsFromArgs(args), noTranscode: flagBool(args.flags, "no-transcode"),
        reporter: progressReporterFor(args, runtime), noWait: false, resumable: flagString(args.flags, "idempotency-key") !== undefined,
        timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000, pollMs: flagNumber(args.flags, "poll-ms") ?? 1000 }));
      warnings.push(...uploaded.warnings);
      if (!uploaded.mediaId) throw usageError("Upload completed without a media identifier.");
      const record = (await (await remote()).call({ method: "GET", path: `/api/media/${encodeURIComponent(uploaded.mediaId)}` })).body as Record<string, any>;
      if (record?.id !== uploaded.mediaId) throw usageError("Media response identity did not match.");
      content[index] = record;
      uploads.push({ index, media_id: uploaded.mediaId, reused: uploaded.reused, timing: uploaded.timing });
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(PLAYLIST_INIT_UPLOAD_CONCURRENCY, files.size) }, () =>
    uploadNext().catch((error) => { queue.length = 0; throw error; })));
  const failure = workers.find((worker) => worker.status === "rejected");
  if (failure) throw failure.reason;
  await writeOutputFile(output, JSON.stringify(preparePlaylist(options), null, 2) + "\n", overwrite);
  const context = ["--config", resolved.configPath, "--api-url", sanitizedPreparationApiUrl(resolved.apiUrl)];
  const trackCount = content.filter((item) => item.primitive === "audio").length;
  // The resolved pins in input order, so a caller asserts what the document
  // holds instead of rereading the file.
  const releaseIds = content.filter((item) => item.primitive === "application").map((item) => String(item.release_id));
  const mediaIds = content.filter((item) => typeof item.id === "string" && RESOURCE_ID_PATTERNS.media.test(item.id)).map((item) => String(item.id));
  return { envelope: successEnvelope({ output, ...dimensions, page_count: content.length - trackCount, ...(trackCount > 0 ? { soundtrack_tracks: trackCount } : {}),
    ...(releaseIds.length > 0 ? { release_ids: releaseIds } : {}), ...(mediaIds.length > 0 ? { media_ids: mediaIds } : {}),
    ...(uploads.length > 0 ? { uploads: uploads.sort((a, b) => a.index - b.index).map(({ index, ...upload }) => ({ source: args.positionals[2 + index], ...upload })) } : {}),
    ...(target ? { screen_id: target.id, screen_revision: target.revision } : {}),
    ...(target ? { publish: { argv: ["screen", "publish", target.id, output, ...context], reason: "Inspect the prepared document before publishing." } } : {}),
  }, { request_id: existingClient?.requestId, warnings }), exitCode: ExitCode.Success, human: `Playlist prepared at ${output}` };
}, false);

export const handleScreenPublish = commandHandler(async (args, runtime, resolved) => {
  const parsed = await readAuthoringJson(args.positionals[3]!, runtime);
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.pages)) assertWirePages(parsed.pages);
  const document = parsed;
  assertPlaylistValid(document);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const json = !flagBool(args.flags, "human");
  const progress = flagBool(args.flags, "no-progress") ? undefined : (stage: string, state?: string) =>
    runtime.stderr.write(json ? `${JSON.stringify({ event: "publish_stage", stage, ...(state ? { state } : {}) })}\n` : `screenrig: ${stage}${state ? ` (${state})` : ""}\n`);
  const shortApplication = shortApplicationPageWarning(document);
  const result = await publishScreen({ client, runtime, configPath: resolved.configPath, apiUrl: resolved.apiUrl, screenId: args.positionals[2]!, revision: flagString(args.flags, "if-match")!, document, requestedKey: flagString(args.flags, "idempotency-key"),
    note: flagString(args.flags, "note"),
    wait: flagBool(args.flags, "no-wait") ? undefined : { timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000, pollMs: flagNumber(args.flags, "poll-ms") ?? 2000 },
    progress });
  if (result.stage === "pending_review") {
    // The playlist review decides the content (approving it can approve the
    // assignment too), so it is the one to check first.
    const first = result.reviews.find((review) => review.kind === "playlist_change") ?? result.reviews[0]!;
    const { warnings: raw, ...pendingData } = result;
    const framing = playlistWarnings(raw, result.playlist_id, true);
    return {
      envelope: successEnvelope({ ...pendingData, next: reviewNext(first.id) }, { request_id: client.requestId, warnings: [...(shortApplication ? [shortApplication] : []), ...result.reviews.map(pendingReviewWarning), ...framing] }),
      exitCode: ExitCode.Success,
      human: [
        "Publish waiting for review",
        `playlist_id: ${result.playlist_id}`,
        `screen_id: ${result.screen_id}`,
        ...result.reviews.map((review) => `review: ${review.id} ${review.kind} ${review.state} ${review.url}`),
        `next: screenrig reviews show ${first.id}`,
        PENDING_REVIEW_SENTENCE,
        ...framing.map((item) => `warning: ${item.message}`),
      ].join("\n"),
    };
  }
  const warning = publishPlaybackWarning(result);
  // playback_verified stays what the Player reported; a page the Player web app
  // cannot frame is reported beside it, in the same result.
  const { warnings: raw, ...data } = result;
  const framing = playlistWarnings(raw, result.playlist_id);
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings: [...(shortApplication ? [shortApplication] : []), ...(warning ? [warning] : []), ...framing] }),
    exitCode: ExitCode.Success,
    human: humanLines(`${result.playback_verified ? "Published and playing" : "Published and assigned"}${hasFramingRefusal(framing) ? "; see the framing warning" : ""}`, [
      ["playlist_id", result.playlist_id],
      ["screen_id", result.screen_id],
      ["stage", result.stage],
      ["waited", `${result.playback.waited_ms} ms`],
      ...(warning ? [["warning", warning.message] as [string, string]] : []),
      ...(shortApplication ? [["warning", shortApplication.message] as [string, string]] : []),
      ...framing.map((item) => ["warning", item.message] as [string, string]),
    ]),
  };
});

/** Why a publish is not visibly playing yet, and what to do about it. */
function publishPlaybackWarning(result: Extract<Awaited<ReturnType<typeof publishScreen>>, { playback: unknown }>): Warning | undefined {
  const { playback, screen_id: screen } = result;
  if ((playback.reason === "playback_failed" || playback.reason === "playback_pending" || playback.playing)
    && isStorageFailureCode(playback.code)) {
    return storageFullWarning(screen, playback.state === "partial" ? "partial"
      : playback.code === "transition_blocked" ? "transition_blocked" : "none_fit");
  }
  const rerun = "Rerun the identical publish command to wait again; it does not create another playlist.";
  switch (playback.reason) {
    case "screen_offline":
      return { code: "screen_offline", message: `The screen is offline, so its Player has not picked up the playlist. It plays when the Player reconnects. ${rerun}` };
    case "playlist_not_effective":
      return { code: "playlist_not_effective", message: `A takeover, campaign or playlist schedule shows ${playback.effective_playlist_id} on this screen. The published playlist is its default and plays when that ends; screen show ${screen} reports effective_playlist, and campaign explain ${screen} says which campaigns apply.` };
    case "playback_failed":
      return { code: "playback_failed", message: `The Player could not switch to the playlist${playback.code ? ` (${playback.code})` : ""}. screen show ${screen} reports the reason; fix it, then screen reload ${screen}.` };
    case "playback_pending":
      return { code: "playback_pending", message: `The Player had not shown the playlist after ${Math.round(playback.waited_ms / 1000)} s (state ${playback.state ?? "unknown"}). Large videos take longer to download. ${rerun}` };
  }
  if (playback.playing && playback.state === "partial") {
    return { code: "playback_partial", message: `The Player is showing only part of the playlist. screen show ${screen} reports progress and screen storage-forecast ${screen} --playlist-id ${result.playlist_id} checks available storage.` };
  }
  return undefined;
}

// Customer webhooks: /api/webhooks. The signing secret is printed once in
// data.secret (create, rotate-secret) and never reaches config, logs, or the
// write-recovery ledger; an identical rerun after an ambiguous failure reuses
// the saved Idempotency-Key and the server replays the same secret for 24 h.
const WEBHOOKS_PATH = "/api/webhooks";

async function webhookCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw webhookProblem(error, id);
  }
}

function webhookRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "if-match");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

/**
 * A 2xx without a secret is a completed write: a replay of the same key would
 * return the same secretless answer, so clear the saved key and point at
 * rotate-secret instead of suggesting a rerun.
 */
async function webhookWithSecret(body: unknown, action: "create" | "rotate", runtime: CliRuntime): Promise<WebhookWithSecret> {
  const webhook = body as WebhookWithSecret | undefined;
  if (!webhook || typeof webhook.id !== "string" || typeof webhook.secret !== "string" || !webhook.secret) {
    await writeRecoveries.get(runtime)?.finish();
    const id = webhook && typeof webhook.id === "string" && WEBHOOK_ID_PATTERN.test(webhook.id) ? webhook.id : undefined;
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "webhook create" : "rotate-secret"} request completed, but its answer did not carry a signing secret. Do not rerun it.`, {
        next: id
          ? { command: `screenrig webhooks rotate-secret ${id}`, reason: "Issue a new signing secret; it is shown once in data.secret." }
          : { command: "screenrig webhooks list", reason: "Find the webhook, then run screenrig webhooks rotate-secret ID to receive a new signing secret." },
      }), ExitCode.Unexpected);
  }
  return webhook;
}

async function webhookSecretResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: "create" | "rotate", runtime: CliRuntime): Promise<CommandResult> {
  const webhook = await webhookWithSecret(response.body, action, runtime);
  const warning = webhookSecretWarning(webhook.id, action);
  return {
    envelope: jsonBody(response, client.requestId, undefined, [warning]),
    exitCode: ExitCode.Success,
    human: [
      action === "create" ? `Created webhook ${webhook.id}` : `Rotated the signing secret of webhook ${webhook.id}`,
      ...webhookLines(webhook),
      `secret: ${webhook.secret}`,
      `warning: ${warning.message}`,
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

export const handleWebhooksCreate = commandHandler(async (args, runtime, resolved) => {
  const url = webhookUrl(flagString(args.flags, "url") ?? "");
  const eventTypes = webhookEventTypes(flagString(args.flags, "event-types") ?? "");
  const description = flagString(args.flags, "description");
  const body: WebhookWrite = {
    url,
    event_types: eventTypes,
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "POST", path: WEBHOOKS_PATH, idempotent: true, body });
  return webhookSecretResult(response, client, "create", runtime);
});

export const handleWebhooksList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "GET", path: WEBHOOKS_PATH });
  const items = (response.body as WebhookList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Webhooks (${list.length})`, ...webhookTableLines(list)].join("\n"),
  };
});

export const handleWebhooksShow = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "GET", path: `${WEBHOOKS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Webhook", ...webhookLines(response.body as Webhook | undefined)].join("\n"),
  };
});

export const handleWebhooksUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "update");
  const url = flagString(args.flags, "url");
  const eventTypes = flagString(args.flags, "event-types");
  const description = flagString(args.flags, "description");
  const patch: WebhookPatch = {
    ...(url !== undefined ? { url: webhookUrl(url) } : {}),
    ...(eventTypes !== undefined ? { event_types: webhookEventTypes(eventTypes) } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
    ...(flagBool(args.flags, "clear-description") ? { description: "" } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("webhooks update requires at least one of --url, --event-types, --description, --clear-description, --enable, or --disable.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "PATCH", path: `${WEBHOOKS_PATH}/${id}`, idempotent: true, body: patch, headers: webhookRevisionHeaders(args),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated webhook ${id}`, ...webhookLines(response.body as Webhook | undefined)].join("\n"),
  };
});

export const handleWebhooksDelete = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "DELETE", path: `${WEBHOOKS_PATH}/${id}`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted webhook ${id}. Its pending deliveries fail with webhook_deleted.`,
  };
});

export const handleWebhooksRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "rotate-secret");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "POST", path: `${WEBHOOKS_PATH}/${id}/rotate-secret`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return webhookSecretResult(response, client, "rotate", runtime);
});

export const handleWebhooksTest = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, { method: "POST", path: `${WEBHOOKS_PATH}/${id}/test`, idempotent: true }, id);
  const delivery = response.body as WebhookDelivery | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(`Queued a test delivery to webhook ${id}`, [
      ["delivery_id", delivery?.id],
      ["event_type", delivery?.event_type],
      ["event_id", delivery?.event_id],
      ["state", delivery?.state],
      ["next", `screenrig webhooks deliveries ${id} --limit 1 shows its outcome; a test is attempted once, without retries.`],
    ]),
  };
});

export const handleWebhooksDeliveries = commandHandler(async (args, runtime, resolved) => {
  const id = webhookId(args.positionals[2], "deliveries");
  const before = flagString(args.flags, "before");
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await webhookCall(client, {
    method: "GET", path: `${WEBHOOKS_PATH}/${id}/deliveries`,
    query: {
      ...(before !== undefined ? { before: webhookDeliveryCursor(before) } : {}),
      ...(limit !== undefined ? { limit: webhookDeliveriesLimit(limit) } : {}),
    },
  }, id);
  const page = response.body as WebhookDeliveryList | undefined;
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" ? page.next_cursor : undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Webhook ${id} deliveries (${items.length})`,
      ...deliveryTableLines(items),
      ...(next ? [`next: screenrig webhooks deliveries ${id} --before ${next}${limit ? ` --limit ${limit}` : ""}`] : []),
    ].join("\n"),
  };
});

// Notifications: /api/notifications, email, webhook, Slack, Teams, PagerDuty
// and Telegram channels. A webhook's signing secret is printed once in
// data.secret (create, rotate-secret) and never reaches config, logs, or the
// write-recovery ledger, as for webhooks; the other channels have no secret. A
// chat or pager credential (destination) is only ever sent, never printed back:
// the notification shows a masked destination_hint. Every channel shares the
// 20-per-project limit and the revision guard (webhookRevisionHeaders).
const NOTIFICATIONS_PATH = "/api/notifications";

async function notificationCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw notificationProblem(error, id);
  }
}

/**
 * A 2xx without a secret is a completed write: a replay of the same key would
 * return the same secretless answer, so clear the saved key and point at
 * rotate-secret instead of suggesting a rerun.
 */
async function notificationWithSecret(body: unknown, action: "create" | "rotate", runtime: CliRuntime): Promise<NotificationWithSecret> {
  const notification = body as NotificationWithSecret | undefined;
  if (!notification || typeof notification.id !== "string" || typeof notification.secret !== "string" || !notification.secret) {
    await writeRecoveries.get(runtime)?.finish();
    const id = notification && typeof notification.id === "string" && NOTIFICATION_ID_PATTERN.test(notification.id) ? notification.id : undefined;
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "notifications create" : "rotate-secret"} request completed, but its answer did not carry a signing secret. Do not rerun it.`, {
        next: id
          ? { command: `screenrig notifications rotate-secret ${id}`, reason: "Issue a new signing secret; it is shown once in data.secret." }
          : { command: "screenrig notifications list", reason: "Find the notification, then run screenrig notifications rotate-secret ID to receive a new signing secret." },
      }), ExitCode.Unexpected);
  }
  return notification;
}

async function notificationSecretResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: "create" | "rotate", runtime: CliRuntime): Promise<CommandResult> {
  const notification = await notificationWithSecret(response.body, action, runtime);
  const warning = notificationSecretWarning(notification.id, action);
  return {
    envelope: jsonBody(response, client.requestId, undefined, [warning]),
    exitCode: ExitCode.Success,
    human: [
      action === "create" ? `Created notification ${notification.id}` : `Rotated the signing secret of notification ${notification.id}`,
      ...notificationLines(notification),
      `secret: ${notification.secret}`,
      `warning: ${warning.message}`,
    ].join("\n"),
    keepRecoveryUntilOutput: true,
  };
}

export const handleNotificationsCreate = commandHandler(async (args, runtime, resolved) => {
  const email = flagString(args.flags, "email");
  const webhook = flagString(args.flags, "webhook");
  const chat = NOTIFICATION_CHAT_CHANNELS.flatMap(({ channel, flag }) => {
    const value = flagString(args.flags, flag);
    return value === undefined ? [] : [{ channel, flag: `--${flag}`, value }];
  });
  if ((email === undefined ? 0 : 1) + (webhook === undefined ? 0 : 1) + chat.length !== 1) {
    throw usageError("notifications create requires exactly one of --email, --webhook, --slack, --teams, --pagerduty or --telegram.");
  }
  const telegramChat = flagString(args.flags, "telegram-chat");
  if ((chat[0]?.channel === "telegram") !== (telegramChat !== undefined)) {
    throw usageError("--telegram and --telegram-chat go together: the bot token and the chat it posts to.");
  }
  const conditions = flagString(args.flags, "conditions");
  const events = flagString(args.flags, "events");
  const tags = flagString(args.flags, "tag");
  const hold = flagString(args.flags, "hold");
  const description = flagString(args.flags, "description");
  const body: NotificationWrite = {
    channel: email !== undefined ? "email" : webhook !== undefined ? "webhook" : chat[0]!.channel,
    ...(email !== undefined ? { recipients: notificationRecipients(email) } : {}),
    ...(webhook !== undefined ? { url: webhookUrl(webhook, "--webhook") } : {}),
    ...(chat.length ? { destination: await notificationDestination(chat[0]!.value, chat[0]!.flag, runtime) } : {}),
    ...(telegramChat !== undefined ? { telegram_chat_id: telegramChat } : {}),
    ...(conditions !== undefined ? { conditions: notificationConditions(conditions) } : {}),
    ...(events !== undefined ? { event_types: webhookEventTypes(events, "--events") } : {}),
    ...(tags !== undefined ? { screen_tags: tags.split(",") } : {}),
    ...(hold !== undefined ? { hold_minutes: Number(notificationHold(hold)) } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "POST", path: NOTIFICATIONS_PATH, idempotent: true, body });
  if (body.channel === "webhook") return notificationSecretResult(response, client, "create", runtime);
  const created = response.body as Notification | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created notification ${created?.id ?? ""}`.trimEnd(), ...notificationLines(created)].join("\n"),
  };
});

export const handleNotificationsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "GET", path: NOTIFICATIONS_PATH });
  const items = (response.body as NotificationList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Notifications (${list.length})`, ...notificationTableLines(list)].join("\n"),
  };
});

export const handleNotificationsShow = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "GET", path: `${NOTIFICATIONS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Notification", ...notificationLines(response.body as Notification | undefined)].join("\n"),
  };
});

export const handleNotificationsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "update");
  const email = flagString(args.flags, "email");
  const url = flagString(args.flags, "url");
  const destination = flagString(args.flags, "destination");
  const telegramChat = flagString(args.flags, "telegram-chat");
  const conditions = flagString(args.flags, "conditions");
  const events = flagString(args.flags, "events");
  const tags = flagString(args.flags, "tag");
  const hold = flagString(args.flags, "hold");
  const description = flagString(args.flags, "description");
  const snooze = flagString(args.flags, "snooze");
  const patch: NotificationPatch = {
    ...(email !== undefined ? { recipients: notificationRecipients(email) } : {}),
    ...(url !== undefined ? { url: webhookUrl(url) } : {}),
    ...(destination !== undefined ? { destination: await notificationDestination(destination, "--destination", runtime) } : {}),
    ...(telegramChat !== undefined ? { telegram_chat_id: telegramChat } : {}),
    ...(conditions !== undefined ? { conditions: notificationConditions(conditions) } : {}),
    ...(flagBool(args.flags, "clear-conditions") ? { conditions: [] } : {}),
    ...(events !== undefined ? { event_types: webhookEventTypes(events, "--events") } : {}),
    ...(flagBool(args.flags, "clear-events") ? { event_types: [] } : {}),
    ...(tags !== undefined ? { screen_tags: tags.split(",") } : {}),
    ...(flagBool(args.flags, "all-screens") ? { screen_tags: [] } : {}),
    ...(hold !== undefined ? { hold_minutes: Number(notificationHold(hold)) } : {}),
    ...(description !== undefined ? { description: webhookDescription(description) } : {}),
    ...(flagBool(args.flags, "clear-description") ? { description: "" } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(snooze !== undefined ? { snoozed_until: snoozedUntil(snooze, runtime.now()) } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("notifications update requires at least one change: --email, --url, --destination, --telegram-chat, --conditions, --clear-conditions, --events, --clear-events, --tag, --all-screens, --hold, --description, --clear-description, --enable, --disable, or --snooze.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // --snooze derives its instant from the clock, so a rerun fingerprints
  // differently; drop the obsolete saved key instead of leaving it behind.
  const response = await notificationCall(client, {
    method: "PATCH", path: `${NOTIFICATIONS_PATH}/${id}`, idempotent: true, body: patch, headers: webhookRevisionHeaders(args),
    ...(snooze !== undefined ? { recoverySupersede: JSON.stringify(["notifications update --snooze", id]) } : {}),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated notification ${id}`, ...notificationLines(response.body as Notification | undefined)].join("\n"),
  };
});

export const handleNotificationsDelete = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "DELETE", path: `${NOTIFICATIONS_PATH}/${id}`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted notification ${id}. Its pending notices fail with webhook_deleted and its delivery log is no longer addressable.`,
  };
});

export const handleNotificationsRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "rotate-secret");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "POST", path: `${NOTIFICATIONS_PATH}/${id}/rotate-secret`, idempotent: true, headers: webhookRevisionHeaders(args),
  }, id);
  return notificationSecretResult(response, client, "rotate", runtime);
});

export const handleNotificationsTest = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, { method: "POST", path: `${NOTIFICATIONS_PATH}/${id}/test`, idempotent: true }, id);
  const delivery = response.body as NotificationDelivery | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(`Queued a test delivery to notification ${id}`, [
      ["delivery_id", delivery?.id],
      ["event_type", delivery?.event_type],
      ["event_id", delivery?.event_id],
      ["state", delivery?.state],
      ["next", `screenrig notifications deliveries ${id} --limit 1 shows its outcome; a test is attempted once, without retries.`],
    ]),
  };
});

export const handleNotificationsResubscribe = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "resubscribe");
  const user = notificationUserId(flagString(args.flags, "user") ?? "");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "DELETE", path: `${NOTIFICATIONS_PATH}/${id}/unsubscribed/${encodeURIComponent(user)}`, idempotent: true,
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Notification ${id} emails ${user} again, if they had unsubscribed.`, ...notificationLines(response.body as Notification | undefined)].join("\n"),
  };
});

export const handleNotificationsDeliveries = commandHandler(async (args, runtime, resolved) => {
  const id = notificationId(args.positionals[2], "deliveries");
  const before = flagString(args.flags, "before");
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await notificationCall(client, {
    method: "GET", path: `${NOTIFICATIONS_PATH}/${id}/deliveries`,
    query: {
      ...(before !== undefined ? { before: notificationDeliveryCursor(before) } : {}),
      ...(limit !== undefined ? { limit: webhookDeliveriesLimit(limit) } : {}),
    },
  }, id);
  const page = response.body as NotificationDeliveryList | undefined;
  const items = Array.isArray(page?.items) ? page.items : [];
  const next = typeof page?.next_cursor === "string" ? page.next_cursor : undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Notification ${id} deliveries (${items.length})`,
      ...notificationDeliveryTableLines(items),
      ...(next ? [`next: screenrig notifications deliveries ${id} --before ${next}${limit ? ` --limit ${limit}` : ""}`] : []),
    ].join("\n"),
  };
});

// Alerts: /api/alerts, one screen's condition while it lasts (acknowledge or
// snooze it while it is open), and /api/alert-mutes, screens muted for
// maintenance. Nothing here is secret. A snooze or mute made with --for derives
// its instant from the clock, so a rerun fingerprints differently; the obsolete
// saved key is superseded instead of left behind, as for notifications update
// --snooze.
const ALERTS_PATH = "/api/alerts";
const ALERT_MUTES_PATH = "/api/alert-mutes";

async function alertCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw alertProblem(error, id);
  }
}

export const handleAlertsList = commandHandler(async (args, runtime, resolved) => {
  const state = flagString(args.flags, "state");
  const screenId = flagString(args.flags, "screen-id");
  const before = flagString(args.flags, "before");
  const limit = flagString(args.flags, "limit");
  const alertQuery = {
    ...(state !== undefined ? { state } : {}),
    ...(screenId !== undefined ? { screen_id: alertScreenId(screenId) } : {}),
    ...(before !== undefined ? { before: alertsCursor(before) } : {}),
    ...(limit !== undefined ? { limit: alertsLimit(limit) } : {}),
  };
  const file = await reportFileOf(args, runtime, resolved, ALERTS_PATH, alertQuery, "alerts", "alerts");
  if (file) return file;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, {
    method: "GET", path: ALERTS_PATH,
    query: alertQuery,
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenAlertListLines(response.body as AlertList | undefined, runtime.now(), { state, screenId, limit }).join("\n"),
  };
});

export const handleAlertsShow = commandHandler(async (args, runtime, resolved) => {
  const id = alertId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "GET", path: `${ALERTS_PATH}/${id}` }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Alert", ...screenAlertLines(response.body as Alert | undefined, runtime.now())].join("\n"),
  };
});

export const handleAlertsAck = commandHandler(async (args, runtime, resolved) => {
  const id = alertId(args.positionals[2], "ack");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "POST", path: `${ALERTS_PATH}/${id}/acknowledge`, idempotent: true }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Acknowledged alert ${id}. It stays acknowledged until it resolves.`, ...screenAlertLines(response.body as Alert | undefined, runtime.now())].join("\n"),
  };
});

export const handleAlertsSnooze = commandHandler(async (args, runtime, resolved) => {
  const id = alertId(args.positionals[2], "snooze");
  const forValue = flagString(args.flags, "for");
  const until = alertEnd(forValue, flagString(args.flags, "until"), runtime.now());
  const body: AlertAcknowledge = { until };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, {
    method: "POST", path: `${ALERTS_PATH}/${id}/acknowledge`, idempotent: true, body,
    ...(forValue !== undefined ? { recoverySupersede: JSON.stringify(["alerts snooze", id]) } : {}),
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Snoozed alert ${id} until ${until}. It needs attention again then if it is still open.`, ...screenAlertLines(response.body as Alert | undefined, runtime.now())].join("\n"),
  };
});

export const handleAlertsMute = commandHandler(async (args, runtime, resolved) => {
  const screenIds = flagString(args.flags, "screen-id");
  const tags = flagString(args.flags, "tag");
  const note = flagString(args.flags, "note");
  const forValue = flagString(args.flags, "for");
  if (screenIds === undefined && tags === undefined) throw usageError("alerts mute requires --screen-id or --tag.");
  const body: AlertMuteWrite = {
    ...(screenIds !== undefined ? { screen_ids: screenIds.split(",") } : {}),
    ...(tags !== undefined ? { tags: tags.split(",") } : {}),
    until: alertEnd(forValue, flagString(args.flags, "until"), runtime.now()),
    ...(note !== undefined ? { note: alertNote(note) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, {
    method: "POST", path: ALERT_MUTES_PATH, idempotent: true, body,
    ...(forValue !== undefined ? { recoverySupersede: JSON.stringify(["alerts mute", body.screen_ids ?? [], body.tags ?? [], body.note ?? null]) } : {}),
  });
  const created = response.body as AlertMute | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Created mute ${created?.id ?? ""}`.trimEnd(), ...alertMuteLines(created)].join("\n"),
  };
});

export const handleAlertsMutes = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "GET", path: ALERT_MUTES_PATH });
  const items = (response.body as AlertMuteList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Mutes (${list.length})`, ...alertMuteTableLines(list)].join("\n"),
  };
});

export const handleAlertsUnmute = commandHandler(async (args, runtime, resolved) => {
  const id = alertMuteId(args.positionals[2], "unmute");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await alertCall(client, { method: "DELETE", path: `${ALERT_MUTES_PATH}/${id}`, idempotent: true }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Ended mute ${id}. Open alerts on its screens need attention again unless they are acknowledged or snoozed.`,
  };
});

// Fleet links: /api/fleet-links. url is a credential that creates screens; it
// is checked before it is printed, never shown in the human list, and kept out
// of the operation log (client.ts privateBodies).
const FLEET_LINKS_PATH = "/api/fleet-links";

async function fleetLinkCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw fleetLinkProblem(error, id);
  }
}

function fleetLinkRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "if-match");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

function fleetLinkTagList(args: ParsedArgs): string[] | undefined {
  const tags = flagString(args.flags, "tag");
  return tags === undefined ? undefined : tags.split(",");
}

function fleetLinkResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, title: string, withUrl: boolean, now: Date): CommandResult {
  const answered = response.body as FleetLink | undefined;
  const { link, warnings } = answered && typeof answered === "object" ? guardFleetLink(answered) : { link: answered, warnings: [] };
  return {
    envelope: jsonBody({ ...response, body: link }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [
      title,
      ...fleetLinkLines(link, now),
      ...(withUrl ? fleetLinkUrlLines(link, warnings.length > 0) : []),
      ...warnings.map((warning) => `warning: ${warning.message}`),
    ].join("\n"),
  };
}

export const handleFleetLinksCreate = commandHandler(async (args, runtime, resolved) => {
  const label = fleetLinkName(flagString(args.flags, "name") ?? "");
  const tags = fleetLinkTagList(args);
  const fields = fieldMap(flagString(args.flags, "field"));
  const playlistId = flagString(args.flags, "playlist-id");
  const maxScreens = flagString(args.flags, "max-screens");
  const expiresAt = flagString(args.flags, "expires-at");
  const body: FleetLinkWrite = {
    label,
    ...(flagBool(args.flags, "disabled") ? { enabled: false } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(playlistId !== undefined ? { playlist_id: fleetLinkPlaylistId(playlistId) } : {}),
    ...(maxScreens !== undefined ? { max_screens: Number(fleetLinkMaxScreens(maxScreens)) } : {}),
    ...(expiresAt !== undefined ? { expires_at: fleetLinkExpiresAt(expiresAt) } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, { method: "POST", path: FLEET_LINKS_PATH, idempotent: true, body });
  const id = (response.body as FleetLink | undefined)?.id;
  return fleetLinkResult(response, client, `Created fleet link ${id ?? ""}`.trimEnd(), true, runtime.now());
});

export const handleFleetLinksList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, { method: "GET", path: FLEET_LINKS_PATH });
  const listed = (response.body as FleetLinkList | undefined)?.items;
  const { items, warnings } = guardFleetLinks(Array.isArray(listed) ? listed : []);
  return {
    envelope: jsonBody({ ...response, body: { ...(response.body as object | undefined), items } }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [`Fleet links (${items.length})`, ...fleetLinkTableLines(items, runtime.now()), ...fleetLinkRedactedNote(items), ...warnings.map((warning) => `warning: ${warning.message}`)].join("\n"),
  };
});

export const handleFleetLinksShow = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "show");
  const wantsProvisioning = flagBool(args.flags, "android-provisioning");
  const origin = wantsProvisioning ? siteOrigin(resolved.apiUrl) : undefined;
  if (wantsProvisioning && origin === undefined) throw unsupportedSiteError();
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, { method: "GET", path: `${FLEET_LINKS_PATH}/${id}` }, id);
  if (origin === undefined) return fleetLinkResult(response, client, "Fleet link", true, runtime.now());
  return fleetLinkAndroidProvisioning(response, client, origin, runtime);
});

/**
 * `fleet-links show --android-provisioning`: the payload the dashboard's QR code
 * encodes, from the link's secret and the site's `managed` Android build. The
 * secret comes from the link as returned (a Read only credential gets none) and
 * the payload is printed once, under a sensitive label, never logged.
 */
async function fleetLinkAndroidProvisioning(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, origin: string, runtime: CliRuntime): Promise<CommandResult> {
  const answered = response.body as FleetLink | undefined;
  const secret = answered && typeof answered === "object" && !fleetLinkUrlProblem(answered.url) ? fleetLinkSecret(answered.url) : undefined;
  if (secret === undefined) {
    throw new CliError(makeProblem("fleet_link_secret_unavailable", "Fleet link secret unavailable", 403,
      answered?.url_redacted === true
        ? "A Read only credential receives no fleet link URL, so the provisioning payload cannot carry the link's secret."
        : "The fleet link was returned without a usable URL, so the provisioning payload cannot carry its secret.",
      { next: { command: "screenrig login --access manage", reason: "A Manage sign-in receives the fleet link URL." } }));
  }
  const artifact = await fetchManagedArtifact(origin, runtime.siteFetch ?? globalThis.fetch);
  const provisioning = androidProvisioning(artifact, origin, secret);
  if (provisioning === undefined) {
    throw unexpectedResponseError(`The managed Android build lists a path outside ${origin}/android/, so no download location is built for it.`);
  }
  const id = String(answered?.id ?? "");
  return {
    envelope: successEnvelope({ id, provisioning }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: [`Android device owner provisioning for fleet link ${id}`, PROVISIONING_NOTICE, "", JSON.stringify(provisioning)].join("\n"),
  };
}

export const handleFleetLinksUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "update");
  const name = flagString(args.flags, "name");
  const tags = fleetLinkTagList(args);
  const fields = fieldMap(flagString(args.flags, "field"));
  const playlistId = flagString(args.flags, "playlist-id");
  const maxScreens = flagString(args.flags, "max-screens");
  const expiresAt = flagString(args.flags, "expires-at");
  const patch: FleetLinkPatch = {
    ...(name !== undefined ? { label: fleetLinkName(name) } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(flagBool(args.flags, "clear-tags") ? { tags: [] } : {}),
    ...(fields !== undefined ? { fields } : {}),
    ...(flagBool(args.flags, "clear-fields") ? { fields: null } : {}),
    ...(playlistId !== undefined ? { playlist_id: fleetLinkPlaylistId(playlistId) } : {}),
    ...(flagBool(args.flags, "clear-playlist") ? { playlist_id: null } : {}),
    ...(maxScreens !== undefined ? { max_screens: Number(fleetLinkMaxScreens(maxScreens)) } : {}),
    ...(flagBool(args.flags, "clear-max-screens") ? { max_screens: null } : {}),
    ...(expiresAt !== undefined ? { expires_at: fleetLinkExpiresAt(expiresAt) } : {}),
    ...(flagBool(args.flags, "clear-expires-at") ? { expires_at: null } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("fleet-links update requires at least one of --name, --enable, --disable, --tag, --clear-tags, --field, --clear-fields, --playlist-id, --clear-playlist, --max-screens, --clear-max-screens, --expires-at, or --clear-expires-at.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, {
    method: "PATCH", path: `${FLEET_LINKS_PATH}/${id}`, idempotent: true, body: patch, headers: fleetLinkRevisionHeaders(args),
  }, id);
  return fleetLinkResult(response, client, `Updated fleet link ${id}. Screens it already created are unchanged.`, false, runtime.now());
});

export const handleFleetLinksRotate = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "rotate");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, {
    method: "POST", path: `${FLEET_LINKS_PATH}/${id}/rotate`, idempotent: true, headers: fleetLinkRevisionHeaders(args),
  }, id);
  return fleetLinkResult(response, client,
    `Rotated fleet link ${id}. The old URL stopped working; screens it already created keep playing. Put the new URL in your device manager.`, true, runtime.now());
});

export const handleFleetLinksDelete = commandHandler(async (args, runtime, resolved) => {
  const id = fleetLinkId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await fleetLinkCall(client, {
    method: "DELETE", path: `${FLEET_LINKS_PATH}/${id}`, idempotent: true, headers: fleetLinkRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted fleet link ${id}. Its URL stopped working; screens it created stay, with their playlists and tags.`,
  };
});

// Triggers: /api/triggers. A CAP trigger takes an emergency system's alerts; an
// overlay trigger takes a few words from any sender and shows them over what
// plays (a bar) or instead of it (a takeover). url and username are not secret;
// the password and the signing secret are returned only by create, rotate-secret
// and the update that turns signing on, printed once, and kept out of the
// operation log (client.ts privateBodies).
const TRIGGERS_PATH = "/api/triggers";

async function triggerCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw triggerProblem(error, id);
  }
}

function triggerRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "if-match");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

type TriggerSecretAction = "create" | "rotate" | "update" | "rotate-signing";

/**
 * The answer of a request that issued a secret: create and rotate-secret carry
 * the password (create also the signing secret of a signing overlay trigger), a
 * signing rotation and the update that turns signing on carry the signing secret.
 */
async function triggerWithSecrets(body: unknown, action: TriggerSecretAction, wantSigning: boolean, runtime: CliRuntime): Promise<TriggerWithSecrets> {
  const trigger = body as TriggerWithSecrets | undefined;
  const passwordOk = typeof trigger?.password === "string" && TRIGGER_PASSWORD_PATTERN.test(trigger.password);
  const signingOk = typeof trigger?.signing_secret === "string" && TRIGGER_SIGNING_SECRET_PATTERN.test(trigger.signing_secret);
  const needPassword = action === "create" || action === "rotate";
  const needSigning = action === "rotate-signing" || (action === "create" && wantSigning);
  if (!trigger || typeof trigger.id !== "string" || (needPassword && !passwordOk) || (needSigning && !signingOk)
    || (trigger.password !== undefined && !passwordOk) || (trigger.signing_secret !== undefined && !signingOk)) {
    await writeRecoveries.get(runtime)?.finish();
    const id = trigger && typeof trigger.id === "string" && TRIGGER_ID_PATTERN.test(trigger.id) ? trigger.id : undefined;
    const signing = action === "rotate-signing" || wantSigning;
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "trigger create" : action === "update" ? "trigger update" : "rotate-secret"} request completed, but its answer did not carry the secret it should. Do not rerun it.`, {
        next: id
          ? { command: `screenrig triggers rotate-secret ${id}${signing ? " --signing" : ""}`, reason: "Issue a new secret; it is shown once in the answer." }
          : { command: "screenrig triggers list", reason: "Find the trigger, then run screenrig triggers rotate-secret ID to receive a new secret." },
      }), ExitCode.Unexpected);
  }
  return trigger;
}

async function triggerSecretResult(
  response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: TriggerSecretAction, wantSigning: boolean, runtime: CliRuntime,
): Promise<CommandResult> {
  const trigger = await triggerWithSecrets(response.body, action, wantSigning, runtime);
  const warnings: Warning[] = [];
  if (trigger.password) warnings.push(triggerPasswordWarning(trigger.id, action === "create" ? "create" : "rotate", trigger.kind));
  if (trigger.signing_secret) warnings.push(triggerSigningWarning(trigger.id));
  const overlay = trigger.kind === "overlay";
  const title = action === "create" ? `Created trigger ${trigger.id}`
    : action === "update" ? `Updated trigger ${trigger.id}`
    : action === "rotate-signing" ? `Rotated the signing secret of trigger ${trigger.id}` : `Rotated the password of trigger ${trigger.id}`;
  const lines = [title, ...triggerLines(trigger), ...overlayLines(trigger.overlay)];
  if (trigger.password || trigger.signing_secret) {
    lines.push("", overlay
      ? "Sensitive trigger secrets (enter them only in the system that posts to the url above)"
      : "Sensitive CAP password (enter it only in your emergency notification system, with the url and username above)");
    if (trigger.password) lines.push(`password: ${trigger.password}`);
    if (trigger.signing_secret) lines.push(`signing_secret: ${trigger.signing_secret}`);
    if (overlay) lines.push(`example: ${triggerExample(trigger.url, trigger.overlay?.signing === true)}`);
    for (const warning of warnings) lines.push(`warning: ${warning.message}`);
  }
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings.length ? warnings : undefined),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
    ...(trigger.password || trigger.signing_secret ? { keepRecoveryUntilOutput: true } : {}),
  };
}

/** --pull: a JSON object (CapPull) from a file or stdin; the server validates its members. */
async function triggerPull(file: string, runtime: CliRuntime): Promise<TriggerPull> {
  let parsed: unknown;
  try {
    parsed = await readAuthoringJson(file, runtime);
  } catch (error) {
    throw usageError(`Cannot read the --pull JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usageError("--pull must hold a JSON object of CAP sources and filters.");
  return parsed as TriggerPull;
}

function triggerTargetBody(args: ParsedArgs): TriggerTarget | undefined {
  const tag = flagString(args.flags, "tag");
  const screenIds = flagString(args.flags, "screen-id");
  if (tag !== undefined && screenIds !== undefined) throw usageError("Pass --tag TAG or --screen-id ID, not both.");
  if (tag !== undefined) return { tag: triggerTag(tag) };
  if (screenIds !== undefined) return { screen_ids: triggerScreenIds(screenIds).split(",") };
  return undefined;
}

/** The kind-only options of create: usage errors name the kind they need. */
function triggerOverlayOptionsOnly(args: ParsedArgs, kind: string): void {
  for (const flag of ["show", "edge", "style", "map", "signing"]) {
    const given = flag === "signing" ? flagBool(args.flags, flag) : flagString(args.flags, flag) !== undefined;
    if (given && kind !== "overlay") throw usageError(`--${flag} applies to an overlay trigger: add --kind overlay.`);
  }
}

export const handleTriggersCreate = commandHandler(async (args, runtime, resolved) => {
  const label = triggerName(flagString(args.flags, "name") ?? "");
  const kind = flagString(args.flags, "kind") ?? "cap";
  const target = triggerTargetBody(args);
  if (!target) throw usageError("triggers create takes exactly one of --tag TAG or --screen-id ID.");
  const hold = flagString(args.flags, "for");
  const pullFile = flagString(args.flags, "pull");
  triggerOverlayOptionsOnly(args, kind);
  const signing = flagBool(args.flags, "signing");
  let body: TriggerWrite;
  if (kind === "overlay") {
    if (pullFile !== undefined) throw usageError("--pull applies to a CAP trigger: omit --kind overlay.");
    const show = flagString(args.flags, "show");
    if (show !== "bar" && show !== "takeover") throw usageError("An overlay trigger needs --show bar (a strip over whatever plays) or --show takeover (the alert fills the screen).");
    const edge = flagString(args.flags, "edge");
    if (edge !== undefined && show !== "bar") throw usageError("--edge applies to a bar: use --show bar.");
    const styleFile = flagString(args.flags, "style");
    const mapFile = flagString(args.flags, "map");
    body = {
      kind: "overlay", label, target,
      ...(hold !== undefined ? { default_for_seconds: triggerHoldSeconds(hold, "overlay") } : {}),
      overlay: {
        show,
        ...(edge !== undefined ? { edge: edge as "top" | "bottom" } : {}),
        ...(styleFile !== undefined ? { style: triggerStyle(await readAuthoringText(styleFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
        ...(mapFile !== undefined ? { mapping: triggerMapping(await readAuthoringText(mapFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
        ...(signing ? { signing: true } : {}),
      },
    };
  } else {
    body = {
      label, target,
      ...(hold !== undefined ? { default_for_seconds: triggerHoldSeconds(hold) } : {}),
      ...(pullFile !== undefined ? { pull: await triggerPull(pullFile, runtime) } : {}),
    };
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "POST", path: TRIGGERS_PATH, idempotent: true, body });
  return triggerSecretResult(response, client, "create", signing, runtime);
});

export const handleTriggersUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "update");
  const name = flagString(args.flags, "name");
  const target = triggerTargetBody(args);
  const hold = flagString(args.flags, "for");
  const pullFile = flagString(args.flags, "pull");
  const edge = flagString(args.flags, "edge");
  const styleFile = flagString(args.flags, "style");
  const mapFile = flagString(args.flags, "map");
  const overlay: NonNullable<TriggerPatch["overlay"]> = {
    ...(edge !== undefined ? { edge: edge as "top" | "bottom" } : {}),
    ...(styleFile !== undefined ? { style: triggerStyle(await readAuthoringText(styleFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
    ...(flagBool(args.flags, "clear-style") ? { style: null } : {}),
    ...(mapFile !== undefined ? { mapping: triggerMapping(await readAuthoringText(mapFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
    ...(flagBool(args.flags, "clear-map") ? { mapping: null } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(flagBool(args.flags, "signing") ? { signing: true } : {}),
    ...(flagBool(args.flags, "no-signing") ? { signing: false } : {}),
  };
  const body: TriggerPatch = {
    ...(name !== undefined ? { label: triggerName(name) } : {}),
    ...(target ? { target } : {}),
    // The kind is not known here, so the server holds the 1m floor of a CAP trigger.
    ...(hold !== undefined ? { default_for_seconds: triggerHoldSeconds(hold, "overlay") } : {}),
    ...(pullFile !== undefined ? { pull: await triggerPull(pullFile, runtime) } : {}),
    ...(flagBool(args.flags, "no-pull") ? { pull: null } : {}),
    ...(Object.keys(overlay).length ? { overlay } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "PATCH", path: `${TRIGGERS_PATH}/${id}`, idempotent: true, body, headers: triggerRevisionHeaders(args) }, id);
  const trigger = response.body as TriggerWithSecrets | undefined;
  if (trigger?.password !== undefined || trigger?.signing_secret !== undefined) return triggerSecretResult(response, client, "update", flagBool(args.flags, "signing"), runtime);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated trigger ${id}`, ...triggerLines(trigger), ...overlayLines(trigger?.overlay)].join("\n"),
  };
});

export const handleTriggersList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "GET", path: TRIGGERS_PATH });
  const items = (response.body as TriggerList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Triggers (${list.length})`, ...triggerTableLines(list)].join("\n"),
  };
});

export const handleTriggersShow = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "GET", path: `${TRIGGERS_PATH}/${id}` }, id);
  const trigger = response.body as Trigger | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Trigger", ...triggerLines(trigger), ...alertLines(trigger?.alert), ...overlayLines(trigger?.overlay)].join("\n"),
  };
});

export const handleTriggersTest = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "POST", path: `${TRIGGERS_PATH}/${id}/test`, idempotent: true }, id);
  const receipt = response.body as (TriggerReceipt & Partial<TriggerOverlayReceipt>) | undefined;
  if (receipt && "active" in receipt) {
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: receipt.outcome === "shown"
        ? `Showing a test overlay from trigger ${id} ${receipt.until ? `until ${receipt.until}` : "until cleared"}. screenrig triggers show ${id} reports its screens; screenrig triggers clear ${id} ends it sooner.`
        : `Trigger ${id} answered ${receipt.outcome ?? "no outcome"}.`,
    };
  }
  const alert = receipt?.alert;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      alert && receipt?.outcome === "shown"
        ? `Showing an exercise alert from trigger ${id} until ${alert.until}. screenrig triggers show ${id} reports its screens; screenrig triggers clear ${id} ends it sooner.`
        : `Trigger ${id} answered ${receipt?.outcome ?? "no outcome"}.`,
      ...alertLines(alert),
    ].join("\n"),
  };
});

export const handleTriggersClear = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "clear");
  const alertId = flagString(args.flags, "alert-id");
  if (alertId !== undefined && (!alertId.trim() || [...alertId].length > 200)) throw usageError("--alert-id takes the sender's alert id, 1 to 200 characters.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, {
    method: "POST", path: `${TRIGGERS_PATH}/${id}/clear`, idempotent: true, ...(alertId !== undefined ? { body: { alert_id: alertId.trim() } } : {}),
  }, id);
  const trigger = response.body as Trigger | undefined;
  const remaining = trigger?.overlay?.alerts.length ?? 0;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      trigger?.overlay
        ? remaining ? `Trigger ${id} still shows ${remaining} alert${remaining === 1 ? "" : "s"}.` : `No alert is active on trigger ${id}. Its bar is lowered, or its screens go back to what they played before.`
        : `No alert is active on trigger ${id}. Screens its alert took over go back to what they played before.`,
      ...triggerLines(trigger),
      ...alertLines(trigger?.alert),
      ...overlayLines(trigger?.overlay),
    ].join("\n"),
  };
});

export const handleTriggersDeliveries = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "deliveries");
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "GET", path: `${TRIGGERS_PATH}/${id}/deliveries`, ...(limit ? { query: { limit } } : {}) }, id);
  const items = (response.body as TriggerDeliveryList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Deliveries of ${id} (${list.length})`, ...triggerDeliveryTableLines(list)].join("\n"),
  };
});

export const handleTriggersRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "rotate-secret");
  const signing = flagBool(args.flags, "signing");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, {
    method: "POST", path: `${TRIGGERS_PATH}/${id}/rotate-secret`, idempotent: true, headers: triggerRevisionHeaders(args),
    ...(signing ? { body: { signing: true } } : {}),
  }, id);
  return triggerSecretResult(response, client, signing ? "rotate-signing" : "rotate", signing, runtime);
});

export const handleTriggersDelete = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, {
    method: "DELETE", path: `${TRIGGERS_PATH}/${id}`, idempotent: true, headers: triggerRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted trigger ${id}. Its URL stopped accepting posts.`,
  };
});

// Content campaigns: /api/campaigns switch every screen of an audience to a
// playlist while from, until and windows hold in each screen's timezone.
// campaign explain reads /api/screens/{id}/campaigns. Advertising campaigns
// (ads campaigns) are a different resource that shares the cmp_ id prefix.
const CAMPAIGNS_PATH = "/api/campaigns";

async function campaignCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
  subject: "campaign" | "screen" = "campaign",
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw campaignProblem(error, id, subject);
  }
}

function campaignRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "if-match");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

/**
 * The audience the flags name, or undefined when none is given: --tag (every
 * listed tag), --any-tag (at least one), --screen-id, --folder (a screen
 * folder and every folder inside it), --all-screens, or --audience (a raw
 * rule: inline JSON, @FILE, or - for stdin).
 */
async function campaignAudienceFlag(args: ParsedArgs, runtime: CliRuntime): Promise<CampaignAudience | undefined> {
  const tags = flagString(args.flags, "tag");
  const anyTags = flagString(args.flags, "any-tag");
  const screenIds = flagString(args.flags, "screen-id");
  const folder = flagString(args.flags, "folder");
  const raw = flagString(args.flags, "audience");
  const all = flagBool(args.flags, "all-screens");
  if ([tags, anyTags, screenIds, folder, raw].filter((value) => value !== undefined).length + (all ? 1 : 0) > 1) {
    throw usageError("Provide at most one of --tag, --any-tag, --screen-id, --folder, --all-screens or --audience.");
  }
  if (tags !== undefined) return campaignTagAudience(tags.split(","));
  if (anyTags !== undefined) return campaignAnyTagAudience(anyTags.split(","));
  if (screenIds !== undefined) return campaignScreenAudience(screenIds.split(","));
  if (folder !== undefined) return campaignFolderAudience(campaignFolder(folder));
  if (all) return campaignAllScreensAudience();
  if (raw === undefined) return undefined;
  const source = raw.trim();
  const text = source === "-" || source.startsWith("@")
    ? await readAuthoringText(source === "-" ? source : source.slice(1), runtime, CAMPAIGN_AUDIENCE_INPUT_MAX_BYTES)
    : raw;
  return campaignAudienceJson(text);
}

/**
 * The level members the flags set: --monthly, --date, --except, --on-touch
 * (60 seconds without a value), --displays and --start. A member the flags do
 * not name stays out of the body.
 */
function campaignLevelFlags(args: ParsedArgs): Pick<CampaignWrite, "monthly" | "dates" | "except" | "interaction" | "displays" | "start"> {
  const monthly = flagString(args.flags, "monthly");
  const dates = flagString(args.flags, "date");
  const except = flagString(args.flags, "except");
  const displays = flagString(args.flags, "displays");
  const start = flagString(args.flags, "start");
  const onTouch = args.flags["on-touch"];
  return {
    ...(monthly !== undefined ? { monthly: campaignMonthlyList(monthly) } : {}),
    ...(dates !== undefined ? { dates: campaignDateList(dates) } : {}),
    ...(except !== undefined ? { except: except.split(",") } : {}),
    ...(onTouch !== undefined && onTouch !== false ? { interaction: { idle_s: typeof onTouch === "string" ? Number(onTouch) : LEVEL_IDLE_DEFAULT_S } } : {}),
    ...(displays !== undefined ? { displays: campaignDisplayList(displays) } : {}),
    ...(start !== undefined ? { start: start === "on-time" ? "on_time" as const : "next_item" as const } : {}),
  };
}

function campaignResult(response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, title: string): CommandResult {
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [title, ...campaignLines(response.body as Campaign | undefined)].join("\n"),
  };
}

export const handleCampaignCreate = commandHandler(async (args, runtime, resolved) => {
  const name = campaignName(flagString(args.flags, "name") ?? "");
  const playlistId = campaignPlaylistId(flagString(args.flags, "playlist-id") ?? "");
  const audience = await campaignAudienceFlag(args, runtime);
  if (!audience) throw usageError("campaign create takes exactly one of --tag, --any-tag, --screen-id, --folder, --all-screens or --audience.");
  const from = flagString(args.flags, "from");
  const until = flagString(args.flags, "until");
  campaignBounds(from, until);
  const windows = flagString(args.flags, "window");
  const priority = flagString(args.flags, "priority");
  const paused = flagBool(args.flags, "paused");
  const body: CampaignWrite = {
    name,
    playlist_id: playlistId,
    audience,
    ...(from !== undefined ? { from } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(windows !== undefined ? { windows: campaignWindowList(windows) } : {}),
    ...campaignLevelFlags(args),
    ...(priority !== undefined ? { priority: Number(priority) } : {}),
    ...(paused ? { paused: true } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "POST", path: CAMPAIGNS_PATH, idempotent: true, body });
  const id = (response.body as Campaign | undefined)?.id ?? "";
  return campaignResult(response, client, paused
    ? `Created campaign ${id}, paused. No screen changes until screenrig campaign resume ${id}.`
    : `Created campaign ${id}. Screens in its audience switch to the playlist within a minute while it holds; screenrig campaign screens ${id} shows each screen's standing.`);
});

export const handleCampaignList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "GET", path: CAMPAIGNS_PATH });
  const items = (response.body as CampaignList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Campaigns (${list.length}), in the order screens read them`, ...campaignTableLines(list)].join("\n"),
  };
});

export const handleCampaignShow = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, { method: "GET", path: `${CAMPAIGNS_PATH}/${id}` }, id);
  return campaignResult(response, client, "Campaign");
});

export const handleCampaignUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "update");
  const name = flagString(args.flags, "name");
  const playlistId = flagString(args.flags, "playlist-id");
  const from = flagString(args.flags, "from");
  const until = flagString(args.flags, "until");
  const windows = flagString(args.flags, "window");
  const priority = flagString(args.flags, "priority");
  const clears = (["clear-from", "clear-until", "clear-windows", "clear-monthly", "clear-dates", "clear-except", "clear-on-touch", "clear-displays"] as const).filter((flag) => flagBool(args.flags, flag));
  const audience = await campaignAudienceFlag(args, runtime);
  campaignBounds(from, until);
  const patch: CampaignPatch = {
    ...(name !== undefined ? { name: campaignName(name) } : {}),
    ...(playlistId !== undefined ? { playlist_id: campaignPlaylistId(playlistId) } : {}),
    ...(audience ? { audience } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(clears.includes("clear-from") ? { from: null } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(clears.includes("clear-until") ? { until: null } : {}),
    ...(windows !== undefined ? { windows: campaignWindowList(windows) } : {}),
    ...(clears.includes("clear-windows") ? { windows: null } : {}),
    ...campaignLevelFlags(args),
    ...(clears.includes("clear-monthly") ? { monthly: null } : {}),
    ...(clears.includes("clear-dates") ? { dates: null } : {}),
    ...(clears.includes("clear-except") ? { except: null } : {}),
    ...(clears.includes("clear-on-touch") ? { interaction: null } : {}),
    ...(clears.includes("clear-displays") ? { displays: null } : {}),
    ...(priority !== undefined ? { priority: Number(priority) } : {}),
  };
  if (!Object.keys(patch).length) {
    throw usageError("campaign update requires at least one of --name, --playlist-id, an audience (--tag, --any-tag, --screen-id, --folder, --all-screens or --audience), --from, --clear-from, --until, --clear-until, --window, --clear-windows, --monthly, --clear-monthly, --date, --clear-dates, --except, --clear-except, --on-touch, --clear-on-touch, --displays, --clear-displays, --start, or --priority.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "PATCH", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, body: patch, headers: campaignRevisionHeaders(args),
  }, id);
  return campaignResult(response, client, `Updated campaign ${id}. Every screen of its old and new audience re-resolves within a minute.`);
});

async function campaignPaused(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, paused: boolean): Promise<CommandResult> {
  const id = campaignId(args.positionals[2], paused ? "pause" : "resume");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const body: CampaignPatch = { paused };
  const response = await campaignCall(client, {
    method: "PATCH", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, body, headers: campaignRevisionHeaders(args),
  }, id);
  return campaignResult(response, client, paused
    ? `Paused campaign ${id}. Screens that showed it return to what they would show without it within a minute; screenrig campaign resume ${id} starts it again.`
    : `Resumed campaign ${id}. Screens in its audience switch to the playlist within a minute while it holds; screenrig campaign screens ${id} shows each screen's standing.`);
}

export const handleCampaignPause = commandHandler((args, runtime, resolved) => campaignPaused(args, runtime, resolved, true));

export const handleCampaignResume = commandHandler((args, runtime, resolved) => campaignPaused(args, runtime, resolved, false));

export const handleCampaignDelete = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "DELETE", path: `${CAMPAIGNS_PATH}/${id}`, idempotent: true, headers: campaignRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted campaign ${id}. Screens that showed it return to what they would show without it within a minute.`,
  };
});

export const handleCampaignScreens = commandHandler(async (args, runtime, resolved) => {
  const id = campaignId(args.positionals[2], "screens");
  const limit = flagString(args.flags, "limit");
  const cursor = flagString(args.flags, "cursor");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await campaignCall(client, {
    method: "GET", path: `${CAMPAIGNS_PATH}/${id}/screens`,
    query: { ...(limit !== undefined ? { limit } : {}), ...(cursor !== undefined ? { cursor } : {}) },
  }, id);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: campaignScreensLines(id, response.body as CampaignScreens | undefined, limit).join("\n"),
  };
});

export const handleCampaignExplain = commandHandler(async (args, runtime, resolved) => {
  const screenId = campaignScreenId(args.positionals[2]);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const at = flagString(args.flags, "at");
  const to = flagString(args.flags, "to");
  const response = await campaignCall(client, {
    method: "GET", path: `/api/screens/${screenId}/campaigns`,
    ...(at !== undefined || to !== undefined ? { query: { ...(at !== undefined ? { at } : {}), ...(to !== undefined ? { to } : {}) } } : {}),
  }, screenId, "screen");
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: campaignExplainLines(screenId, response.body as ScreenCampaigns | undefined).join("\n"),
  };
});

// Playlist schedules and takeover. One screen id uses the single-screen
// routes (revision guard allowed); several ids or --tag use the fleet actions
// route (set_playlist_schedule, takeover, takeover_clear).
function nestedScreenTarget(args: ParsedArgs, command: string) {
  // positionals are [screen, schedule|takeover, action, ...ids].
  return screenTarget({ ...args, positionals: args.positionals.slice(1) }, command);
}

async function screenControlCall(client: ApiClient, id: string, request: Parameters<ApiClient["call"]>[0]) {
  try {
    return await client.call(request);
  } catch (error) {
    throw screenControlProblem(error, id);
  }
}

/** The review note and revision guard of a single-screen control write. */
function screenControlHeaders(args: ParsedArgs, revision: string | undefined): Record<string, string> {
  return { ...reviewNoteFrom(args), ...(revision ? { "if-match": quotedRevision(revision) } : {}) };
}

function screenControlHuman(title: string, screen: Screen | undefined): string {
  return [
    title,
    ...assignmentLine(screen?.effective_playlist, screen?.takeover, screen?.timezone),
    ...takeoverLine(screen?.takeover, screen?.timezone),
    ...(screen?.playlist_schedule ? scheduleTableLines(screen.playlist_schedule.entries, screen.timezone ?? null) : []),
    ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : []),
  ].join("\n");
}

export const handleScreenScheduleShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen schedule show requires <id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "GET", path: `/api/screens/${encodeURIComponent(id)}/playlist-schedule` });
  const view = response.body as ScreenPlaylistScheduleView | undefined;
  // The view carries no zone; human output reads it from the screen so civil
  // windows and instants are labelled. JSON output makes no extra request.
  let timezone: string | null | undefined;
  if (flagBool(args.flags, "human")) {
    try {
      const screen = await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` });
      timezone = (screen.body as Screen | undefined)?.timezone ?? null;
    } catch {
      timezone = undefined;
    }
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      `Playlist schedule for ${id}`,
      ...assignmentLine(view?.effective_playlist, undefined, timezone ?? undefined),
      ...(view?.updated_at ? [`updated_at: ${view.updated_at}`] : []),
      ...scheduleTableLines(view?.entries, timezone === undefined ? "unknown" : timezone),
    ].join("\n"),
  };
});

export const handleScreenScheduleSet = commandHandler(async (args, runtime, resolved) => {
  const file = flagString(args.flags, "file");
  if (!file) throw usageError("screen schedule set requires --file FILE (or --file - for stdin).");
  const target = nestedScreenTarget(args, "screen schedule set");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen schedule set");
  const entries = scheduleEntries(await readAuthoringJson(file, runtime));
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    // Entries are normalized once on the server so every screen stores the
    // same ids; a screen without a timezone fails alone with invalid_request.
    return screenFleetAction(client, runtime, "Fleet schedule set", target.selector, { type: "set_playlist_schedule", entries }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const body: ScreenPlaylistScheduleWrite = { entries };
  const revision = flagString(args.flags, "if-match");
  const response = await screenControlCall(client, id, {
    method: "PUT", path: `/api/screens/${encodeURIComponent(id)}/playlist-schedule`, idempotent: true, body,
    headers: screenControlHeaders(args, revision),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Set a ${entries.length}-entry playlist schedule on ${id}`, response.body as Screen | undefined),
  };
});

export const handleScreenScheduleClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen schedule clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen schedule clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    return screenFleetAction(client, runtime, "Fleet schedule clear", target.selector, { type: "clear_playlist_schedule" }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/playlist-schedule`, idempotent: true,
    headers: screenControlHeaders(args, revision),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Cleared the playlist schedule on ${id}`, response.body as Screen | undefined),
  };
});

export const handleScreenTakeover = commandHandler(async (args, runtime, resolved) => {
  const playlistId = flagString(args.flags, "playlist-id");
  if (!playlistId) throw usageError("screen takeover requires <id>, --tag TAG or --folder ID, and --playlist-id.");
  const target = nestedScreenTarget(args, "screen takeover");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen takeover");
  const forValue = flagString(args.flags, "for");
  const until = takeoverUntil(flagString(args.flags, "until"), forValue, runtime.now());
  const reason = flagString(args.flags, "reason");
  const write: ScreenTakeoverWrite = {
    playlist_id: playlistId,
    ...(until !== undefined ? { until } : {}),
    ...(reason !== undefined ? { reason: takeoverReason(reason) } : {}),
  };
  // --for derives until from the clock, so a rerun fingerprints differently;
  // drop the obsolete saved key instead of leaving it behind.
  const supersede = forValue !== undefined
    ? JSON.stringify(["screen takeover --for", target.kind === "single" ? target.id : target.selector, playlistId]) : undefined;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    try {
      return await screenFleetAction(client, runtime, "Fleet takeover", target.selector, { type: "takeover", ...write }, supersede, reviewNoteFrom(args));
    } catch (error) {
      throw forValue !== undefined ? takeoverForProblem(error) : error;
    }
  }
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  let response;
  try {
    response = await screenControlCall(client, id, {
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/takeover`, idempotent: true, body: write,
      headers: screenControlHeaders(args, revision),
      ...(supersede ? { recoverySupersede: supersede } : {}),
    });
  } catch (error) {
    throw forValue !== undefined ? takeoverForProblem(error) : error;
  }
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Took over ${id} with ${playlistId} ${typeof until === "string" ? `until ${instantInZone(until, (response.body as Screen | undefined)?.timezone)}` : "until cleared"}`, response.body as Screen | undefined),
  };
});

export const handleScreenTakeoverClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen takeover clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen takeover clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") {
    return screenFleetAction(client, runtime, "Fleet takeover clear", target.selector, { type: "takeover_clear" }, undefined, reviewNoteFrom(args));
  }
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/takeover`, idempotent: true,
    headers: screenControlHeaders(args, revision),
  });
  const pending = pendingReviewOf(response);
  if (pending) return pendingReviewResult(response, pending, client.requestId);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: screenControlHuman(`Cleared the takeover on ${id}`, response.body as Screen | undefined),
  };
});

// Reboot and display power. One screen id uses the single-screen routes
// (revision guard allowed); several ids or --tag use the fleet actions route
// (reboot, display, set_display_schedule, clear_display_schedule).
export const handleScreenReboot = commandHandler(async (args, runtime, resolved) => {
  const target = screenTarget(args, "screen reboot");
  if (target.kind === "fleet") {
    rejectFleetRevision(args, "screen reboot");
    // Noninteractive: a fleet reboot is never a side effect of a typo.
    if (!flagBool(args.flags, "yes")) {
      throw usageError("screen reboot with several screens or --tag reboots every matching device; add --yes to confirm.", {
        command: `screenrig screen reboot ${selectorFlags(target.selector)} --yes`,
        reason: "Check the matching screens with screen list first; each rebooted device is dark until it restarts.",
      });
    }
  }
  const lifetime = commandLifetime(args);
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet reboot", target.selector, { type: "reboot", ...lifetime });
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/reboot`, idempotent: true,
      ...(lifetime.expires_in_s === undefined ? {} : { body: lifetime }),
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw rebootProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenRebootAccepted>;
  if (typeof accepted.reboot_id !== "string" || !/^rbt_[A-Za-z0-9_-]{8,64}$/.test(accepted.reboot_id) || serverInstant(accepted.expires_at) === undefined || !validDelivery(accepted.state)) {
    throw usageError("Screen reboot response does not match the generated ScreenRebootAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Reboot accepted", [["screen_id", id], ["reboot_id", accepted.reboot_id], ["state", accepted.state], ["expires_at", accepted.expires_at]]),
      accepted.state === "queued"
        ? `The screen is offline, so the reboot waits: it is sent when the screen comes online before expires_at, and screen show lists it under commands (done once the device reports it booted). Cancel it with screen command cancel ${id} ${accepted.reboot_id}.`
        : "The Player reboots the device when it receives this before expires_at. Confirm it came back with screen show (online, health uptime).",
    ].join("\n"),
  };
}, true);

// Start one page of the playlist a screen is playing now. Single screen only.
export const handleScreenPlayPage = commandHandler(async (args, runtime, resolved) => {
  if (args.flags["page-id"] === true) throw usageError("--page-id requires a value, such as --page-id pg_WELCOME.");
  const pageId = flagString(args.flags, "page-id");
  const ids = args.positionals.slice(2);
  if (!ids.length || pageId === undefined) throw usageError("screen play-page requires <id> and --page-id PAGE_ID.");
  const id = ids[0]!;
  if (id.length < 1 || id.length > 200) throw usageError("screen play-page screen ids must be 1 to 200 characters.");
  if (pageId.length < 1 || pageId.length > 128) throw usageError("--page-id must be 1 to 128 characters.");
  const body: ScreenPlayPageWrite = { page_id: pageId };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "POST", path: `/api/screens/${encodeURIComponent(id)}/play-page`, idempotent: true, body });
  } catch (error) {
    throw playPageProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenPlayPageAccepted>;
  if (typeof accepted.playlist_id !== "string" || typeof accepted.page_id !== "string" || serverInstant(accepted.expires_at) === undefined) {
    throw usageError("Screen play-page response does not match the generated ScreenPlayPageAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Play-page accepted", [["screen_id", id], ["playlist_id", accepted.playlist_id], ["page_id", accepted.page_id], ["expires_at", accepted.expires_at]]),
  };
}, true);

// Show the screen's name over its content. Single screen only.
export const handleScreenIdentify = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("screen identify requires <id>.");
  const duration = flagString(args.flags, "duration");
  // The server's 60 seconds applies unless --duration is given.
  const body: ScreenIdentifyWrite | undefined = duration === undefined ? undefined : { duration_ms: identifyDurationMs(duration) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "POST", path: `/api/screens/${encodeURIComponent(id)}/identify`, idempotent: true, ...(body ? { body } : {}) });
  } catch (error) {
    throw identifyProblem(error, id);
  }
  const accepted = (response.body ?? {}) as Partial<ScreenIdentifyAccepted>;
  if (typeof accepted.identify_id !== "string" || !/^idf_[A-Za-z0-9_-]{8,64}$/.test(accepted.identify_id) || serverInstant(accepted.expires_at) === undefined) {
    throw unexpectedResponseError("Screen identify response does not match the generated ScreenIdentifyAccepted contract.");
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines("Identify accepted", [
        ["screen_id", id],
        ["identify_id", accepted.identify_id],
        ["duration_ms", Number.isSafeInteger(accepted.duration_ms) ? String(accepted.duration_ms) : undefined],
        ["expires_at", accepted.expires_at],
      ]),
      "The Player shows the screen's name over its content for the duration, counted from when it receives this; playback continues underneath. Run it again to replace the overlay.",
    ].join("\n"),
  };
}, true);

// Start live view of a screen, or renew it, and wait for the Player to publish.
// The video is watched on data.viewer_url; the CLI never carries it.
export const handleScreenLiveStart = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "start");
  const duration = flagString(args.flags, "duration");
  const wait = flagString(args.flags, "wait");
  const waitMs = wait === undefined ? LIVE_WAIT_DEFAULT_MS : liveWaitMs(wait);
  // The server's 5 minutes applies unless --duration is given.
  const body: LiveStartRequest | undefined = duration === undefined ? undefined : { duration_s: liveDurationSeconds(duration) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const path = `/api/screens/${encodeURIComponent(id)}/live`;
  let response;
  try {
    response = await client.call({ method: "POST", path, ...(body ? { body } : {}) });
  } catch (error) {
    throw liveProblem(error, id);
  }
  let session = liveSessionBody(response.body);
  if (!session) throw unexpectedResponseError("Screen live start response does not match the generated LiveSession contract.");
  session = await settleLive(session, async () => {
    response = await client.call({ method: "GET", path });
    const read = liveSessionBody(response.body);
    if (!read) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
    return read;
  }, { waitMs, now: () => runtime.now().getTime(), sleep: runtime.sleep });
  if (session.state === "ended" || session.state === "idle") throw liveEndedError(session);
  const warnings = session.publisher?.connected ? [] : [liveNotReadyWarning(session)];
  return {
    envelope: jsonBody({ body: session, headers: response.headers }, client.requestId, undefined, warnings),
    exitCode: ExitCode.Success,
    human: [liveHumanLines(session), ...warnings.map((warning) => warning.message)].join("\n"),
  };
}, true);

// Read a screen's live session.
export const handleScreenLiveStatus = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "status");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}/live` });
  } catch (error) {
    throw liveProblem(error, id);
  }
  const session = liveSessionBody(response.body);
  if (!session) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: liveHumanLines(session) };
}, true);

// End a screen's live session. Also succeeds when there is none.
export const handleScreenLiveStop = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "stop");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const path = `/api/screens/${encodeURIComponent(id)}/live`;
  let response;
  try {
    await client.call({ method: "DELETE", path });
    response = await client.call({ method: "GET", path });
  } catch (error) {
    throw liveProblem(error, id);
  }
  const session = liveSessionBody(response.body);
  if (!session) throw unexpectedResponseError("Screen live status response does not match the generated LiveSession contract.");
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: liveHumanLines(session) };
}, true);

// Save JPEG frames of a screen's live stream: start the session, wait for the
// Player to publish, start frames, then read each new frame once.
export const handleScreenLiveFrame = commandHandler(async (args, runtime, resolved) => {
  const id = liveScreenId(args.positionals[3], "frame");
  const count = flagNumber(args.flags, "count") ?? 1;
  if (!Number.isInteger(count) || count < 1) throw usageError("--count must be a whole number of at least 1.");
  const interval = flagString(args.flags, "interval");
  const intervalMs = interval === undefined ? LIVE_FRAME_INTERVAL_DEFAULT_MS : liveFrameIntervalMs(interval);
  const duration = flagString(args.flags, "duration");
  const wait = flagString(args.flags, "wait");
  const plan = {
    screenId: id,
    count,
    intervalMs,
    leaseSeconds: liveFrameLeaseSeconds(duration === undefined ? undefined : liveDurationSeconds(duration), count, intervalMs),
    waitMs: wait === undefined ? LIVE_WAIT_DEFAULT_MS : liveWaitMs(wait),
    stop: flagBool(args.flags, "stop"),
    output: await resolveFrameOutput(runtime.cwd(), flagString(args.flags, "output"), count),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const result = await captureLiveFrames(plan, client, { now: () => runtime.now().getTime(), sleep: runtime.sleep });
  return { envelope: successEnvelope(result, { request_id: client.requestId }), exitCode: ExitCode.Success, human: liveFramesHumanLines(result) };
}, true);

// Put a notice on a screen instead of its content. Single screen only.
export const handleScreenSuspend = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const message = flagString(args.flags, "message");
  if (!id || message === undefined) throw usageError("screen suspend requires <id> and --message TEXT.");
  const body: ScreenSuspendWrite = { message: suspendMessage(message) };
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/suspend`, idempotent: true, body,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw suspendProblem(error, id);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Suspended screen ${id}`, [
        ["since", serverInstant(screen?.suspension?.since)],
        ["revision", screen?.revision === undefined ? undefined : String(screen.revision)],
      ]),
      `The screen shows your notice instead of its content until screen resume ${id}; its playlist, schedule and settings are unchanged.`,
    ].join("\n"),
  };
}, true);

// End a suspension. Single screen only.
export const handleScreenResume = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("screen resume requires <id>.");
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/resume`, idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw suspendProblem(error, id);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Resumed screen ${id}`, [["revision", screen?.revision === undefined ? undefined : String(screen.revision)]]),
      "The screen shows its own content again.",
    ].join("\n"),
  };
}, true);

// Move the device paired as another screen onto this one. Always carries an
// idempotency key, like recovery confirm: it retires a key and archives a screen.
export const handleScreenReplace = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  const withId = flagString(args.flags, "with");
  if (!id || !withId) throw usageError("screen replace requires <id> and --with ID.");
  if (withId === id) throw usageError("--with must name another screen than <id>: the screen whose paired device takes over.");
  const body: ScreenReplaceWrite = { with: withId };
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/replace`, idempotent: true, body,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw replaceProblem(error, id, withId);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      humanLines(`Replaced the device of screen ${id} with the one paired as ${withId}`, [
        ["revision", screen?.revision === undefined ? undefined : String(screen.revision)],
      ]),
      `${id} keeps its name, tags, playlist, schedules and history on the new device. ${withId} is archived as replaced, and any key ${id} held retires after a fifteen-minute grace window.`,
    ].join("\n"),
  };
}, true);

// Cancel a reboot or reload that is still queued for an offline screen.
export const handleScreenCommandCancel = commandHandler(async (args, runtime, resolved) => {
  // positionals are [screen, command, cancel, ID, COMMAND_ID].
  const id = args.positionals[3];
  const commandId = args.positionals[4];
  if (!id || !commandId) throw usageError("screen command cancel requires <id> and <command_id>.");
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/cancel`, idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw commandCancelProblem(error, id);
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: `Cancelled command ${commandId} on ${id}: it is never sent.`,
  };
}, true);

function displayHuman(title: string, screen: Screen | undefined): string {
  return [title, ...displayLines(screen?.display, screen?.timezone), ...(screen?.revision !== undefined ? [`revision: ${screen.revision}`] : [])].join("\n");
}

export const handleScreenDisplay = commandHandler(async (args, runtime, resolved) => {
  // A trailing on|off positional is shorthand for --power.
  // positionals are [screen, display, set, ...ids].
  const last = args.positionals.at(-1);
  const trailing = args.positionals.length > 3 && (last === "on" || last === "off") ? last : undefined;
  const positionals = (trailing ? args.positionals.slice(0, -1) : args.positionals).slice(1);
  const flagPower = flagString(args.flags, "power");
  if (trailing && flagPower && trailing !== flagPower) throw usageError("screen display got two different powers; use --power on|off once.");
  const power = displayPower(flagPower ?? trailing);
  const target = screenTarget({ ...args, positionals }, "screen display");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display");
  const until = displayUntil(flagString(args.flags, "until"), flagString(args.flags, "for"), runtime.now());
  const write = { power, ...(until !== undefined ? { until } : {}) };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, `Fleet display ${power}`, target.selector, { type: "display", ...write });
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  let response;
  try {
    response = await client.call({
      method: "POST", path: `/api/screens/${encodeURIComponent(id)}/display`, idempotent: true, body: write,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw displayProblem(screenControlProblem(error, id), id);
  }
  const screen = response.body as Screen | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Display ${power} on ${id} ${until ? `until ${instantInZone(until, screen?.timezone)}` : "until the display schedule's next boundary, or until replaced"}`, screen),
  };
}, true);

export const handleScreenDisplayScheduleShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[3];
  if (!id) throw usageError("screen display-schedule show requires <id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await screenControlCall(client, id, { method: "GET", path: `/api/screens/${encodeURIComponent(id)}/display-schedule` });
  const view = response.body as ScreenDisplayScheduleView | undefined;
  let timezone: string | undefined;
  if (flagBool(args.flags, "human")) {
    try {
      timezone = ((await client.call({ method: "GET", path: `/api/screens/${encodeURIComponent(id)}` })).body as Screen | undefined)?.timezone;
    } catch {
      timezone = undefined;
    }
  }
  const display = view?.display ?? (view?.display_schedule ? { requested: "on" as const, source: "default" as const, schedule: view.display_schedule } : undefined);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Display schedule for ${id}`, ...(view?.display_schedule ? [] : ["No display schedule: the display stays on unless turned off."]), ...displayLines(display, timezone)].join("\n"),
  };
}, true);

export const handleScreenDisplayScheduleSet = commandHandler(async (args, runtime, resolved) => {
  const file = flagString(args.flags, "file");
  if (!file) throw usageError("screen display-schedule set requires --file FILE (or --file - for stdin).");
  const target = nestedScreenTarget(args, "screen display-schedule set");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display-schedule set");
  const write = displayScheduleWrite(await readAuthoringJson(file, runtime));
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet display schedule set", target.selector, { type: "set_display_schedule", ...write });
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  const response = await screenControlCall(client, id, {
    method: "PUT", path: `/api/screens/${encodeURIComponent(id)}/display-schedule`, idempotent: true, body: write,
    ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Set a ${write.windows.length}-window display schedule on ${id}${write.enabled ? "" : " (disabled: the display stays on)"}`, response.body as Screen | undefined),
  };
}, true);

export const handleScreenDisplayScheduleClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen display-schedule clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display-schedule clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet display schedule clear", target.selector, { type: "clear_display_schedule" });
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  const response = await screenControlCall(client, id, {
    method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/display-schedule`, idempotent: true,
    ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
  });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Cleared the display schedule on ${id}`, response.body as Screen | undefined),
  };
}, true);

export const handleScreenDisplayClear = commandHandler(async (args, runtime, resolved) => {
  const target = nestedScreenTarget(args, "screen display clear");
  if (target.kind === "fleet") rejectFleetRevision(args, "screen display clear");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  if (target.kind === "fleet") return screenFleetAction(client, runtime, "Fleet display clear", target.selector, { type: "display_clear" });
  const id = target.id;
  const revision = flagString(args.flags, "if-match");
  let response;
  try {
    response = await client.call({
      method: "DELETE", path: `/api/screens/${encodeURIComponent(id)}/display`, idempotent: true,
      ...(revision ? { headers: { "if-match": quotedRevision(revision) } } : {}),
    });
  } catch (error) {
    throw displayProblem(screenControlProblem(error, id), id);
  }
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: displayHuman(`Cleared the display override on ${id}`, response.body as Screen | undefined),
  };
}, true);

// ---- migrate: import from another signage system -------------------------------------------------

export const handleMigrateVendors = commandHandler(async (args) => {
  const id = args.positionals[2];
  const vendors = id === undefined ? sortedVendors() : [findVendor(id)];
  return {
    envelope: successEnvelope({ vendors: vendors.map(describeVendor) }),
    exitCode: ExitCode.Success,
    human: vendors.flatMap((vendor) => vendorLines(vendor)).join("\n"),
  };
}, false);

export const handleMigrateScan = commandHandler(async (args, runtime) => {
  const adapter = findVendor(flagString(args.flags, "from") ?? "");
  const resolvePath = (flag: string): string | undefined => {
    const value = flagString(args.flags, flag);
    return value === undefined ? undefined : path.resolve(runtime.cwd(), value);
  };
  const dir = await chooseDir(runtime, flagString(args.flags, "dir"), adapter.id);
  const files = resolvePath("files");
  const { report } = await runScan({
    adapter,
    flags: {
      ...(flagString(args.flags, "url") !== undefined ? { url: flagString(args.flags, "url")! } : {}),
      ...(flagString(args.flags, "region") !== undefined ? { region: flagString(args.flags, "region")! } : {}),
      ...(flagString(args.flags, "timezone") !== undefined ? { timezone: flagString(args.flags, "timezone")! } : {}),
      ...(files !== undefined ? { files } : {}),
    },
    ...(resolvePath("credentials") !== undefined ? { credentialsFile: resolvePath("credentials")! } : {}),
    dir,
    env: runtime.env,
    now: runtime.now,
    http: vendorHttpFor(runtime, adapter),
  });
  return {
    envelope: successEnvelope({ ...report, dir: dir.dir, scan_file: dir.scanFile }),
    exitCode: ExitCode.Success,
    human: migrationReportLines(report, dir.dir).join("\n"),
  };
}, false);

async function migrateProjectId(client: ApiClient, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  const id = ((await client.call({ method: "GET", path: "/api/project" })).body as Project | undefined)?.id;
  if (typeof id !== "string" || id.length === 0) throw usageError("The project id is unavailable, so the migration directory cannot be bound to it.");
  return id;
}

export const handleMigrateApply = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const dir = await chooseDir(runtime, flagString(args.flags, "dir"));
  const scan = await dir.readScan();
  const adapter = findVendor(scan.vendor);
  const concurrency = flagNumber(args.flags, "concurrency") ?? UPLOAD_BATCH_DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < UPLOAD_BATCH_MIN_CONCURRENCY || concurrency > UPLOAD_BATCH_MAX_CONCURRENCY) {
    throw usageError(`--concurrency must be a whole number from ${UPLOAD_BATCH_MIN_CONCURRENCY} to ${UPLOAD_BATCH_MAX_CONCURRENCY}.`);
  }
  const canvasText = flagString(args.flags, "canvas");
  const canvasMatch = canvasText === undefined ? undefined : /^(\d+)x(\d+)$/i.exec(canvasText);
  const onlyText = flagString(args.flags, "only");
  const only = new Set<OnlyKind>(onlyText === undefined ? ONLY_KINDS : (onlyText.split(",") as OnlyKind[]));
  const credentialsFile = flagString(args.flags, "credentials") === undefined ? undefined : path.resolve(runtime.cwd(), flagString(args.flags, "credentials")!);
  const folder = flagString(args.flags, "folder");
  if (folder !== undefined) mediaFolderId(folder, "--folder");
  const options: ApplyOptions = {
    dryRun: flagBool(args.flags, "dry-run"),
    only,
    ...(folder !== undefined ? { folder } : {}),
    canvas: canvasMatch ? { width: Number(canvasMatch[1]), height: Number(canvasMatch[2]) } : { width: 1920, height: 1080 },
    concurrency,
    noTranscode: flagBool(args.flags, "no-transcode"),
    transcodeOptions: transcodeOptionsFromArgs(args),
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: 1000,
  };
  const json = !flagBool(args.flags, "human");
  const secrets: string[] = [];
  const result = await runApply({
    runtime,
    client,
    dir,
    scan,
    vendorName: adapter.name,
    apiUrl: resolved.apiUrl.replace(/\/+$/, ""),
    projectId: await migrateProjectId(client, resolved.projectId),
    openSession: async () => {
      const credentials = await loadCredentials(adapter, { ...(credentialsFile !== undefined ? { file: credentialsFile } : {}), env: runtime.env });
      secrets.push(...Object.values(credentials));
      const files = scan.inputs.files !== undefined ? await openLocalFiles(scan.inputs.files) : undefined;
      return adapter.open({
        ...(scan.inputs.url !== undefined ? { url: scan.inputs.url } : {}),
        ...(scan.inputs.region !== undefined ? { region: scan.inputs.region } : {}),
        ...(scan.inputs.timezone !== undefined ? { timezone: scan.inputs.timezone } : {}),
        credentials,
        http: vendorHttpFor(runtime, adapter),
        ...(files ? { files } : {}),
        now: runtime.now,
      });
    },
    openFiles: async () => {
      if (scan.inputs.files === undefined) throw usageError("This scan used no --files, so there are no local originals to import.");
      return openLocalFiles(scan.inputs.files);
    },
    reporter: progressReporterFor(args, runtime),
    rerun: shellQuote([
      "screenrig", "migrate", "apply", "--dir", dir.dir,
      ...(onlyText !== undefined ? ["--only", onlyText] : []),
      ...(folder !== undefined ? ["--folder", folder] : []),
      ...(canvasText !== undefined ? ["--canvas", canvasText] : []),
      ...(credentialsFile !== undefined ? ["--credentials", credentialsFile] : []),
      ...(flagString(args.flags, "concurrency") !== undefined ? ["--concurrency", String(concurrency)] : []),
      ...(options.noTranscode ? ["--no-transcode"] : []),
    ]),
    progress: (event) => {
      runtime.stderr.write(json ? `${JSON.stringify(event)}\n` : `screenrig: migrate ${String(event.phase)} ${String(event.done)}/${String(event.total)}\n`);
    },
    secrets,
  }, options);
  return {
    envelope: successEnvelope(result.data, { request_id: client.requestId, warnings: result.warnings }),
    exitCode: result.exitCode,
    human: result.human,
  };
}, true);

export const handleMigratePair = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const rawCode = args.positionals.slice(2).join(" ");
  if (!rawCode) throw usageError("migrate pair requires CODE.");
  const code = canonicalPairingCode(rawCode, "migrate pair CODE");
  const dir = await chooseDir(runtime, flagString(args.flags, "dir"));
  const scan = await dir.readScan();
  const result = await runPair({
    runtime, client, dir, scan,
    apiUrl: resolved.apiUrl.replace(/\/+$/, ""),
    projectId: await migrateProjectId(client, resolved.projectId),
    code,
    screen: flagString(args.flags, "screen") ?? "",
  });
  return { envelope: successEnvelope(result.data, { request_id: client.requestId }), exitCode: ExitCode.Success, human: result.human };
}, true);

// Reports: GET /api/reports builds rollups and statements from the project's
// aggregates (folder, screen and tag groups, alert history, proof of play) and
// writes any of them as JSON, CSV, XLSX or PDF. Report subscriptions mail a
// report to project members on a schedule.
const REPORTS_PATH = "/api/reports";
const REPORT_SUBSCRIPTIONS_PATH = "/api/report-subscriptions";

export const handleReportsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: REPORTS_PATH });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportCatalogLines(response.body as Parameters<typeof reportCatalogLines>[0]).join("\n"),
  };
});

export const handleReportsShow = commandHandler(async (args, runtime, resolved) => {
  const kind = reportKind(args.positionals[2], "reports show");
  const query = reportQuery(args);
  const file = await reportFileOf(args, runtime, resolved, `${REPORTS_PATH}/${kind}`, query, `${kind.replaceAll("_", "-")}${query.to ? `-${query.to}` : ""}`, `${kind} report`);
  if (file) return file;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${REPORTS_PATH}/${kind}`, query });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reportTableLines(response.body as Parameters<typeof reportTableLines>[0]).join("\n"),
  };
});

export const handleReportSubscriptionsList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: REPORT_SUBSCRIPTIONS_PATH });
  const body = response.body as { items?: Parameters<typeof subscriptionListLines>[0] } | undefined;
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: subscriptionListLines(body?.items).join("\n") };
});

export const handleReportSubscriptionsShow = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}` });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: subscriptionLines(response.body as Parameters<typeof subscriptionLines>[0]).join("\n") };
});

/** The write body the subscription flags name: only the members given. */
function reportSubscriptionBody(args: ParsedArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const name = flagString(args.flags, "name");
  const format = flagString(args.flags, "format");
  const recipients = flagString(args.flags, "recipients");
  const filters = reportFilters(flagString(args.flags, "filter"));
  const schedule = reportSchedule(args);
  if (name !== undefined) body.name = name;
  if (format !== undefined) body.format = format;
  if (recipients !== undefined) body.recipients = reportRecipients(recipients);
  if (filters !== undefined) body.filters = filters;
  if (schedule !== undefined) body.schedule = schedule;
  if (flagBool(args.flags, "pause")) body.enabled = false;
  if (flagBool(args.flags, "resume")) body.enabled = true;
  return body;
}

export const handleReportSubscriptionsCreate = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const body = { ...reportSubscriptionBody(args), kind: reportKind(flagString(args.flags, "kind"), "reports subscriptions create --kind") };
  const response = await client.call({ method: "POST", path: REPORT_SUBSCRIPTIONS_PATH, body, idempotent: true });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: ["Created", ...subscriptionLines(response.body as Parameters<typeof subscriptionLines>[0])].join("\n") };
});

export const handleReportSubscriptionsUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "update");
  const body = reportSubscriptionBody(args);
  if (Object.keys(body).length === 0) throw usageError("reports subscriptions update needs at least one change: --name, --cadence, --format, --recipients, --filter, --pause or --resume.");
  const revision = flagString(args.flags, "if-match");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "PATCH", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}`, body, idempotent: true,
    headers: revision ? { "if-match": quotedRevision(revision) } : undefined,
  });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: ["Updated", ...subscriptionLines(response.body as Parameters<typeof subscriptionLines>[0])].join("\n") };
});

export const handleReportSubscriptionsDelete = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "DELETE", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}`, idempotent: true });
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted report subscription ${id}. Nothing more is sent.`,
  };
});

export const handleReportSubscriptionsSend = commandHandler(async (args, runtime, resolved) => {
  const id = reportSubscriptionId(args.positionals[3], "send");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `${REPORT_SUBSCRIPTIONS_PATH}/${id}/send`, idempotent: true });
  const sent = response.body as Parameters<typeof subscriptionLines>[0];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [sent?.last_status === "delivered" ? "Sent now" : "Not delivered", ...subscriptionLines(sent)].join("\n"),
  };
});

/**
 * `project export DIR`: every read route a project has, written to a directory
 * in open formats (src/project-export.ts). Progress goes to stderr; the envelope
 * lists the sections, every file with its SHA-256 and the media counts.
 */
export const handleProjectExport = commandHandler(async (args, runtime, resolved) => {
  const directory = args.positionals[2];
  if (!directory) throw usageError("project export requires a directory: screenrig project export ./export.");
  const since = flagString(args.flags, "since");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const api: ExportApi = {
    get: async (pathName, query) => (await client.call({ method: "GET", path: pathName, query })).body,
    list: async (pathName, query) => {
      const response = await client.listAll(pathName, query, { uncapped: true });
      const items = (response.body as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items : [];
    },
    file: async (pathName, query, target, contentType) => {
      await downloadToFile(client, { path: pathName, query, target, contentType, what: pathName });
    },
    append: async (pathName, offset, target) => {
      const response = await client.download({ method: "GET", path: pathName, headers: offset > 0 ? { range: `bytes=${offset}-` } : undefined });
      if (!response.body) throw usageError(`${pathName} returned no body.`);
      // A server that ignored the range sent the whole object: start the file over.
      const handle = await open(target, offset > 0 && response.status === 206 ? "a" : "w", 0o600);
      try {
        for await (const chunk of response.body) {
          let written = 0;
          while (written < chunk.byteLength) written += (await handle.write(chunk, written, chunk.byteLength - written)).bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
  const result = await runProjectExport(api, {
    directory: path.resolve(runtime.cwd(), directory), media: !flagBool(args.flags, "no-media"), since, now: runtime.now(),
    progress: (line) => runtime.stderr.write(`${line}\n`),
  });
  const warnings: Warning[] = result.sections.filter((section) => section.status !== "ok").map((section) => ({
    code: section.status === "failed" ? "export_section_failed" : "export_section_skipped",
    message: `${section.name}: ${section.detail ?? section.status}`,
  }));
  const data = {
    directory: result.directory, complete: result.failed === 0, sections: result.sections, media: result.media,
    files: result.files.length, bytes: result.files.reduce((sum, file) => sum + file.bytes, 0),
  };
  return {
    envelope: successEnvelope(data, { request_id: client.requestId, warnings }),
    exitCode: ExitCode.Success,
    human: [
      `Project exported to ${result.directory}`,
      `  files: ${data.files} (${formatBytes(data.bytes)}), listed in export.json with their SHA-256`,
      `  media: ${result.media.listed} listed, ${result.media.downloaded} downloaded, ${result.media.kept} already complete, ${result.media.failed} failed`,
      ...result.sections.filter((section) => section.status !== "ok").map((section) => `  ${section.status}: ${section.name}: ${section.detail ?? ""}`),
      result.failed > 0 ? "  Run the same command again to continue: finished files are kept." : "  Run the same command again at any time to refresh the copy.",
    ].join("\n"),
  };
});
