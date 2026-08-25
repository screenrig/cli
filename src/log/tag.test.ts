import assert from "node:assert/strict";
import { test } from "node:test";
import { httpResourceId, httpTag, localTag } from "./tag.js";

const HTTP_CASES: Array<[method: string, path: string, tag: string]> = [
  ["GET", "/api/v1/screens", "get_screens"],
  ["GET", "/api/v1/screens/scr_x", "get_screen"],
  ["POST", "/api/v1/screens/scr_x/archive", "post_screen_archive"],
  ["GET", "/api/v1/screens/scr_x/screenshot/status", "get_screen_screenshot_status"],
  ["GET", "/.health", "get_health"],
  ["GET", "/api/v1/media/med_1/content", "get_media_id_content"],
  ["GET", "/api/v1/screens?limit=10", "get_screens"],
  ["GET", "/.ready", "get_ready"],
  ["GET", "/.version", "get_version"],
  ["POST", "/api/v1/screens/scr_x/toast", "post_screen_toast"],
  ["POST", "/api/v1/screens/scr_x/public-id/rotate", "post_screen_public_id_rotate"],
  ["POST", "/api/v1/media/uploads/upl_1/commit", "post_media_upload_commit"],
  ["GET", "/api/v1/operations/op_1", "get_operation"],
  ["POST", "/api/v1/account/dashboard-links", "post_account_dashboard_links"],
  ["GET", "/api/v1/events/stream", "get_events_stream"],
  ["GET", "/runtime/v1/manifest", "get_manifest"],
  ["GET", "/content/v1/manifests/rev_1/media/med_1", "get_manifest_media_id"],
  ["GET", "/", "get"],
];

test("httpTag maps method and path to compact snake_case without ids or paths", () => {
  for (const [method, path, expected] of HTTP_CASES) {
    assert.equal(httpTag(method, path), expected, `${method} ${path}`);
  }
});

test("httpResourceId takes the first path segment that is not a kept route token", () => {
  assert.equal(httpResourceId("/api/v1/screens/scr_1q2333321"), "scr_1q2333321");
  assert.equal(httpResourceId("/api/v1/screens"), undefined);
  assert.equal(httpResourceId("/api/v1/playlists/pl_x"), "pl_x");
  assert.equal(httpResourceId("/api/v1/media/med_1/content"), "med_1");
  assert.equal(httpResourceId("/api/v1/operations/op_1"), "op_1");
  assert.equal(httpResourceId("/api/v1/applications/app_1"), "app_1");
  assert.equal(httpResourceId("/api/v1/screens/scr_x/screenshot/status"), "scr_x");
  assert.equal(httpResourceId("/api/v1/screens?limit=10"), undefined);
});

test("localTag folds op dots and hyphens", () => {
  assert.equal(localTag("media.transcode"), "media_transcode");
  assert.equal(localTag("cli.run"), "cli_run");
  assert.equal(localTag("process.spawn"), "process_spawn");
  assert.equal(localTag("media.signed_put"), "media_signed_put");
  assert.equal(localTag("SSE.Connect"), "sse_connect");
});
