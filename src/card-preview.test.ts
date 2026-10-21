import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { withCardPreview, type CardPreviewInput } from "./card-preview.js";
import { previewPlaylist } from "./playlist-preview.js";
import { processRuntime, type CliRuntime } from "./runtime.js";
import { testTemp } from "./test-temp.js";

/** Serves a stub public card renderer (`script`) in place of the site's and returns a runtime that drives the test browser. */
function stubPublicRenderer(t: TestContext, directory: string, script: string): CliRuntime {
  const assets = new Map([["/cards/renderer.js", script], ["/cards/sandbox.js", ""], ["/cards/fonts.css", ""]]);
  const link = (src: string) => ({ src, sha256: createHash("sha256").update(assets.get(src)!).digest("hex") });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/cards/index.json") return Response.json({ web: { script: link("/cards/renderer.js"), sandbox: link("/cards/sandbox.js"), fonts: link("/cards/fonts.css") } });
    assert.ok(assets.has(pathname), `unexpected asset ${pathname}`);
    return new Response(assets.get(pathname));
  });
  return { ...processRuntime(), homedir: () => directory, env: { ...process.env, TMPDIR: directory, SCREENRIG_BROWSER: process.env.SCREENRIG_TEST_BROWSER } };
}

test("standalone card pixels occupy the reported layout rectangle, as in a playlist", {
  skip: process.platform === "win32" || !process.env.SCREENRIG_TEST_BROWSER,
}, async t => {
  const directory = await testTemp("card-preview-layout-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A solid renderer exposes the host's viewport and clipping without fonts,
  // public network access, animations or card-specific content affecting pixels.
  const boxes = {
    full: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    strip: { x: 0, y: 960, w: 1920, h: 120, rotation: 0 },
    corner: { x: 1650, y: 810, w: 270, h: 270, rotation: 0 },
    chip: { x: 1650, y: 980, w: 240, h: 70, rotation: 0 },
    center: { x: 510, y: 330, w: 900, h: 420, rotation: 0 },
    wide: { x: 30, y: 80, w: 1860, h: 920, rotation: 0 },
    header: { x: 0, y: 0, w: 1920, h: 80, rotation: 0 },
    footer: { x: 0, y: 1000, w: 1920, h: 80, rotation: 0 },
  };
  // A corner or chip anchored to a top corner sits at the top of the screen.
  const tops = {
    corner: { x: 0, y: 0, w: 270, h: 270, rotation: 0 },
    chip: { x: 30, y: 30, w: 240, h: 70, rotation: 0 },
  };
  const script = `window.ScreenRigCards={
    configure(){}, versions(){return {cards:{test:'1.0.0'}}}, manifest(){return {}},
    place(layout,anchor){return ((anchor||'').indexOf('top')===0&&(${JSON.stringify(tops)})[layout]) || (${JSON.stringify(boxes)})[layout] || (${JSON.stringify(boxes.full)})},
    mount(element,options){element.style.background='#cc3300';options.onReady();return {}}
  };`;
  const runtime = stubPublicRenderer(t, directory, script);
  await withCardPreview({ apiUrl: "https://example.test", runtime }, async renderer => {
    const rect = { x: 100, y: 200, width: 400, height: 300 };
    const cases: Array<{ input: Partial<CardPreviewInput>; expected: { x: number; y: number; w: number; h: number; rotation: number } }> = [
      ...Object.entries(boxes).map(([layout, expected]) => ({ input: { layout, anchor: "bottom-right" }, expected })),
      { input: { layout: "free", placement: { rect, strips: [] } }, expected: { x: 100, y: 200, w: 400, h: 300, rotation: 0 } },
      { input: { layout: "corner", anchor: "bottom-right", placement: { strips: ["bottom"] } }, expected: { ...boxes.corner, y: 690 } },
      // A wide card ignores the strips on the page, as center does.
      { input: { layout: "wide", placement: { strips: ["top", "bottom", "left", "right"] } }, expected: boxes.wide },
      // A header and a footer are full-width bars that ignore the page's strips and bars, as wide does.
      { input: { layout: "header", placement: { strips: ["top", "bottom"], bars: ["header", "footer"] } }, expected: boxes.header },
      { input: { layout: "footer", placement: { strips: ["top", "bottom"], bars: ["header", "footer"] } }, expected: boxes.footer },
      // A corner or chip moves in 80 past the bar on its top or bottom edge, 120 past a strip, the larger when both hold the edge.
      { input: { layout: "chip", anchor: "bottom-right", placement: { strips: [], bars: ["footer"] } }, expected: { ...boxes.chip, y: 900 } },
      { input: { layout: "corner", anchor: "top-left", placement: { strips: [], bars: ["header"] } }, expected: { ...tops.corner, y: 80 } },
      { input: { layout: "chip", anchor: "top-right", placement: { strips: ["top"], bars: ["header"] } }, expected: { ...tops.chip, y: 150 } },
      { input: { layout: "chip", anchor: "bottom-right", placement: { strips: [], bars: ["header"] } }, expected: boxes.chip },
      { input: { layout: "chip", anchor: "top-right", placement: { strips: [], bars: ["footer"] } }, expected: tops.chip },
      { input: { layout: "corner", anchor: "bottom-right", placement: { strips: ["bottom"], bars: ["footer"] } }, expected: { ...boxes.corner, y: 690 } },
      { input: { layout: "chip", anchor: "bottom-right", placement: { strips: ["right"], bars: ["footer", "header"] } }, expected: { ...boxes.chip, x: 1530, y: 900 } },
    ];
    for (const { input, expected } of cases) {
      const standalone = await renderer.render({ card: "test", width: 1920, height: 1080, ...input });
      assert.deepEqual(standalone.result.geometry, expected);
      const image = await loadImage(standalone.png);
      const canvas = createCanvas(1920, 1080);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, 1920, 1080).data;
      let painted = 0;
      for (let y = 0; y < 1080; y++) for (let x = 0; x < 1920; x++) {
        const alpha = pixels[(y * 1920 + x) * 4 + 3];
        const inside = x >= expected.x && x < expected.x + expected.w && y >= expected.y && y < expected.y + expected.h;
        assert.equal(alpha, inside ? 255 : 0, `${input.layout}: pixel ${x},${y}`);
        if (alpha) painted++;
      }
      assert.equal(painted, expected.w * expected.h);
      if (!input.placement) {
        const playlist = await renderer.render({ card: "test", width: 1920, height: 1080, ...input, placement: { strips: [] } });
        assert.deepEqual(standalone.png, playlist.png, `${input.layout}: standalone and playlist must agree`);
      }
    }
  });
});

test("a playlist preview paints a header and footer at the strip layer and moves a chip in past the footer", {
  skip: process.platform === "win32" || !process.env.SCREENRIG_TEST_BROWSER,
}, async t => {
  const directory = await testTemp("card-preview-bars-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Each stub card paints its layout's colour inside its box: header blue, footer green, chip red.
  const boxes = {
    header: { x: 0, y: 0, w: 1920, h: 80, rotation: 0 },
    footer: { x: 0, y: 1000, w: 1920, h: 80, rotation: 0 },
    chip: { x: 1650, y: 980, w: 240, h: 70, rotation: 0 },
    strip: { x: 0, y: 960, w: 1920, h: 120, rotation: 0 },
  };
  const script = `window.ScreenRigCards={
    configure(){}, versions(){return {cards:{test:'1.0.0'}}}, manifest(){return {}},
    place(layout){return (${JSON.stringify(boxes)})[layout] || (${JSON.stringify(boxes.chip)})},
    mount(element,options){element.style.background=({header:'#0000ff',footer:'#00ff00',chip:'#cc3300'})[options.params.layout];options.onReady();return {}}
  };`;
  const runtime = stubPublicRenderer(t, directory, script);
  const card = (id: string, layout: string, anchor?: string) => ({ id, primitive: "card", card: "test", major: 1, params: {}, layout, ...(anchor ? { anchor } : {}), content_fit: "fill" });
  const page = (primitives: object[]) => ({ id: "page", canvas: { width: 1920, height: 1080, background: "#000000FF", viewport_fit: "contain" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "duration", after_ms: 8000 }, primitives });
  const pixel = async (file: string, x: number, y: number): Promise<number[]> => {
    const image = await loadImage(await readFile(file));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(x, y, 1, 1).data);
  };
  const RED = [0xcc, 0x33, 0x00, 255], BLUE = [0, 0, 0xff, 255], GREEN = [0, 0xff, 0, 255];
  const render = async (name: string, primitives: object[]) => {
    const result = await previewPlaylist({ playlist: { name, pages: [page(primitives)] }, outputDirectory: path.join(directory, name), runtime, apiUrl: "https://api.example.test" });
    assert.deepEqual(result.placeholders, []);
    return result.pages[0]!.files.rest;
  };
  // Without a footer the chip sits at its own box; with one it moves in 80 and the footer shows where it was.
  const free = await render("free", [card("chip", "chip", "bottom-right")]);
  assert.deepEqual(await pixel(free, 1700, 1020), RED);
  const bars = await render("bars", [card("header", "header"), card("footer", "footer"), card("chip", "chip", "bottom-right")]);
  assert.deepEqual(await pixel(bars, 960, 40), BLUE);
  assert.deepEqual(await pixel(bars, 960, 1040), GREEN);
  assert.deepEqual(await pixel(bars, 1700, 1020), GREEN, "the footer paints under the chip's old place");
  assert.deepEqual(await pixel(bars, 1700, 935), RED, "the chip moved in 80 past the footer");
  // A header leaves a bottom chip where it is.
  const header = await render("header", [card("header", "header"), card("chip", "chip", "bottom-right")]);
  assert.deepEqual(await pixel(header, 1700, 1020), RED);
});
