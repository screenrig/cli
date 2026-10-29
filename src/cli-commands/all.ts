// Every command bundle, loaded eagerly. The CLI loads bundles on demand
// (index.ts); tests and in-process parsing use the whole tree.
import type { CommandRegistrar } from "./index.js";
import { register as account } from "../bundles/account.js";
import { register as ads } from "../bundles/ads.js";
import { register as media } from "../bundles/media.js";
import { register as playlists } from "../bundles/playlists.js";
import { register as screens } from "../bundles/screens.js";
import { register as monitoring } from "../bundles/monitoring.js";
import { register as integrations } from "../bundles/integrations.js";
import { register as migrate } from "../bundles/migrate.js";

export const ALL_COMMAND_REGISTRARS: readonly CommandRegistrar[] = [account, ads, media, playlists, screens, monitoring, integrations, migrate];
