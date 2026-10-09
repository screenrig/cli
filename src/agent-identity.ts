import { RESOURCE_ID_PATTERNS } from "./generated/resource-ids.js";
import type { Agent, AgentSelfStatus } from "./adapters/protocol.js";
import { usageError } from "./problems.js";

const AGENT_ID = RESOURCE_ID_PATTERNS.agent;

function isDateTime(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function agentPlatform(): string {
  return `${process.platform}/${process.arch}`;
}

export function validateAgent(value: unknown, expectedState?: Agent["state"]): Agent {
  const agent = value as Partial<Agent> | undefined;
  if (!agent || typeof agent.id !== "string" || !AGENT_ID.test(agent.id)
    || typeof agent.name !== "string" || agent.name.length === 0
    || typeof agent.agent_type !== "string" || agent.agent_type.length === 0
    || !["pending", "active", "revoked", "cancelled", "expired"].includes(agent.state ?? "")
    || typeof agent.authenticated_requests !== "number" || typeof agent.metered_credits !== "number"
    || !Array.isArray(agent.capabilities) || agent.capabilities.length === 0
    || agent.capabilities.some((name) => typeof name !== "string")
    || !isDateTime(agent.created_at) || (expectedState !== undefined && agent.state !== expectedState)) {
    throw usageError("Agent response does not match the generated Agent contract.");
  }
  return agent as Agent;
}

export function validateAgentSelfStatus(value: unknown, expectedState?: Agent["state"]): AgentSelfStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw usageError("Agent self status does not match the generated AgentSelfStatus contract.");
  }
  const status = value as Partial<AgentSelfStatus>;
  if (typeof status.connection_ready !== "boolean") {
    throw usageError("Agent self status does not match the generated AgentSelfStatus contract.");
  }
  return { agent: validateAgent(status.agent, expectedState), connection_ready: status.connection_ready };
}
