# cli

Public noninteractive screenRIG CLI and deterministic static-application packer.
Agents run the CLI bundled by `screenrig/plugin` from current `main`; developers
can build this checkout. This repository does not own plugin installation,
Players, backend services or the site.

## Sources of truth

- `src/` and its tests define commands and behavior. Native Commander command
  definitions own arguments, choices and validation; help-only notes and examples
  live in `src/cli-commands/guidance.ts`.
- `package.json` defines the executable, Node engine and scripts. The committed
  version stays `0.1.0`; CI stamps CalVer on the artifact (`RELEASING.md`).
- `contracts.toml` names the backend OpenAPI/protocol inputs; `contracts.sha256`
  pins their bytes, including the built `assets/screenrig.runtime.js`. The
  OpenAPI is backend's public document (`api/public/`), which leaves out the
  staff routes; `check:public` fails on any staff route in the tree.
- `scripts/package-release.sh` builds the deterministic `screenrig-cli.tgz`:
  readable, unminified `dist/bin.js` and the flat `dist/*.js` chunks it loads per
  command bundle (the plugin directory's security scan reviews the code as
  text), with the runtime dependencies inside (`runtime-dependencies.lock.json`),
  plus `assets/`. No bundled file may exceed 256 KiB (the Claude plugin
  directory reads no more), and the bundler fails on one. It cuts any chunk over
  235,000 bytes into pieces by module path (`scripts/bundle-release.mjs`); a
  single module over the limit has to be split in source.
  `scripts/check-release-artifact.mjs` states the artifact's inventory.
- The bundler also fails on any pattern `scripts/directory-scan.mjs` lists: the
  Claude directory reads script text as shell and holds a plugin that seems to
  read a credential. Template literals ship as `.concat()` for that reason. In
  source: register a `set` or `export` subcommand with `subcommand()`, never
  start a clause of a message with "pass" (write "name a file"), and read the
  environment only by name in `src/host-settings.ts`.
- Commands load on demand: `src/cli-commands/index.ts` maps each top-level
  command to a bundle in `src/bundles/`, which registers its commands and
  imports their handlers from `src/handlers/`; `src/commands.ts` keeps what
  bundles share. A new registration module joins a bundle there (the catalog
  test fails otherwise); help guidance loads only for help.
- `npm-release.yml` is the only npm publication path (`RELEASING.md`).

## Rules

- Edit `src/`, never `dist/`. Never hand-edit `assets/` or `src/generated/`;
  refresh them with `rig contracts sync cli`. `npm run vendor:check` (part of
  `npm run check`) is the offline gate and `rig contracts check cli` compares
  against backend origin/main.
- Read `assets/` only through `src/assets.ts`.
- A command that sends a new request field must not reach `main` before the backend that accepts it is in production:
  the backend rejects unknown fields, and the plugin rebundles `main`.
- Never PATH-swap a local checkout into an installed agent, and never
  `npm i -g screenrig` as the agent path.
- The README must keep the exact `[security policy](SECURITY.md)`
  link (`scripts/check-release-artifact.mjs` checks it).

## Vocabulary and help

- Fleet commands accept any number of screen ids or tag matches, follow the
  backend's bounded continuations under one action key, honor budget pauses and
  return every per-screen result. Never add a screen-count or fleet-page cap.
- `show` inspects a resource, `list` reads a collection, K/V uses `get`/`set`,
  display names use `--name`, selectors use `--screen-id`, `--app-id`,
  `--playlist-id`, `--release-id`, revision guards use `--expect-rev`, event
  cursors use `--after`. The group is `app`; prose says "application".
  Aliases and compatibility shims for old spellings or old servers are removed,
  not kept; only code that reads credentials or config files saved by released
  CLIs stays. Never rename backend fields to match flags.
- Declare option relationships with `requireOptionGroup` so human help, JSON
  help and preflight validation agree. Every command gets a working example, and
  help states write scope, waiting and recovery where relevant. Document stdin
  only where implemented.
- Output is one envelope per invocation; progress goes to stderr.

## Behavior invariants

- `agent enroll` is the only enrolling command; enrollment is never a side effect
  of another command. Other authenticated commands fail with `not_enrolled`
  (exit 3); keep that code stable.
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
  generate` as the whole page; live text, built-in cards; live objects,
  playlist primitives. Never emit native `text`, `box` or `line`.
- Server admission decides whether billed work (`media generate`) proceeds, not
  the displayed balance; respect `payment_required`. Add no pay, Stripe or x402
  commands.
- Optional `log_socket` lives in the 0600 user config; there is no flag or env
  override, and a connect failure never fails the command.

## Verification

```sh
npm ci
npm run check:public
npm run check
npm run smoke:mock
npm run pack:dry
npm run pack:release
npm run check:npm-install
```

`npm run smoke:server` needs an explicitly owned local backend. To run this
checkout: `npm run build && node ./dist/bin.js version`.
