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
4. Allow GitHub Actions to create `v*` tags. The distributing `main` job creates
   them. Humans create GitHub Releases from those tags; they do not invent a
   second version.
5. After trusted publishing works, require two-factor authentication and disallow
   token-based publishing for the npm package.

Trusted publishing requires a GitHub-hosted runner, `id-token: write`, Node
22.14 or newer, and npm 11.5.1 or newer. The workflow uses Node 24 and pins npm
11.5.1. It does not read an npm token. npm generates provenance automatically for
the public package from this public repository.

## Versioning

Distributed CLI artifacts use calendar versioning `YY.MM.SERIAL` (UTC). The
GitHub tag is `vYY.MM.N`. SERIAL starts at 1 each UTC month. 0 is not a release.
Local, pull-request, and other untagged trees use `YY.MM.0-dev`. Do not publish
a `-dev` version. `npm-release.yml` already rejects prerelease GitHub releases.

Committed `package.json` stays `0.1.0`. Do not bump it on every commit. The
distributing `main` job tags HEAD after tests pass and stamps that CalVer into
the packed artifact. A rebuild of the same SHA reuses the tag. Failed jobs do
not tag. SERIAL is not `github.run_number` and not a git commit count.

`npm-release.yml` reuses the tag on that commit and stamps the published
package. The checksum of the CLI tarball the plugin just packed is provenance
of that build; it is not this CalVer string and not a freeze of which SHA to
fetch.

## Release procedure

1. Merge the reviewed commit to `main`. Do not rewrite `package.json`.
2. Let the distributing `main` job tag `vYY.MM.N` and upload the stamped
   `screenrig-cli.tgz`. A rebuild of the same SHA reuses the tag.
3. Create a non-prerelease GitHub release on that existing tag when npm should
   publish. Do not retag.
4. Let `npm-release.yml` reuse the tag, stamp the package, publish through OIDC,
   and attach the offline archive. It rejects a tag that is not `vYY.MM.N`.
5. Require all Linux, macOS, and Windows clean-install jobs to pass. Each installs
   the exact registry version and runs `screenrig --json version` plus
   `screenrig --json compose catalog` on Node 20.11.1.
6. Confirm the workflow attached `screenrig-cli.tgz` and its SHA-256 file to the
   same GitHub release.
7. Verify the npm package page shows provenance before announcing availability.

npm versions are immutable. Never move a release tag, replace an existing npm
version, or use a mutable `latest` install in release verification.

The GitHub archive is the deterministic offline artifact used by the ScreenRig
plugin. The normal npm package is smaller and resolves its declared dependencies
from npm. Homebrew can be evaluated only after this stable release exists. ScreenRig
does not publish this Node CLI to PyPI.
