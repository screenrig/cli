# cli

Public noninteractive ScreenRig CLI and deterministic static-application packer.
Agents run the CLI bundled by `screenrig/plugin` from current `main`; developers
can build this checkout. This repository does not own plugin
installation, Players, backend services or the site. It is a public maintainer
guide: the optional workspace-parent AGENTS.md adds shared operational rules but
is not required to contribute.

## Sources of truth

- `src/` and its tests define commands and behavior. Native Commander command
  definitions own arguments, choices and validation; help-only notes and examples
  live in `src/cli-commands/guidance.ts`. `src/media/` owns the ffmpeg probe,
  transcode planner and progress reporter.
- `package.json` defines the executable, Node engine and scripts. The committed
  version stays `0.1.0`; CI stamps CalVer on the artifact (`RELEASING.md`).
- `contracts.toml` names the backend OpenAPI/protocol inputs; `contracts.sha256`
  pins their bytes, including the built `assets/screenrig.runtime.js`. The
  OpenAPI is backend's public document (`api/public/`), which leaves out the
  staff routes; `check:public` fails on any staff route in the tree.
- `scripts/package-release.sh` builds the deterministic `screenrig-cli.tgz`: one
  minified `dist/bin.js` with the runtime dependencies inside (except the
  `@napi-rs/canvas-*` platform packages, fetched on first render per
  `runtime-dependencies.lock.json`). `scripts/check-release-artifact.mjs` states
  its inventory.
- `.github/workflows/ci.yml` runs the public, test, package and secret gates;
  `npm-release.yml` is the only npm publication path. Never publish from a laptop.

## Rules

- Edit `src/`, never `dist/`. Never hand-edit `vendor/`, `assets/` or
  `src/generated/`; refresh them from the workspace root with
  `rig contracts sync cli`. `npm run vendor:check` is the offline gate and
  `rig contracts check cli` compares against backend origin/main.
- Read `assets/` only through `src/assets.ts` and load `@napi-rs/canvas` only
  through `src/canvas.ts`; commands that do not draw never load it.
- Preserve unrelated work. Do not commit, push, tag or publish unless asked.
- Never PATH-swap a local checkout into an installed agent, and never
  `npm i -g screenrig` as the agent path.
- `cli/` is public: no internal hosts, private origins or customer data, and
  never write MCP. The README must keep the exact `[security policy](SECURITY.md)`
  link.

## Vocabulary and help

- Fleet commands accept any number of screen ids or tag matches, follow the
  backend's bounded continuations under one action key, honor budget pauses and
  return every per-screen result. Never add a screen-count or fleet-page cap.
- `show` inspects a resource, `list` reads a collection, K/V uses `get`/`set`,
  display names use `--name`, selectors use `--screen-id`, `--app-id`,
  `--playlist-id`, `--release-id`, revision guards use `--expect-rev`, event
  cursors use `--after`. The group is `app`; prose says "application".
  Keep existing aliases working and never rename backend fields to match flags.
- Declare option relationships with `requireOptionGroup` so human help, JSON
  help and preflight validation agree. Every command gets a working example, and
  help states write scope, waiting and recovery where relevant. Document stdin
  only where implemented.
- Output is one envelope per invocation; progress goes to stderr.

## Behavior invariants

- `agent enroll --email ADDRESS --organization NAME` is the only enrolling
  command. Other authenticated commands fail with `not_enrolled` (exit 3); keep
  that code stable.
- No part of a stored credential reaches stdout. Report presence through
  `hasToken` / `describeTokenPresence` (`present` / `(none)`).
- `media upload` transcodes by default and requires external ffmpeg/ffprobe,
  which the CLI never bundles. H.264 is the default with no per-client fallback;
  `--codec hevc` is opt-in. Do not retune quality, bitrate or GOP values: they
  are a product decision. `--no-transcode` uploads accepted source bytes
  unchanged but does not bypass the lossy-WebP delivery policy.
- `doctor` check status is `pass`, `warn` or `fail`; only `fail` moves the exit
  code. A missing credential is `warn` with `next.command`.
- Playlist authoring: existing file, `media upload`; presentable page, `media
  generate` as the whole page; slide-deck-like, local `compose render`; live
  objects, playlist primitives. Never emit native `text`, `box` or `line`.
- Server admission decides whether billed work (`media generate`) proceeds, not
  the displayed balance; respect `payment_required`. Add no pay, Stripe or x402
  commands. Compose is local and unauthenticated and never writes PNG bytes to
  stdout.
- Optional `log_socket` lives in the 0600 user config; there is no flag or env
  override, and a connect failure never fails the command.

## Verification

```sh
npm ci
npm run check:public
npm run vendor:check
npm run check
npm run smoke:mock
npm run pack:dry
npm run pack:release
npm run check:npm-install
```

`npm run smoke:server` needs an explicitly owned local backend. To run this
checkout: `npm run build && node ./dist/bin.js version`.
