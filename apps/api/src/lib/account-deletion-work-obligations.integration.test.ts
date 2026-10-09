import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, inArray, TransactionRollbackError } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  contacts,
  entities,
  taskAssignees,
  timeEntries,
  WORK_OBLIGATION_STATUS,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { reassignActiveTaskAssignmentsAndDropMemberships } from "@/api/lib/account-deletion-steps";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { clearMemberAssignments } from "@/api/lib/member-assignment-offboarding";
import { tryLockAccountMemberCleanup } from "@/api/lib/member-assignment-offboarding-owner";
import { cents } from "@/api/lib/money";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
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

test("account erasure unassigns open tasks, keeps finished work's assignee and attorney history", async () => {
  try {
    await testDb.transaction(async (tx) => {
      const taskIds = [createSafeId<"entity">(), createSafeId<"entity">()];
      await tx.insert(entities).values(
        taskIds.map((id, index) => ({
          id,
          workspaceId: ids.wsA2,
          kind: "task" as const,
          name: "Preserved task",
          status: index === 0 ? "open" : "done",
        })),
      );
      await tx.insert(taskAssignees).values(
        taskIds.map((entityId) => ({
          entityId,
          workspaceId: ids.wsA2,
          userId: ids.userA1,
          role: "assignee" as const,
        })),
      );
      const contactId = createSafeId<"contact">();
      await tx.insert(contacts).values({
        id: contactId,
        organizationId: ids.orgA,
        type: "person",
        displayName: "Assigned contact",
        originatingAttorneyId: ids.userA1,
        responsibleAttorneyId: ids.userA2,
      });
      const count = await reassignActiveTaskAssignmentsAndDropMemberships({
        tx: asTestRaw<Transaction>(tx),
        currentUserId: ids.userA1,
        deletionRequestId: createSafeId<"accountDeletionRequest">(),
        reassignments: [],
      });
      expect(count).toBe(0);
      expect(await tx.$count(entities, inArray(entities.id, taskIds))).toBe(2);
      const [openTaskId, doneTaskId] = taskIds;
      if (!openTaskId || !doneTaskId) {
        throw new Error("fixture tasks");
      }
      // Finished work keeps its former assignee as history.
      expect(
        await tx
          .select({ entityId: taskAssignees.entityId })
          .from(taskAssignees)
          .where(inArray(taskAssignees.entityId, taskIds)),
      ).toEqual([{ entityId: doneTaskId }]);
      expect(
        await tx
          .select({
            originating: contacts.originatingAttorneyId,
            responsible: contacts.responsibleAttorneyId,
          })
          .from(contacts)
          .where(eq(contacts.id, contactId)),
      ).toEqual([{ originating: null, responsible: ids.userA2 }]);
      const history = await tx
        .select({
          resourceId: auditLogs.resourceId,
          changes: auditLogs.changes,
        })
        .from(auditLogs)
        .where(inArray(auditLogs.resourceId, [...taskIds, contactId]));
      expect(history).toHaveLength(2);
      expect(history).toContainEqual(
        expect.objectContaining({
          resourceId: openTaskId,
          changes: expect.objectContaining({
            assigneeUserId: { old: ids.userA1, new: null },
          }),
        }),
      );
      expect(history).toContainEqual(
        expect.objectContaining({
          resourceId: contactId,
          changes: expect.objectContaining({
            originatingAttorneyId: { old: ids.userA1, new: null },
          }),
        }),
      );
      throw new TransactionRollbackError();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
});

type FixtureTransaction = Parameters<
  Parameters<TestDatabase["transaction"]>[0]
>[0];

const rollingBack = async (body: (tx: FixtureTransaction) => Promise<void>) => {
  try {
    await testDb.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
};

describe("account erasure spans every organization", () => {
  test("pending approvals in an organization the user already left are cleared and audited there", async () => {
    await rollingBack(async (tx) => {
      // The user left organization B earlier; its draft approval stayed.
      await tx.delete(member).where(eq(member.id, ids.memberA1orgB));
      const leftEntryId = createSafeId<"timeEntry">();
      const currentEntryId = createSafeId<"timeEntry">();
      const entry = {
        approverUserId: ids.userA1,
        dateWorked: new Date().toISOString().slice(0, 10),
        timezoneId: "UTC",
        durationMinutes: 30,
        billedMinutes: 30,
        rateAtEntry: cents(10_000),
        currency: "EUR",
        narrative: "Reviewed the file",
      };
      await tx.insert(timeEntries).values([
        {
          ...entry,
          id: leftEntryId,
          organizationId: ids.orgB,
          workspaceId: ids.wsB1,
          userId: ids.userB1,
        },
        {
          ...entry,
          id: currentEntryId,
          organizationId: ids.orgA,
          workspaceId: ids.wsA2,
          userId: ids.userA2,
        },
      ]);

      await reassignActiveTaskAssignmentsAndDropMemberships({
        tx: asTestRaw<Transaction>(tx),
        currentUserId: ids.userA1,
        deletionRequestId: createSafeId<"accountDeletionRequest">(),
        reassignments: [],
      });

      expect(
        await tx
          .select({
            id: timeEntries.id,
            approverUserId: timeEntries.approverUserId,
          })
          .from(timeEntries)
          .where(inArray(timeEntries.id, [leftEntryId, currentEntryId]))
          .orderBy(timeEntries.id),
      ).toEqual(
        [leftEntryId, currentEntryId]
          .toSorted()
          .map((id) => ({ id, approverUserId: null })),
      );
      expect(
        await tx
          .select({
            organizationId: auditLogs.organizationId,
            changes: auditLogs.changes,
          })
          .from(auditLogs)
          .where(eq(auditLogs.resourceId, leftEntryId)),
      ).toEqual([
        {
          organizationId: ids.orgB,
          changes: { approverUserId: { old: ids.userA1, new: null } },
        },
      ]);
    });
  });

  test("counted cleanup drains multiple tenant pages and audits every changed row", async () => {
    await rollingBack(async (tx) => {
      const raw = asTestRaw<Transaction>(tx);
      const tasks = Array.from(
        { length: LIMITS.memberRemovalCleanupBatchSize + 1 },
        (_, index) => ({
          id: createSafeId<"entity">(),
          workspaceId: index % 2 === 0 ? ids.wsA2 : ids.wsB1,
          kind: "task" as const,
          name: "Counted cleanup task",
          status: "open",
        }),
      );
      const attorneys = tasks.map((task) => ({
        id: createSafeId<"contact">(),
        organizationId: task.workspaceId === ids.wsA2 ? ids.orgA : ids.orgB,
        type: "person" as const,
        displayName: "Counted cleanup contact",
        responsibleAttorneyId: ids.userA1,
      }));
      const approvals = tasks.map(
        (task) =>
          ({
            id: createSafeId<"timeEntry">(),
            organizationId: task.workspaceId === ids.wsA2 ? ids.orgA : ids.orgB,
            workspaceId: task.workspaceId,
            userId: ids.userA1,
            approverUserId: ids.userA1,
            status: "draft" as const,
            dateWorked: "2026-10-01",
            timezoneId: "UTC",
            durationMinutes: 1,
            billedMinutes: 1,
            rateAtEntry: cents(0),
            currency: "EUR",
            narrative: "Counted cleanup approval",
          }) satisfies typeof timeEntries.$inferInsert,
      );
      await tx.insert(entities).values(tasks);
      await tx.insert(taskAssignees).values(
        tasks.map((task) => ({
          entityId: task.id,
          workspaceId: task.workspaceId,
          userId: ids.userA1,
          role: "assignee" as const,
        })),
      );
      await tx.insert(contacts).values(attorneys);
      await tx.insert(timeEntries).values(approvals);

      await clearMemberAssignments({
        tx: raw,
        scope: { type: "account" },
        userId: brandPersistedUserId(ids.userA1),
        actorUserId: brandPersistedUserId(ids.userA1),
      });

      expect(
        await tx.$count(
          taskAssignees,
          inArray(
            taskAssignees.entityId,
            tasks.map(({ id }) => id),
          ),
        ),
      ).toBe(0);
      expect(
        await tx.$count(
          contacts,
          and(
            inArray(
              contacts.id,
              attorneys.map(({ id }) => id),
            ),
            eq(contacts.responsibleAttorneyId, ids.userA1),
          ),
        ),
      ).toBe(0);
      expect(
        await tx.$count(
          timeEntries,
          and(
            inArray(
              timeEntries.id,
              approvals.map(({ id }) => id),
            ),
            eq(timeEntries.approverUserId, ids.userA1),
          ),
        ),
      ).toBe(0);
      const expected = new Map([
        ...tasks.map(
          (task) =>
            [
              String(task.id),
              task.workspaceId === ids.wsA2 ? ids.orgA : ids.orgB,
            ] as const,
        ),
        ...attorneys.map(
          (row) => [String(row.id), row.organizationId] as const,
        ),
        ...approvals.map(
          (row) => [String(row.id), row.organizationId] as const,
        ),
      ]);
      const audits = await tx
        .select({
          resourceId: auditLogs.resourceId,
          organizationId: auditLogs.organizationId,
        })
        .from(auditLogs)
        .where(inArray(auditLogs.resourceId, [...expected.keys()]));
      expect(audits).toHaveLength(expected.size);
      expect(new Set(audits.map(({ resourceId }) => resourceId)).size).toBe(
        expected.size,
      );
      for (const row of audits) {
        expect(expected.get(row.resourceId)).toBe(row.organizationId);
      }
    });
  });

  test("the matter bound is the per-organization cap once per organization involved", async () => {
    await rollingBack(async (tx) => {
      const raw = asTestRaw<Transaction>(tx);
      // Three affected matters across two organizations fit a cap of two per organization.
      expect(
        await tryLockAccountMemberCleanup({
          tx: raw,
          userId: brandPersistedUserId(ids.userA1),
          workspacesPerOrganization: 2,
        }),
      ).toBeUndefined();
      // A cap of one per organization cannot cover those three matters.
      const refused = await Result.tryPromise({
        try: async () =>
          await tryLockAccountMemberCleanup({
            tx: raw,
            userId: brandPersistedUserId(ids.userA1),
            workspacesPerOrganization: 1,
          }),
        catch: (error) => error,
      });
      expect(Result.isError(refused)).toBe(true);
      if (Result.isError(refused)) {
        expect(refused.error).toBeInstanceOf(HandlerError);
      }
    });
  });
});
