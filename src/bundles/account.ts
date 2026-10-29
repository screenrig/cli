// The account commands: registered only when an invocation needs them.
import type { Command } from "commander";
import type { CommandActionBinder } from "../cli-commands/types.js";
import { registerProjectCommands } from "../cli-commands/project.js";
import { registerOrganizationCommands } from "../cli-commands/organization.js";
import { registerInvitationCommands } from "../cli-commands/invitations.js";
import { registerBillingCommands } from "../cli-commands/billing.js";
import { registerAgentCommands } from "../cli-commands/agent.js";
import { registerServiceClientCommands } from "../cli-commands/service-client.js";
import { registerDashboardCommands } from "../cli-commands/dashboard.js";
import { registerAgentNotesCommands } from "../cli-commands/agent-notes.js";
import { registerFeedbackCommands } from "../cli-commands/feedback.js";
import { registerSupportCommands } from "../cli-commands/support.js";
import { registerDoctorCommands } from "../cli-commands/doctor.js";
import { registerVersionCommands } from "../cli-commands/version.js";
import { registerStatusCommands } from "../cli-commands/status.js";
import { registerRecoveryCommands } from "../cli-commands/recovery.js";

export function register(root: Command, bind: CommandActionBinder): void {
  registerProjectCommands(root, bind);
  registerOrganizationCommands(root, bind);
  registerInvitationCommands(root, bind);
  registerBillingCommands(root, bind);
  registerAgentCommands(root, bind);
  registerServiceClientCommands(root, bind);
  registerDashboardCommands(root, bind);
  registerAgentNotesCommands(root, bind);
  registerFeedbackCommands(root, bind);
  registerSupportCommands(root, bind);
  registerDoctorCommands(root, bind);
  registerVersionCommands(root, bind);
  registerStatusCommands(root, bind);
  registerRecoveryCommands(root, bind);
}
