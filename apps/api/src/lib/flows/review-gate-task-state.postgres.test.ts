import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  featureEnrolments,
  flowRunSteps,
  notifications,
} from "@/api/db/schema";
import { env } from "@/api/env";
import updateKanbanPlacement from "@/api/handlers/fields/kanban-placement/update";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
type Fixture = Awaited<ReturnType<typeof flowReviewGateFixture>>;
type TaskActionOptions = {
  fixture: Fixture;
  safeDb: SafeDb;
  entry: "task update" | "Kanban text";
  taskStatus: "done" | "cancelled";
  assignment: Parameters<
    typeof updateKanbanPlacement.handler
  >[0]["body"]["fields"];
};

const taskAction = async ({
  fixture: f,
  safeDb,
  entry,
  taskStatus,
  assignment,
}: TaskActionOptions) => {
  if (entry === "task update") {
    const result = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId: f.workspaceId,
        userId: f.userId,
        recordAuditEvent: f.recordAuditEvent,
        body: {
          taskId: f.taskEntityId,
          status: taskStatus,
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
    scopedDb: NO_DB,
    safeDb,
    workspaceId: f.workspaceId,
    user: { id: f.userId },
    session: { activeOrganizationId: f.organizationId },
    request: new Request("https://example.test/review"),
    audit: f.recordAuditEvent,
  };
  const result = await updateKanbanPlacement.handler(
    createTestHandlerContext<
      Parameters<typeof updateKanbanPlacement.handler>[0]
    >({
      ...context,
      body: {
        entityId: f.taskEntityId,
        status: taskStatus,
        fields: assignment,
      },
    }),
  );
  if (typeof result === "object" && "code" in result) {
    return { type: "error" as const, status: result.code };
  }
  expect(result).toEqual({});
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

if (!databaseUrl || !enabled) {
  describe.skip("review task entry serialization (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review task entry serialization (postgres)", () => {
    test("revoking flow admission refuses a linked review metadata edit without changing the task", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const f = await flowReviewGateFixture(db, {
          intermediate: false,
          governed: true,
        });
        try {
          const before = await db.query.entities.findFirst({
            where: { id: { eq: f.taskEntityId } },
          });
          await db.transaction(async (tx) => {
            await lockFeatureRecoveryAdmission({
              tx,
              organizationId: f.organizationId,
              featureId: "flows",
            });
            await tx
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, f.organizationId),
                  eq(featureEnrolments.userId, f.userId),
                  eq(featureEnrolments.featureId, "flows"),
                ),
              );
          });
          const changed = await Result.gen(() =>
            updateTaskHandler({
              safeDb: f.safeDb(db),
              workspaceId: f.workspaceId,
              userId: f.userId,
              recordAuditEvent: f.recordAuditEvent,
              body: { taskId: f.taskEntityId, name: "Changed after revoke" },
              features: { governedWorkflow: true, legalLists: false },
            }),
          );
          expect(changed.isErr()).toBe(true);
          if (changed.isErr()) {
            expect(changed.error).toMatchObject({
              status: 404,
              message: "Not found",
            });
          }
          expect(
            await db.query.entities.findFirst({
              where: { id: { eq: f.taskEntityId } },
            }),
          ).toEqual(before);
        } finally {
          await f.cleanup();
        }
      });
    });

    test("a run approval serializes a competing task rejection at feature admission", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = openClient({ connection: { statement_timeout: 10_000 } });
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
        const pending: ReturnType<typeof taskAction>[] = [];
        const previousGovernedWorkflow = env.FEATURE_GOVERNED_WORKFLOW;
        env.FEATURE_GOVERNED_WORKFLOW = true;
        try {
          await controller.db.transaction(async (tx) => {
            await tx
              .select({ id: flowRunSteps.id })
              .from(flowRunSteps)
              .where(
                and(eq(flowRunSteps.runId, f.runId), eq(flowRunSteps.index, 0)),
              )
              .for("update");
            pending.push(
              runAction({
                fixture: f,
                safeDb: f.safeDb(first.db),
                action: "approved",
              }),
            );
            await waitForBlockedPid(observer.sql, {
              waitingPid: firstPid,
              holdingPid: controllerPid,
            });
            pending.push(
              taskAction({
                fixture: f,
                safeDb: f.safeDb(second.db),
                entry: "task update",
                taskStatus: "cancelled",
                assignment: [],
              }),
            );
            await waitForBlockedPid(observer.sql, {
              waitingPid: secondPid,
              holdingPid: firstPid,
            });
            const waiting = await observer.db.execute<{ locktype: string }>(
              sql`SELECT locktype FROM pg_locks WHERE pid = ${secondPid} AND NOT granted`,
            );
            expect(waiting).toEqual([{ locktype: "advisory" }]);
          });
          expect(await Promise.all(pending)).toEqual([
            { type: "ok" },
            { type: "error", status: 409 },
          ]);
          const state = await f.read();
          expect(state.run?.status).toBe("completed");
          expect(state.task?.status).toBe("done");
          expect(state.obligation?.status).toBe("completed");
          expect(state.steps.at(0)?.status).toBe("completed");
          expect(state.steps.at(0)?.output).toMatchObject({
            kind: "review-gate",
            decision: "approved",
          });
          expect(f.enqueued).toEqual([]);
        } finally {
          env.FEATURE_GOVERNED_WORKFLOW = previousGovernedWorkflow;
          try {
            await Promise.all(pending);
          } finally {
            await f.cleanup();
          }
        }
      });
    });
    test("failed Kanban field write rolls back review completion without filing a notice", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const client = openClient();
        const f = await flowReviewGateFixture(client.db, {
          intermediate: false,
          governed: true,
        });
        const before = await f.read();
        const previousGovernedWorkflow = env.FEATURE_GOVERNED_WORKFLOW;
        env.FEATURE_GOVERNED_WORKFLOW = true;
        try {
          expect(
            await taskAction({
              fixture: f,
              safeDb: f.safeDb(client.db),
              entry: "Kanban text",
              taskStatus: "done",
              assignment: [
                {
                  propertyId: createSafeId<"property">(),
                  content: { type: "text", version: 1, value: "Not committed" },
                },
              ],
            }),
          ).toEqual({ type: "error", status: 404 });
          expect(await f.read()).toEqual(before);
          const completionNotices = await client.db
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              eq(notifications.idempotencyKey, `flow-run-completed:${f.runId}`),
            )
            .limit(2);
          expect(completionNotices).toEqual([]);
          expect(f.enqueued).toEqual([]);
        } finally {
          env.FEATURE_GOVERNED_WORKFLOW = previousGovernedWorkflow;
          await f.cleanup();
        }
      });
    });
  });
}
