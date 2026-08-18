import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "./problems.js";
import {
  expandPlaylistPage,
  expandPlaylistPages,
  formatTemplateCatalog,
  longestSansLineWidth,
  minSansLineHeight,
  playlistTemplateCatalog,
  SHARED_LOGO_RECT,
  SLIDE_BACKGROUND,
  SLIDE_BAR_COLOR,
  SLIDE_DEFAULT_ADVANCE,
  SLIDE_DEFAULT_TRANSITION,
  SLIDE_DIM,
  SLIDE_FAINT,
  SLIDE_FIT_MAX_RATIO,
  SLIDE_FONT_FAMILY,
  SLIDE_MUSTARD,
  SLIDE_PLATE_FILL,
  SLIDE_PLATE_PAD_X,
  SLIDE_PLATE_PAD_Y,
  SLIDE_PLATE_RADIUS,
  SLIDE_TEMPLATES,
  SLIDE_TEXT_COLOR,
} from "./playlist-templates.js";

const MEDIA = {
  type: "image" as const,
  selector: { by: "id" as const, media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
  alt: "Lobby still",
};

const VIDEO = {
  type: "video" as const,
  selector: { by: "id" as const, media_id: "med_BBBBBBBBBBBBBBBBBBBBBBBB" },
  loop: false,
};

const CATALOG_IDS = [
  "slide-intro",
  "slide-text-only-1",
  "slide-text-only-2",
  "slide-text-photo-1",
  "slide-text-photo-2",
  "slide-text-photo-3",
  "slide-half-bleed-1",
  "slide-half-bleed-2",
  "slide-quote",
  "slide-callout",
  "slide-bullets",
  "slide-stat-grid",
  "slide-three-up",
  "slide-photo",
  "slide-full-bleed",
] as const;

const RETIRED_IDS = [
  "slide-title",
  "slide-text-1",
  "slide-section",
  "slide-text-2",
  "slide-compare",
  "slide-image-text",
];

const TEXT_LOGO_GAP = 16;

function assertUsage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "usage_error");
    assert.match(err.problem.detail, pattern);
    return true;
  });
}

function bar() {
  return {
    id: "bar",
    content: {
      type: "line",
      orientation: "horizontal",
      color: SLIDE_BAR_COLOR,
    },
    rect: { x: 0, y: 0, width: 1920, height: 16 },
    layer: 1,
    content_fit: "fill",
  };
}

interface ExpandedPlacement {
  id: string;
  layer: number;
  content_fit?: string;
  rect: { x: number; y: number; width: number; height: number };
  content: {
    type: string;
    color?: string;
    text?: string;
    align?: string;
    vertical_align?: string;
    font_size?: number;
    line_height?: number;
    font_weight?: number;
    fill?: string;
    corner_radius?: { top_left: number };
  };
}

function asPlacements(value: unknown): ExpandedPlacement[] {
  return (value as { placements: ExpandedPlacement[] }).placements;
}

function placement(value: unknown, id: string): ExpandedPlacement {
  const found = asPlacements(value).find((item) => item.id === id);
  assert.ok(found, `missing placement ${id}`);
  return found;
}

function descenderSafe(fontSize: number, lineHeight: number): boolean {
  return lineHeight >= minSansLineHeight(fontSize);
}

test("the closed catalog is exactly the fifteen slide templates", () => {
  const catalog = playlistTemplateCatalog();
  assert.deepEqual(catalog.templates.map((template) => template.id), [...CATALOG_IDS]);
  assert.equal(SLIDE_TEMPLATES.length, 15);
  assert.equal(catalog.wrap, false);
  assert.equal(catalog.font_family, "sans");
  assert.equal(catalog.canvas.background, SLIDE_BACKGROUND);
  assert.equal(catalog.canvas.width, 1920);
  assert.equal(catalog.canvas.height, 1080);
  assert.equal(catalog.canvas.viewport_fit, "contain");
  assert.equal(catalog.text_color, SLIDE_TEXT_COLOR);
  const formatted = formatTemplateCatalog(catalog);
  assert.match(formatted, /slide-intro/);
  assert.match(formatted, /slide-callout/);
  assert.match(formatted, /slide-full-bleed/);
  assert.match(formatted, /title \(text, required, align center, vertical_align middle\)/);
  assert.doesNotMatch(formatted, /slide-title/);
  assert.doesNotMatch(formatted, /slide-image-text/);
  const intro = catalog.templates.find((template) => template.id === "slide-intro");
  assert.deepEqual(intro?.slots, [
    { id: "title", kind: "text", required: true, align: "center", vertical_align: "middle" },
    { id: "subtitle", kind: "text", required: false, align: "center" },
    { id: "logo", kind: "image", required: false },
  ]);
  const photo = catalog.templates.find((template) => template.id === "slide-text-photo-1");
  assert.ok(photo?.slots.some((slot) => slot.id === "picture" && slot.kind === "image_or_video"));
  const headline = photo?.slots.find((slot) => slot.id === "headline");
  assert.equal(headline?.align, "left");
  const callout = catalog.templates.find((template) => template.id === "slide-callout");
  assert.deepEqual(callout?.slots.map((slot) => slot.id), ["headline", "body", "logo"]);
  assert.equal(callout?.slots.find((slot) => slot.id === "headline")?.align, "center");
});

test("slide-intro expands title, optional subtitle, and the mustard bar", () => {
  const expanded = expandPlaylistPage({
    id: "intro",
    template: "slide-intro",
    slots: {
      title: { text: "Welcome" },
      subtitle: { text: ["Line one", "Line two"] },
    },
  }) as { id: string; placements: ExpandedPlacement[] };
  assert.equal(expanded.id, "intro");
  const placements = asPlacements(expanded);
  assert.deepEqual(placements.map((item) => item.id), ["bar", "title", "subtitle"]);
  assert.deepEqual(placements[0], bar());
  const title = placement(expanded, "title");
  const subtitle = placement(expanded, "subtitle");
  assert.equal(title.content.text, "Welcome");
  assert.equal(title.content.font_weight, 700);
  assert.equal(title.content.align, "center");
  assert.equal(title.content.vertical_align, "middle");
  assert.equal(title.content.color, SLIDE_MUSTARD);
  assert.equal(title.rect.width, 1600);
  assert.equal(title.rect.height, title.content.line_height);
  assert.ok((title.content.font_size ?? 0) >= 96);
  assert.ok((title.content.font_size ?? 0) <= Math.floor(96 * SLIDE_FIT_MAX_RATIO));
  assert.ok(descenderSafe(title.content.font_size ?? 0, title.content.line_height ?? 0));
  assert.equal(subtitle.content.text, "Line one\nLine two");
  assert.equal(subtitle.content.color, SLIDE_DIM);
  assert.equal(subtitle.content.align, "center");
  assert.equal(subtitle.rect.height, 2 * (subtitle.content.line_height ?? 0));
  assert.ok(title.rect.y + title.rect.height <= subtitle.rect.y);
});

test("slide-intro omits subtitle and logo when they are absent", () => {
  const expanded = expandPlaylistPage({
    id: "intro",
    template: "slide-intro",
    slots: { title: { text: "Welcome" } },
  }) as { placements: Array<{ id: string }> };
  assert.deepEqual(expanded.placements.map((item) => item.id), ["bar", "title"]);
});

test("slide-text-only-1 splits the centered stack and keeps mustard eyebrow", () => {
  const expanded = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: "Hours" },
      body: { text: "Open daily" },
    },
  });
  const placements = asPlacements(expanded);
  assert.deepEqual(placements.map((item) => item.id), ["bar", "eyebrow", "headline", "body"]);
  const eyebrow = placement(expanded, "eyebrow");
  const headline = placement(expanded, "headline");
  const body = placement(expanded, "body");
  assert.equal(eyebrow.content.color, SLIDE_MUSTARD);
  assert.equal(headline.content.color, SLIDE_TEXT_COLOR);
  assert.equal(body.content.color, SLIDE_DIM);
  assert.equal(eyebrow.rect.x, 160);
  assert.equal(eyebrow.rect.width, 1600);
  assert.equal(eyebrow.rect.height, eyebrow.content.line_height);
  assert.equal(headline.rect.height, headline.content.line_height);
  assert.equal(headline.content.align, "center");
  assert.ok(eyebrow.rect.y < headline.rect.y);
  assert.ok(headline.rect.y + headline.rect.height <= body.rect.y);
});

test("slide-text-only-2 has no body slot and a larger headline", () => {
  const expanded = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-2",
    slots: {
      eyebrow: { text: "Chapter" },
      headline: { text: "Agenda" },
      subhead: { text: "What comes next" },
    },
  });
  const placements = asPlacements(expanded);
  assert.deepEqual(placements.map((item) => item.id), ["bar", "eyebrow", "headline", "subhead"]);
  const headline = placement(expanded, "headline");
  assert.ok((headline.content.font_size ?? 0) >= 96);
  assert.equal(headline.rect.height, headline.content.line_height);
  assertUsage(
    () => expandPlaylistPage({
      id: "copy",
      template: "slide-text-only-2",
      slots: { eyebrow: { text: "X" }, headline: { text: "Y" }, body: { text: "nope" } },
    }),
    /Unknown slot body/,
  );
});

test("slide-text-photo-1 puts text left and picture right", () => {
  const expanded = expandPlaylistPage({
    id: "split",
    template: "slide-text-photo-1",
    slots: {
      headline: { text: "Lobby" },
      picture: MEDIA,
    },
  });
  const placements = asPlacements(expanded);
  assert.deepEqual(placements.map((item) => item.id), ["picture", "bar", "headline"]);
  const picture = placement(expanded, "picture");
  const headline = placement(expanded, "headline");
  assert.deepEqual(picture.rect, { x: 1003, y: 165, width: 874, height: 750 });
  assert.equal(picture.content_fit, "cover");
  assert.equal(picture.layer, 0);
  assert.equal(headline.rect.x, 59);
  assert.equal(headline.rect.width, 825);
  assert.equal(headline.rect.height, headline.content.line_height);
});

test("slide-text-photo-2 and slide-text-photo-3 swap columns; photo-3 defaults contain", () => {
  const two = asPlacements(expandPlaylistPage({
    id: "two",
    template: "slide-text-photo-2",
    slots: { headline: { text: "Right" }, picture: MEDIA },
  }));
  const three = asPlacements(expandPlaylistPage({
    id: "three",
    template: "slide-text-photo-3",
    slots: { headline: { text: "Wide" }, picture: { ...MEDIA, content_fit: "contain" } },
  }));
  assert.deepEqual(two.find((item) => item.id === "picture")?.rect, {
    x: 43,
    y: 165,
    width: 874,
    height: 750,
  });
  assert.equal(two.find((item) => item.id === "headline")?.rect.x, 1036);
  assert.equal(two.find((item) => item.id === "headline")?.rect.width, 825);
  assert.equal(two.find((item) => item.id === "picture")?.content_fit, "cover");
  assert.deepEqual(three.find((item) => item.id === "picture")?.rect, {
    x: 43,
    y: 165,
    width: 1095,
    height: 750,
  });
  assert.equal(three.find((item) => item.id === "headline")?.rect.x, 1257);
  assert.equal(three.find((item) => item.id === "headline")?.rect.width, 604);
  assert.equal(three.find((item) => item.id === "picture")?.content_fit, "contain");
});

test("a picture slot may override content_fit; omitted optional picture is dropped", () => {
  const overridden = asPlacements(expandPlaylistPage({
    id: "fit",
    template: "slide-text-photo-1",
    slots: {
      headline: { text: "Lobby" },
      picture: { ...MEDIA, content_fit: "contain" },
    },
  }));
  assert.equal(overridden.find((item) => item.id === "picture")?.content_fit, "contain");
  const omitted = asPlacements(expandPlaylistPage({
    id: "plain",
    template: "slide-text-photo-1",
    slots: { headline: { text: "Lobby" } },
  }));
  assert.deepEqual(omitted.map((item) => item.id), ["bar", "headline"]);
});

test("slide-half-bleed-1 and slide-half-bleed-2 fill one half with required picture", () => {
  const left = asPlacements(expandPlaylistPage({
    id: "hb1",
    template: "slide-half-bleed-1",
    slots: { headline: { text: "Left" }, picture: MEDIA },
  }));
  const right = asPlacements(expandPlaylistPage({
    id: "hb2",
    template: "slide-half-bleed-2",
    slots: { headline: { text: "Right" }, picture: VIDEO },
  }));
  assert.deepEqual(left.find((item) => item.id === "picture")?.rect, {
    x: 0,
    y: 16,
    width: 960,
    height: 1064,
  });
  assert.equal(left.find((item) => item.id === "headline")?.rect.x, 1020);
  assert.equal(left.find((item) => item.id === "headline")?.rect.width, 840);
  assert.deepEqual(right.find((item) => item.id === "picture")?.rect, {
    x: 960,
    y: 16,
    width: 960,
    height: 1064,
  });
  assert.equal(right.find((item) => item.id === "picture")?.content.type, "video");
  assertUsage(
    () => expandPlaylistPage({
      id: "hb1",
      template: "slide-half-bleed-1",
      slots: { headline: { text: "Left" } },
    }),
    /Missing required slot picture on template slide-half-bleed-1/,
  );
});

test("slide-quote centers quote and optional author on one plate", () => {
  const expanded = expandPlaylistPage({
    id: "q",
    template: "slide-quote",
    slots: {
      quote: { text: "Make it count" },
      author: { text: "A speaker" },
    },
  });
  const placements = asPlacements(expanded);
  assert.deepEqual(placements.map((item) => item.id), ["bar", "plate", "quote", "author"]);
  const quote = placement(expanded, "quote");
  const author = placement(expanded, "author");
  const plate = placement(expanded, "plate");
  assert.equal(quote.content.text, "Make it count");
  assert.equal(quote.content.align, "center");
  assert.equal(quote.content.vertical_align, "middle");
  assert.equal(quote.rect.height, quote.content.line_height);
  assert.equal(author.content.color, SLIDE_DIM);
  assert.equal(plate.content.type, "box");
  assert.equal(plate.content.fill, SLIDE_PLATE_FILL);
  assert.equal(plate.content.corner_radius?.top_left, SLIDE_PLATE_RADIUS);
  assert.equal(plate.rect.x, quote.rect.x - SLIDE_PLATE_PAD_X);
  assert.equal(plate.rect.y, quote.rect.y - SLIDE_PLATE_PAD_Y);
  assert.ok(plate.rect.y + plate.rect.height >= author.rect.y + author.rect.height + SLIDE_PLATE_PAD_Y);
});

test("slide-callout emits a plate, required headline, and optional body", () => {
  const expanded = expandPlaylistPage({
    id: "card",
    template: "slide-callout",
    slots: {
      headline: { text: "Heads up" },
      body: { text: "The plate sits behind the copy." },
    },
  });
  const placements = asPlacements(expanded);
  assert.deepEqual(placements.map((item) => item.id), ["bar", "plate", "headline", "body"]);
  assert.equal(placements.filter((item) => item.content.type === "box").length, 1);
  const headline = placement(expanded, "headline");
  const body = placement(expanded, "body");
  const plate = placement(expanded, "plate");
  assert.equal(headline.content.align, "center");
  assert.equal(body.content.align, "center");
  assert.equal(plate.content.type, "box");
  assert.equal(plate.rect.x, headline.rect.x - SLIDE_PLATE_PAD_X);
  assertUsage(
    () => expandPlaylistPage({
      id: "card",
      template: "slide-callout",
      slots: { body: { text: "missing headline" } },
    }),
    /Missing required slot headline on template slide-callout/,
  );
});

test("slide-bullets stacks six rows and an optional picture", () => {
  const expanded = asPlacements(expandPlaylistPage({
    id: "list",
    template: "slide-bullets",
    slots: {
      headline: { text: "Agenda" },
      b1: { text: "One" },
      b3: { text: "Three" },
      picture: MEDIA,
    },
  }));
  assert.deepEqual(expanded.map((item) => item.id), ["picture", "bar", "headline", "b1", "b3"]);
  assert.equal(expanded.find((item) => item.id === "b1")?.rect.x, 59);
  assert.equal(expanded.find((item) => item.id === "b1")?.rect.width, 1100);
  assert.equal(expanded.find((item) => item.id === "b3")?.rect.y, 460);
  assert.deepEqual(expanded.find((item) => item.id === "picture")?.rect, {
    x: 1200,
    y: 165,
    width: 680,
    height: 750,
  });
});

test("slide-stat-grid lays a 2x2 of value/label pairs", () => {
  const expanded = asPlacements(expandPlaylistPage({
    id: "stats",
    template: "slide-stat-grid",
    slots: {
      headline: { text: "Numbers" },
      v1: { text: "12" },
      l1: { text: "Screens" },
      v4: { text: "4" },
      l4: { text: "Cities" },
    },
  }));
  assert.deepEqual(expanded.map((item) => item.id), ["bar", "headline", "v1", "l1", "v4", "l4"]);
  const v1 = expanded.find((item) => item.id === "v1");
  const l1 = expanded.find((item) => item.id === "l1");
  const v4 = expanded.find((item) => item.id === "v4");
  assert.equal(v1?.content.color, SLIDE_MUSTARD);
  assert.equal(l1?.content.color, SLIDE_DIM);
  assert.equal(v1?.rect.x, 59);
  assert.equal(v1?.rect.y, 250);
  assert.equal(v1?.rect.width, 880);
  assert.equal(l1?.rect.x, 59);
  assert.equal(l1?.rect.y, 358);
  assert.equal(v4?.rect.x, 982);
  assert.equal(v4?.rect.y, 653);
});

test("slide-three-up lays three columns", () => {
  const expanded = asPlacements(expandPlaylistPage({
    id: "cols",
    template: "slide-three-up",
    slots: {
      headline: { text: "Three" },
      t1: { text: "A" },
      b1: { text: "First" },
      t3: { text: "C" },
      b3: { text: "Third" },
    },
  }));
  assert.deepEqual(expanded.map((item) => item.id), ["bar", "headline", "t1", "b1", "t3", "b3"]);
  assert.equal(expanded.find((item) => item.id === "t1")?.rect.x, 59);
  assert.equal(expanded.find((item) => item.id === "t1")?.rect.y, 250);
  assert.equal(expanded.find((item) => item.id === "t1")?.rect.width, 560);
  assert.equal(expanded.find((item) => item.id === "t3")?.rect.x, 1273);
  assert.equal(expanded.find((item) => item.id === "t1")?.content.color, SLIDE_MUSTARD);
  assert.equal(expanded.find((item) => item.id === "b1")?.content.color, SLIDE_DIM);
});

test("slide-photo and slide-full-bleed cover the stage; logo overlays at layer 2", () => {
  const photo = asPlacements(expandPlaylistPage({
    id: "still",
    template: "slide-photo",
    slots: {
      picture: MEDIA,
      caption: { text: "Lobby" },
      logo: MEDIA,
    },
  }));
  const bleed = asPlacements(expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    slots: { picture: MEDIA, logo: MEDIA },
  }));
  assert.deepEqual(photo.map((item) => item.id), ["picture", "bar", "logo", "caption"]);
  assert.deepEqual(photo.find((item) => item.id === "picture")?.rect, {
    x: 43,
    y: 122,
    width: 1834,
    height: 880,
  });
  assert.equal(photo.find((item) => item.id === "caption")?.rect.x, 419);
  assert.equal(photo.find((item) => item.id === "caption")?.rect.y, 1012);
  assert.equal(photo.find((item) => item.id === "logo")?.layer, 2);
  assert.equal(photo.find((item) => item.id === "logo")?.content_fit, "contain");
  assert.deepEqual(bleed.find((item) => item.id === "picture")?.rect, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(bleed.find((item) => item.id === "logo")?.rect, SHARED_LOGO_RECT);
});

test("logo rejects video; page text_color tints only slots without a template color", () => {
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "Welcome" }, logo: VIDEO },
    }),
    /Slot logo is an image slot and does not take video/,
  );
  const expanded = asPlacements(expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    text_color: "#ffffffff",
    canvas: { background: "#112233ff" },
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: "Hours" },
      body: { text: "Open daily" },
      footnote: { text: "Subject to change" },
    },
  }));
  assert.equal((expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    text_color: "#ffffffff",
    canvas: { background: "#112233ff" },
    slots: { eyebrow: { text: "Today" }, headline: { text: "Hours" } },
  }) as { canvas: { background: string } }).canvas.background, "#112233FF");
  assert.equal(expanded.find((item) => item.id === "headline")?.content.color, "#FFFFFFFF");
  assert.equal(expanded.find((item) => item.id === "eyebrow")?.content.color, SLIDE_MUSTARD);
  assert.equal(expanded.find((item) => item.id === "body")?.content.color, SLIDE_DIM);
  assert.equal(expanded.find((item) => item.id === "footnote")?.content.color, SLIDE_FAINT);
  assert.equal(expanded.find((item) => item.id === "bar")?.content.color, SLIDE_BAR_COLOR);
});

test("omitted transition and advance take the slide defaults; supplied values replace them", () => {
  const custom = expandPlaylistPage({
    id: "intro",
    template: "slide-intro",
    transition: { type: "crossfade", duration_ms: 400 },
    advance: { mode: "duration", after_ms: 12000 },
    visibility: { enabled: true, windows: [{ days: ["mon"] }] },
    slots: { title: { text: "Welcome" } },
  }) as { transition: unknown; advance: unknown; visibility: unknown };
  assert.deepEqual(custom.transition, { type: "crossfade", duration_ms: 400 });
  assert.deepEqual(custom.advance, { mode: "duration", after_ms: 12000 });
  assert.deepEqual(custom.visibility, { enabled: true, windows: [{ days: ["mon"] }] });
});

test("a page without template is forwarded unchanged", () => {
  const full = {
    id: "poster",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    placements: [
      {
        id: "hero",
        content: MEDIA,
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
    ],
  };
  assert.equal(expandPlaylistPage(full), full);
  assert.deepEqual(expandPlaylistPages([full]), [full]);
});

test("unknown and retired template ids name playlist templates", () => {
  for (const id of ["slide-hero", ...RETIRED_IDS]) {
    assert.throws(
      () => expandPlaylistPage({ id: "intro", template: id, slots: { title: { text: "X" } } }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.problem.code, "usage_error");
        assert.match(err.problem.detail, new RegExp(`Unknown template ${id}`));
        assert.match(err.problem.detail, /playlist templates/);
        assert.equal(err.problem.next?.command, "screenrig --json playlist templates");
        return true;
      },
    );
  }
});

test("templated page usage errors name the offending field", () => {
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "Welcome" }, footer: { text: "nope" } },
    }),
    /Unknown slot footer/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { type: "image", selector: { by: "id", media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" } } },
    }),
    /Slot title is a text slot and does not take type image/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "hero",
      template: "slide-photo",
      slots: { picture: { text: "not media" } },
    }),
    /Slot picture is an image or video slot and does not take text/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "copy",
      template: "slide-text-only-1",
      slots: { headline: { text: "Hours" } },
    }),
    /Missing required slot eyebrow on template slide-text-only-1/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "" } },
    }),
    /Required slot title has empty text/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "Welcome" } },
      placements: [],
    }),
    /mixes template and placements/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      canvas: { width: 1920, background: SLIDE_BACKGROUND },
      slots: { title: { text: "Welcome" } },
    }),
    /canvas has unsupported fields: width/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      canvas: { height: 1080, viewport_fit: "contain" },
      slots: { title: { text: "Welcome" } },
    }),
    /canvas has unsupported fields: height, viewport_fit/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      name: "not a page field",
      slots: { title: { text: "Welcome" } },
    }),
    /has unsupported fields: name/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "Welcome", rect: { x: 0, y: 0, width: 1, height: 1 } } },
    }),
    /Slot title has unsupported fields: rect/,
  );
});

test("expanded pages never retain template identity", () => {
  const expanded = expandPlaylistPage({
    id: "intro",
    template: "slide-intro",
    text_color: "#EEE9DFFF",
    slots: { title: { text: "Welcome" } },
  }) as Record<string, unknown>;
  assert.equal("template" in expanded, false);
  assert.equal("slots" in expanded, false);
  assert.equal("text_color" in expanded, false);
});

test("a one-line headline hugs line_height instead of the old 160 hole", () => {
  const expanded = expandPlaylistPage({
    id: "split",
    template: "slide-text-photo-1",
    slots: { headline: { text: "Lobby" } },
  });
  const headline = placement(expanded, "headline");
  assert.equal(headline.rect.height, headline.content.line_height);
  assert.notEqual(headline.rect.height, 160);
  assert.ok((headline.rect.height ?? 0) < 200);
});

test("a two-line headline height is two line_heights", () => {
  const expanded = expandPlaylistPage({
    id: "split",
    template: "slide-text-photo-1",
    slots: { headline: { text: ["First line", "Second line"] } },
  });
  const headline = placement(expanded, "headline");
  assert.equal(headline.content.text, "First line\nSecond line");
  assert.equal(headline.rect.height, 2 * (headline.content.line_height ?? 0));
});

test("over-budget lines keep the last fitting line and append an ellipsis", () => {
  const expanded = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: ["One", "Two", "Three", "Four"] },
    },
  });
  const headline = placement(expanded, "headline");
  const maxLines = Math.floor(200 / (headline.content.line_height ?? 100));
  assert.ok((headline.content.text ?? "").endsWith("…"));
  assert.equal((headline.content.text ?? "").split("\n").length, maxLines);
  assert.equal(headline.rect.height, maxLines * (headline.content.line_height ?? 0));
  assert.match(headline.content.text ?? "", /Two…$/);
});

test("a long single line shrinks font_size below the template default", () => {
  const long = "WWWWWWWWWWWWWWWWWWWW";
  const expanded = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: long },
    },
  });
  const headline = placement(expanded, "headline");
  assert.ok((headline.content.font_size ?? 80) < 80, `font_size ${headline.content.font_size}`);
  assert.ok((headline.content.font_size ?? 0) >= 40);
  assert.ok(
    longestSansLineWidth([long], headline.content.font_size ?? 0, 700) <= headline.rect.width,
  );
  assert.ok(descenderSafe(headline.content.font_size ?? 0, headline.content.line_height ?? 0));
});

test("a short single line in a large hole grows font_size up to 150%", () => {
  const expanded = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: "Go" },
    },
  });
  const headline = placement(expanded, "headline");
  assert.ok((headline.content.font_size ?? 0) > 80, `font_size ${headline.content.font_size}`);
  assert.ok((headline.content.font_size ?? 0) <= Math.floor(80 * SLIDE_FIT_MAX_RATIO));
  assert.equal(headline.content.font_size, 120);
  assert.ok(descenderSafe(headline.content.font_size ?? 0, headline.content.line_height ?? 0));
  assert.equal(headline.rect.height, headline.content.line_height);
});

test("every emitted text keeps a descender-safe line_height", () => {
  const expanded = asPlacements(expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: ["Put your screens", "in the conversation."] },
      subhead: { text: "Describe the outcome." },
      body: { text: "The agent prepares the content." },
      footnote: { text: "Looking at the glass is still the proof." },
    },
  }));
  const texts = expanded.filter((item) => item.content.type === "text");
  assert.ok(texts.length >= 5);
  for (const item of texts) {
    assert.ok(
      descenderSafe(item.content.font_size ?? 0, item.content.line_height ?? 0),
      `${item.id} ${item.content.font_size}/${item.content.line_height}`,
    );
    assert.ok((item.rect.height ?? 0) >= (item.content.line_height ?? 0), item.id);
  }
});

test("slot align override appears on the placement; omitted uses the template default", () => {
  const overridden = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: "Hours", align: "right" },
    },
  });
  const defaults = expandPlaylistPage({
    id: "copy",
    template: "slide-text-only-1",
    slots: {
      eyebrow: { text: "Today" },
      headline: { text: "Hours" },
    },
  });
  assert.equal(placement(overridden, "headline").content.align, "right");
  assert.equal(placement(defaults, "headline").content.align, "center");
  assertUsage(
    () => expandPlaylistPage({
      id: "copy",
      template: "slide-text-only-1",
      slots: { eyebrow: { text: "Today" }, headline: { text: "Hours", align: "justified" } },
    }),
    /Slot headline align must be left, center, or right/,
  );
});

test("every template uses the shared bottom-left logo rect", () => {
  assert.equal(SLIDE_TEMPLATES.length, 15);
  for (const template of SLIDE_TEMPLATES) {
    const logo = template.slots.find((slot) => slot.id === "logo");
    assert.ok(logo, `${template.id} is missing logo`);
    assert.equal(logo?.kind, "picture");
    if (logo?.kind === "picture") {
      assert.deepEqual(logo.rect, SHARED_LOGO_RECT, template.id);
      assert.equal(logo.layer, 2, template.id);
      assert.equal(logo.content_fit, "contain", template.id);
      assert.equal(logo.accept, "image", template.id);
    }
  }
});

test("no text slot intersects the logo rect with a 16px gap", () => {
  const padded = {
    x: SHARED_LOGO_RECT.x - TEXT_LOGO_GAP,
    y: SHARED_LOGO_RECT.y - TEXT_LOGO_GAP,
    width: SHARED_LOGO_RECT.width + TEXT_LOGO_GAP * 2,
    height: SHARED_LOGO_RECT.height + TEXT_LOGO_GAP * 2,
  };
  for (const template of SLIDE_TEMPLATES) {
    for (const slot of template.slots) {
      if (slot.kind !== "text") {
        continue;
      }
      assert.equal(
        rectsOverlap(slot.rect, padded),
        false,
        `${template.id} ${slot.id} intersects the padded logo`,
      );
    }
  }
});

test("every filled template stays within 24 placements, inside the canvas, and without accidental overlap", () => {
  const filled: Record<string, Record<string, unknown>> = {
    "slide-intro": { title: { text: "T" }, subtitle: { text: "S" }, logo: MEDIA },
    "slide-text-only-1": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      subhead: { text: "S" },
      body: { text: "B" },
      footnote: { text: "F" },
      logo: MEDIA,
    },
    "slide-text-only-2": { eyebrow: { text: "E" }, headline: { text: "H" }, subhead: { text: "S" }, logo: MEDIA },
    "slide-text-photo-1": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      subhead: { text: "S" },
      body: { text: "B" },
      footnote: { text: "F" },
      picture: MEDIA,
      logo: MEDIA,
    },
    "slide-text-photo-2": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      picture: MEDIA,
      logo: MEDIA,
    },
    "slide-text-photo-3": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      picture: MEDIA,
      logo: MEDIA,
    },
    "slide-half-bleed-1": { headline: { text: "H" }, picture: MEDIA, logo: MEDIA },
    "slide-half-bleed-2": { headline: { text: "H" }, picture: MEDIA, logo: MEDIA },
    "slide-quote": { quote: { text: "Q" }, author: { text: "A" }, logo: MEDIA },
    "slide-callout": { headline: { text: "H" }, body: { text: "B" }, logo: MEDIA },
    "slide-bullets": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      b1: { text: "1" },
      b2: { text: "2" },
      b3: { text: "3" },
      b4: { text: "4" },
      b5: { text: "5" },
      b6: { text: "6" },
      picture: MEDIA,
      logo: MEDIA,
    },
    "slide-stat-grid": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      v1: { text: "1" },
      l1: { text: "a" },
      v2: { text: "2" },
      l2: { text: "b" },
      v3: { text: "3" },
      l3: { text: "c" },
      v4: { text: "4" },
      l4: { text: "d" },
      logo: MEDIA,
    },
    "slide-three-up": {
      eyebrow: { text: "E" },
      headline: { text: "H" },
      t1: { text: "A" },
      b1: { text: "a" },
      t2: { text: "B" },
      b2: { text: "b" },
      t3: { text: "C" },
      b3: { text: "c" },
      logo: MEDIA,
    },
    "slide-photo": { picture: MEDIA, caption: { text: "C" }, logo: MEDIA },
    "slide-full-bleed": { picture: MEDIA, logo: MEDIA },
  };

  assert.deepEqual(Object.keys(filled).sort(), [...CATALOG_IDS].sort());

  for (const id of CATALOG_IDS) {
    const placements = asPlacements(expandPlaylistPage({
      id,
      template: id,
      slots: filled[id],
    }));
    assert.ok(placements.length >= 1, id);
    assert.ok(placements.length <= 24, `${id} has ${placements.length} placements`);
    assert.equal(new Set(placements.map((item) => item.id)).size, placements.length, id);
    assert.ok(placements.some((item) => item.id === "bar"), id);
    const boxes = placements.filter((item) => item.content.type === "box");
    if (id === "slide-quote" || id === "slide-callout") {
      assert.equal(boxes.length, 1, id);
    } else {
      assert.equal(boxes.length, 0, id);
    }
    const logo = placements.find((item) => item.id === "logo");
    assert.deepEqual(logo?.rect, SHARED_LOGO_RECT, id);
    assert.equal(logo?.layer, 2, id);
    for (const item of placements) {
      assert.ok(item.rect.x >= 0, id);
      assert.ok(item.rect.y >= 0, id);
      assert.ok(item.rect.x + item.rect.width <= 1920, `${id} ${item.id} overflows x`);
      assert.ok(item.rect.y + item.rect.height <= 1080, `${id} ${item.id} overflows y`);
      if (item.content.type === "text") {
        assert.ok(
          descenderSafe(item.content.font_size ?? 0, item.content.line_height ?? 0),
          `${id} ${item.id} line_height`,
        );
        assert.ok((item.rect.height ?? 0) >= (item.content.line_height ?? 0), `${id} ${item.id} short rect`);
      }
    }
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = placements[i]!;
        const b = placements[j]!;
        if (isOverlayPair(a, b)) {
          continue;
        }
        assert.equal(rectsOverlap(a.rect, b.rect), false, `${id} ${a.id} overlaps ${b.id}`);
      }
    }
  }
});

function isOverlayPair(a: { id: string; content: { type: string } }, b: { id: string; content: { type: string } }): boolean {
  const ids = new Set([a.id, b.id]);
  const types = new Set([a.content.type, b.content.type]);
  return ids.has("bar") || (ids.has("logo") && ids.has("picture")) || types.has("box");
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
