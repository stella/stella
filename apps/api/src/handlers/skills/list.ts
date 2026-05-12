import { Result } from "better-result";
import { and, desc, eq, or } from "drizzle-orm";
import { t } from "elysia";

import { listSkillMetadata, listSkillResources } from "@stll/skills";

import { agentSkills, AGENT_SKILL_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

const listSkillsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.agentSkillsPageSizeMax,
    }),
  ),
  offset: t.Optional(t.Integer({ minimum: 0 })),
});

const config = {
  permissions: { workspace: ["read"] },
  query: listSkillsQuerySchema,
} satisfies HandlerConfig;

const listSkills = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, memberRole, query }) {
    const limit = query.limit ?? LIMITS.agentSkillsPageSizeDefault;
    const offset = query.offset ?? 0;

    const installedRows = yield* Result.await(
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
            agentSkills.id,
          )
          .limit(limit + 1)
          .offset(offset),
      ),
    );
    const hasMore = installedRows.length > limit;
    const installed = hasMore ? installedRows.slice(0, limit) : installedRows;

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
      nextOffset: hasMore ? offset + installed.length : null,
    });
  },
);

export default listSkills;
