import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import exportSkill from "@/api/handlers/skills/export";
import { isHttpStatusResponse } from "@/api/http/status";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

/** One private skill holding `size` files, as its author exports it. */
export const seedSkillExportScaling = async (db: GatedTestDb, size: number) => {
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
      trigger: { type: "user_dispatch", source: "action", userId },
    },
    organizationId,
    workspaceId: null,
    userId,
  });
  const cleanup = async () => {
    await deleteOrganizationsForTest(db, [organizationId]);
    await db.delete(user).where(eq(user.id, userId));
  };
  try {
    await db.insert(organization).values({
      id: organizationId,
      name: "Skill export fixture",
      slug: organizationId,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(user).values({
      id: userId,
      name: "Skill exporter",
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
      role: "member",
      createdAt: new Date(),
    });
    await scopedDb(async (tx) => {
      await tx.insert(agentSkills).values({
        body: "Read the references.",
        contentHash: "0".repeat(64),
        description: "Export scaling fixture.",
        id: skillId,
        metadata: {},
        name: "Export scaling",
        organizationId,
        origin: "authored",
        scope: "private",
        slug: "export-scaling",
        userId,
      });
      await tx.insert(agentSkillResources).values(
        Array.from({ length: size }, (_, index) => ({
          content: `Reference ${String(index)}\n`,
          organizationId,
          path: `references/ref-${String(index).padStart(4, "0")}.md`,
          sizeBytes: `Reference ${String(index)}\n`.length,
          skillId,
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

type SkillExportFixture = Awaited<ReturnType<typeof seedSkillExportScaling>>;

export const skillExportScalingScenarios = [
  {
    name: "skill package export grant",
    definition: exportSkill,
    expectedRows: 1,
    // The archive grows with the files and is stored, never returned: the
    // response is one download grant and the reads are one skill and one
    // bounded file set, whatever the count.
    measure: async (fixture: SkillExportFixture) =>
      await runWithMeasuredQueryCounter(async (counter) => {
        const response = await exportSkill.handler(
          createTestHandlerContext<Parameters<typeof exportSkill.handler>[0]>({
            audit: fixture.recordAuditEvent,
            params: { skillId: fixture.skillId },
            query: { format: "zip" },
            request: new Request(
              `https://example.test/v1/skills/${fixture.skillId}/export?format=zip`,
            ),
            route: "/v1/skills/:skillId/export",
            safeDb: fixture.safeDb,
            scopedDb: fixture.scopedDb,
            session: {
              activeOrganizationId: fixture.organizationId,
              id: Bun.randomUUIDv7(),
            },
            user: { email: fixture.email, id: fixture.userId },
          }),
        );
        if (
          isHttpStatusResponse(response) ||
          response.fileName !== "export-scaling.zip"
        ) {
          panic("Skill export scaling requires a successful grant");
        }
        return {
          rows: 1,
          // An instant prints without trailing zero digits, so its length
          // varies by the clock, not by the data.
          responseBytes: Buffer.byteLength(
            JSON.stringify({ ...response, expiresAt: "" }),
          ),
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
        };
      }),
  },
];
