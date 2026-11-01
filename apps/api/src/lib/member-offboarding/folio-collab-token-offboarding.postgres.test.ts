import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entityVersions,
  flowRuns,
  folioCollabRooms,
  folioCollabRoomTokens,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";

import { removeOrganizationMemberInTransaction } from "./member-assignment-offboarding-owner";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!databaseUrl || !enabled)(
  "Folio collaboration token member-removal role (postgres)",
  () => {
    test("deletes only the departing member's API-issued tokens in locked organization workspaces", async () => {
      await withGatedTestClients(databaseUrl!, async ({ openClient }) => {
        const { db } = openClient();
        const target = await flowReviewGateFixture(db, { intermediate: false });
        const otherOrganization = await flowReviewGateFixture(db, {
          intermediate: false,
        });
        const roomId = createSafeId<"folioCollabRoom">();
        const otherOrganizationRoomId = createSafeId<"folioCollabRoom">();
        const propertyId = createSafeId<"property">();
        const otherOrganizationPropertyId = createSafeId<"property">();
        const versionId = createSafeId<"entityVersion">();
        const otherOrganizationVersionId = createSafeId<"entityVersion">();
        const targetTokenId = createSafeId<"folioCollabRoomToken">();
        const otherMemberTokenId = createSafeId<"folioCollabRoomToken">();
        const otherOrganizationTokenId = createSafeId<"folioCollabRoomToken">();
        const otherOrganizationMemberId = Bun.randomUUIDv7();
        const otherMemberId = Bun.randomUUIDv7();
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
        try {
          await db.insert(properties).values([
            {
              id: propertyId,
              workspaceId: target.workspaceId,
              name: "File",
              status: "fresh",
              content: { version: 1, type: "file" },
              tool: { version: 1, type: "manual-input" },
            },
            {
              id: otherOrganizationPropertyId,
              workspaceId: otherOrganization.workspaceId,
              name: "File",
              status: "fresh",
              content: { version: 1, type: "file" },
              tool: { version: 1, type: "manual-input" },
            },
          ]);
          await db.insert(entityVersions).values([
            {
              id: versionId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              createdBy: target.userId,
              versionNumber: 1,
              description: "Initial version",
            },
            {
              id: otherOrganizationVersionId,
              workspaceId: otherOrganization.workspaceId,
              entityId: otherOrganization.taskEntityId,
              createdBy: otherOrganization.userId,
              versionNumber: 1,
              description: "Initial version",
            },
          ]);
          await db.insert(member).values([
            {
              id: otherOrganizationMemberId,
              organizationId: otherOrganization.organizationId,
              userId: target.userId,
              role: "member",
              createdAt: new Date(),
            },
            {
              id: otherMemberId,
              organizationId: target.organizationId,
              userId: otherOrganization.userId,
              role: "member",
              createdAt: new Date(),
            },
          ]);
          await db.insert(folioCollabRooms).values([
            {
              id: roomId,
              workspaceId: target.workspaceId,
              entityId: target.taskEntityId,
              propertyId,
              baseVersionId: versionId,
              sourceVersionId: versionId,
              fileName: "Offboarding target.docx",
              yjsSnapshotFileId: createSafeId<"userFile">(),
              docxCheckpointFileId: createSafeId<"userFile">(),
            },
            {
              id: otherOrganizationRoomId,
              workspaceId: otherOrganization.workspaceId,
              entityId: otherOrganization.taskEntityId,
              propertyId: otherOrganizationPropertyId,
              baseVersionId: otherOrganizationVersionId,
              sourceVersionId: otherOrganizationVersionId,
              fileName: "Other organization.docx",
              yjsSnapshotFileId: createSafeId<"userFile">(),
              docxCheckpointFileId: createSafeId<"userFile">(),
            },
          ]);
          await db.insert(folioCollabRoomTokens).values([
            {
              id: targetTokenId,
              workspaceId: target.workspaceId,
              roomId,
              userId: target.userId,
              sourceSessionId: null,
              tokenHash: "a".repeat(64),
              generation: 0,
              permissions: { canEdit: true },
              expiresAt: new Date(Date.now() + 60_000),
            },
            {
              id: otherMemberTokenId,
              workspaceId: target.workspaceId,
              roomId,
              userId: otherOrganization.userId,
              sourceSessionId: null,
              tokenHash: "b".repeat(64),
              generation: 0,
              permissions: { canEdit: true },
              expiresAt: new Date(Date.now() + 60_000),
            },
            {
              id: otherOrganizationTokenId,
              workspaceId: otherOrganization.workspaceId,
              roomId: otherOrganizationRoomId,
              userId: target.userId,
              sourceSessionId: null,
              tokenHash: "c".repeat(64),
              generation: 0,
              permissions: { canEdit: true },
              expiresAt: new Date(Date.now() + 60_000),
            },
          ]);

          await db.transaction(async (tx) => {
            const lockedMember = await tx
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
            expect(lockedMember).toEqual([{ id: targetMember.id }]);
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
                set_config(
                  'app.workspace_ids',
                  ${`{${target.workspaceId},${otherOrganization.workspaceId}}`},
                  true
                )
            `);
            await tx.execute(
              sql`SET LOCAL ROLE stella_folio_collab_token_offboarding`,
            );

            const deleted = await tx
              .delete(folioCollabRoomTokens)
              .where(
                sql`id IN (${targetTokenId}, ${otherMemberTokenId}, ${otherOrganizationTokenId})`,
              )
              .returning({ id: folioCollabRoomTokens.id });
            expect(deleted).toEqual([{ id: targetTokenId }]);
          });

          const remaining = await db
            .select({ id: folioCollabRoomTokens.id })
            .from(folioCollabRoomTokens)
            .where(
              sql`id IN (${targetTokenId}, ${otherMemberTokenId}, ${otherOrganizationTokenId})`,
            );
          expect(remaining.map(({ id }) => id).toSorted()).toEqual(
            [otherMemberTokenId, otherOrganizationTokenId].toSorted(),
          );

          const applicationScope = createScopedDb(
            markRlsDatabase(db),
            [],
            target.organizationId,
            target.userId,
          );
          const ordinaryRole = await applicationScope(
            async (tx) =>
              await tx
                .delete(folioCollabRoomTokens)
                .where(eq(folioCollabRoomTokens.id, otherMemberTokenId))
                .returning({ id: folioCollabRoomTokens.id }),
          );
          expect(ordinaryRole).toEqual([]);
          // A credential remains an affected matter after its membership and live run have ended.
          const tokenAfterMatterRemoval =
            createSafeId<"folioCollabRoomToken">();
          await db
            .update(member)
            .set({ role: "owner" })
            .where(eq(member.id, otherMemberId));
          await db
            .update(flowRuns)
            .set({ status: "completed" })
            .where(eq(flowRuns.id, target.runId));
          await db
            .delete(workspaceMembers)
            .where(
              and(
                eq(workspaceMembers.workspaceId, target.workspaceId),
                eq(workspaceMembers.userId, target.userId),
              ),
            );
          await db.insert(folioCollabRoomTokens).values({
            id: tokenAfterMatterRemoval,
            workspaceId: target.workspaceId,
            roomId,
            userId: target.userId,
            sourceSessionId: null,
            tokenHash: "d".repeat(64),
            generation: 0,
            permissions: { canEdit: true },
            expiresAt: new Date(Date.now() + 60_000),
          });
          await withAggregateTransaction(
            db,
            async (tx) =>
              await removeOrganizationMemberInTransaction(tx, {
                organizationId: target.organizationId,
                memberId: targetMember.id,
                userId: target.userId,
                actorUserId: otherOrganization.userId,
              }),
          );
          expect(
            await db.$count(
              folioCollabRoomTokens,
              eq(folioCollabRoomTokens.id, tokenAfterMatterRemoval),
            ),
          ).toBe(0);
          expect(
            await db.$count(
              folioCollabRoomTokens,
              eq(folioCollabRoomTokens.id, otherOrganizationTokenId),
            ),
          ).toBe(1);
        } finally {
          await db
            .delete(organization)
            .where(
              inArray(organization.id, [
                target.organizationId,
                otherOrganization.organizationId,
              ]),
            );
          await db
            .delete(user)
            .where(inArray(user.id, [target.userId, otherOrganization.userId]));
        }
      });
    });
  },
);
