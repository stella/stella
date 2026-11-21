import type { McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";

/**
 * External connector tools (and, for any other credential, skill tools)
 * require the advanced surface.
 */
export const modeAllowsGatewayTools = (mode: McpMode): boolean =>
  mode === "advanced";

/** The credential facts that decide which skills a session is served. */
export type SkillToolSession = Pick<McpRequestContext, "sessionCredentialType">;

/**
 * An agent run (a coding agent on the member's computer or in the agent
 * sandbox) presents a short-lived, user-attributed token minted by stella
 * itself (`mcp/agent-run-token.ts`).
 */
const isAgentRunSession = ({
  sessionCredentialType,
}: SkillToolSession): boolean => sessionCredentialType === "agent_run";

/**
 * Skill tools are served on the advanced surface, and on the default surface
 * to an agent run: the run reaches stella on the default surface (so it gets
 * none of the capability executors only the advanced surface lists), and its
 * skills are what lets it follow the member's methods as a cloud chat does.
 * External connector tools stay advanced-only.
 */
export const modeAllowsSkillTools = (
  mode: McpMode,
  session: SkillToolSession,
): boolean =>
  modeAllowsGatewayTools(mode) ||
  (mode === "default" && isAgentRunSession(session));

/**
 * An agent run gets the skills shipped with stella as tools too, since its
 * harness finds a skill by its tool's description. Other clients read them as
 * resources, as before.
 */
export const servesBuiltInSkillTools = (session: SkillToolSession): boolean =>
  isAgentRunSession(session);
