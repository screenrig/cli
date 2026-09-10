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
screenrig version
```

Node.js 20.11 or newer is required. `media upload` additionally requires ffmpeg
and ffprobe; the other commands do not. Run `screenrig doctor` to inspect
the optional media toolchain before an upload.

This global package is the official developer-shell distribution. It is not the
agent install. Do not substitute it for the plugin launcher.

## What it does

Operational commands return JSON envelopes by default, including errors with
nonzero exit codes. `--json` remains accepted for compatibility. Use `--human`
for explicit human-readable output; it cannot be combined with `--json`.
Output format never changes based on terminal detection. Progress goes to stderr;
`events follow` writes NDJSON (one envelope per line) without a trailing summary.
An empty follow session returns one envelope with `data.items: []`.

Help, including bare command groups, stays human-readable by default; use
`--json --help` for structured discovery. Authoring files remain JSON.

The customer surface is content (`app`, `media`, `compose`), playlists, and screens. Full reference:
[https://screenrig.ai/docs/cli.md](https://screenrig.ai/docs/cli.md).

Discover commands progressively with `screenrig --help`, `screenrig screen --help`,
and `screenrig screen assign --help`. Deeper groups work the same way:
`screenrig comment show --help`. `screenrig help screen assign` is equivalent.
Add `--json` for structured child command paths, invocation syntax, and option types;
help runs without configuration or authentication. Command-specific options follow
that command, for example `screenrig screen update ID --name Lobby --if-match 1`.
Global options such as `--json` may appear before or after the command. Use
`--name=VALUE` for a value starting with a dash, and `--` before option-like file
names. Duplicate options are rejected.

Choose by what the page is:

- Already have the file: `media upload`, then a playlist and `screen assign`.
- Anything presentable: `media generate` as the whole page.
- Slide-deck-like experiences: local unbilled `compose render`.
- Live video, iframe, or webapp: write playlist primitives.

## Application command results

`app upload` and `app update` return the same JSON data paths with or without
`--no-wait`: `data.application` contains the accepted application `id`,
`release_id`, and `operation_id`; `data.pack` contains `sha256` and `file_count`.
The accepted response does not include an application revision. Read `app show`
for the current revision before an update.

`data.operation` contains the observed completed operation when waiting. With
`--no-wait` it is `null`: upload acceptance does not establish operation state
or release readiness. Use `operations get <operation_id>` or
`operations wait <operation_id>` to observe processing. The envelope's
`operation_id` identifies that same operation in either mode. Existing flat
accepted fields (`data.id`, `data.release_id`, `data.operation_id`) and
`data.sha256` remain available as compatibility aliases in both modes.

## Configuration

User-private config lives outside the replaceable plugin directory
(`$XDG_CONFIG_HOME/screenrig/config.json`, or
`%APPDATA%\screenrig\config.json` on Windows). The default service is `https://api.screenrig.ai`.
`SCREENRIG_API_URL` and `--api-url` are explicit overrides.

Optional `log_socket` in that same config enables a side-channel NDJSON
operation log. There is no `--log-socket` flag. Connect failure never fails the
command.

## Develop

Commander 14 supports Node 20.11 and owns parsing, command selection, and help.
Add commands in `src/cli-commands/`: each group registers native Commander commands
with their arguments, options, descriptions, validation hooks, and bound handlers.
There is no separate command schema or path-based dispatcher. Shared option
parsers live beside these modules; human and JSON help read the registered tree.

`src/program.ts` awaits Commander actions with `parseAsync`. The output boundary
keeps one CLI envelope per invocation, and shared handler setup handles config,
authentication, and logging. Only explicitly supplied options reach handlers,
including the existing `no-*` switches. `parseArgv` is an inspection helper for
tests; execution runs through Commander actions.

```sh
npm ci
npm run vendor:check
npm run typecheck
npm test
npm run smoke:mock
```

Execute this checkout with `node ./dist/bin.js` after `npm run build`.

Development profiles are described in [CONTRIBUTING.md](https://github.com/screenrig/cli/blob/main/CONTRIBUTING.md).

See [`RELEASING.md`](https://github.com/screenrig/cli/blob/main/RELEASING.md) for CalVer stamping and npm publication.
Report suspected vulnerabilities through the [security policy](SECURITY.md).
