/**
 * The environment for a helper this CLI spawns (ffmpeg, a local browser, a file
 * opener): this process's own, without any `SCREENRIG_` variable. Those hold
 * the CLI's credentials (`SCREENRIG_TOKEN`, `SCREENRIG_CLIENT_SECRET`,
 * `SCREENRIG_CLIENT_KEY_FILE`, ...) and settings, and the helpers open
 * untrusted media and pages.
 */
export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (!name.toUpperCase().startsWith("SCREENRIG_")) env[name] = value;
  }
  return env;
}
