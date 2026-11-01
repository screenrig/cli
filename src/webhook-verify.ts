import { readAuthoringText } from "./authoring-input.js";
import { flagBool, flagString, type ParsedArgs } from "./command-input.js";
import { usageError } from "./problems.js";
import type { CliRuntime } from "./runtime.js";
import type { WebhookHandshake, WebhookVerify, WebhookVerifyVendor, WebhookVerifyWrite } from "./adapters/protocol.js";

// Vendor signatures and handshakes of the inbound webhooks: a card webhook
// (kv webhook) and an overlay trigger (triggers) take posts straight from the
// vendors, with no relay. verify names the vendor whose own signature
// authenticates a post in place of the webhook's secret; handshake names the
// challenge a vendor makes before it sends anything.

/** WebhookVerifyVendor (vendor/openapi.yaml). */
export const WEBHOOK_VERIFY_VENDORS = ["github", "stripe", "shopify", "slack", "linear", "vercel", "asana", "generic_hmac"] as const;
/** WebhookHandshake (vendor/openapi.yaml). */
export const WEBHOOK_HANDSHAKES = ["microsoft_graph", "monday", "trello", "azure_event_grid"] as const;
export const WEBHOOK_VERIFY_ENCODINGS = ["hex", "base64"] as const;
/** WebhookVerifyWrite.secret is at most 512 characters; a secret file is far smaller than this. */
const SECRET_FILE_MAX_BYTES = 4096;
const SECRET_MAX_CHARACTERS = 512;
/** WebhookVerifyWrite.header and timestamp_header. */
const HEADER_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const WEBHOOK_VERIFY_TOLERANCE_MIN_S = 1;
export const WEBHOOK_VERIFY_TOLERANCE_MAX_S = 86_400;

/** The flags a card webhook and an overlay trigger share, as option attribute names. */
export const VERIFY_FLAGS = ["verify", "verify-secret-file", "verify-header", "verify-encoding", "verify-timestamp-header", "verify-tolerance", "handshake", "clear-verify", "clear-handshake"] as const;

/** --verify-header and --verify-timestamp-header: the header name a sender uses. */
export function verifyHeaderOption(flag: string): (value: string) => string {
  return (value) => {
    if (!HEADER_PATTERN.test(value)) throw usageError(`${flag} takes a header name of 1 to 100 letters, digits, - or _, such as X-Acme-Signature.`);
    return value;
  };
}

/** --verify-tolerance: whole seconds, 1 to 86400. */
export function verifyToleranceOption(value: string): string {
  if (!/^\d+$/.test(value) || Number(value) < WEBHOOK_VERIFY_TOLERANCE_MIN_S || Number(value) > WEBHOOK_VERIFY_TOLERANCE_MAX_S) {
    throw usageError(`--verify-tolerance takes whole seconds from ${WEBHOOK_VERIFY_TOLERANCE_MIN_S} to ${WEBHOOK_VERIFY_TOLERANCE_MAX_S}, such as 300.`);
  }
  return value;
}

/**
 * The vendor's shared secret from a file or stdin. Only the line ending a shell
 * or editor leaves is dropped: a generic sender's secret may hold spaces, and
 * the key of every HMAC is the secret's bytes exactly as the vendor shows them.
 */
export async function readVerifySecret(file: string, runtime: CliRuntime): Promise<string> {
  const where = file === "-" ? "stdin" : file;
  const secret = (await readAuthoringText(file, runtime, SECRET_FILE_MAX_BYTES)).replace(/(?:\r?\n)+$/, "");
  if (!secret.trim()) throw usageError(`${where} holds no secret.`);
  if (/\p{Cc}/u.test(secret)) throw usageError(`${where} must hold only the vendor's secret: one line of text without control characters.`);
  if ([...secret].length > SECRET_MAX_CHARACTERS) throw usageError(`The secret in ${where} is longer than ${SECRET_MAX_CHARACTERS} characters.`);
  return secret;
}

/** The long names of the vendor flags a command was given, for a command that has no use for them. */
export function verifyFlagsGiven(args: ParsedArgs): string[] {
  return VERIFY_FLAGS.filter((name) => args.flags[name] !== undefined).map((name) => `--${name}`);
}

/** One stdin serves one option: a second `-` would read an empty stream. */
export function singleStdin(inputs: ReadonlyArray<readonly [flag: string, value: string | undefined]>): void {
  const reading = inputs.filter(([, value]) => value === "-").map(([flag]) => flag);
  if (reading.length > 1) throw usageError(`${reading.join(" and ")} cannot both read stdin: give one of them a file.`);
}

export interface VerifyMembers {
  /** The verify member of the request: the verification to set, or null to remove it. */
  verify?: WebhookVerifyWrite | null;
  /** The handshake member of the request: the handshake to answer, or null to remove it. */
  handshake?: WebhookHandshake | null;
}

/**
 * The verify and handshake members the flags ask for. `create` is true for a
 * request that makes the webhook, where every vendor but asana needs its secret;
 * an update that keeps the vendor may leave it out, and the server keeps the
 * stored one. `subject` names what the flags apply to in an error.
 */
export async function verifyMembers(args: ParsedArgs, runtime: CliRuntime, options: { create: boolean; subject: string }): Promise<VerifyMembers> {
  const members: VerifyMembers = {};
  const vendor = flagString(args.flags, "verify") as WebhookVerifyVendor | undefined;
  const secretFile = flagString(args.flags, "verify-secret-file");
  const header = flagString(args.flags, "verify-header");
  const encoding = flagString(args.flags, "verify-encoding");
  const timestampHeader = flagString(args.flags, "verify-timestamp-header");
  const tolerance = flagString(args.flags, "verify-tolerance");
  const handshake = flagString(args.flags, "handshake") as WebhookHandshake | undefined;
  if (flagBool(args.flags, "clear-verify")) members.verify = null;
  if (flagBool(args.flags, "clear-handshake")) members.handshake = null;
  if (handshake !== undefined) members.handshake = handshake;
  if (vendor === undefined) {
    const stray = (["verify-secret-file", "verify-header", "verify-encoding", "verify-timestamp-header", "verify-tolerance"] as const).find((name) => flagString(args.flags, name) !== undefined);
    if (stray !== undefined) throw usageError(`--${stray} describes the vendor named by --verify: add --verify VENDOR.`);
    return members;
  }
  const generic = vendor === "generic_hmac";
  if (!generic) {
    const stray = ([["verify-header", header], ["verify-encoding", encoding], ["verify-timestamp-header", timestampHeader], ["verify-tolerance", tolerance]] as const).find(([, value]) => value !== undefined);
    if (stray) throw usageError(`--${stray[0]} applies to --verify generic_hmac, the sender that signs with an HMAC of your choosing.`);
  } else if (header === undefined) {
    throw usageError("--verify generic_hmac needs --verify-header NAME: the header that carries the signature.");
  }
  if (tolerance !== undefined && timestampHeader === undefined) throw usageError("--verify-tolerance applies with --verify-timestamp-header: it is how far the timestamp may sit from the server's clock.");
  if (vendor === "asana") {
    if (secretFile !== undefined) throw usageError("--verify asana takes no secret: Asana's handshake delivers it when the webhook is created at Asana, and screenRIG keeps it sealed.");
  } else if (secretFile === undefined && options.create) {
    throw usageError(`--verify ${vendor} needs --verify-secret-file FILE (or - for stdin): the secret ${generic ? "your sender signs with" : `${vendorName(vendor)} shows`}, so ${options.subject} can check its signature.`);
  }
  members.verify = {
    vendor,
    ...(secretFile !== undefined ? { secret: await readVerifySecret(secretFile, runtime) } : {}),
    ...(header !== undefined ? { header } : {}),
    ...(encoding !== undefined ? { encoding: encoding as "hex" | "base64" } : {}),
    ...(timestampHeader !== undefined ? { timestamp_header: timestampHeader } : {}),
    ...(tolerance !== undefined ? { tolerance_seconds: Number(tolerance) } : {}),
  };
  return members;
}

function vendorName(vendor: WebhookVerifyVendor): string {
  switch (vendor) {
    case "github": return "GitHub";
    case "stripe": return "Stripe";
    case "shopify": return "Shopify";
    case "slack": return "Slack";
    case "linear": return "Linear";
    case "vercel": return "Vercel";
    case "asana": return "Asana";
    case "generic_hmac": return "the sender";
  }
}

/** A webhook's verification as one line of a read: the vendor, how a generic sender signs, and whether its secret is held. */
export function verifyText(verify: WebhookVerify | undefined): string {
  if (!verify) return "";
  const parts: string[] = [verify.vendor];
  if (verify.vendor === "generic_hmac") {
    parts.push(`header ${verify.header ?? "?"}`, verify.encoding ?? "hex");
    if (verify.timestamp_header) parts.push(`timestamp ${verify.timestamp_header} within ${verify.tolerance_seconds ?? 300}s`);
  }
  const secret = verify.secret;
  parts.push(secret?.set
    ? `secret held${secret.hint ? ` (${secret.hint})` : ""}`
    : verify.vendor === "asana" ? "waiting for Asana's handshake: events are refused until it arrives" : "secret not held");
  return parts.join(", ");
}

/** The lines a read of a webhook or an overlay adds for verification and handshake. */
export function verifyLines(verify: WebhookVerify | undefined, handshake: WebhookHandshake | undefined): string[] {
  return [
    ...(verify ? [`verify: ${verifyText(verify)}`] : []),
    ...(handshake ? [`handshake: ${handshake}`] : []),
  ];
}
