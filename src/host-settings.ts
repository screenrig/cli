/**
 * The machine settings this CLI reads: config and tool locations, the API
 * origin and display presence. None of them is a credential; sign-ins live in
 * the 0600 user config. Each one is read by name, here and nowhere else, and
 * child processes inherit this process's own surroundings unchanged.
 */
export interface HostSettings {
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
  PROGRAMFILES?: string;
  TMPDIR?: string;
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  SCREENRIG_CONFIG?: string;
  SCREENRIG_API_URL?: string;
  SCREENRIG_BROWSER?: string;
  SCREENRIG_FFMPEG?: string;
  SCREENRIG_FFPROBE?: string;
  SCREENRIG_CWEBP?: string;
  SCREENRIG_VERSION?: string;
  SCREENRIG_INSTALL_SOURCE?: string;
  SCREENRIG_SDK_RUNTIME?: string;
}

/** This process's settings. */
export function processSettings(): HostSettings {
  const settings: HostSettings = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
    PROGRAMFILES: process.env.PROGRAMFILES,
    TMPDIR: process.env.TMPDIR,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    SCREENRIG_CONFIG: process.env.SCREENRIG_CONFIG,
    SCREENRIG_API_URL: process.env.SCREENRIG_API_URL,
    SCREENRIG_BROWSER: process.env.SCREENRIG_BROWSER,
    SCREENRIG_FFMPEG: process.env.SCREENRIG_FFMPEG,
    SCREENRIG_FFPROBE: process.env.SCREENRIG_FFPROBE,
    SCREENRIG_CWEBP: process.env.SCREENRIG_CWEBP,
    SCREENRIG_VERSION: process.env.SCREENRIG_VERSION,
    SCREENRIG_INSTALL_SOURCE: process.env.SCREENRIG_INSTALL_SOURCE,
    SCREENRIG_SDK_RUNTIME: process.env.SCREENRIG_SDK_RUNTIME,
  };
  for (const name of Object.keys(settings) as (keyof HostSettings)[]) if (settings[name] === undefined) delete settings[name];
  return settings;
}
