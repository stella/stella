import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, TransactionRollbackError } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  entities,
  taskAssignees,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { reassignActiveTaskAssignmentsAndDropMemberships } from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("account deletion governed ownership", () => {
  test("hands off reassigned work, unassigns other mutable work, and retains closed history", async () => {
    try {
      await testDb.transaction(async (tx) => {
        const handedEntityId = createSafeId<"entity">();
        const unassignedEntityId = createSafeId<"entity">();
        const closedEntityId = createSafeId<"entity">();

        await tx.insert(entities).values([
          {
            id: handedEntityId,
            workspaceId: ids.wsA2,
            kind: "task",
            name: "Account deletion handoff",
            status: "open",
          },
          {
            id: unassignedEntityId,
            workspaceId: ids.wsA2,
            kind: "task",
            name: "Account deletion unassignment",
            status: "open",
          },
          {
            id: closedEntityId,
            workspaceId: ids.wsA2,
            kind: "task",
            name: "Retained account deletion history",
            status: "completed",
          },
        ]);
        await tx.insert(taskAssignees).values({
          id: createSafeId<"taskAssignee">(),
          workspaceId: ids.wsA2,
          entityId: handedEntityId,
          userId: ids.userA1,
          role: "assignee",
        });
        await tx.insert(workObligations).values([
          {
            entityId: handedEntityId,
            workspaceId: ids.wsA2,
            ownerUserId: ids.userA1,
            status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
          },
          {
            entityId: unassignedEntityId,
            workspaceId: ids.wsA2,
            ownerUserId: ids.userA1,
            status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
          },
          {
            entityId: closedEntityId,
            workspaceId: ids.wsA2,
            ownerUserId: ids.userA1,
            status: WORK_OBLIGATION_STATUS.COMPLETED,
          },
        ]);

        const reassignmentCount =
          await reassignActiveTaskAssignmentsAndDropMemberships({
            tx: asTestRaw<Transaction>(tx),
            currentUserId: ids.userA1,
            deletionRequestId: createSafeId<"accountDeletionRequest">(),
            reassignments: [
              { entityId: handedEntityId, reassignedUserId: ids.userA2 },
            ],
          });

        expect(reassignmentCount).toBe(1);
        expect(
          await tx
            .select({
              entityId: taskAssignees.entityId,
              userId: taskAssignees.userId,
            })
            .from(taskAssignees)
            .where(eq(taskAssignees.entityId, handedEntityId)),
        ).toEqual([{ entityId: handedEntityId, userId: ids.userA2 }]);

        const obligations = await tx
          .select({
            entityId: workObligations.entityId,
            ownerUserId: workObligations.ownerUserId,
            status: workObligations.status,
          })
          .from(workObligations)
          .where(
            inArray(workObligations.entityId, [
              handedEntityId,
              unassignedEntityId,
              closedEntityId,
            ]),
          );
        expect(obligations).toEqual(
          expect.arrayContaining([
            {
              entityId: handedEntityId,
              ownerUserId: ids.userA2,
              status: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
            },
            {
              entityId: unassignedEntityId,
              ownerUserId: null,
              status: WORK_OBLIGATION_STATUS.UNASSIGNED,
            },
            {
              entityId: closedEntityId,
              ownerUserId: ids.userA1,
              status: WORK_OBLIGATION_STATUS.COMPLETED,
            },
          ]),
        );

        const events = await tx
          .select({
            obligationEntityId: workObligationEvents.obligationEntityId,
            details: workObligationEvents.details,
          })
          .from(workObligationEvents)
          .where(
            inArray(workObligationEvents.obligationEntityId, [
              handedEntityId,
              unassignedEntityId,
              closedEntityId,
            ]),
          );
        expect(events).toHaveLength(2);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              obligationEntityId: handedEntityId,
              details: expect.objectContaining({
                nextOwnerUserId: ids.userA2,
                cause: "account_deletion",
              }),
            }),
            expect.objectContaining({
              obligationEntityId: unassignedEntityId,
              details: expect.objectContaining({
                nextOwnerUserId: null,
                cause: "account_deletion",
              }),
            }),
          ]),
        );

        const obligationAudits = await tx
          .select({
            changes: auditLogs.changes,
            metadata: auditLogs.metadata,
            resourceId: auditLogs.resourceId,
          })
          .from(auditLogs)
          .where(
            and(
              inArray(auditLogs.resourceId, [
                handedEntityId,
                unassignedEntityId,
                closedEntityId,
              ]),
              eq(auditLogs.resourceType, "work_obligation"),
            ),
          );
        expect(obligationAudits).toHaveLength(2);
        expect(obligationAudits).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              resourceId: handedEntityId,
              changes: expect.objectContaining({
                ownerUserId: { old: ids.userA1, new: ids.userA2 },
              }),
              metadata: expect.objectContaining({
                cause: "account-deletion",
              }),
            }),
            expect.objectContaining({
              resourceId: unassignedEntityId,
              changes: expect.objectContaining({
                ownerUserId: { old: ids.userA1, new: null },
                status: {
                  old: WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
                  new: WORK_OBLIGATION_STATUS.UNASSIGNED,
                },
              }),
            }),
          ]),
        );

        tx.rollback();
      });
    } catch (error) {
      if (error instanceof TransactionRollbackError) {
        return;
      }
      throw error;
    }

    throw new Error("Expected the integration test transaction to roll back");
  });
});
