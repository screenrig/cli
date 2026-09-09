# cli

This repository owns the public noninteractive ScreenRig CLI and deterministic
static-application packer. The supported agent distribution is the CLI bundled
by `screenrig/plugin` from current `screenrig/cli` `main`. Exact-version npm
releases are the official developer-shell distribution.

It does not own plugin installation, Players, backend services, the site, or
production deployment.

The workspace [`../AGENTS.md`](../AGENTS.md) is the shared working agreement.
This file outranks it on anything local here.

## Sources of truth

- `src/` and its tests define implemented commands and behavior. `src/media/`
  owns the ffmpeg toolchain probe, the transcode planner, and the progress
  reporter.
- `package.json` defines the executable, Node engine, scripts, and public
  metadata. Committed version stays `0.1.0`; CI stamps CalVer on the artifact.
- `vendor/manifest.json` records exact backend OpenAPI/protocol/SDK runtime
  inputs.
- `scripts/package-release.sh` defines deterministic `screenrig-cli.tgz`.
- `.github/workflows/ci.yml` defines public, test, package, and secret gates.
  `.github/workflows/npm-release.yml` is the only npm publication path.
- See `RELEASING.md` for CalVer and npm publication.

## Edit and generation rules

- Edit `src/`, never `dist/`. `npm run build` regenerates `dist/`.
- Do not hand-edit `vendor/` or `assets/screenrig.runtime.js`. Refresh from a
  reviewed backend checkout:

  ```sh
  node scripts/sync-contract-snapshots.mjs --sync --source-root ../backend
  ```

- `npm run vendor:check` is the cheap vendor gate (tamper check, plus drift
  against `../backend` when that sibling exists). Public GitHub Actions does
  not clone backend.
- The release artifact must include every non-development package recorded in
  `package-lock.json`, including optional native targets, and must run offline.
- Preserve unrelated work. Do not commit, push, tag, or publish unless asked.
  Do not publish npm from a laptop.

## Media transcoding

- `media upload` transcodes by default. ffmpeg and ffprobe are a required
  external dependency of that command. The CLI never bundles them.
- H.264 is the default deliberately. There is no per-client codec fallback.
  `--codec hevc` is opt-in for native-only fleets.
- `doctor` check status is `pass`, `warn`, or `fail`; only `fail` moves the
  exit code. A missing credential is `warn` with `next.command`.
- Progress goes to stderr only. Stdout carries the single envelope.
- `--no-transcode` uploads accepted source bytes unchanged. It does not bypass
  the lossy-WebP delivery policy.
- Do not retune quality/bitrate/GOP values here; they are a product decision.

## Product and security boundaries

- Package metadata requires Node.js 20.11+.
- `agent enroll --email ADDRESS` is the explicit first-agent step. Other
  authenticated commands do not enroll as a side effect; they fail with
  `not_enrolled` (exit 3). Keep that code stable.
- No part of a stored credential reaches stdout. Report presence through
  `hasToken` / `describeTokenPresence` (`present` / `(none)`).
- Playlist authoring: choose by what the page is. Existing file →
  `media upload`. Presentable page → `media generate` as the whole page.
  Slide-deck-like → local `compose render`. Live objects → playlist primitives.
  Do not emit native `text`, `box`, or `line`.
- `media generate` is billed per token ($10 / 1M text input, $16 / 1M image
  input, $60 / 1M image output). Quality (`low`, `medium`, `high`; default
  `medium`) changes how detailed the still is and therefore how many tokens it
  uses. Remaining that cannot cover the debit returns payment_required / 402,
  including during launch fail-open. Never print the prompt or pixels.
- Compose is local and unauthenticated. Never put PNG bytes in stdout.
- Until 2027-01-01 08:00 UTC, production fails open on empty remaining for
  billed `/api/v1` work except `media generate`. Do not add pay, Stripe, or
  x402 commands.
- `cli/` is public. Never write MCP. Never print credentials, cookies, signed
  URLs, object keys, or pixels.
- Root `README.md` must keep the exact `[security policy](SECURITY.md)` link.

## Local workspace logs

When this CLI is started through `rig start` in the developer workspace,
stdout and stderr including request, response, and error lines are
appended to `../logs/YY-MM-DD/cli.log` (example
`../logs/26-09-08/cli.log`). Rig deletes date folders older than 7 days.
The `logs/` directory is not a git repository.

## Follow operation logs

Optional `log_socket` lives in the same 0600 user config as the token. There is
no `--log-socket` flag and no `SCREENRIG_LOG_SOCKET` override. Connect failure
never fails the command. This socket is not `events follow`.

## Verification

```sh
npm ci
npm run check:public
npm run vendor:check
npm run typecheck
npm run lint
npm test
npm run smoke:mock
npm run pack:dry
npm run pack:release
npm run check:npm-install
```

`npm run smoke:server` requires an explicitly owned local backend.

To execute this checkout:

```sh
npm run build
node ./dist/bin.js --json version
```

Do not PATH-swap a local checkout into an installed agent. Do not
`npm i -g screenrig` as the agent path.

## Completion evidence

Report source/docs/vendor files changed, vendored hashes, command results,
package inventory, stale-language scan, repository status, skipped
live-server/plugin/player gates, and claim state.
