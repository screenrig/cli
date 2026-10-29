// Command handlers for the support commands, loaded on demand.
import { formatResultContext } from "../project-context.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../command-input.js";
import { projectStreamQuery } from "../project-routing.js";
import { requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { CliError, unexpectedResponseError, usageError } from "../problems.js";
import { parseSse } from "../sse.js";
import { redactEvent, redactText } from "../redact.js";
import { EVENT_STREAM_BACKOFF_CAP_MS, EVENT_STREAM_BACKOFF_MS, clientFor, commandHandler, isAbortError, isHardFollowError, jsonBody, readFeedbackBody, sleepWhileOpen, streamEnvelope, streamToken, transportFor } from "../commands.js";


// Support messages are deliberately kept out of operation-log bodies.
export const handleSupportStatus = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/support/status" });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: JSON.stringify(response.body, null, 2) };
});

export function supportConversation(args: ParsedArgs, required = false): string | undefined {
  const id = flagString(args.flags, "conversation-id");
  if ((required && !id) || (id && !/^sc_[A-Za-z0-9_-]+$/.test(id))) throw usageError("Supply a valid --conversation-id.");
  return id;
}
export function supportSequence(value: string | undefined): string | undefined {
  if (value !== undefined && !/^\d+$/.test(value)) throw usageError("Support sequences must be nonnegative integers.");
  if (value !== undefined && !Number.isSafeInteger(Number(value))) throw usageError("Support sequence is out of range.");
  return value;
}
export const handleSupportSubmit = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args);
  const body = (await readFeedbackBody(args, runtime)).trim();
  if (!body || [...body].length > 4000) throw usageError("A support message must contain 1–4000 characters.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: id ? `/api/support/conversations/${id}/messages` : "/api/support/conversations", idempotent: true, body: { body, human_requested: flagBool(args.flags, "human-requested") } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: JSON.stringify(response.body, null, 2) };
});
export const handleSupportHistory = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args);
  const after = supportSequence(flagString(args.flags, "after"));
  if (after && !id) throw usageError("--after requires --conversation-id.");
  const before = flagString(args.flags, "before");
  if (before && (id || !/^sc_[A-Za-z0-9_-]+$/.test(before))) throw usageError("--before accepts a conversation cursor when listing conversations.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: id ? `/api/support/conversations/${id}/messages` : "/api/support/conversations", query: { after, before } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: JSON.stringify(response.body, null, 2) };
});
export const handleSupportClose = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args, true)!;
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `/api/support/conversations/${id}/close`, body: {} });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: "Support conversation ended. Its history is saved." };
});
export const handleSupportRead = commandHandler(async (args, runtime, resolved) => {
  const id = supportConversation(args, true)!;
  const sequence = supportSequence(flagString(args.flags, "sequence"));
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "PUT", path: `/api/support/conversations/${id}/read`, body: { sequence: Number(sequence) } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success, human: "Support replies marked read." };
});
export const handleSupportFollow = commandHandler(async (args, runtime, resolved) => {
  const selected = supportConversation(args);
  let after = supportSequence(flagString(args.flags, "after")) ?? "0";
  let token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const transport = transportFor(runtime, resolved.apiUrl, token);
  const controller = new AbortController();
  const timeout = flagNumber(args.flags, "timeout");
  const timer = timeout && timeout > 0 ? setTimeout(() => controller.abort(), timeout) : undefined;
  let delay = EVENT_STREAM_BACKOFF_MS;
  let printedContext = false;
  try {
    while (!controller.signal.aborted) {
      let buffer = "";
      try {
        token = await streamToken(runtime, token);
        const stream = await transport.stream({ method: "GET", path: "/stream/support", query: { after, ...projectStreamQuery(resolved.projectId) }, headers: { authorization: `Bearer ${token}`, "x-request-id": client.nextRequestId() }, signal: controller.signal });
        for await (const chunk of stream) {
          buffer += chunk;
          const parsed = parseSse(buffer); buffer = parsed.rest;
          if (buffer.length > 128 * 1024 || parsed.events.some((frame) => (frame.data?.length ?? 0) > 128 * 1024)) throw unexpectedResponseError("Support stream frame exceeded its size limit.");
          for (const frame of parsed.events) {
            if (frame.event !== "support.message" || !frame.data) continue;
            let message: { conversation_id: string; sequence: number; author: string; body: string };
            try { message = JSON.parse(frame.data); } catch { throw unexpectedResponseError("Support stream sent invalid JSON."); }
            if (!message || typeof message.body !== "string" || typeof message.author !== "string" || typeof message.conversation_id !== "string") throw unexpectedResponseError("Support stream sent an invalid message.");
            if (!frame.id || !/^\d+$/.test(frame.id) || !Number.isSafeInteger(message.sequence) || String(message.sequence) !== frame.id) throw unexpectedResponseError("Support stream sent an invalid sequence.");
            if (BigInt(frame.id) <= BigInt(after)) continue;
            after = frame.id;
            if (selected && message.conversation_id !== selected) continue;
            if (flagBool(args.flags, "human") && !printedContext) {
              if (formatResultContext(runtime)) runtime.stdout.write(`${formatResultContext(runtime)}\n`);
              printedContext = true;
            }
            runtime.stdout.write(flagBool(args.flags, "human") ? `${message.author}: ${redactText(message.body)}\n` : `${JSON.stringify(streamEnvelope(runtime, redactEvent(message), client.requestId))}\n`);
          }
          delay = EVENT_STREAM_BACKOFF_MS;
          if (controller.signal.aborted) break;
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) break;
        if (isHardFollowError(error) || (error instanceof CliError && error.problem.code === "unexpected_response")) throw error;
      }
      if (!controller.signal.aborted) await sleepWhileOpen(delay, controller.signal, runtime.sleep);
      delay = Math.min(delay * 2, EVENT_STREAM_BACKOFF_CAP_MS);
    }
  } finally { if (timer) clearTimeout(timer); }
  return { envelope: successEnvelope({ after }, { request_id: client.requestId }), exitCode: ExitCode.Success, human: "", output: "stream" };
});
