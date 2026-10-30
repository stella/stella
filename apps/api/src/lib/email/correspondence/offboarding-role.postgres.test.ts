import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { compareCodeUnit } from "@stll/collation";

import { member, organization, user } from "@/api/db/auth-schema";
import { correspondence, workspaces } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { clearCorrespondenceAssignmentsForOffboarding } from "@/api/lib/email/correspondence/offboarding";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const correspondenceRow = (
  organizationId: SafeId<"organization">,
  workspaceId: SafeId<"workspace">,
  assigneeId: SafeId<"user">,
) =>
  ({
    id: createSafeId<"correspondence">(),
    organizationId,
    workspaceId,
    direction: "in" as const,
    channel: "email" as const,
    source: "delivery" as const,
    intake: "direct" as const,
    originalSignature: null,
    authenticatedSenderAddress: "sender@example.test",
    contentHash: "a".repeat(64),
    dedupKey: Bun.randomUUIDv7().replaceAll("-", "").repeat(2),
    from: { address: "sender@example.test", name: null },
    to: [],
    cc: [],
    subject: "Member removal assignment",
    sentAt: null,
    receivedAt: new Date("2026-10-28T12:00:00.000Z"),
    inReplyTo: null,
    references: [],
    bodyText: "Retained correspondence",
    bodyHtml: null,
    spf: "pass" as const,
    dkim: "pass" as const,
    dmarc: "pass" as const,
    alignedIdentifier: null,
    handlingState: "new" as const,
    assigneeId,
  }) satisfies typeof correspondence.$inferInsert;

if (!databaseUrl || !enabled) {
  describe.skip("correspondence offboarding role (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("correspondence offboarding role (postgres)", () => {
    test("clears only the locked member's assignments in the target organization", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const organizationId = mintAuthProviderId<"organization">();
        const otherOrganizationId = mintAuthProviderId<"organization">();
        const departingUserId = mintAuthProviderId<"user">();
        const otherUserId = mintAuthProviderId<"user">();
        const memberId = Bun.randomUUIDv7();
        const otherOrganizationMemberId = Bun.randomUUIDv7();
        const targetWorkspaceId = createSafeId<"workspace">();
        const otherWorkspaceId = createSafeId<"workspace">();
        const targetAssignment = correspondenceRow(
          organizationId,
          targetWorkspaceId,
          departingUserId,
        );
        const otherOrganizationAssignment = correspondenceRow(
          otherOrganizationId,
          otherWorkspaceId,
          departingUserId,
        );
        const otherAssigneeAssignment = correspondenceRow(
          organizationId,
          targetWorkspaceId,
          otherUserId,
        );

        try {
          await db.insert(user).values([
            {
              id: departingUserId,
              name: "Departing member",
              email: `${departingUserId.toLowerCase()}@correspondence-offboarding.test`,
            },
            {
              id: otherUserId,
              name: "Other assignee",
              email: `${otherUserId.toLowerCase()}@correspondence-offboarding.test`,
            },
          ]);
          await db.insert(organization).values([
            {
              id: organizationId,
              name: "Target organization",
              slug: organizationId,
              createdAt: new Date(),
            },
            {
              id: otherOrganizationId,
              name: "Other organization",
              slug: otherOrganizationId,
              createdAt: new Date(),
            },
          ]);
          await Promise.all(
            [organizationId, otherOrganizationId].map(
              async (id) =>
                await recordNewOrganizationAccessState(db, {
                  organizationId: id,
                  now: new Date(),
                }),
            ),
          );
          await db.insert(member).values([
            {
              id: memberId,
              organizationId,
              userId: departingUserId,
              role: "member",
              createdAt: new Date(),
            },
            {
              id: otherOrganizationMemberId,
              organizationId: otherOrganizationId,
              userId: departingUserId,
              role: "member",
              createdAt: new Date(),
            },
            {
              id: Bun.randomUUIDv7(),
              organizationId,
              userId: otherUserId,
              role: "owner",
              createdAt: new Date(),
            },
          ]);
          await db.insert(workspaces).values([
            {
              id: targetWorkspaceId,
              organizationId,
              name: "Target matter",
              reference: targetWorkspaceId,
            },
            {
              id: otherWorkspaceId,
              organizationId: otherOrganizationId,
              name: "Other matter",
              reference: otherWorkspaceId,
            },
          ]);
          await createScopedDb(
            markRlsDatabase(db),
            [targetWorkspaceId],
            organizationId,
            departingUserId,
          )(async (tx) => {
            await tx
              .insert(correspondence)
              .values([targetAssignment, otherAssigneeAssignment]);
          });
          await createScopedDb(
            markRlsDatabase(db),
            [otherWorkspaceId],
            otherOrganizationId,
            departingUserId,
          )(async (tx) => {
            await tx.insert(correspondence).values(otherOrganizationAssignment);
          });

          await db.transaction(async (tx) => {
            const lockedMember = await tx
              .select({ id: member.id })
              .from(member)
              .where(
                and(
                  eq(member.id, memberId),
                  eq(member.organizationId, organizationId),
                  eq(member.userId, departingUserId),
                ),
              )
              .for("update");
            expect(lockedMember).toEqual([{ id: memberId }]);
            await tx.execute(sql`
              SELECT
                set_config('app.organization_id', ${organizationId}, true),
                set_config(
                  'app.member_removal_user_id',
                  ${departingUserId},
                  true
                ),
                set_config(
                  'app.member_removal_member_id',
                  ${memberId},
                  true
                )
            `);
            await tx.execute(
              sql`SET LOCAL ROLE stella_correspondence_offboarding`,
            );

            const bodyRead = await tx
              .transaction(
                async (savepoint) =>
                  await savepoint
                    .select({ bodyText: correspondence.bodyText })
                    .from(correspondence),
              )
              .then(
                () => ({ status: "committed" as const }),
                (error: unknown) => ({ status: "refused" as const, error }),
              );
            expect(bodyRead.status).toBe("refused");
            if (bodyRead.status === "refused") {
              expect(getPgErrorCode(bodyRead.error)).toBe("42501");
            }

            const otherOrganizationMutation = await tx
              .update(correspondence)
              .set({ assigneeId: null, updatedAt: new Date() })
              .where(eq(correspondence.id, otherOrganizationAssignment.id))
              .returning({ id: correspondence.id });
            expect(otherOrganizationMutation).toEqual([]);

            const otherAssigneeMutation = await tx
              .update(correspondence)
              .set({ assigneeId: null, updatedAt: new Date() })
              .where(eq(correspondence.id, otherAssigneeAssignment.id))
              .returning({ id: correspondence.id });
            expect(otherAssigneeMutation).toEqual([]);

            const nonNullReassignment = await tx
              .transaction(
                async (savepoint) =>
                  await savepoint
                    .update(correspondence)
                    .set({ assigneeId: otherUserId, updatedAt: new Date() })
                    .where(eq(correspondence.id, targetAssignment.id)),
              )
              .then(
                () => ({ status: "committed" as const }),
                (error: unknown) => ({ status: "refused" as const, error }),
              );
            expect(nonNullReassignment.status).toBe("refused");
            if (nonNullReassignment.status === "refused") {
              expect(getPgErrorCode(nonNullReassignment.error)).toBe("42501");
            }

            const bodyUpdate = await tx
              .transaction(
                async (savepoint) =>
                  await savepoint
                    .update(correspondence)
                    .set({ bodyText: "Changed" })
                    .where(eq(correspondence.id, targetAssignment.id)),
              )
              .then(
                () => ({ status: "committed" as const }),
                (error: unknown) => ({ status: "refused" as const, error }),
              );
            expect(bodyUpdate.status).toBe("refused");
            if (bodyUpdate.status === "refused") {
              expect(getPgErrorCode(bodyUpdate.error)).toBe("42501");
            }

            const clearedCount =
              await clearCorrespondenceAssignmentsForOffboarding({
                tx,
                userId: departingUserId,
                scope: { type: "organization", organizationId },
              });
            expect(clearedCount).toBe(1);
          });

          const rows = (
            await Promise.all(
              [
                { organizationId, workspaceId: targetWorkspaceId },
                {
                  organizationId: otherOrganizationId,
                  workspaceId: otherWorkspaceId,
                },
              ].map(
                async (scope) =>
                  await createScopedDb(
                    markRlsDatabase(db),
                    [scope.workspaceId],
                    scope.organizationId,
                    departingUserId,
                  )(
                    async (tx) =>
                      await tx
                        .select({
                          id: correspondence.id,
                          assigneeId: correspondence.assigneeId,
                        })
                        .from(correspondence)
                        .where(
                          inArray(correspondence.id, [
                            targetAssignment.id,
                            otherOrganizationAssignment.id,
                            otherAssigneeAssignment.id,
                          ]),
                        ),
                  ),
              ),
            )
          )
            .flat()
            .toSorted((left, right) => compareCodeUnit(left.id, right.id));
          expect(rows).toEqual(
            [
              {
                id: targetAssignment.id,
                assigneeId: null,
              },
              {
                id: otherAssigneeAssignment.id,
                assigneeId: otherUserId,
              },
              {
                id: otherOrganizationAssignment.id,
                assigneeId: departingUserId,
              },
            ].toSorted((left, right) => compareCodeUnit(left.id, right.id)),
          );
        } finally {
          await db
            .delete(organization)
            .where(
              inArray(organization.id, [organizationId, otherOrganizationId]),
            );
          await db
            .delete(user)
            .where(inArray(user.id, [departingUserId, otherUserId]));
        }
      });
    });
  });
}
