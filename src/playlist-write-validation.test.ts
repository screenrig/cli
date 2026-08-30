import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "./problems.js";
import { validatePlaylistWrite } from "./playlist-write-validation.js";

function iframePrimitive(id: string, src: string) {
  return {
    id,
    primitive: "iframe",
    src,
    title: "Example",
    rect: { x: 0, y: 0, width: 100, height: 100 },
    layer: 0,
    content_fit: "fill",
  };
}

function playlistWithPrimitives(primitives: unknown[]) {
  return {
    name: "Lobby",
    pages: [{
      id: "page",
      canvas: { width: 1920, height: 1080, background: "#000000FF" },
      transition: { type: "crossfade", duration_ms: 200 },
      advance: { mode: "duration", after_ms: 1000 },
      primitives,
    }],
  };
}

const TWO_IFRAMES = [
  iframePrimitive("web_a", "https://example.com/"),
  iframePrimitive("web_b", "https://example.org/"),
];

test("playlist write accepts two iframe primitives on a page", () => {
  assert.deepEqual(validatePlaylistWrite(playlistWithPrimitives(TWO_IFRAMES), new Map()), new Set());
});

test("playlist write rejects a third iframe primitive on a page", () => {
  const primitives = [...TWO_IFRAMES, iframePrimitive("web_c", "https://example.net/")];
  assert.throws(
    () => validatePlaylistWrite(playlistWithPrimitives(primitives), new Map()),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.match(error.problem.detail, /must contain at most 2 iframe primitives/);
      return true;
    },
  );
});
