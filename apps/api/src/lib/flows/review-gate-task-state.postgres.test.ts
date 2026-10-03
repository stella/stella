import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { flowRunSteps, workspaces } from "@/api/db/schema";
import updateKanbanPlacement from "@/api/handlers/fields/kanban-placement/update";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  flowReviewGateFixture,
  waitForBlockedPid,
} from "@/api/tests/helpers/flow-review-gate";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const TASK_ENTRIES = [
  "task update",
  "obligation transition",
  "Kanban",
] as const;
type TaskEntry = (typeof TASK_ENTRIES)[number];
type Fixture = Awaited<ReturnType<typeof flowReviewGateFixture>>;
type TaskActionOptions = { fixture: Fixture; safeDb: SafeDb; entry: TaskEntry };

const taskAction = async ({ fixture: f, safeDb, entry }: TaskActionOptions) => {
  if (entry === "task update") {
    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId: f.workspaceId,
        userId: f.userId,
        recordAuditEvent: f.recordAuditEvent,
        body: {
          taskId: f.taskEntityId,
          status: "cancelled",
          workflowReason: "Task decision",
        },
        features: { governedWorkflow: true, legalLists: false },
      }),
    );
    if (Result.isError(result)) {
      if (!HandlerError.is(result.error)) {
        throw result.error;
      }
      return { type: "error" as const, status: result.error.status };
    }
    return { type: "ok" as const };
  }
  const context = {
    safeDb,
    workspaceId: f.workspaceId,
    user: { id: f.userId },
    session: { activeOrganizationId: f.organizationId },
    request: new Request("https://example.test/review"),
    recordAuditEvent: f.recordAuditEvent,
    createAuditRecorder: () => f.recordAuditEvent,
  };
  const result =
    entry === "Kanban"
      ? await updateKanbanPlacement.handler(
          createTestHandlerContext<
            Parameters<typeof updateKanbanPlacement.handler>[0]
          >({
            ...context,
            body: { entityId: f.taskEntityId, status: "cancelled", fields: [] },
          }),
        )
      : await transitionWorkObligation.handler(
          createTestHandlerContext<
            Parameters<typeof transitionWorkObligation.handler>[0]
          >({
            ...context,
            params: { entityId: f.taskEntityId, workspaceId: f.workspaceId },
            body: { action: "cancel" },
          }),
        );
  if (typeof result === "object" && "code" in result) {
    return { type: "error" as const, status: result.code };
  }
  expect(result).toEqual(entry === "Kanban" ? {} : { success: true });
  return { type: "ok" as const };
};

type RunActionOptions = {
  fixture: Fixture;
  safeDb: SafeDb;
  action: "approved" | "cancel";
};
const runAction = async ({ fixture, safeDb, action }: RunActionOptions) => {
  const result = await fixture.act(safeDb, action);
  if (Result.isError(result)) {
    if (!HandlerError.is(result.error)) {
      throw result.error;
    }
    return { type: "error" as const, status: result.error.status };
  }
  return { type: "ok" as const };
};

const RUN_ACTIONS = ["approved", "cancel"] as const;
const cases = TASK_ENTRIES.flatMap((entry) =>
  [false, true].flatMap((taskFirst) =>
    RUN_ACTIONS.flatMap((action) =>
      [false, true].map(
        (loserHoldsWorkspace) =>
          ({ entry, taskFirst, action, loserHoldsWorkspace }) as const,
      ),
    ),
  ),
) satisfies {
  entry: TaskEntry;
  taskFirst: boolean;
  action: "approved" | "cancel";
  loserHoldsWorkspace: boolean;
}[];

if (!databaseUrl || !enabled) {
  describe.skip("review task entry serialization (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review task entry serialization (postgres)", () => {
    test.each(cases)(
      "$entry taskFirst=$taskFirst run=$action heldWorkspace=$loserHoldsWorkspace",
      async ({ entry, taskFirst, action, loserHoldsWorkspace }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const first = openClient({
            connection: { statement_timeout: 10_000 },
          });
          const second = openClient({
            connection: { statement_timeout: 10_000 },
          });
          const controller = openClient({
            connection: { statement_timeout: 10_000 },
          });
          const observer = openClient();
          const f = await flowReviewGateFixture(first.db, {
            intermediate: false,
            governed: true,
          });
          const pid = async (client: typeof first) => {
            const rows = await client.db.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            );
            const value = rows.at(0)?.pid;
            if (value === undefined) {
              throw new Error("Session identity missing");
            }
            return value;
          };
          const firstPid = await pid(first);
          const secondPid = await pid(second);
          const controllerPid = await pid(controller);
          const firstDb = f.safeDb(first.db);
          const originalSecondDb = f.safeDb(second.db);
          const workspaceHeld = Promise.withResolvers<undefined>();
          const secondDb: SafeDb = async (work, retry) =>
            await originalSecondDb(async (tx) => {
              if (loserHoldsWorkspace) {
                await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, f.workspaceId))
                  .for("update");
                workspaceHeld.resolve(undefined);
              }
              return await work(tx);
            }, retry);
          const pending: ReturnType<typeof taskAction>[] = [];
          try {
            await controller.db.transaction(async (tx) => {
              await tx
                .select({ id: flowRunSteps.id })
                .from(flowRunSteps)
                .where(
                  and(
                    eq(flowRunSteps.runId, f.runId),
                    eq(flowRunSteps.index, 0),
                  ),
                )
                .for("update");
              pending.push(
                taskFirst
                  ? taskAction({ fixture: f, safeDb: firstDb, entry })
                  : runAction({ fixture: f, safeDb: firstDb, action }),
              );
              // The first actor owns the run and waits for the controller's
              // step. The second must wait for that same run before settling
              // the governed obligation, even inside Kanban's outer tx.
              await waitForBlockedPid(observer.sql, {
                waitingPid: firstPid,
                holdingPid: controllerPid,
              });
              pending.push(
                taskFirst
                  ? runAction({ fixture: f, safeDb: secondDb, action })
                  : taskAction({ fixture: f, safeDb: secondDb, entry }),
              );
              if (loserHoldsWorkspace) {
                await workspaceHeld.promise;
              }
              await waitForBlockedPid(observer.sql, {
                waitingPid: secondPid,
                holdingPid: firstPid,
              });
            });
            expect(await Promise.all(pending)).toEqual([
              { type: "ok" },
              { type: "error", status: 409 },
            ]);
            const state = await f.read();
            const cancelled = !taskFirst && action === "cancel";
            expect(state.run?.status).toBe(
              !taskFirst && action === "approved" ? "completed" : "cancelled",
            );
            expect(state.task?.status).toBe(cancelled ? "cancelled" : "done");
            expect(state.obligation?.status).toBe(
              cancelled ? "cancelled" : "completed",
            );
            expect(state.steps.at(0)?.status).toBe(
              cancelled ? "skipped" : "completed",
            );
            if (cancelled) {
              expect(state.steps.at(0)?.output).toBeNull();
            } else {
              expect(state.steps.at(0)?.output).toMatchObject({
                kind: "review-gate",
                decision: taskFirst ? "rejected" : "approved",
              });
            }
            expect(f.enqueued).toEqual([]);
          } finally {
            try {
              await Promise.all(pending);
            } finally {
              await f.cleanup();
            }
          }
        });
      },
    );
  });
}
