import { arch, platform } from "node:os";
import { CLI_VERSION } from "./version.js";

/** The User-Agent every outbound CLI request carries, so the edge can tell the CLI from bare Node. */
export const USER_AGENT = `screenrig-cli/${CLI_VERSION} (${platform()}; ${arch()})`;
