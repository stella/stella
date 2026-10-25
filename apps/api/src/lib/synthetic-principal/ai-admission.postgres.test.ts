import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { env } from "@/api/env";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE } from "@/api/lib/ai-config-response";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { decideChatUsageLane } from "@/api/lib/usage/lane-routing";
import { memberMayUseAI } from "@/api/lib/usage/member-capacity";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";

import { SYNTHETIC_PRINCIPAL } from "./constants";

const testState = createTestState({ file: import.meta.path, config: env });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// The same readers serve chat, structured calls, and request authentication.
const readers = { config: loadOrgAIConfig, settings: loadOrgAISettings };

describe.skipIf(!enabled)("monitoring principal AI admission", () => {
  test("monitoring work stays unavailable across deployment settings while ordinary fresh organizations retain admission", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      try {
        await db.transaction(async (tx) => {
          const normal = {
            organizationId: mintAuthProviderId<"organization">(),
            userId: mintAuthProviderId<"user">(),
          };
          await tx.insert(user).values({
            id: normal.userId,
            email: `${normal.userId}@example.test`,
            name: "Čeněk Nový",
          });
          const synthetic = {
            organizationId: brandPersistedOrganizationId(
              SYNTHETIC_PRINCIPAL.org.id,
            ),
            userId: brandPersistedUserId(SYNTHETIC_PRINCIPAL.user.id),
          };
          for (const feature of [false, true]) {
            testState.setConfig("FEATURE_ORG_ACCESS_STATE", feature);
            testState.setConfig("ORG_EVALUATION_PERIOD_DAYS", 7);
            const organizationId = mintAuthProviderId<"organization">();
            await tx.insert(organization).values({
              id: organizationId,
              name: "Nová kancelář",
              slug: organizationId,
              createdAt: new Date(),
            });
            await recordNewOrganizationAccessState(tx, {
              organizationId,
              now: new Date(),
            });
            // AI admission requires current organization membership.
            await tx.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId: normal.userId,
              role: "owner",
              createdAt: new Date(),
            });
            const ordinary = { organizationId, userId: normal.userId };
            for (const personalKey of [false, true]) {
              testState.setConfig("REQUIRE_PERSONAL_AI_KEY", personalKey);
              expect(
                await memberMayUseAI(
                  tx,
                  synthetic.organizationId,
                  synthetic.userId,
                ),
              ).toBe(false);
              expect(
                await memberMayUseAI(
                  tx,
                  ordinary.organizationId,
                  ordinary.userId,
                ),
              ).toBe(true);
              expect(await decideChatUsageLane({ tx, ...synthetic })).toBe(
                "unassigned",
              );
              expect(await decideChatUsageLane({ tx, ...ordinary })).toBe(
                "pool",
              );
              for (const load of Object.values(readers)) {
                const denied = await load(tx, synthetic);
                expect(denied.status).toBe("error");
                if (denied.status === "error") {
                  expect(denied.error.status).toBe(403);
                  expect(denied.error.code).toBe(
                    AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE,
                  );
                }
                expect((await load(tx, ordinary)).status).toBe("ok");
              }
              expect(
                (await loadOrgSettingsForAuth(tx, synthetic)).orgAIConfigStatus,
              ).toBe(ORG_AI_CONFIG_STATUS.memberAssignmentRequired);
              expect(
                (await loadOrgSettingsForAuth(tx, ordinary)).orgAIConfigStatus,
              ).toBe(ORG_AI_CONFIG_STATUS.ok);
            }
          }
          tx.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError)) {
          throw error;
        }
      }
    });
  });
});
