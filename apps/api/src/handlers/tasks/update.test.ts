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
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { updateTaskHandler } from "./update";

describe("updateTaskHandler legacy deadline compatibility", () => {
  test("moves the working target and hard deadline together", async () => {
    const taskId = createSafeId<"entity">();
    const workspaceId = createSafeId<"workspace">();
    const userId = createSafeId<"user">();
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
