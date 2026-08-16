# ScreenRig CLI

The ScreenRig CLI is the noninteractive command-line client bundled with the
ScreenRig agent plugin. The supported customer flow is: install ScreenRig from
the agent marketplace, open the Player, then ask your agent to pair the
six-character code shown on screen. The plugin owns invocation; a separate CLI
installation is not part of customer setup.

The CLI emits machine-readable JSON, enrolls automatically on first use, keeps
credentials outside the replaceable plugin directory, and packages already-built
static applications deterministically. It never builds or executes uploaded
source code.

`screenrig auth revoke --yes` is the explicit credential-removal command. It
revokes exactly the stored calling credential on the server and removes local
credential, enrollment, and transient authenticated-operation state only after
the server confirms success. Non-secret API configuration is preserved. The
account, screens, and content remain, but the revoked credential cannot be
recovered in the current anonymous no-email model; the next account-scoped
command enrolls a separate new account. A failed or ambiguous request retains
local state, and retrying the same revocation is safe.

## Development

Node.js 20.11 or newer is required.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run pack:dry
```

The pinned browser runtime in `assets/screenrig.runtime.js` is a release input.
Maintainers update it from the corresponding reviewed ScreenRig SDK artifact
before publishing a release; contributors do not fetch a mutable runtime during
the build.

Security reports belong in
[GitHub Private Vulnerability Reporting](https://github.com/screenrig/cli/security/advisories/new),
not in public issues. See [SECURITY.md](SECURITY.md).

This repository is licensed under Apache-2.0. The license applies to the
contents of this public CLI repository; it does not license other ScreenRig
services or repositories.
