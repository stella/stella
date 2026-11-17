import { Result } from "better-result";

import { classifyFailure, readFailureBrand } from "@stll/errors";

import { LOCAL_RUN_MCP_MODE } from "@/api/handlers/chat/local-run-plan";
import type { AvailableChatSkill } from "@/api/lib/agent-skills/skills";
import type { AdmittedMcpSession } from "@/api/lib/auth/oauth-grant-admission";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { AGENT_RUN_DEFAULT_SCOPES } from "@/api/mcp/agent-run-token";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { loadServedSkillTools } from "@/api/mcp/gateway/skills";

/** One skill a run on the member's computer can load, as its prompt lists it. */
export type LocalRunSkillTool = {
  /** The skill's slug, as a skill reference in a message names it. */
  name: string;
  /** The tool the stella MCP server serves the skill as, to this run. */
  toolName: string;
  description: string;
  source: AvailableChatSkill["source"];
};

type LoadLocalRunSkillToolsOptions = {
  organizationId: SafeId<"organization">;
  /** The chat run the turn belongs to; it names the session, nothing is audited. */
  runId: string;
  userId: SafeId<"user">;
  /** The matters the run's token is minted for. */
  workspaceIds: readonly SafeId<"workspace">[];
};

/**
 * The skill tools the stella MCP server will serve this turn's run: the
 * session its agent-run token opens (`mcp/agent-run-token.ts`) on the surface
 * the run is handed (`LOCAL_RUN_MCP_MODE`), listed by the same function
 * `tools/list` uses. The run's prompt lists exactly these, so it never names a
 * skill its MCP server would refuse.
 */
export const loadLocalRunSkillTools = async ({
  organizationId,
  runId,
  userId,
  workspaceIds,
}: LoadLocalRunSkillToolsOptions): Promise<
  Result<readonly LocalRunSkillTool[], HandlerError<500>>
> => {
  const session: AdmittedMcpSession = {
    credential: { type: "agent_run", runId },
    organizationId,
    scopes: [...AGENT_RUN_DEFAULT_SCOPES],
    userId,
    workspaceIds: [...workspaceIds],
  };
  return await Result.tryPromise({
    try: async () => {
      // The session is the run's own, not the chat request's: a turn's run
      // outlives its request, and listing skills records nothing about it.
      const context = await resolveMcpSessionContext(session, {
        request: new Request(getMcpResourceUrl(LOCAL_RUN_MCP_MODE), {
          method: "POST",
        }),
      });
      const served = await loadServedSkillTools({
        context,
        mode: LOCAL_RUN_MCP_MODE,
        scopes: session.scopes,
      });
      return served.map((skill): LocalRunSkillTool => ({
        name: skill.name,
        toolName: skill.exposedName,
        description: skill.description,
        source: skill.source,
      }));
    },
    // A failed read of the member's organization state; a cause that names
    // its own failure (a lost connection, a deadline) keeps that reason.
    catch: (cause) =>
      classifyFailure(
        new HandlerError({
          status: 500,
          message: "Failed to load the skills for a run on a computer",
          cause,
        }),
        readFailureBrand(cause)?.reason ?? "organization_state_unreadable",
      ),
  });
};
