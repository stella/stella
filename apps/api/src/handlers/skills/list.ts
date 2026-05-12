import { Result } from "better-result";
import { and, desc, eq, or } from "drizzle-orm";

import { listSkillMetadata, listSkillResources } from "@stll/skills";

import { agentSkills, AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listSkills = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, memberRole }) {
    const installed = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: agentSkills.id,
            scope: agentSkills.scope,
            origin: agentSkills.origin,
            slug: agentSkills.slug,
            name: agentSkills.name,
            description: agentSkills.description,
            version: agentSkills.version,
            license: agentSkills.license,
            compatibility: agentSkills.compatibility,
            sourceUrl: agentSkills.sourceUrl,
            contentHash: agentSkills.contentHash,
            enabled: agentSkills.enabled,
            userId: agentSkills.userId,
            createdAt: agentSkills.createdAt,
          })
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
          .orderBy(
            desc(agentSkills.enabled),
            agentSkills.scope,
            agentSkills.name,
          )
          .limit(LIMITS.agentSkillsListLimit),
      ),
    );

    return Result.ok({
      canManageTeam: ["admin", "owner"].includes(memberRole.role),
      builtIn: listSkillMetadata().map((skill) => ({
        id: skill.name,
        scope: "built-in" as const,
        origin: "built-in" as const,
        slug: skill.name,
        name: skill.name,
        description: skill.description,
        version: skill.version,
        license: skill.license ?? null,
        compatibility: skill.compatibility ?? null,
        enabled: true,
        resourceCount: listSkillResources(skill.name).length,
      })),
      installed,
    });
  },
);

export default listSkills;
