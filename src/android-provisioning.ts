import { apexHost } from "./apex-origin.js";
import { CliError, makeProblem, networkError, unexpectedResponseError, usageError } from "./problems.js";

/** Where the sideload channel lists its Android builds: a static file beside the dashboard. */
export const ANDROID_MANIFEST_PATH = "/android/manifest.json";

/** The device administrator the QR code names: the managed build's receiver, in whatever package the channel lists. */
const ADMIN_RECEIVER = "ai.screenrig.player.managed.ScreenRigDeviceAdminReceiver";

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SIGNER_SHA256 = /^[0-9a-f]{64}$/i;
/** A fleet link's secret: `srfl_` and 43 URL-safe characters, not followed by another. */
const FLEET_SECRET = /srfl_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;
const MANIFEST_TIMEOUT_MS = 15_000;

/** The managed build as the channel lists it: its package, the versioned file's path on the site and its signing certificate's SHA-256 (hex). */
export interface ManagedArtifact {
  package: string;
  path: string;
  signer_sha256: string;
}

/** The secret in a fleet link's URL (or the bare secret), or undefined when there is none. */
export function fleetLinkSecret(text: string | undefined): string | undefined {
  return text === undefined ? undefined : FLEET_SECRET.exec(text)?.[0];
}

/** Android's signature checksum: the certificate's SHA-256 as URL-safe base64 without padding. The channel lists it as hex. */
export function signatureChecksum(signerSha256: string): string {
  return Buffer.from(signerSha256, "hex").toString("base64url");
}

/**
 * The `managed` entry of a `screenrig.android/v1` manifest. The other roles and
 * unknown fields are ignored; an entry that does not read this way reads as absent.
 */
export function managedArtifact(manifest: unknown): ManagedArtifact | undefined {
  const entry = manifest && typeof manifest === "object" ? (manifest as { managed?: unknown }).managed : undefined;
  if (!entry || typeof entry !== "object") return undefined;
  const { package: name, path, signer_sha256: signer } = entry as Record<string, unknown>;
  if (typeof name !== "string" || !PACKAGE_NAME.test(name)) return undefined;
  if (typeof path !== "string" || !path.startsWith("/android/") || !path.endsWith(".apk")) return undefined;
  if (typeof signer !== "string" || !SIGNER_SHA256.test(signer)) return undefined;
  return { package: name, path, signer_sha256: signer };
}

/**
 * The site that serves the sideload channel for an API origin: its apex, on the
 * same scheme and port. Undefined for an origin that is not a ScreenRig API.
 */
export function siteOrigin(apiUrl: string): string | undefined {
  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return undefined;
  }
  const apex = apexHost(api.hostname);
  if (!apex || (api.protocol !== "https:" && !(api.protocol === "http:" && api.hostname.endsWith(".localhost")))) return undefined;
  return `${api.protocol}//${apex}${api.port ? `:${api.port}` : ""}`;
}

/**
 * The provisioning payload Android's setup wizard reads from a QR code scanned
 * on a factory-reset device: the Player's device administrator, the versioned
 * APK on the site, the signing certificate's checksum, every system app left
 * enabled, and the fleet link secret in the admin extras, where the Player reads
 * it as it reads a device manager's `fleet_link`. The same payload the dashboard's
 * Android device owner section encodes. Undefined when the listed path leaves the
 * site's `/android/` tree or `secret` is not a bare fleet link secret.
 */
export function androidProvisioning(artifact: ManagedArtifact, origin: string, secret: string): Record<string, unknown> | undefined {
  if (fleetLinkSecret(secret) !== secret) return undefined;
  let location: URL;
  try {
    location = new URL(artifact.path, origin);
  } catch {
    return undefined;
  }
  if (location.origin !== origin || !location.pathname.startsWith("/android/")) return undefined;
  return {
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": `${artifact.package}/${ADMIN_RECEIVER}`,
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": location.href,
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": signatureChecksum(artifact.signer_sha256),
    "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
    "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": { fleet_link: secret },
  };
}

/** `error.message`, with the cause's message when fetch wrapped one ("fetch failed"). */
function causeText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

/**
 * Reads the site's Android manifest and returns its `managed` entry. A site that
 * lists no device-owner build is a clear answer, never a fallback to the `player`
 * entry, whose package has no device administrator.
 */
export async function fetchManagedArtifact(origin: string, fetchImplementation: typeof fetch): Promise<ManagedArtifact> {
  const url = `${origin}${ANDROID_MANIFEST_PATH}`;
  let response: Response;
  try {
    // A redirect would let another host name the APK Android installs as device owner.
    response = await fetchImplementation(url, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  } catch (error) {
    throw networkError(`Could not read ${url}: ${causeText(error)}.`);
  }
  if (!response.ok) throw unexpectedResponseError(`${url} answered HTTP ${response.status}.`);
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch {
    throw unexpectedResponseError(`${url} did not answer a JSON document.`);
  }
  const artifact = managedArtifact(manifest);
  if (!artifact) {
    throw new CliError(makeProblem(
      "android_device_owner_build_unavailable",
      "No Android device owner build",
      404,
      `${origin} lists no Android build for device owner setup, so there is nothing to provision with. Do not use the player build: it has no device administrator.`,
    ));
  }
  return artifact;
}

/** The sentence a command prints with the payload: it creates screens. */
export const PROVISIONING_NOTICE = "Sensitive: this JSON carries the fleet link secret, which creates screens. Encode it as a QR code and show it only to the person at the device (Welcome screen: tap six times, then scan).";

export function unsupportedSiteError(): CliError {
  return usageError("--android-provisioning reads the Android build list from the site that belongs to the configured API origin, and this origin has none.", {
    command: "screenrig doctor",
    reason: "Shows the configured API origin without sending requests.",
  });
}
