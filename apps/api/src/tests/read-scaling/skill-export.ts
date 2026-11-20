import { panic, Result } from "better-result";
import { inArray } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources, agentSkills } from "@/api/db/schema";
import exportSkill from "@/api/handlers/skills/export";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** Files the exported skill holds, the same at every tenant cardinality. */
const TARGET_RESOURCES = 5;

/**
 * One organization's skill among `size` skills of other organizations, each
 * with as many files: the export reads only its own skill's rows.
 */
export const seedSkillExportScaling = async (db: GatedTestDb, size: number) => {
  const skill = (
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ) => ({
    body: "Read `references/topic-0.md`.",
    contentHash: "0".repeat(64),
    description: "Scaling fixture skill.",
    id: createSafeId<"agentSkill">(),
    metadata: {},
    name: "scaling-skill",
    organizationId,
    origin: "authored" as const,
    scope: "private" as const,
    slug: `scaling-skill-${createSafeId<"agentSkill">()}`,
    userId,
  });
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const target = skill(organizationId, userId);
  const peers = Array.from({ length: size }, () =>
    skill(mintAuthProviderId<"organization">(), mintAuthProviderId<"user">()),
  );
  const skills = [target, ...peers];
  await db.insert(agentSkills).values(skills);
  await db.insert(agentSkillResources).values(
    skills.flatMap((row) =>
      Array.from({ length: TARGET_RESOURCES }, (_, index) => ({
        content: `Topic ${String(index)}.`,
        organizationId: row.organizationId,
        path: `references/topic-${String(index)}.md`,
        sizeBytes: 8,
        skillId: row.id,
      })),
    ),
  );
  const safeDb: SafeDb = async (work) =>
    await Result.tryPromise(async () => await db.transaction(work));
  return {
    organizationId,
    safeDb,
    skillId: target.id,
    userId,
    cleanup: async () => {
      await db.delete(agentSkills).where(
        inArray(
          agentSkills.id,
          skills.map(({ id }) => id),
        ),
      );
    },
  };
};

type SkillExportFixture = Awaited<ReturnType<typeof seedSkillExportScaling>>;

export const skillExportScalingScenario = {
  name: "skill archive export",
  definition: exportSkill,
  measure: async (fixture: SkillExportFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await exportSkill.handler(
        asTestRaw<Parameters<typeof exportSkill.handler>[0]>({
          memberRole: sessionMemberRole("owner"),
          params: { skillId: fixture.skillId },
          recordAuditEvent: auditRecorderDouble(),
          request: new Request(
            `https://example.test/v1/skills/${fixture.skillId}/export`,
          ),
          route: "/v1/skills/:skillId/export",
          safeDb: fixture.safeDb,
          session: { activeOrganizationId: fixture.organizationId },
          user: {
            email: `${fixture.userId}@example.test`,
            emailVerified: true,
            id: fixture.userId,
          },
        }),
      );
      if (!(response instanceof Response)) {
        return panic("Skill export must answer with the archive");
      }
      const bytes = await response.arrayBuffer();
      return {
        responseBytes: bytes.byteLength,
        rows: TARGET_RESOURCES + 1,
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
      };
    }),
};
