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

## Playlist schedules and takeover

The server decides what each screen plays, in this order: its takeover, else
the first playlist schedule entry whose windows match the screen's civil time,
else the playlist assigned with `screen assign`. `screen show`, `screen list`,
and the write commands below return `effective_playlist`
(`{id, source: takeover|schedule|default, entry_id?, until?}`), `takeover`,
and `playlist_schedule`. `until` is the next moment the choice is known to
change. `screen show --human` prints it in the screen's timezone, as in
`Playing: pl_LUNCH (schedule entry lunch until 2026-08-14 15:00 America/Los_Angeles)`
(UTC, labelled, when the screen has no zone). Schedule tables are labelled with
the screen timezone, and JSON output keeps RFC 3339 instants.
`screen list --human` adds a `PLAYING` column when any listed screen is on a
takeover or schedule entry. Switches land within about a minute of a boundary;
Players need no update.

```sh
screenrig screen schedule show scr_CAFE
screenrig screen schedule set scr_CAFE --file dayparts.json [--expect-rev REVISION]
screenrig screen schedule set --tag Cafe --file dayparts.json
screenrig screen schedule clear scr_CAFE [--expect-rev REVISION]
screenrig screen schedule clear --tag Cafe
screenrig screen takeover scr_LOBBY --playlist-id pl_DRILL --for 30m --reason "Fire drill"
screenrig screen takeover --tag Lobby --playlist-id pl_LAUNCH --until 2026-10-01T18:00:00Z
screenrig screen takeover scr_A scr_B --playlist-id pl_NOTICE --until none
screenrig screen takeover clear --tag Lobby
```

A schedule file lists 1 to 32 entries in priority order; the first entry that
matches wins. Each entry has 1 to 16 windows in the screen timezone. `days` uses
`mon` to `sun`, and `start`/`end` are `HH:MM`. Omit both for the whole day. An
`end` at or before `start` crosses midnight and belongs to the start day.
Optional `from` (inclusive) and `until` (exclusive) are civil minutes such as
`2026-12-24T18:00`, with no offset. An omitted `id` becomes `entry_N`. The CLI
checks this shape before sending anything. It also accepts the JSON output of
`screen schedule show` back unchanged. Breakfast, lunch, and dinner dayparts:

```json
{
  "entries": [
    { "id": "breakfast", "playlist_id": "pl_BREAKFAST",
      "windows": [{ "days": ["mon", "tue", "wed", "thu", "fri"], "start": "06:00", "end": "11:00" },
                  { "days": ["sat", "sun"], "start": "08:00", "end": "12:00" }] },
    { "id": "lunch", "playlist_id": "pl_LUNCH",
      "windows": [{ "days": ["mon", "tue", "wed", "thu", "fri"], "start": "11:00", "end": "15:00" }] },
    { "id": "dinner", "playlist_id": "pl_DINNER",
      "windows": [{ "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], "start": "17:00", "end": "22:00" }] }
  ]
}
```

Outside every window the assigned playlist plays. Schedule and takeover writes
need an assigned default playlist, because the screen falls back to it. A screen
without one gets `invalid_request` (exit 8), and `next` points at
`screen assign ID --playlist-id PLAYLIST_ID`. A schedule also needs the screen
timezone. Without one the write is `invalid_request` (exit 8), and `next` points
at `screen set-timezone`. If a scheduled playlist later cannot be shown, its
entries are skipped and `screen.playlist_unavailable` is recorded. A takeover
whose playlist cannot be shown ends. These writes share per-minute limits:
600 per project, 20 per screen, and 60 per IP (`rate_limited`, exit 7, with
`retry_after_seconds`). Every playlist a schedule or takeover names is
validated as an assignment. An archived screen answers `screen_archived`
(exit 5, `next` is `screen unarchive`).

A takeover shows one playlist ahead of the schedule and the assignment.
`--until` takes an RFC 3339 instant with seconds and an offset, such as
`2026-10-01T18:00:00Z` or `2026-10-01T11:00:00-07:00` (uppercase `T` and `Z`).
It is sent normalized to UTC and must be strictly in the future and at most 7
days ahead. `--for 30m|2h|3d` is converted to an `until` from this computer's
clock. It accepts up to 7 days, at most `6d23h59m`, which leaves a minute for
clock differences. If the server still refuses the result, `next` suggests a
shorter `--for`. `--until none`, or neither flag, holds the takeover until
`screen takeover clear`. `--reason` is trimmed, at most 120 characters, and may
not contain control characters. A new takeover replaces the previous
one. `screen takeover ID` is short for `screen takeover set ID`.

With one screen id, `schedule set`, `schedule clear`, `takeover`, and
`takeover clear` use the single-screen routes and return the updated screen.
`--expect-rev` guards its revision (`revision_conflict`, exit 6). Several ids
or `--tag` become one `POST /api/v1/screens/actions` request
(`set_playlist_schedule`, `clear_playlist_schedule`, `takeover`,
`takeover_clear`) with the fleet envelope and exit rules described above. Each
screen fails alone; for example, a screen with no timezone or no default
playlist fails with `invalid_request`. The whole fan-out is refused with
`rate_limited` when it exceeds what remains of the project budget. A `--for` rerun after an ambiguous failure computes a new end and is
sent as a new request.

Deleting a playlist that a live screen can still show fails with
`resource_conflict` (exit 5). A screen can still show it if the playlist is
assigned, named by a schedule entry, held by a takeover, or effective. `next`
points at `screen list`, and `screen show ID` shows the screen's reference. `events list` and
`events follow` print `screen.playlist_switched` (`playlist_id`,
`previous_playlist_id`, `source`, `entry_id`, `until`),
`screen.takeover_started` (`playlist_id`, `until`, where `none` means held until
cleared, and `reason`), and `screen.takeover_ended` (`reason`
`expired|cleared|replaced|playlist_deleted|playlist_unavailable`), and the warning
`screen.playlist_unavailable` (`playlist_id`, `entry_ids` comma-joined, and `code`
`playlist_deleted|playlist_unavailable`).

## Webhooks

A webhook POSTs this project's own durable events to an HTTPS endpoint you
run. A project has at most 10.

```sh
screenrig webhooks create --url https://hooks.example.com/screenrig --event-types "screen.*,playlist.updated" [--description TEXT] [--disabled]
screenrig webhooks list
screenrig webhooks show whk_WEBHOOK
screenrig webhooks update whk_WEBHOOK [--url URL] [--event-types TYPES] [--description TEXT | --clear-description] [--enable | --disable] [--expect-rev REVISION]
screenrig webhooks delete whk_WEBHOOK [--expect-rev REVISION]
screenrig webhooks rotate-secret whk_WEBHOOK [--expect-rev REVISION]
screenrig webhooks test whk_WEBHOOK
screenrig webhooks deliveries whk_WEBHOOK [--before CURSOR] [--limit N]
```

`--url` must be `https` on port 443 (the default) or 8443, and its host must
resolve only to public Internet addresses. The server checks it on every write
and again before every delivery. A refusal is `webhook_url_rejected` (exit 8)
with the server's reason in `error.detail`, for example
`The webhook URL was rejected: url port must be 443 (the default) or 8443.`
An eleventh webhook is `webhook_limit_reached` (exit 5); delete one first.
`--event-types` takes 1 to 32 exact types (`screen.online`) or prefixes ending
in `.*` (`screen.*`), comma-separated.

`create` and `rotate-secret` return the webhook with its signing secret in
`data.secret`, plus warning `webhook_secret_shown_once`. Store the secret
right away. No other command returns it, and the CLI never writes it to its
config, operation log, or write-recovery state. After an interrupted or
ambiguous create or rotation, rerun the identical command within 24 hours. It
reuses the saved Idempotency-Key and the server replays the same answer,
secret included. After a rotation, at most one attempt that was already in
flight can still arrive signed with the old secret, so accept both for a short
while.

`update` changes only the fields you pass. `--enable` clears the failure state
and starts delivery at the current event. Events from while the webhook was
disabled are not replayed. `--disable` and `delete` fail pending deliveries.
`test` queues one `webhook.test` delivery to that webhook only. It is attempted
once, without retries, at most 20 per minute per project (`rate_limited`,
exit 7). `deliveries` lists one row per event, newest first, with `state`,
`attempts`, `last_status`, and a fixed `last_error` class. Pass
`data.next_cursor` back as `--before` for the next page. A failed attempt is
retried with backoff for 24 hours. After 72 hours of continuous failure the
webhook is disabled (`status: disabled`, `disabled_reason: delivery_failures`).

### Verify a delivery

The body is the same JSON event object `events list` returns. The headers are
`ScreenRig-Webhook-Id`, `ScreenRig-Event-Id` (stable across retries), and
`ScreenRig-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is HMAC-SHA256
over `"<t>.<raw body>"` keyed with the secret string. Compute it over the raw
bytes before parsing JSON, compare in constant time, reject an old `t`, and
deduplicate on `ScreenRig-Event-Id`, because delivery is at least once and
unordered. Answer 2xx within 10 seconds.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// rawBody: the request body bytes (Buffer) exactly as received.
function verify(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (typeof signatureHeader !== "string" || !signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map((part) => part.split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const given = Buffer.from(parts.v1 ?? "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

## Playback export

`playback plays` reads one row per visible start of an image or video,
oldest first by `received_at`. `playback list` reads the daily aggregates
(one row per screen, media, and UTC day).

```sh
screenrig playback plays [--from TIME] [--to TIME] [--screen-id ID] [--media-id ID] [--tag TAG] [--cursor CURSOR] [--limit N] [--all]
screenrig playback plays --format csv [--output FILE] [--from TIME] [--to TIME] [--screen-id ID] [--media-id ID] [--tag TAG]
screenrig playback list [--screen-id ID] [--media-id ID] [--day YYYY-MM-DD | --day-from YYYY-MM-DD --day-to YYYY-MM-DD] [--format csv] [--output FILE]
```

`--from` (inclusive) and `--to` (exclusive) bound `received_at`. Each takes an
RFC 3339 instant with seconds and an offset (`2026-09-01T00:00:00Z`,
`2026-09-01T00:00:00-07:00`), `now`, or an age before now (`7d`, `12h`, `30m`).
The CLI normalizes both to UTC, defaults to the 24 hours up to now, refuses a
range longer than 31 days, and sends the resolved bounds (echoed as `data.from`
and `data.to`) on every request. `--tag` matches a tag the screen carried when
the play was received. The newest 5 seconds are held back until they settle,
so a play appears about 5 seconds after it is received; `data.to` reports that
effective end (at most 5 seconds before now), and `data.next` keeps it.

JSON returns one page in `data.items` (server default 200 rows, `--limit` up
to 1000) with `data.next_cursor`. Pass it back with `--cursor` and the same
filters; `data.next.argv` is that exact command. `--all` follows the cursor to
the end of the range, 1000 rows per page unless `--limit` says otherwise, for
at most 50 pages. It stops early, with `data.next` and a warning, at the page
cap (`playback_plays_truncated`) or when the playback export budget is spent
(`playback_export_rate_limited`), rather than spending requests into a refusal.

`--format csv` streams the whole range as RFC 4180 CSV with a fixed header
row. The CLI writes it to `--output FILE` (default `./playback-plays.csv`, or
`./playback-aggregates.csv` for `playback list`) through a private temporary
file in the same directory, and replaces an existing `FILE` only after the
stream ends cleanly. `--timeout` is the no-progress limit for the stream
(default 60000 ms without a byte), not a limit on its total duration. The envelope reports
`path`, `bytes`, `rows`, `sha256`, and, for plays, `last_received_at`; the CSV
itself never enters the envelope. `--output -` writes only the CSV to stdout.
`primitive_id` and `started_at` cells are empty unless the Player reported
them. A cell that begins with `=`, `+`, `-`, `@`, tab, or carriage return
carries a leading `'` so spreadsheets do not evaluate it.

If a stream fails partway, the command exits non-zero and never writes the
target file. For plays, the complete rows already received stay in
`FILE.partial` (`FILE.partial-2` and so on if that exists), and `error.next`
exports the rest of the range from the last `received_at` into an unused
`FILE-rest.csv`; rows received at that exact instant appear in
both, so drop the repeats when joining them. A failed aggregates export keeps
nothing; rerun it.

`playback list` takes `--day` for one UTC day, or `--day-from` and `--day-to`
for an inclusive range of at most 366 days. With `--format csv` and no range it
exports the 31 days up to today.

Billing and limits: each JSON page is one billed API request, so `--all` bills
one request per page. A CSV export is one billed request for the whole range.
Every plays request and every CSV export also spends the playback export budget
of 30 requests per minute per project; past it the answer is `rate_limited`
(exit 7) with `retry_after_seconds`.

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

## Device health

Every paired Player reports device health on session start and every five
minutes. `screen show` returns it as `data.health` with the server's
`reported_at`; `stale` turns true after 15 minutes without a report, and the
last report stays visible. With `--human` it prints a `Health` block: report
time, device and Player uptime, memory in use, CPU load and cores,
temperature, display connection and power, network kind and Wi-Fi signal, and
crashes and renderer restarts in the last 24 hours.

`screen list --human` adds a `HEALTH` column when any listed screen needs
attention: `display disconnected`, `hot` (80 °C or more), `crashing` (3 or more
crashes in 24 hours), or `stale`. Transitions arrive as `screen.health_changed`
events, which `events list` and `events follow` print with a compact
`changes=` value such as
`display_disconnected,temperature_high temperature_c=82`.

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
writes, webhook writes, feedback submissions, and operation cancellation persist
an idempotency key before sending the request. After an ambiguous network failure or server
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
