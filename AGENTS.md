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
- `.github/workflows/ci.yml` defines public, test, package, and secret gates.
  Production selects the artifact only through the backend component lock.

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

## Product and security boundaries

- Package metadata requires Node.js 20.11+. The plugin's package-relative
  launcher owns the exact runtime preflight. ffmpeg and ffprobe are a host
  dependency the launcher does not provide.
- The first authenticated command persists replay state, enrolls automatically,
  verifies the issued credential, and resumes the original command.
  `--beta-key` and `SCREENRIG_BETA_KEY` are sent as `beta_key` on
  `POST /api/v1/enrollments` when present, and omitted when unset.
- `auth revoke --yes` is server-first and retains local state after failed or
  ambiguous server results.
- `screen pair` currently accepts exactly six canonical undashed characters.
  `browser setup --code` accepts the dashed or undashed public handoff form.
- Configuration and transient retry state are atomic and user-private. Never
  log/output raw credentials, signed upload details, cookies, completion nonces,
  provisioning material, customer content, or secret-bearing headers/bodies.
  ffmpeg diagnostics reach the user only through `summarizeFfmpegError`, which
  redacts and bounds the stderr tail; keep it on that path.
- Transcoded bytes live in a `mkdtemp` directory the caller removes. Every
  failure path after that directory exists must remove it.
- The contract carries `text`, `box`, and `line` vector placements in
  `screenrig.canvas/v1`, plus their playlist authoring schemas. **Do not
  encourage authoring them.** The server rejects a page containing one until
  `SCREENRIG__RUNTIME__ACCEPT_VECTOR_PLACEMENTS` is enabled, which waits on every
  player being pinned. No example, doc, fixture, or smoke may author one.
- `Media.codecs` is server-derived from the stored bytes and never
  client-declared. The CLI must not send, infer, or validate it. `--codec hevc`
  simply causes the server to derive `hvc1.*` instead.
- The default plan has no product storage cap (`account_content_bytes` and
  `content_limit_bytes` are 0). A custom storage ceiling, when present, is
  checked first and rejected with `quota_exceeded`. Remaining prepaid credit of
  zero rejects declare and commit with `payment_required`. Keep the 1 GiB local
  check as a plan-independent transport bound. Keep `quota_exceeded` and
  `payment_required` guidance pointing at `account show`. `account show` may
  print remaining mcr; optional kCr display is later. Do not add pay, Stripe,
  or x402 commands.
- Screenshotting is outside v1; do not add or document screenshot commands.

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
```

`npm run smoke:server` requires an explicitly owned local backend and is not a
production or hardware gate. `npm run vendor:check:drift -- <backend-checkout>`
requires a readable backend checkout and is therefore not part of the CI list
above; run it explicitly when one is available.

## Completion evidence

Report exact source/docs/vendor files changed, vendored provenance and hashes,
all command results, package inventory, stale-language scan, repository status,
and skipped live-server/plugin/player/native/deployment checks.
