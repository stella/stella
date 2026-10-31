import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import { workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { matterStewardRecoveryScalingScenario } from "@/api/tests/read-scaling/matter-steward-recovery";
import { writeScalingViolations } from "@/api/tests/read-scaling/measurement";

test.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "steward recovery refusal stays bounded as the organization's matter corpus grows",
  async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const results = [];
      for (const size of [10, 200]) {
        const organizationId = mintAuthProviderId<"organization">();
        const userId = mintAuthProviderId<"user">();
        const stewardUserId = mintAuthProviderId<"user">();
        const workspaceIds = Array.from({ length: size }, () =>
          createSafeId<"workspace">(),
        );
        const workspaceId =
          workspaceIds.at(0) ?? panic("Missing matter fixture");
        await db
          .insert(organization)
          .values({
            id: organizationId,
            name: "Recovery firm",
            slug: organizationId,
            createdAt: new Date(),
          });
        await recordNewOrganizationAccessState(db, {
          organizationId,
          now: new Date(),
        });
        await db
          .insert(user)
          .values(
            [userId, stewardUserId].map((id) => ({
              id,
              name: "Recovery member",
              email: `${id}@example.test`,
            })),
          );
        try {
          await db.insert(member).values([
            {
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "owner",
              createdAt: new Date(),
            },
            {
              id: mintAuthProviderIdValue(),
              organizationId,
              userId: stewardUserId,
              role: "member",
              createdAt: new Date(),
            },
          ]);
          await db
            .insert(workspaces)
            .values(
              workspaceIds.map((id) => ({
                id,
                organizationId,
                name: "Recovery matter",
                reference: id,
                visibility: MATTER_VISIBILITY.adminsAndAssigned,
              })),
            );
          const context = asTestRaw<
            Parameters<typeof matterStewardRecoveryScalingScenario.measure>[0]
          >({
            request: new Request(
              `https://example.test/v1/workspaces/${workspaceId}/recover-steward`,
              { method: "POST" },
            ),
            route: "/v1/workspaces/:workspaceId/recover-steward",
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            memberRole: sessionMemberRole("owner"),
            params: { workspaceId },
            body: { stewardUserId },
            createAuditRecorder: () => () =>
              panic("A recovery refusal must not record a mutation"),
          });
          const measured =
            await matterStewardRecoveryScalingScenario.measure(context);
          expect(measured.statements).toBeGreaterThan(0);
          results.push(measured);
        } finally {
          await db
            .delete(workspaces)
            .where(eq(workspaces.organizationId, organizationId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db
            .delete(user)
            .where(inArray(user.id, [userId, stewardUserId]));
        }
      }
      const small = results.at(0) ?? panic("Missing small measurement");
      const large = results.at(1) ?? panic("Missing large measurement");
      expect(writeScalingViolations({ small, large })).toEqual([]);
    });
  },
);
