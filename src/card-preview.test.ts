import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { test } from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { withCardPreview, type CardPreviewInput } from "./card-preview.js";
import { processRuntime } from "./runtime.js";
import { testTemp } from "./test-temp.js";

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
  };
  const script = `window.ScreenRigCards={
    configure(){}, versions(){return {cards:{test:'1.0.0'}}}, manifest(){return {}},
    place(layout){return (${JSON.stringify(boxes)})[layout] || (${JSON.stringify(boxes.full)})},
    mount(element,options){element.style.background='#cc3300';options.onReady();return {}}
  };`;
  const assets = new Map([["/cards/renderer.js", script], ["/cards/sandbox.js", ""], ["/cards/fonts.css", ""]]);
  const link = (src: string) => ({ src, sha256: createHash("sha256").update(assets.get(src)!).digest("hex") });
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/cards/index.json") return Response.json({ web: { script: link("/cards/renderer.js"), sandbox: link("/cards/sandbox.js"), fonts: link("/cards/fonts.css") } });
    assert.ok(assets.has(pathname), `unexpected asset ${pathname}`);
    return new Response(assets.get(pathname));
  });
  const runtime = { ...processRuntime(), homedir: () => directory, env: { ...process.env, TMPDIR: directory, SCREENRIG_BROWSER: process.env.SCREENRIG_TEST_BROWSER } };
  await withCardPreview({ apiUrl: "https://example.test", runtime }, async renderer => {
    const rect = { x: 100, y: 200, width: 400, height: 300 };
    const cases: Array<{ input: Partial<CardPreviewInput>; expected: { x: number; y: number; w: number; h: number; rotation: number } }> = [
      ...Object.entries(boxes).map(([layout, expected]) => ({ input: { layout, anchor: "bottom-right" }, expected })),
      { input: { layout: "free", placement: { rect, strips: [] } }, expected: { x: 100, y: 200, w: 400, h: 300, rotation: 0 } },
      { input: { layout: "corner", anchor: "bottom-right", placement: { strips: ["bottom"] } }, expected: { ...boxes.corner, y: 690 } },
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
