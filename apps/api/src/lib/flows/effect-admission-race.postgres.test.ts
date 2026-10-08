import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  featureEnrolments,
  flowDefinitions,
  flowRunSteps,
  notifications,
} from "@/api/db/schema";
import createDefinition from "@/api/handlers/flows/create";
import deleteDefinition from "@/api/handlers/flows/delete";
import cancelRun from "@/api/handlers/flows/runs/cancel";
import reviewRun from "@/api/handlers/flows/runs/review";
import updateDefinition from "@/api/handlers/flows/update";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { executeFlowStep } from "@/api/lib/flows/flow-executor";
import { startFlowRun } from "@/api/lib/flows/start-flow-run";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  flowReviewGateFixture,
  waitForBlockedPid,
} from "@/api/tests/helpers/flow-review-gate";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ACTIONS = [
  "manual",
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "cancel",
  "review-task",
] as const;
type Action = (typeof ACTIONS)[number];
type Fixture = Awaited<ReturnType<typeof flowReviewGateFixture>>;

const backendPid = async (db: GatedTestDb) => {
  const rows = await db.execute<{ pid: number }>(
    sql`select pg_backend_pid() as pid`,
  );
  return rows.at(0)?.pid ?? panic("Expected service database PID");
};

type InvokeActionOptions = {
  action: Action;
  fixture: Fixture;
  database: GatedTestDb;
  safeDb: SafeDb;
  definitionId: ReturnType<typeof createSafeId<"flowDefinition">>;
  reservePeriod: () => Promise<void>;
  enqueue: () => Promise<void>;
};

const invokeAction = async ({
  action,
  fixture: f,
  database,
  safeDb,
  definitionId,
  reservePeriod,
  enqueue,
}: InvokeActionOptions) => {
  const identity = {
    safeDb,
    workspaceId: f.workspaceId,
    session: { activeOrganizationId: f.organizationId },
    user: { id: f.userId, email: `${f.userId}@example.test` },
    recordAuditEvent: f.recordAuditEvent,
    getActiveWorkspaceIds: async () => [f.workspaceId],
    getWorkspaceAccess: async (workspaceId: typeof f.workspaceId) =>
      workspaceId === f.workspaceId
        ? { id: workspaceId, status: "active" }
        : null,
    pinServerValidatedWorkspaceId: (workspaceId: typeof f.workspaceId) =>
      workspaceId === f.workspaceId,
  };
  const body = {
    name: "Changed definition",
    description: null,
    enabled: true,
    steps: [{ kind: "review-gate", name: "Review", instructions: "Review" }],
    trigger: { type: "manual" },
  };
  switch (action) {
    case "create":
      return await createDefinition.handler(
        createTestHandlerContext<
          Parameters<typeof createDefinition.handler>[0]
        >({ ...identity, body }),
      );
    case "update":
      return await updateDefinition.handler(
        createTestHandlerContext<
          Parameters<typeof updateDefinition.handler>[0]
        >({ ...identity, body, params: { flowId: definitionId } }),
      );
    case "delete":
      return await deleteDefinition.handler(
        createTestHandlerContext<
          Parameters<typeof deleteDefinition.handler>[0]
        >({ ...identity, params: { flowId: definitionId } }),
      );
    case "approve":
    case "reject":
      return await reviewRun.handler(
        createTestHandlerContext<Parameters<typeof reviewRun.handler>[0]>({
          ...identity,
          params: { workspaceId: f.workspaceId, runId: f.runId },
          body: {
            decision: action === "approve" ? "approved" : "rejected",
            note: null,
          },
        }),
      );
    case "cancel":
      return await cancelRun.handler(
        createTestHandlerContext<Parameters<typeof cancelRun.handler>[0]>({
          ...identity,
          params: { workspaceId: f.workspaceId, runId: f.runId },
        }),
      );
    case "manual": {
      const started = await startFlowRun({
        safeDb,
        organizationId: f.organizationId,
        workspaceId: f.workspaceId,
        definitionId,
        triggerSource: { type: "manual", userId: f.userId },
        inputEntityIds: [],
        kickoff: async ({ run }) => await run(undefined, reservePeriod),
        enqueueStep: enqueue,
      });
      if (started.isOk()) {
        return started.value;
      }
      if ("cause" in started.error && HandlerError.is(started.error.cause)) {
        return { code: started.error.cause.status };
      }
      throw started.error;
    }
    case "review-task": {
      const scopedDb: ScopedDb = async (work) => {
        const result = await safeDb(work);
        if (result.isErr()) {
          throw result.error;
        }
        return result.value;
      };
      return await executeFlowStep(
        { runId: f.runId, stepIndex: 0 },
        new AbortController().signal,
        {
          database,
          admission: testModelAdmission(f.organizationId),
          makeScopedDb: () => scopedDb,
          makeSafeDb: () => safeDb,
          broadcastUpdate: () => undefined,
          enqueueStep: enqueue,
          taskFeatures: { governedWorkflow: false, legalLists: false },
          flushSearchRepairs: async () =>
            panic("Refused review must not flush search repairs"),
        },
      );
    }
    default:
      action satisfies never;
      return panic("Unknown admission test action");
  }
};

if (!databaseUrl || !enabled) {
  describe.skip("flow effect admission races (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("flow effect admission races (postgres)", () => {
    for (const action of ACTIONS) {
      test(`${action}: revoke committed after preflight refuses the authoritative effect`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient();
          const worker = openClient({
            connection: { statement_timeout: 10_000 },
          });
          const grantWriter = openClient({
            connection: { statement_timeout: 10_000 },
          });
          const f = await flowReviewGateFixture(observer.db, {
            intermediate: false,
            initialRunStatus:
              action === "review-task" ? "pending" : "awaiting_review",
          });
          const definitionId = createSafeId<"flowDefinition">();
          const preflight = Promise.withResolvers<undefined>();
          const enterEffect = Promise.withResolvers<undefined>();
          let calls = 0;
          let reservations = 0;
          let enqueues = 0;
          const delayedSafeDb: SafeDb = async (work, retry) => {
            calls += 1;
            if (calls === 2) {
              await enterEffect.promise;
            }
            const result = await f.safeDb(worker.db)(work, retry);
            if (calls === 1) {
              preflight.resolve(undefined);
            }
            return result;
          };
          let running: Promise<unknown> | undefined;
          try {
            await observer.db.insert(flowDefinitions).values({
              id: definitionId,
              organizationId: f.organizationId,
              name: "Original definition",
              description: null,
              enabled: true,
              createdByUserId: f.userId,
              steps: [
                {
                  kind: "review-gate",
                  name: "Review",
                  instructions: "Review",
                },
              ],
              trigger: { type: "manual" },
            });
            if (action === "review-task") {
              await observer.db
                .update(flowRunSteps)
                .set({ reviewTaskEntityId: null })
                .where(eq(flowRunSteps.runId, f.runId));
            }
            const workerPid = await backendPid(worker.db);
            const grantPid = await backendPid(grantWriter.db);
            running = invokeAction({
              action,
              fixture: f,
              database: worker.db,
              safeDb: delayedSafeDb,
              definitionId,
              reservePeriod: async () => {
                reservations += 1;
              },
              enqueue: async () => {
                enqueues += 1;
              },
            });
            await Promise.race([
              preflight.promise,
              running.then(() =>
                panic("Action did not reach its preflight barrier"),
              ),
            ]);
            const snapshot = async () => ({
              state: await f.read(),
              definitions: await observer.db.query.flowDefinitions.findMany({
                where: { organizationId: { eq: f.organizationId } },
                limit: 10,
              }),
              runs: await observer.db.query.flowRuns.findMany({
                where: { workspaceId: { eq: f.workspaceId } },
                limit: 10,
              }),
              noticeCount: await observer.db.$count(
                notifications,
                eq(notifications.workspaceId, f.workspaceId),
              ),
            });
            const before = await snapshot();
            await grantWriter.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "flows",
              });
              enterEffect.resolve(undefined);
              await waitForBlockedPid(observer.sql, {
                waitingPid: workerPid,
                holdingPid: grantPid,
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
            expect(await running).toMatchObject(
              action === "review-task" ? { status: "paused" } : { code: 404 },
            );
            expect(calls).toBe(2);
            expect(reservations).toBe(0);
            expect(enqueues).toBe(0);
            expect(await snapshot()).toEqual(before);
          } finally {
            enterEffect.resolve(undefined);
            if (running !== undefined) {
              await Promise.allSettled([running]);
            }
            await f.cleanup();
          }
        });
      });
    }
  });
}
