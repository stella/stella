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
import type { WorkObligationStatus } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditAction, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import { WORK_OBLIGATION_TRANSITIONS } from "@/api/lib/work-obligations/transitions";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

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
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => ({
              for: async () =>
                table === entities ? [{ listItemType: "task" }] : [],
            }),
          }),
        }),
      }),
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

type StatusWriteOptions = {
  governedWorkflow: boolean;
  owner: "caller" | "other" | "none";
  requestedStatus: string;
  status: WorkObligationStatus;
  workflowReason?: string;
};

/**
 * Drive one legacy task-status write against an obligation in a known state,
 * and report what the obligation row and the audit trail received.
 */
const runStatusWrite = async ({
  governedWorkflow,
  owner,
  requestedStatus,
  status,
  workflowReason,
}: StatusWriteOptions) => {
  const taskId = createSafeId<"entity">();
  const workspaceId = createSafeId<"workspace">();
  const userId = mintAuthProviderId<"user">();
  const workflowUpdates: Record<string, unknown>[] = [];
  const auditActions: AuditAction[] = [];
  const workflow = {
    entityId: taskId,
    workspaceId,
    type: WORK_OBLIGATION_TYPE.TASK,
    status,
    ownerUserId: {
      caller: userId,
      other: mintAuthProviderId<"user">(),
      none: null,
    }[owner],
    acknowledgedAt: new Date("2026-01-01T00:00:00Z"),
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
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    for (const entry of Array.isArray(event) ? event : [event]) {
      if (entry.resourceType === AUDIT_RESOURCE_TYPE.WORK_OBLIGATION) {
        auditActions.push(entry.action);
      }
    }
  };

  const result = await Result.gen(() =>
    updateTaskHandler({
      safeDb,
      workspaceId,
      userId,
      recordAuditEvent,
      body: {
        taskId,
        status: requestedStatus,
        ...(workflowReason === undefined ? {} : { workflowReason }),
      },
      features: { governedWorkflow, legalLists: true },
    }),
  );

  return { auditActions, result, workflowUpdates };
};

describe("updateTaskHandler governed lifecycle", () => {
  test("refuses to cancel completed work", async () => {
    const { result, workflowUpdates } = await runStatusWrite({
      governedWorkflow: true,
      owner: "caller",
      requestedStatus: "cancelled",
      status: WORK_OBLIGATION_STATUS.COMPLETED,
      workflowReason: "superseded",
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 409,
        message:
          "Work that is completed must be reopened before it can be cancelled",
      });
    }
    expect(workflowUpdates).toEqual([]);
  });

  test("refuses to complete cancelled work", async () => {
    const { result, workflowUpdates } = await runStatusWrite({
      governedWorkflow: true,
      owner: "caller",
      requestedStatus: "done",
      status: WORK_OBLIGATION_STATUS.CANCELLED,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 409,
        message:
          "Work that is cancelled must be reopened before it can be completed",
      });
    }
    expect(workflowUpdates).toEqual([]);
  });

  test("refuses completion by anyone but the accountable owner", async () => {
    const { result, workflowUpdates } = await runStatusWrite({
      governedWorkflow: true,
      owner: "other",
      requestedStatus: "done",
      status: WORK_OBLIGATION_STATUS.ACTIVE,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 409,
        message: "Only the accountable owner can complete this work",
      });
    }
    expect(workflowUpdates).toEqual([]);
  });

  test("lets the owner complete from every status the table admits", async () => {
    const runs = await Promise.all(
      WORK_OBLIGATION_TRANSITIONS.complete.from.map(async (status) =>
        runStatusWrite({
          governedWorkflow: true,
          owner: "caller",
          requestedStatus: "done",
          status,
        }),
      ),
    );

    for (const { auditActions, result, workflowUpdates } of runs) {
      expect(Result.isOk(result)).toBe(true);
      expect(workflowUpdates).toEqual([
        expect.objectContaining({ status: WORK_OBLIGATION_STATUS.COMPLETED }),
      ]);
      expect(auditActions).toEqual([AUDIT_ACTION.UPDATE]);
    }
  });

  test("audits a cancellation as a cancellation", async () => {
    const { auditActions, result, workflowUpdates } = await runStatusWrite({
      governedWorkflow: true,
      owner: "caller",
      requestedStatus: "cancelled",
      status: WORK_OBLIGATION_STATUS.ACTIVE,
      workflowReason: "client withdrew the instruction",
    });

    expect(Result.isOk(result)).toBe(true);
    expect(workflowUpdates).toEqual([
      expect.objectContaining({ status: WORK_OBLIGATION_STATUS.CANCELLED }),
    ]);
    expect(auditActions).toEqual([AUDIT_ACTION.CANCEL]);
  });

  test("ungoverned deployments keep flipping closed work freely", async () => {
    const cancelled = await runStatusWrite({
      governedWorkflow: false,
      owner: "none",
      requestedStatus: "cancelled",
      status: WORK_OBLIGATION_STATUS.COMPLETED,
    });

    expect(Result.isOk(cancelled.result)).toBe(true);
    expect(cancelled.workflowUpdates).toEqual([
      expect.objectContaining({ status: WORK_OBLIGATION_STATUS.CANCELLED }),
    ]);
    expect(cancelled.auditActions).toEqual([AUDIT_ACTION.CANCEL]);

    const completed = await runStatusWrite({
      governedWorkflow: false,
      owner: "none",
      requestedStatus: "done",
      status: WORK_OBLIGATION_STATUS.CANCELLED,
    });

    expect(Result.isOk(completed.result)).toBe(true);
    expect(completed.workflowUpdates).toEqual([
      expect.objectContaining({ status: WORK_OBLIGATION_STATUS.COMPLETED }),
    ]);
  });
});
