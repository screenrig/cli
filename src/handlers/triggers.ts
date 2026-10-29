// Command handlers for the triggers commands, loaded on demand.
import { readAuthoringJson, readAuthoringText } from "../authoring-input.js";
import { TRIGGER_ID_PATTERN, TRIGGER_MAPPING_MAX_BYTES, TRIGGER_PASSWORD_PATTERN, TRIGGER_SIGNING_SECRET_PATTERN, alertLines, overlayLines, triggerDeliveryTableLines, triggerExample, triggerHoldSeconds, triggerId, triggerLines, triggerMapping, triggerName, triggerPasswordWarning, triggerProblem, triggerScreenIds, triggerSigningWarning, triggerStyle, triggerTableLines, triggerTag } from "../triggers.js";
import { type Trigger, type TriggerDeliveryList, type TriggerList, type TriggerOverlayReceipt, type TriggerPatch, type TriggerPull, type TriggerReceipt, type TriggerTarget, type TriggerWithSecrets, type TriggerWrite } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope, type Warning } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, makeProblem, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { quotedRevision } from "../if-match.js";
import { clientFor, commandHandler, jsonBody, writeRecoveries, type CommandResult } from "../commands.js";


// Triggers: /api/triggers. A CAP trigger takes an emergency system's alerts; an
// overlay trigger takes a few words from any sender and shows them over what
// plays (a bar) or instead of it (a takeover). url and username are not secret;
// the password and the signing secret are returned only by create, rotate-secret
// and the update that turns signing on, printed once, and kept out of the
// operation log (client.ts privateBodies).
export const TRIGGERS_PATH = "/api/triggers";

export async function triggerCall(
  client: ApiClient,
  request: Parameters<ApiClient["call"]>[0],
  id?: string,
): Promise<Awaited<ReturnType<ApiClient["call"]>>> {
  try {
    return await client.call(request);
  } catch (error) {
    throw triggerProblem(error, id);
  }
}

export function triggerRevisionHeaders(args: ParsedArgs): Record<string, string> | undefined {
  const revision = flagString(args.flags, "expect-rev");
  return revision ? { "if-match": quotedRevision(revision) } : undefined;
}

export type TriggerSecretAction = "create" | "rotate" | "update" | "rotate-signing";

/**
 * The answer of a request that issued a secret: create and rotate-secret carry
 * the password (create also the signing secret of a signing overlay trigger), a
 * signing rotation and the update that turns signing on carry the signing secret.
 */
export async function triggerWithSecrets(body: unknown, action: TriggerSecretAction, wantSigning: boolean, runtime: CliRuntime): Promise<TriggerWithSecrets> {
  const trigger = body as TriggerWithSecrets | undefined;
  const passwordOk = typeof trigger?.password === "string" && TRIGGER_PASSWORD_PATTERN.test(trigger.password);
  const signingOk = typeof trigger?.signing_secret === "string" && TRIGGER_SIGNING_SECRET_PATTERN.test(trigger.signing_secret);
  const needPassword = action === "create" || action === "rotate";
  const needSigning = action === "rotate-signing" || (action === "create" && wantSigning);
  if (!trigger || typeof trigger.id !== "string" || (needPassword && !passwordOk) || (needSigning && !signingOk)
    || (trigger.password !== undefined && !passwordOk) || (trigger.signing_secret !== undefined && !signingOk)) {
    await writeRecoveries.get(runtime)?.finish();
    const id = trigger && typeof trigger.id === "string" && TRIGGER_ID_PATTERN.test(trigger.id) ? trigger.id : undefined;
    const signing = action === "rotate-signing" || wantSigning;
    throw new CliError(makeProblem("unexpected_response", "Unexpected response", 502,
      `The ${action === "create" ? "trigger create" : action === "update" ? "trigger update" : "rotate-secret"} request completed, but its answer did not carry the secret it should. Do not rerun it.`, {
        next: id
          ? { command: `screenrig triggers rotate-secret ${id}${signing ? " --signing" : ""}`, reason: "Issue a new secret; it is shown once in the answer." }
          : { command: "screenrig triggers list", reason: "Find the trigger, then run screenrig triggers rotate-secret ID to receive a new secret." },
      }), ExitCode.Unexpected);
  }
  return trigger;
}

export async function triggerSecretResult(
  response: Awaited<ReturnType<ApiClient["call"]>>, client: ApiClient, action: TriggerSecretAction, wantSigning: boolean, runtime: CliRuntime,
): Promise<CommandResult> {
  const trigger = await triggerWithSecrets(response.body, action, wantSigning, runtime);
  const warnings: Warning[] = [];
  if (trigger.password) warnings.push(triggerPasswordWarning(trigger.id, action === "create" ? "create" : "rotate", trigger.kind));
  if (trigger.signing_secret) warnings.push(triggerSigningWarning(trigger.id));
  const overlay = trigger.kind === "overlay";
  const title = action === "create" ? `Created trigger ${trigger.id}`
    : action === "update" ? `Updated trigger ${trigger.id}`
    : action === "rotate-signing" ? `Rotated the signing secret of trigger ${trigger.id}` : `Rotated the password of trigger ${trigger.id}`;
  const lines = [title, ...triggerLines(trigger), ...overlayLines(trigger.overlay)];
  if (trigger.password || trigger.signing_secret) {
    lines.push("", overlay
      ? "Sensitive trigger secrets (enter them only in the system that posts to the url above)"
      : "Sensitive CAP password (enter it only in your emergency notification system, with the url and username above)");
    if (trigger.password) lines.push(`password: ${trigger.password}`);
    if (trigger.signing_secret) lines.push(`signing_secret: ${trigger.signing_secret}`);
    if (overlay) lines.push(`example: ${triggerExample(trigger.url, trigger.overlay?.signing === true)}`);
    for (const warning of warnings) lines.push(`warning: ${warning.message}`);
  }
  return {
    envelope: jsonBody(response, client.requestId, undefined, warnings.length ? warnings : undefined),
    exitCode: ExitCode.Success,
    human: lines.join("\n"),
    ...(trigger.password || trigger.signing_secret ? { keepRecoveryUntilOutput: true } : {}),
  };
}

/** --pull: a JSON object (CapPull) from a file or stdin; the server validates its members. */
export async function triggerPull(file: string, runtime: CliRuntime): Promise<TriggerPull> {
  let parsed: unknown;
  try {
    parsed = await readAuthoringJson(file, runtime);
  } catch (error) {
    throw usageError(`Cannot read the --pull JSON: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw usageError("--pull must hold a JSON object of CAP sources and filters.");
  return parsed as TriggerPull;
}

export function triggerTargetBody(args: ParsedArgs): TriggerTarget | undefined {
  const tag = flagString(args.flags, "tag");
  const screenIds = flagString(args.flags, "screen-id");
  if (tag !== undefined && screenIds !== undefined) throw usageError("Pass --tag TAG or --screen-id ID, not both.");
  if (tag !== undefined) return { tag: triggerTag(tag) };
  if (screenIds !== undefined) return { screen_ids: triggerScreenIds(screenIds).split(",") };
  return undefined;
}

/** The kind-only options of create: usage errors name the kind they need. */
export function triggerOverlayOptionsOnly(args: ParsedArgs, kind: string): void {
  for (const flag of ["show", "edge", "style", "map", "signing"]) {
    const given = flag === "signing" ? flagBool(args.flags, flag) : flagString(args.flags, flag) !== undefined;
    if (given && kind !== "overlay") throw usageError(`--${flag} applies to an overlay trigger: add --kind overlay.`);
  }
}

export const handleTriggersCreate = commandHandler(async (args, runtime, resolved) => {
  const label = triggerName(flagString(args.flags, "name") ?? "");
  const kind = flagString(args.flags, "kind") ?? "cap";
  const target = triggerTargetBody(args);
  if (!target) throw usageError("triggers create takes exactly one of --tag TAG or --screen-id ID.");
  const hold = flagString(args.flags, "for");
  const pullFile = flagString(args.flags, "pull");
  triggerOverlayOptionsOnly(args, kind);
  const signing = flagBool(args.flags, "signing");
  let body: TriggerWrite;
  if (kind === "overlay") {
    if (pullFile !== undefined) throw usageError("--pull applies to a CAP trigger: omit --kind overlay.");
    const show = flagString(args.flags, "show");
    if (show !== "bar" && show !== "takeover") throw usageError("An overlay trigger needs --show bar (a strip over whatever plays) or --show takeover (the alert fills the screen).");
    const edge = flagString(args.flags, "edge");
    if (edge !== undefined && show !== "bar") throw usageError("--edge applies to a bar: use --show bar.");
    const styleFile = flagString(args.flags, "style");
    const mapFile = flagString(args.flags, "map");
    body = {
      kind: "overlay", label, target,
      ...(hold !== undefined ? { default_for_seconds: triggerHoldSeconds(hold, "overlay") } : {}),
      overlay: {
        show,
        ...(edge !== undefined ? { edge: edge as "top" | "bottom" } : {}),
        ...(styleFile !== undefined ? { style: triggerStyle(await readAuthoringText(styleFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
        ...(mapFile !== undefined ? { mapping: triggerMapping(await readAuthoringText(mapFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
        ...(signing ? { signing: true } : {}),
      },
    };
  } else {
    body = {
      label, target,
      ...(hold !== undefined ? { default_for_seconds: triggerHoldSeconds(hold) } : {}),
      ...(pullFile !== undefined ? { pull: await triggerPull(pullFile, runtime) } : {}),
    };
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "POST", path: TRIGGERS_PATH, idempotent: true, body });
  return triggerSecretResult(response, client, "create", signing, runtime);
});

export const handleTriggersUpdate = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "update");
  const name = flagString(args.flags, "name");
  const target = triggerTargetBody(args);
  const hold = flagString(args.flags, "for");
  const pullFile = flagString(args.flags, "pull");
  const edge = flagString(args.flags, "edge");
  const styleFile = flagString(args.flags, "style");
  const mapFile = flagString(args.flags, "map");
  const overlay: NonNullable<TriggerPatch["overlay"]> = {
    ...(edge !== undefined ? { edge: edge as "top" | "bottom" } : {}),
    ...(styleFile !== undefined ? { style: triggerStyle(await readAuthoringText(styleFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
    ...(flagBool(args.flags, "clear-style") ? { style: null } : {}),
    ...(mapFile !== undefined ? { mapping: triggerMapping(await readAuthoringText(mapFile, runtime, TRIGGER_MAPPING_MAX_BYTES)) } : {}),
    ...(flagBool(args.flags, "clear-map") ? { mapping: null } : {}),
    ...(flagBool(args.flags, "enable") ? { enabled: true } : {}),
    ...(flagBool(args.flags, "disable") ? { enabled: false } : {}),
    ...(flagBool(args.flags, "signing") ? { signing: true } : {}),
    ...(flagBool(args.flags, "no-signing") ? { signing: false } : {}),
  };
  const body: TriggerPatch = {
    ...(name !== undefined ? { label: triggerName(name) } : {}),
    ...(target ? { target } : {}),
    // The kind is not known here, so the server holds the 1m floor of a CAP trigger.
    ...(hold !== undefined ? { default_for_seconds: triggerHoldSeconds(hold, "overlay") } : {}),
    ...(pullFile !== undefined ? { pull: await triggerPull(pullFile, runtime) } : {}),
    ...(flagBool(args.flags, "no-pull") ? { pull: null } : {}),
    ...(Object.keys(overlay).length ? { overlay } : {}),
  };
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "PATCH", path: `${TRIGGERS_PATH}/${id}`, idempotent: true, body, headers: triggerRevisionHeaders(args) }, id);
  const trigger = response.body as TriggerWithSecrets | undefined;
  if (trigger?.password !== undefined || trigger?.signing_secret !== undefined) return triggerSecretResult(response, client, "update", flagBool(args.flags, "signing"), runtime);
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Updated trigger ${id}`, ...triggerLines(trigger), ...overlayLines(trigger?.overlay)].join("\n"),
  };
});

export const handleTriggersList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "GET", path: TRIGGERS_PATH });
  const items = (response.body as TriggerList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Triggers (${list.length})`, ...triggerTableLines(list)].join("\n"),
  };
});

export const handleTriggersShow = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "GET", path: `${TRIGGERS_PATH}/${id}` }, id);
  const trigger = response.body as Trigger | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: ["Trigger", ...triggerLines(trigger), ...alertLines(trigger?.alert), ...overlayLines(trigger?.overlay)].join("\n"),
  };
});

export const handleTriggersTest = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "test");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "POST", path: `${TRIGGERS_PATH}/${id}/test`, idempotent: true }, id);
  const receipt = response.body as (TriggerReceipt & Partial<TriggerOverlayReceipt>) | undefined;
  if (receipt && "active" in receipt) {
    return {
      envelope: jsonBody(response, client.requestId),
      exitCode: ExitCode.Success,
      human: receipt.outcome === "shown"
        ? `Showing a test overlay from trigger ${id} ${receipt.until ? `until ${receipt.until}` : "until cleared"}. screenrig triggers show ${id} reports its screens; screenrig triggers clear ${id} ends it sooner.`
        : `Trigger ${id} answered ${receipt.outcome ?? "no outcome"}.`,
    };
  }
  const alert = receipt?.alert;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      alert && receipt?.outcome === "shown"
        ? `Showing an exercise alert from trigger ${id} until ${alert.until}. screenrig triggers show ${id} reports its screens; screenrig triggers clear ${id} ends it sooner.`
        : `Trigger ${id} answered ${receipt?.outcome ?? "no outcome"}.`,
      ...alertLines(alert),
    ].join("\n"),
  };
});

export const handleTriggersClear = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "clear");
  const alertId = flagString(args.flags, "alert-id");
  if (alertId !== undefined && (!alertId.trim() || [...alertId].length > 200)) throw usageError("--alert-id takes the sender's alert id, 1 to 200 characters.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, {
    method: "POST", path: `${TRIGGERS_PATH}/${id}/clear`, idempotent: true, ...(alertId !== undefined ? { body: { alert_id: alertId.trim() } } : {}),
  }, id);
  const trigger = response.body as Trigger | undefined;
  const remaining = trigger?.overlay?.alerts.length ?? 0;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [
      trigger?.overlay
        ? remaining ? `Trigger ${id} still shows ${remaining} alert${remaining === 1 ? "" : "s"}.` : `No alert is active on trigger ${id}. Its bar is lowered, or its screens go back to what they played before.`
        : `No alert is active on trigger ${id}. Screens its alert took over go back to what they played before.`,
      ...triggerLines(trigger),
      ...alertLines(trigger?.alert),
      ...overlayLines(trigger?.overlay),
    ].join("\n"),
  };
});

export const handleTriggersDeliveries = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "deliveries");
  const limit = flagString(args.flags, "limit");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, { method: "GET", path: `${TRIGGERS_PATH}/${id}/deliveries`, ...(limit ? { query: { limit } } : {}) }, id);
  const items = (response.body as TriggerDeliveryList | undefined)?.items;
  const list = Array.isArray(items) ? items : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Deliveries of ${id} (${list.length})`, ...triggerDeliveryTableLines(list)].join("\n"),
  };
});

export const handleTriggersRotateSecret = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "rotate-secret");
  const signing = flagBool(args.flags, "signing");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, {
    method: "POST", path: `${TRIGGERS_PATH}/${id}/rotate-secret`, idempotent: true, headers: triggerRevisionHeaders(args),
    ...(signing ? { body: { signing: true } } : {}),
  }, id);
  return triggerSecretResult(response, client, signing ? "rotate-signing" : "rotate", signing, runtime);
});

export const handleTriggersDelete = commandHandler(async (args, runtime, resolved) => {
  const id = triggerId(args.positionals[2], "delete");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await triggerCall(client, {
    method: "DELETE", path: `${TRIGGERS_PATH}/${id}`, idempotent: true, headers: triggerRevisionHeaders(args),
  }, id);
  return {
    envelope: successEnvelope({ id, deleted: true }, { request_id: response.headers["x-request-id"] ?? client.requestId }),
    exitCode: ExitCode.Success,
    human: `Deleted trigger ${id}. Its URL stopped accepting posts.`,
  };
});
