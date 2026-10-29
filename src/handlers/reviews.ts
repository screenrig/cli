// Command handlers for the reviews commands, loaded on demand.
import { type Review, type ReviewDecisionResult, type ReviewList } from "../adapters/protocol.js";
import { flagString } from "../command-input.js";
import { requireToken } from "../client.js";
import { reviewDetailLines, reviewListLines } from "../reviews.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import { clientFor, commandHandler, jsonBody } from "../commands.js";


// Reviews of proposed changes: /api/reviews. Agents read them and withdraw
// their own proposals; only a person approves, rejects or asks for changes.
export const REVIEW_LIST_MAX = 100;

export const handleReviewsList = commandHandler(async (args, runtime, resolved) => {
  const limit = flagString(args.flags, "limit");
  if (limit !== undefined && Number(limit) > REVIEW_LIST_MAX) throw usageError(`--limit must be at most ${REVIEW_LIST_MAX}.`);
  const state = flagString(args.flags, "state");
  const kind = flagString(args.flags, "kind");
  const cursor = flagString(args.flags, "cursor");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/reviews", query: { state, kind, limit, cursor } });
  const page = (response.body ?? {}) as ReviewList;
  const next = typeof page.next_cursor === "string" && page.next_cursor ? page.next_cursor : undefined;
  const nextArgv = next ? ["reviews", "list", ...(state ? ["--state", state] : []), ...(kind ? ["--kind", kind] : []), ...(limit ? ["--limit", limit] : []), "--cursor", next] : undefined;
  return {
    envelope: jsonBody(response, client.requestId, nextArgv ? { next: { command: `screenrig ${nextArgv.join(" ")}`, argv: nextArgv, reason: "Read the next page of reviews." } } : undefined),
    exitCode: ExitCode.Success,
    human: [...reviewListLines(page), ...(nextArgv ? [`next: screenrig ${nextArgv.join(" ")}`] : [])].join("\n"),
  };
});

export const handleReviewsShow = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("reviews show requires <review-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/reviews/${encodeURIComponent(id)}` });
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: reviewDetailLines(response.body as Review).join("\n"),
  };
});

export const handleReviewsWithdraw = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("reviews withdraw requires <review-id>.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "POST", path: `/api/reviews/${encodeURIComponent(id)}/withdraw`, idempotent: true });
  const result = response.body as ReviewDecisionResult | undefined;
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: [`Withdrew review ${id}; nothing it proposed reaches the screens.`, ...(result?.review ? reviewDetailLines(result.review).slice(1) : [])].join("\n"),
  };
});
