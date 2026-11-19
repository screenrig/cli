import type { Screen, ScreenCommand, ScreenHealth, ScreenNetworkChange, ScreenNetworkIPv4, ScreenNetworkWrite } from "./adapters/protocol.js";
import { COMMAND_CAUSE, COMMAND_ID, expiresInSeconds, instant } from "./screen-commands.js";
import { CliError, usageError } from "./problems.js";
import { plainText } from "./reviews.js";
import { networkLines } from "./screen-health.js";

/**
 * Remote network settings (backend docs/player-compatibility.md §6.5.2): the connection that
 * carries the default route and its IPv4 addressing, applied by a Player that manages its host
 * and kept only if the device reaches screenRIG again within the rollback time. Local checks mirror
 * ScreenNetworkWrite; the server stays authoritative and checks the rest.
 */
export const NETWORK_ROLLBACK_MIN_S = 60;
export const NETWORK_ROLLBACK_MAX_S = 600;
export const NETWORK_PREFIX_MIN = 8;
export const NETWORK_PREFIX_MAX = 30;
export const NETWORK_DNS_MAX = 3;
export const NETWORK_SSID_MAX_BYTES = 32;

const IPV4 = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;
const isIpv4 = (value: string) => IPV4.test(value) && value.split(".").every((part) => Number(part) <= 255);

/** --wifi: the network's name, 1 to 32 bytes without control characters. */
export function wifiNameOption(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > NETWORK_SSID_MAX_BYTES || /\p{Cc}/u.test(value)) {
    throw usageError(`--wifi takes the Wi-Fi network's name: 1 to ${NETWORK_SSID_MAX_BYTES} bytes, no control characters.`);
  }
  return value;
}

/** --address: IPV4/PREFIX with a prefix length from 8 to 30, such as 192.168.1.50/24. */
export function networkAddress(value: string): { address: string; prefix: number } {
  const [address, prefix, ...rest] = value.trim().split("/");
  const length = prefix !== undefined && /^\d{1,2}$/.test(prefix) ? Number(prefix) : Number.NaN;
  if (rest.length || !address || !isIpv4(address) || !(length >= NETWORK_PREFIX_MIN && length <= NETWORK_PREFIX_MAX)) {
    throw usageError(`--address takes an IPv4 address and prefix length ADDRESS/PREFIX, the prefix from ${NETWORK_PREFIX_MIN} to ${NETWORK_PREFIX_MAX}, such as 192.168.1.50/24.`);
  }
  return { address, prefix: length };
}

export function networkAddressOption(value: string): string {
  networkAddress(value);
  return value;
}

/** --gateway: an IPv4 address. */
export function networkGatewayOption(value: string): string {
  if (!isIpv4(value.trim())) throw usageError("--gateway takes an IPv4 address, such as 192.168.1.1.");
  return value;
}

/** --dns: one to three IPv4 addresses, separated by commas. */
export function networkDns(value: string): string[] {
  const servers = value.split(",").map((server) => server.trim());
  if (servers.length > NETWORK_DNS_MAX || servers.some((server) => !isIpv4(server))) {
    throw usageError(`--dns takes one to ${NETWORK_DNS_MAX} IPv4 addresses separated by commas, such as 192.168.1.1,1.1.1.1.`);
  }
  return servers;
}

export function networkDnsOption(value: string): string {
  networkDns(value);
  return value;
}

/** --rollback-after: whole seconds from 60 to 600. */
export function networkRollbackSeconds(value: string): number {
  const seconds = /^\d{1,4}$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!(seconds >= NETWORK_ROLLBACK_MIN_S && seconds <= NETWORK_ROLLBACK_MAX_S)) {
    throw usageError(`--rollback-after takes whole seconds from ${NETWORK_ROLLBACK_MIN_S} to ${NETWORK_ROLLBACK_MAX_S}.`);
  }
  return seconds;
}

export function networkRollbackOption(value: string): string {
  networkRollbackSeconds(value);
  return value;
}

/** The Wi-Fi password: 8 to 63 printable ASCII characters or 64 hex digits. The message never repeats it. */
export function wifiPasswordChecked(secret: string, where: string): string {
  if (!(/^[\x20-\x7e]{8,63}$/.test(secret) || /^[0-9a-fA-F]{64}$/.test(secret))) {
    throw usageError(`The Wi-Fi password in ${where} must be 8 to 63 printable ASCII characters or 64 hex digits.`);
  }
  return secret;
}

/** What the flags of screen network set describe. `secret` is the password text already read from its file or stdin. */
export interface NetworkFlags {
  wifi?: string;
  hidden?: boolean;
  secret?: string;
  ethernet?: boolean;
  dhcp?: boolean;
  address?: string;
  gateway?: string;
  dns?: string;
  rollbackAfter?: string;
  expiresIn?: string;
}

/** The ScreenNetworkWrite the flags describe. A member left out takes the server's default. */
export function networkWrite(flags: NetworkFlags): ScreenNetworkWrite {
  if ((flags.wifi === undefined) === !flags.ethernet) throw usageError("Provide exactly one of --wifi or --ethernet.");
  if ((flags.address === undefined) === !flags.dhcp) throw usageError("Provide exactly one of --dhcp or --address.");
  if (flags.address === undefined && (flags.gateway !== undefined || flags.dns !== undefined)) throw usageError("--gateway and --dns apply to --address, not --dhcp.");
  if (flags.address !== undefined && flags.gateway === undefined) throw usageError("--address requires --gateway.");
  const ipv4: ScreenNetworkIPv4 = flags.address === undefined
    ? { mode: "automatic" }
    : {
      mode: "manual",
      ...networkAddress(flags.address),
      gateway: networkGatewayOption(flags.gateway!).trim(),
      ...(flags.dns === undefined ? {} : { dns: networkDns(flags.dns) }),
    };
  if (flags.ethernet && (flags.hidden || flags.secret !== undefined)) throw usageError("--hidden and --password-file apply to --wifi.");
  return {
    connection: flags.ethernet ? "ethernet" : "wifi",
    ...(flags.ethernet ? {} : {
      wifi: {
        ssid: wifiNameOption(flags.wifi!),
        ...(flags.hidden ? { hidden: true } : {}),
        ...(flags.secret === undefined ? {} : { password: flags.secret }),
      },
    }),
    ipv4,
    ...(flags.rollbackAfter === undefined ? {} : { rollback_after_s: networkRollbackSeconds(flags.rollbackAfter) }),
    ...(flags.expiresIn === undefined ? {} : { expires_in_s: expiresInSeconds(flags.expiresIn) }),
  };
}

/** What a request or a recorded change asks for in words: `Wi-Fi Lobby (hidden, password set), automatic addressing, rolls back after 180 s`. */
export function networkChangeText(change: ScreenNetworkWrite | ScreenNetworkChange): string {
  const wifi = change.wifi as { ssid?: unknown; hidden?: unknown; password_set?: unknown; password?: unknown } | undefined;
  const flags = [wifi?.hidden === true ? "hidden" : undefined, wifi?.password_set === true || (typeof wifi?.password === "string" && wifi.password !== "") ? "password set" : undefined].filter(Boolean);
  const connection = change.connection === "wifi"
    ? `Wi-Fi ${typeof wifi?.ssid === "string" ? plainText(wifi.ssid).slice(0, 64) : ""}${flags.length ? ` (${flags.join(", ")})` : ""}`.trimEnd()
    : "Ethernet";
  const ipv4 = change.ipv4;
  const addressing = ipv4?.mode === "manual"
    ? `address ${typeof ipv4.address === "string" ? plainText(ipv4.address) : "?"}${typeof ipv4.prefix === "number" ? `/${ipv4.prefix}` : ""}${typeof ipv4.gateway === "string" ? `, gateway ${plainText(ipv4.gateway)}` : ""}${Array.isArray(ipv4.dns) && ipv4.dns.length ? `, DNS ${ipv4.dns.filter((server): server is string => typeof server === "string").map(plainText).join(", ")}` : ""}`
    : "automatic addressing";
  return [connection, addressing, typeof change.rollback_after_s === "number" ? `rolls back after ${change.rollback_after_s} s` : undefined].filter(Boolean).join(", ");
}

/** The newest network command in Screen.commands (the server lists them oldest first), or undefined. */
export function latestNetworkCommand(screen: Screen | undefined): ScreenCommand | undefined {
  const commands: unknown = screen?.commands;
  if (!Array.isArray(commands)) return undefined;
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index] as ScreenCommand | undefined;
    if (command && typeof command === "object" && command.type === "network") return command;
  }
  return undefined;
}

const ROLLBACK_REASONS: Record<string, string> = {
  no_link: "no link, or the Wi-Fi network was not found",
  wrong_password: "the Wi-Fi password was refused",
  no_address: "the chosen connection got no IPv4 address",
  restarted: "the device restarted during the trial",
  not_connected: "the device could not reach screenRIG on the new settings",
};

const REFUSALS: Record<string, string> = {
  refused_unmanaged: "the Player does not manage its host's network",
  refused_busy: "an update, another network change or the device's own menu was in progress",
  refused_invalid: "the device refused the settings",
  refused_no_wifi: "the device has no Wi-Fi",
  refused_no_password: "the device could not take the Wi-Fi password",
  refused_failed: "the device could not start the change",
};

/** One sentence for a network command: its state, the result the Player reported, and what it asked for. */
export function networkChangeSentence(command: ScreenCommand): string | undefined {
  const { id, state } = command;
  if (typeof id !== "string" || !COMMAND_ID.test(id) || typeof state !== "string") return undefined;
  const cause = typeof command.cause === "string" && COMMAND_CAUSE.test(command.cause) ? command.cause : undefined;
  const reason = typeof command.detail === "string" && COMMAND_CAUSE.test(command.detail) ? command.detail : undefined;
  const what = command.network && typeof command.network === "object" ? `: ${networkChangeText(command.network)}` : "";
  const lead = `Network change ${id}`;
  if (state === "queued") {
    const expires = instant(command.expires_at);
    return `${lead} queued${expires ? ` until ${expires}` : ""}: it is sent when the screen comes online${what.replace(/^:/, ";")}`;
  }
  if (state === "sent") return `${lead} on trial${what}`;
  if (state === "done") return `${lead} kept${what}`;
  if (state === "failed") {
    if (cause === "rolled_back") {
      return `${lead} rolled back${reason ? `: ${reason}${ROLLBACK_REASONS[reason] ? ` (${ROLLBACK_REASONS[reason]})` : ""}` : ""}; the screen is back on its previous settings${what.replace(/^:/, ";")}`;
    }
    if (cause?.startsWith("refused_")) {
      return `${lead} refused${REFUSALS[cause] ? `: ${REFUSALS[cause]}` : ` (${cause})`}; nothing changed${what.replace(/^:/, ";")}`;
    }
    return `${lead} failed${cause ? ` (${cause})` : ""}${what}`;
  }
  if (state === "expired" || state === "cancelled" || state === "superseded") return `${lead} ${state}: it never ran${what.replace(/^:/, ";")}`;
  return undefined;
}

/** The one line screen show prints for a network change still pending (queued, or sent and on trial). */
export function networkSummaryLines(screen: Screen | undefined): string[] {
  const command = latestNetworkCommand(screen);
  if (!command || (command.state !== "queued" && command.state !== "sent")) return [];
  const sentence = networkChangeSentence(command);
  return sentence ? [sentence] : [];
}

/** The human text of screen network show: where the device is on its network now, then the newest network change. */
export function networkShowLines(id: string, network: ScreenHealth["network"], change: ScreenCommand | undefined): string[] {
  const lines = [`Network of ${id}`];
  const reported = networkLines(network);
  lines.push(...(reported.length ? reported : ["The Player has not reported its network."]));
  const sentence = change ? networkChangeSentence(change) : undefined;
  lines.push(sentence ?? "No network change has been asked of this screen recently.");
  if (change?.state === "queued") lines.push(`Cancel it with screen command cancel ${id} ${change.id}.`);
  return lines;
}

function guided(error: CliError, next: { command: string; reason: string }, detail?: string): CliError {
  return new CliError({ ...error.problem, ...(detail === undefined ? {} : { detail }), next }, error.exitCode, error.warnings);
}

/**
 * Network refusals. 409 network_unsupported: only a Player that manages its host (the Raspberry Pi
 * appliance, a Linux Player installed to manage its host) changes the network remotely, and nothing
 * is recorded. A protected screen refuses it, a screen still waiting to pair has no Player, and an
 * archived one must be unarchived.
 */
export function networkProblem(error: unknown, id: string): unknown {
  if (!(error instanceof CliError) || error.problem.next) return error;
  if (error.problem.code === "network_unsupported") {
    return guided(error, {
      command: `screenrig screen show ${id}`,
      reason: "Check host.capabilities for network.configure. This screen's network changes in its own Device Configuration menu, on the device.",
    }, `${error.problem.detail} Nothing was sent: only the Raspberry Pi appliance and Linux Players installed to manage their host change their network remotely. Change the network in the screen's own Device Configuration menu.`);
  }
  if (error.problem.code === "protected_target") {
    return guided(error, {
      command: `screenrig screen show ${id}`,
      reason: "A screen in a protected screen folder refuses network changes. Change the network in the screen's own Device Configuration menu, or clear the folder's protection through a review, make the change and protect it again.",
    });
  }
  if (error.problem.code === "resource_conflict") {
    return guided(error, { command: `screenrig screen show ${id}`, reason: "A screen still waiting to pair has no Player whose network could change. Pair it first." });
  }
  if (error.problem.code === "screen_archived") {
    return guided(error, { command: `screenrig screen unarchive ${id}`, reason: "An archived screen refuses network changes. Unarchive it first." });
  }
  return error;
}
