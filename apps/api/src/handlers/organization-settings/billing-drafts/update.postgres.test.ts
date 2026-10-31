import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { createTestState } from "@stll/test-state";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  agentSkillResources,
  agentSkills,
  billingGuidelineFiles,
  featureEnrolments,
  organizationSettings,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

import updateBillingDraftConfiguration from "./update";

const testState = createTestState({ file: import.meta.path, config: env });
const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgres) {
  describe.skip("billing draft settings update on PostgreSQL", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("an administrator saves billing draft settings on the application role", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const skillId = createSafeId<"agentSkill">();
      const resourceId = createSafeId<"agentSkillResource">();
      // Billing administration is admitted by the deployment flag and the
      // actor's own time-billing enrolment.
      testState.setConfig("FEATURE_TIME_BILLING", true);

      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Billing settings PostgreSQL fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Billing administrator",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await db.insert(featureEnrolments).values({
          organizationId,
          userId,
          featureId: "time-billing",
        });
        await db.insert(agentSkills).values({
          id: skillId,
          organizationId,
          userId,
          scope: "team",
          origin: "authored",
          slug: "billing-rules",
          name: "Billing rules",
          description: "Rules",
          contentHash: "a".repeat(64),
          body: "Rules",
        });
        await db.insert(agentSkillResources).values({
          id: resourceId,
          organizationId,
          skillId,
          path: "references/firm.md",
          content: "# Billing\nDescribe the work",
          sizeBytes: 29,
        });

        // The scoped database runs every transaction on the application role.
        const safeDb = createSafeDb(db, [], organizationId, userId);
        const organizationRowLock = await safeDb(
          async (tx) =>
            await tx.execute(
              sql`SELECT id FROM ${organization} WHERE ${organization.id} = ${organizationId} FOR UPDATE`,
            ),
        );
        expect(
          organizationRowLock.isErr()
            ? getPgErrorCode(organizationRowLock.error)
            : "locked",
        ).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);

        const update = async (
          body: Parameters<
            typeof updateBillingDraftConfiguration.handler
          >[0]["body"],
        ) =>
          await updateBillingDraftConfiguration.handler(
            createTestHandlerContext<
              Parameters<typeof updateBillingDraftConfiguration.handler>[0]
            >({
              audit: auditRecorderDouble(),
              scopedDb: NO_DB,
              session: { activeOrganizationId: organizationId },
              user: { id: userId },
              safeDb,
              body,
            }),
          );

        const enabled = await update({
          expectedUpdatedAt: new Date(0).toISOString(),
          mode: "enabled",
          resourceIds: [resourceId],
        });
        expect(enabled).toMatchObject({ updated: true });
        const settings = await db
          .select({
            mode: organizationSettings.aiBillingDraftsMode,
            updatedAt: organizationSettings.updatedAt,
          })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId));
        expect(settings.map(({ mode }) => mode)).toEqual(["enabled"]);
        expect(
          await db
            .select({
              resourceId: billingGuidelineFiles.resourceId,
              clientId: billingGuidelineFiles.clientId,
            })
            .from(billingGuidelineFiles)
            .where(eq(billingGuidelineFiles.organizationId, organizationId)),
        ).toEqual([{ resourceId, clientId: null }]);

        // A second write updates the existing settings row under the same fence.
        const savedAt =
          settings.at(0)?.updatedAt.toISOString() ?? new Date(0).toISOString();
        expect(
          await update({ expectedUpdatedAt: savedAt, mode: "disabled" }),
        ).toMatchObject({ updated: true });
        expect(
          await db
            .select({ mode: organizationSettings.aiBillingDraftsMode })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId)),
        ).toEqual([{ mode: "disabled" }]);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}
