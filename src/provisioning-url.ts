import type { ScreenProvisioning } from "./adapters/protocol.js";
import { usageError } from "./problems.js";

export interface ValidatedProvisioning {
  publicUrl: string;
  provisioningUrl: string;
}

export function validateProvisioningUrls(value: ScreenProvisioning): ValidatedProvisioning {
  let publicUrl: URL;
  let provisioningUrl: URL;
  try {
    publicUrl = new URL(value.public_url);
    provisioningUrl = new URL(value.provisioning_url);
  } catch {
    throw usageError("Browser provisioning response contains an invalid URL.");
  }
  const expectedPath = `/s/${value.screen.public_id}`;
  const localHttp = publicUrl.protocol === "http:" && (publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1" || publicUrl.hostname.endsWith(".localhost"));
  if (
    (publicUrl.protocol !== "https:" && !localHttp)
    || publicUrl.username !== ""
    || publicUrl.password !== ""
    || publicUrl.search !== ""
    || publicUrl.hash !== ""
    || publicUrl.pathname !== expectedPath
    || provisioningUrl.origin !== publicUrl.origin
    || provisioningUrl.pathname !== expectedPath
    || provisioningUrl.username !== ""
    || provisioningUrl.password !== ""
    || provisioningUrl.search !== ""
    || !/^#provision=[A-Za-z0-9_-]{43}$/.test(provisioningUrl.hash)
  ) {
    throw usageError("Browser provisioning response contains an unsafe URL.");
  }
  return { publicUrl: publicUrl.href, provisioningUrl: provisioningUrl.href };
}
