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
Use `screenrig help --all` for the complete command inventory, or
`screenrig help --all screen` for one group's descendants. Normal help lists
immediate children. Add `--json` for structured command paths, positional arguments,
option choices and defaults, relationships, and examples;
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

## Screen host and recovery

Native players report the shell and hardware they run on. `screen show` prints
that as a `Host` block (platform, host version, model, manufacturer, firmware,
serial, DUID, MAC, capabilities, and when it was last updated); absent fields
are omitted, and `screen list` adds a `PLATFORM` column when any screen reports
one. In JSON mode the fields pass through as `host` and `host_updated_at`. The
host is a hint that names a device. It is never a credential and never
authorizes anything; only the player's key does.

When a display loses its stored identity (for example after a factory reset)
and starts pairing again while reporting identifiers that match exactly one of
your screens, the server records an offer on that screen. `screen show` and
`screen list` show it as `recovery_pending` with its deadline. Nothing changes
until you confirm:

```bash
screenrig screen show scr_LOBBY
screenrig screen recover scr_LOBBY
```

`screen recover` reconnects the display to the existing screen: the label,
playlist, timezone, schedules, and history stay; the display's new key replaces
the previous one, which retires after a fifteen-minute grace window. Recovery
never happens without this confirmation and never crosses accounts. If you do
not confirm, the pairing code still works as a new screen. The command exits
nonzero with `recovery_not_offered` when nothing is pending,
`recovery_expired` when the display's pairing session lapsed, and
`recovery_ambiguous` when the identifiers are attached to more than one screen.

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

### Nonblocking agent connection

`screenrig agent connect --no-wait --print-url` starts or resumes a connection,
reads one server status snapshot, and returns a JSON envelope. While approval is
pending, `data.status` is `pending`, `data.approval_url` contains the dashboard
handoff, and `data.next.command` identifies the resume command. `data.next.argv`
supplies its arguments, preserving the selected config and API origin. Open the handoff
for the intended user, then run `screenrig agent connect --no-wait` again. An
approved connection completes credential collection and activation and returns
`data.status: active`. No credential is included in either result.

Without `--print-url`, the CLI tries to open the browser and includes the handoff
URL in the pending result only if opening fails. `--no-wait` defaults to a
30-second status-read budget; it does not wait for a person to approve. Normal
`agent connect` retains its existing approval wait of up to 24 hours. `--timeout`
overrides either mode's wait budget. Terminal denial, cancellation, and expiry
remain errors.

### Recovering writes

Ordinary application uploads/updates, playlist creates/updates/deletes, screen
mutations other than provisioning, media tag updates/deletes, K/V and comment
writes, feedback submissions, and operation cancellation persist an idempotency
key before sending the request. After an ambiguous network failure or server
error, rerun the same command with unchanged input. The CLI reuses the saved key;
it does not automatically send another request within the failed invocation.
`write_recovery_saved` indicates that recovery state was retained.

The private config stores request fingerprints, keys, timestamps, and the command
group/action, never request payloads. Fingerprints include the origin, credential, target, request
body, and revision. Changed requests receive different keys. A completed command
clears its pending state; application acceptance followed by a failed processing
wait retains it so retrying does not create another application. Definite
refusals still require reconciliation; revision checks remain in force.

Automatic replay stops after 23 hours, before the server's 24-hour replay window
ends. Inspect the resource before explicitly supplying a new `--idempotency-key`
for a reconciled write. Explicit keys remain supported. Pending entries are not
silently evicted; resolve outstanding writes if the 256-entry limit is reached.
Use `screenrig recovery list` and `screenrig recovery show ID` to inspect local
pending writes. Results contain opaque recovery IDs, creation and replay-expiry
times, replay status, and command names where available. Older entries have no
command metadata. Request contents and retry keys are never returned.

After checking the remote outcome, run `screenrig recovery reconcile ID` to remove
that entry's local retry protection. This does not retry, cancel, or undo the remote
write; a subsequent invocation can make a new write. IDs identify a particular saved
entry, so an old ID cannot remove a replacement entry. These commands work locally
with the selected `--config`, including when credentials are no longer usable.
Enrollment, generation, media uploads/batches, bundle imports, and browser
handoffs retain their existing specialized recovery behavior.

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

## Prepare, publish, and edit playlists

For ready images and videos, prepare a full-screen playlist in playback order:

```sh
screenrig playlist init med_POSTER med_VIDEO --name "Lobby loop" --screen scr_LOBBY --output lobby.json
screenrig playlist preview lobby.json --output preview --contact-sheet
screenrig screen publish scr_LOBBY lobby.json --expect-rev 7
```

Inspect the preview before publishing. `playlist init` reads media metadata and
screen observations but makes no remote writes. It creates one page per media ID,
with `contain` fit, a black background, and a 200 ms crossfade. Images last 8000 ms;
videos are muted, do not loop, and advance on completion. Use `--duration-ms` for
image duration and `--fit contain|cover|fill` for content fit. Override the canvas
with both `--target-width` and `--target-height`; these also work without `--screen`.
Unknown or multiple reported surfaces require explicit dimensions. Output files
must not already exist.

`screen publish <screen-id> <file>` creates a new playlist, assigns it using the
expected **screen** revision, and reads back the assignment. It does not update an
existing playlist by name. A name collision requires a different name or an
explicit `playlist update`. Its JSON result reports `playlist_id`,
`playlist_revision`, `screen_id`, `screen_revision`, `assignment_verified`, and
`playback_verified`. Assignment verification does not prove playback; request and
inspect a screenshot and relevant playback evidence separately.

Publishing saves a private local journal automatically. After an ambiguous failure,
repeat the identical command and input with the same config to resume. If playlist
creation succeeded before assignment failed, the error identifies the created
playlist. Do not delete it or start another create to recover. A revision conflict
requires inspecting the screen and reconciling the intended assignment; an already
created playlist can be assigned explicitly with `screen assign`. Assignment-conflict
guidance includes an inspection command and a separate assignment template with
`<REVIEWED_REVISION>`. Replace that placeholder only after inspecting the screen and
deciding the assignment is still intended. Structured argument arrays preserve the
selected configuration and API origin without requiring shell parsing. Publishing never
silently refreshes the expected revision. Unfinished recovery stops after the
24-hour server idempotency window; inspect and reconcile before making more writes.

To edit an existing playlist:

```sh
screenrig playlist show pl_EXISTING --output lobby.json
screenrig playlist update pl_EXISTING lobby.json --expect-rev 4
```

`playlist show --output` writes the editable `{name, pages}` document and returns
its path, `playlist_id`, and source `revision` on stdout. Use that returned revision
for the update. It preserves dynamic selectors, schedules, motion, and pinned
application releases, removing server-derived media and timing fields. Comments
remain separate. Plain `playlist show` is an inspection response; `--editable`
without `--output` returns `data.document`, `data.playlist_id`, and `data.revision`.
Updating a playlist affects every screen assigned to it.

Playlist validate, create, update, preview, and screen publish accept `-` as their
input file to read stdin. JSON envelopes are never written into authored files.
`--expect-rev` is the preferred revision spelling; `--if-match` remains a compatible
alias. Supply only one. The HTTP revision contract is unchanged.

Generation accepts either `--prompt TEXT` or `--prompt-file FILE`, including
`--prompt-file -` for stdin. The file is the complete prompt, with no trimming;
the existing 4000-character limit applies. Prompts are excluded from diagnostics.
