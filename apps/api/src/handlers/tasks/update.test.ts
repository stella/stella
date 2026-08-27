import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  entities,
  WORK_OBLIGATION_EVENT_TYPE,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_TYPE,
  workObligationEvents,
  workObligations,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { updateTaskHandler } from "./update";

const TASK_FEATURES_ENABLED = {
  governedWorkflow: true,
  legalLists: true,
} as const;
const TASK_FEATURES_DISABLED = {
  governedWorkflow: false,
  legalLists: false,
} as const;

describe("updateTaskHandler feature compatibility", () => {
  test("rejects non-task item types while Legal Lists is disabled", async () => {
    const taskId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const userId = mintAuthProviderId<"user">();
    const { safeDb } = createScopedDbMock({
      update: () => {
        throw new Error("database should not be accessed");
      },
    });

    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { taskId, listItemType: "fact" },
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

  test("permits the ordinary task item type while Legal Lists is disabled", async () => {
    const taskId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const userId = mintAuthProviderId<"user">();
    const { safeDb } = createScopedDbMock({
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: taskId }] }),
        }),
      }),
    });

    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { taskId, listItemType: "task" },
        features: TASK_FEATURES_DISABLED,
      }),
    );

    expect(Result.isOk(result)).toBe(true);
  });

  test("keeps an existing obligation synchronized while enforcement is disabled", async () => {
    const taskId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const userId = mintAuthProviderId<"user">();
    const workflowUpdates: Record<string, unknown>[] = [];
    const workflow = {
      entityId: taskId,
      workspaceId,
      type: WORK_OBLIGATION_TYPE.TASK,
      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
      ownerUserId: null,
      acknowledgedAt: null,
      workingTargetDate: null,
      hardDeadlineDate: null,
    };
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => ({ for: async () => [workflow] }) }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === workObligations) {
            workflowUpdates.push(values);
          }
          return {
            where: () => ({
              returning: async () =>
                table === entities ? [{ id: taskId }] : [{ entityId: taskId }],
            }),
          };
        },
      }),
      insert: () => ({ values: async () => {} }),
    });

    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { taskId, status: "done" },
        features: TASK_FEATURES_DISABLED,
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(workflowUpdates).toEqual([
      expect.objectContaining({ status: WORK_OBLIGATION_STATUS.COMPLETED }),
    ]);
  });

  test("rejects a legacy due date after an existing hard deadline", async () => {
    const taskId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const userId = mintAuthProviderId<"user">();
    const workflow = {
      entityId: taskId,
      workspaceId,
      type: WORK_OBLIGATION_TYPE.TASK,
      status: WORK_OBLIGATION_STATUS.UNASSIGNED,
      ownerUserId: null,
      acknowledgedAt: null,
      workingTargetDate: "2026-08-10",
      hardDeadlineDate: "2026-08-15",
    };
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => ({ for: async () => [workflow] }) }),
        }),
      }),
      update: () => {
        throw new Error("database should not be updated");
      },
    });

    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { taskId, dueDate: "2026-08-20" },
        features: TASK_FEATURES_DISABLED,
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 400,
        message: "Working target cannot be after the hard deadline",
      });
    }
  });
});

describe("updateTaskHandler legacy deadline compatibility", () => {
  test("moves the working target and hard deadline together", async () => {
    const taskId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const userId = mintAuthProviderId<"user">();
    const workflowUpdates: Record<string, unknown>[] = [];
    const eventBatches: Record<string, unknown>[][] = [];
    const workflow = {
      entityId: taskId,
      workspaceId,
      type: WORK_OBLIGATION_TYPE.DEADLINE,
      status: WORK_OBLIGATION_STATUS.ACTIVE,
      ownerUserId: userId,
      acknowledgedAt: new Date("2026-01-01T00:00:00Z"),
      workingTargetDate: "2026-08-10",
      hardDeadlineDate: "2026-08-10",
    };
    const { safeDb } = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: async () => [workflow],
            }),
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          if (table === workObligations) {
            workflowUpdates.push(values);
          }
          return {
            where: () => ({
              returning: async () =>
                table === entities ? [{ id: taskId }] : [{ entityId: taskId }],
            }),
          };
        },
      }),
      insert: (table: unknown) => ({
        values: async (values: Record<string, unknown>[]) => {
          if (table === workObligationEvents) {
            eventBatches.push(values);
          }
        },
      }),
    });

    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => {},
        body: { taskId, dueDate: "2026-08-20" },
        features: TASK_FEATURES_ENABLED,
      }),
    );

    expect(Result.isOk(result)).toBe(true);
    expect(workflowUpdates).toEqual([
      expect.objectContaining({
        workingTargetDate: "2026-08-20",
        hardDeadlineDate: "2026-08-20",
      }),
    ]);
    expect(eventBatches.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: WORK_OBLIGATION_EVENT_TYPE.WORKING_TARGET_CHANGED,
        }),
        expect.objectContaining({
          type: WORK_OBLIGATION_EVENT_TYPE.HARD_DEADLINE_CHANGED,
        }),
      ]),
    );
  });
});
