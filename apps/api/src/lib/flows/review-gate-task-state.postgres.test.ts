import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  flowRunSteps,
  notifications,
  properties,
  taskAssignees,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import updateKanbanPlacement from "@/api/handlers/fields/kanban-placement/update";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  flowReviewGateFixture,
  waitForBlockedPid,
} from "@/api/tests/helpers/flow-review-gate";
import {
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const TASK_ENTRIES = [
  "task update",
  "obligation transition",
  "Kanban",
  "Kanban text",
  "Kanban person",
  "Kanban date",
  "save_task",
] as const;
type TaskEntry = (typeof TASK_ENTRIES)[number];
type Fixture = Awaited<ReturnType<typeof flowReviewGateFixture>>;
type TaskActionOptions = {
  fixture: Fixture;
  safeDb: SafeDb;
  entry: TaskEntry;
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
  if (entry === "save_task") {
    const scopedDb: ScopedDb = async (work) => {
      const result = await safeDb(work);
      if (Result.isError(result)) {
        throw result.error;
      }
      return result.value;
    };
    const context = {
      accessibleWorkspaceIds: [f.workspaceId],
      accessibleWorkspaceIdSet: new Set([f.workspaceId]),
      accessibleWorkspaceStatusById: new Map([
        [f.workspaceId, "active" as const],
      ]),
      accessibleWorkspaces: [],
      grantedScopes: [],
      memberRole: "owner",
      organizationId: f.organizationId,
      recordAuditEvent: f.recordAuditEvent,
      safeDb,
      scopedDb,
      userId: f.userId,
      userEmail: `${f.userId}@example.test`,
    } satisfies McpRequestContext;
    const result = await handleMcpToolCall({
      toolName: "save_task",
      args: {
        task_id: f.taskEntityId,
        status: taskStatus,
        name: "Changed review task",
        due_date: "2026-10-10",
        add_assignee_user_id: f.userId,
      },
      context,
    });
    if (result.isError) {
      const content = result.content.at(0);
      expect(content?.type).toBe("text");
      if (content?.type !== "text") {
        throw new Error("save_task error omitted its text envelope");
      }
      expect(JSON.parse(content.text)).toMatchObject({
        error: { code: "conflict" },
      });
      return { type: "error" as const, status: 409 };
    }
    expect(result.structuredContent).toEqual({
      taskId: f.taskEntityId,
      updated: true,
    });
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
  const result =
    entry !== "obligation transition"
      ? await updateKanbanPlacement.handler(
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
        )
      : await transitionWorkObligation.handler(
          createTestHandlerContext<
            Parameters<typeof transitionWorkObligation.handler>[0]
          >({
            ...context,
            params: { entityId: f.taskEntityId, workspaceId: f.workspaceId },
            body: { action: taskStatus === "done" ? "complete" : "cancel" },
          }),
        );
  if (typeof result === "object" && "code" in result) {
    return { type: "error" as const, status: result.code };
  }
  expect(result).toEqual(
    entry !== "obligation transition" ? {} : { success: true },
  );
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
      (["none", "loser"] as const).map(
        (workspaceLockOwner) =>
          ({
            entry,
            taskFirst,
            action,
            workspaceLockOwner,
          }) as const,
      ),
    ),
  ),
) satisfies {
  entry: TaskEntry;
  taskFirst: boolean;
  action: "approved" | "cancel";
  workspaceLockOwner: "none" | "winner" | "loser";
}[];
const preheldCases = TASK_ENTRIES.filter(
  (entry) =>
    entry === "Kanban text" ||
    entry === "Kanban person" ||
    entry === "Kanban date" ||
    entry === "save_task",
).flatMap((entry) =>
  [false, true].flatMap((taskFirst) =>
    RUN_ACTIONS.map(
      (action) =>
        ({
          entry,
          taskFirst,
          action,
          workspaceLockOwner: "winner",
        }) as const,
    ),
  ),
);

if (!databaseUrl || !enabled) {
  describe.skip("review task entry serialization (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("review task entry serialization (postgres)", () => {
    test.each([...cases, ...preheldCases])(
      "$entry taskFirst=$taskFirst run=$action workspaceLockOwner=$workspaceLockOwner",
      async ({ entry, taskFirst, action, workspaceLockOwner }) => {
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
          const assignment: TaskActionOptions["assignment"] = [];
          if (
            entry === "Kanban text" ||
            entry === "Kanban person" ||
            entry === "Kanban date"
          ) {
            const entityVersionId = createSafeId<"entityVersion">();
            const propertyId = createSafeId<"property">();
            const content = (() => {
              if (entry === "Kanban text") {
                return {
                  type: "text",
                  version: 1,
                  value: "Changed review task",
                } as const;
              }
              if (entry === "Kanban date") {
                return {
                  type: "date",
                  version: 1,
                  value: "2026-10-10",
                } as const;
              }
              return {
                type: "person",
                version: 1,
                userId: f.userId,
                name: "Reviewer",
                image: null,
              } as const;
            })();
            await first.db.insert(entityVersions).values({
              id: entityVersionId,
              entityId: f.taskEntityId,
              workspaceId: f.workspaceId,
            });
            await first.db
              .update(entities)
              .set({ currentVersionId: entityVersionId })
              .where(eq(entities.id, f.taskEntityId));
            await first.db.insert(properties).values({
              id: propertyId,
              workspaceId: f.workspaceId,
              name: entry,
              status: "fresh",
              content: { type: content.type, version: 1 },
              tool: { type: "manual-input", version: 1 },
            });
            assignment.push({ propertyId, content });
          }
          const previousGovernedWorkflow = env.FEATURE_GOVERNED_WORKFLOW;
          env.FEATURE_GOVERNED_WORKFLOW = true;
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
          const taskStatus = action === "approved" ? "cancelled" : "done";
          const originalFirstDb = f.safeDb(first.db);
          const firstDb: SafeDb = async (work, retry) =>
            await originalFirstDb(async (tx) => {
              if (workspaceLockOwner === "winner") {
                await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, f.workspaceId))
                  .for("update");
              }
              return await work(tx);
            }, retry);
          const originalSecondDb = f.safeDb(second.db);
          let workspaceAcquired = false;
          const secondDb: SafeDb = async (work, retry) =>
            await originalSecondDb(async (tx) => {
              if (workspaceLockOwner === "loser") {
                await tx
                  .select({ id: workspaces.id })
                  .from(workspaces)
                  .where(eq(workspaces.id, f.workspaceId))
                  .for("update");
                workspaceAcquired = true;
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
                  ? taskAction({
                      fixture: f,
                      safeDb: firstDb,
                      entry,
                      taskStatus,
                      assignment,
                    })
                  : runAction({ fixture: f, safeDb: firstDb, action }),
              );
              // The winner owns the run and waits on the controller's step;
              // the contender must respect workspace → run → step order.
              await waitForBlockedPid(observer.sql, {
                waitingPid: firstPid,
                holdingPid: controllerPid,
              });
              pending.push(
                taskFirst
                  ? runAction({ fixture: f, safeDb: secondDb, action })
                  : taskAction({
                      fixture: f,
                      safeDb: secondDb,
                      entry,
                      taskStatus,
                      assignment,
                    }),
              );
              await waitForBlockedPid(observer.sql, {
                waitingPid: secondPid,
                holdingPid: firstPid,
              });
              const waiting = await observer.db.execute<{ query: string }>(
                sql`SELECT query FROM pg_stat_activity WHERE pid = ${secondPid}`,
              );
              const blockedQuery = waiting.at(0)?.query;
              expect(blockedQuery).toBeDefined();
              if (workspaceLockOwner === "loser") {
                expect(workspaceAcquired).toBe(false);
                expect(blockedQuery).toMatch(/FROM "workspaces".*FOR UPDATE/iu);
              } else if (workspaceLockOwner === "winner") {
                expect(blockedQuery).toMatch(
                  /FROM "workspaces".*FOR KEY SHARE/iu,
                );
              } else {
                expect(blockedQuery).toMatch(/FROM "flow_runs".*FOR UPDATE/iu);
              }
            });
            expect(await Promise.all(pending)).toEqual([
              { type: "ok" },
              { type: "error", status: 409 },
            ]);
            expect(workspaceAcquired).toBe(workspaceLockOwner === "loser");
            const state = await f.read();
            const cancelled = !taskFirst && action === "cancel";
            expect(state.run?.status).toBe(
              (taskFirst ? action === "cancel" : action === "approved")
                ? "completed"
                : "cancelled",
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
                decision:
                  taskFirst && action === "approved" ? "rejected" : "approved",
              });
            }
            if (entry === "save_task") {
              expect(state.task?.name).toBe(
                taskFirst ? "Changed review task" : "Review task",
              );
              expect(state.task?.dueDate).toEqual(
                taskFirst ? "2026-10-10" : null,
              );
              const assignees = await first.db
                .select({ userId: taskAssignees.userId })
                .from(taskAssignees)
                .where(eq(taskAssignees.entityId, f.taskEntityId));
              expect(assignees).toEqual(
                taskFirst ? [{ userId: f.userId }] : [],
              );
            }
            const assignmentToRead = assignment.at(0);
            if (assignmentToRead) {
              const values = await first.db
                .select({ content: fields.content })
                .from(fields)
                .where(eq(fields.propertyId, assignmentToRead.propertyId));
              expect(values).toEqual(
                taskFirst ? [{ content: assignmentToRead.content }] : [],
              );
            }
            const completionNotices = await first.db
              .select({
                userId: notifications.userId,
                organizationId: notifications.organizationId,
                workspaceId: notifications.workspaceId,
                kind: notifications.kind,
                entityType: notifications.entityType,
                entityId: notifications.entityId,
                metadata: notifications.metadata,
              })
              .from(notifications)
              .where(
                eq(
                  notifications.idempotencyKey,
                  `flow-run-completed:${f.runId}`,
                ),
              )
              .limit(2);
            expect(completionNotices).toEqual(
              taskFirst && taskStatus === "done"
                ? [
                    {
                      userId: f.userId,
                      organizationId: f.organizationId,
                      workspaceId: f.workspaceId,
                      kind: NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
                      entityType: "flow_run",
                      entityId: f.runId,
                      metadata: { flowName: "Review flow" },
                    },
                  ]
                : [],
            );
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
      },
    );
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
