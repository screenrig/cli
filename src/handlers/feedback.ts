// Command handlers for the feedback commands, loaded on demand.
import { type FeedbackContext, type FeedbackKind, type FeedbackList, type FeedbackSubmission, type FeedbackWrite } from "../adapters/protocol.js";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { ApiClient, requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { redactText } from "../redact.js";
import { CLI_VERSION } from "../version.js";
import { clientFor, commandHandler, humanLines, jsonBody, readFeedbackBody, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


/**
 * The submission kind comes from the route, never from the request body, so the
 * CLI action selects the path and nothing in the payload can contradict it.
 */
export const FEEDBACK_PATHS: Record<FeedbackKind, string> = {
  bug: "/api/feedback/bugs",
  feature: "/api/feedback/features",
};

/**
 * Exactly the contract pattern for `FeedbackContext.command`: up to four
 * lowercase words. It admits no flag, no uppercase, no separator, and no
 * punctuation, so an argument value cannot survive it.
 */
export const FEEDBACK_COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}( [a-z][a-z0-9-]{0,31}){0,3}$/;
export const FEEDBACK_TITLE_MAX = 120;
export const FEEDBACK_BODY_MAX = 4000;

/**
 * Built from the resolved command surface only. Nothing here is derived from
 * raw argv, so no argument value, path, identifier, or credential can reach the
 * server through the diagnostic envelope.
 */
export function feedbackContextFromArgs(
  args: ParsedArgs,
  platform: string,
): FeedbackContext | undefined {
  if (flagBool(args.flags, "no-context")) {
    return undefined;
  }
  const context: FeedbackContext = { cli_version: CLI_VERSION };
  if (/^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/.test(platform)) {
    context.platform = platform;
  }
  // `--command --json` parses as a valueless flag. Fail rather than silently
  // dropping the context the caller asked for.
  if (args.flags.command === true) {
    throw usageError('--command requires a value, such as --command "media upload".');
  }
  // Validated exactly as supplied. Normalizing first would let an uppercase
  // argument value such as "screen pair ABC234" be lowercased into a shape the
  // pattern accepts, which is precisely the leak the closed envelope prevents.
  const command = flagString(args.flags, "command")?.trim();
  if (command !== undefined) {
    if (!FEEDBACK_COMMAND_PATTERN.test(command)) {
      throw usageError(
        "--command accepts a command path only, as up to four lowercase words such as " +
          '"media upload". Option flags, identifiers, file paths, and argument values are rejected ' +
          "by the server and must not be placed here.",
      );
    }
    context.command = command;
  }
  return context;
}

export const handleFeedbackList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  return feedbackList(args, client);
});

export const handleFeedbackBug = commandHandler((args, runtime, resolved) => submitFeedback(args, runtime, resolved, "bug"));
export const handleFeedbackFeature = commandHandler((args, runtime, resolved) => submitFeedback(args, runtime, resolved, "feature"));

export function feedbackID(args: ParsedArgs): string {
  const id = args.positionals[2];
  if (!id || !/^(?:(?:stage|qa|development)_)?fb_[A-Za-z0-9_-]{16,24}$/.test(id)) throw usageError("Supply a feedback ID from feedback list.");
  return id;
}

export function feedbackThreadHuman(item: FeedbackSubmission): string {
  return [
    `${item.id}  ${item.status ?? "open"}  ${redactText(item.title)}`,
    redactText(item.body),
    ...(item.responses ?? []).map(reply => `${reply.created_at}  ${reply.author === "agent" ? "Agent" : "Staff"}  ${reply.status}${reply.fixed_in ? ` in ${reply.fixed_in}` : ""}\n${redactText(reply.text)}`),
  ].join("\n\n");
}

export const handleFeedbackShow = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/feedback/${feedbackID(args)}` });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: feedbackThreadHuman(response.body as FeedbackSubmission) };
});

export const handleFeedbackReply = commandHandler(async (args, runtime, resolved) => {
  const id = feedbackID(args);
  const text = (await readFeedbackBody(args, runtime)).trim();
  if (!text || [...text].length > 2000) throw usageError("A feedback reply must be 1 to 2000 characters.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `/api/feedback/${id}/responses`, body: { text }, idempotent: true });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: feedbackThreadHuman(response.body as FeedbackSubmission) };
});

export async function submitFeedback(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, kind: FeedbackKind): Promise<CommandResult> {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);

  const title = args.positionals[2]?.trim();
  if (!title) {
    throw usageError(`feedback ${kind} requires a title.`);
  }
  if (title.length > FEEDBACK_TITLE_MAX) {
    throw usageError(`A feedback title is at most ${FEEDBACK_TITLE_MAX} characters.`);
  }
  const body = (await readFeedbackBody(args, runtime)).trim();
  if (!body) {
    throw usageError("A feedback body must not be empty.");
  }
  if (body.length > FEEDBACK_BODY_MAX) {
    throw usageError(`A feedback body is at most ${FEEDBACK_BODY_MAX} characters.`);
  }

  const context = feedbackContextFromArgs(args, `${process.platform}/${process.arch}`);
  const payload: FeedbackWrite = { title, body, ...(context ? { context } : {}) };

  // Submissions are immutable and the server deduplicates an exact retry under
  // the same key for 24 hours, so the ordinary idempotency key is what makes a
  // retry safe rather than duplicating a report.
  const response = await client.call({
    method: "POST",
    path: FEEDBACK_PATHS[kind],
    idempotent: true,
    body: payload,
  });
  const submission = response.body as FeedbackSubmission;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines(kind === "bug" ? "Bug report submitted" : "Feature request submitted", [
      ["id", submission?.id],
      ["kind", submission?.kind],
      ["title", submission?.title],
      ["created_at", submission?.created_at],
      ["note", `Add details with screenrig feedback reply ${submission?.id} --body TEXT.`],
    ]),
  };
}

/**
 * The human view of staff responses: the latest reply under its submission,
 * one line, with the fixing version when staff named one. The full list, in
 * order, is `responses` in the JSON envelope.
 */
export function feedbackReplyLines(item: FeedbackSubmission): string[] {
  const reply = item.responses?.at(-1);
  if (!reply) return [];
  const text = redactText(reply.text).replace(/\s+/g, " ").trim();
  const shown = text.length > 200 ? `${text.slice(0, 199)}…` : text;
  const fixed = reply.fixed_in ? ` in ${reply.fixed_in}` : "";
  return [`    ${reply.author === "agent" ? "agent · " : ""}${reply.status}${fixed}: ${shown}`];
}

export async function feedbackList(args: ParsedArgs, client: ApiClient): Promise<CommandResult> {
  const kindFlag = flagString(args.flags, "kind")?.toLowerCase();
  if (kindFlag !== undefined && kindFlag !== "bug" && kindFlag !== "feature") {
    throw usageError("--kind accepts bug or feature.");
  }
  const kinds: FeedbackKind[] = kindFlag ? [kindFlag as FeedbackKind] : ["bug", "feature"];

  const items: FeedbackSubmission[] = [];
  for (const kind of kinds) {
    const response = await client.call({ method: "GET", path: FEEDBACK_PATHS[kind] });
    const page = (response.body ?? {}) as FeedbackList;
    // The route already fixes the kind; keep it on each item so a merged list
    // stays unambiguous even when the server omits it.
    for (const item of page.items ?? []) {
      items.push({ ...item, kind: item.kind ?? kind });
    }
  }
  items.sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0));

  return {
    envelope: successEnvelope({ items }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human:
      items.length === 0
        ? "No feedback submissions"
        : [
            `Feedback submissions (${items.length})`,
            ...items.flatMap((item) => [
              `${item.created_at}  ${item.kind.padEnd(7)}  ${item.id}  ${(item.status ?? "open").padEnd(9)}  ${item.title}`,
              ...feedbackReplyLines(item),
            ]),
          ].join("\n"),
  };
}
