import type { CommandHandler } from "./commands.js";
import { flagNumber, flagString } from "./command-input.js";
import { successEnvelope } from "./envelope.js";
import { ExitCode } from "./exit-codes.js";
import { unexpectedResponseError } from "./problems.js";
import { FetchTransport } from "./transport/http.js";

const MONITOR_ORIGIN = "https://monitor.screenrig.ai";
const STATES = new Set(["up", "degraded", "down", "unknown"]);

export interface ServiceStatus {
  schema: "screenrig.monitor/v1";
  generated_at: string;
  environments: Array<{
    environment: string;
    state: string;
    observed_at: string;
    stale: boolean;
    deploying: boolean;
    version_mismatch: boolean;
    components: unknown[];
    reasons: string[];
  }>;
}

export function validateServiceStatus(value: unknown, environment: string, now: Date): ServiceStatus {
  const doc = value as ServiceStatus | undefined;
  if (!doc || doc.schema !== "screenrig.monitor/v1" || !Array.isArray(doc.environments) || doc.environments.length !== 1) {
    throw unexpectedResponseError("The service monitor returned an invalid status document.");
  }
  const current = doc.environments[0];
  if (!current || current.environment !== environment || !STATES.has(current.state) || !Array.isArray(current.components)) {
    throw unexpectedResponseError("The service monitor returned an invalid environment.");
  }
  const observed = Date.parse(current.observed_at);
  if (current.stale || !Number.isFinite(observed) || now.getTime() - observed > 90_000 || observed - now.getTime() > 5_000) {
    current.state = "unknown";
    current.stale = true;
    current.reasons = ["Monitor observations are stale; current service state is unknown."];
  }
  return doc;
}

export const handleServiceStatus: CommandHandler = async (args, runtime) => {
  const environment = flagString(args.flags, "environment") ?? "production";
  // No credential/config access: outage diagnosis works before enrollment and
  // never sends a project token to the independent monitor.
  const transport = runtime.transport ?? new FetchTransport(MONITOR_ORIGIN, undefined);
  const response = await transport.request({
    method: "GET", path: "/api/status", query: { environment },
    timeout_ms: flagNumber(args.flags, "timeout") ?? 10_000,
  });
  if (response.status !== 200) throw unexpectedResponseError("The independent service monitor is unavailable.");
  const data = validateServiceStatus(response.body, environment, runtime.now());
  const current = data.environments[0]!;
  return {
    envelope: successEnvelope(data),
    exitCode: ExitCode.Success,
    human: `${environment}: ${current.state}${current.deploying ? " (deployment window)" : ""}${current.version_mismatch ? " · backend versions differ" : ""}${current.stale ? " · observations are stale" : ""}\n${MONITOR_ORIGIN}/?environment=${environment}`,
  };
};
