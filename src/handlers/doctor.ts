// Command handlers for the doctor commands, loaded on demand.
import { type Capabilities } from "../adapters/protocol.js";
import { type ParsedArgs } from "../command-input.js";
import { resolveConfig, describeTokenPresence, hasToken, readConfigFile, type ScreenRigConfig } from "../config.js";
import { refreshExpiryDays } from "../oauth-session.js";
import { successEnvelope, type ProblemNext } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { redactText } from "../redact.js";
import { cwebpLookup, ffmpegLookup, resolveCwebpToolchain, resolveFfmpegToolchain, type CwebpToolchain, type FfmpegToolchain } from "../media/ffmpeg.js";
import { CLI_VERSION, cliDistribution } from "../version.js";
import { clientFor, commandHandler, type CommandResult } from "../commands.js";


export const handleDoctor = commandHandler(doctor, false);

export const READINESS_SENTENCE_MAX = 400;

/** One line, redacted, bounded: the sentence is server text shown to the operator. */
export function redactedReadinessSentence(sentence: string): string {
  const flat = redactText(sentence).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return flat.length > READINESS_SENTENCE_MAX ? `${flat.slice(0, READINESS_SENTENCE_MAX)}...` : flat;
}

/**
 * `pass` is present and usable and `fail` is a defect the operator has to fix.
 * `warn` is an optional piece or degraded server dependency, reported without
 * moving the exit code: a host that is missing nothing required exits 0.
 */
export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  path?: "first_run_enroll" | "reconnect_existing";
  /** The command that clears a `warn` or `fail` row, when one exists. */
  next?: ProblemNext;
}

/**
 * A fresh install has no credential and nothing is broken, so the `token` row
 * warns and names the enrollment or connection command instead of failing.
 * `fail` is reserved for damage the operator must repair: bad permissions,
 * a missing toolchain piece a supported command needs, or an unreachable
 * control plane.
 */
export function credentialCheck(resolved: Awaited<ReturnType<typeof resolveConfig>>): DoctorCheck {
  if (hasToken(resolved.token)) {
    return { name: "token", status: "pass", detail: describeTokenPresence(resolved.token) };
  }
  const detail = describeTokenPresence(resolved.token);
  if (resolved.signedOut) {
    return {
      name: "token",
      status: "warn",
      detail: `${detail}; this installation is signed out`,
      path: "reconnect_existing",
      next: { command: "screenrig login", reason: "Sign this installation in again; a person approves it in the dashboard." },
    };
  }
  if (resolved.retiredCredential) {
    return {
      name: "token",
      status: "warn",
      detail: `${detail}; the stored credential is no longer accepted`,
      path: "reconnect_existing",
      next: { command: "screenrig login", reason: "Sign this installation in; a person approves it in the dashboard. Then rerun doctor." },
    };
  }
  if (resolved.lastAgent) {
    return {
      name: "token",
      status: "warn",
      detail: `${detail}; this installation was disconnected`,
      path: "first_run_enroll",
      next: {
        command: "screenrig agent enroll --email ADDRESS --organization NAME",
        reason: "Ask the user for their contact email, enroll a new project agent, then rerun doctor. Use screenrig login only when the user asked to join an existing project.",
      },
    };
  }
  return {
    name: "token",
    status: "warn",
    detail: `${detail}; this installation is not enrolled`,
    path: "first_run_enroll",
    next: {
      command: resolved.enrollment ? "screenrig agent enroll" : "screenrig agent enroll --email ADDRESS --organization NAME",
      reason: resolved.enrollment
        ? "Resume the exact pending enrollment, then rerun doctor."
        : "Create the first agent with unverified contact metadata, then rerun doctor. Every authenticated command fails with not_enrolled until then.",
    },
  };
}

/** The session's last possible day: the refresh family ends at the idle or absolute expiry, whichever comes first. */
export function signInCheck(grant: NonNullable<ScreenRigConfig["oauth"]>, now: Date): DoctorCheck {
  const ends = grant.refresh_expires_at ? new Date(grant.refresh_expires_at * 1000).toISOString() : undefined;
  const days = refreshExpiryDays(grant, now);
  if (days === undefined) {
    return { name: "sign_in", status: "pass", detail: ends ? `session ends by ${ends}; each use moves the idle end forward` : "session present" };
  }
  return {
    name: "sign_in",
    status: "warn",
    detail: `session ends ${ends} (${days} days)`,
    next: { command: "screenrig login", reason: "Sign in again before the session ends; a person approves it in the dashboard." },
  };
}

export function probeFailureDetail(err: unknown, fallback: string): string {
  if (err instanceof CliError) {
    return err.problem.detail;
  }
  return err instanceof Error ? redactText(err.message) : fallback;
}

export async function doctor(
  args: ParsedArgs,
  runtime: CliRuntime,
  resolved: Awaited<ReturnType<typeof resolveConfig>>,
): Promise<CommandResult> {
  const checks: DoctorCheck[] = [];
  const distribution = cliDistribution();
  checks.push({ name: "distribution", status: "pass", detail: `${distribution.kind}; ${distribution.agent_setup}` });
  const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    status: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 11) ? "pass" : "fail",
    detail: `node ${process.versions.node}`,
  });
  checks.push({
    name: "config_path",
    status: "pass",
    detail: resolved.configPath,
  });
  try {
    const st = await runtime.fs.stat(resolved.configPath);
    const mode = st.mode & 0o777;
    const ok = (mode & 0o077) === 0;
    checks.push({
      name: "config_permissions",
      status: ok ? "pass" : "fail",
      detail: `mode ${mode.toString(8)}`,
    });
  } catch {
    checks.push({ name: "config_permissions", status: "pass", detail: "config file not present" });
  }
  checks.push(credentialCheck(resolved));
  const grant = (await readConfigFile(resolved.configPath, { ...runtime.fs, env: runtime.env, homedir: runtime.homedir }).catch(() => undefined))?.oauth;
  if (grant) checks.push(signInCheck(grant, runtime.now()));
  checks.push({
    name: "api_url",
    status: resolved.apiUrl.startsWith("https://") || resolved.apiUrl.startsWith("http://127.") || resolved.apiUrl.includes("localhost") ? "pass" : "fail",
    detail: resolved.apiUrl,
  });
  checks.push({
    name: "log_socket",
    status: "pass",
    detail: resolved.logSocket ?? "(none)",
  });
  const lookup = ffmpegLookup(runtime.env);
  const webpLookup = cwebpLookup(runtime.env);
  let toolchain: FfmpegToolchain | undefined;
  let toolchainDetail: string | undefined;
  try {
    toolchain = await resolveFfmpegToolchain(runtime);
  } catch (err) {
    toolchainDetail = probeFailureDetail(err, "ffmpeg probe failed");
  }
  let cwebp: CwebpToolchain | undefined;
  let cwebpDetail: string | undefined;
  try {
    cwebp = await resolveCwebpToolchain(runtime);
  } catch (err) {
    cwebpDetail = probeFailureDetail(err, "cwebp probe failed");
  }
  // WebP stills have two independent encoders: ffmpeg's libwebp, and the
  // `cwebp` binary the image planner falls back to. Neither is required on its
  // own, so each is a warning while the other is usable, and the pair fails
  // only when the CLI has no way to produce WebP at all. `undefined` means the
  // ffmpeg probe never answered, which the ffmpeg check already reports.
  const libwebp = toolchain?.encoders.has("libwebp");
  const webpEncodable = libwebp === true || cwebp !== undefined;

  if (toolchain) {
    checks.push({
      name: "ffmpeg",
      status: "pass",
      detail: `${toolchain.ffmpeg} ${toolchain.ffmpegVersion}${lookup.ffmpegFromEnv ? " (SCREENRIG_FFMPEG)" : ""}`,
    });
    checks.push({
      name: "ffprobe",
      status: "pass",
      detail: `${toolchain.ffprobe} ${toolchain.ffprobeVersion}${lookup.ffprobeFromEnv ? " (SCREENRIG_FFPROBE)" : ""}`,
    });
    const encoders = toolchain.encoders;
    checks.push({
      name: "encoder_libx264",
      status: encoders.has("libx264") ? "pass" : "fail",
      detail: encoders.has("libx264")
        ? "libx264 available"
        : "libx264 missing from this ffmpeg build; the default video profile cannot encode",
    });
    checks.push({
      name: "encoder_libx265",
      status: encoders.has("libx265") ? "pass" : "warn",
      detail: encoders.has("libx265")
        ? "libx265 available"
        : "libx265 missing from this ffmpeg build; --codec hevc is unavailable",
    });
    checks.push({
      name: "encoder_libwebp",
      status: encoders.has("libwebp") ? "pass" : webpEncodable ? "warn" : "fail",
      detail: encoders.has("libwebp")
        ? "libwebp available"
        : "libwebp missing from this ffmpeg build; animation cannot be encoded",
    });
    const tonemap = toolchain.filters.has("zscale") && toolchain.filters.has("tonemap");
    checks.push({
      name: "filter_hdr_tonemap",
      status: tonemap ? "pass" : "warn",
      detail: tonemap
        ? "zscale and tonemap available"
        : "zscale or tonemap missing; HDR sources convert without tone mapping",
    });
  } else {
    checks.push({ name: "ffmpeg", status: "fail", detail: toolchainDetail ?? "ffmpeg probe failed" });
  }

  if (cwebp) {
    checks.push({
      name: "cwebp",
      status: "pass",
      detail: `${cwebp.cwebp} ${cwebp.version}${cwebp.fromEnv ? " (SCREENRIG_CWEBP)" : ""}`,
    });
  } else {
    const missing =
      cwebpDetail ?? `${webpLookup.cwebp} not available${webpLookup.cwebpFromEnv ? " (SCREENRIG_CWEBP)" : ""}`;
    if (libwebp === true) {
      checks.push({
        name: "cwebp",
        status: "warn",
        detail: `${missing}; not required because this ffmpeg build has the libwebp encoder`,
      });
    } else if (libwebp === false) {
      checks.push({
        name: "cwebp",
        status: "fail",
        detail:
          `${missing}; this ffmpeg build has no libwebp encoder either, so image transcode cannot produce WebP. ` +
          "Install an ffmpeg built with libwebp, or install cwebp on PATH (or set SCREENRIG_CWEBP).",
      });
    } else {
      checks.push({
        name: "cwebp",
        status: "warn",
        detail: `${missing}; it is the fallback for an ffmpeg build without libwebp, so fix ffmpeg first`,
      });
    }
  }

  const client = clientFor(runtime, args, resolved.apiUrl, resolved.token);
  for (const route of ["/.health", "/.ready", "/.version", "/api/capabilities"] as const) {
    try {
      const response = await client.call({ method: "GET", path: route });
      const name = route === "/api/capabilities" ? "capabilities" : route.slice(2);
      const body = response.body;
      const degraded = route === "/.ready" && body !== null && typeof body === "object"
        && "degraded" in body && Array.isArray(body.degraded) ? body.degraded : [];
      const degradedDetail = route === "/.ready" && body !== null && typeof body === "object"
        && "degraded_detail" in body && body.degraded_detail !== null && typeof body.degraded_detail === "object"
        && !Array.isArray(body.degraded_detail)
        ? (body.degraded_detail as Record<string, unknown>)
        : {};
      const guidance = [...new Set(degraded.map((dependency): string => {
        // The server's degraded_detail sentence is written for a client to show
        // verbatim (for example why app upload will answer 503). Prefer it, bounded
        // and redacted, over the local fallback text.
        const sentence = typeof dependency === "string" ? degradedDetail[dependency] : undefined;
        if (typeof sentence === "string" && sentence.trim().length > 0) {
          return `${dependency}: ${redactedReadinessSentence(sentence)}`;
        }
        switch (dependency) {
          case "application_processing":
            return "application_processing: new applications cannot become ready; ask the service operator to restore application workers, then rerun doctor";
          case "valkey":
            return "valkey: ask the service operator to restore Valkey connectivity, then rerun doctor";
          default:
            // Probe names are server input; do not echo arbitrary values into diagnostics.
            return "another optional dependency is unavailable; ask the service operator to inspect readiness diagnostics, then rerun doctor";
        }
      }))];
      checks.push({
        name,
        status: degraded.length > 0 ? "warn" : "pass",
        detail: `status ${response.status}${guidance.length > 0 ? `; service ready with degraded dependencies. ${guidance.join(". ")}` : ""}`,
      });
      if (route === "/api/capabilities") {
        // Probe feedback support from the advertised feature map rather than
        // assuming the routes exist on every deployment.
        const features = ((response.body ?? {}) as Capabilities).features ?? {};
        const supported = features.feedback === true;
        checks.push({
          name: "feedback",
          // An optional server feature, so its absence is not a local defect.
          status: supported ? "pass" : "warn",
          detail: supported
            ? "server advertises feedback support"
            : "server does not advertise feedback support; feedback commands are unavailable",
        });
      }
    } catch (err) {
      const name = route === "/api/capabilities" ? "capabilities" : route.slice(2);
      // An uploader works only in its playlists and folders: that answer is the credential doing its job.
      if (err instanceof CliError && err.problem.code === "outside_upload_scope") {
        checks.push({ name, status: "pass", detail: "uploader: these playlists and folders" });
        continue;
      }
      const detail = err instanceof CliError ? err.problem.detail : err instanceof Error ? err.message : `${route} failed`;
      checks.push({ name, status: "fail", detail });
    }
  }
  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  const status: DoctorStatus = failed ? "fail" : warned ? "warn" : "pass";
  // `data.next` is the one command that clears the worst row that has one.
  const next = checks.find((check) => check.status === "fail" && check.next)?.next
    ?? checks.find((check) => check.status === "warn" && check.next)?.next;
  return {
    envelope: successEnvelope({ status, checks, version: CLI_VERSION, distribution, ...(next ? { next } : {}) }),
    exitCode: failed ? ExitCode.Unexpected : ExitCode.Success,
    human: checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}${check.next ? `\n  next: ${check.next.command}` : ""}`).join("\n"),
  };
}
