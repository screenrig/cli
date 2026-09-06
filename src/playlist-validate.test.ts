import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OBJECT_MOTION_GUIDANCE,
  PANNING_BACKGROUND_EXAMPLE_PAGE,
  SPINNING_BADGE_EXAMPLE_PAGE,
} from "./playlist-templates.js";
import { assertPlaylistValid, playlistIssues } from "./playlist-validate.js";

function playlist(primitive: Record<string, unknown> = {}) {
  return { name: "Local preflight", pages: [{ id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF", viewport_fit: "contain" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 }, primitives: [{ id: "media", primitive: "image", selector: { by: "all", one_at_a_time: true }, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "contain", ...primitive }] }] };
}
test("local canonical validation accepts dynamic selectors and application/iframe pages", () => {
  assert.doesNotThrow(() => assertPlaylistValid(playlist()));
  const p = playlist();
  p.pages[0]!.primitives = [{ id: "kiosk", primitive: "application", release_id: "rel_EXAMPLE", controller: true, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" }] as any;
  p.pages[0]!.advance = { mode: "application", max_ms: 180000 } as any;
  assert.deepEqual(playlistIssues(p), []);
});
test("local entry diagnostics name only the invalid fields on the selected branch", () => {
  const issues = playlistIssues(playlist({ enter: { type: "fade-left", duration_ms: 500, delay_ms: 250 } }));
  assert.deepEqual(issues.map((issue) => issue.path), ["/pages/0/primitives/0/enter/duration_ms", "/pages/0/primitives/0/enter/delay_ms"]);
  assert.ok(issues.every((issue) => issue.message.includes("keep only type")));
});
test("local canonical validation accepts the panning background and spinning badge examples", () => {
  assert.doesNotThrow(() => assertPlaylistValid({ name: "Pan", pages: [PANNING_BACKGROUND_EXAMPLE_PAGE] }));
  assert.doesNotThrow(() => assertPlaylistValid({ name: "Badge", pages: [SPINNING_BADGE_EXAMPLE_PAGE] }));
  assert.equal(PANNING_BACKGROUND_EXAMPLE_PAGE.primitives[0]?.motion.loop, "loop");
  assert.equal(SPINNING_BADGE_EXAMPLE_PAGE.primitives[0]?.motion.speed, "slow");
  assert.match(OBJECT_MOTION_GUIDANCE, /one moving element per page is the norm/);
});

test("local canonical validation accepts enter stagger 0 through 8", () => {
  assert.deepEqual(playlistIssues(playlist({ enter: { type: "fade-up", stagger: 0 } })), []);
  assert.deepEqual(playlistIssues(playlist({ enter: { type: "fade-up", stagger: 8 } })), []);
  const issues = playlistIssues(playlist({ enter: { type: "fade-up", stagger: 9 } }));
  assert.ok(issues.some((issue) => issue.path === "/pages/0/primitives/0/enter/stagger"));
});

test("local canonical validation rejects spin on an iframe", () => {
  const invalid = playlist();
  invalid.pages[0]!.primitives = [{
    id: "web",
    primitive: "iframe",
    src: "https://example.com/",
    title: "Example",
    rect: { x: 0, y: 0, width: 1920, height: 1080 },
    layer: 0,
    content_fit: "fill",
    motion: { type: "spin", direction: "cw", speed: "slow" },
  }] as any;
  const issues = playlistIssues(invalid);
  assert.ok(issues.some((issue) => issue.path === "/pages/0/primitives/0/motion" && issue.message.includes("spin")));
});

test("local canonical validation rejects a path with 65 points", () => {
  const page = structuredClone(PANNING_BACKGROUND_EXAMPLE_PAGE);
  page.primitives[0]!.motion.points = Array.from({ length: 65 }, (_, index) => ({ x: index, y: 0 }));
  const issues = playlistIssues({ name: "Overflow", pages: [page] });
  assert.ok(issues.some((issue) => issue.path === "/pages/0/primitives/0/motion/points"));
});

test("canonical cross-field semantics reject duplicate IDs, controllers and looping media_end", () => {
  const duplicate = playlist(); duplicate.pages.push(structuredClone(duplicate.pages[0]!));
  assert.ok(playlistIssues(duplicate).some((issue) => issue.path === "/pages/1/id"));
  const end = playlist({ primitive: "video", loop: true }); end.pages[0]!.advance = { mode: "media_end" } as any;
  assert.ok(playlistIssues(end).some((issue) => issue.path.endsWith("/loop")));
  const missingController = playlist(); missingController.pages[0]!.advance = { mode: "application", max_ms: 180000 } as any;
  assert.ok(playlistIssues(missingController).some((issue) => issue.message.includes("exactly one controller")));
});
