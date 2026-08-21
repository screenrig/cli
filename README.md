# ScreenRig CLI

This repository implements the noninteractive ScreenRig control-plane CLI and
deterministic web-application package packer. The supported customer
distribution is the exact CI artifact pinned and bundled by
[`screenrig/plugin`](https://github.com/screenrig/plugin); the plugin invokes it
through a package-relative launcher.

## Implemented behavior

The CLI emits machine-readable envelopes and automatically enrolls on the first
authenticated operation. It atomically persists enrollment retry state before
the request, stores the issued credential in user-private configuration outside
the replaceable plugin directory, verifies it, and resumes the original
command.

If the server asks for a beta key, pass `--beta-key` with the key the operator
gave you, or set `SCREENRIG_BETA_KEY`. The CLI sends that value as `beta_key`
on `POST /api/v1/enrollments` and omits the field when it is unset.

```sh
screenrig --json --beta-key screenrig-beta-program account show
```

`auth revoke --yes` revokes the calling credential on the server before
removing local credential, enrollment, and transient authenticated-operation
state. A failed or ambiguous server result retains local state for an exact
retry.

`compose catalog` and `compose render` run locally. They do not enroll. They
do not debit credits. `compose render` reads a JSON spec, writes a PNG, and
writes `<output>.layout.json` next to it. The envelope carries paths, canvas
size, the resolved font family, space tokens, the type ramp, and whether any
text was truncated. It never prints image bytes. `--open` opens the local PNG
with the OS opener when the user asked to view the still on this computer.

ScreenRig content has three families: static images, including stills produced
by local compose; motion video; and web content delivered as an `iframe` or
`application`.

Playlist pages on the wire use `image`, `video`, `iframe`, and `application`
only. Copy and chrome are composed locally, uploaded as `image`, then placed
as one image. `playlist templates` is a local catalog of slide ids; templates
that would emit native `text`, `box`, or `line` fail with a pointer at
`compose catalog` and `compose render`. Picture-only templates still expand
to image or video placements with selectors. A page without `template` is
forwarded unchanged when its placements are those wire kinds.
`canvas.background` is a solid uppercase `#RRGGBBAA` or a top-to-bottom
linear gradient (`type` `linear`, 2 through 8 strictly increasing stops,
first `at` 0, last `at` 1, no angle). Image and video placements write a
`selector` (`by` is `id`, `ids`, `all`, or `tag`). Do not put `media_id` on
the content object, and do not send server-resolved `items`. Page advance
uses `duration`, `application`, or `media_end`. There is no `video_end`
mode.

Default pages use `{ "type": "crossfade", "duration_ms": 200 }` and put no
`enter` on placements. `transition.type` may also be `swipe-left`,
`swipe-right`, `swipe-up`, or `swipe-down`. `duration_ms` is required and
runs from 0 through 60000. When a swipe type is chosen, write
`duration_ms: 600`. That is the authoring default for swipe, not a schema
default, and it does not change the template default. Swipe is the incoming
page's type. The outgoing page follows so the edges stay touching. The name
is motion direction: `swipe-left` moves content left.

Optional placement `enter` is `{ "type": "..." }` with that same object
name on playlist JSON. There is no snake_case rename inside it. Types are
`fade-up`, `fade-down`, `fade-left`, `fade-right`, `fade-in`, `zoom-in`,
and `zoom-out`. Absent means no object animation. Use swipe and `enter`
sparingly, for emphasis or a particular style, not on every page. If you
want object animation, layer the content and put the motion on the
top-layer text or images. Do not animate every placement. Object enter
starts invisible. It runs 500 ms after the page occupies the full
viewport, for 400 ms. Those delays are contract constants, not author
fields and not CLI flags. These are playlist document fields the CLI
sends. The control plane accepts swipe types and placement `enter`.
Canonical CLI source on public `main` is repository-ready. They are not
in the locked plugin bundle.

The ordinary pair command currently accepts six canonical characters:

```sh
screenrig --json screen pair ABC234
```

Native player pairing codes last 72 hours while unclaimed. A successful claim
starts a fresh independent 72-hour collection window. `screen pair` claims the
code on the control plane; the CLI does not time the code locally.

The separate homepage handoff command accepts either `ABC-234` or `ABC234`,
normalizes it, and returns only safe status fields:

```sh
screenrig --json browser setup --code ABC-234
```

Browser handoff has a backend-owned 30-minute unclaimed window and a fresh
10-minute protected delivery window after claim. The CLI never receives or
prints the browser cookie, provisioning token, continuation redirect, native
pairing or session credentials, or identity material.

`screen archive` hides a screen and darkens live glass. It does not unbind
the player. `screen list` omits archived rows; `screen list --state archived`
lists them. `screen show` still returns an archived row. `screen unarchive`
restores the screen if admission passes. `screen delete` is not a
de-associate; the server returns `screen_archive_required`.
`screen revoke-credential` is retired. Native players use generate-once
Ed25519 identity with `ScreenRig-Pairing` and `ScreenRig-Session`;
`ScreenRig-Device` is retired. Signed on-device reset is the only
de-associate. The CLI is not a screen and holds no player keypair. `screen
archive` and `screen unarchive` are repository-ready on public `main`. They are
absent from the locked plugin bundle. Native identity remains an owning-player
claim; none of this is a marketplace, deployed, or hardware-validated claim.

Application packing accepts an already-built static directory. It produces
deterministic bounded archives, injects the pinned browser SDK runtime, and
never builds or executes uploaded source. `app upload` accepts optional
`--name` (at most 120 characters) as the application name header. Runtime
pages use `screenrig.canvas/v1`; protected content and
`screenrig.webapp-package/v1` delivery are backend/player concerns. `screen
screenshot <id>` requests one still WebP of an active screen, waits until it
is ready, and writes a file. It does not print image bytes.

`comment show`, `comment set`, and `comment delete` store an opaque JSON
object on a screen, a playlist, or one playlist page. Compact UTF-8 of that
object is at most 1 KiB. ScreenRig does not read or use it, does not send it
to players, and does not treat it as authorization. Set takes `--json-value`
or `--file`. Last write wins; there is no `--if-match`. These commands are
repository-ready on public `main`. They are absent from the locked plugin
bundle and are not a marketplace or deployed claim.

`playback list` returns daily playback aggregates for this account, newest
days first. Filter with `--screen-id`, `--media-id`, and `--day YYYY-MM-DD`.
Those identifiers select the caller's own rows and are never a cross-account
lookup.

Authenticated responses may carry remaining prepaid credits as an integer.
Remaining below 1000 credits adds a `credits_low` warning to the envelope
`warnings[]` array; the message includes the integer remaining. A 402
`payment_required` problem means remaining is below 1 credit and billed
control-plane commands are rejected. Both signals can appear together on a
402 envelope. `account show`, `auth revoke --yes`, `screen toast`,
`screen screenshot`, `compose catalog`, and `compose render` do not debit
that meter. Opening `events follow` costs 1 credit. There is no pay command.

## Account dashboard

`dashboard` mints one single-use link to the account dashboard and hands it to
the browser:

```sh
screenrig dashboard
```

The link is single use and stops being claimable ten minutes after it is
minted. That clock belongs to the dashboard link alone: it is not the
30-minute public handoff locator, not the 10-minute protected provisioning
delivery window, and not the 72-hour native pairing clocks. A fresh link is one
more `screenrig dashboard` away, so let one expire rather than keeping it.

The token rides the URL fragment. No server sees a fragment, no access log
records one, and no `Referer` header carries one, so **the whole URL is a
credential**. The CLI opens it and prints nothing. The URL reaches stdout as
one line in exactly two cases: the opener could not start a browser, or you
asked for it with `--print-url` because your shell is not on the machine with
the browser. Treat that line the way you would treat a password. The CLI never
writes the link to a file, never keeps it in configuration, and cannot show it
again.

```sh
screenrig --json dashboard --print-url
```

The command mints; it never claims. Claiming happens in the browser on the
dashboard origin, so the CLI never presents a link token and never sees
`dashboard_link_expired` or `dashboard_link_consumed`. What the mint call can
return is `invalid_request`, `unauthorized`, `payment_required`,
`rate_limited`, and `not_ready`; the CLI renders each with the server's own
detail and guidance.

Minting is an authenticated control-plane request and debits 1 credit. Retrying
is safe: the request carries `Idempotency-Key`, and an exact retry returns the
original link and expiry for twenty-four hours instead of minting a second live
link.

This command is **repository-ready on public `main`**. It is absent from the
locked plugin bundle. The dashboard origin is not deployed: no request has
been served there, so a minted link does not resolve yet. Do not read this
section as a working dashboard.

## Feedback

Bug reports and feature requests are account-scoped and immutable:

```sh
screenrig --json feedback bug "Playlist stalls after pairing" \
  --body-file ./report.md --command "screen pair"
screenrig --json feedback feature "Add a dry-run flag" --body "Preview a change first."
screenrig --json feedback list --kind bug
```

The kind comes from the CLI action, which selects the route; nothing in the
request body carries it. A submission cannot be updated or deleted, so the CLI
exposes no such command — a correction is a new submission. The ordinary
idempotency key makes an exact retry safe: the server returns the original
submission for twenty-four hours instead of storing a duplicate. `feedback list`
without `--kind` merges both routes newest-first.

`--body` takes inline text and `--body-file` reads a file, which suits a
multi-line report. A title is at most 120 characters and a body at most 4000.

Each submission carries a closed diagnostic envelope holding the CLI version and
the `os/arch` platform. `--no-context` omits it entirely. `--command` adds the
command the feedback is about, and it accepts a command path only, as up to four
lowercase words such as `media upload`. That value is never taken from the
command line you actually ran: it comes from this flag alone, and the CLI
validates it against the contract pattern exactly as supplied, so a flag, a file
path, an identifier, or an argument value is rejected before any request is
sent. The server independently rejects an unknown member of the envelope.

The server rejects, rather than redacts, text matching a ScreenRig credential
shape. The CLI does not scrub your text first; it renders the server's problem
and its field-level guidance so you can rewrite the submission and resend.

Submissions are rate limited per account. A `429` is reported with the code
`rate_limited`, exit code 7, `retry_after_seconds` in the envelope, and
next-action guidance naming the wait, rather than as a bare status.

`screenrig doctor` reports a `feedback` check from the server's advertised
capability map, so support is probed rather than assumed.

## Page scheduling and the screen timezone

A playlist page may carry an optional `visibility` object that limits when the
page plays. The rule is civil, so it is read in the screen's own time zone.

```sh
screenrig --json screen set-timezone scr_01 --timezone America/Los_Angeles --if-match 3
```

`--timezone` takes an IANA identifier. The server validates it against an
embedded zone database, so the CLI forwards the value unchanged rather than
carrying a list that can go stale. A screen has no time zone until one is set,
and a patch never clears one. `screen update` accepts the same `--timezone`.

Two rules decide whether a playlist is accepted:

- **Every playlist keeps at least one page with no `visibility` field at all.**
  A page whose only rule is `enabled: false` does not satisfy this, and the
  server rejects a playlist that fails it. That page is what guarantees a screen
  always has something eligible to show.
- **A screen running a scheduled playlist must have a time zone.** `screen
  assign`, `screen update --playlist-id`, and `playlist update` check this
  before they send anything, and name the screen and the command that fixes it.
  Set the zone first, then assign.

## Screen toast

A toast is transient stage chrome on one screen, not a placement. It occupies
no canvas slot, has no layer, and never participates in readiness or
crossfade. Latest-wins: there is no queue and the CLI exposes no cancel
command. Level colours are player chrome and are not API fields.

```sh
screenrig --json screen toast scr_01 --text "Lobby closed"
screenrig --json screen toast scr_01 --level info --text "Lobby closed"
screenrig --json screen toast scr_01 --level alert --text "Doors locked" --duration-ms 5000
```

`--level` defaults to `info` when omitted. Agent toasts are info. Info stream
toasts are admitted in production. `error` and `alert` remain accepted.
`--text` is 1 to 120 characters, accepts line feed as the only line break, and
allows at most three lines. `--duration-ms` is optional, defaults to 10000 on
the server, and must be between 2000 and 60000 inclusive when supplied.

The write is idempotent. An exact retry under the same `--idempotency-key`
returns the original `expires_at` for twenty-four hours. Runtime scan never
delivers a toast after that instant, so a persisted cursor cannot replay it.

The accepted envelope is `{ expires_at }` only. The CLI does not scrub toast
text; the server rejects recognizable ScreenRig credential material and other
control characters. Do not put credentials, cookies, Authorization headers,
completion nonces, signed URLs, or object keys in the text.

## Screen screenshot

`screen screenshot <id>` requests one still WebP of an active screen. It
blocks until the image is on disk. There is no `--no-wait`. Latest-wins: a
later request replaces the in-flight `capture_id`.

```sh
screenrig --json screen screenshot scr_01
screenrig --json screen screenshot scr_01 --output ./lobby.webp
```

`<id>` must match `scr_` plus URL-safe characters. `--output` is a file path,
not a directory. The default is `./<id>.webp` in the current working
directory. An existing file is overwritten without a prompt. `--timeout`
defaults to 35000 ms and `--poll-ms` defaults to 500 ms.

The success envelope is `screen_id`, `capture_id`, `path`, `bytes`, `sha256`,
`width`, and `height` only. A matching `timed_out` status or a wait deadline
is `screenshot_unavailable`. A later `capture_id` is `resource_conflict`. The
CLI never prints image bytes, hex, or base64.

## Local compose

Compose a still on this machine, look at the PNG, then upload it as media.

```sh
screenrig --json compose catalog
screenrig --json compose render ./spec.json --output ./still.png
screenrig --json media upload ./still.png
```

The spec is a fail-closed tree of `Frame`, `Column`, `Row`, `Box`, `Spacer`,
`Text`, and `Image`. Roles are `display`, `title`, `body`, `caption`, and
`label`. Spacing tokens are `xs`, `s`, `m`, `l`, and `xl`. Pins are `top`,
`bottom`, `left`, and `right`. Do not author `x` or `y` on any node. The root
`Frame` defines the canvas through required `width` and `height`. Do not author
`fontSize`. The current source accepts positive `width` and `height` values in
px on `Image`, `Box`, `Row`, `Column`, and `Spacer`. This implemented behavior
is not in the locked plugin bundle. Keep `flex` for remaining space.
`pin` `top` or `bottom` stretches the full width; `left` or `right` stretches
the full height. Size a wordmark with `width` and `height`, not `pin`.
Optional Text `textShadow` is
`{ "x": 2, "y": 2, "blur": 4, "color": "#00000080" }`; omit it to paint
without a shadow. `Image.src` is a local filesystem path
relative to the spec file. The CLI does not fetch URLs.

`--open` is only for viewing the still on this computer. Agent vision reads
the file path. Do not cat pixels into chat.

A playlist page for that still is one `image` placement whose `rect` is the
canvas and whose `content_fit` is `fill`.

## Events

`events list` reads one finite page. `events follow` stays on the stream.
A disconnect or transient connect failure reconnects with exponential
backoff and resumes from the last SSE id. `--timeout` covers the whole
follow, including backoff. Human mode prints one logfmt line per event.
`--json events list` prints one JSON page envelope. `--json events follow`
prints one JSON envelope per event as it arrives.

```sh
screenrig events list
screenrig --json events list --after ev1_0 --limit 25
screenrig events follow
screenrig --json events follow --after ev1_0
screenrig --json playback list --screen-id scr_01 --day 2026-08-14
```

A human line looks like
`at=2026-08-14T17:00:00.000Z type=application.event severity=info code=cta.pressed placement_id=weather`.
It carries `at`, `type`, `severity`, optional resource fields, scalar
details, and a non-canned `message`. Canned server sentences are omitted. An
`application.event` or `runtime.reported` with no remaining data is silent. A
page or stream with nothing to print writes no human output. `--json` is a
JSON envelope or stream. After redaction it may still include a server
`message` field when that field is data.

## Media transcoding

`media upload` transcodes the source by default before it declares the upload,
so the control plane receives delivery-ready bytes on that path. **ffmpeg and
ffprobe are external dependencies only for default transcoding.**
`--no-transcode` uploads the source unchanged and bypasses both tools. The CLI
does not bundle them. It runs `ffmpeg` and `ffprobe` from `PATH`, or from the absolute
paths in `SCREENRIG_FFMPEG` and `SCREENRIG_FFPROBE` when those variables are
set. Image encode prefers ffmpeg `libwebp` / `libwebp_anim`. If those encoders
are missing, the CLI falls back to `cwebp` on `PATH`, or `SCREENRIG_CWEBP`.
The install hint asks for ffmpeg 6.0 or newer; the CLI reports the resolved
version but does not enforce a minimum. What it does enforce is the presence of
the encoder each profile needs. `screenrig doctor` reports the resolved binaries
and versions, the `libx265`, `libx264`, and `libwebp` encoders, the `cwebp`
fallback, and whether the build carries the `zscale` and `tonemap` filters that
HDR tone mapping needs. `encoder_libwebp` is the ffmpeg encoder only; a fail
there does not mean stills cannot transcode when `cwebp` passes.

The command also checks the filename. A low-information name such as
`video.mp4` or `IMG_1234.jpg` adds an advisory `generic_filename` warning to
the envelope. The upload still succeeds; the warning never changes the exit
code.

Video becomes an MP4:

- H.264 by default (`libx264`, High profile, level 4.2), or H.265 with
  `--codec hevc` (`libx265`, `hvc1` tag, Main profile).
- `-preset fast`, CRF 23 for H.264 and CRF 28 for H.265, `-maxrate 8M`,
  `-bufsize 16M`, 2 B-frames, and a keyframe interval of two seconds.
- `yuv420p`, tagged Rec. 709 with limited range. An HDR source is tone mapped
  to Rec. 709 through `zscale` and `tonemap`. An ffmpeg build without those
  filters converts without tone mapping and the envelope carries a warning.
- Audio, where the source has any, is AAC at 192 kbit/s, 48 kHz, stereo.
  Players play from a complete cached file, so the encode does not remux
  for progressive download.
- The frame rate is capped at 30 fps by default.

Images become lossy WebP at quality 90, in `yuva420p` when the source carries an
alpha channel and `yuv420p` otherwise. An animated source uses `libwebp_anim`
where the build provides it and loops forever. If ffmpeg has no libwebp encoder,
a still is encoded with `cwebp` (`-q 90 -alpha_q 100`, never `-lossless`). A
WebP source that already fits the size bound is passed through unchanged instead
of re-encoded. `--no-transcode` is the escape hatch for already-correct delivery
WebP, not the recovery for a missing libwebp encoder.

Both families bound **each** edge to 3840 pixels, so a portrait source is capped
exactly like a landscape one. Aspect ratio is preserved, and a source smaller
than the bound is never upscaled.

### Why H.264 is the default

ScreenRig stores exactly one rendition per media object, and the layout contract
carries no codec parameter. There is no per-client fallback: whatever the CLI
uploads is what every player has to decode. H.264 High profile level 4.2 is the
default because it has broad decode support across current browser and platform
combinations.

H.265 support is not universal:

- Safari on macOS and iOS plays it.
- Chrome and Edge play it only where the platform offers hardware HEVC decode.
- Firefox support is limited.

A browser that cannot decode the rendition does not fall back to anything, so
`--codec hevc` risks a black or stalled screen. Use it only for a fleet you know
is native-only, meaning the Qt/GStreamer and Android/MediaCodec players. It
does buy a smaller file at the same quality, which matters on a constrained
link, but that saving does not outrank playback on the browser path.

### Flags

| Flag | Effect |
| --- | --- |
| `--no-transcode` | Upload accepted delivery bytes unchanged. ffmpeg, ffprobe, and cwebp are not run; lossless WebP is still rejected. |
| `--codec h264\|hevc` | Video codec. Default `h264`. `avc` and `h265` are accepted as aliases. |
| `--max-fps N` | Frame-rate cap, greater than 0 and at most 240. Default 30. |
| `--max-edge PIXELS` | Bound on each edge, 16 to 3840. Default 3840. |
| `--webp-quality 1-100` | WebP quality. Default 90. |
| `--no-progress` | Emit no progress output. |
| `--tag TAG` | Optional 1–32 letter-or-digit tag stored on the ready object. |

```sh
screenrig --json media upload ./clip.mov
screenrig --json media upload ./clip.mov --codec hevc
screenrig --json media upload ./poster.png --no-transcode
screenrig --json media upload ./lobby-welcome.png --tag lobby
screenrig --json media list --tag lobby --kind image
screenrig --json media update med_01 --tag lobby --if-match 1
screenrig --json media update med_01 --clear-tag --if-match 2
```

`media list` forwards `--tag` and `--kind image|video` as query filters.
Untagged objects are omitted when `--tag` is present. `media update` patches
the tag only; `--clear-tag` sends `null`. There is no other media metadata
patch.

### Progress and the envelope

Progress is written to **stderr only**. Stdout stays reserved for the single
result envelope, so an agent parses stdout without stripping progress noise.
Under `--json` the reporter writes `transcode_start`, `transcode_progress`, and
`transcode_complete` JSON lines to stderr. Otherwise it writes a human bar with
an ETA, redrawn in place on a TTY and throttled when stderr is not a TTY.

The envelope carries a `transcode` block with `applied`, `stage`, `reason`,
`source_bytes`, `output_bytes`, `width`, `height`, `dimensions_measured`, and
`duration_ms`. `width` and `height` are read back from the produced file with a
follow-up probe rather than predicted from the plan, because ffmpeg's rounding
does not match the planner's. If that read-back fails, the CLI reports the
planned size, sets `dimensions_measured` to `false`, and adds a warning instead
of presenting an estimate as a measurement.
`transcode.duration_ms` is the wall-clock encode time in milliseconds, and is
`0` for a passthrough. Under `--no-transcode` the block reduces to `applied`
and `reason`. Warnings such as a missing tone mapping filter appear as
`transcode_warning` entries in the envelope warnings.

When the upload operation succeeds, the same envelope also carries `media_id`,
and `id` with the same value. That is the ready object id for playlist
selectors. It is also at `operation.result.media_id`. Do not guess a different
path. After a tagged upload, `media list --tag TAG` is the filename-to-id map.

## Development and provenance

Node.js 20.11 or newer is required by the package. The commands below are
source-checkout development gates, not installed-plugin commands; run them from
this repository checkout. Default `media upload` transcoding additionally
requires ffmpeg and ffprobe on the host. `--no-transcode` bypasses both. No
other command requires them; `screenrig doctor` only probes and reports the
optional toolchain.

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

There are two vendor checks, and they answer different questions:

```sh
npm run vendor:check                            # internal consistency
npm run vendor:check:drift -- ../backend        # backend drift
```

`npm run vendor:check` proves **internal consistency only**: the vendored bytes
still match `vendor/manifest.json`, so nobody hand-edited `vendor/`. It never
reads a backend checkout, and therefore **cannot tell you the contract moved
on**. It is the gate CI runs, because CI has no backend checkout.

`npm run vendor:check:drift -- <backend-checkout>` additionally compares each
vendored file against the canonical input in that checkout. It names every file
that drifted with the vendored and canonical SHA-256 and byte count, and prints
the exact `--sync` command to refresh. It fails closed: a `--source-root` that
is absent, valueless, not a directory, or missing a canonical input is an error,
never a pass. Run it whenever the backend contract may have changed; a snapshot
that passes `vendor:check` can still be superseded.

CI publishes deterministic `screenrig-cli.tgz`. The plugin repository pins that
artifact by CLI commit and SHA-256. **Deploys are independent** (operating
rule): this repository's `main` Action publishes that CI artifact only. No
npm or marketplace publish unless the user asks later. Do not pack siblings.
Do not dispatch backend. Do not copy deploy tokens between repos.
Coordinated multi-repo deploy is rare and only for a breaking contract
change. This repository does not deploy ScreenRig.

The release archive vendors the complete production dependency closure from
`package-lock.json`, including every locked native canvas target. Packaging
verifies each registry tarball against its locked SHA-512 integrity and then
runs `version` and `compose catalog` from the extracted offline archive. The
installed plugin never runs `npm install` and does not fetch mutable runtime
dependencies.

Source/package tests do not prove installed-plugin loading, live enrollment or
pairing, public browser handoff, Player rendering, native hardware, or
production deployment. The transcode profiles above are asserted by unit tests
that drive a fake process runner; they are not validated by playback on player
hardware or in any browser.

See the repository [security policy](SECURITY.md). Security reports belong in
[GitHub Private Vulnerability Reporting](https://github.com/screenrig/cli/security/advisories/new).
The Apache-2.0 license covers this public CLI,
not other ScreenRig services or repositories.
