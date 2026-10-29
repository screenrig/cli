// Command handlers for the billing commands, loaded on demand.
import { flagString } from "../command-input.js";
import { requireToken } from "../client.js";
import { ExitCode } from "../exit-codes.js";
import { clientFor, commandHandler, humanLines, jsonBody, requirePrivateNoStore, simpleGet } from "../commands.js";


/**
 * Read this project's shared balance. The withdrawal section is reported as the
 * server states it: while payment rails are unconfigured the balance explains
 * that plainly instead of implying a payout path or a second wallet.
 */
export const handleBillingBalance = commandHandler(async (args, runtime, resolved) => {
  const token = requireToken(resolved.token);
  const client = clientFor(runtime, args, resolved.apiUrl, token);
  const response = await client.call({ method: "GET", path: "/api/billing/balance" });
  requirePrivateNoStore(response.headers, "Billing balance response");
  const body = (response.body ?? {}) as {
    remaining_mcr?: unknown; reserved_mcr?: unknown; available_mcr?: unknown;
    withdrawal?: { allowed?: unknown; eligible_earned_mcr?: unknown; rails_available?: unknown; unavailable_reason?: unknown; blockers?: unknown };
  };
  const withdrawal = body.withdrawal ?? {};
  const blockers = Array.isArray(withdrawal.blockers) ? withdrawal.blockers.filter((item): item is string => typeof item === "string") : [];
  return {
    envelope: jsonBody(response, client.requestId),
    exitCode: ExitCode.Success,
    human: humanLines("Credit balance", [
      ["remaining_mcr", typeof body.remaining_mcr === "string" ? body.remaining_mcr : undefined],
      ["reserved_mcr", typeof body.reserved_mcr === "string" ? body.reserved_mcr : undefined],
      ["available_mcr", typeof body.available_mcr === "string" ? body.available_mcr : undefined],
      ["withdrawal_allowed", withdrawal.allowed === undefined ? undefined : String(withdrawal.allowed)],
      ["eligible_earned_mcr", typeof withdrawal.eligible_earned_mcr === "string" ? withdrawal.eligible_earned_mcr : undefined],
      ["rails", withdrawal.rails_available === false
        ? `unavailable (${typeof withdrawal.unavailable_reason === "string" ? withdrawal.unavailable_reason : "no payment rail"}); credits are spent in the dashboard and no payout can be requested from this CLI`
        : withdrawal.rails_available === true ? "available to the verified financial administrator in the dashboard" : undefined],
      ["blockers", blockers.length > 0 ? blockers.join(", ") : undefined],
      ["note", "purchased credits are not withdrawable, and promotional or included grants cannot fund paid ad spend"],
    ]),
  };
});

export const handleBillingStatement = commandHandler((args, runtime, resolved) =>
  simpleGet(args, runtime, resolved, "/api/billing/statement", "Credit statement", {
    cursor: flagString(args.flags, "cursor"),
    limit: flagString(args.flags, "limit"),
  }));
