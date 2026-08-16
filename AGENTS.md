# ScreenRig CLI agent guide

This repository owns the public noninteractive ScreenRig CLI and deterministic
static-application packer. The supported customer distribution is the pinned
CLI artifact bundled by `screenrig/plugin`; this repository does not own plugin
installation, players, backend services, the site, or production deployment.

## Sources of truth

- `src/` and its tests define implemented commands and behavior.
- `package.json` defines the executable, Node engine, scripts, package
  inventory, and public metadata.
- `vendor/manifest.json` records exact backend OpenAPI/protocol/SDK runtime
  inputs.
- `scripts/package-release.sh` defines deterministic `screenrig-cli.tgz`.
- `.github/workflows/ci.yml` defines public, test, package, and secret gates.
  Production selects the artifact only through the backend component lock.

## Edit and generation rules

- Edit `src/`, never `dist/`; `npm run build` regenerates `dist/`.
- Do not hand-edit `vendor/` or `assets/screenrig.runtime.js`. Refresh from
  an explicit reviewed backend checkout:

  ```sh
  node scripts/sync-contract-snapshots.mjs --sync --source-root <backend-checkout>
  ```

- Inspect every vendored path/byte/hash change and keep adapters/tests aligned.
- Preserve deterministic archive ordering, normalized metadata, SDK injection,
  path/type/size limits, and source-directory immutability.
- Preserve unrelated work. Do not commit, push, tag, publish, deploy, or change
  external systems unless explicitly authorized.

## Product and security boundaries

- Package metadata requires Node.js 20.11+. The plugin's package-relative
  launcher owns the exact runtime preflight.
- The first authenticated command persists replay state, enrolls automatically,
  verifies the issued credential, and resumes the original command.
- `auth revoke --yes` is server-first and retains local state after failed or
  ambiguous server results.
- `screen pair` currently accepts exactly six canonical undashed characters.
  `browser setup --code` accepts the dashed or undashed public handoff form.
- Configuration and transient retry state are atomic and user-private. Never
  log/output raw credentials, signed upload details, cookies, completion nonces,
  provisioning material, customer content, or secret-bearing headers/bodies.
- Screenshotting is outside v1; do not add or document screenshot commands.

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
```

`npm run smoke:server` requires an explicitly owned local backend and is not a
production or hardware gate.

## Completion evidence

Report exact source/docs/vendor files changed, vendored provenance and hashes,
all command results, package inventory, stale-language scan, repository status,
and skipped live-server/plugin/player/native/deployment checks.
