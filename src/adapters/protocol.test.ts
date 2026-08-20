import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ARCHIVE_LIMITS,
  limitsFromCapabilities,
  type Capabilities,
} from "./protocol.js";

const GENERATED_CONTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/protocol/openapi.gen.ts",
);
const OPENAPI_CONTRACT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/openapi.yaml",
);

function interfaceBody(source: string, name: string): string {
  const marker = `export interface ${name} {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `generated contract is missing ${name}`);
  let depth = 0;
  for (let i = start + "export interface ".length; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      if (depth === 1) {
        const bodyStart = i + 1;
        for (let j = bodyStart; j < source.length; j++) {
          const inner = source[j];
          if (inner === "{") depth += 1;
          else if (inner === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(bodyStart, j);
          }
        }
      }
    }
  }
  throw new Error(`unterminated generated interface ${name}`);
}

function quotedProperties(body: string): string[] {
  return [...body.matchAll(/"([A-Za-z0-9_]+)"\s*\??\s*:/g)].map((match) => {
    const name = match[1];
    assert.ok(name);
    return name;
  });
}

test("adapter shapes mirror generated OpenAPI contract fields and Capabilities literals", () => {
  const source = readFileSync(GENERATED_CONTRACT, "utf8");

  const capabilities = interfaceBody(source, "Capabilities");
  assert.deepEqual(quotedProperties(capabilities), [
    "account_content_bytes",
    "api_version",
    "application_compressed_bytes",
    "application_expanded_bytes",
    "application_file_bytes",
    "application_file_count",
    "application_package_bytes",
    "application_path_bytes",
    "application_path_depth",
    "features",
    "media_image_bytes",
    "playlist_max_items_per_page",
    "playlist_max_media_per_selector",
    "playlist_max_pages",
    "protocol_version",
    "screens_per_account",
    "transition_max_duration_ms",
  ]);
  assert.match(capabilities, /"account_content_bytes": 0/);
  assert.match(capabilities, /"application_compressed_bytes": 104857600/);
  assert.match(capabilities, /"application_expanded_bytes": 262144000/);
  assert.match(capabilities, /"application_file_bytes": 33554432/);
  assert.match(capabilities, /"application_file_count": 5000/);
  assert.match(capabilities, /"application_package_bytes": 272629760/);
  assert.match(capabilities, /"application_path_bytes": 255/);
  assert.match(capabilities, /"application_path_depth": 16/);
  assert.match(capabilities, /"media_image_bytes": 20971520/);
  assert.match(capabilities, /"playlist_max_items_per_page": 24/);
  assert.match(capabilities, /"playlist_max_media_per_selector": 32/);
  assert.match(capabilities, /"playlist_max_pages": 100/);
  assert.match(capabilities, /"screens_per_account": 100/);
  assert.match(capabilities, /"transition_max_duration_ms": 60000/);
  assert.doesNotMatch(capabilities, /limits/);
  assert.doesNotMatch(capabilities, /application_archive_bytes/);

  assert.deepEqual(quotedProperties(interfaceBody(source, "Operation")), [
    "created_at",
    "error",
    "id",
    "kind",
    "request_id",
    "result",
    "state",
    "updated_at",
  ]);
  // release_id is required, not optional. The server has always returned it and
  // it is the only handle a playlist placement accepts, so a caller must never
  // have to poll the operation to learn it.
  const operationAccepted = interfaceBody(source, "OperationAccepted");
  assert.deepEqual(quotedProperties(operationAccepted), [
    "id",
    "operation_id",
    "release_id",
  ]);
  assert.match(operationAccepted, /"release_id": string/);
  assert.doesNotMatch(operationAccepted, /"release_id"\?/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "Media")), [
    "bytes",
    "codecs",
    "content_type",
    "created_at",
    "duration_ms",
    "filename",
    "height",
    "id",
    "kind",
    "operation_id",
    "revision",
    "sha256",
    "state",
    "tag",
    "updated_at",
    "width",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaUploadDeclaration")), [
    "bytes",
    "content_type",
    "filename",
    "sha256",
    "tag",
  ]);
  assert.match(
    readFileSync(OPENAPI_CONTRACT, "utf8"),
    /Read media_image_bytes from the capabilities document to preflight the image bound/,
  );
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaUploadSession")), [
    "expires_at",
    "headers",
    "id",
    "method",
    "operation",
    "upload_url",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaCommit")), [
    "bytes",
    "content_type",
    "sha256",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "MediaTagPatch")), [
    "tag",
  ]);
  const account = interfaceBody(source, "Account");
  assert.deepEqual(quotedProperties(account), [
    "content_limit_bytes",
    "created_at",
    "credit_remaining",
    "id",
    "reserved_bytes",
    "revision",
    "screen_count",
    "screen_limit",
    "status",
    "updated_at",
    "used_bytes",
  ]);
  assert.match(account, /"status": "active" \| "cancelled" \| "deleted"/);
  assert.doesNotMatch(source, /credit_remaining_mcr/);
  assert.doesNotMatch(source, /AccountAccountings/);
  assert.doesNotMatch(source, /CreditAccountingHour/);
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");
  assert.doesNotMatch(openapi, /credit_remaining_mcr/);
  assert.match(openapi, /ScreenRig-Credits-Remaining/);
  assert.match(openapi, /ScreenRig-Credits-Reset/);
  assert.match(openapi, /ScreenRig-Credits-Included/);
  assert.doesNotMatch(openapi, /\/api\/v1\/account\/accountings/);
  assert.doesNotMatch(openapi, /AccountAccountings/);
  assert.doesNotMatch(openapi, /CreditAccountingHour/);
  assert.match(openapi, /\/api\/v1\/playback:/);
  const chrome = interfaceBody(source, "RuntimeChrome");
  assert.deepEqual(quotedProperties(chrome), ["banner", "schema_version"]);
  assert.match(chrome, /"banner": null/);
  assert.match(chrome, /"schema_version": 1/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "CLIEnrollment")), [
    "account",
    "issuance_expires_at",
    "issuance_id",
    "token",
  ]);
  const enrollmentRequest = interfaceBody(source, "CLIEnrollmentRequest");
  assert.deepEqual(quotedProperties(enrollmentRequest), ["beta_key", "client_id"]);
  assert.match(enrollmentRequest, /"beta_key"\?: string/);
  assert.match(enrollmentRequest, /"client_id": string/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "PairScreen")), ["code", "label"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "PairingClaim")), ["public_url", "screen"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ProvisionScreen")), ["label"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ScreenProvisioning")), [
    "expires_at", "provisioning_url", "public_url", "screen",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "BrowserLinkClaimRequest")), ["code"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "BrowserLinkClaim")), ["screen", "session_id", "status"]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "BrowserLinkClaimScreen")), ["id", "public_id", "public_url", "state"]);
  const screen = interfaceBody(source, "Screen");
  assert.deepEqual(quotedProperties(screen), [
    "content_access_generation",
    "created_at",
    "id",
    "label",
    "last_ip",
    "last_online_at",
    "manifest_revision",
    "observation",
    "online",
    "playlist_id",
    "public_id",
    "revision",
    "state",
    "timezone",
    "updated_at",
  ]);
  assert.match(screen, /"state": "pairing_pending" \| "active"/);
  // A screen has no timezone until one is set, so it must stay optional. The
  // local schedule preflight reads exactly this member.
  assert.match(screen, /"timezone"\?: string/);
  // Observation is player-reported and absent until the first report.
  assert.match(screen, /"observation"\?: ScreenObservation/);
  // online is required and false until the first paired runtime connect.
  // last_online_at and last_ip stay optional until that first connect.
  assert.match(screen, /"online": boolean/);
  assert.doesNotMatch(screen, /"online"\?: boolean/);
  assert.match(screen, /"last_online_at"\?: string/);
  assert.match(screen, /"last_ip"\?: string/);
  assert.doesNotMatch(source, /Bootstrap/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ScreenPatch")), [
    "name",
    "playlist_id",
    "timezone",
  ]);
  const toastWrite = interfaceBody(source, "ScreenToastWrite");
  assert.deepEqual(quotedProperties(toastWrite), ["duration_ms", "level", "text"]);
  assert.match(toastWrite, /"level": "error" \| "alert" \| "info"/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "ScreenToastAccepted")), ["expires_at"]);
  const toastDetails = interfaceBody(source, "ScreenToastDetails");
  assert.deepEqual(quotedProperties(toastDetails), ["duration_ms", "expires_at", "level", "text"]);
  assert.match(toastDetails, /"level": "error" \| "alert" \| "info"/);
  assert.doesNotMatch(toastWrite, /color/);
  assert.doesNotMatch(toastDetails, /color/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "FeedbackWrite")), [
    "body",
    "context",
    "title",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(source, "FeedbackContext")), [
    "cli_version",
    "command",
    "platform",
  ]);
  const submission = interfaceBody(source, "FeedbackSubmission");
  assert.deepEqual(quotedProperties(submission), [
    "body",
    "context",
    "created_at",
    "id",
    "kind",
    "title",
  ]);
  assert.match(submission, /"kind": "bug" \| "feature"/);
  // Submissions are immutable, so the contract must never grow a revision.
  assert.doesNotMatch(submission, /revision/);
  assert.deepEqual(quotedProperties(interfaceBody(source, "FeedbackList")), ["items"]);
  const capabilitiesFromContract: Capabilities = {
    account_content_bytes: 0,
    api_version: "0.2.0",
    application_compressed_bytes: 104857600,
    application_expanded_bytes: 262144000,
    application_file_bytes: 33554432,
    application_file_count: 5000,
    application_path_bytes: 255,
    application_path_depth: 16,
    features: {},
    media_image_bytes: 20971520,
    playlist_max_items_per_page: 24,
    playlist_max_media_per_selector: 32,
    playlist_max_pages: 100,
    protocol_version: "1",
    screens_per_account: 100,
    transition_max_duration_ms: 60000,
  };
  const limits = limitsFromCapabilities(capabilitiesFromContract);
  assert.equal(limits.application_archive_bytes, capabilitiesFromContract.application_compressed_bytes);
  assert.equal(limits.application_archive_bytes, DEFAULT_ARCHIVE_LIMITS.application_archive_bytes);
  assert.deepEqual(limits, DEFAULT_ARCHIVE_LIMITS);
});

test("local enrollment request adapter accepts optional beta_key", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"),
    "utf8",
  );
  assert.match(source, /export interface CLIEnrollmentRequest \{[\s\S]*?beta_key\?: string;/);
});

test("screen observation is optional, read-only, and absent from ScreenPatch", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");
  const adapter = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"),
    "utf8",
  );
  const commands = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/commands.ts"),
    "utf8",
  );

  const screen = interfaceBody(generated, "Screen");
  assert.match(screen, /"observation"\?: ScreenObservation/);
  assert.doesNotMatch(screen, /"observation": ScreenObservation/);

  const observation = interfaceBody(generated, "ScreenObservation");
  assert.deepEqual(quotedProperties(observation), ["observed_at", "surfaces"]);

  const surface = interfaceBody(generated, "ScreenObservationSurface");
  assert.deepEqual(quotedProperties(surface), [
    "height",
    "id",
    "pixel_ratio",
    "presentation",
    "width",
  ]);
  assert.match(surface, /"presentation": "output" \| "windowed"/);

  const patch = interfaceBody(generated, "ScreenPatch");
  assert.deepEqual(quotedProperties(patch), ["name", "playlist_id", "timezone"]);
  assert.doesNotMatch(patch, /observation/);
  assert.doesNotMatch(interfaceBody(generated, "PairScreen"), /observation/);
  assert.doesNotMatch(interfaceBody(adapter, "ScreenPatch"), /observation/);
  assert.match(adapter, /observation\?: ScreenObservation/);

  const details = interfaceBody(generated, "ScreenSurfaceChangedDetails");
  assert.deepEqual(quotedProperties(details), ["observed_at", "surfaces"]);

  assert.match(openapi, /\/runtime\/v1\/observation:/);
  assert.match(openapi, /operationId: putRuntimeObservation/);
  assert.match(openapi, /ScreenPatch cannot write it/);
  assert.match(openapi, /screen\.surface_changed/);
  assert.match(openapi, /surfaces: \{ type: array, minItems: 1, maxItems: 1/);
  // The CLI reads observation from GET /api/v1/screens/{id}. Players PUT the
  // runtime route; this command surface must not.
  assert.doesNotMatch(commands, /\/runtime\/v1\/observation/);
  assert.match(commands, /screen update requires <id>, --if-match, and --name, --playlist-id, or --timezone/);
});

test("screen online is required, last_online_at and last_ip are optional, and ScreenPatch cannot write them", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");
  const adapter = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"),
    "utf8",
  );
  const commands = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/commands.ts"),
    "utf8",
  );

  const screen = interfaceBody(generated, "Screen");
  assert.match(screen, /"online": boolean/);
  assert.doesNotMatch(screen, /"online"\?: boolean/);
  assert.match(screen, /"last_online_at"\?: string/);
  assert.match(screen, /"last_ip"\?: string/);

  const patch = interfaceBody(generated, "ScreenPatch");
  assert.deepEqual(quotedProperties(patch), ["name", "playlist_id", "timezone"]);
  assert.doesNotMatch(patch, /online|last_online_at|last_ip/);
  assert.doesNotMatch(interfaceBody(generated, "PairScreen"), /online|last_online_at|last_ip/);
  assert.doesNotMatch(interfaceBody(adapter, "ScreenPatch"), /online|last_online_at|last_ip/);
  assert.match(adapter, /online: boolean/);
  assert.match(adapter, /last_online_at\?: string/);
  assert.match(adapter, /last_ip\?: string/);

  const screenSchema = openapi.slice(openapi.indexOf("    Screen:\n"), openapi.indexOf("    ScreenList:"));
  assert.match(screenSchema, /state, online, created_at, updated_at/);
  assert.match(screenSchema, /not a player heartbeat or presence\.write report/);
  assert.match(screenSchema, /maxLength: 45/);
  assert.match(screenSchema, /ScreenPatch, pairing bodies, session[\s\S]*runtime manifest cannot write it/);
  assert.doesNotMatch(commands, /--online|--last-online-at|--last-ip/);
  assert.match(commands, /screen update requires <id>, --if-match, and --name, --playlist-id, or --timezone/);
});

test("published problem codes include payment_required at 402", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  const listed = source.match(/x-problem-codes: \[([^\]]+)\]/);
  assert.ok(listed?.[1], "missing x-problem-codes");
  assert.deepEqual(listed[1].split(", ").map((code) => code.trim()), [
    "internal_error",
    "invalid_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "method_not_allowed",
    "idempotency_mismatch",
    "credential_issuance_expired",
    "provisioning_invalid",
    "provisioning_expired",
    "provisioning_consumed",
    "provisioning_exchange_mismatch",
    "browser_already_paired",
    "handoff_code_invalid",
    "handoff_code_expired",
    "handoff_session_rate_limited",
    "handoff_session_conflict",
    "browser_link_not_claimed",
    "browser_link_account_mismatch",
    "origin_not_allowed",
    "resource_conflict",
    "revision_conflict",
    "invalid_range",
    "quota_exceeded",
    "payment_required",
    "rate_limited",
    "dependency_unavailable",
    "schema_incompatible",
    "not_ready",
    "screenshot_unavailable",
  ]);
  assert.match(source, /payment_required/);
  assert.doesNotMatch(source, /stripe|x402/i);
});

test("playlist writes send a media selector and media_end, not a singular media_id or video_end", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  const imageWrite = interfaceBody(generated, "PlaylistImageContentWrite");
  assert.deepEqual(quotedProperties(imageWrite), ["alt", "dwell_ms", "selector", "type"]);
  assert.match(imageWrite, /"type": "image"/);
  assert.doesNotMatch(imageWrite, /"media_id"/);

  const videoWrite = interfaceBody(generated, "PlaylistVideoContentWrite");
  assert.deepEqual(quotedProperties(videoWrite), ["loop", "muted", "selector", "type"]);
  assert.match(videoWrite, /"type": "video"/);
  assert.doesNotMatch(videoWrite, /"media_id"/);

  const selectorById = interfaceBody(generated, "PlaylistMediaSelectorByID");
  assert.deepEqual(quotedProperties(selectorById), ["by", "media_id", "one_at_a_time"]);
  assert.match(selectorById, /"by": "id"/);

  const mediaEndWrite = interfaceBody(generated, "PlaylistMediaEndAdvanceWrite");
  assert.deepEqual(quotedProperties(mediaEndWrite), ["max_ms", "mode"]);
  assert.match(mediaEndWrite, /"mode": "media_end"/);

  const runtimeAdvance = interfaceBody(generated, "RuntimeAdvance");
  assert.match(runtimeAdvance, /"mode": "duration" \| "application" \| "media_end"/);

  assert.doesNotMatch(generated, /PlaylistVideoEndAdvance/);
  assert.doesNotMatch(generated, /video_end/);
  assert.match(openapi, /PlaylistImageContentWrite:[\s\S]*?required: \[type, selector\]/);
  assert.match(openapi, /PlaylistVideoContentWrite:[\s\S]*?required: \[type, selector\]/);
  assert.match(openapi, /PlaylistMediaEndAdvanceWrite:[\s\S]*?enum: \[media_end\]/);
  assert.doesNotMatch(openapi, /PlaylistVideoEndAdvance/);
  assert.doesNotMatch(openapi, /enum: \[video_end\]/);
});

test("playlist and runtime placements are image, video, iframe, and application only", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  assert.match(
    generated,
    /export type PlaylistPlacementWrite = PlaylistApplicationPlacementWrite \| PlaylistImagePlacementWrite \| PlaylistVideoPlacementWrite \| PlaylistIframePlacementWrite;/,
  );
  assert.match(
    generated,
    /export type PlaylistPlacement = PlaylistApplicationPlacement \| PlaylistImagePlacement \| PlaylistVideoPlacement \| PlaylistIframePlacement;/,
  );
  assert.match(
    generated,
    /export type RuntimePlacement = RuntimeApplicationPlacement \| RuntimeImagePlacement \| RuntimeVideoPlacement \| RuntimeIframePlacement;/,
  );
  for (const name of [
    "PlaylistTextPlacementWrite",
    "PlaylistBoxPlacementWrite",
    "PlaylistLinePlacementWrite",
    "PlaylistTextContent",
    "PlaylistBoxContent",
    "PlaylistLineContent",
    "RuntimeTextPlacement",
    "RuntimeBoxPlacement",
    "RuntimeLinePlacement",
  ]) {
    assert.doesNotMatch(generated, new RegExp(`export (type|interface) ${name}\\b`));
    assert.doesNotMatch(openapi, new RegExp(`${name}:`));
  }
  assert.doesNotMatch(openapi, /enum: \[text\]/);
  assert.doesNotMatch(openapi, /enum: \[box\]/);
  assert.doesNotMatch(openapi, /enum: \[line\]/);
});

test("an application carries no state of its own and reports its newest ready release", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  // Publish state lives on the operation and the release, never on the
  // application. Anything that wants a placeable handle reads
  // latest_ready_release, which is absent until a first publish is ready.
  const application = interfaceBody(generated, "Application");
  assert.deepEqual(quotedProperties(application), [
    "created_at",
    "id",
    "latest_ready_release",
    "name",
    "revision",
    "updated_at",
  ]);
  assert.match(application, /"latest_ready_release"\?: string/);
  assert.doesNotMatch(application, /"state"/);
  assert.doesNotMatch(application, /"release_id"/);
  assert.match(openapi, /Application: \{ type: object, additionalProperties: false/);
});

test("canvas background is a solid color or a top-to-bottom linear gradient", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  assert.match(generated, /export type CanvasBackground = CanvasColor \| LinearGradientBackground/);
  const gradient = interfaceBody(generated, "LinearGradientBackground");
  assert.deepEqual(quotedProperties(gradient), ["stops", "type"]);
  assert.match(gradient, /"type": "linear"/);
  const stop = interfaceBody(generated, "LinearGradientStop");
  assert.deepEqual(quotedProperties(stop), ["at", "color"]);
  assert.match(interfaceBody(generated, "PlaylistCanvas"), /"background": CanvasBackground/);

  assert.match(openapi, /CanvasBackground:[\s\S]*?oneOf:/);
  assert.match(openapi, /LinearGradientBackground:[\s\S]*?enum: \[linear\]/);
  assert.match(openapi, /There is no angle field/);
  assert.doesNotMatch(openapi, /background: \{ type: string, pattern: "\^#\[0-9A-F\]\{8\}\$"/);
});

test("page visibility is a scheduling sibling of advance and needs a screen timezone", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  // The CLI never builds a schedule; it only detects the key, so presence on
  // both the write and read page shapes is the whole dependency.
  assert.match(interfaceBody(generated, "PlaylistPageWrite"), /"visibility"\?: PageVisibility/);
  assert.match(interfaceBody(generated, "PlaylistPage"), /"visibility"\?: PageVisibility/);

  // visibility is a sibling of advance. It is deliberately not part of
  // screenrig.canvas/v1, so it must never appear inside the canvas schema.
  assert.match(openapi, /PageVisibility:[\s\S]*?required: \[enabled\]/);
  assert.match(openapi, /at least one page with no visibility field/);

  // A civil rule needs a zone, so the schedule and the screen timezone ship
  // together. Both stay optional; a screen has none until one is set.
  const visibility = interfaceBody(generated, "PageVisibility");
  assert.deepEqual(quotedProperties(visibility), ["enabled", "from", "until", "windows"]);
  assert.match(visibility, /"enabled": boolean/);
  const window = interfaceBody(generated, "PageVisibilityWindow");
  assert.deepEqual(quotedProperties(window), ["days", "end", "start"]);
  assert.match(window, /"mon" \| "tue" \| "wed" \| "thu" \| "fri" \| "sat" \| "sun"/);
  assert.match(interfaceBody(generated, "ScreenPatch"), /"timezone"\?: string/);
  assert.match(interfaceBody(generated, "RuntimeManifest"), /"timezone"\?: string/);
});

test("toast contract is a closed POST with idempotency, no queue, and no colour fields", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  const start = source.indexOf("/api/v1/screens/{id}/toast:");
  const end = source.indexOf("/api/v1/screens/{id}/screenshot:");
  assert.notEqual(start, -1, "missing toast route");
  const route = source.slice(start, end);
  assert.match(route, /post:/);
  assert.doesNotMatch(route, /get:/);
  assert.doesNotMatch(route, /patch:/);
  assert.doesNotMatch(route, /put:/);
  assert.doesNotMatch(route, /delete:/);
  assert.match(route, /IdempotencyKey/);
  assert.match(route, /"202":/);
  assert.match(route, /RateLimitedProblem/);
  assert.match(route, /not a placement/);
  assert.match(route, /screen\.toast/);
  assert.match(route, /expires_at/);
  assert.doesNotMatch(route, /color/);
  assert.match(source, /ScreenToastWrite:[\s\S]*?required: \[level, text\]/);
  assert.match(source, /level: \{ type: string, enum: \[error, alert, info\]/);
  assert.match(source, /duration_ms: \{ type: integer, minimum: 2000, maximum: 60000, default: 10000/);
  assert.doesNotMatch(source.slice(source.indexOf("ScreenToastWrite:"), source.indexOf("ScreenToastAccepted:")), /color/);
});

test("screenshot contract is latest-wins POST, status GET, and binary WebP GET", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  const start = source.indexOf("/api/v1/screens/{id}/screenshot:");
  const end = source.indexOf("/api/v1/events:");
  assert.notEqual(start, -1, "missing screenshot route");
  const route = source.slice(start, end);
  assert.match(route, /operationId: requestScreenScreenshot/);
  assert.match(route, /operationId: getScreenScreenshot/);
  assert.match(route, /operationId: getScreenScreenshotStatus/);
  assert.match(route, /IdempotencyKey/);
  assert.match(route, /Latest-wins/);
  assert.match(route, /image\/webp/);
  assert.match(route, /screenshot_unavailable/);
  assert.match(route, /resource_conflict/);
  assert.match(source, /ScreenshotCaptureID: \{ type: string, pattern: "\^shot_\[A-Za-z0-9_-\]\{16,64\}\$"/);
  assert.match(source, /x-problem-codes: \[[^\]]+screenshot_unavailable\]/);
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  assert.deepEqual(quotedProperties(interfaceBody(generated, "ScreenScreenshotAccepted")), [
    "capture_id",
    "expires_at",
  ]);
  assert.deepEqual(quotedProperties(interfaceBody(generated, "ScreenScreenshotStatus")), [
    "bytes",
    "capture_id",
    "captured_at",
    "expires_at",
    "height",
    "sha256",
    "state",
    "width",
  ]);
  assert.match(interfaceBody(generated, "ScreenScreenshotStatus"), /"idle" \| "pending" \| "ready" \| "timed_out"/);
  assert.doesNotMatch(interfaceBody(generated, "ScreenScreenshotStatus"), /pixels|base64|object_key/);
});

test("feedback contract is account-scoped, immutable, idempotent, and closed to argument values", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");

  // The kind is carried by the route, so there are exactly two write paths and
  // neither takes a kind in the body.
  for (const route of ["/api/v1/feedback/bugs:", "/api/v1/feedback/features:"]) {
    assert.ok(source.includes(route), `missing feedback route ${route}`);
  }
  assert.match(source, /FeedbackWrite:[\s\S]*?required: \[title, body\]/);
  assert.doesNotMatch(source.slice(source.indexOf("FeedbackWrite:"), source.indexOf("FeedbackContext:")), /kind/);

  // Writes require Idempotency-Key so an exact retry cannot duplicate a report.
  const bugs = source.slice(source.indexOf("/api/v1/feedback/bugs:"), source.indexOf("/api/v1/feedback/features:"));
  assert.match(bugs, /parameters: \[\{ \$ref: "#\/components\/parameters\/IdempotencyKey" \}\]/);
  assert.match(bugs, /"429": \{ \$ref: "#\/components\/responses\/RateLimitedProblem" \}/);
  assert.match(source, /RateLimitedProblem:[\s\S]*?Retry-After: \{ required: true/);

  // Submissions are immutable: no PATCH, PUT, or DELETE, and no revision.
  const features = source.slice(source.indexOf("/api/v1/feedback/features:"), source.indexOf("/runtime/v1/pairing-sessions:"));
  for (const verb of ["patch:", "put:", "delete:"]) {
    assert.ok(!bugs.includes(verb), `feedback bugs must not expose ${verb}`);
    assert.ok(!features.includes(verb), `feedback features must not expose ${verb}`);
  }

  // The diagnostic envelope is closed and cannot carry argument values.
  const context = source.slice(source.indexOf("FeedbackContext:"), source.indexOf("FeedbackSubmission:"));
  assert.match(context, /additionalProperties: false/);
  assert.match(context, /command: \{ type: string, maxLength: 128, pattern: "\^\[a-z\]\[a-z0-9-\]\{0,31\}\( \[a-z\]\[a-z0-9-\]\{0,31\}\)\{0,3\}\$"/);
  assert.deepEqual(
    [...context.matchAll(/^ {8}([a-z_]+):/gm)].map((match) => match[1]),
    ["cli_version", "command", "platform"],
  );
});

test("the feedback command pattern rejects every shape an argument value takes", () => {
  // Mirrors FeedbackContext.command in the vendored contract exactly.
  const pattern = /^[a-z][a-z0-9-]{0,31}( [a-z][a-z0-9-]{0,31}){0,3}$/;
  for (const accepted of ["doctor", "media upload", "screen pair", "kv set", "screen rotate-public-id"]) {
    assert.ok(pattern.test(accepted), `${accepted} must be accepted`);
  }
  for (const rejected of [
    "--json",                                   // option flag
    "media upload --codec hevc",                // flag with a value
    "media upload ./poster.png",                // file path
    "media upload /home/someone/poster.png",    // absolute path
    "screen pair ABC234",                       // uppercase argument value
    "media show med_AAAAAAAAAAAAAAAAAAAAAAAA",  // identifier with underscores
    "auth revoke --token=sr_live_x_y",          // credential-shaped argument
    "kv set greeting --json-value {\"a\":1}",   // JSON payload
    "a b c d e",                                // more than four words
    "media  upload",                            // doubled separator
    "MEDIA UPLOAD",                             // uppercase
  ]) {
    assert.ok(!pattern.test(rejected), `${rejected} must be rejected`);
  }
});

test("control-plane KV adapter follows the authoritative binary-safe OpenAPI schema", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  assert.match(source, /KVWrite:.*required: \[value_base64, content_type\].*value_base64:.*contentEncoding: base64.*content_type:/);
  assert.match(source, /KVEntry:.*required: \[application_id, key, value_base64, content_type, bytes, sha256, revision\]/);
  assert.match(source, /KVSummary:.*required: \[application_id, key, content_type, bytes, sha256, revision\]/);
  assert.match(source, /KVList:.*maxItems: 200/);
  assert.doesNotMatch(source.match(/KVWrite:[^\n]+/)?.[0] ?? "", /value: \{\s*\}/);
});
