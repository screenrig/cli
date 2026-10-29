// Command handlers for the service-client commands, loaded on demand.
import { open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { flagBool, flagString, type ParsedArgs } from "../command-input.js";
import { requireToken } from "../client.js";
import { accessLabel, isServiceClientId, readKeyFile, type AccessLevel } from "../oauth.js";
import { accessFields } from "../reviews.js";
import { successEnvelope } from "../envelope.js";
import { ExitCode } from "../exit-codes.js";
import { fileError, unexpectedResponseError, usageError } from "../problems.js";
import type { CliRuntime } from "../runtime.js";
import { clientFor, commandHandler, humanLines, uploadScopeFromArgs, type CommandResult, type ResolvedCommandConfig } from "../commands.js";


export interface ServiceClientView {
  id: string;
  name: string;
  access: AccessLevel;
  effective_access?: AccessLevel;
  access_limited_by?: "project" | "person";
  state: "active" | "revoked";
  capabilities: string[];
  keys: Array<{ kid: string; alg: string }>;
  secrets: Array<{ id: string; hint: string }>;
  last_used_at?: string;
  upload_scope?: { playlist_ids: string[]; folder_ids: string[] };
}

export function serviceClientId(args: ParsedArgs, verb: string): string {
  const id = args.positionals[2];
  if (!isServiceClientId(id)) throw usageError(`service-client ${verb} requires a service client id (scl_...) from service-client list.`);
  return id;
}

export function serviceClientLines(client: ServiceClientView): Array<[string, string | undefined]> {
  return [
    ["id", client.id],
    ["name", client.name],
    ...accessFields(client).lines,
    ["state", client.state],
    ["capabilities", client.capabilities.join(", ")],
    ["keys", client.keys.map((key) => `${key.kid} (${key.alg})`).join(", ") || undefined],
    ["secrets", client.secrets.map((secret) => `${secret.id} (…${secret.hint})`).join(", ") || undefined],
    ["last_used_at", client.last_used_at],
    ...(client.upload_scope ? [["uploader", `folders ${client.upload_scope.folder_ids.join(", ")}; playlists ${client.upload_scope.playlist_ids.join(", ") || "none"}`] as [string, string]] : []),
  ];
}

/** A public JWK from --key-file; a private key file contributes only its public half. */
export async function serviceKeyFromFile(args: ParsedArgs, runtime: CliRuntime): Promise<Record<string, unknown> | undefined> {
  const file = flagString(args.flags, "key-file");
  if (file === undefined) return undefined;
  let text: string;
  try { text = await readFile(path.resolve(runtime.cwd(), file), "utf8"); } catch (error) { throw fileError(`Cannot read --key-file ${file}.`, error); }
  return (await readKeyFile(text)).publicKey as Record<string, unknown>;
}

/**
 * A new secret goes to a new 0600 file, never to stdout. The file is created
 * before the request, so an unwritable path fails before a secret exists. The
 * handle that created it stays open and receives the secret, so a path swapped
 * for a link or another file in the meantime is never written through.
 */
export async function reserveSecretFile(args: ParsedArgs, runtime: CliRuntime): Promise<{ path: string; write(secret: string): Promise<void>; discard(): Promise<void> } | undefined> {
  const file = flagString(args.flags, "secret-file");
  if (file === undefined) return undefined;
  const target = path.resolve(runtime.cwd(), file);
  let handle;
  try { handle = await open(target, "wx", 0o600); } catch (error) { throw fileError(`Cannot create --secret-file ${file}; it must not exist yet.`, error); }
  return {
    path: target,
    write: async (secret) => {
      try { await handle.writeFile(`${secret}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    },
    discard: async () => {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
    },
  };
}

export async function serviceClientWrite(args: ParsedArgs, runtime: CliRuntime, resolved: ResolvedCommandConfig, request: { path: string; body?: Record<string, unknown>; title: string },
  secretFile?: Awaited<ReturnType<typeof reserveSecretFile>>): Promise<CommandResult> {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  let response;
  try {
    response = await client.call({ method: "POST", path: request.path, ...(request.body ? { body: request.body } : {}) });
  } catch (error) {
    await secretFile?.discard();
    throw error;
  }
  const result = response.body as { client: ServiceClientView; secret?: string; propagation?: string };
  if (secretFile) {
    if (typeof result.secret !== "string") {
      await secretFile.discard();
      throw unexpectedResponseError("The server created no secret.", client.requestId);
    }
    try {
      await secretFile.write(result.secret);
    } catch (error) {
      throw fileError(`The secret was created but could not be written to ${secretFile.path}. Remove it with service-client remove-secret and add another.`, error);
    }
  }
  return {
    envelope: successEnvelope({ client: result.client, ...(secretFile ? { secret_file: secretFile.path } : {}), ...(result.propagation ? { propagation: result.propagation } : {}) },
      { request_id: client.requestId }),
    exitCode: ExitCode.Success,
    human: humanLines(request.title, [...serviceClientLines(result.client), ["secret_file", secretFile?.path], ["propagation", result.propagation]]),
  };
}

export const handleServiceClientList = commandHandler(async (args, runtime, resolved) => {
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: "/api/service-clients" });
  const items = (response.body as { items?: ServiceClientView[] }).items ?? [];
  return { envelope: successEnvelope({ items }, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: items.map((item) => `${item.id}  ${item.name}  ${accessLabel(item.access)}${item.effective_access && item.effective_access !== item.access ? ` (acts as ${accessLabel(item.effective_access)})` : ""}  ${item.state}`).join("\n") || "No service clients." };
});

export const handleServiceClientShow = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "show");
  const client = clientFor(runtime, args, resolved.apiUrl, requireToken(resolved.token));
  const response = await client.call({ method: "GET", path: `/api/service-clients/${id}` });
  return { envelope: successEnvelope(response.body, { request_id: client.requestId }), exitCode: ExitCode.Success,
    human: humanLines("Service client", serviceClientLines(response.body as ServiceClientView)) };
});

export const handleServiceClientCreate = commandHandler(async (args, runtime, resolved) => {
  const name = flagString(args.flags, "name");
  if (!name || name.length > 80) throw usageError("service-client create requires --name with 1-80 characters.");
  const key = await serviceKeyFromFile(args, runtime);
  if (!key && flagString(args.flags, "secret-file") === undefined) {
    throw usageError("service-client create needs --key-file PATH (a public key, recommended) or --secret-file PATH (a generated secret), or both.");
  }
  const capabilities = flagString(args.flags, "capability")?.split(",");
  const access = flagString(args.flags, "access");
  const uploader = flagBool(args.flags, "uploader");
  if (!uploader && (flagString(args.flags, "folder-id") !== undefined || flagString(args.flags, "playlist-id") !== undefined)) {
    throw usageError("--folder-id and --playlist-id require --uploader.");
  }
  if (uploader && capabilities?.some((capability) => capability !== "content" && capability !== "playlists")) {
    throw usageError("An uploader client holds the content and playlists capabilities only.");
  }
  // The client's own access applies to an uploader client (Propose unless chosen), so --access is not part of the scope.
  const scope = uploader ? uploadScopeFromArgs(args, "service-client create --uploader", false) : undefined;
  const secretFile = await reserveSecretFile(args, runtime);
  return serviceClientWrite(args, runtime, resolved, { path: "/api/service-clients", title: "Service client created", body: {
    name, ...(capabilities ? { capabilities } : {}), ...(access ? { access } : {}), ...(key ? { key } : {}), ...(secretFile ? { secret: true } : {}),
    ...(scope ? { upload_scope: scope } : {}),
  } }, secretFile);
});

export const handleServiceClientAddKey = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "add-key");
  const key = await serviceKeyFromFile(args, runtime);
  if (!key) throw usageError("service-client add-key requires --key-file PATH.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/keys`, body: { key }, title: "Key added" });
});

export const handleServiceClientAddSecret = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "add-secret");
  if (flagString(args.flags, "secret-file") === undefined) throw usageError("service-client add-secret requires --secret-file PATH; the secret is written only there.");
  const secretFile = await reserveSecretFile(args, runtime);
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/secrets`, title: "Secret added" }, secretFile);
});

export const handleServiceClientRemoveKey = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "remove-key");
  const kid = flagString(args.flags, "kid");
  if (!kid || kid.length > 200) throw usageError("service-client remove-key requires --kid KID from service-client show.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/keys/${encodeURIComponent(kid)}/remove`, title: "Key removed" });
});

export const handleServiceClientRemoveSecret = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "remove-secret");
  const secretId = flagString(args.flags, "secret-id");
  if (!secretId || !/^css_[A-Za-z0-9_-]+$/.test(secretId)) throw usageError("service-client remove-secret requires --secret-id css_... from service-client show.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/secrets/${secretId}/remove`, title: "Secret removed" });
});

export const handleServiceClientRevoke = commandHandler(async (args, runtime, resolved) => {
  const id = serviceClientId(args, "revoke");
  if (!flagBool(args.flags, "yes")) throw usageError("service-client revoke requires --yes. Revocation is permanent: the client's keys and secrets are deleted and its tokens end.");
  return serviceClientWrite(args, runtime, resolved, { path: `/api/service-clients/${id}/revoke`, title: "Service client revoked" });
});
