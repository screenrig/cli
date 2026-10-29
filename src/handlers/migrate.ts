// Command handlers for the migrate commands, loaded on demand.
import { canonicalPairingCode } from "../pairing-code.js";
import { shellQuote } from "../temp-file.js";
import path from "node:path";
import { type Project } from "../adapters/protocol.js";
import { flagBool, flagNumber, flagString } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import { UPLOAD_BATCH_DEFAULT_CONCURRENCY, UPLOAD_BATCH_MAX_CONCURRENCY, UPLOAD_BATCH_MIN_CONCURRENCY } from "../media-upload-batch.js";
import { runApply, ONLY_KINDS, type ApplyOptions, type OnlyKind } from "../migrate/apply.js";
import { chooseDir, describeVendor, findVendor, sortedVendors, vendorHttpFor, vendorLines } from "../migrate/cli.js";
import { loadCredentials } from "../migrate/credentials.js";
import { openLocalFiles } from "../migrate/local-files.js";
import { runPair } from "../migrate/pair.js";
import { reportLines as migrationReportLines } from "../migrate/report.js";
import { runScan } from "../migrate/scan.js";
import { clientFor, commandHandler, mediaFolderId, progressReporterFor, transcodeOptionsFromArgs } from "../commands.js";


// ---- migrate: import from another signage system -------------------------------------------------

export const handleMigrateVendors = commandHandler(async (args) => {
  const id = args.positionals[2];
  const vendors = id === undefined ? sortedVendors() : [findVendor(id)];
  return {
    envelope: successEnvelope({ vendors: vendors.map(describeVendor) }),
    exitCode: ExitCode.Success,
    human: vendors.flatMap((vendor) => vendorLines(vendor)).join("\n"),
  };
}, false);

export const handleMigrateScan = commandHandler(async (args, runtime) => {
  const adapter = findVendor(flagString(args.flags, "from") ?? "");
  const resolvePath = (flag: string): string | undefined => {
    const value = flagString(args.flags, flag);
    return value === undefined ? undefined : path.resolve(runtime.cwd(), value);
  };
  const dir = await chooseDir(runtime, flagString(args.flags, "dir"), adapter.id);
  const files = resolvePath("files");
  const { report } = await runScan({
    adapter,
    flags: {
      ...(flagString(args.flags, "url") !== undefined ? { url: flagString(args.flags, "url")! } : {}),
      ...(flagString(args.flags, "region") !== undefined ? { region: flagString(args.flags, "region")! } : {}),
      ...(flagString(args.flags, "timezone") !== undefined ? { timezone: flagString(args.flags, "timezone")! } : {}),
      ...(files !== undefined ? { files } : {}),
    },
    ...(resolvePath("credentials") !== undefined ? { credentialsFile: resolvePath("credentials")! } : {}),
    dir,
    env: runtime.env,
    now: runtime.now,
    http: vendorHttpFor(runtime, adapter),
  });
  return {
    envelope: successEnvelope({ ...report, dir: dir.dir, scan_file: dir.scanFile }),
    exitCode: ExitCode.Success,
    human: migrationReportLines(report, dir.dir).join("\n"),
  };
}, false);

export async function migrateProjectId(client: ApiClient, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  const id = ((await client.call({ method: "GET", path: "/api/project" })).body as Project | undefined)?.id;
  if (typeof id !== "string" || id.length === 0) throw usageError("The project id is unavailable, so the migration directory cannot be bound to it.");
  return id;
}

export const handleMigrateApply = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const dir = await chooseDir(runtime, flagString(args.flags, "dir"));
  const scan = await dir.readScan();
  const adapter = findVendor(scan.vendor);
  const concurrency = flagNumber(args.flags, "concurrency") ?? UPLOAD_BATCH_DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < UPLOAD_BATCH_MIN_CONCURRENCY || concurrency > UPLOAD_BATCH_MAX_CONCURRENCY) {
    throw usageError(`--concurrency must be a whole number from ${UPLOAD_BATCH_MIN_CONCURRENCY} to ${UPLOAD_BATCH_MAX_CONCURRENCY}.`);
  }
  const canvasText = flagString(args.flags, "canvas");
  const canvasMatch = canvasText === undefined ? undefined : /^(\d+)x(\d+)$/i.exec(canvasText);
  const onlyText = flagString(args.flags, "only");
  const only = new Set<OnlyKind>(onlyText === undefined ? ONLY_KINDS : (onlyText.split(",") as OnlyKind[]));
  const credentialsFile = flagString(args.flags, "credentials") === undefined ? undefined : path.resolve(runtime.cwd(), flagString(args.flags, "credentials")!);
  const folder = flagString(args.flags, "folder");
  if (folder !== undefined) mediaFolderId(folder, "--folder");
  const options: ApplyOptions = {
    dryRun: flagBool(args.flags, "dry-run"),
    only,
    ...(folder !== undefined ? { folder } : {}),
    canvas: canvasMatch ? { width: Number(canvasMatch[1]), height: Number(canvasMatch[2]) } : { width: 1920, height: 1080 },
    concurrency,
    noTranscode: flagBool(args.flags, "no-transcode"),
    transcodeOptions: transcodeOptionsFromArgs(args),
    timeoutMs: flagNumber(args.flags, "timeout") ?? 120_000,
    pollMs: 1000,
  };
  const json = !flagBool(args.flags, "human");
  const secrets: string[] = [];
  const result = await runApply({
    runtime,
    client,
    dir,
    scan,
    vendorName: adapter.name,
    apiUrl: resolved.apiUrl.replace(/\/+$/, ""),
    projectId: await migrateProjectId(client, resolved.projectId),
    openSession: async () => {
      const credentials = await loadCredentials(adapter, { ...(credentialsFile !== undefined ? { file: credentialsFile } : {}), env: runtime.env });
      secrets.push(...Object.values(credentials));
      const files = scan.inputs.files !== undefined ? await openLocalFiles(scan.inputs.files) : undefined;
      return adapter.open({
        ...(scan.inputs.url !== undefined ? { url: scan.inputs.url } : {}),
        ...(scan.inputs.region !== undefined ? { region: scan.inputs.region } : {}),
        ...(scan.inputs.timezone !== undefined ? { timezone: scan.inputs.timezone } : {}),
        credentials,
        http: vendorHttpFor(runtime, adapter),
        ...(files ? { files } : {}),
        now: runtime.now,
      });
    },
    openFiles: async () => {
      if (scan.inputs.files === undefined) throw usageError("This scan used no --files, so there are no local originals to import.");
      return openLocalFiles(scan.inputs.files);
    },
    reporter: progressReporterFor(args, runtime),
    rerun: shellQuote([
      "screenrig", "migrate", "apply", "--dir", dir.dir,
      ...(onlyText !== undefined ? ["--only", onlyText] : []),
      ...(folder !== undefined ? ["--folder", folder] : []),
      ...(canvasText !== undefined ? ["--canvas", canvasText] : []),
      ...(credentialsFile !== undefined ? ["--credentials", credentialsFile] : []),
      ...(flagString(args.flags, "concurrency") !== undefined ? ["--concurrency", String(concurrency)] : []),
      ...(options.noTranscode ? ["--no-transcode"] : []),
    ]),
    progress: (event) => {
      runtime.stderr.write(json ? `${JSON.stringify(event)}\n` : `screenrig: migrate ${String(event.phase)} ${String(event.done)}/${String(event.total)}\n`);
    },
    secrets,
  }, options);
  return {
    envelope: successEnvelope(result.data, { request_id: client.requestId, warnings: result.warnings }),
    exitCode: result.exitCode,
    human: result.human,
  };
}, true);

export const handleMigratePair = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const rawCode = args.positionals.slice(2).join(" ");
  if (!rawCode) throw usageError("migrate pair requires CODE.");
  const code = canonicalPairingCode(rawCode, "migrate pair CODE");
  const dir = await chooseDir(runtime, flagString(args.flags, "dir"));
  const scan = await dir.readScan();
  const result = await runPair({
    runtime, client, dir, scan,
    apiUrl: resolved.apiUrl.replace(/\/+$/, ""),
    projectId: await migrateProjectId(client, resolved.projectId),
    code,
    screen: flagString(args.flags, "screen") ?? "",
  });
  return { envelope: successEnvelope(result.data, { request_id: client.requestId }), exitCode: ExitCode.Success, human: result.human };
}, true);
