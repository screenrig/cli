// Command handlers for the invitations commands, loaded on demand.
import { type Invitation, type InvitationIssued } from "../adapters/protocol.js";
import { flagBool, flagString } from "../command-input.js";
import { requireToken } from "../client.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { usageError } from "../problems.js";
import { adsListOption, clientFor, commandHandler, humanLines, isPlainContactEmail, jsonBody, requirePrivateNoStore, uploadScopeFromArgs } from "../commands.js";


/** invitations create targets an existing project and never enrolls as a side effect. */
export function invitationEmail(value: string | undefined): string {
  const email = value?.trim();
  if (!email) {
    throw usageError("invitations create requires --email ADDRESS.");
  }
  if (!isPlainContactEmail(email)) {
    throw usageError("invitations create --email must be one plain ASCII address with an unquoted local part and dotted DNS domain.");
  }
  return email;
}

export const handleInvitationsCreate = commandHandler(async (args, runtime, resolved) => {
  const uploader = flagString(args.flags, "kind") === "uploader";
  const kind = flagString(args.flags, "kind") === "ad-buyer" ? "ad_buyer" : "project_member";
  const link = flagBool(args.flags, "link");
  // A link names no recipient (the server refuses emails with it), so never accept and drop an address.
  if (link && flagString(args.flags, "email") !== undefined) throw usageError("--link cannot be used with --email: a link names no recipient. Use --email to invite by email, or --link alone.");
  const emails = link ? [] : adsListOption(flagString(args.flags, "email"), "email").map(invitationEmail);
  if (!link && (!emails.length || emails.length > 50)) throw usageError("invitations create requires --link, or --email with 1 to 50 addresses.");
  const screenIds = adsListOption(flagString(args.flags, "screen-id"), "screen-id");
  const slotIds = adsListOption(flagString(args.flags, "slot-id"), "slot-id");
  const policy = flagString(args.flags, "policy");
  if (kind === "ad_buyer" && link) throw usageError("--link is available only for member invitations.");
  if (kind === "project_member" && (screenIds.length || slotIds.length || policy !== undefined)) {
    throw usageError("Advertising scope and policy require --kind ad-buyer.");
  }
  if (!uploader && (flagString(args.flags, "folder-id") !== undefined || flagString(args.flags, "playlist-id") !== undefined || flagString(args.flags, "access") !== undefined)) {
    throw usageError("--folder-id, --playlist-id and --access require --kind uploader.");
  }
  const uploadScope = uploader ? uploadScopeFromArgs(args, "invitations create --kind uploader", true) : undefined;
  if (uploadScope?.access !== undefined && uploadScope.access !== "propose" && uploadScope.access !== "manage") throw usageError("--access takes propose or manage.");
  if (kind === "ad_buyer" && !screenIds.length && !slotIds.length) {
    throw usageError("Ad-buyer invitations require at least one --screen-id or --slot-id.");
  }
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({
    method: "POST", path: "/api/invitations", idempotent: true,
    body: { kind, delivery: link ? "link" : "email",
      ...(!link ? { emails } : {}),
      ...(uploadScope ? { upload_scope: uploadScope } : {}),
      ...(kind === "ad_buyer" ? { advertising: { screen_ids: screenIds, slot_ids: slotIds, policy: policy ?? "trusted" } } : {}),
    },
  });
  requirePrivateNoStore(response.headers, "Invitation response");
  const body = response.body as { invitations?: InvitationIssued[] };
  if (!Array.isArray(body?.invitations) || !body.invitations.length || (link && body.invitations.length !== 1)) {
    throw usageError("Invitation response does not match the generated invitation contract.");
  }
  const invitations = body.invitations.map((value) => {
    const invitation = validateInvitation(value);
    if (link) {
      if (typeof value.url !== "string" || !value.url) throw usageError("Link invitation response is missing its URL.");
      return { ...invitation, url: value.url };
    }
    return invitation;
  });
  return {
    envelope: successEnvelope({ invitations }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Invitations created", [
      ["invitations", String(invitations.length)],
      ["delivery", link ? "Deliver this link only to the intended person; do not store or log it." : "Email requested; delivery is not confirmed."],
      ...(link ? [["url", (invitations[0] as InvitationIssued).url] as [string, string]] : []),
    ]),
  };
});

export const handleInvitationsList = commandHandler(async (args, runtime, resolved) => {
  const kind = flagString(args.flags, "kind");
  const status = flagString(args.flags, "status");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/invitations", query: {
    ...(kind ? { kind: kind === "ad-buyer" ? "ad_buyer" : "project_member" } : {}),
    ...(status ? { status } : {}),
  } });
  return { envelope: jsonBody(response, client.requestId), exitCode: ExitCode.Success,
    human: JSON.stringify(response.body, null, 2) };
});

export const handleInvitationsRevoke = commandHandler(async (args, runtime, resolved) => {
  const id = args.positionals[2];
  if (!id) throw usageError("invitations revoke requires ID.");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  // The route answers 204 with no body; report what happened rather than an empty object.
  await client.call({ method: "POST", path: `/api/invitations/${encodeURIComponent(id)}/revoke`, idempotent: true });
  return {
    envelope: successEnvelope({ id, status: "revoked" }, { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines("Invitation revoked", [["id", id], ["status", "revoked"]]),
  };
});

export function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Reject a body that does not match the generated project invitation contract. */
export function validateInvitation(value: unknown): Invitation {
  const invitation = value as Partial<Invitation> | undefined;
  if (!invitation || typeof invitation.id !== "string" || !invitation.id
    || !["project_member", "ad_buyer"].includes(invitation.kind ?? "")
    || !["email", "link"].includes(invitation.delivery ?? "")
    || !["queued", "sent", "issued", "accepted", "revoked", "expired", "failed"].includes(invitation.status ?? "")
    || typeof invitation.project_id !== "string" || !invitation.project_id
    || !isDateTime(invitation.created_at) || !isDateTime(invitation.expires_at)) {
    throw usageError("Invitation response does not match the generated invitation contract.");
  }
  // Project onto the credential-free contract before the explicit link handoff.
  return {
    id: invitation.id, kind: invitation.kind!, delivery: invitation.delivery!, status: invitation.status!,
    project_id: invitation.project_id, created_at: invitation.created_at!, expires_at: invitation.expires_at!,
    ...(invitation.recipient_email ? { recipient_email: invitation.recipient_email } : {}),
    ...(invitation.advertising ? { advertising: invitation.advertising } : {}),
    ...(invitation.upload_scope ? { upload_scope: invitation.upload_scope } : {}),
  };
}
