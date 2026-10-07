import assert from "node:assert/strict";
import { test } from "node:test";
import { httpResourceId, httpTag, localTag } from "./tag.js";

const HTTP_CASES: Array<[method: string, path: string, tag: string]> = [
  ["GET", "/api/screens", "get_screens"],
  ["GET", "/api/screens/scr_x", "get_screen"],
  ["POST", "/api/screens/scr_x/archive", "post_screen_archive"],
  ["GET", "/api/screens/scr_x/screenshot/status", "get_screen_screenshot_status"],
  ["GET", "/.health", "get_health"],
  ["GET", "/api/media/med_1/content", "get_media_id_content"],
  ["GET", "/api/screens?limit=10", "get_screens"],
  ["GET", "/.ready", "get_ready"],
  ["GET", "/.version", "get_version"],
  ["POST", "/api/screens/scr_x/toast", "post_screen_toast"],
  ["POST", "/api/screens/scr_x/reload", "post_screen_reload"],
  ["POST", "/api/screens/scr_x/public-id/rotate", "post_screen_public_id_rotate"],
  ["POST", "/api/media/uploads/upl_1/commit", "post_media_upload_commit"],
  ["POST", "/api/media/generations", "post_media_generations"],
  ["GET", "/api/operations/op_1", "get_operation"],
  ["POST", "/api/invitations", "post_invitations"],
  ["GET", "/stream/project", "get_stream_project"],
  ["GET", "/screen/manifest", "get_screen_manifest"],
  ["GET", "/media/manifests/rev_1/med_1", "get_media_manifest"],
  ["GET", "/", "get"],
];

test("httpTag maps method and path to compact snake_case without ids or paths", () => {
  for (const [method, path, expected] of HTTP_CASES) {
    assert.equal(httpTag(method, path), expected, `${method} ${path}`);
  }
});

test("httpResourceId takes the first path segment that is not a kept route token", () => {
  assert.equal(httpResourceId("/api/screens/scr_1q2333321"), "scr_1q2333321");
  assert.equal(httpResourceId("/api/screens"), undefined);
  assert.equal(httpResourceId("/api/playlists/pl_x"), "pl_x");
  assert.equal(httpResourceId("/api/media/med_1/content"), "med_1");
  assert.equal(httpResourceId("/api/media/generations"), undefined);
  assert.equal(httpResourceId("/api/operations/op_1"), "op_1");
  assert.equal(httpResourceId("/api/applications/app_1"), "app_1");
  assert.equal(httpResourceId("/api/screens/scr_x/screenshot/status"), "scr_x");
  assert.equal(httpResourceId("/api/screens?limit=10"), undefined);
});

test("localTag folds op dots and hyphens", () => {
  assert.equal(localTag("media.transcode"), "media_transcode");
  assert.equal(localTag("cli.run"), "cli_run");
  assert.equal(localTag("process.spawn"), "process_spawn");
  assert.equal(localTag("media.signed_put"), "media_signed_put");
  assert.equal(localTag("SSE.Connect"), "sse_connect");
});
