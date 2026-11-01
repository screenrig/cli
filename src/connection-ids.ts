import { usageError } from "./problems.js";

// A project connection (pcn_) is the project's reusable access to Microsoft or
// Google. A data source, a Power BI connection and a SharePoint media sync
// account name one in config.connection_id instead of carrying credentials of
// their own; connections.ts is the command, this is what every consumer shares.

/** Backend Connection.id (vendor/openapi.yaml). */
export const CONNECTION_ID_PATTERN = /^(?:(?:stage|qa|development)_)?pcn_[A-Za-z0-9_-]+$/;
/** What a consumer's config.connection_id accepts. */
export const CONNECTION_REFERENCE_PATTERN = /^(?:(?:stage|qa|development)_)?pcn_[A-Za-z0-9_-]{4,64}$/;

/** --connection-id on a command that reads through a connection. */
export function connectionIdOption(value: string): string {
  if (!CONNECTION_REFERENCE_PATTERN.test(value)) {
    throw usageError("--connection-id takes a connection id (pcn_…).", { command: "screenrig connection list", reason: "List this project's connections and their ids." });
  }
  return value;
}
