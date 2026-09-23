import { commandHelp } from "../help.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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


test("local enrollment request adapter requires email and accepts optional beta_key", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"),
    "utf8",
  );
  assert.match(source, /export interface CLIEnrollmentRequest \{[\s\S]*?beta_key\?: string;/);
  assert.match(source, /export interface CLIEnrollmentRequest \{[\s\S]*?email: string;/);
});

test("the dashboard link is minted only, and the CLI never claims one", () => {
  const adapter = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"),
    "utf8",
  );
  const commands = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/commands.ts"),
    "utf8",
  );
  assert.deepEqual(quotedProperties(interfaceBody(readFileSync(GENERATED_CONTRACT, "utf8"), "DashboardLink")), [
    "expires_at",
    "url",
  ]);
  assert.match(adapter, /export interface DashboardLink \{[\s\S]*?expires_at: string;/);
  assert.match(adapter, /actor\?: EventActor/);
  assert.match(commands, /"\/api\/v1\/account\/dashboard-links"/);
  // Claiming happens in the browser on the dashboard origin. The CLI holds the
  // account bearer and must never present a link token itself.
  assert.doesNotMatch(commands, /\/dashboard\/v1\//);
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
  assert.match(commands, /screen update requires <id>, and --name, --playlist-id, or --timezone/);
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
  assert.match(screenSchema, /not a player\s+heartbeat or presence\.write report/);
  assert.match(screenSchema, /maxLength: 45/);
  assert.match(screenSchema, /ScreenPatch, pairing bodies, session[\s\S]*runtime manifest\s+body cannot write it/);
  assert.doesNotMatch(commands, /--online|--last-online-at|--last-ip/);
  assert.match(commands, /screen update requires <id>, and --name, --playlist-id, or --timezone/);
});

test("recovery_pending.host is a local optional description without identifiers", () => {
  const adapter = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"),
    "utf8",
  );
  const pending = interfaceBody(adapter, "ScreenRecoveryPending");
  assert.match(pending, /expires_at: string/);
  assert.match(pending, /host\?: ScreenRecoveryPendingHost/);
  const host = interfaceBody(adapter, "ScreenRecoveryPendingHost");
  assert.match(host, /platform\?: HostContext\["platform"\]/);
  assert.match(host, /model\?: string/);
  assert.match(host, /firmware\?: string/);
  assert.match(host, /manufacturer\?: string/);
  assert.doesNotMatch(host, /duid|serial|mac|host_version|capabilities/);
});

test("published problem codes include payment_required and dependency_timeout", () => {
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
    "email_conflict",
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
    "dependency_timeout",
    "schema_incompatible",
    "not_ready",
    "manifest_degraded",
    "screenshot_unavailable",
    "identity_invalid",
    "identity_conflict",
    "enrollment_bound",
    "proof_invalid",
    "screen_archived",
    "screen_archive_required",
    "dashboard_link_invalid",
    "dashboard_link_expired",
    "dashboard_link_consumed",
    "passkey_invalid",
    "passkeys_disabled",
    "application_in_use",
    "agent_connection_invalid",
    "agent_connection_expired",
    "agent_connection_conflict",
    "agent_connection_not_approved",
    "agent_connection_cancelled",
    "agent_limit_exceeded",
    "agent_lockout_risk",
    "recovery_ambiguous",
    "recovery_expired",
    "recovery_not_offered",
    "invitation_limit_reached",
    "version_required",
    "price_change_pending",
    "quote_stale",
    "insufficient_credits",
    "self_deal",
    "invitation_invalid",
    "invitation_expired",
    "invitation_consumed",
    "billing_unavailable",
    "user_binding_stale",
    // Runtime (Player) codes from the compatibility contract. The account
    // commands never receive them; they are pinned so a contract change is
    // reviewed here.
    "session_expired",
    "credential_revoked",
    "proof_clock_skew",
    "key_retired",
    "assignment_not_found",
    "upgrade_required",
  ]);
  assert.match(source, /payment_required/);
  assert.doesNotMatch(source, /stripe|x402/i);
});

test("pinned backend snapshot includes swipe and primitive enter", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  const transition = interfaceBody(generated, "PlaylistTransition");
  assert.deepEqual(quotedProperties(transition), ["duration_ms", "type"]);
  assert.match(
    transition,
    /"type": "crossfade" \| "swipe-left" \| "swipe-right" \| "swipe-up" \| "swipe-down"/,
  );

  const runtimeTransition = interfaceBody(generated, "RuntimeTransition");
  assert.match(
    runtimeTransition,
    /"type": "crossfade" \| "swipe-left" \| "swipe-right" \| "swipe-up" \| "swipe-down"/,
  );

  const enter = interfaceBody(generated, "PrimitiveEnter");
  assert.deepEqual(quotedProperties(enter), ["stagger", "type"]);
  assert.match(
    enter,
    /"type": "fade-up" \| "fade-down" \| "fade-left" \| "fade-right" \| "fade-in" \| "zoom-in" \| "zoom-out"/,
  );
  assert.match(enter, /"stagger"\?: number/);

  const imageWrite = interfaceBody(generated, "PlaylistImagePrimitiveWrite");
  assert.deepEqual(quotedProperties(imageWrite), ["alt", "content_fit", "dwell_ms", "enter", "id", "layer", "motion", "primitive", "rect", "selector"]);
  assert.match(imageWrite, /"enter"\?: PrimitiveEnter/);
  assert.match(imageWrite, /"motion"\?: PrimitiveMotion/);

  const spin = interfaceBody(generated, "PrimitiveMotionSpin");
  assert.deepEqual(quotedProperties(spin), ["direction", "speed", "type"]);
  assert.match(spin, /"direction": "cw" \| "ccw"/);
  assert.match(spin, /"speed": "slow" \| "medium" \| "fast"/);
  const pathMotion = interfaceBody(generated, "PrimitiveMotionPath");
  assert.deepEqual(quotedProperties(pathMotion), ["loop", "points", "rate", "type"]);
  const drift = interfaceBody(generated, "PrimitiveMotionDrift");
  assert.deepEqual(quotedProperties(drift), ["direction", "speed", "type", "zoom"]);

  assert.match(openapi, /enum: \[crossfade, swipe-left, swipe-right, swipe-up, swipe-down\]/);
  assert.match(openapi, /PrimitiveEnter:/);
  assert.match(openapi, /enum: \[fade-up, fade-down, fade-left, fade-right, fade-in, zoom-in, zoom-out\]/);
  assert.match(openapi, /PrimitiveMotion:/);
  assert.match(openapi, /enum: \[spin\]/);
  assert.match(openapi, /enum: \[path\]/);
  assert.match(openapi, /enum: \[drift\]/);
  assert.match(openapi, /there is no snake_case rename inside it/);
  // `unknown_enter_type` is a manifest diagnostic code, not a snake_case field.
  assert.doesNotMatch(openapi, /\benter_type\b|object_enter_delay_ms|enter_delay_ms/);
});

test("playlist writes send a media selector and media_end, not a singular media_id or video_end", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  const imageWrite = interfaceBody(generated, "PlaylistImagePrimitiveWrite");
  assert.deepEqual(quotedProperties(imageWrite), ["alt", "content_fit", "dwell_ms", "enter", "id", "layer", "motion", "primitive", "rect", "selector"]);
  assert.match(imageWrite, /"primitive": "image"/);
  assert.doesNotMatch(imageWrite, /"media_id"/);

  const videoWrite = interfaceBody(generated, "PlaylistVideoPrimitiveWrite");
  assert.deepEqual(quotedProperties(videoWrite), ["content_fit", "enter", "id", "layer", "loop", "motion", "muted", "primitive", "rect", "selector"]);
  assert.match(videoWrite, /"primitive": "video"/);
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
  assert.match(openapi, /PlaylistImagePrimitiveWrite:[\s\S]*?required: \[id, primitive, selector, rect, layer, content_fit\]/);
  assert.match(openapi, /PlaylistVideoPrimitiveWrite:[\s\S]*?required: \[id, primitive, selector, rect, layer, content_fit\]/);
  assert.match(openapi, /PlaylistMediaEndAdvanceWrite:[\s\S]*?enum: \[media_end\]/);
  assert.doesNotMatch(openapi, /PlaylistVideoEndAdvance/);
  assert.doesNotMatch(openapi, /enum: \[video_end\]/);
});

test("pinned backend snapshot uses the canonical primitive unions including streams", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");

  assert.match(
    generated,
    /export type PlaylistPrimitiveWrite = PlaylistApplicationPrimitiveWrite \| PlaylistImagePrimitiveWrite \| PlaylistVideoPrimitiveWrite \| PlaylistIframePrimitiveWrite \| PlaylistStreamPrimitiveWrite;/,
  );
  assert.match(
    generated,
    /export type PlaylistPrimitive = PlaylistApplicationPrimitive \| PlaylistImagePrimitive \| PlaylistVideoPrimitive \| PlaylistIframePrimitive \| PlaylistStreamPrimitive;/,
  );
  assert.match(
    generated,
    /export type RuntimePrimitive = RuntimeApplicationPrimitive \| RuntimeImagePrimitive \| RuntimeVideoPrimitive \| RuntimeIframePrimitive \| RuntimeStreamPrimitive;/,
  );
  for (const name of [
    "PlaylistTextPrimitiveWrite",
    "PlaylistBoxPrimitiveWrite",
    "PlaylistLinePrimitiveWrite",
    "PlaylistTextContent",
    "PlaylistBoxContent",
    "PlaylistLineContent",
    "RuntimeTextPrimitive",
    "RuntimeBoxPrimitive",
    "RuntimeLinePrimitive",
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
  assert.match(route, /not a primitive/);
  assert.match(route, /screen\.toast/);
  assert.match(route, /expires_at/);
  assert.doesNotMatch(route, /color/);
  assert.match(source, /ScreenToastWrite:[\s\S]*?required: \[level, text\]/);
  assert.match(source, /level: \{ type: string, enum: \[error, alert, info\]/);
  assert.match(source, /duration_ms: \{ type: integer, minimum: 2000, maximum: 60000, default: 10000/);
  assert.doesNotMatch(source.slice(source.indexOf("ScreenToastWrite:"), source.indexOf("ScreenToastAccepted:")), /color/);
});

test("reload contract is an optional-revision POST that answers ScreenReloadAccepted", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const adapter = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"), "utf8");
  const start = source.indexOf("  /api/v1/screens/{id}/reload:");
  const end = source.indexOf("  /api/v1/screens/{id}/toast:");
  assert.ok(start !== -1 && end > start, "missing reload route");
  const route = source.slice(start, end);
  assert.match(route, /operationId: reloadScreen/);
  assert.match(route, /post:/);
  assert.doesNotMatch(route, /get:|patch:|put:|delete:|requestBody/);
  assert.match(route, /IfMatch/);
  assert.match(route, /OptionalIdempotencyKey/);
  assert.match(route, /"202":[\s\S]*ScreenReloadAccepted/);
  assert.match(route, /RateLimitedProblem/);
  assert.match(route, /player\.reload/);
  assert.match(route, /pairing_pending screen has no Player yet[\s\S]*resource_conflict/);
  assert.deepEqual(quotedProperties(interfaceBody(generated, "ScreenReloadAccepted")), ["expires_at", "reload_id"]);
  assert.match(interfaceBody(adapter, "ScreenReloadAccepted"), /reload_id: string;[\s\S]*expires_at: string;/);
});

test("Screen exposes archive_reason, archived_at, and applications_unsupported as read-only fields", () => {
  const generated = readFileSync(GENERATED_CONTRACT, "utf8");
  const openapi = readFileSync(OPENAPI_CONTRACT, "utf8");
  const adapter = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/adapters/protocol.ts"), "utf8");
  const screen = interfaceBody(generated, "Screen");
  assert.match(screen, /"archive_reason"\?: string/);
  assert.match(screen, /"archived_at"\?: string/);
  assert.match(screen, /"applications_unsupported"\?:/);
  assert.doesNotMatch(interfaceBody(generated, "ScreenPatch"), /archive_reason|archived_at|applications_unsupported/);
  const screenSchema = openapi.slice(openapi.indexOf("    Screen:\n"), openapi.indexOf("    HostContext:"));
  assert.match(screenSchema, /Known values: account[\s\S]*device_reset[\s\S]*device_unpair/);
  assert.match(screenSchema, /Readers ignore a value they do not\s+know/);
  assert.match(screenSchema, /applications_unsupported:[\s\S]*required: \[at\]/);
  const local = interfaceBody(adapter, "Screen");
  assert.match(local, /archive_reason\?: string/);
  assert.match(local, /archived_at\?: string/);
  assert.match(local, /applications_unsupported\?: ScreenApplicationsUnsupported/);
  assert.match(interfaceBody(adapter, "ScreenApplicationsUnsupported"), /at: string/);
  assert.doesNotMatch(interfaceBody(adapter, "ScreenPatch"), /archive_reason|archived_at|applications_unsupported/);
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
  assert.ok(source.includes('ScreenshotCaptureID: { type: string, pattern: "^(?:(?:stage|qa|development)_)?shot_[A-Za-z0-9_-]{16,64}$"'));
  assert.match(source, /x-problem-codes: \[[^\]]*screenshot_unavailable[^\]]*\]/);
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
    "reason",
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
  for (const accepted of ["doctor", "media upload", "screen pair", "kv set", "comment set", "screen rotate-public-id"]) {
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

test("opaque agent comments are optional on GET resources, dedicated comment routes write them, and writes cannot", () => {
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

  assert.match(interfaceBody(generated, "Screen"), /"comments"\?: Record<string, unknown>/);
  assert.match(interfaceBody(generated, "Playlist"), /"comments"\?: Record<string, unknown>/);
  assert.match(interfaceBody(generated, "PlaylistPage"), /"comments"\?: Record<string, unknown>/);
  assert.doesNotMatch(interfaceBody(generated, "ScreenPatch"), /comments/);
  assert.doesNotMatch(interfaceBody(generated, "PlaylistWrite"), /comments/);
  assert.doesNotMatch(interfaceBody(generated, "PlaylistPageWrite"), /comments/);
  assert.doesNotMatch(interfaceBody(generated, "RuntimeManifest"), /comments/);
  assert.doesNotMatch(interfaceBody(generated, "RuntimePage"), /comments/);

  const comments = interfaceBody(generated, "Comments");
  assert.deepEqual(quotedProperties(comments), ["comments"]);
  assert.match(comments, /"comments": Record<string, unknown> \| null/);
  const write = interfaceBody(generated, "CommentsWrite");
  assert.deepEqual(quotedProperties(write), ["comments"]);
  assert.match(write, /"comments": Record<string, unknown>/);
  assert.doesNotMatch(write, /"comments"\?:/);

  assert.match(adapter, /comments\?: Record<string, unknown>/);
  assert.doesNotMatch(interfaceBody(adapter, "ScreenPatch"), /comments/);

  assert.match(openapi, /\/api\/v1\/comment\/screen\/\{id\}:/);
  assert.match(openapi, /\/api\/v1\/comment\/playlist\/\{id\}:/);
  assert.match(openapi, /\/api\/v1\/comment\/playlist\/\{id\}\/page\/\{page_id\}:/);
  assert.match(openapi, /Never reads or uses it|ScreenRig never reads or uses it/);
  assert.match(openapi, /Not on the runtime manifest and never authorization/);
  assert.match(openapi, /Last-write-wins on the comments field only/);
  const screenComments = openapi.slice(
    openapi.indexOf("/api/v1/comment/screen/{id}:"),
    openapi.indexOf("/api/v1/comment/playlist/{id}:"),
  );
  assert.match(screenComments, /parameters: \[\{ \$ref: "#\/components\/parameters\/OptionalIdempotencyKey" \}\]/);
  assert.doesNotMatch(screenComments, /IfMatch/);

  for (const action of ["show", "set", "delete"]) {
    for (const target of ["screen", "playlist"]) {
      const help = commandHelp(["comment", action, target]);
      assert.match(help.synopsis[0]!, new RegExp(`comment ${action} ${target} \\[options\\] <id>`));
      const options = new Map(help.options.map((option) => [option.name, option]));
      assert.equal(options.has("--page"), target === "playlist");
      if (target === "playlist") assert.equal(options.get("--page")?.type, "value");
      for (const name of ["--json-value", "--file"]) {
        assert.equal(options.has(name), action === "set");
        if (action === "set") assert.equal(options.get(name)?.type, "value");
      }
      assert.equal(options.has("--expect-rev"), false);
      assert.equal(options.has("--value-base64"), false);
    }
  }
  assert.doesNotMatch(commands, /comment\/screen\/:id/);
  assert.doesNotMatch(commands, /--value-base64.*comment/);
});

test("control-plane KV adapter follows the authoritative binary-safe OpenAPI schema", () => {
  const source = readFileSync(OPENAPI_CONTRACT, "utf8");
  assert.match(source, /KVWrite:.*required: \[value_base64\].*value_base64:.*contentEncoding: base64.*content_type:/);
  assert.match(source, /KVEntry:.*required: \[application_id, key, value_base64, content_type, bytes, sha256, revision\]/);
  assert.match(source, /KVSummary:.*required: \[application_id, key, content_type, bytes, sha256, revision\]/);
  assert.match(source, /KVList:.*maxItems: 200/);
  assert.doesNotMatch(source.match(/KVWrite:[^\n]+/)?.[0] ?? "", /value: \{\s*\}/);
});
