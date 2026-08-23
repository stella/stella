import { Result } from "better-result";
import { describe, expect, mock, test } from "bun:test";

import { taskAssignees, workObligations } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock, toSafeDbMock } from "@/api/tests/scoped-db-mock";

import { createTaskForFeatures } from "./create";

const TASK_FEATURES_ENABLED = {
  governedWorkflow: true,
  legalLists: true,
} as const;
const TASK_FEATURES_DISABLED = {
  governedWorkflow: false,
  legalLists: false,
} as const;
const createTaskHandler = createTaskForFeatures(TASK_FEATURES_ENABLED).handler;

type CreateTaskCtx = Parameters<typeof createTaskHandler>[0];
type ScopedDb = CreateTaskCtx["scopedDb"];

const workspaceId = toSafeId<"workspace">("ws_test123");
const userId = toSafeId<"user">("user_abc");
const sourceEntityId = toSafeId<"entity">(
  "11111111-1111-4111-8111-111111111248",
);

/** Mock scopedDb that throws if called (validates early return). */
const throwingScopedDb = () =>
  asTestRaw<ScopedDb>(
    mock(() => {
      throw new Error("scopedDb should not be called");
    }),
  );

/** Mock scopedDb that resolves successfully. */
const resolvingScopedDb = () =>
  asTestRaw<ScopedDb & ReturnType<typeof mock>>(
    mock(async () => ({ entityId: "fake" })),
  );

const createHandlerContext = ({
  body,
  safeDb,
  scopedDb,
}: {
  body: CreateTaskCtx["body"];
  safeDb: CreateTaskCtx["safeDb"];
  scopedDb: CreateTaskCtx["scopedDb"];
}): CreateTaskCtx =>
  asTestRaw<CreateTaskCtx>({
    workspaceId,
    user: { id: userId },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test123"),
    },
    memberRole: { role: "owner" },
    body,
    safeDb,
    scopedDb,
  });

describe("createTaskHandler validation", () => {
  test("invalid status returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task", status: "bogus" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid task status" },
    });
  });

  test("invalid priority returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task", priority: "critical" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid task priority" },
    });
  });

  test("invalid list item type returns 400 before DB call", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: { name: "Test item", listItemType: "unknown" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid list item type" },
    });
  });

  test("invalid status checked before invalid priority", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: {
          name: "Test task",
          status: "bogus",
          priority: "critical",
        },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Invalid task status" },
    });
  });

  test("rejects a working target after the hard deadline before DB access", async () => {
    const scopedDb = throwingScopedDb();

    const result = await createTaskHandler(
      createHandlerContext({
        body: {
          name: "File response",
          workingTargetDate: "2026-09-11",
          hardDeadlineDate: "2026-09-10",
        },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(result).toEqual({
      code: 400,
      response: { message: "Working target cannot be after the hard deadline" },
    });
  });

  test("rejects workflow-only fields while Governed Workflow is disabled", async () => {
    const scopedDb = throwingScopedDb();

    const result = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb: toSafeDbMock(scopedDb),
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { name: "File response", ownerUserId: userId },
        features: TASK_FEATURES_DISABLED,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 404,
        message: "Governed Workflow is disabled",
      });
    }
  });

  test("rejects List-only fields while Legal Lists is disabled", async () => {
    const scopedDb = throwingScopedDb();

    const result = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb: toSafeDbMock(scopedDb),
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { name: "Witness fact", listItemType: "fact" },
        features: TASK_FEATURES_DISABLED,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 404,
        message: "Legal Lists are disabled",
      });
    }
  });

  test("assigns legacy task creation to its workspace-member creator", async () => {
    const assigneeRows: Record<string, unknown>[] = [];
    const { safeDb } = createScopedDbMock({
      $count: async () => 0,
      select: () => ({
        from: () => ({
          // The search-repair mark reads its tenant from the source row.
          innerJoin: () => ({ where: () => [] }),
          where: () => ({
            limit: () => ({ for: async () => [{ userId }] }),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (
          values: Record<string, unknown> | Record<string, unknown>[],
        ) => {
          if (table === taskAssignees) {
            assigneeRows.push(...(Array.isArray(values) ? values : [values]));
          }
        },
        select: () => ({ onConflictDoUpdate: async () => [] }),
      }),
      update: () => ({
        set: () => ({ where: async () => [] }),
      }),
    });

    const result = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { name: "Prepare filing" },
        features: TASK_FEATURES_DISABLED,
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(assigneeRows).toEqual([
      expect.objectContaining({ userId, role: "assignee" }),
    ]);
  });

  test("valid status and priority proceeds to DB call", async () => {
    const scopedDb = resolvingScopedDb();

    await createTaskHandler(
      createHandlerContext({
        body: {
          name: "Test task",
          status: "in_progress",
          priority: "high",
        },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(scopedDb).toHaveBeenCalledTimes(1);
  });

  test("defaults status to 'open' and priority to 'none'", async () => {
    const scopedDb = resolvingScopedDb();

    await createTaskHandler(
      createHandlerContext({
        body: { name: "Test task" },
        safeDb: toSafeDbMock(scopedDb),
        scopedDb,
      }),
    );

    expect(scopedDb).toHaveBeenCalledTimes(1);
  });

  test("creates unassigned work for an authorized caller without workspace membership", async () => {
    const obligationRows: Record<string, unknown>[] = [];
    const { safeDb } = createScopedDbMock({
      $count: async () => 0,
      select: () => ({
        from: () => ({
          // The search-repair mark reads its tenant from the source row.
          innerJoin: () => ({ where: () => [] }),
          where: () => ({
            limit: () => ({ for: async () => [] }),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>) => {
          if (table === workObligations) {
            obligationRows.push(values);
          }
        },
        select: () => ({ onConflictDoUpdate: async () => [] }),
      }),
      update: () => ({
        set: () => ({
          where: async () => [],
        }),
      }),
    });

    const result = await Result.gen(() =>
      createTaskEntityHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { name: "Firm-admin task" },
        features: TASK_FEATURES_ENABLED,
        workObligationSource: {
          type: "document",
          entityId: sourceEntityId,
          description: "Inbox signal: filing deadline",
        },
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(obligationRows).toEqual([
      expect.objectContaining({
        ownerUserId: null,
        sourceEntityId,
        sourceDescription: "Inbox signal: filing deadline",
        sourceType: "document",
        status: "unassigned",
      }),
    ]);
  });

  test("all valid TASK_STATUSES pass validation", async () => {
    const validStatuses = [
      "open",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ];

    for (const taskStatus of validStatuses) {
      const scopedDb = resolvingScopedDb();

      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: each iteration asserts on its own mock
      await createTaskHandler(
        createHandlerContext({
          body: { name: "Test task", status: taskStatus },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });

  test("all valid ENTITY_PRIORITIES pass validation", async () => {
    const validPriorities = ["none", "urgent", "high", "medium", "low"];

    for (const priority of validPriorities) {
      const scopedDb = resolvingScopedDb();

      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: each iteration asserts on its own mock
      await createTaskHandler(
        createHandlerContext({
          body: { name: "Test task", priority },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });

  test("all supported List item types pass validation", async () => {
    const itemTypes = ["task", "fact", "issue", "requirement", "event"];

    for (const listItemType of itemTypes) {
      const scopedDb = resolvingScopedDb();

      // oxlint-disable-next-line no-await-in-loop -- sequential test setup: each iteration asserts on its own mock
      await createTaskHandler(
        createHandlerContext({
          body: { name: "Test item", listItemType },
          safeDb: toSafeDbMock(scopedDb),
          scopedDb,
        }),
      );

      expect(scopedDb).toHaveBeenCalledTimes(1);
    }
  });
});
