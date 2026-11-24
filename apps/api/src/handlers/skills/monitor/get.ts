import { Result } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { member, user as userTable } from "@/api/db/auth-schema";
import { agentSkillResources, auditLogs } from "@/api/db/schema";
import { loadManagedSkill } from "@/api/handlers/skills/managed-skill";
import {
  aggregateSkillMonitor,
  SKILL_MONITOR_WINDOWS,
  type SkillMonitorWindowDays,
} from "@/api/handlers/skills/monitor/monitor.logic";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const MONITOR_AUDIT_ROW_LIMIT = 20_000;

const monitorParamsSchema = v.object({
  skillId: resourceIdSchema("agentSkill"),
});

const monitorQuerySchema = v.object({
  days: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(4),
      v.transform(Number),
      v.picklist(SKILL_MONITOR_WINDOWS),
    ),
  ),
});

const config = {
  contract: "patch",
  description:
    "Read usage monitoring metrics for one agent skill over a 7, 30, or 90 " +
    "day window: runs, unique users, average DAU, Chat vs. MCP reads, daily " +
    "trend, and per-file context reads. Restricted to skill managers " +
    "(private skill owner, or org admins/owners for team skills).",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "agent_tool_authoring",
    consumesServices: false,
  },
  params: monitorParamsSchema,
  query: monitorQuerySchema,
} satisfies HandlerConfig;

const getSkillMonitor = createSafeRootHandler(
  config,
  async function* ({ memberRole, params, query, safeDb, session, user }) {
    const skill = yield* Result.await(
      loadManagedSkill({
        action: "edit",
        memberRole,
        organizationId: session.activeOrganizationId,
        safeDb,
        skillId: params.skillId,
        userId: user.id,
      }),
    );

    const windowDays: SkillMonitorWindowDays = query.days ?? 7;
    const now = new Date();

    const [resourceRows, auditRows, profileRows] = yield* Result.await(
      safeDb(async (tx) => {
        const resources = await tx
          .select({ path: agentSkillResources.path })
          .from(agentSkillResources)
          .where(
            and(
              eq(agentSkillResources.skillId, skill.id),
              eq(
                agentSkillResources.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .orderBy(asc(agentSkillResources.path))
          .limit(LIMITS.agentSkillResourcesPerSkill);

        const logs = await tx
          .select({
            createdAt: auditLogs.createdAt,
            metadata: auditLogs.metadata,
            runId: auditLogs.runId,
            userId: auditLogs.userId,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, session.activeOrganizationId),
              eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.AGENT_SKILL),
              eq(auditLogs.resourceId, skill.id),
              eq(auditLogs.action, AUDIT_ACTION.ACCESS),
              sql`${auditLogs.createdAt} >= now() - make_interval(days => ${windowDays})`,
            ),
          )
          .orderBy(asc(auditLogs.createdAt))
          .limit(MONITOR_AUDIT_ROW_LIMIT);

        const userIds = [...new Set(logs.map((row) => row.userId))];
        const profiles =
          userIds.length === 0
            ? []
            : await tx
                .select({
                  id: userTable.id,
                  image: userTable.image,
                  name: userTable.name,
                })
                .from(userTable)
                .innerJoin(member, eq(member.userId, userTable.id))
                .where(
                  and(
                    eq(member.organizationId, session.activeOrganizationId),
                    inArray(userTable.id, userIds),
                  ),
                );

        return [resources, logs, profiles] as const;
      }),
    );

    const userProfiles = new Map(
      profileRows.map((row) => [row.id, { image: row.image, name: row.name }]),
    );

    return Result.ok(
      aggregateSkillMonitor({
        now,
        resourcePaths: resourceRows.map((row) => row.path),
        rows: auditRows,
        userProfiles,
        windowDays,
      }),
    );
  },
);

export default getSkillMonitor;
