import type { Command } from "commander";
import { findCommand } from "../command-path.js";
import { addCommandExamples, addCommandNotes, commandExamples } from "./notes.js";

/** Help-only workflow guidance. Syntax and validation belong to the native commands. */
export function registerGuidance(root: Command): void {
  const examples: Record<string, string[]> = {
    "account show": [""],
    "agent enroll": ["--email operator@example.com --name Lobby-agent", "--force --email operator@example.com"],
    "agent connect": ["--print-url", "--wait --timeout 10000"],
    "agent status": [""],
    "agent disconnect": ["--yes"],
    "dashboard": [""],
    "app pack": ["./lobby-app --output lobby-app.tar.gz"],
    "app upload": ['./lobby-app --name "Lobby app"'],
    "app update": ["app_APP ./lobby-app"],
    "app list": [""], "app show": ["app_APP"],
    "media upload": ["./poster.png --tag Lobby"],
    "media upload-batch": ["uploads.json --state uploads-state.json"],
    "media show": ["med_MEDIA"], "media download": ["med_MEDIA --output poster.webp"],
    "media list": ["--tag Lobby --primitive image"],
    "media update": ["med_MEDIA --tag Lobby"],
    "media delete": ["med_MEDIA"],
    "compose catalog": [""], "compose render": ["slide.json --output rendered"],
    "compose batch": ["slides.json --output rendered"],
    "playlist validate": ["lobby.json"], "playlist preview": ["lobby.json --output preview --contact-sheet"],
    "playlist templates": [""], "playlist create": ["lobby.json"],
    "playlist update": ["pl_PLAYLIST lobby.json"],
    "playlist export": ["pl_PLAYLIST --output lobby-bundle"],
    "playlist import": ['lobby-bundle --name "Lobby copy"', "lobby-bundle --update pl_PLAYLIST"],
    "playlist list": [""], "playlist delete": ["pl_PLAYLIST"],
    "screen publish": ["scr_SCREEN lobby.json"],
    "screen pair": ['234567 --name "Lobby screen"'],
    "screen provision": ['--open --name "Lobby screen"'],
    "screen update": ['scr_SCREEN --name "Lobby screen"'],
    "screen list": ["", "--state archived"], "screen show": ["scr_SCREEN"],
    "screen assign": ["scr_SCREEN --playlist-id pl_PLAYLIST"],
    "screen set-timezone": ["scr_SCREEN --timezone America/Los_Angeles"],
    "screen archive": ["scr_SCREEN"], "screen unarchive": ["scr_SCREEN"],
    "screen delete": ["scr_SCREEN"], "screen rotate-public-id": ["scr_SCREEN"],
    "screen toast": ['scr_SCREEN --text "Welcome" --duration-ms 5000'],
    "screen screenshot": ["scr_SCREEN --output screenshot.webp"],
    "browser setup": ["--code SETUP_CODE --open"],
    "kv get": ["greeting --app-id app_APP"],
    "kv set": ['greeting --app-id app_APP --json-value \'{"message":"Welcome"}\'', "greeting --app-id app_APP --file greeting.txt --content-type text/plain"],
    "kv list": ["--app-id app_APP"], "kv delete": ["greeting --app-id app_APP"],
    "comment show screen": ["scr_SCREEN"], "comment show playlist": ["pl_PLAYLIST --page page_1"],
    "comment set screen": ["scr_SCREEN --file comments.json"],
    "comment set playlist": ["pl_PLAYLIST --page page_1 --file comments.json"],
    "comment delete screen": ["scr_SCREEN"], "comment delete playlist": ["pl_PLAYLIST --page page_1"],
    "operations show": ["op_OPERATION"], "operations wait": ["op_OPERATION --timeout 120000"],
    "operations cancel": ["op_OPERATION"],
    "events list": ["--limit 20"], "events follow": ["--timeout 30000"],
    "playback list": ["--screen-id scr_SCREEN"],
    "feedback bug": ['"Preview failed" --body-file report.md'],
    "feedback feature": ['"New workflow" --body-file request.md'], "feedback list": ["--kind bug"],
    "doctor": [""], "version": [""], "recovery list": [""],
    "recovery show": ["RECOVERY_ID"], "recovery reconcile": ["RECOVERY_ID"],
  };
  for (const [path, suffixes] of Object.entries(examples)) {
    const command = findCommand(root, path.split(" "));
    if (!command) throw new Error(`Unknown example command ${path}`);
    if (!commandExamples(command).length) addCommandExamples(command, ...suffixes.map(suffix => `screenrig ${path}${suffix ? ` ${suffix}` : ""}`));
  }
  const notes: Record<string, string> = {
    "agent enroll": "The default first-run path. For a new account, ask the user for their contact email and supply it with --email. If an unwanted existing-account connection is pending, --force discards it before enrollment. Intentional existing-account reconnects use agent connect. An already enrolled installation can reuse its saved enrollment.",
    "agent connect": "Existing-account reconnect only. Requires dashboard approval and resumes a pending connection when present. New accounts and first-run installations use agent enroll.",
    "app pack": "Local and unauthenticated. Pack an already-built static directory with a root index.html. app upload packs the directory itself; packing first is optional.",
    "app upload": "Creates a new application and its first immutable release. Packs the built directory and waits for processing by default (120000 ms, polling every 1000 ms). With --no-wait, use operations wait on the returned operation_id before using the release.",
    "app update": "Creates a new immutable release for the same application and preserves its K/V. Existing playlists remain pinned to their previous release. Use playlist replace-release to preview and apply an explicit replacement. Wait defaults: 120000 ms, polling every 1000 ms.",
    "media upload": "Transcodes by default and requires ffmpeg and ffprobe. --no-transcode uploads accepted bytes unchanged. Waits for processing by default (120000 ms, polling every 1000 ms). For multiple files use media upload-batch with a manifest.",
    "media upload-batch": "Reuse the manifest to resume with automatic private state; --state optionally selects its path. Default concurrency is 4 (range 1–8). Transcodes by default; ffmpeg and ffprobe are required unless --no-transcode is used. Upload polling defaults to 1000 ms.",
    "playlist validate": "Local schema and semantic validation; no authentication required. --lint-only is accepted for compatibility: this command always validates locally. Authorization and readiness still require server checks.",
    "playlist create": "Creates a new remote playlist without assigning screens. Supply a canonical {name, pages} document, not an inspection envelope. Display names may repeat; IDs identify playlists. Use playlist init to prepare a document or screen publish to create and assign it.",
    "playlist update": "Replaces the authored document and affects every assigned screen. First use playlist show ID --output FILE; edit that document; optionally supply its revision with --expect-rev. Use --overwrite to replace an authoring file; parent directories are created automatically.",
    "playlist show": "Plain show is an inspection response. --editable returns data.document and revision; --output writes the editable document to a file (--overwrite replaces an existing file) and reports the revision on stdout. When both are supplied, --output takes precedence.",
    "playlist export": "The output directory must not exist. Exports referenced images and videos; application primitives cannot be exported. Dynamic selectors are snapshotted to explicit media IDs.",
    "playlist import": "Creates a new playlist by default. Display names may repeat. Updating an existing playlist requires --update and affects all its assigned screens; --expect-rev is optional.",
    "screen publish": "Creates a new playlist and assigns it; does not update an existing playlist by name. Optionally guard against concurrent changes with --expect-rev. Inspect the prepared document and preview first. Repeat identical input to resume an ambiguous failure. After a revision conflict inspect the screen and follow the returned recovery instructions. Assignment readback does not prove playback; request and inspect screen screenshot separately.",
    "screen assign": "Assigns an existing playlist. --expect-rev optionally checks the screen revision. Scheduled playlists require the screen timezone. Use screen update to set timezone and assignment together.",
    "screen screenshot": "Requests, waits for, and downloads a screenshot. Default wait is 35000 ms and polling interval is 500 ms. Stdout reports the saved path, never image bytes. Inspect the downloaded image to assess playback.",
    "kv get": "Returns bytes as data.value_base64, including JSON values. Decode base64 and parse JSON only when data.content_type indicates JSON. kv list omits values.",
    "kv set": "--json-value encodes JSON directly. --file reads a local file or stdin with -; --value-base64 accepts canonical padded base64, including empty bytes. Byte modes default to application/octet-stream; --content-type overrides it. JSON mode also accepts an explicit application/json. Omit --expect-rev to create or overwrite; supply it to reject concurrent changes.",
    "comment set": "Replaces comments with a JSON value from --json-value or --file, including - for stdin. Last write wins; comments do not take --expect-rev or bump the resource revision.",
    "operations wait": "Wait defaults to 120000 ms, polling every 1000 ms. --timeout sets the wait budget. Use the operation_id returned by an accepted asynchronous command.",
    "events follow": "Writes NDJSON: one JSON envelope per event on stdout. --after resumes from a cursor; --cursor is a compatibility alias. --timeout is in milliseconds; zero or omitted leaves the stream unbounded.",
  };
  for (const [path, note] of Object.entries(notes)) {
    const command = findCommand(root, path.split(" "));
    if (!command) throw new Error(`Unknown guidance command ${path}`);
    addCommandNotes(command, note);
    if (path === "comment set") for (const child of command.commands) addCommandNotes(child, note);
  }
}
