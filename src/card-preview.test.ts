import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { inflateSync } from "node:zlib";
import { withCardPreview, type CardPreviewInput } from "./card-preview.js";
import { processRuntime, type CliRuntime } from "./runtime.js";
import { testTemp } from "./test-temp.js";

/** RGBA pixels of an 8-bit, non-interlaced RGB or RGBA PNG: inflate the IDAT stream and undo each scanline's filter. */
function decodePng(png: Buffer): { width: number; height: number; data: Uint8Array } {
  assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "not a PNG");
  let width = 0, height = 0, channels = 0;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString("latin1", offset + 4, offset + 8), body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, "bit depth");
      assert.ok(body[9] === 2 || body[9] === 6, `color type ${body[9]}`);
      assert.equal(body[12], 0, "interlaced");
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") chunks.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels]! : 0, up = y > 0 ? out[(y - 1) * stride + x]! : 0, upLeft = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels]! : 0;
      const guess = left + up - upLeft, pl = Math.abs(guess - left), pu = Math.abs(guess - up), pul = Math.abs(guess - upLeft);
      const predictor = [0, left, up, (left + up) >> 1, pl <= pu && pl <= pul ? left : pu <= pul ? up : upLeft][filter];
      assert.notEqual(predictor, undefined, `PNG filter ${filter}`);
      out[y * stride + x] = (line[x]! + predictor!) & 255;
    }
  }
  if (channels === 4) return { width, height, data: out };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([out[i * 3]!, out[i * 3 + 1]!, out[i * 3 + 2]!, 255], i * 4);
  return { width, height, data: rgba };
}

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
      const decoded = decodePng(standalone.png);
      assert.equal(decoded.width, 1920);
      assert.equal(decoded.height, 1080);
      const pixels = decoded.data;
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
