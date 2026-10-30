import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import {
  desktopEditHandoffs,
  entityVersions,
  pdfSigningSessions,
  properties,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { withOrgScopedFixture } from "@/api/tests/helpers/org-scoped-fixture";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!databaseUrl || !enabled)(
  "member exchange offboarding role (postgres)",
  () => {
    test("deletes only target-owned historical exchanges in the locked organization scope", async () => {
      await withGatedTestClients(databaseUrl!, async ({ openClient }) => {
        const { db } = openClient();
        const target = await flowReviewGateFixture(db, { intermediate: false });
        const otherOrganization = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const targetMember = (
          await db
            .select({ id: member.id })
            .from(member)
            .where(
              and(
                eq(member.organizationId, target.organizationId),
                eq(member.userId, target.userId),
              ),
            )
            .limit(1)
        ).at(0);
        if (targetMember === undefined) {
          throw new Error("Missing target organization membership");
        }

        const targetPropertyId = createSafeId<"property">();
        const otherPropertyId = createSafeId<"property">();
        const targetVersionId = createSafeId<"entityVersion">();
        const otherVersionId = createSafeId<"entityVersion">();
        const targetHandoffId = createSafeId<"desktopEditHandoff">();
        const colleagueHandoffId = createSafeId<"desktopEditHandoff">();
        const foreignHandoffId = createSafeId<"desktopEditHandoff">();
        const targetSigningId = createSafeId<"pdfSigningSession">();
        const colleagueSigningId = createSafeId<"pdfSigningSession">();
        const foreignSigningId = createSafeId<"pdfSigningSession">();
        const expired = new Date(Date.now() - 60_000);
        const token = (digit: string) => digit.repeat(64);

        try {
          await db.insert(properties).values([
            {
              id: targetPropertyId,
              workspaceId: target.workspaceId,
              name: "Target exchange",
              status: "fresh",
              content: { version: 1, type: "file" },
              tool: { version: 1, type: "manual-input" },
            },
            {
              id: otherPropertyId,
              workspaceId: otherOrganization.workspaceId,
              name: "Other organization exchange",
              status: "fresh",
              content: { version: 1, type: "file" },
              tool: { version: 1, type: "manual-input" },
            },
          ]);
          await db.insert(entityVersions).values([
            {
              id: targetVersionId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              createdBy: target.userId,
              versionNumber: 1,
              description: "Initial version",
            },
            {
              id: otherVersionId,
              workspaceId: otherOrganization.workspaceId,
              entityId: otherOrganization.taskEntityId,
              createdBy: otherOrganization.userId,
              versionNumber: 1,
              description: "Initial version",
            },
          ]);
          await db.insert(desktopEditHandoffs).values([
            {
              id: targetHandoffId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              propertyId: targetPropertyId,
              createdBy: target.userId,
              tokenHash: token("1"),
              apiBaseUrl: "https://example.test",
              expiresAt: expired,
            },
            {
              id: colleagueHandoffId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              propertyId: targetPropertyId,
              createdBy: otherOrganization.userId,
              tokenHash: token("2"),
              apiBaseUrl: "https://example.test",
              expiresAt: expired,
            },
            {
              id: foreignHandoffId,
              workspaceId: otherOrganization.workspaceId,
              entityId: otherOrganization.taskEntityId,
              propertyId: otherPropertyId,
              createdBy: target.userId,
              tokenHash: token("3"),
              apiBaseUrl: "https://example.test",
              expiresAt: expired,
            },
          ]);
          const signingRows = [
            {
              id: targetSigningId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              propertyId: targetPropertyId,
              baseVersionId: targetVersionId,
              createdBy: target.userId,
              handoffTokenHash: token("4"),
              handoffExpiresAt: expired,
              tokenExpiresAt: expired,
              status: "cancelled",
              closeReason: "user_cancelled",
              closedAt: expired,
            },
            {
              id: colleagueSigningId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              propertyId: targetPropertyId,
              baseVersionId: targetVersionId,
              createdBy: otherOrganization.userId,
              handoffTokenHash: token("5"),
              handoffExpiresAt: expired,
              tokenExpiresAt: expired,
            },
            {
              id: foreignSigningId,
              workspaceId: otherOrganization.workspaceId,
              entityId: otherOrganization.taskEntityId,
              propertyId: otherPropertyId,
              baseVersionId: otherVersionId,
              createdBy: target.userId,
              handoffTokenHash: token("6"),
              handoffExpiresAt: expired,
              tokenExpiresAt: expired,
            },
          ] as const satisfies readonly (typeof pdfSigningSessions.$inferInsert)[];
          for (const owner of [target, otherOrganization]) {
            await withOrgScopedFixture({
              database: db,
              workspaceId: owner.workspaceId,
              fn: async (tx) =>
                await tx
                  .insert(pdfSigningSessions)
                  .values(
                    signingRows.filter(
                      (row) => row.workspaceId === owner.workspaceId,
                    ),
                  ),
            });
          }

          const attempt = async (scope: {
            organizationId: string;
            userId: string;
            workspaceIds: readonly string[];
          }) =>
            await db.transaction(async (tx) => {
              const locked = await tx
                .select({ id: member.id })
                .from(member)
                .where(
                  and(
                    eq(member.id, targetMember.id),
                    eq(member.organizationId, target.organizationId),
                    eq(member.userId, target.userId),
                  ),
                )
                .for("update");
              expect(locked).toEqual([{ id: targetMember.id }]);
              await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, target.workspaceId))
                .for("update");
              await tx.execute(sql`
                SELECT
                  set_config('app.organization_id', ${scope.organizationId}, true),
                  set_config('app.member_removal_user_id', ${scope.userId}, true),
                  set_config('app.member_removal_member_id', ${targetMember.id}, true),
                  set_config('app.workspace_ids', ${`{${scope.workspaceIds.join(",")}}`}, true)
              `);
              await tx.execute(
                sql`SET LOCAL ROLE stella_member_exchange_offboarding`,
              );
              return await tx
                .delete(desktopEditHandoffs)
                .where(inArray(desktopEditHandoffs.id, [targetHandoffId]))
                .returning({ id: desktopEditHandoffs.id });
            });

          expect(
            await attempt({
              organizationId: otherOrganization.organizationId,
              userId: target.userId,
              workspaceIds: [target.workspaceId],
            }),
          ).toEqual([]);
          expect(
            await attempt({
              organizationId: target.organizationId,
              userId: otherOrganization.userId,
              workspaceIds: [target.workspaceId],
            }),
          ).toEqual([]);
          expect(
            await attempt({
              organizationId: target.organizationId,
              userId: target.userId,
              workspaceIds: [],
            }),
          ).toEqual([]);

          const deletedHandoffs = await db.transaction(async (tx) => {
            await tx
              .select({ id: member.id })
              .from(member)
              .where(eq(member.id, targetMember.id))
              .for("update");
            await tx
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.id, target.workspaceId))
              .for("update");
            await tx.execute(sql`
              SELECT
                set_config('app.organization_id', ${target.organizationId}, true),
                set_config('app.member_removal_user_id', ${target.userId}, true),
                set_config('app.member_removal_member_id', ${targetMember.id}, true),
                set_config('app.workspace_ids', ${`{${target.workspaceId}}`}, true)
            `);
            await tx.execute(
              sql`SET LOCAL ROLE stella_member_exchange_offboarding`,
            );
            const handoffs = await tx
              .delete(desktopEditHandoffs)
              .where(
                inArray(desktopEditHandoffs.id, [
                  targetHandoffId,
                  colleagueHandoffId,
                  foreignHandoffId,
                ]),
              )
              .returning({ id: desktopEditHandoffs.id });
            const signing = await tx
              .delete(pdfSigningSessions)
              .where(
                inArray(pdfSigningSessions.id, [
                  targetSigningId,
                  colleagueSigningId,
                  foreignSigningId,
                ]),
              )
              .returning({ id: pdfSigningSessions.id });
            return { handoffs, signing };
          });
          expect(deletedHandoffs.handoffs).toEqual([{ id: targetHandoffId }]);
          expect(deletedHandoffs.signing).toEqual([{ id: targetSigningId }]);
          expect(
            await db
              .select({ id: desktopEditHandoffs.id })
              .from(desktopEditHandoffs)
              .where(
                inArray(desktopEditHandoffs.id, [
                  targetHandoffId,
                  colleagueHandoffId,
                  foreignHandoffId,
                ]),
              ),
          ).toHaveLength(2);
          expect(
            await db
              .select({ id: pdfSigningSessions.id })
              .from(pdfSigningSessions)
              .where(
                inArray(pdfSigningSessions.id, [
                  targetSigningId,
                  colleagueSigningId,
                  foreignSigningId,
                ]),
              ),
          ).toHaveLength(2);
        } finally {
          await otherOrganization.cleanup();
          await target.cleanup();
        }
      });
    });
  },
);
