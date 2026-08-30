import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "./problems.js";
import {
  expandPlaylistPage,
  expandPlaylistPages,
  formatTemplateCatalog,
  playlistTemplateCatalog,
  SHARED_LOGO_RECT,
  SLIDE_BACKGROUND,
  SLIDE_DEFAULT_TRANSITION,
  SLIDE_SWIPE_AUTHORING_DURATION_MS,
  SLIDE_TEMPLATES,
} from "./playlist-templates.js";

const MEDIA = {
  primitive: "image" as const,
  selector: { by: "id" as const, media_id: "med_AAAAAAAAAAAAAAAAAAAAAAAA" },
  alt: "Lobby still",
};

const VIDEO = {
  primitive: "video" as const,
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

function assertUsage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CliError);
    assert.equal(err.problem.code, "usage_error");
    assert.match(err.problem.detail, pattern);
    return true;
  });
}

function asPrimitives(value: unknown): Array<{
  id: string;
  primitive: string;
  layer: number;
  content_fit?: string;
  rect: { x: number; y: number; width: number; height: number };
}> {
  return (value as { primitives: Array<{
    id: string;
    primitive: string;
    layer: number;
    content_fit?: string;
    rect: { x: number; y: number; width: number; height: number };
  }> }).primitives;
}

test("the catalog lists the fifteen slide ids and points copy at compose", () => {
  const catalog = playlistTemplateCatalog();
  assert.deepEqual(catalog.templates.map((template) => template.id), [...CATALOG_IDS]);
  assert.equal(SLIDE_TEMPLATES.length, 15);
  assert.equal(catalog.canvas.background, SLIDE_BACKGROUND);
  assert.equal(catalog.canvas.width, 1920);
  assert.equal(catalog.canvas.height, 1080);
  assert.deepEqual(catalog.compose.wire_primitives, ["image", "video", "iframe", "application"]);
  assert.deepEqual(catalog.transition, { type: "crossfade", duration_ms: 200 });
  assert.deepEqual(catalog.transition, SLIDE_DEFAULT_TRANSITION);
  assert.deepEqual(catalog.transition_types, [
    "crossfade",
    "swipe-left",
    "swipe-right",
    "swipe-up",
    "swipe-down",
  ]);
  assert.equal(catalog.swipe_duration_ms, 600);
  assert.equal(catalog.swipe_duration_ms, SLIDE_SWIPE_AUTHORING_DURATION_MS);
  assert.deepEqual(catalog.enter_types, [
    "fade-up",
    "fade-down",
    "fade-left",
    "fade-right",
    "fade-in",
    "zoom-in",
    "zoom-out",
  ]);
  assert.match(catalog.compose.catalog_command, /compose catalog/);
  assert.match(catalog.compose.render_command, /compose render/);
  const formatted = formatTemplateCatalog(catalog);
  assert.match(formatted, /composed locally/);
  assert.match(formatted, /compose catalog/);
  assert.match(formatted, /Default page transition is crossfade 200 ms with no object enter/);
  assert.doesNotMatch(formatted, /title \(text, required/);
  assert.doesNotMatch(formatted, /emit native text/);
  const intro = catalog.templates.find((template) => template.id === "slide-intro");
  assert.equal(intro?.compose_locally, true);
  assert.ok(intro?.slots.some((slot) => slot.id === "title" && slot.kind === "compose"));
  const bleed = catalog.templates.find((template) => template.id === "slide-full-bleed");
  assert.ok(bleed?.slots.some((slot) => slot.id === "picture" && slot.kind === "image_or_video"));
});

test("templates with copy fail expansion and point at compose render", () => {
  assert.throws(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "Welcome" } },
    }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.problem.code, "usage_error");
      assert.match(err.problem.detail, /compose render/);
      assert.match(err.problem.detail, /text, box, or line/);
      assert.equal(err.problem.next?.command, "screenrig --json compose catalog");
      return true;
    },
  );
});

test("slide-full-bleed expands picture and logo only, with no text box or line", () => {
  const expanded = expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    slots: { picture: MEDIA, logo: MEDIA },
  });
  const primitives = asPrimitives(expanded);
  assert.deepEqual(primitives.map((item) => item.id), ["picture", "logo"]);
  assert.ok(primitives.every((item) => item.primitive === "image" || item.primitive === "video"));
  assert.deepEqual(primitives.find((item) => item.id === "picture")?.rect, {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(primitives.find((item) => item.id === "logo")?.rect, SHARED_LOGO_RECT);
  assert.equal(primitives.find((item) => item.id === "logo")?.layer, 2);
  assert.equal(primitives.find((item) => item.id === "logo")?.content_fit, "contain");
});

test("slide-photo expands picture-only when caption is omitted; caption is compose", () => {
  const photo = asPrimitives(expandPlaylistPage({
    id: "still",
    template: "slide-photo",
    slots: { picture: MEDIA, logo: MEDIA },
  }));
  assert.deepEqual(photo.map((item) => item.id), ["picture", "logo"]);
  assertUsage(
    () => expandPlaylistPage({
      id: "still",
      template: "slide-photo",
      slots: { picture: MEDIA, caption: { text: "Lobby" } },
    }),
    /compose render/,
  );
});

test("a picture slot may override content_fit; omitted optional picture is dropped", () => {
  const overridden = asPrimitives(expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    slots: { picture: { ...MEDIA, content_fit: "contain" } },
  }));
  assert.equal(overridden.find((item) => item.id === "picture")?.content_fit, "contain");
  assert.equal(overridden.some((item) => item.id === "logo"), false);
});

test("logo rejects video; required picture is still required", () => {
  assertUsage(
    () => expandPlaylistPage({
      id: "hero",
      template: "slide-full-bleed",
      slots: { picture: MEDIA, logo: VIDEO },
    }),
    /Slot logo is an image slot and does not take video/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "hero",
      template: "slide-full-bleed",
      slots: {},
    }),
    /Missing required slot picture on template slide-full-bleed/,
  );
});

test("a page without template is forwarded unchanged when primitives use the wire vocabulary", () => {
  const full = {
    id: "poster",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 200 },
    advance: { mode: "duration", after_ms: 8000 },
    primitives: [
      {
        id: "hero",
        ...MEDIA,
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
    ],
  };
  assert.equal(expandPlaylistPage(full), full);
  assert.deepEqual(expandPlaylistPages([full]), [full]);
});

test("a full page that authors text, box, or line is refused", () => {
  for (const type of ["text", "box", "line"]) {
    assertUsage(
      () => expandPlaylistPage({
        id: "poster",
        canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
        primitives: [
          {
            id: "chrome",
            primitive: type,
            text: "nope",
            rect: { x: 0, y: 0, width: 1920, height: 16 },
            layer: 1,
            content_fit: "fill",
          },
        ],
      }),
      /primitive must be image\|video\|iframe\|application/,
    );
  }
});

test("unknown and retired template ids name playlist templates", () => {
  for (const id of ["slide-hero", "slide-title"]) {
    assert.throws(
      () => expandPlaylistPage({ id: "intro", template: id, slots: { title: { text: "X" } } }),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.problem.code, "usage_error");
        assert.match(err.problem.detail, new RegExp(`Unknown template ${id}`));
        assert.equal(err.problem.next?.command, "screenrig --json playlist templates");
        return true;
      },
    );
  }
});

test("templated page usage errors name the offending field", () => {
  assertUsage(
    () => expandPlaylistPage({
      id: "hero",
      template: "slide-full-bleed",
      slots: { picture: MEDIA, footer: { text: "nope" } },
    }),
    /Unknown slot footer/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "hero",
      template: "slide-full-bleed",
      slots: { picture: { text: "not media" } },
    }),
    /Slot picture is an image or video slot and does not take text/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "intro",
      template: "slide-intro",
      slots: { title: { text: "Welcome" } },
      primitives: [],
    }),
    /mixes template and primitives/,
  );
  assertUsage(
    () => expandPlaylistPage({
      id: "hero",
      template: "slide-full-bleed",
      canvas: { width: 1920, background: SLIDE_BACKGROUND },
      slots: { picture: MEDIA },
    }),
    /canvas has unsupported fields: width/,
  );
});

test("expanded picture pages never retain template identity", () => {
  const expanded = expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    slots: { picture: MEDIA },
  }) as Record<string, unknown>;
  assert.equal("template" in expanded, false);
  assert.equal("slots" in expanded, false);
  assert.equal("text_color" in expanded, false);
});

test("omitted transition and advance take the slide defaults; supplied values replace them", () => {
  const omitted = expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    slots: { picture: MEDIA },
  }) as { transition: unknown; primitives: Array<Record<string, unknown>> };
  assert.deepEqual(omitted.transition, { type: "crossfade", duration_ms: 200 });
  assert.ok(omitted.primitives.every((primitive) => !("enter" in primitive)));
  const custom = expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    transition: { type: "crossfade", duration_ms: 400 },
    advance: { mode: "duration", after_ms: 12000 },
    visibility: { enabled: true, windows: [{ days: ["mon"] }] },
    slots: { picture: MEDIA },
  }) as { transition: unknown; advance: unknown; visibility: unknown };
  assert.deepEqual(custom.transition, { type: "crossfade", duration_ms: 400 });
  assert.deepEqual(custom.advance, { mode: "duration", after_ms: 12000 });
  assert.deepEqual(custom.visibility, { enabled: true, windows: [{ days: ["mon"] }] });
});

test("a templated page forwards a supplied swipe transition and never invents enter", () => {
  const expanded = expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    transition: { type: "swipe-left", duration_ms: 600 },
    slots: { picture: MEDIA },
  }) as { transition: unknown; primitives: Array<Record<string, unknown>> };
  assert.deepEqual(expanded.transition, { type: "swipe-left", duration_ms: 600 });
  assert.ok(expanded.primitives.every((primitive) => !("enter" in primitive)));
});

test("a full page with swipe and enter is forwarded unchanged", () => {
  const full = {
    id: "poster",
    canvas: { width: 1920, height: 1080, viewport_fit: "contain", background: "#000000FF" },
    transition: { type: "swipe-left", duration_ms: 600 },
    advance: { mode: "duration", after_ms: 8000 },
    primitives: [
      {
        id: "hero",
        ...MEDIA,
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        layer: 0,
        content_fit: "contain",
      },
      {
        id: "caption",
        ...MEDIA,
        rect: { x: 80, y: 860, width: 1760, height: 160 },
        layer: 2,
        content_fit: "contain",
        enter: { type: "fade-up" },
      },
    ],
  };
  assert.equal(expandPlaylistPage(full), full);
});

test("a linear canvas.background is accepted on a picture template", () => {
  const wash = {
    type: "linear" as const,
    stops: [
      { at: 0, color: "#1b2632ff" },
      { at: 1, color: "#eee9dfff" },
    ],
  };
  const expanded = expandPlaylistPage({
    id: "hero",
    template: "slide-full-bleed",
    canvas: { background: wash },
    slots: { picture: MEDIA },
  }) as { canvas: { background: unknown } };
  assert.deepEqual(expanded.canvas.background, {
    type: "linear",
    stops: [
      { at: 0, color: "#1B2632FF" },
      { at: 1, color: "#EEE9DFFF" },
    ],
  });
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

test("no expanded template emits text, box, or line", () => {
  const pictureOnly = ["slide-photo", "slide-full-bleed"] as const;
  for (const id of pictureOnly) {
    const primitives = asPrimitives(expandPlaylistPage({
      id,
      template: id,
      slots: { picture: MEDIA, logo: MEDIA },
    }));
    for (const item of primitives) {
      assert.ok(["image", "video", "iframe", "application"].includes(item.primitive), `${id} ${item.id}`);
    }
  }
  for (const template of SLIDE_TEMPLATES) {
    if (pictureOnly.includes(template.id as typeof pictureOnly[number])) {
      continue;
    }
    assert.throws(
      () => expandPlaylistPage({ id: template.id, template: template.id, slots: {} }),
      (err: unknown) => err instanceof CliError && err.problem.code === "usage_error",
    );
  }
});
