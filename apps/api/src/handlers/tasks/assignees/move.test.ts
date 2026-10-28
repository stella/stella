import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { member } from "@/api/db/auth-schema";
import {
  entities,
  taskAssignees,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { NewNotification } from "@/api/lib/notifications";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { moveAssigneeHandler } from "./move";

const workspaceId = createSafeId<"workspace">();
const taskId = createSafeId<"entity">();
const fromUserId = mintAuthProviderId<"user">();
const toUserId = mintAuthProviderId<"user">();
const actorUserId = mintAuthProviderId<"user">();
const organizationId = mintAuthProviderId<"organization">();
const assignmentId = createSafeId<"taskAssignee">();

type MockDbOptions = {
  // `null` models the locked task-row read finding nothing (assignees-add
  // and assignees-remove's own "not found" case); omitted defaults to a
  // writable task so tests only opt into the not-found case explicitly.
  task?: { id: string; readOnly: boolean } | null;
  isMember?: boolean;
  // Whether the upsert changed the row; a repeat of an existing assignment
  // returns nothing, exactly as the conditional upsert does.
  assignmentChanged?: boolean;
};

const createMock = ({
  task = { id: taskId, readOnly: false },
  isMember = true,
  assignmentChanged = true,
}: MockDbOptions = {}) => {
  const deletedWhere: unknown[] = [];
  const insertedValues: Record<string, unknown>[] = [];
  const auditEvents: AuditEvent[] = [];
  const lockedTables: unknown[] = [];
  const filed: NewNotification[][] = [];

  const { safeDb, getCallCount } = createScopedDbMock({
    select: () => ({
      from: (table: unknown) => {
        let rows: unknown[] = [];
        if (table === entities) {
          rows = task ? [task] : [];
        } else if (table === workspaces) {
          rows = [{ organizationId: mintAuthProviderId<"organization">() }];
        } else if (
          (table === workspaceMembers || table === member) &&
          isMember
        ) {
          rows = [{ userId: toUserId }];
        }
        return {
          // Only the actor lookup joins: the matter's organization and the
          // assigning user's name through their membership of it.
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: async () => [
                  { actorName: "Ada Lovelace", organizationId },
                ],
              }),
            }),
          }),
          where: (): unknown =>
            table === member
              ? Promise.resolve(rows)
              : {
                  orderBy: () => ({
                    limit: () => ({
                      for: async (lock: string) => {
                        lockedTables.push(table);
                        expect(lock).toBe("key share");
                        return rows;
                      },
                    }),
                  }),
                  for: async (lock: string) => {
                    lockedTables.push(table);
                    expect(lock).toBe(
                      table === entities ? "update" : "key share",
                    );
                    return rows;
                  },
                },
        };
      },
    }),
    query: {
      workspaceMembers: {
        findFirst: async () => (isMember ? { id: "member-1" } : undefined),
      },
    },
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        if (table === taskAssignees) {
          deletedWhere.push(condition);
        }
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>[]) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (table !== taskAssignees) {
              return [];
            }
            insertedValues.push(...values);
            return assignmentChanged
              ? values.map((value) => ({ ...value, id: assignmentId }))
              : [];
          },
        }),
      }),
    }),
  });

  const recordAuditEvent = async (
    _tx: unknown,
    event: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(event) ? event : [event]));
  };

  const fileNotifications = (rows: readonly NewNotification[]) => {
    filed.push([...rows]);
  };

  return {
    safeDb,
    recordAuditEvent,
    fileNotifications,
    filed,
    deletedWhere,
    insertedValues,
    auditEvents,
    getCallCount,
    lockedTables,
  };
};

describe("moveAssigneeHandler", () => {
  test("rejects when both fromUserId and toUserId are null", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, getCallCount } =
      createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId: null, toUserId: null },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 400 });
    }
    // Rejected before any transaction opens: neither guard input is usable.
    expect(getCallCount()).toBe(0);
  });

  test("returns 404 when the task does not exist", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, getCallCount } =
      createMock({
        task: null,
      });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 404 });
    }
    expect(getCallCount()).toBe(1);
  });

  test("returns 409 when the task is read-only", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, getCallCount } =
      createMock({
        task: { id: taskId, readOnly: true },
      });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 409 });
    }
    expect(getCallCount()).toBe(1);
  });

  test("returns 400 when toUserId is not a workspace member", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, getCallCount } =
      createMock({
        isMember: false,
      });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 400,
        message: "User is not a member of this workspace",
      });
    }
    expect(getCallCount()).toBe(1);
  });

  test("skips the membership check when toUserId is null (pure removal)", async () => {
    const {
      safeDb,
      recordAuditEvent,
      fileNotifications,
      filed,
      deletedWhere,
      insertedValues,
      getCallCount,
    } = createMock({ isMember: false });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId: null },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(deletedWhere).toHaveLength(1);
    expect(insertedValues).toEqual([]);
    expect(filed).toEqual([[]]);
    expect(getCallCount()).toBe(1);
  });

  test("moves the assignee: removes fromUserId and adds toUserId in one locked transaction", async () => {
    const {
      safeDb,
      recordAuditEvent,
      fileNotifications,
      deletedWhere,
      insertedValues,
      auditEvents,
      getCallCount,
      lockedTables,
    } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    // Guard reads (the row lock, the membership check) and the writes all
    // run inside ONE transaction — the fix for the two-transaction TOCTOU
    // gap between validating and writing.
    expect(getCallCount()).toBe(1);
    expect(lockedTables).toEqual([
      workspaces,
      workspaceMembers,
      entities,
      workspaces,
      workspaceMembers,
    ]);
    expect(deletedWhere).toHaveLength(1);
    expect(insertedValues).toEqual([
      expect.objectContaining({
        entityId: taskId,
        workspaceId,
        userId: toUserId,
        role: "assignee",
      }),
    ]);
    expect(auditEvents).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          change: "assignee-removed",
          assigneeUserId: fromUserId,
        }),
      }),
      expect.objectContaining({
        metadata: expect.objectContaining({
          change: "assignee-added",
          assigneeUserId: toUserId,
        }),
      }),
    ]);
  });

  test("adding only (fromUserId null) issues no delete", async () => {
    const {
      safeDb,
      recordAuditEvent,
      fileNotifications,
      deletedWhere,
      insertedValues,
    } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId: null, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(deletedWhere).toEqual([]);
    expect(insertedValues).toHaveLength(1);
  });

  test("is idempotent: removing an absent assignee and adding an already-present one both succeed", async () => {
    // The mock's delete/insert always "succeed" regardless of prior state,
    // mirroring the real onConflictDoUpdate/no-op-delete semantics assignees-add
    // and assignees-remove already rely on.
    const { safeDb, recordAuditEvent, fileNotifications } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
  });

  test("tells the new assignee who assigned them, pointing at the task", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, filed } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(filed).toEqual([
      [
        {
          kind: "task_assigned",
          metadata: { actorName: "Ada Lovelace" },
          entityType: "task",
          entityId: taskId,
          workspaceId,
          organizationId,
          userId: toUserId,
          idempotencyKey: `task_assigned:${taskId}:${toUserId}:${assignmentId}`,
        },
      ],
    ]);
  });

  test("files nothing when the actor assigns the task to themselves", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, filed } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId: toUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(filed).toEqual([[]]);
  });

  test("files nothing when the person was already the assignee", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, filed } = createMock({
      assignmentChanged: false,
    });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId: null, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(filed).toEqual([[]]);
  });

  test("files nothing when the move is refused", async () => {
    const { safeDb, recordAuditEvent, fileNotifications, filed } = createMock({
      task: { id: taskId, readOnly: true },
    });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        actorUserId,
        recordAuditEvent,
        fileNotifications,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    expect(filed).toEqual([]);
  });
});
