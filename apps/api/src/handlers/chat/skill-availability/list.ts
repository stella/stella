import { Result } from "better-result";
import { and, eq, or } from "drizzle-orm";

import { AGENT_SKILL_SCOPES, agentSkills } from "@/api/db/schema";
import { resolveCallerChatSkillAvailability } from "@/api/handlers/chat/skill-availability/offered-tools";
import { SKILL_TOOL_AVAILABILITY_STATUS } from "@/api/lib/agent-skills/required-tools";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  // The composer menus read this beside the skill list; it names skill ids
  // and tool names only.
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
} satisfies HandlerConfig;

const VISIBLE_SKILLS_MAX =
  LIMITS.agentSkillsPerUser + LIMITS.agentSkillsTeamPerOrganization;

/**
 * The caller's skills that chat cannot offer, each with the tools it lacks.
 * Chat decides this, not the skill listing: the tool set it is decided over
 * is chat's own. The composer menus leave these skills out and the tools
 * page says why.
 */
const listUnavailableChatSkills = createSafeRootHandler(
  config,
  async function* ({
    getAccessibleWorkspaces,
    memberRole,
    orgAIConfig,
    safeDb,
    scopedDb,
    session,
    user,
  }) {
    const skills = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: agentSkills.id, metadata: agentSkills.metadata })
          .from(agentSkills)
          .where(
            and(
              eq(agentSkills.organizationId, session.activeOrganizationId),
              or(
                eq(agentSkills.scope, AGENT_SKILL_SCOPES[0]), // "team"
                eq(agentSkills.userId, user.id),
              ),
            ),
          )
          .limit(VISIBLE_SKILLS_MAX),
      ),
    );
    const availability = yield* Result.await(
      resolveCallerChatSkillAvailability({
        context: {
          getAccessibleWorkspaces,
          memberRole,
          organizationId: session.activeOrganizationId,
          orgAIConfig,
          safeDb,
          scopedDb,
          userId: user.id,
        },
        skills,
      }),
    );

    return Result.ok({
      unavailable: [...availability].flatMap(([skillId, decision]) =>
        decision.status === SKILL_TOOL_AVAILABILITY_STATUS.unavailable
          ? [{ missingTools: decision.missingTools, skillId }]
          : [],
      ),
    });
  },
);

export default listUnavailableChatSkills;
