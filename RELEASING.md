# Releasing the ScreenRig CLI

The public npm package is `screenrig`. A stable GitHub release in
[`screenrig/cli`](https://github.com/screenrig/cli) is the only source event that
may publish it. Do not publish from a laptop or from the ordinary `main` workflow.

## One-time registry and GitHub setup

An npm package owner and a GitHub organization owner must complete these steps
before the first release:

1. Establish npm ownership of the unscoped `screenrig` package name. If npm does
   not permit that name, stop and make the package-name decision before changing
   source metadata.
2. Configure the package's npm trusted publisher with organization `screenrig`,
   repository `cli`, workflow filename `npm-release.yml`, environment `npm`, and
   allowed action `npm publish`.
3. Create a protected GitHub environment named `npm` with required reviewers.
4. Protect release tags matching `v*` so only release owners can create them.
5. After trusted publishing works, require two-factor authentication and disallow
   token-based publishing for the npm package.

Trusted publishing requires a GitHub-hosted runner, `id-token: write`, Node
22.14 or newer, and npm 11.5.1 or newer. The workflow uses Node 24 and pins npm
11.5.1. It does not read an npm token. npm generates provenance automatically for
the public package from this public repository.

## Release procedure

1. Update `package.json`, `package-lock.json`, `src/commands.ts` `CLI_VERSION`,
   `scripts/check-public-repo.py` `EXPECTED_VERSION`, and
   `scripts/check-release-artifact.mjs` together.
2. Run the repository gates documented in `AGENTS.md`.
3. Merge the reviewed release commit to `main`.
4. Create a non-prerelease GitHub release whose immutable tag is exactly
   `v<package.json version>` and targets that commit.
5. Let `npm-release.yml` publish through OIDC. It rejects a tag/version mismatch,
   runs the complete public gates, and publishes no secret token.
6. Require all Linux, macOS, and Windows clean-install jobs to pass. Each installs
   the exact registry version and runs `screenrig --json version` plus
   `screenrig --json compose catalog` on Node 20.11.1.
7. Confirm the workflow attached `screenrig-cli.tgz` and its SHA-256 file to the
   same GitHub release.
8. Verify the npm package page shows provenance before announcing availability.

npm versions are immutable. Never move a release tag, replace an existing npm
version, or use a mutable `latest` install in release verification.

The GitHub archive is the deterministic offline artifact used by the ScreenRig
plugin. The normal npm package is smaller and resolves its declared dependencies
from npm. Homebrew can be evaluated only after this stable release exists. ScreenRig
does not publish this Node CLI to PyPI.
