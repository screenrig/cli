# Releasing the ScreenRig CLI

The public npm package is `screenrig`. A stable GitHub release in
[`screenrig/cli`](https://github.com/screenrig/cli) is the only event that
publishes it, through `.github/workflows/npm-release.yml`. Never publish from a
laptop or the ordinary `main` workflow.

The npm trusted publisher is configured for organization `screenrig`, repository
`cli`, workflow `npm-release.yml`, environment `npm` (protected, with required
reviewers). Publishing uses OIDC on a GitHub-hosted runner, with no npm token;
npm generates provenance. The workflow pins npm 11.5.1.

## Versioning

Distributed artifacts use CalVer `YY.MM.SERIAL` (UTC); the tag is `vYY.MM.N`.
SERIAL starts at 1 each UTC month. Untagged trees use `YY.MM.0-dev`, which is
never published. The committed `package.json` stays `0.1.0`: the `main` job tags
HEAD after tests pass and stamps the CalVer into the packed artifact; rebuilding
the same SHA reuses the tag, and a failed job does not tag.

## Procedure

1. Merge the reviewed commit to `main`. The `main` job tags `vYY.MM.N` and uploads
   the stamped `screenrig-cli.tgz`.
2. To publish to npm, create a non-prerelease GitHub release on that existing
   tag. Do not retag. `npm-release.yml` rejects any other tag shape, publishes,
   and attaches the archive and its SHA-256 file to the release.
3. The Linux, macOS and Windows clean-install jobs must pass: each installs the
   exact registry version on Node 22.11.0 and runs `screenrig --json version`
   and `screenrig --json compose catalog`.
4. Confirm the npm page shows provenance before announcing.

npm versions are immutable: never move a tag or replace a published version, and
never verify against a mutable `latest`. The archive is what the plugin bundles
(`AGENTS.md` describes its contents).
