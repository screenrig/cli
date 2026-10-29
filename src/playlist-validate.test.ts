import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPlaylistValid, playlistIssues } from "./playlist-validate.js";

const PANNING_BACKGROUND_PAGE = {
  id: "pan",
  canvas: { width: 1920, height: 1080, viewport_fit: "contain" as const, background: "#000000FF" },
  transition: { type: "crossfade" as const, duration_ms: 200 },
  advance: { mode: "duration" as const, after_ms: 8000 },
  primitives: [
    {
      id: "background",
      primitive: "image" as const,
      selector: { by: "id" as const, media_id: "med_background" },
      rect: { x: 0, y: 0, width: 2400, height: 1080 },
      layer: 0,
      content_fit: "cover" as const,
      motion: { type: "path" as const, points: [{ x: -480, y: 0 }], rate: 40, loop: "loop" as const },
    },
  ],
};

const SPINNING_BADGE_PAGE = {
  id: "badge",
  canvas: { width: 1920, height: 1080, viewport_fit: "contain" as const, background: "#1B2632FF" },
  transition: { type: "crossfade" as const, duration_ms: 200 },
  advance: { mode: "duration" as const, after_ms: 8000 },
  primitives: [
    {
      id: "badge",
      primitive: "image" as const,
      selector: { by: "id" as const, media_id: "med_badge" },
      rect: { x: 1640, y: 80, width: 200, height: 200 },
      layer: 1,
      content_fit: "contain" as const,
      motion: { type: "spin" as const, direction: "cw" as const, speed: "slow" as const },
    },
  ],
};

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
test("local canonical validation accepts a folder selector and plays it one at a time on a duration page", () => {
  assert.deepEqual(playlistIssues(playlist({ selector: { by: "folder", folder_id: "mfd_Lobby1", order: "random", one_at_a_time: true } })), []);
  assert.deepEqual(playlistIssues(playlist({ selector: { by: "folder", folder_id: "mfd_Lobby1" } })).map((issue) => issue.path), ["/pages/0/primitives/0/selector/one_at_a_time"]);
  assert.notDeepEqual(playlistIssues(playlist({ selector: { by: "folder", folder_id: "med_Lobby1", one_at_a_time: true } })), []);
});
test("local entry diagnostics name only the invalid fields on the selected branch", () => {
  const issues = playlistIssues(playlist({ enter: { type: "fade-left", duration_ms: 500, delay_ms: 250 } }));
  assert.deepEqual(issues.map((issue) => issue.path), ["/pages/0/primitives/0/enter/duration_ms", "/pages/0/primitives/0/enter/delay_ms"]);
  assert.ok(issues.every((issue) => issue.message.includes("keep only type")));
});
test("local canonical validation accepts a panning background and a spinning badge", () => {
  assert.doesNotThrow(() => assertPlaylistValid({ name: "Pan", pages: [PANNING_BACKGROUND_PAGE] }));
  assert.doesNotThrow(() => assertPlaylistValid({ name: "Badge", pages: [SPINNING_BADGE_PAGE] }));
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

test("local canonical validation accepts LAN, http and logged-in iframe pages and refuses other schemes", () => {
  const iframe = (src: string) => {
    const value = playlist();
    value.pages[0]!.primitives = [{ id: "web", primitive: "iframe", src, title: "Example", rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "fill" }] as any;
    return playlistIssues(value);
  };
  for (const src of ["https://user:pass@example.com/page", "http://user@printer.local/", "http://192.168.1.20:8080/status", "https://example.com/@user", "http://intranet/menu"]) {
    assert.deepEqual(iframe(src), [], src);
  }
  for (const src of ["ftp://example.com/", "javascript:alert(1)"]) {
    assert.deepEqual(iframe(src).map((issue) => issue.path), ["/pages/0/primitives/0/src"], src);
  }
});

test("off-canvas bleed rectangles remain valid under the canvas clipping contract", () => {
  const value = playlist({ rect: { x: -500, y: -500, width: 5000, height: 5000 } });
  value.pages[0]!.canvas.width = 384;
  value.pages[0]!.canvas.height = 823;
  assert.deepEqual(playlistIssues(value), []);
});

test("local canonical validation rejects a path with 65 points", () => {
  const page = structuredClone(PANNING_BACKGROUND_PAGE);
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
test("media_end allows a card chip beside its one video, as the server does", () => {
  const withChip = playlist({ primitive: "video", loop: false });
  withChip.pages[0]!.advance = { mode: "media_end" } as any;
  withChip.pages[0]!.primitives = [...withChip.pages[0]!.primitives as any[], { id: "chip", primitive: "card", card: "clock", major: 1, params: {}, layout: "chip", anchor: "top-right", content_fit: "fill" }] as any;
  assert.deepEqual(playlistIssues(withChip), []);
  const cardOnly = playlist(); cardOnly.pages[0]!.advance = { mode: "media_end" } as any;
  cardOnly.pages[0]!.primitives = [{ id: "chip", primitive: "card", card: "clock", major: 1, params: {}, layout: "full", content_fit: "fill" }] as any;
  assert.ok(playlistIssues(cardOnly).some((issue) => issue.path === "/pages/0/advance" && issue.message.includes("exactly one image or video")));
});
test("a wide card validates without an anchor and shares the page's one full, center or wide slot", () => {
  const wide = (id: string, extra: Record<string, unknown> = {}) => ({ id, primitive: "card", card: "clock", major: 1, params: {}, layout: "wide", content_fit: "fill", ...extra });
  const withCards = (...cards: Record<string, unknown>[]) => { const p = playlist(); p.pages[0]!.primitives = cards as any; return p; };
  assert.deepEqual(playlistIssues(withCards(wide("w"))), []);
  assert.ok(playlistIssues(withCards(wide("w", { anchor: "top" }))).some((issue) => issue.path === "/pages/0/primitives/0/anchor"));
  assert.deepEqual(playlistIssues(withCards(wide("w"), wide("c", { layout: "chip", anchor: "top-right" }))), []);
  for (const other of ["full", "center", "wide"]) {
    const issues = playlistIssues(withCards(wide("w"), wide("o", { layout: other })));
    assert.ok(issues.some((issue) => issue.path === "/pages/0/primitives/1/layout" && issue.message.includes("one full, center or wide card")), other);
  }
});
test("a header or footer card validates without an anchor, one per edge, beside a wide card and corner cards", () => {
  const bar = (id: string, layout: string, extra: Record<string, unknown> = {}) => ({ id, primitive: "card", card: "clock", major: 1, params: {}, layout, content_fit: "fill", ...extra });
  const withCards = (...cards: Record<string, unknown>[]) => { const p = playlist(); p.pages[0]!.primitives = cards as any; return p; };
  assert.deepEqual(playlistIssues(withCards(bar("h", "header"))), []);
  assert.deepEqual(playlistIssues(withCards(bar("f", "footer"))), []);
  assert.deepEqual(playlistIssues(withCards(bar("h", "header"), bar("f", "footer"), bar("w", "wide"), bar("c", "chip", { anchor: "top-left" }), bar("k", "corner", { anchor: "bottom-right" }))), []);
  for (const layout of ["header", "footer"]) {
    assert.ok(playlistIssues(withCards(bar("b", layout, { anchor: "top" }))).some((issue) => issue.path === "/pages/0/primitives/0/anchor"), `${layout} takes no anchor`);
    const second = playlistIssues(withCards(bar("a", layout), bar("b", layout)));
    assert.ok(second.some((issue) => issue.path === "/pages/0/primitives/1/layout" && issue.message.includes(`one ${layout} card`)), `${layout} twice`);
  }
});

function soundtrackDocument(page: Record<string, unknown>, audio: Record<string, unknown> = {}) {
  const pageDefaults = { id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF", viewport_fit: "contain" }, transition: { type: "crossfade", duration_ms: 200 }, primitives: [{ id: "media", primitive: "image", selector: { by: "id", media_id: "med_IMAGE" }, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "contain" }] };
  return { name: "Album", audio: { tracks: [{ id: "intro", media_id: "med_SONG" }, { id: "bed", media_id: "med_SONG" }], loop: false, volume: 0.5, ...audio }, pages: [{ ...pageDefaults, advance: { mode: "duration", after_ms: 5000 }, ...page }] };
}

test("soundtrack audio_end page: the local validator accepts a cued page that ends with its track", () => {
  const cue = { track: "bed", restart: true };
  assert.deepEqual(playlistIssues(soundtrackDocument({ advance: { mode: "audio_end" }, audio_cue: cue })), []);
  assert.deepEqual(playlistIssues(soundtrackDocument({ advance: { mode: "audio_end", max_ms: 214000 }, audio_cue: cue })), []);
  // The read form carries the server's max_ms; the write form omits it.
  assert.notDeepEqual(playlistIssues(soundtrackDocument({ advance: { mode: "audio_end", max_ms: 500 }, audio_cue: cue })), []);
  assert.notDeepEqual(playlistIssues(soundtrackDocument({ advance: { mode: "audio_end", after_ms: 5000 }, audio_cue: cue })), []);
});

test("soundtrack audio_end without cue is refused at the page advance", () => {
  const issues = playlistIssues(soundtrackDocument({ advance: { mode: "audio_end" } }));
  assert.ok(issues.some((issue) => issue.path === "/pages/0/advance" && issue.message.includes("audio_end requires an audio_cue")));
});

test("soundtrack audio_end image dwell is refused, as on a duration page", () => {
  const document = soundtrackDocument({ advance: { mode: "audio_end" }, audio_cue: { track: "bed", restart: true } });
  (document.pages[0]!.primitives[0] as Record<string, unknown>).dwell_ms = 3000;
  assert.ok(playlistIssues(document).some((issue) => issue.path === "/pages/0/primitives/0/dwell_ms"));
  const several = soundtrackDocument({ advance: { mode: "audio_end" }, audio_cue: { track: "bed", restart: true } });
  (several.pages[0]!.primitives[0] as Record<string, unknown>).selector = { by: "all" };
  assert.ok(playlistIssues(several).some((issue) => issue.path === "/pages/0/primitives/0/selector/one_at_a_time"));
});

test("soundtrack cued is a boolean", () => {
  const cue = { track: "bed", restart: true };
  assert.deepEqual(playlistIssues(soundtrackDocument({ audio_cue: cue }, { cued: true })), []);
  assert.deepEqual(playlistIssues(soundtrackDocument({ audio_cue: cue }, { cued: false })), []);
  assert.ok(playlistIssues(soundtrackDocument({ audio_cue: cue }, { cued: "yes" })).some((issue) => issue.path === "/audio/cued"));
});

test("soundtrack 128 tracks is the limit and 129 tracks is refused", () => {
  const tracksOf = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `track_${index + 1}`, media_id: "med_SONG" }));
  assert.deepEqual(playlistIssues(soundtrackDocument({}, { tracks: tracksOf(128) })), []);
  const issues = playlistIssues(soundtrackDocument({}, { tracks: tracksOf(129) }));
  assert.ok(issues.some((issue) => issue.path === "/audio/tracks" && issue.message.includes("128")));
  assert.ok(playlistIssues(soundtrackDocument({}, { tracks: [] })).some((issue) => issue.path === "/audio/tracks"));
});
test("local canonical validation accepts a camera's rtsp URL as given, or a bare url that implies the protocol", () => {
  const stream = (sources: unknown[]) => playlist({ primitive: "stream", selector: undefined, fallback_media_id: "med_FALLBACK", sources });
  const strip = (value: ReturnType<typeof playlist>) => { delete (value.pages[0]!.primitives[0] as Record<string, unknown>).selector; return value; };
  assert.deepEqual(playlistIssues(strip(stream([{ protocol: "rtsp", url: "rtsps://user:pass@192.168.1.1:7441/AbCdEf?enableSrtp" }]))), []);
  assert.deepEqual(playlistIssues(strip(stream([{ url: "rtsp://camera.local:554/stream1" }, { url: "https://example.com/live.m3u8" }]))), []);
  assert.notDeepEqual(playlistIssues(strip(stream([{ protocol: "rtsp", url: "http://192.168.1.1/stream" }]))), []);
  assert.notDeepEqual(playlistIssues(strip(stream([{ url: "rtsp://camera.local/one" }, { protocol: "rtsp", url: "rtsps://camera.local/two" }]))), []);
});
