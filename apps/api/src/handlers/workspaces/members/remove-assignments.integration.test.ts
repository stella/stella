import { Result } from "better-result";
import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { and, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { assertProperty } from "@stll/property-testing";

import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  entities,
  taskAssignees,
  timeEntries,
  workObligations,
  workspaceMembers,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import calendarTasks from "@/api/handlers/tasks/calendar/list";
import { listTasksPage } from "@/api/handlers/tasks/list-query";
import { isAccountDeletionActiveTaskStatus } from "@/api/lib/account-deletion-reassignment";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { LIMITS } from "@/api/lib/limits";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { taskAssigneeCondition } from "@/api/lib/tasks/assigned";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import { removeWorkspaceMemberHandler } from "./remove";

setDefaultTimeout(120_000);
let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
beforeAll(async () => {
  fixture = await getRlsFixture();
});
afterAll(async () => {
  await releaseRlsFixture();
});
const dependencies = {
  broadcastSessionEvent: () => undefined,
  broadcastWorkspaceResourceSetUpdated: () => undefined,
  closeSessionConnections: () => undefined,
  revokeWorkspaceSseAccess: async () => {
    await Promise.resolve();
  },
} satisfies NonNullable<
  Parameters<typeof removeWorkspaceMemberHandler>[0]["dependencies"]
>;

test.each([
  "unassigned",
  "replacement",
  "existing-assignee",
  "invalid",
] as const)(
  "matter removal preserves tasks with %s disposition",
  async (disposition) => {
    const { testDb, ids } = fixture;
    const nextAssignee = disposition === "unassigned" ? null : ids.userA2;
    const result = await Result.tryPromise(async () => {
      await testDb.transaction(async (tx) => {
        const taskId = createSafeId<"entity">();
        const otherTaskId = createSafeId<"entity">();
        await tx.insert(entities).values([
          {
            id: taskId,
            workspaceId: ids.wsA2,
            kind: "task",
            name: "Assigned work",
            dueDate: "2026-10-03",
          },
          {
            id: otherTaskId,
            workspaceId: ids.wsA1,
            kind: "task",
            name: "Other matter work",
          },
        ]);
        await tx.insert(taskAssignees).values([
          {
            entityId: taskId,
            workspaceId: ids.wsA2,
            userId: ids.userA1,
            role: "assignee",
          },
          ...(disposition === "existing-assignee" || disposition === "invalid"
            ? [
                {
                  entityId: taskId,
                  workspaceId: ids.wsA2,
                  userId: ids.userA2,
                  role: "reviewer" as const,
                },
              ]
            : []),
          {
            entityId: otherTaskId,
            workspaceId: ids.wsA1,
            userId: ids.userA1,
            role: "assignee",
          },
        ]);
        await tx.insert(workObligations).values({
          entityId: taskId,
          workspaceId: ids.wsA2,
          ownerUserId: ids.userA1,
          status: "awaiting_acknowledgement",
        });
        const safeDb = asTestRaw<SafeDb>(
          createMembershipSafeDb(markRlsDatabase(tx), {
            organizationId: ids.orgA,
            serverValidatedWorkspaceIds: [ids.wsA2],
            userId: ids.userA2,
          }),
        );
        const recordAuditEvent = createAuditRecorder({
          organizationId: ids.orgA,
          workspaceId: ids.wsA2,
          userId: ids.userA2,
          request: new Request("https://api.example.test/remove"),
          server: null,
        });
        const removal = await Result.gen(() =>
          removeWorkspaceMemberHandler({
            safeDb,
            workspaceId: ids.wsA2,
            userId: ids.userA1,
            actorUserId: ids.userA2,
            recordAuditEvent,
            dependencies,
            ...(disposition === "unassigned"
              ? {}
              : {
                  reassignTo:
                    disposition === "invalid" ? ids.userB1 : ids.userA2,
                }),
          }),
        );
        await tx.execute(sql`RESET ROLE`);
        expect(Result.isError(removal)).toBe(disposition === "invalid");
        expect(
          await tx.$count(
            entities,
            inArray(entities.id, [taskId, otherTaskId]),
          ),
        ).toBe(2);
        const assignees = await tx
          .select({ userId: taskAssignees.userId, role: taskAssignees.role })
          .from(taskAssignees)
          .where(eq(taskAssignees.entityId, taskId));
        let expectedAssignees;
        if (disposition === "invalid") {
          expectedAssignees = expect.arrayContaining([
            { userId: ids.userA1, role: "assignee" },
            { userId: ids.userA2, role: "reviewer" },
          ]);
        } else if (disposition === "unassigned") {
          expectedAssignees = [];
        } else {
          expectedAssignees = [
            {
              userId: ids.userA2,
              role: disposition === "replacement" ? "assignee" : "reviewer",
            },
          ];
        }
        expect(assignees).toEqual(expectedAssignees);
        expect(
          await tx.$count(
            taskAssignees,
            and(
              eq(taskAssignees.entityId, otherTaskId),
              eq(taskAssignees.userId, ids.userA1),
            ),
          ),
        ).toBe(1);
        expect(
          await tx.$count(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, ids.wsA2),
              eq(workspaceMembers.userId, ids.userA1),
            ),
          ),
        ).toBe(disposition === "invalid" ? 1 : 0);
        if (disposition === "unassigned") {
          const page = await listTasksPage({
            safeDb,
            organizationId: ids.orgA,
            userId: ids.userA2,
            workspaceIds: [ids.wsA2],
            query: { assignee: "unassigned" },
          });
          if (Result.isError(page)) {
            throw page.error;
          }
          expect(page.value.items.map(({ id }) => id)).toContain(taskId);
          const calendar = await calendarTasks.handler(
            asTestRaw<Parameters<typeof calendarTasks.handler>[0]>({
              safeDb,
              workspaceId: ids.wsA2,
              user: { id: ids.userA2 },
              memberRole: sessionMemberRole("owner"),
              session: { activeOrganizationId: ids.orgA },
              body: {
                dateFrom: "2026-10-01T00:00:00.000Z",
                dateTo: "2026-10-31T23:59:59.000Z",
                datePropertyIds: ["_due-date"],
              },
            }),
          );
          expect(calendar).toMatchObject({
            tasks: expect.arrayContaining([
              expect.objectContaining({ taskId }),
            ]),
          });
          await tx.execute(sql`RESET ROLE`);
          expect(
            await tx.$count(
              entities,
              and(
                eq(entities.id, taskId),
                taskAssigneeCondition({ assignee: "me", userId: ids.userA1 }),
              ),
            ),
          ).toBe(0);
        }
        expect(
          await tx
            .select({
              owner: workObligations.ownerUserId,
              status: workObligations.status,
            })
            .from(workObligations)
            .where(eq(workObligations.entityId, taskId)),
        ).toEqual([
          {
            owner: disposition === "invalid" ? ids.userA1 : nextAssignee,
            status:
              disposition === "unassigned"
                ? "unassigned"
                : "awaiting_acknowledgement",
          },
        ]);
        const history = await tx
          .select({ changes: auditLogs.changes })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.resourceId, taskId),
              eq(auditLogs.resourceType, "entity"),
            ),
          );
        expect(history).toEqual(
          disposition === "invalid"
            ? []
            : [
                expect.objectContaining({
                  changes: expect.objectContaining({
                    assigneeUserId: {
                      old: ids.userA1,
                      new: disposition === "unassigned" ? null : ids.userA2,
                    },
                  }),
                }),
              ],
        );
        throw new TransactionRollbackError();
      });
    });
    if (
      Result.isError(result) &&
      !(result.error.cause instanceof TransactionRollbackError)
    ) {
      throw result.error.cause;
    }
    expect(Result.isError(result)).toBe(true);
  },
);

test("membership-removal.task-preservation", async () => {
  await assertProperty(
    "membership-removal.task-preservation",
    fc.asyncProperty(
      fc.constantFrom(
        null,
        TASK_STATUS.OPEN,
        TASK_STATUS.IN_PROGRESS,
        TASK_STATUS.IN_REVIEW,
        TASK_STATUS.DONE,
        TASK_STATUS.CANCELLED,
      ),
      fc.constantFrom("assignee", "reviewer"),
      fc.boolean(),
      async (status, role, reassign) => {
        const { testDb, ids } = fixture;
        const open =
          status === null || isAccountDeletionActiveTaskStatus(status);
        const result = await Result.tryPromise(
          async () =>
            await testDb.transaction(async (tx) => {
              const taskId = createSafeId<"entity">();
              await tx.insert(entities).values({
                id: taskId,
                workspaceId: ids.wsA2,
                kind: "task",
                name: "Preserved task",
                status,
              });
              await tx.insert(taskAssignees).values({
                entityId: taskId,
                workspaceId: ids.wsA2,
                userId: ids.userA1,
                role,
              });
              const safeDb = asTestRaw<SafeDb>(
                createMembershipSafeDb(markRlsDatabase(tx), {
                  organizationId: ids.orgA,
                  serverValidatedWorkspaceIds: [ids.wsA2],
                  userId: ids.userA2,
                }),
              );
              const removed = await Result.gen(() =>
                removeWorkspaceMemberHandler({
                  safeDb,
                  workspaceId: ids.wsA2,
                  userId: ids.userA1,
                  actorUserId: ids.userA2,
                  reassignTo: reassign ? ids.userA2 : undefined,
                  recordAuditEvent: createAuditRecorder({
                    organizationId: ids.orgA,
                    workspaceId: ids.wsA2,
                    userId: ids.userA2,
                    request: new Request("https://example.test/remove"),
                    server: null,
                  }),
                  dependencies,
                }),
              );
              if (Result.isError(removed)) {
                throw removed.error;
              }
              await tx.execute(sql`RESET ROLE`);
              expect(
                await tx
                  .select({ status: entities.status })
                  .from(entities)
                  .where(eq(entities.id, taskId)),
              ).toEqual([{ status }]);
              // Finished work keeps its former assignee; open work moves
              // to the replacement or returns to the matter.
              let expected: { userId: string; role: typeof role }[] = [];
              if (!open) {
                expected = [{ userId: ids.userA1, role }];
              } else if (reassign) {
                expected = [{ userId: ids.userA2, role }];
              }
              expect(
                await tx
                  .select({
                    userId: taskAssignees.userId,
                    role: taskAssignees.role,
                  })
                  .from(taskAssignees)
                  .where(eq(taskAssignees.entityId, taskId)),
              ).toEqual(expected);
              expect(
                await tx.$count(auditLogs, eq(auditLogs.resourceId, taskId)),
              ).toBe(open ? 1 : 0);
              throw new TransactionRollbackError();
            }),
        );
        if (
          Result.isError(result) &&
          !(result.error.cause instanceof TransactionRollbackError)
        ) {
          throw result.error.cause;
        }
      },
    ),
    { numRuns: 24 },
  );
});

test("matter removal returns only that matter's pending approvals to the pool", async () => {
  const { testDb, ids } = fixture;
  const result = await Result.tryPromise(
    async () =>
      await testDb.transaction(async (tx) => {
        const entry = (
          workspaceId: typeof ids.wsA2 | null,
          status: "draft" | "approved",
        ) => ({
          id: createSafeId<"timeEntry">(),
          organizationId: ids.orgA,
          workspaceId,
          activityGroup:
            workspaceId === null
              ? TIME_ENTRY_ACTIVITY_GROUP.INTERNAL
              : TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
          userId: ids.userA2,
          approverUserId: ids.userA1,
          status,
          dateWorked: "2026-10-01",
          timezoneId: "UTC",
          durationMinutes: 30,
          billedMinutes: 30,
          rateAtEntry: cents(10_000),
          currency: "EUR",
          narrative: "Review",
        });
        const pending = entry(ids.wsA2, "draft");
        const approved = entry(ids.wsA2, "approved");
        const elsewhere = entry(ids.wsA1, "draft");
        const internal = {
          ...entry(null, "draft"),
          billable: false,
          billedMinutes: 0,
          rateAtEntry: cents(0),
          currency: UNPRICED_TIME_ENTRY_CURRENCY,
        };
        await tx
          .insert(timeEntries)
          .values([pending, approved, elsewhere, internal]);
        const safeDb = asTestRaw<SafeDb>(
          createMembershipSafeDb(markRlsDatabase(tx), {
            organizationId: ids.orgA,
            serverValidatedWorkspaceIds: [ids.wsA2],
            userId: ids.userA2,
          }),
        );
        const removed = await Result.gen(() =>
          removeWorkspaceMemberHandler({
            safeDb,
            workspaceId: ids.wsA2,
            userId: ids.userA1,
            actorUserId: ids.userA2,
            recordAuditEvent: createAuditRecorder({
              organizationId: ids.orgA,
              workspaceId: ids.wsA2,
              userId: ids.userA2,
              request: new Request("https://example.test/remove"),
              server: null,
            }),
            dependencies,
          }),
        );
        if (Result.isError(removed)) {
          throw removed.error;
        }
        await tx.execute(sql`RESET ROLE`);
        const approvers = new Map(
          (
            await tx
              .select({
                id: timeEntries.id,
                approverUserId: timeEntries.approverUserId,
              })
              .from(timeEntries)
              .where(
                inArray(timeEntries.id, [
                  pending.id,
                  approved.id,
                  elsewhere.id,
                  internal.id,
                ]),
              )
          ).map((row) => [row.id, row.approverUserId]),
        );
        expect(approvers.get(pending.id)).toBeNull();
        expect(approvers.get(approved.id)).toBe(ids.userA1);
        expect(approvers.get(elsewhere.id)).toBe(ids.userA1);
        expect(approvers.get(internal.id)).toBe(ids.userA1);
        expect(
          await tx
            .select({ changes: auditLogs.changes })
            .from(auditLogs)
            .where(eq(auditLogs.resourceId, pending.id)),
        ).toEqual([
          expect.objectContaining({
            changes: { approverUserId: { old: ids.userA1, new: null } },
          }),
        ]);
        throw new TransactionRollbackError();
      }),
  );
  if (
    Result.isError(result) &&
    !(result.error.cause instanceof TransactionRollbackError)
  ) {
    throw result.error.cause;
  }
});

test("member cleanup drains more than one bounded assignment batch", async () => {
  const { testDb, ids } = fixture;
  const result = await Result.tryPromise(
    async () =>
      await testDb.transaction(async (tx) => {
        const taskIds = Array.from(
          { length: LIMITS.memberRemovalCleanupBatchSize + 1 },
          () => createSafeId<"entity">(),
        );
        await tx.insert(entities).values(
          taskIds.map((id) => ({
            id,
            workspaceId: ids.wsA2,
            kind: "task" as const,
            name: "Retained work",
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
        const safeDb = asTestRaw<SafeDb>(
          createMembershipSafeDb(markRlsDatabase(tx), {
            organizationId: ids.orgA,
            serverValidatedWorkspaceIds: [ids.wsA2],
            userId: ids.userA2,
          }),
        );
        const removed = await Result.gen(() =>
          removeWorkspaceMemberHandler({
            safeDb,
            workspaceId: ids.wsA2,
            userId: ids.userA1,
            actorUserId: ids.userA2,
            recordAuditEvent: createAuditRecorder({
              organizationId: ids.orgA,
              workspaceId: ids.wsA2,
              userId: ids.userA2,
              request: new Request("https://example.test/remove"),
              server: null,
            }),
            dependencies,
          }),
        );
        if (Result.isError(removed)) {
          throw removed.error;
        }
        await tx.execute(sql`RESET ROLE`);
        expect(await tx.$count(entities, inArray(entities.id, taskIds))).toBe(
          taskIds.length,
        );
        expect(
          await tx.$count(
            taskAssignees,
            inArray(taskAssignees.entityId, taskIds),
          ),
        ).toBe(0);
        expect(
          await tx.$count(auditLogs, inArray(auditLogs.resourceId, taskIds)),
        ).toBe(taskIds.length);
        throw new TransactionRollbackError();
      }),
  );
  if (
    Result.isError(result) &&
    !(result.error.cause instanceof TransactionRollbackError)
  ) {
    throw result.error.cause;
  }
});
