import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addDays, allocateTags, buildLayout, buildPlaylist, campaignTiming, kindOf, placeholderBody, tagAudience, tagFromName, uploadName,
  type BuildContext, type MediaRef,
} from "./map.js";
import type { SourceLayout, SourcePlaylist, SourceSchedule, SourceZone } from "./types.js";

// ---- names and kinds ---------------------------------------------------------------------------

test("kindOf prefers the MIME type and falls back to the extension", () => {
  assert.equal(kindOf({ mime: "image/png", filename: "x.mp4" }), "image");
  assert.equal(kindOf({ mime: "video/mp4; codecs=avc1" }), "video");
  assert.equal(kindOf({ filename: "Song.MP3" }), "audio");
  assert.equal(kindOf({ filename: "Brand.ttf" }), undefined);
  assert.equal(kindOf({ mime: "application/pdf", filename: "deck.pdf" }), undefined);
  assert.equal(kindOf({}), undefined);
});

test("uploadName is the media's name with the original extension, never a path, within 255 bytes", () => {
  assert.equal(uploadName({ name: "Spring sale", filename: "IMG_001.JPG" }), "Spring sale.JPG");
  assert.equal(uploadName({ name: "Spring sale.JPG", filename: "IMG_001.JPG" }), "Spring sale.JPG");
  assert.equal(uploadName({ name: "../../etc/passwd", filename: "a.png" }), "passwd.png");
  assert.equal(uploadName({ name: "", filename: "dir/clip.mp4" }), "clip.mp4");
  assert.equal(uploadName({ name: "  ", filename: "" }), "media");
  const long = uploadName({ name: "é".repeat(300), filename: "x.png" });
  assert.ok(Buffer.byteLength(long, "utf8") <= 255);
  assert.ok(long.endsWith(".png"));
});

// ---- tags --------------------------------------------------------------------------------------

test("tagFromName strips marks, joins words and keeps intra-word capitals", () => {
  assert.equal(tagFromName("Lobby screens"), "LobbyScreens");
  assert.equal(tagFromName("Café  Étage 2"), "CafeEtage2");
  assert.equal(tagFromName("FrontDesk"), "FrontDesk");
  assert.equal(tagFromName("LOBBY wall"), "LobbyWall");
  assert.equal(tagFromName("日本語"), "");
  assert.equal(tagFromName("---"), "");
  assert.equal(tagFromName("a".repeat(40)).length, 32);
});

test("allocateTags makes empty names stable, and separates collisions with other tags and with existing screens", () => {
  const wants = [
    { key: "group:1", name: "Lobby", fallback: "Group", id: "1" },
    { key: "group:2", name: "lobby", fallback: "Group", id: "2" },
    { key: "group:3", name: "日本語", fallback: "Group", id: "3" },
    { key: "group:4", name: "Cafe", fallback: "Group", id: "4" },
    { key: "screen:9", name: "Cafe!", fallback: "Screen", id: "9" },
  ];
  const tags = allocateTags(wants, ["cafe"]);
  assert.deepEqual(tags, {
    "group:1": "Lobby",
    "group:2": "Lobby2",
    "group:3": tags["group:3"],
    "group:4": "Cafe2",
    "screen:9": "Cafe3",
  });
  assert.match(tags["group:3"]!, /^Group[0-9a-f]{6}$/);
  assert.deepEqual(allocateTags(wants, ["cafe"]), tags, "the allocation is deterministic");
});

test("allocateTags keeps earlier allocations, never reuses them, and shortens a tag to fit its digit", () => {
  const existing = { "group:1": "Lobby" };
  const next = allocateTags([{ key: "group:1", name: "Renamed", fallback: "Group", id: "1" }, { key: "group:2", name: "Lobby", fallback: "Group", id: "2" }], [], existing);
  assert.deepEqual(next, { "group:2": "Lobby2" });
  const long = `X${"x".repeat(31)}`;
  const crowded = allocateTags([{ key: "a", name: long, fallback: "Group", id: "a" }, { key: "b", name: long, fallback: "Group", id: "b" }], []);
  assert.equal(crowded.a, long);
  assert.equal(crowded.b, `X${"x".repeat(30)}2`);
});

// ---- schedules to campaigns ---------------------------------------------------------------------

function schedule(over: Partial<SourceSchedule>): SourceSchedule {
  return { id: "s", name: "S", targets: { group_ids: ["g"], screen_ids: [] }, content: { playlist_id: "p" }, priority: 0, notes: [], ...over };
}

test("an always schedule has no bounds and no windows", () => {
  assert.deepEqual(campaignTiming(schedule({ always: true })), { ok: true, lossy: [] });
});

test("a one-off schedule keeps its start and end as from and until", () => {
  assert.deepEqual(campaignTiming(schedule({ start: "2026-12-24T18:00", end: "2026-12-26T09:30" })), { ok: true, from: "2026-12-24T18:00", until: "2026-12-26T09:30", lossy: [] });
  assert.deepEqual(campaignTiming(schedule({ start: "2026-12-24T18:00" })), { ok: true, from: "2026-12-24T18:00", lossy: [] });
  assert.deepEqual(campaignTiming(schedule({ end: "2026-12-26T09:30" })), { ok: true, until: "2026-12-26T09:30", lossy: [] });
  assert.deepEqual(campaignTiming(schedule({ start: "2026-12-24T18:00", end: "2026-12-24T18:00" })), { ok: false, reason: "It ends before it starts." });
  assert.deepEqual(campaignTiming(schedule({ start: "2026-02-30T18:00" })), { ok: false, reason: "Its start or end time could not be read." });
});

test("a daily or weekly repeat becomes weekly windows from the start and end times", () => {
  assert.deepEqual(campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T17:30", repeat: { every: "day" } })), {
    ok: true, from: "2026-10-26T00:00", windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "09:00", end: "17:30" }], lossy: [],
  });
  assert.deepEqual(campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every: "week", weekdays: ["wed", "mon"] } })), {
    ok: true, from: "2026-10-26T00:00", windows: [{ days: ["mon", "wed"], start: "09:00", end: "10:00" }], lossy: [],
  });
  // A weekly repeat without weekdays repeats on the start's own day.
  const sunday = campaignTiming(schedule({ start: "2026-11-01T09:00", end: "2026-11-01T10:00", repeat: { every: "week" } }));
  assert.deepEqual(sunday.ok && sunday.windows, [{ days: ["sun"], start: "09:00", end: "10:00" }]);
});

test("a window past midnight stays exact and belongs to its start day", () => {
  const result = campaignTiming(schedule({ start: "2026-10-30T22:00", end: "2026-10-31T02:00", repeat: { every: "week", weekdays: ["fri"] } }));
  assert.deepEqual(result.ok && result.windows, [{ days: ["fri"], start: "22:00", end: "02:00" }]);
});

test("an occurrence of 24 hours or more is the whole day, and says so", () => {
  const result = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-27T09:00", repeat: { every: "week", weekdays: ["mon"] } }));
  assert.deepEqual(result.ok && result.windows, [{ days: ["mon"] }]);
  assert.match(result.ok ? result.lossy[0]! : "", /24 hours or more/);
  const open = campaignTiming(schedule({ start: "2026-10-26T09:00", repeat: { every: "day" } }));
  assert.match(open.ok ? open.lossy[0]! : "", /no end time/);
});

test("midnight to the next midnight is exactly a whole day: days only, and nothing is said", () => {
  const whole = campaignTiming(schedule({ start: "2026-10-26T00:00", end: "2026-10-27T00:00", repeat: { every: "week", weekdays: ["mon", "wed"] } }));
  assert.deepEqual(whole.ok && whole.windows, [{ days: ["mon", "wed"] }]);
  assert.deepEqual(whole.ok && whole.lossy, []);
  const daily = campaignTiming(schedule({ start: "2026-10-26T00:00", end: "2026-10-27T00:00", repeat: { every: "day" } }));
  assert.deepEqual(daily.ok && [daily.windows, daily.lossy], [[{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }], []]);
  // Anything else that long, or longer, still changed: noon to noon, midnight to the day after next, or a minute past.
  for (const [start, end] of [["2026-10-26T12:00", "2026-10-27T12:00"], ["2026-10-26T00:00", "2026-10-28T00:00"], ["2026-10-26T00:00", "2026-10-27T00:01"]] as const) {
    const longer = campaignTiming(schedule({ start, end, repeat: { every: "week", weekdays: ["mon"] } }));
    assert.match(longer.ok ? longer.lossy[0]! : "", /24 hours or more/, `${start} to ${end}`);
  }
});

test("bounds: until is the day after the last day, in every calendar corner", () => {
  const until = (end: string): string | undefined => {
    const result = campaignTiming(schedule({ start: "2026-02-01T09:00", end: "2026-02-01T10:00", repeat: { every: "day", until: end } }));
    return result.ok ? result.until : undefined;
  };
  assert.equal(until("2026-12-31"), "2027-01-01T00:00");
  assert.equal(until("2028-02-28"), "2028-02-29T00:00");
  assert.equal(until("2027-02-28"), "2027-03-01T00:00");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
  assert.deepEqual(campaignTiming(schedule({ start: "2026-02-10T09:00", end: "2026-02-10T10:00", repeat: { every: "day", until: "2026-02-09" } })), { ok: false, reason: "Its repeat ends before it starts." });
});

test("times stay civil across a daylight saving change", () => {
  const result = campaignTiming(schedule({ start: "2026-03-08T02:30", end: "2026-03-08T03:30", repeat: { every: "day", until: "2026-03-08" } }));
  assert.deepEqual(result, { ok: true, from: "2026-03-08T00:00", until: "2026-03-09T00:00", windows: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "02:30", end: "03:30" }], lossy: [] });
  const fall = campaignTiming(schedule({ start: "2026-11-01T01:30", end: "2026-11-01T02:30", repeat: { every: "week" } }));
  assert.deepEqual(fall.ok && fall.windows, [{ days: ["sun"], start: "01:30", end: "02:30" }]);
});

test("count becomes until: the last occurrence's date, for days and for weeks", () => {
  const day = campaignTiming(schedule({ start: "2026-03-06T09:00", end: "2026-03-06T10:00", repeat: { every: "day", count: 3 } }));
  assert.equal(day.ok && day.until, "2026-03-09T00:00");
  const week = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every: "week", weekdays: ["mon", "wed", "fri"], count: 5 } }));
  assert.equal(week.ok && week.until, "2026-11-05T00:00");
  const midweek = campaignTiming(schedule({ start: "2026-10-28T09:00", end: "2026-10-28T10:00", repeat: { every: "week", weekdays: ["mon", "wed"], count: 3 } }));
  assert.equal(midweek.ok && midweek.until, "2026-11-05T00:00");
  const earlier = campaignTiming(schedule({ start: "2026-03-06T09:00", end: "2026-03-06T10:00", repeat: { every: "day", count: 3, until: "2026-03-07" } }));
  assert.equal(earlier.ok && earlier.until, "2026-03-08T00:00", "the earlier of until and count wins");
  const weekday = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every: "day", weekdays: ["mon", "tue"], count: 3 } }));
  assert.equal(weekday.ok && weekday.until, "2026-11-03T00:00");
});

test("an interval above one is every day or week, and says so", () => {
  const result = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every: "week", interval: 2 } }));
  assert.deepEqual(result.ok && result.lossy, ["It repeated every 2 weeks; it now repeats every week."]);
  const days = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every: "day", interval: 3, count: 2 } }));
  assert.deepEqual(days.ok && days.lossy, ["It repeated every 3 days; it now repeats every day."]);
  assert.equal(days.ok && days.until, "2026-10-30T00:00", "count steps by the interval");
});

test("month, year, hour, minute and numbered-weekday repeats are not imported, each with its reason", () => {
  for (const every of ["month", "year", "hour", "minute"] as const) {
    const result = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every } }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, new RegExp(`by the ${every}`));
  }
  const nth = campaignTiming(schedule({ start: "2026-10-26T09:00", end: "2026-10-26T10:00", repeat: { every: "month", nth_weekday: true } }));
  assert.equal(nth.ok, false);
  const bare = campaignTiming(schedule({ repeat: { every: "day" } }));
  assert.deepEqual(bare, { ok: false, reason: "It repeats but has no start time." });
  const backwards = campaignTiming(schedule({ start: "2026-10-26T10:00", end: "2026-10-26T09:00", repeat: { every: "day" } }));
  assert.deepEqual(backwards, { ok: false, reason: "It ends before it starts." });
});

test("tagAudience is one tag, or any of several", () => {
  assert.deepEqual(tagAudience(["Lobby"]), { tag: "Lobby" });
  assert.deepEqual(tagAudience(["Lobby", "Cafe"]), { any: [{ tag: "Lobby" }, { tag: "Cafe" }] });
});

// ---- playlists ---------------------------------------------------------------------------------

const refs = new Map<string, MediaRef>([
  ["img1", { id: "med_img1", kind: "image" }],
  ["img2", { id: "med_img2", kind: "image" }],
  ["vid1", { id: "med_vid1", kind: "video", duration_ms: 12_000 }],
  ["vid2", { id: "med_vid2", kind: "video" }],
  ["aud1", { id: "med_aud1", kind: "audio" }],
  ["aud2", { id: "med_aud2", kind: "audio" }],
]);

function context(playlists: SourcePlaylist[] = [], layouts: SourceLayout[] = []): BuildContext {
  return { media: refs, playlists: new Map(playlists.map((item) => [item.id, item])), layouts: new Map(layouts.map((item) => [item.id, item])), canvas: { width: 1280, height: 720 } };
}

function playlist(items: SourcePlaylist["items"], over: Partial<SourcePlaylist> = {}): SourcePlaylist {
  return { id: "p", name: "Lobby loop", items, notes: [], ...over };
}

type Page = { id: string; advance: Record<string, unknown>; canvas: Record<string, unknown>; primitives: Array<Record<string, unknown>> };
const pagesOf = (built: ReturnType<typeof buildPlaylist>): Page[] => {
  assert.ok(built.ok, built.ok ? "" : built.reason);
  return (built.document as { pages: Page[] }).pages;
};

test("a plain playlist is one page per item: images hold 8 seconds or their own, videos play to the end", () => {
  const built = buildPlaylist(playlist([{ media_id: "img1" }, { media_id: "img2", duration_s: 15 }, { media_id: "vid1" }, { media_id: "vid2", duration_s: 20 }]), context());
  const pages = pagesOf(built);
  assert.deepEqual(pages.map((page) => page.id), ["page_1", "page_2", "page_3", "page_4"]);
  assert.deepEqual(pages.map((page) => page.advance), [
    { mode: "duration", after_ms: 8000 }, { mode: "duration", after_ms: 15_000 }, { mode: "media_end" }, { mode: "duration", after_ms: 20_000 },
  ]);
  assert.deepEqual(pages[0]!.canvas, { width: 1280, height: 720, viewport_fit: "contain", background: "#000000FF" });
  assert.deepEqual(pages[2]!.primitives[0], { id: "content", primitive: "video", selector: { by: "id", media_id: "med_vid1" }, rect: { x: 0, y: 0, width: 1280, height: 720 }, layer: 0, content_fit: "contain", muted: true, loop: false });
  assert.equal(pages[3]!.primitives[0]!.loop, true, "a video held for a set time loops to fill it");
  assert.equal(built.ok && built.document.name, "Lobby loop");
});

test("a web page item becomes an iframe page titled by its address", () => {
  const pages = pagesOf(buildPlaylist(playlist([{ url: "https://example.com/menu", duration_s: 30 }, { url: "http://lan.example.com:8080/", title: "Specials" }]), context()));
  assert.deepEqual(pages[0]!.primitives[0], { id: "content", primitive: "iframe", src: "https://example.com/menu", title: "example.com", rect: { x: 0, y: 0, width: 1280, height: 720 }, layer: 0, content_fit: "fill" });
  assert.equal(pages[1]!.primitives[0]!.title, "Specials");
  assert.deepEqual(pages[0]!.advance, { mode: "duration", after_ms: 30_000 });
});

test("audio items become the soundtrack, and an audio-only list is not imported", () => {
  const built = buildPlaylist(playlist([{ media_id: "aud1" }, { media_id: "img1" }, { media_id: "aud2" }, { media_id: "aud1" }]), context());
  assert.ok(built.ok);
  assert.deepEqual(built.document.audio, { tracks: [{ id: "track_1", media_id: "med_aud1" }, { id: "track_2", media_id: "med_aud2" }] });
  assert.equal(pagesOf(built).length, 1);
  assert.ok(built.lossy.some((line) => /soundtrack/.test(line)));
  const only = buildPlaylist(playlist([{ media_id: "aud1" }]), context());
  assert.deepEqual(only, { ok: false, reason: "It holds only audio, and a playlist needs at least one page.", lossy: only.lossy });
});

test("shuffle plays in order, and says so", () => {
  const built = buildPlaylist(playlist([{ media_id: "img1" }], { shuffle: true }), context());
  assert.ok(built.ok && built.lossy.includes("It played in random order; it now plays in order."));
});

test("nested playlists and layouts are inlined, and a cycle stops with a note", () => {
  const inner = playlist([{ media_id: "img2" }], { id: "inner", name: "Inner" });
  const loops = playlist([{ media_id: "img1" }, { playlist_id: "loops" }, { playlist_id: "inner" }], { id: "loops", name: "Loops" });
  const built = buildPlaylist(loops, context([inner, loops]));
  assert.equal(pagesOf(built).length, 2);
  assert.ok(built.ok && built.lossy.includes("Playlist Loops contains itself; the repeat was left out."));
  const layout: SourceLayout = { id: "l", name: "Split", zones: [zone("a", 0, 0, 1920, 1080, 0, [{ media_id: "img1" }])], notes: [] };
  const mixed = buildPlaylist(playlist([{ media_id: "img2" }, { layout_id: "l" }]), context([], [layout]));
  const pages = pagesOf(mixed);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[1]!.canvas, { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" });
});

test("items whose media did not come over, and addresses that are not web addresses, are left out and counted", () => {
  const built = buildPlaylist(playlist([{ media_id: "gone" }, { media_id: "img1" }, { media_id: "gone2" }, { url: "ftp://example.com/x" }]), context());
  assert.equal(pagesOf(built).length, 1);
  assert.ok(built.ok && built.lossy.includes("2 items were left out because their media did not come over."));
  assert.ok(built.ok && built.lossy.some((line) => /1 web page was left out/.test(line)));
  const empty = buildPlaylist(playlist([{ media_id: "gone" }]), context());
  assert.deepEqual(empty.ok, false);
  assert.equal(empty.ok ? "" : empty.reason, "Nothing in it can be imported.");
});

test("a long name is shortened to 120 characters and says so; durations beyond the limits are moved", () => {
  const built = buildPlaylist(playlist([{ media_id: "img1", duration_s: 0.2 }], { name: "n".repeat(130) }), context());
  assert.ok(built.ok);
  assert.equal((built.document.name as string).length, 120);
  assert.ok(built.lossy.some((line) => /longer than 120/.test(line)));
  assert.ok(built.lossy.some((line) => /nearest limit/.test(line)));
  assert.equal(pagesOf(built)[0]!.advance.after_ms, 1000);
});

test("more than 100 pages is refused with the validator's own words", () => {
  const items = Array.from({ length: 101 }, () => ({ media_id: "img1" }));
  const built = buildPlaylist(playlist(items), context());
  assert.equal(built.ok, false);
  assert.match(built.ok ? "" : built.reason, /would be refused/);
});

// ---- layouts -----------------------------------------------------------------------------------

function zone(id: string, x: number, y: number, width: number, height: number, z: number, items: SourceZone["items"]): SourceZone {
  return { id, name: `Zone ${id}`, x, y, width, height, z, items };
}

function layout(zones: SourceZone[], over: Partial<SourceLayout> = {}): SourceLayout {
  return { id: "l", name: "Menu board", width: 1920, height: 1080, zones, notes: [], ...over };
}

test("a single-zone layout with a video plays it to its end", () => {
  const built = buildLayout(layout([zone("a", 0, 0, 1920, 1080, 0, [{ media_id: "vid1", duration_s: 99 }])]), context());
  assert.ok(built.ok);
  const pages = (built.document as { pages: Page[] }).pages;
  assert.deepEqual(pages[0]!.advance, { mode: "media_end" });
  assert.equal(pages[0]!.primitives[0]!.loop, false);
});

test("a multi-zone layout has one page per item of the largest zone, the others cycling beside it", () => {
  const main = zone("main", 0, 0, 1280, 1080, 2, [{ media_id: "img1", duration_s: 10 }, { media_id: "vid1" }, { media_id: "img2" }]);
  const side = zone("side", 1280, 0, 640, 540, 0, [{ media_id: "img2" }, { media_id: "vid2" }]);
  const ticker = zone("tick", 1280, 540, 640, 540, 1, [{ url: "https://example.com/ticker" }]);
  const built = buildLayout(layout([side, main, ticker]), context());
  assert.ok(built.ok);
  const pages = (built.document as { pages: Page[] }).pages;
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((page) => page.advance), [
    { mode: "duration", after_ms: 10_000 }, { mode: "duration", after_ms: 12_000 }, { mode: "duration", after_ms: 8000 },
  ]);
  // Layers follow z: side (0), ticker (1), main (2); ids follow the vendor's zone order.
  const first = pages[0]!.primitives;
  assert.deepEqual(first.map((item) => [item.id, item.layer]), [["zone_1", 0], ["zone_2", 2], ["zone_3", 1]]);
  assert.deepEqual(first[0]!.rect, { x: 1280, y: 0, width: 640, height: 540 });
  assert.deepEqual(pages.map((page) => (page.primitives[0]!.selector as { media_id: string }).media_id), ["med_img2", "med_vid2", "med_img2"]);
  assert.equal(pages[1]!.primitives[0]!.loop, true, "a video beside the main zone loops, muted");
  assert.equal(pages[1]!.primitives[0]!.muted, true);
  assert.ok(built.lossy.some((line) => /Zone side advances together with the main zone Zone main/.test(line)));
  assert.equal(built.lossy.filter((line) => /never show/.test(line)).length, 0);
});

test("items past the main zone's count never show, and the layout says so", () => {
  const main = zone("main", 0, 0, 1280, 1080, 0, [{ media_id: "img1" }]);
  const side = zone("side", 1280, 0, 640, 1080, 1, [{ media_id: "img1" }, { media_id: "img2" }, { media_id: "vid2" }]);
  const built = buildLayout(layout([main, side]), context());
  assert.ok(built.ok);
  assert.equal((built.document as { pages: Page[] }).pages.length, 1);
  assert.ok(built.lossy.some((line) => /Items past 1 in zone Zone side never show/.test(line)));
});

test("the main zone is the largest, ties going to the lowest z and then the first", () => {
  const a = zone("a", 0, 0, 100, 100, 5, [{ media_id: "img1" }, { media_id: "img2" }]);
  const b = zone("b", 100, 0, 100, 100, 1, [{ media_id: "img2" }]);
  const built = buildLayout(layout([a, b]), context());
  assert.ok(built.ok);
  assert.equal((built.document as { pages: Page[] }).pages.length, 1, "b has the lower z, so b is the main zone");
});

test("a video with no stated duration in a multi-zone layout holds for the uploaded video's length", () => {
  const main = zone("main", 0, 0, 1280, 1080, 0, [{ media_id: "vid1" }]);
  const side = zone("side", 1280, 0, 640, 1080, 1, [{ media_id: "img1" }]);
  const built = buildLayout(layout([main, side]), context());
  assert.ok(built.ok);
  assert.deepEqual((built.document as { pages: Page[] }).pages[0]!.advance, { mode: "duration", after_ms: 12_000 });
});

test("zones are clamped to the canvas as whole numbers, and zones with nothing importable are dropped", () => {
  const main = zone("main", -10.4, -3, 2500.6, 600.4, 0, [{ media_id: "img1" }]);
  const lost = zone("lost", 0, 0, 100, 100, 1, [{ media_id: "gone" }]);
  const built = buildLayout(layout([main, lost]), context());
  assert.ok(built.ok);
  const pages = (built.document as { pages: Page[] }).pages;
  assert.deepEqual(pages[0]!.primitives[0]!.rect, { x: 0, y: 0, width: 1920, height: 600 });
  assert.equal(pages[0]!.primitives.length, 1);
  assert.ok(built.lossy.some((line) => /Zone lost had nothing that could be imported/.test(line)));
});

test("a layout with no importable zone is not imported; a layout without a size uses 1920 by 1080", () => {
  const none = buildLayout(layout([zone("a", 0, 0, 10, 10, 0, [{ media_id: "gone" }])]), context());
  assert.deepEqual(none.ok, false);
  assert.equal(none.ok ? "" : none.reason, "None of its zones holds anything that can be imported.");
  const plain = buildLayout({ id: "l", name: "No size", zones: [zone("a", 0, 0, 10, 10, 0, [{ media_id: "img1" }])], notes: [] }, context());
  assert.ok(plain.ok);
  assert.deepEqual((plain.document as { pages: Page[] }).pages[0]!.canvas.width, 1920);
});

// ---- placeholders -------------------------------------------------------------------------------

test("a placeholder's label is cut to 80 characters and its tags to 16, the own tag first", () => {
  const groups = Array.from({ length: 20 }, (_, index) => `g${index}`);
  const body = placeholderBody({ name: "x".repeat(90), group_ids: groups }, (id) => `T${id}`, "Own");
  assert.equal([...body.label].length, 80);
  assert.equal(body.tags.length, 16);
  assert.equal(body.tags[0], "Own");
  assert.equal(body.lossy.length, 2);
  const plain = placeholderBody({ name: "Front desk", group_ids: ["a", "a", "zz"] }, (id) => (id === "zz" ? undefined : `T${id}`), undefined);
  assert.deepEqual(plain, { label: "Front desk", tags: ["Ta"], lossy: [] });
});
