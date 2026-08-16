# ScreenRig CLI

This repository implements the noninteractive ScreenRig control-plane CLI and
deterministic static-application packer. The supported customer distribution is
the exact CI artifact pinned and bundled by
[`screenrig/plugin`](https://github.com/screenrig/plugin); the plugin invokes it
through a package-relative launcher.

## Implemented behavior

The CLI emits machine-readable envelopes and automatically enrolls on the first
authenticated operation. It atomically persists enrollment retry state before
the request, stores the issued credential in user-private configuration outside
the replaceable plugin directory, verifies it, and resumes the original
command.

`auth revoke --yes` revokes the calling credential on the server before
removing local credential, enrollment, and transient authenticated-operation
state. A failed or ambiguous server result retains local state for an exact
retry.

The ordinary pair command currently accepts six canonical characters:

```sh
screenrig --json screen pair ABC234
```

The separate homepage handoff command accepts either `ABC-234` or `ABC234`,
normalizes it, and returns only safe status fields:

```sh
screenrig --json browser setup --code ABC-234
```

Browser handoff has a backend-owned 30-minute unclaimed window and a fresh
10-minute protected delivery window after claim. The CLI never receives or
prints the browser cookie, provisioning token, continuation redirect, native
device credential, or runtime session.

Application packing accepts an already-built static directory. It produces
deterministic bounded archives, injects the pinned browser SDK runtime, and
never builds or executes uploaded source. Runtime pages use
`screenrig.canvas/v1`; protected content and `screenrig.webapp-package/v1`
delivery are backend/player concerns. Screenshotting is not part of v1 and the
CLI exposes no screenshot command.

## Development and provenance

Node.js 20.11 or newer is required by the package.

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

`vendor/manifest.json` pins backend OpenAPI/protocol inputs and the injected SDK
runtime by path, byte count, and SHA-256. Refresh only with
`node scripts/sync-contract-snapshots.mjs --sync --source-root
<backend-checkout>` and review every change. `dist/` is generated from
`src/`.

CI publishes deterministic `screenrig-cli.tgz`. The plugin repository pins that
artifact by CLI commit and SHA-256, and the backend production lock separately
selects it for release assembly. This repository does not deploy ScreenRig.

Source/package tests do not prove installed-plugin loading, live enrollment or
pairing, public browser handoff, Player rendering, native hardware, or
production deployment.

Security reports belong in
[GitHub Private Vulnerability Reporting](https://github.com/screenrig/cli/security/advisories/new).
See [SECURITY.md](SECURITY.md). The Apache-2.0 license covers this public CLI,
not other ScreenRig services or repositories.
