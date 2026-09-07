import assert from "node:assert/strict";
import { test } from "node:test";
import { aspectMismatchWarnings } from "./aspect-mismatch.js";

const SCREEN_ID = "scr_EXAMPLE";

function screen(width: unknown, height: unknown): unknown {
  return { observation: { surfaces: [{ width, height }] } };
}

function playlist(width: unknown, height: unknown): unknown {
  return {
    pages: [{
      id: "page_main",
      primitives: [{
        primitive: "image",
        resolved_media: [{ media_id: "med_EXAMPLE", intrinsic_size: { width, height } }],
      }],
    }],
  };
}

test("portrait media on a landscape screen warns with page and media ids", () => {
  assert.deepEqual(aspectMismatchWarnings(SCREEN_ID, screen(1920, 1080), playlist(1080, 1920)), [{
    code: "aspect_mismatch",
    message: "Page page_main uses portrait media med_EXAMPLE on screen scr_EXAMPLE, whose player reported a landscape 1920x1080 surface.",
  }]);
});

test("landscape media on a portrait screen warns", () => {
  assert.deepEqual(aspectMismatchWarnings(SCREEN_ID, screen(1080, 1920), playlist(1920, 1080)), [{
    code: "aspect_mismatch",
    message: "Page page_main uses landscape media med_EXAMPLE on screen scr_EXAMPLE, whose player reported a portrait 1080x1920 surface.",
  }]);
});

test("matching media and screen orientation is silent", () => {
  assert.deepEqual(aspectMismatchWarnings(SCREEN_ID, screen(1920, 1080), playlist(1600, 900)), []);
});

test("square media is silent", () => {
  assert.deepEqual(aspectMismatchWarnings(SCREEN_ID, screen(1920, 1080), playlist(1000, 1000)), []);
});

test("unknown or missing observations and dimensions are silent and do not throw", () => {
  for (const [screenValue, playlistValue] of [
    [undefined, playlist(1080, 1920)],
    [{}, playlist(1080, 1920)],
    [{ observation: {} }, playlist(1080, 1920)],
    [screen(undefined, 1080), playlist(1080, 1920)],
    [screen(1920, 1080), undefined],
    [screen(1920, 1080), playlist(undefined, 1920)],
  ]) {
    assert.doesNotThrow(() => aspectMismatchWarnings(SCREEN_ID, screenValue, playlistValue));
    assert.deepEqual(aspectMismatchWarnings(SCREEN_ID, screenValue, playlistValue), []);
  }
});
