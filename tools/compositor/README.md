# Compositor lab

A local preview over `screenrig compose render`, not a second compositor. The CLI
owns parsing, typing, painting, fonts and diagnostics (`src/compose/`); this
directory holds example specs, a static viewer and a small HTTP server that
shells out to the built CLI. Run `screenrig compose catalog` for the language
(regions, fields, installed fonts).

```sh
# from the repository root
npm run build
cd tools/compositor
node server.mjs        # http://127.0.0.1:4545/
```

The server answers only requests whose Host is `127.0.0.1`, `localhost` or `[::1]`
with its own port, takes `POST /api/generate` only as `application/json` from its
own page, and refuses spec image paths that are absolute or climb out of the
run directory.

The lab renders layered output (the default; `--combined` is for inspection) with
the cwd set so `./media/...` in a spec resolves under `examples/`. Showcase media
under `examples/media/` is gitignored; pages that reference it fail to generate
until the files are present. Do not install a second canvas package here.
`iframe` and `webapp` layers are not painted; the lab draws a labelled hole.
`src/compose/compose.test.ts` reads `examples/` and checks that the specs name
installed fonts.
