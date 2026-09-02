import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { entities, taskAssignees } from "@/api/db/schema";
import type { AuditEvent } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { moveAssigneeHandler } from "./move";

const workspaceId = createSafeId<"workspace">();
const taskId = createSafeId<"entity">();
const fromUserId = mintAuthProviderId<"user">();
const toUserId = mintAuthProviderId<"user">();

type MockDbOptions = {
  // `null` models the locked task-row read finding nothing (assignees-add
  // and assignees-remove's own "not found" case); omitted defaults to a
  // writable task so tests only opt into the not-found case explicitly.
  task?: { id: string; readOnly: boolean } | null;
  isMember?: boolean;
};

const createMock = ({
  task = { id: taskId, readOnly: false },
  isMember = true,
}: MockDbOptions = {}) => {
  const deletedWhere: unknown[] = [];
  const insertedValues: Record<string, unknown>[] = [];
  const auditEvents: AuditEvent[] = [];
  const lockedTables: unknown[] = [];

  const { safeDb, getCallCount } = createScopedDbMock({
    // Mirrors the handler's own chain: `.select({...}).from(entities)
    // .where(...).for("update")` — no `.limit()`, matching
    // handlers/entities/rename.ts's lock-then-guard-in-tx shape.
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          for: async (lock: string) => {
            lockedTables.push(table);
            expect(lock).toBe("update");
            return table === entities && task ? [task] : [];
          },
        }),
      }),
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
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          if (table === taskAssignees) {
            insertedValues.push(values);
          }
        },
      }),
    }),
  });

  const recordAuditEvent = async (
    _tx: unknown,
    event: AuditEvent | AuditEvent[],
  ) => {
    auditEvents.push(...(Array.isArray(event) ? event : [event]));
  };

  return {
    safeDb,
    recordAuditEvent,
    deletedWhere,
    insertedValues,
    auditEvents,
    getCallCount,
    lockedTables,
  };
};

describe("moveAssigneeHandler", () => {
  test("rejects when both fromUserId and toUserId are null", async () => {
    const { safeDb, recordAuditEvent, getCallCount } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
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
    const { safeDb, recordAuditEvent, getCallCount } = createMock({
      task: null,
    });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
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
    const { safeDb, recordAuditEvent, getCallCount } = createMock({
      task: { id: taskId, readOnly: true },
    });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
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
    const { safeDb, recordAuditEvent, getCallCount } = createMock({
      isMember: false,
    });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
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
      deletedWhere,
      insertedValues,
      getCallCount,
    } = createMock({ isMember: false });

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
        body: { taskId, fromUserId, toUserId: null },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(deletedWhere).toHaveLength(1);
    expect(insertedValues).toEqual([]);
    expect(getCallCount()).toBe(1);
  });

  test("moves the assignee: removes fromUserId and adds toUserId in one locked transaction", async () => {
    const {
      safeDb,
      recordAuditEvent,
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
        recordAuditEvent,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    // Guard reads (the row lock, the membership check) and the writes all
    // run inside ONE transaction — the fix for the two-transaction TOCTOU
    // gap between validating and writing.
    expect(getCallCount()).toBe(1);
    expect(lockedTables).toEqual([entities]);
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
    const { safeDb, recordAuditEvent, deletedWhere, insertedValues } =
      createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
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
    const { safeDb, recordAuditEvent } = createMock();

    const result = await Result.gen(() =>
      moveAssigneeHandler({
        safeDb,
        workspaceId,
        recordAuditEvent,
        body: { taskId, fromUserId, toUserId },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
  });
});
