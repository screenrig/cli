# ScreenRig CLI

This repository implements the noninteractive ScreenRig control-plane CLI and
deterministic static-application packer. The supported customer distribution is
the exact CI artifact pinned and bundled by
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

Playlist create and update send the supplied JSON file verbatim. Image and
video placements write a `selector` (`by` is `id`, `ids`, `all`, or `tag`).
Do not put `media_id` on the content object, and do not send server-resolved
`items`. Page advance uses `duration`, `application`, or `media_end`. There
is no `video_end` mode.

The ordinary pair command currently accepts six canonical characters:

```sh
screenrig --json screen pair ABC234
```

The separate homepage handoff command accepts either `ABC-234` or `ABC234`,
normalizes it, and returns only safe status fields:

```sh
screenrig --json browser setup --code ABC-234
```

Browser handoff has a backend-owned 30-minute unclaimed window and a fresh
10-minute protected delivery window after claim. The CLI never receives or
prints the browser cookie, provisioning token, continuation redirect, native
device credential, or runtime session.

Application packing accepts an already-built static directory. It produces
deterministic bounded archives, injects the pinned browser SDK runtime, and
never builds or executes uploaded source. Runtime pages use
`screenrig.canvas/v1`; protected content and `screenrig.webapp-package/v1`
delivery are backend/player concerns. Screenshotting is not part of v1 and the
CLI exposes no screenshot command.

## Feedback

Bug reports and feature requests are account-scoped and immutable:

```sh
screenrig --json feedback bug "Playlist stalls after pairing" \
  --body-file ./report.md --command "screen pair"
screenrig --json feedback feature "Add a dry-run flag" --body "Preview a change first."
screenrig --json feedback list [--kind bug|feature]
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

## Screen toast

A toast is transient stage chrome on one screen, not a placement. It occupies
no canvas slot, has no layer, and never participates in readiness or
crossfade. Latest-wins: there is no queue and the CLI exposes no cancel
command. Level colours are player chrome and are not API fields.

```sh
screenrig --json screen toast scr_01 --level info --text "Lobby closed"
screenrig --json screen toast scr_01 --level alert --text "Doors locked" --duration-ms 5000
```

`--level` is one of `error`, `alert`, or `info`. `--text` is 1 to 120
characters, accepts line feed as the only line break, and allows at most
three lines. `--duration-ms` is optional, defaults to 10000 on the server, and
must be between 2000 and 60000 inclusive when supplied.

The write is idempotent. An exact retry under the same `--idempotency-key`
returns the original `expires_at` for twenty-four hours. Runtime scan never
delivers a toast after that instant, so a persisted cursor cannot replay it.

The accepted envelope is `{ expires_at }` only. The CLI does not scrub toast
text; the server rejects recognizable ScreenRig credential material and other
control characters. Do not put credentials, cookies, Authorization headers,
completion nonces, signed URLs, or object keys in the text.

## Media transcoding

`media upload` transcodes the source before it declares the upload, so the
control plane only ever receives delivery-ready bytes. This makes **ffmpeg and
ffprobe a required external dependency** of that one command. The CLI does not
bundle them. It runs `ffmpeg` and `ffprobe` from `PATH`, or from the absolute
paths in `SCREENRIG_FFMPEG` and `SCREENRIG_FFPROBE` when those variables are
set. The install hint asks for ffmpeg 6.0 or newer; the CLI reports the resolved
version but does not enforce a minimum. What it does enforce is the presence of
the encoder each profile needs. `screenrig doctor` reports the resolved binaries
and versions, the `libx265`, `libx264`, and `libwebp` encoders, and whether the
build carries the `zscale` and `tonemap` filters that HDR tone mapping needs.

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

Images become WebP at quality 90, in `yuva420p` when the source carries an
alpha channel and `yuv420p` otherwise. An animated source uses `libwebp_anim`
where the build provides it and loops forever. A WebP source that already fits
the size bound is passed through unchanged instead of re-encoded.

Both families bound **each** edge to 3840 pixels, so a portrait source is capped
exactly like a landscape one. Aspect ratio is preserved, and a source smaller
than the bound is never upscaled.

### Why H.264 is the default

ScreenRig stores exactly one rendition per media object, and the layout contract
carries no codec parameter. There is no per-client fallback: whatever the CLI
uploads is what every player has to decode. H.264 High profile level 4.2 is the
default because current browsers play it universally.

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
| `--no-transcode` | Upload the source bytes unchanged. ffmpeg is never run. |
| `--codec h264\|hevc` | Video codec. Default `h264`. `avc` and `h265` are accepted as aliases. |
| `--max-fps N` | Frame-rate cap, greater than 0 and at most 240. Default 30. |
| `--max-edge PIXELS` | Bound on each edge, 16 to 3840. Default 3840. |
| `--webp-quality 1-100` | WebP quality. Default 90. |
| `--no-progress` | Emit no progress output. |

```sh
screenrig --json media upload ./clip.mov
screenrig --json media upload ./clip.mov --codec hevc
screenrig --json media upload ./poster.png --no-transcode
```

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

## Development and provenance

Node.js 20.11 or newer is required by the package. `media upload` additionally
requires ffmpeg and ffprobe on the host; no other command runs them.

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
artifact by CLI commit and SHA-256, and the backend production lock separately
selects it for release assembly. This repository does not deploy ScreenRig.

Source/package tests do not prove installed-plugin loading, live enrollment or
pairing, public browser handoff, Player rendering, native hardware, or
production deployment. The transcode profiles above are asserted by unit tests
that drive a fake process runner; they are not validated by playback on player
hardware or in any browser.

Security reports belong in
[GitHub Private Vulnerability Reporting](https://github.com/screenrig/cli/security/advisories/new).
See [SECURITY.md](SECURITY.md). The Apache-2.0 license covers this public CLI,
not other ScreenRig services or repositories.
