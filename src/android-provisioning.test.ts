import assert from "node:assert/strict";
import { test } from "node:test";
import { androidProvisioning, fetchManagedArtifact, fleetLinkSecret, managedArtifact, signatureChecksum, siteOrigin } from "./android-provisioning.js";
import { CliError } from "./problems.js";

const SECRET = `srfl_${"A".repeat(43)}`;
const SIGNER = "ab".repeat(32);
const MANAGED = { package: "ai.screenrig.player.managed", path: "/android/managed/screenrig-managed-26.10.12.apk", signer_sha256: SIGNER };
const ORIGIN = "https://screenrig.ai";

function answering(body: unknown, init: { status?: number; json?: boolean } = {}): typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = ((url: string, requestInit?: RequestInit) => {
    calls.push({ url, ...(requestInit ? { init: requestInit } : {}) });
    const status = init.status ?? 200;
    return Promise.resolve(init.json === false
      ? new Response(String(body), { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

async function refused(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    return error;
  }
  assert.fail("expected the call to be refused");
}

test("the signature checksum is the certificate digest as URL-safe base64 without padding", () => {
  assert.equal(signatureChecksum(`fbff${"00".repeat(30)}`), "-_8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(signatureChecksum(SIGNER), "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s");
  assert.equal(signatureChecksum(SIGNER.toUpperCase()), "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s");
});

test("a fleet link secret is found in its URL or standing alone, and only when whole", () => {
  assert.equal(fleetLinkSecret(`https://play.screenrig.ai/player/#fleet=${SECRET}`), SECRET);
  assert.equal(fleetLinkSecret(SECRET), SECRET);
  assert.equal(fleetLinkSecret(`${SECRET}x`), undefined);
  assert.equal(fleetLinkSecret(`srfl_${"A".repeat(42)}`), undefined);
  assert.equal(fleetLinkSecret(undefined), undefined);
});

test("only a well-formed managed entry is a device owner build; the player entry never stands in", () => {
  assert.deepEqual(managedArtifact({ managed: MANAGED, player: { package: "ai.screenrig.player" } }), MANAGED);
  assert.equal(managedArtifact({ player: { package: "ai.screenrig.player", path: "/android/player/screenrig-player-26.10.12.apk", signer_sha256: SIGNER } }), undefined);
  assert.equal(managedArtifact({ managed: { ...MANAGED, package: "not a package" } }), undefined);
  assert.equal(managedArtifact({ managed: { ...MANAGED, path: "//evil.example/android/x.apk" } }), undefined);
  assert.equal(managedArtifact({ managed: { ...MANAGED, path: "/other/x.apk" } }), undefined);
  assert.equal(managedArtifact({ managed: { ...MANAGED, path: "/android/x.zip" } }), undefined);
  assert.equal(managedArtifact({ managed: { ...MANAGED, signer_sha256: "abcd" } }), undefined);
  assert.equal(managedArtifact({ managed: { ...MANAGED, signer_sha256: undefined } }), undefined);
  assert.equal(managedArtifact({ managed: "yes" }), undefined);
  assert.equal(managedArtifact(null), undefined);
  assert.equal(managedArtifact([]), undefined);
});

test("the site is the API origin's apex on the same scheme and port, for a ScreenRig API only", () => {
  assert.equal(siteOrigin("https://api.screenrig.ai"), "https://screenrig.ai");
  assert.equal(siteOrigin("https://api.stage.screenrig.ai/"), "https://stage.screenrig.ai");
  assert.equal(siteOrigin("http://api.screenrig.localhost:8080"), "http://screenrig.localhost:8080");
  assert.equal(siteOrigin("http://api.screenrig.ai"), undefined);
  assert.equal(siteOrigin("https://api.example.com"), undefined);
  assert.equal(siteOrigin("not a url"), undefined);
});

test("the payload names the managed receiver, the versioned download, the checksum and the secret", () => {
  assert.deepEqual(androidProvisioning(MANAGED, ORIGIN, SECRET), {
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME": "ai.screenrig.player.managed/ai.screenrig.player.managed.ScreenRigDeviceAdminReceiver",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION": "https://screenrig.ai/android/managed/screenrig-managed-26.10.12.apk",
    "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM": "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s",
    "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
    "android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE": { fleet_link: SECRET },
  });
});

test("no payload is built for a path that leaves the android tree or a value that is not a bare secret", () => {
  assert.equal(androidProvisioning({ ...MANAGED, path: "/android/../dashboard/x.apk" }, ORIGIN, SECRET), undefined);
  assert.equal(androidProvisioning(MANAGED, ORIGIN, `https://play.screenrig.ai/player/#fleet=${SECRET}`), undefined);
  assert.equal(androidProvisioning(MANAGED, ORIGIN, "srfl_short"), undefined);
});

test("the manifest is read from the site without following a redirect", async () => {
  const fetchImplementation = answering({ schema: "screenrig.android/v1", managed: MANAGED });
  assert.deepEqual(await fetchManagedArtifact(ORIGIN, fetchImplementation), MANAGED);
  assert.equal(fetchImplementation.calls.length, 1);
  assert.equal(fetchImplementation.calls[0]!.url, "https://screenrig.ai/android/manifest.json");
  assert.equal(fetchImplementation.calls[0]!.init?.redirect, "error");
  assert.equal(fetchImplementation.calls[0]!.init?.method, "GET");
});

test("a site with no device owner build says so, whatever else it lists", async () => {
  for (const manifest of [{}, { player: { package: "ai.screenrig.player", path: "/android/player/screenrig-player-26.10.12.apk", signer_sha256: SIGNER } }, { managed: { ...MANAGED, path: "/x.apk" } }]) {
    const error = await refused(fetchManagedArtifact(ORIGIN, answering(manifest)));
    assert.equal(error.problem.code, "android_device_owner_build_unavailable");
    assert.equal(error.problem.status, 404);
    assert.match(error.problem.detail, /lists no Android build for device owner setup/);
    assert.match(error.problem.detail, /Do not use the player build/);
  }
});

test("an unreadable site is a network or response fault, never a missing build", async () => {
  const down = await refused(fetchManagedArtifact(ORIGIN, (() => Promise.reject(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))) as typeof fetch));
  assert.equal(down.problem.code, "transport_error");
  assert.match(down.problem.detail, /https:\/\/screenrig\.ai\/android\/manifest\.json: fetch failed: ECONNREFUSED/);
  const status = await refused(fetchManagedArtifact(ORIGIN, answering({}, { status: 503 })));
  assert.equal(status.problem.code, "unexpected_response");
  assert.match(status.problem.detail, /HTTP 503/);
  const html = await refused(fetchManagedArtifact(ORIGIN, answering("<html>", { json: false })));
  assert.equal(html.problem.code, "unexpected_response");
  assert.match(html.problem.detail, /did not answer a JSON document/);
});
