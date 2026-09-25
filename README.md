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
and ffprobe, as do batch uploads and playlist preparation from local media files. Run `screenrig doctor` to inspect
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
that command, for example `screenrig screen update ID --name Lobby`.
Global options such as `--json` may appear before or after the command. Use
`--name=VALUE` for a value starting with a dash, and `--` before option-like file
names. Duplicate options are rejected.

Choose by what the page is:

- Already have the file: `media upload`, then a playlist and `screen assign`.
- Anything presentable: `media generate` as the whole page.
- Slide-deck-like experiences: local unbilled `compose render`.
- Live video, iframe, or webapp: write playlist primitives.

## Command vocabulary

Use these canonical spellings in new invocations and examples:

| Concept | Spelling | Compatibility |
| --- | --- | --- |
| Inspect one resource | `show` (including `operations show`) | `operations get` and `playlist get` remain aliases |
| Read/write a K/V value | `kv get` / `kv set` | Values retain their byte-oriented semantics |
| Display name | `--name` | Screen pair/provision retain `--label` |
| Select a screen | `--screen-id` | Playlist init retains `--screen` |
| Select an application namespace | `--app-id` | K/V retains `--application-id` |
| Select a playlist or release | `--playlist-id` / `--release-id` | IDs stay explicit |
| Guard a revision | `--expect-rev` | `--if-match` remains an alias |
| Read a collection | `list` | `events` and `operations` retain established plural group names |

The application command group is `app`; use “application” in explanatory prose.
Keep the established `comment ACTION screen|playlist ID` grammar. `--page` and
`--primitive` identify objects within a playlist, rather than project resources.
Use `--after` for an event cursor (`--cursor` remains an alias). `--output` selects
an output path; each command states whether it expects a file or directory.
Durations use milliseconds as stated by `--duration-ms`, `--poll-ms`, and `--timeout`.

Legacy option spellings share the same value and validation as their canonical
option; supplying both is an error. JSON help exposes compatibility spellings in
`options[].aliases`. Response fields and backend contracts are unchanged.
Option `relationships` describe `exactlyOne`, `atLeastOne`, and `together` groups;
`requires` means the first option requires every remaining option. These same
rules validate invocations before configuration or network access.

## Projects and enrollment

An explicit enrollment creates a project, attaches this agent, and emails a
member invitation to the contact address. The same person can belong to more
than one project.

```sh
screenrig agent enroll --email ADDRESS [--project-name NAME] [--name NAME] [--intent signage|advertising] [--force]
screenrig project show
screenrig project capabilities
screenrig project rename NAME
```

`--project-name` names the project; `--name` names this agent. Enrollment reports
the project ID and name and confirms that a member invitation was requested,
without exposing a credential or invitation URL. Other authenticated commands
never enroll automatically.

## Invitations

Invite people to the current project, or invite advertising buyers through the
same invitation commands:

```sh
screenrig invitations create --email ADDRESS[,ADDRESS] [--link]
screenrig invitations create --kind ad-buyer --email ADDRESS[,ADDRESS] [--screen-id ID] [--slot-id ID] [--policy trusted|review_required]
screenrig invitations list [--kind member|ad-buyer] [--status STATUS]
screenrig invitations revoke ID
```

Member invitations are the default. Email delivery reports invitation status,
not proof that a message reached the inbox. `--link` requests a member invitation
link instead of email delivery. Its URL appears once in the selected output
format and is never saved to configuration, write-recovery state, or logs.
Share it only with the intended person. Advertising invitations use email
delivery and the selected screen, slot, and approval policy.

The server enforces invitation and member limits. A refused invitation is not
retried automatically. After an ambiguous failure, rerun the same command
unchanged; the CLI preserves its request key. Automation can supply
`--idempotency-key` to explicitly replay a request.

## Dashboard and sign-in reset

```sh
screenrig dashboard [open]
screenrig dashboard reset-sign-in --email ADDRESS
```

`dashboard` and `dashboard open` open the dashboard origin without a credential
or a network request. If no browser can open, the CLI prints the public origin.
Sign in as a person and select a project in the dashboard.

A sign-in reset is unauthenticated: it never enrolls, sends a stored credential,
or changes the stored project or enrollment. It works on a fresh installation.
The response is neutral whether or not the address is known: if this address can
receive sign-in instructions, check its inbox. Delivery is not confirmed.
Rerunning an ambiguous request reuses its saved Idempotency-Key.

To attach an existing project to this installation, run `screenrig agent connect`
and approve the connection request in that project's dashboard.

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
never happens without this confirmation and never crosses projects. If you do
not confirm, the pairing code still works as a new screen. The command exits
nonzero with `recovery_not_offered` when nothing is pending,
`recovery_expired` when the display's pairing session lapsed, and
`recovery_ambiguous` when the identifiers are attached to more than one screen.

When the server reports it, the offer also describes the display asking to
reconnect: platform, model, firmware, and manufacturer, with no identifiers.
`screen show` prints them on the recovery line, for example
`Recovery pending until 2026-09-13T08:00:00Z: Samsung tizen QM43B, firmware
T-KTM2DEUC-1234`; absent fields are omitted, and in JSON mode they pass through
as `recovery_pending.host`. Compare the reported model and firmware with the
display you expect before confirming. A display's identifiers can be read by
any application running on it, so an offer alone does not prove which display
is asking. The service also refuses offers while the screen's current player
is still online and limits how many offers each screen receives.

## Archived screens and reload

Archiving a screen darkens its display but keeps the display's binding: the
player stays connected, never re-pairs, and resumes when you run
`screen unarchive`. A screen is also archived when its player is reset on the
display or a paired browser unpairs itself. While archived, `screen show`
prints `archive_reason` (`project`, `device_reset`, or `device_unpair`) and
`archived_at` when the server reports them, and `screen list --state archived`
adds a `REASON` column. `screen unarchive` re-admits the same display key for
every reason, so a display that still holds it resumes with no re-pairing. A
display reset on the device may start pairing again with a new key; when that
pairing is offered as a recovery of the archived screen, `screen show` reports
`recovery_pending`, and `screen recover` moves the screen to the new key while
it stays archived until `screen unarchive`. A key retired by a confirmed
`screen recover` stays retired.

```bash
screenrig screen list --state archived
screenrig screen unarchive scr_LOBBY
```

`screen reload` asks a screen's player to reload once and returns a
`reload_id` and `expires_at` ten minutes later. A web player reloads at its
next page boundary; a native player reconnects, refetches its manifest, and
checks for an update. The Player reloads once, and ignores a reload within
ten minutes of the last one it acted on.
It works on active and archived screens and does not change the screen
revision; a screen still waiting to pair answers `resource_conflict`.

When a screen's player cannot show the application or web page primitives in
its playlist, `screen show` reports `applications_unsupported` with the time
the condition began, and `screen list` marks the row. The manifest is
unchanged; the player skips those primitives.

## Screen tags and fleet actions

A screen carries 0 to 16 unique tags, each 1 to 32 letters or digits. Tags
select fleets; they are never authorization and never reach the runtime
manifest. Changing tags bumps the screen revision, not the manifest revision.
`screen show` and `screen list` return `tags`; `screen list` adds a `TAGS`
column when any listed screen has tags.

```sh
screenrig screen list --tag Lobby
screenrig screen tag scr_LOBBY --set Lobby,Floor2 [--expect-rev REVISION]
screenrig screen tag scr_LOBBY --add Spring
screenrig screen tag scr_LOBBY --remove Floor2
screenrig screen tag scr_LOBBY --clear
screenrig screen tag --tag Lobby --add Spring
screenrig screen assign --tag Lobby --playlist-id pl_PLAYLIST
screenrig screen reload scr_LOBBY scr_ENTRANCE
screenrig screen toast --tag Lobby --text "Closing in ten minutes"
screenrig screen screenshot --tag Lobby --output lobby-shots [--concurrency 4]
```

`screen tag` takes exactly one of `--set`, `--add`, `--remove`, or `--clear`.
With one screen id it uses `PATCH /api/v1/screens/{id}` with the whole tag set
and returns the updated screen, like every other single-screen write. `--set`
and `--clear` are guarded only by `--expect-rev`. `--add` and `--remove` read
the screen first and send the new set guarded by `--expect-rev` or, when
omitted, by the revision just read, so a concurrent change fails with
`revision_conflict` (exit 6) instead of being overwritten.

`screen assign`, `screen reload`, `screen toast`, and `screen tag` accept
several screen ids or `--tag TAG` (not both) as one
`POST /api/v1/screens/actions` request: one metered request for up to 500
screens. `--tag` selects active screens only. One screen id keeps the
single-screen route and its envelope. Fleet requests take no `--expect-rev`
because revision guards are per screen. They always send an Idempotency-Key.
After an interrupted or ambiguous request, rerunning the identical command
reuses the saved key and replays finished screens without repeating their side
effects. A returned answer, including a partial failure, completes the write,
so a later rerun is a new request (pass the same `--idempotency-key` to replay
an answered request deliberately within 24 hours). Fleet `--add`/`--remove`
apply against each stored set atomically. A single-screen `--add`/`--remove`
rerun that reads a newer revision replaces its obsolete saved key.

A fleet answer keeps `ok: true`; partial success is a normal answer, not a
transport error:

```json
{
  "ok": true,
  "data": {
    "action": "reload",
    "matched": 3, "succeeded": 2, "failed": 1,
    "results": [
      { "screen_id": "scr_LOBBY", "status": "ok", "reload": { "reload_id": "…", "expires_at": "…" } },
      { "screen_id": "scr_GONE", "status": "failed", "problem": { "code": "not_found", "status": 404, "…": "…" } },
      { "screen_id": "scr_ENTRANCE", "status": "ok", "reload": { "reload_id": "…", "expires_at": "…" } }
    ]
  },
  "warnings": [{ "code": "fleet_partial_failure", "message": "1 of 3 screens failed; 2 succeeded. …" }]
}
```

An `ok` result carries the single-screen result: `revision` for `assign`,
`revision` and `tags` for tag actions, `reload` for reload, and `toast` for
toast. A `failed` result carries the problem that screen's own request would
have returned. The exit code is 0 only when every matched screen succeeded.
Otherwise it is the exit code of the first failed screen's problem (for
example 4 for `not_found`, 6 for `revision_conflict`), with warning
`fleet_partial_failure`. No match is exit 0 with warning `fleet_no_match`. A
malformed selector or action fails the whole request before any screen changes.

`screen screenshot` with several ids or `--tag` fans out on the client
(screenshots are unbilled, so there is no fleet screenshot action). `--tag`
resolves through `screen list --tag`, one billed list request, and keeps
active screens, at most 500. Several ids must all be screen ids (`scr_…`).
An unexpected local failure stops new captures; unstarted screens report
`not_attempted` and the exit code is 1. `--output` is
then a directory, the current directory by default, created if missing. Each
capture writes `<screen_id>.webp`. `--concurrency` bounds captures in flight
(1–8, default 4). The envelope has the same `matched`/`succeeded`/`failed`/`results`
shape with `action: "screenshot"`, `selector`, and `output`. Each `ok` result
carries `path`, `bytes`, `sha256`, `width`, and `height`. The exit code and
warnings follow the same rule. `--idempotency-key` is refused in this form.

`screen publish` stays single-screen, because its assignment readback and
revision guard are per screen. For a fleet, create the playlist once with
`playlist create`, then run `screen assign --tag TAG --playlist-id ID`.
Each screen applies its own schedule timezone rule and fails individually.

`events list` and `events follow` include the project-only presence events
`screen.online` and `screen.offline` (with `details.last_online_at`, and
`offline_at` on a return). `screen.offline` is written only after the
presence lease has been expired for 60 seconds, so a brief reconnect writes
neither.

## Storage report

A native player reports its content-cache storage to the server, and
`screen show` prints that as a `Storage` block: cache capacity and used bytes,
durability, the storage plan's fit and transition with the excluded page
count, bytes transferred in the last 24 hours, the forecast fit for the
assigned playlist revision, and, while the plan does not fit, a `shortfall`
line with the bytes needed versus capacity. A report older than 24 hours is
marked `(stale)`; a screen that has never reported storage prints no
storage block. In JSON mode the fields pass through as `storage`,
`storage_forecast`, and `storage_shortfall`. The report describes the
player's last observed state; it is never a credential and never authorizes
anything.

`screen storage-forecast <id> --playlist-id pl_PLAYLIST [--playlist-rev N]`
answers whether one playlist would fit the named screen's last reported
storage *before* it is assigned. It is a read-only dry run: it writes nothing
(no assignment, no screen revision, no event) and leaves the screen's stored
forecast untouched. The answer uses the same target selection as the forecast
in `screen show` — the screen's last reported capacity, no transition
prediction, nothing treated as local — and prints it as a `Storage forecast`
block: fit, excluded page count, bytes required versus capacity in binary
units, the basis, and when the storage report was received; a report older
than 24 hours is marked `(stale)` but is still forecast from. `fit` is
`unknown` when the screen has never reported storage or the playlist's
content references are not ready, and the byte counts and report time are
null then. `--playlist-rev` refuses a playlist that changed since you read it
with `revision_conflict` (exit 6); a screen or playlist of another project is
`not_found` (exit 4), and rate limits are `rate_limited` (exit 7). JSON mode
returns the server response as `data` unchanged.

## Application command results

`app upload` and `app update` return the same JSON data paths with or without
`--no-wait`: `data.application` contains the accepted application `id`,
`release_id`, and `operation_id`; `data.pack` contains `sha256` and `file_count`.
The accepted response does not include an application revision. Updates need no prior read. For an optional revision guard, read `app show` and pass `--expect-rev`.

`data.operation` contains the observed completed operation when waiting. With
`--no-wait` it is `null`: upload acceptance does not establish operation state
or release readiness. Use `operations show <operation_id>` or
`operations wait <operation_id>` to observe processing. The envelope's
`operation_id` identifies that same operation in either mode. Existing flat
accepted fields (`data.id`, `data.release_id`, `data.operation_id`) and
`data.sha256` remain available as compatibility aliases in both modes.

## Configuration

### Nonblocking agent connection

`screenrig agent connect --print-url` starts or resumes a connection,
reads one server status snapshot, and returns a JSON envelope. While approval is
pending, `data.status` is `pending`, `data.request_submitted` is `true`,
`data.connection_complete` is `false`, `data.approval_url` contains the dashboard
handoff, and `data.next.command` identifies the resume command. `data.next.argv`
supplies its arguments, preserving the selected config and API origin. Open the handoff
for the intended user, then run `screenrig agent connect` again. An
approved connection completes credential collection and activation and returns
`data.status: active` and `data.connection_complete: true`. No credential is included in either result.

Without `--print-url`, the CLI tries to open the browser and includes the handoff
URL in the pending result only if opening fails. The default (also `--no-wait`)
reads a status snapshot for at most one second. If none arrives, the request
remains resumable and `data.status_checked` is `false`; this does not assert
that the server still awaits approval. A received pending snapshot sets it to
`true`. Success with pending status means submission succeeded, not connection
completion.

Use `agent connect --wait` to wait for approval for up to 30 seconds, or
`agent connect --wait --timeout 10000` for an explicit budget in milliseconds
(1–86400000). Reaching the wait budget returns a resumable pending result.
Without `--wait`, `--timeout` can shorten but never extend the one-second
snapshot budget. Approval requests expire after 24 hours. Terminal denial,
cancellation, and expiry remain errors.

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
refusals still require reconciliation; explicit revision checks remain in force.

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
screenrig playlist init med_POSTER med_VIDEO --name "Lobby loop" --screen-id scr_LOBBY --output lobby.json
screenrig playlist preview lobby.json --output preview --contact-sheet
screenrig screen publish scr_LOBBY lobby.json
```

Inspect the document and preview before publishing. `playlist init` accepts ordered
local image/video/audio files, ready `med_` IDs, pinned `rel_` application releases, and
HTTPS iframe URLs, including mixed inputs:

```sh
screenrig playlist init ./poster.png med_VIDEO rel_APP https://example.com --name Lobby --screen-id scr_LOBBY --output lobby.json
```

Files use the normal media upload/transcode path and wait for readiness; ffmpeg
and ffprobe are required unless `--no-transcode` is used. Preparation uploads
files but does not create a remote playlist or assign a screen. Existing media
must be ready. Release availability and iframe embedding support still need
preview/server and Player verification. Preparation does not fetch iframe URLs.
Each file occurrence has a distinct upload key derived from the invocation's
idempotency key and its input position. For retryable preparation, supply
`--idempotency-key` from the first attempt and reuse it with identical inputs in
the same order, within the server's replay window. Declarations and commits then
reuse their respective per-file keys. Without an explicit key, a new invocation
gets new upload keys. If preparation fails after an upload, that media remains in
the project; inspect `media list` and reuse its ID instead of uploading it again.

The canonical document contains one full-screen page per input, a black background,
and a 200 ms crossfade. Images use `--fit contain|cover|fill` (default `contain`);
videos are muted, do not loop, and advance on completion. Other pages advance after
`--duration-ms` (default 8000). Applications and iframes use `fill`; applications
are pinned to the supplied release and use timed advancement, without controller
privileges. Edit the document for application-controlled advancement.

### Soundtrack

Audio inputs do not become pages. They become the playlist soundtrack: an
ordered list of MP3 tracks that plays continuously while pages change, looping
by default. `media upload` sends an MP3 unchanged and converts WAV, AAC/M4A,
OGG, and FLAC to a 192 kb/s MP3 first (ffmpeg with libmp3lame). Tracks run 1
second to 4 hours.

```sh
screenrig playlist init ./poster.png ./menu.mp4 ./lobby-loop.wav --name Lobby --screen-id scr_LOBBY --output lobby.json
screenrig media list --primitive audio
```

The document gains a top-level `audio` object; a page may add an optional
`audio_cue` hint that jumps to a named track when that page appears:

```json
{
  "name": "Lobby",
  "audio": { "tracks": [{ "id": "intro", "media_id": "med_SONG" }, { "id": "bed", "media_id": "med_BED" }], "loop": true, "volume": 0.8 },
  "pages": [{ "id": "welcome", "audio_cue": { "track": "intro", "restart": true }, "...": "..." }]
}
```

`playlist update` replaces the whole document, so omitting `audio` removes the
soundtrack. `playlist show --editable`, `playlist export`, and `playlist import`
keep the soundtrack, its cues, and its audio files.

With `--screen-id`, the result includes `screen_id`, `screen_revision`, and a
`publish.argv` array containing the output path and optional revision guard. It also
returns `preview.argv`. These arrays preserve the selected config/API and paths
with spaces; execute preview, inspect it, then use the publish arguments. Add `--expect-rev` explicitly to guard against later screen changes. Target metadata stays outside
the playlist file. Override canvas dimensions with both `--target-width` and
`--target-height`; these also work without `--screen-id` (no publish arguments).
Unknown or multiple reported surfaces require explicit dimensions. Output files are exclusive by default; use `--overwrite` to replace an existing authoring file atomically. Parent directories are created automatically. URL and release-ID inputs with explicit dimensions work without login.

`screen publish <screen-id> <file>` creates a new playlist, assigns it with an optional **screen** revision guard, and reads back the assignment. It does not update an
existing playlist by name. Display names may repeat; use the playlist ID for an explicit `playlist update`. Its JSON result reports `playlist_id`,
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
screenrig playlist update pl_EXISTING lobby.json
```

`playlist show --output` writes the editable `{name, pages}` document and returns
its path, `playlist_id`, and source `revision` on stdout. Optionally pass that revision with `--expect-rev` to guard the update. It preserves dynamic selectors, schedules, motion, and pinned
application releases, removing server-derived media and timing fields. Comments
remain separate. Plain `playlist show` is an inspection response; `--editable`
without `--output` returns `data.document`, `data.playlist_id`, and `data.revision`.
Updating a playlist affects every screen assigned to it.

After `app update` succeeds, take `data.application.release_id` and preview a
replacement of one explicitly identified application primitive:

```sh
screenrig playlist replace-release pl_EXISTING --page board-page --primitive board --release-id rel_NEW
```

Review `data.previous_release_id`, `data.release_id`, and `data.affected_screens`
(including archived assignments). Then use the returned `data.impact` to apply that exact replacement:

```sh
screenrig playlist replace-release pl_EXISTING --page board-page --primitive board --release-id rel_NEW --apply
```

The CLI preserves the other primitives and playlist settings. Every screen
assigned to this shared playlist receives the new pin; archived screens retain
it for later use. A changed replacement, playlist revision, or observed screen
impact requires a fresh preview and review. Screen assignments can change after
the snapshot; the server checks the playlist revision atomically only when `--expect-rev` is supplied. Release
availability and ownership are validated by the server on apply. After writing,
verify screen manifest revisions and playback. Existing pins stay unchanged
until the replacement is applied.

Playlist validate, create, update, preview, and screen publish accept `-` as their
input file to read stdin. JSON envelopes are never written into authored files.
`--expect-rev` is the preferred revision spelling; `--if-match` remains a compatible
alias. Supply only one. Omit the flag to write the current resource without a revision precondition. A supplied stale revision still returns `revision_conflict`.

Generation accepts either `--prompt TEXT` or `--prompt-file FILE`, including
`--prompt-file -` for stdin. The file is the complete prompt, with no trimming;
the existing 4000-character limit applies. Prompts are excluded from diagnostics.
