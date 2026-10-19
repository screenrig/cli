import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "./problems.js";
import { validatePlaylistWrite } from "./playlist-write-validation.js";
import { playlistIssues } from "./playlist-validate.js";

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

function playlistWithTransition(transition: unknown) {
  const value = playlistWithPrimitives(TWO_IFRAMES);
  return { ...value, pages: value.pages.map((page) => ({ ...page, transition })) };
}

test("both local authoring validators accept all fifteen transition types without changing the document", () => {
  const plainTypes = ["crossfade", "swipe-left", "swipe-right", "swipe-up", "swipe-down", "dip", "wipe-left", "wipe-right", "wipe-up", "wipe-down", "slide-left", "slide-right", "slide-up", "slide-down"] as const;
  const transitions: unknown[] = [];
  for (const type of plainTypes) {
    for (const duration_ms of [0, 200, 60_000]) {
      transitions.push({ type, duration_ms });
      for (const ease of ["linear", "in", "out", "in-out"] as const) transitions.push({ type, duration_ms, ease });
    }
  }
  transitions.push({ type: "dip", duration_ms: 800, ease: "in-out", color: "#aB09fF" });
  for (const theme of ["neomustard", "aurora", "folio", "signal", "manifesto", "bloom", "primetime"] as const) {
    transitions.push({ type: "stinger", duration_ms: 3500, stinger: { theme, title: "FIRST HALF", subtitle: "Example match", logo: "media:med_01EXAMPLE", accent: "#FF2d4B", hang_ms: 1000 } });
  }
  for (const duration_ms of [2000, 2001, 3500, 6000]) {
    transitions.push({ type: "stinger", duration_ms, stinger: {} });
    for (const hang_ms of [0, Math.floor(duration_ms * 3 / 5)]) transitions.push({ type: "stinger", duration_ms, stinger: { hang_ms } });
  }
  transitions.push({ type: "stinger", duration_ms: 2000, stinger: { title: "", subtitle: "" } });
  transitions.push({ type: "stinger", duration_ms: 2000, stinger: { title: "🌟".repeat(40), subtitle: "🌟".repeat(60) } });
  transitions.push({ type: "stinger", duration_ms: 2000, stinger: { logo: `media:med_${"x".repeat(120)}` } });
  for (const transition of transitions) {
    const value = playlistWithTransition(transition);
    const original = structuredClone(value);
    assert.deepEqual(validatePlaylistWrite(value, new Map()), new Set(), JSON.stringify(transition));
    assert.deepEqual(playlistIssues(value), [], JSON.stringify(transition));
    assert.deepEqual(value, original);
  }
});

test("both local authoring validators refuse transition rule violations at the server's member path", () => {
  const plain = (members: Record<string, unknown>) => ({ type: "crossfade", duration_ms: 200, ...members });
  const stinger = (members: Record<string, unknown>, duration_ms: unknown = 3500) => ({ type: "stinger", duration_ms, stinger: members });
  const cases: Array<[unknown, string]> = [
    ...[undefined, null, [], "crossfade", 200].map((value): [unknown, string] => [value, ""]),
    [{ duration_ms: 200 }, "type"],
    [{ type: "crossfade" }, "duration_ms"],
    [plain({ extra: true }), "extra"],
    [plain({ "extra/~": true }), "extra/~"],
    ...[null, 1, {}, ["crossfade"], "", "fade", "STINGER"].map((type): [unknown, string] => [plain({ type }), "type"]),
    ...[null, "200", -1, 60_001, 0.5, NaN, Infinity].map((duration_ms): [unknown, string] => [plain({ duration_ms }), "duration_ms"]),
    ...[null, "", "ease-in", 1, ["linear"]].map((ease): [unknown, string] => [plain({ ease }), "ease"]),
    [plain({ color: "#000000" }), "color"],
    ...[null, "#000", "#000000FF", "#GG0000", "#000000\n", 123].map((color): [unknown, string] => [{ type: "dip", duration_ms: 800, color }, "color"]),
    ...[null, {}, []].map((value): [unknown, string] => [plain({ stinger: value }), "stinger"]),
    [{ type: "stinger", duration_ms: 3500 }, "stinger"],
    ...[null, [], "title", 1].map((value): [unknown, string] => [{ type: "stinger", duration_ms: 3500, stinger: value }, "stinger"]),
    ...[0, 1999, 6001, 60_000, 3500.5].map((duration): [unknown, string] => [stinger({}, duration), "duration_ms"]),
    [stinger({ extra: true }), "stinger.extra"],
    [stinger({ duration_ms: 3500 }), "stinger.duration_ms"],
    [stinger({ hangMs: 1000 }), "stinger.hangMs"],
    ...[null, "", "unknown", "Primetime", 1, ["aurora"]].map((theme): [unknown, string] => [stinger({ theme }), "stinger.theme"]),
    ...[null, 1, [], "x".repeat(41), "🌟".repeat(41)].map((title): [unknown, string] => [stinger({ title }), "stinger.title"]),
    ...[null, 1, [], "x".repeat(61), "🌟".repeat(61)].map((subtitle): [unknown, string] => [stinger({ subtitle }), "stinger.subtitle"]),
    ...[null, "#fff", "#11223344", "#GG0000", "#112233\n", 1].map((accent): [unknown, string] => [stinger({ accent }), "stinger.accent"]),
    // The server resolves a logo through the card media check, which accepts only media:med_<id>.
    ...[null, "", "media:", "media:example", `media:${"x".repeat(300)}`, `media:med_${"x".repeat(121)}`, "med_EXAMPLE", "MEDIA:med_EXAMPLE", "https://example.com/logo.png", 1].map((logo): [unknown, string] => [stinger({ logo }), "stinger.logo"]),
    ...[null, "1000", -1, 6001, 0.5, 2101, NaN, Infinity].map((hang_ms): [unknown, string] => [stinger({ hang_ms }), "stinger.hang_ms"]),
    [stinger({ hang_ms: 1201 }, 2001), "stinger.hang_ms"],
    ...["linear", "in", "out", "in-out", null].map((ease): [unknown, string] => [{ ...stinger({}), ease }, "ease"]),
    [{ ...stinger({}), color: "#000000" }, "color"],
  ];
  for (const type of ["swipe-left", "swipe-right", "swipe-up", "swipe-down", "wipe-left", "wipe-right", "wipe-up", "wipe-down", "slide-left", "slide-right", "slide-up", "slide-down"]) {
    cases.push([plain({ type, color: "#000000" }), "color"], [plain({ type, stinger: {} }), "stinger"]);
  }
  for (const [transition, field] of cases) {
    const value = playlistWithTransition(transition);
    const path = `playlist.pages[0].transition${field ? `.${field}` : ""}`;
    assert.throws(() => validatePlaylistWrite(value, new Map()), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.ok(error.problem.detail.startsWith(`${path} `), error.problem.detail);
      return true;
    }, JSON.stringify(transition) ?? "missing transition");
    const pointer = field.split(".").filter(Boolean).map((key) => `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
    // The canonical schema decides validity and may add companion errors for a conditional rule;
    // the offending member's path must be among the issues.
    const issuePaths = playlistIssues(value).map((issue) => issue.path);
    assert.ok(issuePaths.includes(`/pages/0/transition${pointer}`), `${JSON.stringify(transition) ?? "missing transition"} -> ${issuePaths.join(", ")}`);
  }
});

test("playlist write accepts two iframe primitives on a page", () => {
  assert.deepEqual(validatePlaylistWrite(playlistWithPrimitives(TWO_IFRAMES), new Map()), new Set());
});

test("playlist write accepts a panning background and a spinning badge", () => {
  assert.deepEqual(
    validatePlaylistWrite(playlistWithPrimitives([{
      id: "background",
      primitive: "image",
      selector: { by: "id", media_id: "med_background" },
      rect: { x: 0, y: 0, width: 2400, height: 1080 },
      layer: 0,
      content_fit: "cover",
      motion: { type: "path", points: [{ x: -480, y: 0 }], rate: 40, loop: "loop" },
    }]), new Map([["med_background", "image"]])),
    new Set(["med_background"]),
  );
  assert.deepEqual(
    validatePlaylistWrite(playlistWithPrimitives([{
      id: "badge",
      primitive: "image",
      selector: { by: "id", media_id: "med_badge" },
      rect: { x: 1640, y: 80, width: 200, height: 200 },
      layer: 1,
      content_fit: "contain",
      motion: { type: "spin", direction: "cw", speed: "slow" },
    }]), new Map([["med_badge", "image"]])),
    new Set(["med_badge"]),
  );
});

test("playlist write rejects spin on an iframe and a path with 65 points", () => {
  assert.throws(
    () => validatePlaylistWrite(playlistWithPrimitives([{
      ...iframePrimitive("web", "https://example.com/"),
      motion: { type: "spin", direction: "cw", speed: "slow" },
    }]), new Map()),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.match(error.problem.detail, /spin is not allowed/);
      return true;
    },
  );
  assert.throws(
    () => validatePlaylistWrite(playlistWithPrimitives([{
      id: "background",
      primitive: "image",
      selector: { by: "id", media_id: "med_background" },
      rect: { x: 0, y: 0, width: 2400, height: 1080 },
      layer: 0,
      content_fit: "cover",
      motion: {
        type: "path",
        points: Array.from({ length: 65 }, (_, index) => ({ x: index, y: 0 })),
        rate: 40,
        loop: "loop",
      },
    }]), new Map([["med_background", "image"]])),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.problem.code, "usage_error");
      assert.match(error.problem.detail, /1 to 64 waypoints/);
      return true;
    },
  );
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

function soundtrackPlaylist(overrides: Record<string, unknown> = {}, cue?: unknown) {
  const base = playlistWithPrimitives(TWO_IFRAMES) as Record<string, any>;
  if (cue !== undefined) base.pages[0].audio_cue = cue;
  return { ...base, audio: { tracks: [{ id: "intro", media_id: "med_SONG" }, { id: "bed", media_id: "med_BED" }], loop: false, volume: 0.5 }, ...overrides };
}

const AUDIO_MEDIA = new Map([["med_SONG", "audio"], ["med_BED", "audio"], ["med_STILL", "image"]] as const);

test("playlist write accepts a soundtrack and a page cue and reports the track media", () => {
  assert.deepEqual(
    validatePlaylistWrite(soundtrackPlaylist({}, { track: "bed", restart: true }), AUDIO_MEDIA),
    new Set(["med_SONG", "med_BED"]),
  );
});

test("playlist write rejects malformed soundtracks and cues", () => {
  const cases: Array<[string, unknown]> = [
    ["no tracks", soundtrackPlaylist({ audio: { tracks: [] } })],
    ["duplicate id", soundtrackPlaylist({ audio: { tracks: [{ id: "a", media_id: "med_SONG" }, { id: "a", media_id: "med_BED" }] } })],
    ["image track", soundtrackPlaylist({ audio: { tracks: [{ id: "a", media_id: "med_STILL" }] } })],
    ["missing media", soundtrackPlaylist({ audio: { tracks: [{ id: "a", media_id: "med_GONE" }] } })],
    ["volume", soundtrackPlaylist({ audio: { tracks: [{ id: "a", media_id: "med_SONG" }], volume: 1.5 } })],
    ["extra key", soundtrackPlaylist({ audio: { tracks: [{ id: "a", media_id: "med_SONG" }], fade_ms: 200 } })],
    ["unknown cue track", soundtrackPlaylist({}, { track: "missing" })],
    ["cue without soundtrack", (() => { const value = playlistWithPrimitives(TWO_IFRAMES) as any; value.pages[0].audio_cue = { track: "intro" }; return value; })()],
  ];
  for (const [name, value] of cases) {
    assert.throws(() => validatePlaylistWrite(value, AUDIO_MEDIA), CliError, name);
  }
});

function imagePage(id: string, advance: unknown, cue?: unknown, imageOverrides: Record<string, unknown> = {}) {
  return {
    id,
    canvas: { width: 1920, height: 1080, background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance,
    ...(cue === undefined ? {} : { audio_cue: cue }),
    primitives: [{
      id: "image",
      primitive: "image",
      selector: { by: "id", media_id: "med_STILL" },
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      layer: 0,
      content_fit: "contain",
      ...imageOverrides,
    }],
  };
}

function audioEndPlaylist(page: Record<string, unknown>, audio: unknown = { tracks: [{ id: "intro", media_id: "med_SONG" }, { id: "bed", media_id: "med_BED" }], loop: false, volume: 0.5 }) {
  return { name: "Album", ...(audio === null ? {} : { audio }), pages: [page] };
}

const AUDIO_END_MEDIA = new Set(["med_SONG", "med_BED", "med_STILL"]);

test("soundtrack audio_end page: a page cued to a track ends with it, with or without a max_ms hint", () => {
  const cue = { track: "bed", restart: true };
  assert.deepEqual(validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end" }, cue)), AUDIO_MEDIA), AUDIO_END_MEDIA);
  assert.deepEqual(validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end", max_ms: 214_000 }, cue)), AUDIO_MEDIA), AUDIO_END_MEDIA);
  // A selector that matches several images plays one at a time, as on a duration page.
  const several = imagePage("one", { mode: "audio_end" }, cue, { selector: { by: "ids", media_ids: ["med_STILL", "med_STILL2"], one_at_a_time: true } });
  assert.doesNotThrow(() => validatePlaylistWrite(audioEndPlaylist(several), new Map([...AUDIO_MEDIA, ["med_STILL2", "image"] as const])));
});

test("soundtrack audio_end without cue, without soundtrack, or with a bad hint is refused", () => {
  const cue = { track: "bed", restart: true };
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end" })), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError && /pages\[0\]\.advance audio_end requires an audio_cue on the same page/.test(error.problem.detail),
  );
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end" }), null), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError && /audio_end requires an audio_cue/.test(error.problem.detail),
  );
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end" }, cue), null), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError && /requires a playlist audio soundtrack/.test(error.problem.detail),
  );
  assert.throws(() => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end" }, { track: "missing" })), AUDIO_MEDIA), CliError);
  assert.throws(() => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end", max_ms: 500 }, cue)), AUDIO_MEDIA), CliError);
  assert.throws(() => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end", after_ms: 5000 }, cue)), AUDIO_MEDIA), CliError);
});

test("soundtrack audio_end image dwell: an audio_end page follows the duration page rules", () => {
  const cue = { track: "bed", restart: true };
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(imagePage("one", { mode: "audio_end" }, cue, { dwell_ms: 3000 })), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError && /audio_end pages forbid image dwell_ms/.test(error.problem.detail),
  );
  const several = imagePage("one", { mode: "audio_end" }, cue, { selector: { by: "ids", media_ids: ["med_STILL", "med_STILL2"] } });
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(several), new Map([...AUDIO_MEDIA, ["med_STILL2", "image"] as const])),
    (error: unknown) => error instanceof CliError && /multi-item selectors require one_at_a_time true/.test(error.problem.detail),
  );
});

test("soundtrack cued: cued is a boolean on the soundtrack", () => {
  const tracks = [{ id: "intro", media_id: "med_SONG" }, { id: "bed", media_id: "med_BED" }];
  const page = imagePage("one", { mode: "duration", after_ms: 5000 }, { track: "bed", restart: true });
  assert.deepEqual(validatePlaylistWrite(audioEndPlaylist(page, { tracks, loop: false, volume: 0.5, cued: true }), AUDIO_MEDIA), AUDIO_END_MEDIA);
  assert.doesNotThrow(() => validatePlaylistWrite(audioEndPlaylist(page, { tracks, cued: false }), AUDIO_MEDIA));
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(page, { tracks, cued: "yes" }), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError && /cued/.test(error.problem.detail),
  );
});

test("soundtrack 128 tracks and 129 tracks: the limit is 128 and the refusal names it and the count", () => {
  const tracksOf = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `track_${index + 1}`, media_id: "med_SONG" }));
  const page = imagePage("one", { mode: "duration", after_ms: 5000 });
  assert.deepEqual(validatePlaylistWrite(audioEndPlaylist(page, { tracks: tracksOf(128) }), AUDIO_MEDIA), new Set(["med_SONG", "med_STILL"]));
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(page, { tracks: tracksOf(129) }), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError
      && error.problem.code === "usage_error"
      && error.problem.detail.includes("audio.tracks must contain 1 to 128 tracks; this playlist has 129."),
  );
  assert.throws(
    () => validatePlaylistWrite(audioEndPlaylist(page, { tracks: [] }), AUDIO_MEDIA),
    (error: unknown) => error instanceof CliError && error.problem.detail.includes("audio.tracks must contain 1 to 128 tracks; this playlist has 0."),
  );
});
