import { Result } from "better-result";
import { and, asc, desc, eq, gt, or, sql } from "drizzle-orm";
import { t } from "elysia";

import { listSkillMetadata, listSkillResources } from "@stll/skills";

import {
  agentSkills,
  AGENT_SKILL_SCOPES,
  type AgentSkillScope,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedAgentSkillId } from "@/api/lib/safe-id-boundaries";

const listSkillsQuerySchema = t.Object({
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: LIMITS.agentSkillsPageSizeMax,
    }),
  ),
  cursor: t.Optional(t.String({ maxLength: 512 })),
});

const config = {
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "agent_tool_authoring" },
  query: listSkillsQuerySchema,
} satisfies HandlerConfig;

type SkillCursor = {
  enabled: boolean;
  scope: AgentSkillScope;
  name: string;
  id: SafeId<"agentSkill">;
};

const isAgentSkillScope = (value: unknown): value is AgentSkillScope => {
  for (const scope of AGENT_SKILL_SCOPES) {
    if (value === scope) {
      return true;
    }
  }

  return false;
};

const decodeSkillCursor = (cursor: string): SkillCursor | null => {
  const parts = decodePaginationCursor(cursor);
  const enabled = parts?.at(0);
  const scope = parts?.at(1);
  const name = parts?.at(2);
  const id = parts?.at(3);

  if (
    typeof enabled !== "boolean" ||
    !isAgentSkillScope(scope) ||
    typeof name !== "string" ||
    !isUuidPaginationCursorPart(id)
  ) {
    return null;
  }

  return { enabled, scope, name, id: brandPersistedAgentSkillId(id) };
};

const listSkills = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, memberRole, query }) {
    const limit = query.limit ?? LIMITS.agentSkillsPageSizeDefault;

    const visibilityFilter = and(
      eq(agentSkills.organizationId, session.activeOrganizationId),
      or(
        eq(agentSkills.scope, AGENT_SKILL_SCOPES[0]), // "team"
        eq(agentSkills.userId, user.id),
      ),
    );
    const conditions = [visibilityFilter];

    if (query.cursor) {
      const cursor = decodeSkillCursor(query.cursor);

      if (!cursor) {
        return Result.err(
          new HandlerError({ status: 400, message: "Invalid cursor" }),
        );
      }

      const sameEnabledCursorCondition = or(
        and(
          eq(agentSkills.enabled, cursor.enabled),
          gt(agentSkills.scope, cursor.scope),
        ),
        and(
          eq(agentSkills.enabled, cursor.enabled),
          eq(agentSkills.scope, cursor.scope),
          gt(agentSkills.name, cursor.name),
        ),
        and(
          eq(agentSkills.enabled, cursor.enabled),
          eq(agentSkills.scope, cursor.scope),
          eq(agentSkills.name, cursor.name),
          gt(agentSkills.id, cursor.id),
        ),
      );

      const cursorCondition = cursor.enabled
        ? or(eq(agentSkills.enabled, false), sameEnabledCursorCondition)
        : sameEnabledCursorCondition;

      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }

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
            command: agentSkills.command,
            body: sql<string | null>`
              case
                when ${agentSkills.command} is not null then ${agentSkills.body}
                else null
              end
            `.as("body"),
            userId: agentSkills.userId,
            createdAt: agentSkills.createdAt,
          })
          .from(agentSkills)
          .where(and(...conditions))
          .orderBy(
            desc(agentSkills.enabled),
            asc(agentSkills.scope),
            asc(agentSkills.name),
            asc(agentSkills.id),
          )
          .limit(limit + 1),
      ),
    );
    const installedPage = createCursorPage({
      rows: installedRows,
      limit,
      cursorForItem: (item) =>
        encodePaginationCursor([item.enabled, item.scope, item.name, item.id]),
    });

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
      installed: installedPage.items,
      limit: installedPage.limit,
      nextCursor: installedPage.nextCursor,
    });
  },
);

export default listSkills;
