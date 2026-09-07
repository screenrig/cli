# Compositor lab

Preview over `screenrig compose render`. Not a second compositor.

The CLI owns parse, type, paint, fonts, and diagnostics. This directory is a local preview: examples, a static viewer, and a small HTTP server that shells out to the built CLI.

Type size is procedural. Authors name a role (`eyebrow`, `title`, `subtitle`, `text`, `footer`). They do not set `fontSize`.

## Run

Build the CLI first, then start the lab from this directory:

```sh
# from the CLI repository root
npm run build
cd tools/compositor
node server.mjs
```

Do not install a second canvas package here. Showcase media under
`examples/media/` is local and gitignored; the lab still runs without those
files, but example pages that reference them will fail to generate until the
files are present. `examples/exec-intro.json` is the overlay-family deck
(named regions from `compose catalog`, `enter` on the copy, page `logo`).
The title page matches `overlay-title` (no card). Status and close pages
match `overlay-still`. Title uses `title-boardroom.jpg`. Other photo and
video paths are stand-ins under `examples/media/` when that directory is
present.

Open http://127.0.0.1:4545/

Generate calls:

```sh
node <cli-root>/dist/bin.js --json compose render <run>/input.json --output <run-dir>
```

with cwd set so `./media/...` in the spec resolves under `examples/`. Default generate is layered (no `--combined`). `--combined` is inspection-only on the CLI.

The preview plays layered output: region PNGs stacked by `z`/`rect`, `<video>` for page `video`, enter animations (500 ms then 400 ms, plus `stagger * 120` ms), and `drift` / `spin` motion.

## Language

JSON. The page sets the rails. Every region inherits `font`, `background`, `brand`, and `text`. Muted copy is derived from `text` mixed toward `background`. Unknown keys fail. Copy fields accept a string or an array of lines.

```json
{
  "width": 1920,
  "height": 1080,
  "font": "Liberation Serif",
  "background": "#1C1410",
  "brand": "#C9A227",
  "text": "#F3E6D0",
  "left": {
    "enter": "fade-up",
    "title": "COMMUNITY SUPPER",
    "text": "Saturday 17 October at 19:00."
  },
  "right": {
    "valign": "bottom",
    "footer": "Main Hall · Reserve at welcome desk"
  }
}
```

On the page, `text` is the copy color. In a region, `text` is the body copy.

`background` is a color, not a region. Full-bleed media is `image` or `video` on the page.

Regions: `fullpage`, `left`, `right`, `left-third`, `middle-third`, `right-third`, `middle-half`, `top-half`, `bottom-half`, `top`, `bottom`.

Inside a region: `eyebrow`, `title`, `subtitle`, `text`, `footer`, `image`, `video`, `iframe`, `webapp`, `cards`, `card`, `table`. Optional `enter`, `stagger`, `motion`, `align`, `valign`, `fill`, `color`, `z`, `shadow`, `outline`.

`card` is a plate. `card.fit` is `region` (default, fills the region) or `ink` (hugs measured type plus 24 px, placed with `align`/`valign`). Default fill is the page background + B3. `cards` (plural) is the menu-item list and can sit inside `card`. Copy strings accept `**bold**`, `*italic*`, and `__underline__`.

Page `logo` is a path or `{ src, corner }`. It sits 32 px inset from the chosen corner, contained to 200×100, never upscaled.

Text over a page `image` or `video` with no `fill` gets a 1 px unblurred drop shadow: black `#000000E6` on light type, white `#FFFFFFE6` on dark type. Set `shadow` to `"none"` or `{ "x", "y", "color" }` to override. `outline` is `{ "width": 0.5-12, "color" }` and is off by default.

`video` plays in the lab from `media.src`. `iframe` and `webapp` are not painted: the manifest carries `{ type, src, rect }` and the lab draws a labelled hole from `media.rect`. Layers without `file` do not load an image.

There is no `size` field. Changing canvas size or region width changes type. A short title in a wide box sits at wish. A long title tightens toward the floor, then wraps.

A named `font` must be installed. A missing family is `usage_error`, not a silent fallback.
