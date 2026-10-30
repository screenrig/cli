import { fileURLToPath } from "node:url";

// The shape the control plane accepts: a host and an optional marketplace.
const INSTALL_SOURCE = /^[a-z][a-z0-9-]{0,31}(\/[a-z0-9][a-z0-9._-]{0,63})?$/;

/**
 * Where this installation came from, sent with enrollment and sign-in so a
 * signup can be traced to the host and marketplace that installed it. The
 * plugin's bootstrap helper sets SCREENRIG_INSTALL_SOURCE ("claude/screenrig",
 * or a host directory's marketplace); the npm package runs from
 * node_modules/screenrig. Anything else reports nothing.
 */
export function installSource(env: Record<string, string | undefined>, moduleUrl: string = import.meta.url): string | undefined {
  const value = env.SCREENRIG_INSTALL_SOURCE?.trim();
  if (value && INSTALL_SOURCE.test(value)) return value;
  return /[\\/]node_modules[\\/]screenrig[\\/]/.test(fileURLToPath(moduleUrl)) ? "npm" : undefined;
}
