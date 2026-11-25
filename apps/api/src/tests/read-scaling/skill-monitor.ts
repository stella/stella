import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { agentSkills } from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import getSkillMonitor from "@/api/handlers/skills/monitor/get";
import { isHttpStatusResponse } from "@/api/http/status";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/** One private skill with `size` audit access rows in the 7-day monitor window. */
export const seedSkillMonitorScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@example.test`;
  const skillId = createSafeId<"agentSkill">();
  const rlsDb = markRlsDatabase(db);
  const scopedDb = createScopedDb(rlsDb, [], organizationId, userId);
  const safeDb = createSafeDb(rlsDb, [], organizationId, userId);
  const recordAuditEvent = createBackgroundAuditRecorder({
    execution: {
      performer: { id: userId, type: "user" },
      trigger: { type: "system", source: "skill_monitor_scaling_fixture" },
    },
    organizationId,
    userId,
    workspaceId: null,
  });
  const cleanup = async () => {
    await deleteOrganizationsForTest(db, [organizationId]);
    await db.delete(user).where(eq(user.id, userId));
  };
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "Skill monitor fixture",
      slug: organizationId,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(user).values({
      id: userId,
      name: "Skill monitor owner",
      email,
      emailVerified: true,
    });
    await recordNewOrganizationAccessState(db, {
      organizationId,
      now: new Date(),
    });
    await db.insert(member).values({
      id: Bun.randomUUIDv7(),
      userId,
      organizationId,
      role: "owner",
      createdAt: new Date(),
    });
    await scopedDb(async (tx) => {
      await tx.insert(agentSkills).values({
        body: "Read the references.",
        contentHash: "0".repeat(64),
        description: "Monitor scaling fixture.",
        id: skillId,
        metadata: {},
        name: "Monitor scaling",
        organizationId,
        origin: "authored",
        scope: "private",
        slug: "monitor-scaling",
        userId,
      });
      await recordAuditEvent(
        tx,
        Array.from({ length: size }, () => ({
          action: AUDIT_ACTION.ACCESS,
          metadata: { outcome: "ok", surface: "chat" },
          resourceId: skillId,
          resourceType: AUDIT_RESOURCE_TYPE.AGENT_SKILL,
        })),
      );
    });
    return {
      cleanup,
      email,
      organizationId,
      recordAuditEvent,
      safeDb,
      scopedDb,
      skillId,
      userId,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

type SkillMonitorFixture = Awaited<ReturnType<typeof seedSkillMonitorScaling>>;

export const skillMonitorScalingScenarios = [
  {
    name: "skill usage monitor",
    definition: getSkillMonitor,
    expectedRows: 7,
    // Audit rows are aggregated in memory into a fixed 7-day series and
    // bounded summaries, so statements, transactions, and payload size stay
    // constant as access logs grow.
    measure: async (fixture: SkillMonitorFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await getSkillMonitor.handler(
          createTestHandlerContext<
            Parameters<typeof getSkillMonitor.handler>[0]
          >({
            audit: fixture.recordAuditEvent,
            params: { skillId: fixture.skillId },
            query: { days: 7 },
            request: new Request(
              `https://example.test/v1/skills/${fixture.skillId}/monitor?days=7`,
            ),
            route: "/v1/skills/:skillId/monitor",
            safeDb: fixture.safeDb,
            scopedDb: fixture.scopedDb,
            session: { activeOrganizationId: fixture.organizationId },
            user: { email: fixture.email, id: fixture.userId },
          }),
        );
        if (
          isHttpStatusResponse(response) ||
          response.dailyTrend.length !== 7
        ) {
          panic("Skill monitor scaling requires a 7-day summary response");
        }
        return {
          rows: response.dailyTrend.length,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
        };
      }),
  },
];
