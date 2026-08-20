# ScreenRig CLI agent guide

This repository owns the public noninteractive ScreenRig CLI and deterministic
static-application packer. The supported customer distribution is the pinned
CLI artifact bundled by `screenrig/plugin`; this repository does not own plugin
installation, players, backend services, the site, or production deployment.

## Sources of truth

- `src/` and its tests define implemented commands and behavior. `src/media/`
  owns the ffmpeg toolchain probe, the transcode planner, and the progress
  reporter.
- `package.json` defines the executable, Node engine, scripts, package
  inventory, and public metadata.
- `vendor/manifest.json` records exact backend OpenAPI/protocol/SDK runtime
  inputs.
- `scripts/package-release.sh` defines deterministic `screenrig-cli.tgz`.
- `scripts/vendor-runtime-dependencies.mjs` vendors the complete exact
  production closure from `package-lock.json`; `scripts/check-release-artifact.mjs`
  rejects a release that cannot run offline.
- `.github/workflows/ci.yml` defines public, test, package, and secret gates.
  **Deploys are independent** (operating rule): this repository's `main`
  Action publishes the `screenrig-cli.tgz` CI artifact only. No npm or
  marketplace publish unless the user asks later. Do not pack siblings.
  Do not dispatch backend. Do not copy deploy tokens between repos.
  Coordinated multi-repo deploy is rare and only for a breaking contract
  change. Current CI packages the archive and does not publish npm.

## Edit and generation rules

- Edit `src/`, never `dist/`; `npm run build` regenerates `dist/`.
- Do not hand-edit `vendor/` or `assets/screenrig.runtime.js`. Refresh from
  an explicit reviewed backend checkout:

  ```sh
  node scripts/sync-contract-snapshots.mjs --sync --source-root <backend-checkout>
  ```

- **`npm run vendor:check` proves internal consistency only.** It compares
  `vendor/` against `vendor/manifest.json` and never reads a backend checkout,
  so a snapshot pinned to a superseded contract passes it forever. It stays the
  CI gate because CI has no backend checkout. Do not add a backend dependency
  to it.
- **`npm run vendor:check:drift -- <backend-checkout>` is the drift gate.** It
  compares each vendored file against the canonical input and reports every
  divergence with both SHA-256 values and byte counts. It fails closed on an
  absent, valueless, non-directory, or incomplete source root. Run it before
  trusting a snapshot, and whenever the backend contract may have moved.
- The drift gate reads the source root's **working tree**, matching `--sync`.
  That catches drift early, but it also means it can report divergence against
  uncommitted backend work in flight. Confirm the backend revision is reviewed
  before syncing; never vendor an in-progress contract.
- Inspect every vendored path/byte/hash change and keep adapters/tests aligned.
- Preserve deterministic archive ordering, normalized metadata, SDK injection,
  path/type/size limits, and source-directory immutability.
- The release artifact must include every non-development package recorded in
  `package-lock.json`, including all optional native targets. Verify SHA-512
  before extraction. Never add a mutable runtime install step to the plugin.
- Preserve unrelated work. Do not commit, push, tag, publish, deploy, or change
  external systems unless explicitly authorized.

## Media transcoding

- `media upload` transcodes by default, so **ffmpeg and ffprobe are a required
  external dependency** of that command. The CLI never bundles or installs
  them. Resolution order is `SCREENRIG_FFMPEG` / `SCREENRIG_FFPROBE`, then
  `PATH`. `doctor` reports both binaries, the `libx265`, `libx264`, and
  `libwebp` encoders, and the `zscale` / `tonemap` filters.
- Delivery profiles are fixed. Video defaults to H.264 (`libx264`, High, level
  4.2, `-preset fast -crf 23 -maxrate 8M -bufsize 16M`, `-bf 2`, GOP two
  seconds, `yuv420p`, Rec. 709 limited range, AAC 192 kbit/s 48 kHz stereo),
  with H.265 (`libx265`, `hvc1`, Main, CRF 28) under `--codec hevc`. Players
  play from a complete cached file, so the encode does not remux for
  progressive download (`+faststart`). Images are WebP quality 90, `yuva420p` when the source has
  alpha, `libwebp_anim` for animation. Both bound **each** edge to 3840 px,
  preserve aspect, and never upscale. HDR is tone mapped to Rec. 709, with a
  warning-and-fallback path when the build has no libzimg. Do not retune these
  values here; they are a product decision, not a local one.
- **H.264 is the default deliberately.** ScreenRig stores one rendition per
  media object and the layout contract carries no codec parameter, so there is
  no per-client fallback. A browser that cannot decode the rendition stalls
  rather than degrading. H.265 browser support is not universal: Safari plays
  it, Chrome and Edge only with platform hardware HEVC decode, Firefox is
  limited. Document `--codec hevc` as an opt-in for fleets known to be
  native-only, meaning Qt/GStreamer and Android/MediaCodec. In a browser without
  hardware HEVC decode it can render black. Never frame H.265 as the
  browser-optimized choice, and do not flip the default back without an
  `architecture` ruling.
- Progress goes to **stderr only**, because stdout carries the single envelope.
  `--json` switches the reporter to JSON lines on stderr. The envelope's
  `transcode` block reports `applied`, `stage`, `reason`, `source_bytes`,
  `output_bytes`, `width`, `height`, `dimensions_measured`, and `duration_ms`.
- `width`/`height` are measured from the produced file, never predicted.
  `boundedSize` plans the encode; ffmpeg rounds differently, so the envelope
  must carry a read-back. Keep the honest fallback: on a failed read-back,
  report the planned size with `dimensions_measured: false` and a warning.
- `--no-transcode` uploads the source bytes unchanged and never runs ffmpeg.
  Any gate or test that asserts raw-byte upload identity must pass it.
- `npm run smoke:mock` must stay independent of a host ffmpeg. It uses
  `--no-transcode` for `media upload` and ignores the toolchain checks in
  `doctor`. The transcode paths are covered by `src/media/transcode.test.ts` and
  `src/cli.test.ts` with a fake process runner.
- This transcoding support is source-ready. No test here proves playback on a
  real browser, on player hardware, or in production.

## Feedback

- `feedback bug`, `feedback feature`, and `feedback list` bind
  `POST`/`GET /api/v1/feedback/bugs` and `/api/v1/feedback/features`. **The kind
  comes from the route.** Never add a `kind` member to the request body.
- Submissions are immutable. Do not add an update or delete command, and do not
  document one. A correction is a new submission.
- Writes carry `Idempotency-Key`. The server returns the original submission for
  an exact retry within 24 hours; a different body under the same key returns
  `idempotency_mismatch`.
- `FeedbackContext` is a closed object of three optional scalars. Never invent a
  member; the server rejects an unknown one. `context.command` is
  pattern-constrained to up to four lowercase words and **must never be built
  from raw argv**. It comes only from `--command`, is validated exactly as
  supplied, and is never normalized first — lowercasing would let
  `screen pair ABC234` through.
- Do not add client-side scrubbing of title or body. The server rejects rather
  than redacts credential-shaped text; render its problem and its `errors[]`
  guidance so the operator can rewrite and resend.
- A 429 must surface `Retry-After`. `ApiClient.call` folds it into
  `retry_after_seconds` and next-action guidance for every route, not just
  feedback.
- Probe support through `capabilities.features.feedback` rather than assuming
  the routes exist. `doctor` reports it.

## Toast

- `screen toast <id> --level error|alert|info --text TEXT [--duration-ms MS]`
  binds `POST /api/v1/screens/{id}/toast`. A toast is stage chrome, not a
  placement: no canvas slot, no layer, no readiness or crossfade.
- Latest-wins. Do not add a queue, a cancel command, or a colour field.
  Player chrome chooses the fill; the API never carries one.
- Text is 1 to 120 characters, line feed is the only accepted line break, and
  at most three lines are accepted. `duration_ms` is omitted so the server can
  default it to 10000; when supplied it must be an integer from 2000 to 60000.
- Writes carry `Idempotency-Key`. An exact retry returns the original
  `expires_at` for twenty-four hours. The accepted body is `{ expires_at }`
  only; do not echo the submitted text in the human report or invent an id.
- Do not add client-side scrubbing of toast text. The server rejects
  recognizable ScreenRig credential material and other control characters;
  render its problem so the operator can rewrite and resend.

## Comments

- `comment show|set|delete` bind dedicated `/api/v1/comment/...` routes on a
  screen, a playlist, or one playlist page (`--page`). USAGE is word commands
  (`comment show screen <id>`), not the HTTP path.
- Comments are the agent's own JSON object. Compact UTF-8 of that object is at
  most 1024 bytes. The value itself must be an object; arrays and scalars are
  rejected. ScreenRig does not read or use them. They are not authorization
  and are not on the runtime manifest. Last-write-wins; no `--if-match`; no
  revision bump.
- `comment set` takes exactly one of `--json-value` or `--file`. Both send the
  object as `{ "comments": { ... } }`. Do not add `--value-base64`.
- Unset GET is `{ "comments": null }`. DELETE is 204, unsets, and is
  idempotent. Writes carry `Idempotency-Key`.
- Optional `comments` on `screen show` / `playlist show` (and lists) is passed
  through when the server sends it. Do not strip it. `ScreenPatch` and
  playlist writes cannot set it.
- This surface is **source-ready**. It is not in the locked plugin bundle. Do
  not claim marketplace or deployed.

## Archive

- `screen archive <id> --if-match REVISION` binds
  `POST /api/v1/screens/{id}/archive`. It hides the screen from the default
  list and darkens the glass. It does not unbind the player.
- `screen unarchive <id> --if-match REVISION` binds
  `POST /api/v1/screens/{id}/unarchive`. It restores the screen to the default
  list. Unarchive must pass screen admission.
- `screen list` omits archived screens. `screen list --state archived` lists
  archived screens only. `screen show <id>` still returns an archived row.
- `screen delete` sends `DELETE /api/v1/screens/{id}` and surfaces
  `screen_archive_required`. It does not tombstone. There is no account unbind.
- `screen revoke-credential` is retired. The CLI does not call
  `POST /api/v1/screens/{id}/credential/revoke`. It returns a usage error that
  names `screen archive`.
- The CLI is not a screen. Do not add a CLI keypair.

## Screenshot

- `screen screenshot <id> [--output FILE]` binds
  `POST /api/v1/screens/{id}/screenshot`, polls
  `GET /api/v1/screens/{id}/screenshot/status`, then downloads
  `GET /api/v1/screens/{id}/screenshot?capture_id=...` as `image/webp`. It
  blocks until the still WebP is on disk. There is no `--no-wait`.
- `<id>` must match `^scr_[A-Za-z0-9_-]+$`. `--output` is a file path, not a
  directory. The default is `./<id>.webp` in the current working directory.
  The file is overwritten without a prompt.
- `--timeout` (default 35000 ms) and `--poll-ms` (default 500 ms) are the
  existing global wait flags. A matching `timed_out` status or a wait deadline
  is `screenshot_unavailable`. A later `capture_id` is `resource_conflict`.
- Writes carry `Idempotency-Key`. The download uses the binary transport path;
  never put image bytes in `rawText`, JSON, the envelope, or human output.
  The success envelope is `screen_id`, `capture_id`, `path`, `bytes`, `sha256`,
  `width`, and `height` only.

## Dashboard

- `dashboard [--print-url]` binds `POST /api/v1/account/dashboard-links` on the
  CLI account bearer. It mints one single-use link, then opens it with
  `runtime.openUrl`, the same opener `browser setup --open` uses. Do not add a
  second opener.
- **The whole URL is a credential.** The 256-bit token rides the fragment, which
  no server, access log, or `Referer` header sees. The URL reaches stdout as one
  line only when the opener failed or the operator passed `--print-url`. Never
  write it to a file, never keep it in the config, and never repeat it.
- `DashboardLinkTTL` is ten minutes and the link is single use. That clock is
  not the 30-minute public locator, not the 10-minute protected provisioning
  window, and not the 72-hour native pairing clocks. Do not describe it as any
  of them. The remedy for an expired link is another mint, not a refresh route.
- `validateDashboardLink` binds the returned origin to the configured control
  plane and accepts only `/#link=<43 base64url characters>`. A query, a path, or
  authority credentials is a rejection, never something to strip and continue
  with.
- **The CLI mints and never claims.** `POST /dashboard/v1/links/claim` is the
  browser's request on the dashboard origin. `dashboard_link_invalid`,
  `dashboard_link_expired`, `dashboard_link_consumed`, `passkey_invalid`, and
  `passkeys_disabled` belong to that origin; the CLI cannot receive them and must
  not pretend to map them. The mint call returns `invalid_request`,
  `unauthorized`, `payment_required`, `rate_limited`, or `not_ready`.
- Writes carry `Idempotency-Key`. An exact retry returns the original link and
  expiry for twenty-four hours, so a retry is safe and does not mint a second
  live link.
- This command is **source-ready**. It is not in the locked plugin bundle, and
  the dashboard origin is not deployed. Do not claim a working dashboard.
- `redactText` strips a `#link=` or `#provision=` fragment from any text that
  reaches a problem detail, an event, or a message. Keep new output on that path.

## Events

- `events list` binds `GET /api/v1/events` with `--after` / `--cursor` and
  `--limit`. `events follow` binds `GET /api/v1/events/stream` with the same
  cursor flags and the global `--timeout`. It reconnects on disconnect or a
  transient connect failure, with exponential backoff, and sends the last
  SSE `id` as `after`. `--timeout` covers the whole follow, including
  backoff. 401, 403, 404, and other non-transient 4xx problems stop the
  command. Do not print reconnect chatter on stdout.
- Human mode is logfmt: one `key=value` line per printable event. `--json
  events list` is one page envelope. `--json events follow` is a JSON stream
  of envelopes. Do not document canned server sentences as the trail.
- A human line carries `at`, `type`, `severity`, optional `resource_type` and
  `resource_id`, scalar `details`, and a `message` that is not canned and is
  not a duplicate of `type` or `details.code`. Nested objects, empty strings,
  and sensitive keys or values are omitted. A screenshot `capture_id` is data.
- An `application.event` or `runtime.reported` with no remaining scalar
  payload is silent. A silent page or stream writes no human output. `--json
  events list` still emits the empty page envelope. `--json events follow`
  with no events emits one empty `{ items: [] }` envelope.
- `--json` redacts tokens, pixels, authorization, object keys, and other
  credential-shaped material. Canned-sentence silence is human-only. After
  redaction, a server `message` field that is data remains.
- Optional `Event.actor` is `{ user_id, display_name }` and names the dashboard
  user that caused one mutation. It is descriptive attribution and never
  authorization. Events an agent, the CLI, a player, or a worker produced carry
  no actor. `--json` passes it through. It is a nested object, so the human
  logfmt line omits it under the existing rule; no event carries one until the
  dashboard serves traffic, so do not add a rendering that cannot be verified.

## Playback

- `playback list [--screen-id ID] [--media-id ID] [--day YYYY-MM-DD]` binds
  `GET /api/v1/playback`. Daily aggregates for this account: one row per
  screen, media, and UTC day. Newest days first.
- `--screen-id` must start with `scr_`. `--media-id` must start with `med_`.
  `--day` is a UTC calendar day as `YYYY-MM-DD`. Identifiers filter the
  caller's own rows and are never a cross-account lookup.
- This command is **repository-ready** on public `main`. It is not in the
  locked plugin bundle. Do not claim marketplace or deployed.

## Media tags

- `media upload --tag TAG` stores a 1–32 letter-or-digit tag on the ready
  object at declare. It is not redeclared at commit. Pattern
  `^[A-Za-z0-9]{1,32}$`; reject other values locally as `usage_error`.
- `media list [--tag TAG] [--kind image|video]` forwards those query
  filters to `GET /api/v1/media`. Untagged objects are omitted when `--tag`
  is present.
- `media update <id> (--tag TAG | --clear-tag) --if-match REVISION` binds
  `PATCH /api/v1/media/{id}`. Exactly one of `--tag` or `--clear-tag`.
  `--clear-tag` sends `null`. There is no other media metadata patch. Do
  not add an update path for filename, kind, or codecs.
- This surface is **repository-ready** on public `main`. It is not in the
  locked plugin bundle. Do not claim marketplace or deployed.

## Page scheduling

- `visibility` on a playlist page is optional playback orchestration and a
  sibling of `advance`. It is **not** part of `screenrig.canvas/v1`. The CLI
  forwards it verbatim and never constructs one.
- The CLI inspects exactly one thing about it: whether the `visibility` key is
  present on a page. That mirrors the server's own test, so a page whose only
  rule is `enabled: false` still counts as scheduled. Do not deepen this into
  local schedule evaluation; the player evaluates, and the server validates.
- **A screen running a scheduled playlist must have a timezone.** `screen
  assign`, `screen update --playlist-id`, and `playlist update` refuse locally
  before sending, naming the screen and the `screen set-timezone` command that
  fixes it. The server enforces the same rule on assignment, playlist update,
  and manifest resolution; the local check exists to replace an opaque 400 with
  an actionable message, never to replace the server's authority.
- `screen set-timezone` forwards the IANA identifier unchanged. The server owns
  the zone database. Never add a CLI-side zone list or allowlist; it would go
  stale and reject valid names.
- **Every playlist must keep at least one page with no `visibility` field at
  all.** That is a server rule and the CLI does not duplicate it. Do not add a
  local copy that could drift; render the server's problem instead.

## Page motion

- Default templated pages stay `{ type: "crossfade", duration_ms: 200 }` with
  no placement `enter`. Do not flip that default to swipe.
- Full pages are opaque: the CLI forwards `transition.type` swipe variants
  (`swipe-left`, `swipe-right`, `swipe-up`, `swipe-down`) and optional
  placement `enter: { type }` with that same object name. No snake_case
  inside `enter`. `duration_ms` is required, 0 through 60000. Swipe
  authoring default when chosen is `duration_ms: 600`.
- Teach swipe and `enter` as spare emphasis, not as the ordinary page.
  Object enter delay 500 ms and duration 400 ms are contract constants, not
  author fields and not CLI flags.
- `Application` carries no `state` and no `release_id`. It reports
  `latest_ready_release`. `OperationAccepted.release_id` is required, so
  `app upload` reports the release id without waiting on the operation result.
  Knowing the id is not readiness; the operation still decides that.
  Optional `--name` (at most 120 characters, no line break) is sent as
  `ScreenRig-Application-Name`. Every upload still creates a new
  application and a new release; `--name` is not an in-place update. That
  flag is **repository-ready** on public `main`. It is not in the locked
  plugin bundle. Do not claim marketplace or deployed.

## Product and security boundaries

- Package metadata requires Node.js 20.11+. The plugin's package-relative
  launcher owns the exact runtime preflight. ffmpeg and ffprobe are a host
  dependency the launcher does not provide.
- The first authenticated command persists replay state, enrolls automatically,
  verifies the issued credential, and resumes the original command.
  `--beta-key` and `SCREENRIG_BETA_KEY` are sent as `beta_key` on
  `POST /api/v1/enrollments` when present, and omitted when unset.
- `auth revoke --yes` is server-first and retains local state after failed or
  ambiguous server results. That route is
  `POST /api/v1/account/credential/revoke` (CLI account bearer). It does
  not unbind a screen. `POST /api/v1/screens/{id}/credential/revoke` is
  retired. Archive hides a screen. Do not teach `screen revoke-credential`
  or `screen delete` as unbind. `screen delete` surfaces
  `screen_archive_required`. The CLI is not a screen and holds no player
  keypair.
- `screen pair` currently accepts exactly six canonical undashed characters.
  `browser setup --code` accepts the dashed or undashed public handoff form.
- Configuration and transient retry state are atomic and user-private. Never
  log/output raw credentials, signed upload details, cookies, completion nonces,
  provisioning material, customer content, or secret-bearing headers/bodies.
  ffmpeg diagnostics reach the user only through `summarizeFfmpegError`, which
  redacts and bounds the stderr tail; keep it on that path.
- Transcoded bytes live in a `mkdtemp` directory the caller removes. Every
  failure path after that directory exists must remove it.
- Playlist pages the CLI emits may use only `image`, `video`, `iframe`, and
  `application`. Do not emit native `text`, `box`, or `line`. Copy and chrome
  are composed locally with `compose catalog` / `compose render`, uploaded as
  `image`, then placed as one image. `playlist templates` is a local catalog.
  Templated pages that would emit vector chrome fail with `usage_error`
  pointing at those compose commands. Do not silently rasterize and upload.
- `canvas.background` is a solid uppercase `#RRGGBBAA` or a top-to-bottom
  linear gradient (`type: "linear"`, 2 through 8 strictly increasing stops,
  first at=0, last at=1). There is no angle. Templated pages accept that
  union on `canvas.background` only. Default slide templates stay solid
  `SLIDE_BACKGROUND`. Do not invent a local background variant.
- `Media.codecs` is server-derived from the stored bytes and never
  client-declared. The CLI must not send, infer, or validate it. `--codec hevc`
  simply causes the server to derive `hvc1.*` instead.
- The default plan has no product storage cap (`account_content_bytes` and
  `content_limit_bytes` are 0). A custom storage ceiling, when present, is
  checked first and rejected with `quota_exceeded`. Remaining prepaid credit of
  below 1 whole credit rejects billed `/api/v1` work with `payment_required`.
  Keep the 1 GiB local check as a plan-independent transport bound. Keep
  `quota_exceeded` and `payment_required` guidance pointing at `account show`.
  `account show` prints integer `credit_remaining` and does not debit.
  Remaining below 1000 credits adds `credits_low` to envelope `warnings[]`.
  Screen toast and screenshot are exempt from the 1-credit API meter. Do not
  add pay, Stripe, or x402 commands.
- Screenshotting is in v1. `screen screenshot <id>` blocks on a still WebP and
  writes a file. Do not print pixels.
- `compose catalog` and `compose render` are local and unauthenticated. The
  render envelope is paths and layout metadata only. Never put PNG bytes in
  stdout, the envelope, or human text. `--open` opens a local path through
  `CliRuntime.openPath`; it is not the agent vision loop.
- Optional Text `textShadow` is local `compose render` paint only. Author
  `{ x, y, blur?, color }` in px; omit it to paint without a shadow. It is
  not `screenrig.canvas/v1` and not a player feature. Layout `x`/`y` on Text
  stay forbidden. This is **source-ready** in the working tree. It is not in
  the locked plugin bundle. Do not claim marketplace or deployed.

## Verification

```sh
npm ci
npm run check:public
npm run vendor:check
npm run typecheck
npm run lint
npm test
npm run smoke:mock
npm run pack:dry
npm run pack:release
```

`npm run smoke:server` requires an explicitly owned local backend and is not a
production or hardware gate. `npm run vendor:check:drift -- <backend-checkout>`
requires a readable backend checkout and is therefore not part of the CI list
above; run it explicitly when one is available.

## Completion evidence

Report exact source/docs/vendor files changed, vendored provenance and hashes,
all command results, package inventory, stale-language scan, repository status,
and skipped live-server/plugin/player/native/deployment checks.
