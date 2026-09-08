# ScreenRig CLI

Noninteractive control-plane CLI and deterministic web-application packer for
[screenRIG](https://screenrig.ai).

The supported customer distribution is the CLI bundled by
[`screenrig/plugin`](https://github.com/screenrig/plugin) from current
`screenrig/cli` `main`. Agent workflows must keep using that plugin-relative
launcher.

## Official npm installation for developer shells

The public npm package is `screenrig`. Install an exact published CalVer
(`YY.MM.SERIAL`, UTC) rather than a mutable range. GitHub release tags are
`vYY.MM.N`. Local and pull-request trees use `YY.MM.0-dev` and must not be
published.

```sh
npm install --global screenrig@<YY.MM.SERIAL>
screenrig --json version
```

Node.js 20.11 or newer is required. `media upload` additionally requires ffmpeg
and ffprobe; the other commands do not. Run `screenrig --json doctor` to inspect
the optional media toolchain before an upload.

This global package is the official developer-shell distribution. It is not the
agent install. Do not substitute it for the plugin launcher.

## What it does

Commands return JSON envelopes an agent can branch on. Customer surface is
content (`app`, `media`, `compose`), playlists, and screens. Full reference:
[https://screenrig.ai/docs/cli.md](https://screenrig.ai/docs/cli.md).

Choose by what the page is:

- Already have the file: `media upload`, then a playlist and `screen assign`.
- Anything presentable: `media generate` as the whole page.
- Slide-deck-like experiences: local unbilled `compose render`.
- Live video, iframe, or webapp: write playlist primitives.

## Configuration

User-private config lives outside the replaceable plugin directory
(`$XDG_CONFIG_HOME/screenrig/config.json`, or
`%APPDATA%\screenrig\config.json` on Windows). When `config.local-dev.json`
exists in that directory, the CLI uses
`http://api.screenrig.localhost:8088` by default. Otherwise the production
default is `https://api.screenrig.ai`. `SCREENRIG_API_URL` and `--api-url`
remain explicit overrides.

Optional `log_socket` in that same config enables a side-channel NDJSON
operation log. There is no `--log-socket` flag. Connect failure never fails the
command.

## Develop

```sh
npm ci
npm run vendor:check
npm run typecheck
npm test
npm run smoke:mock
```

Execute this checkout with `node ./dist/bin.js` after `npm run build`.

See [`RELEASING.md`](RELEASING.md) for CalVer stamping and npm publication.
Report suspected vulnerabilities through the [security policy](SECURITY.md).
