import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  featureEnrolments,
  flowDefinitions,
  flowRunSteps,
  flowRuns,
  notifications,
  workspaceMembers,
} from "@/api/db/schema";
import createDefinition from "@/api/handlers/flows/create";
import deleteDefinition from "@/api/handlers/flows/delete";
import cancelRun from "@/api/handlers/flows/runs/cancel";
import reviewRun from "@/api/handlers/flows/runs/review";
import updateDefinition from "@/api/handlers/flows/update";
import { createSafeId } from "@/api/lib/branded-types";
import {
  timestampCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";
import { FlowStepError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  executeFlowStep,
  failFlowRunFromWorker,
} from "@/api/lib/flows/flow-executor";
import {
  persistFlowStepClaim,
  type FlowStepJobData,
} from "@/api/lib/flows/flow-run-queue";
import { resumeFlowStepsAfterGrant } from "@/api/lib/flows/flow-run-worker";
import { FLOW_STEP_LEASE_MS } from "@/api/lib/flows/flow-types";
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

const prepareAiPersistenceRun = async (
  database: GatedTestDb,
  fixture: Fixture,
) => {
  await database
    .update(flowRuns)
    .set({
      definitionSnapshot: {
        name: "Admission flow",
        steps: [
          {
            kind: "ai",
            name: "Draft",
            prompt: "Draft a paragraph",
            includeDocuments: false,
          },
        ],
      },
    })
    .where(eq(flowRuns.id, fixture.runId));
  await database
    .update(flowRunSteps)
    .set({ kind: "ai", reviewTaskEntityId: null })
    .where(eq(flowRunSteps.runId, fixture.runId));
};

const ACCESS_CHANGES = [
  "matter-membership",
  "soft-delete",
  "hard-delete",
] as const;

type ChangeFlowActorAccessOptions = {
  change: (typeof ACCESS_CHANGES)[number];
  database: GatedTestDb;
  fixture: Fixture;
};

const changeFlowActorAccess = async ({
  change,
  database,
  fixture,
}: ChangeFlowActorAccessOptions) => {
  switch (change) {
    case "matter-membership":
      await database
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, fixture.workspaceId),
            eq(workspaceMembers.userId, fixture.userId),
          ),
        );
      expect(
        await database.$count(
          member,
          and(
            eq(member.organizationId, fixture.organizationId),
            eq(member.userId, fixture.userId),
          ),
        ),
      ).toBe(1);
      expect(
        await database.$count(
          featureEnrolments,
          and(
            eq(featureEnrolments.organizationId, fixture.organizationId),
            eq(featureEnrolments.userId, fixture.userId),
            eq(featureEnrolments.featureId, "flows"),
          ),
        ),
      ).toBe(1);
      break;
    case "soft-delete":
      await database
        .update(user)
        .set({ deletedAt: new Date() })
        .where(eq(user.id, fixture.userId));
      break;
    case "hard-delete":
      await database.delete(user).where(eq(user.id, fixture.userId));
      break;
    default:
      change satisfies never;
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
  describe("in-flight flow persistence admission (postgres)", () => {
    test.each(["completion", "failure"] as const)(
      "%s after revocation retains the current step; re-grant completes it once",
      async (settlement) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient();
          const worker = openClient();
          const grantWriter = openClient();
          const f = await flowReviewGateFixture(observer.db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          const entered = Promise.withResolvers<undefined>();
          const release = Promise.withResolvers<undefined>();
          let claimedStartedAt: TimestampCasToken | undefined;
          let broadcasts = 0;
          let enqueues = 0;
          let modelCalls = 0;
          const safeDb = f.safeDb(worker.db);
          const scopedDb: ScopedDb = async (work) => {
            const result = await safeDb(work);
            if (result.isErr()) {
              throw result.error;
            }
            return result.value;
          };
          const dependencies = {
            database: worker.db,
            admission: testModelAdmission(f.organizationId),
            makeScopedDb: () => scopedDb,
            makeSafeDb: () => safeDb,
            loadAIConfig: async () => Result.ok(null),
            enqueueStep: async () => {
              enqueues += 1;
            },
            broadcastUpdate: () => {
              broadcasts += 1;
            },
            onClaim: (token: TimestampCasToken) => {
              claimedStartedAt = token;
            },
          };
          const job = { runId: f.runId, stepIndex: 0 };
          let running: Promise<unknown> | undefined;
          try {
            await prepareAiPersistenceRun(observer.db, f);
            const execution = Result.tryPromise(
              async () =>
                await executeFlowStep(job, new AbortController().signal, {
                  ...dependencies,
                  generateTextForRole: async () => {
                    modelCalls += 1;
                    entered.resolve(undefined);
                    await release.promise;
                    if (settlement === "failure") {
                      throw new FlowStepError({
                        message: "Provider unavailable",
                      });
                    }
                    return "Uncommitted output";
                  },
                }),
            );
            running = execution;
            await Promise.race([
              entered.promise,
              execution.then(() =>
                panic("Execution did not reach the model barrier"),
              ),
            ]);
            const before = await f.read();
            expect(before.run).toMatchObject({
              status: "running",
              currentStepIndex: 0,
            });
            expect(before.steps.at(0)).toMatchObject({
              status: "running",
              output: null,
              finishedAt: null,
            });
            const noticesBefore = await observer.db.$count(
              notifications,
              eq(notifications.workspaceId, f.workspaceId),
            );
            const broadcastsBefore = broadcasts;
            await grantWriter.db.transaction(async (tx) => {
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
            release.resolve(undefined);
            const result = await execution;
            if (settlement === "completion") {
              if (result.isErr()) {
                throw result.error;
              }
              expect(result.value).toEqual({ status: "paused" });
            } else {
              if (result.isOk()) {
                panic("Expected external model failure");
              }
              if (claimedStartedAt === undefined) {
                panic("Expected running claim");
              }
              expect(
                await failFlowRunFromWorker(job, result.error, {
                  database: worker.db,
                  claimedStartedAt,
                  makeScopedDb: () => scopedDb,
                  broadcastUpdate: dependencies.broadcastUpdate,
                }),
              ).toEqual({ status: "paused" });
            }
            expect(await f.read()).toEqual(before);
            expect(
              await observer.db.$count(
                notifications,
                eq(notifications.workspaceId, f.workspaceId),
              ),
            ).toBe(noticesBefore);
            expect(broadcasts).toBe(broadcastsBefore);
            expect(enqueues).toBe(0);
            await grantWriter.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "flows",
              });
              await tx.insert(featureEnrolments).values({
                organizationId: f.organizationId,
                userId: f.userId,
                featureId: "flows",
              });
            });
            const recoveredJobs: Parameters<typeof executeFlowStep>[0][] = [];
            await resumeFlowStepsAfterGrant(
              { organizationId: f.organizationId, userId: f.userId },
              {
                database: worker.db,
                enqueueStep: async (recoveredJob) => {
                  recoveredJobs.push(recoveredJob);
                },
              },
            );
            expect(recoveredJobs).toEqual([job]);
            const recoveredJob =
              recoveredJobs.at(0) ?? panic("Expected retained step recovery");
            const recovered = () =>
              executeFlowStep(recoveredJob, new AbortController().signal, {
                ...dependencies,
                generateTextForRole: async () => {
                  modelCalls += 1;
                  return "Recovered output";
                },
              });
            expect(await recovered()).toEqual({ status: "completed" });
            const completed = await f.read();
            expect(completed.run).toMatchObject({ status: "completed" });
            expect(completed.steps.at(0)).toMatchObject({
              status: "completed",
              output: { kind: "ai", markdown: "Recovered output" },
            });
            expect(
              await observer.db.$count(
                notifications,
                eq(notifications.workspaceId, f.workspaceId),
              ),
            ).toBe(noticesBefore + 1);
            expect(await recovered()).toEqual({ status: "completed" });
            expect(await f.read()).toEqual(completed);
            expect(modelCalls).toBe(2);
            expect(
              await observer.db.$count(
                notifications,
                eq(notifications.workspaceId, f.workspaceId),
              ),
            ).toBe(noticesBefore + 1);
          } finally {
            release.resolve(undefined);
            if (running !== undefined) {
              await Promise.allSettled([running]);
            }
            await f.cleanup();
          }
        });
      },
    );
  });
  describe("durable flow claims after access changes (postgres)", () => {
    test.each(ACCESS_CHANGES)(
      "%s: a reconstructed retry retains the original claim and settles without another model call",
      async (change) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient();
          const worker = openClient();
          const f = await flowReviewGateFixture(observer.db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          let savedData: FlowStepJobData = { runId: f.runId, stepIndex: 0 };
          let claimWrites = 0;
          let modelCalls = 0;
          let broadcasts = 0;
          const firstJob = {
            data: savedData,
            updateData: async (data: FlowStepJobData) => {
              savedData = data;
              claimWrites += 1;
            },
          };
          const safeDb = f.safeDb(worker.db);
          const scopedDb: ScopedDb = async (work) => {
            const result = await safeDb(work);
            if (result.isErr()) {
              throw result.error;
            }
            return result.value;
          };
          const dependencies = {
            database: worker.db,
            admission: testModelAdmission(f.organizationId),
            makeScopedDb: () => scopedDb,
            makeSafeDb: () => safeDb,
            loadAIConfig: async () => Result.ok(null),
            enqueueStep: async () => panic("Unexpected step advancement"),
            broadcastUpdate: () => {
              broadcasts += 1;
            },
            onClaim: async (token: TimestampCasToken) => {
              await persistFlowStepClaim(firstJob, token);
            },
            generateTextForRole: async () => {
              modelCalls += 1;
              expect(savedData.claimedStartedAt).toBeDefined();
              throw new FlowStepError({ message: "Provider unavailable" });
            },
          };
          const retainedOutput = {
            kind: "ai",
            markdown: "Retained output",
          } as const;
          try {
            await prepareAiPersistenceRun(observer.db, f);
            await observer.db
              .update(flowRunSteps)
              .set({ output: retainedOutput })
              .where(eq(flowRunSteps.runId, f.runId));
            const firstAttempt = await Result.tryPromise(
              async () =>
                await executeFlowStep(
                  firstJob.data,
                  new AbortController().signal,
                  dependencies,
                ),
            );
            if (firstAttempt.isOk()) {
              panic("Expected the first external call to fail");
            }
            const claim =
              (
                await observer.db
                  .select({
                    token: timestampCasToken(flowRunSteps.startedAt),
                  })
                  .from(flowRunSteps)
                  .where(eq(flowRunSteps.runId, f.runId))
              ).at(0) ?? panic("Expected running source claim");
            expect(savedData.claimedStartedAt).toBe(claim.token);
            expect(claimWrites).toBe(1);
            const claimedState = await f.read();
            expect(claimedState.steps.at(0)).toMatchObject({
              status: "running",
              output: retainedOutput,
            });
            const noticesBefore = await observer.db.$count(
              notifications,
              eq(notifications.workspaceId, f.workspaceId),
            );
            const broadcastsBefore = broadcasts;
            await changeFlowActorAccess({
              change,
              database: observer.db,
              fixture: f,
            });
            // A new queue object carries only the data saved before the failed external call.
            const retryJob = { data: { ...savedData } };
            expect(retryJob).not.toBe(firstJob);
            const finalAttempt = await Result.tryPromise(
              async () =>
                await executeFlowStep(
                  retryJob.data,
                  new AbortController().signal,
                  dependencies,
                ),
            );
            if (change === "matter-membership") {
              expect(finalAttempt.isErr()).toBe(true);
              expect(await f.read()).toEqual(claimedState);
            } else {
              if (finalAttempt.isErr()) {
                throw finalAttempt.error;
              }
              expect(finalAttempt.value).toEqual({ status: "completed" });
            }
            const failure = finalAttempt.isErr()
              ? finalAttempt.error
              : firstAttempt.error;
            expect(
              await failFlowRunFromWorker(retryJob.data, failure, {
                database: worker.db,
                claimedStartedAt: retryJob.data.claimedStartedAt,
                makeScopedDb: () => scopedDb,
                broadcastUpdate: dependencies.broadcastUpdate,
              }),
            ).toEqual({ status: "completed" });
            const settled = await f.read();
            expect(settled.run).toMatchObject({ status: "failed" });
            expect(settled.steps.at(0)).toMatchObject({
              status: "failed",
              output: retainedOutput,
            });
            if (change !== "matter-membership") {
              expect(settled.run).toMatchObject({
                recoveryState: "actor-removed",
                error: "actor-removed",
              });
              expect(settled.steps.at(0)).toMatchObject({
                error: "actor-removed",
              });
              expect(
                await observer.db.$count(
                  notifications,
                  eq(notifications.workspaceId, f.workspaceId),
                ),
              ).toBe(noticesBefore);
              expect(broadcasts).toBe(broadcastsBefore);
            }
            const recoveredJobs: FlowStepJobData[] = [];
            await resumeFlowStepsAfterGrant(
              { organizationId: f.organizationId, userId: f.userId },
              {
                database: worker.db,
                enqueueStep: async (job) => {
                  recoveredJobs.push(job);
                },
              },
            );
            expect(recoveredJobs).toEqual([]);
            expect(
              await failFlowRunFromWorker(retryJob.data, failure, {
                database: worker.db,
                claimedStartedAt: retryJob.data.claimedStartedAt,
                makeScopedDb: () => scopedDb,
                broadcastUpdate: dependencies.broadcastUpdate,
              }),
            ).toEqual({ status: "completed" });
            expect(await f.read()).toEqual(settled);
            expect(modelCalls).toBe(1);
            expect(claimWrites).toBe(1);
          } finally {
            await f.cleanup();
          }
        });
      },
    );
  });
  describe("SQL flow claim lease recovery (postgres)", () => {
    test.each([
      "queue-write-failure",
      "worker-loss",
      "queue-write-failure-with-access-loss",
    ] as const)(
      "%s: an empty queue hint cannot replace a fresh claim and converges after expiry",
      async (interruption) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient();
          const worker = openClient();
          const f = await flowReviewGateFixture(observer.db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          let clock = new Date("2030-01-01T12:00:00.000Z");
          let modelCalls = 0;
          let recoveryClaims = 0;
          let attemptedData: FlowStepJobData | undefined;
          const queuedData: FlowStepJobData = { runId: f.runId, stepIndex: 0 };
          const queueJob = {
            data: queuedData,
            updateData: async (data: FlowStepJobData) => {
              attemptedData = data;
              throw new FlowStepError({ message: "Queue unavailable" });
            },
          };
          const safeDb = f.safeDb(worker.db);
          const scopedDb: ScopedDb = async (work) => {
            const result = await safeDb(work);
            if (result.isErr()) {
              throw result.error;
            }
            return result.value;
          };
          const dependencies = {
            database: worker.db,
            now: () => clock,
            admission: testModelAdmission(f.organizationId),
            makeScopedDb: () => scopedDb,
            makeSafeDb: () => safeDb,
            loadAIConfig: async () => Result.ok(null),
            enqueueStep: async () => panic("Unexpected step advancement"),
            broadcastUpdate: () => {},
            generateTextForRole: async () => {
              modelCalls += 1;
              return "Recovered output";
            },
          };
          const retainedOutput = {
            kind: "ai",
            markdown: "Retained output",
          } as const;
          try {
            await prepareAiPersistenceRun(observer.db, f);
            await observer.db
              .update(flowRunSteps)
              .set({ output: retainedOutput })
              .where(eq(flowRunSteps.runId, f.runId));
            const interrupted = await Result.tryPromise(
              async () =>
                await executeFlowStep(
                  queueJob.data,
                  new AbortController().signal,
                  {
                    ...dependencies,
                    onClaim: async (token: TimestampCasToken) => {
                      if (interruption === "worker-loss") {
                        throw new FlowStepError({
                          message: "Worker unavailable",
                        });
                      }
                      await persistFlowStepClaim(queueJob, token);
                    },
                  },
                ),
            );
            expect(interrupted.isErr()).toBe(true);
            expect(modelCalls).toBe(0);
            expect(queueJob.data.claimedStartedAt).toBeUndefined();
            const original =
              (
                await observer.db
                  .select({
                    startedAt: flowRunSteps.startedAt,
                    token: timestampCasToken(flowRunSteps.startedAt),
                  })
                  .from(flowRunSteps)
                  .where(eq(flowRunSteps.runId, f.runId))
              ).at(0) ?? panic("Expected committed SQL claim");
            if (original.startedAt === null || original.token === null) {
              panic("Expected a non-null running claim");
            }
            if (interruption !== "worker-loss") {
              expect(attemptedData?.claimedStartedAt).toBe(original.token);
            }
            const noticesBefore = await observer.db.$count(
              notifications,
              eq(notifications.workspaceId, f.workspaceId),
            );
            const originalState = await f.read();
            expect(originalState.run).toMatchObject({ status: "running" });
            expect(originalState.steps.at(0)).toMatchObject({
              status: "running",
              output: retainedOutput,
            });
            const restartJob = { data: { runId: f.runId, stepIndex: 0 } };
            const retry = () =>
              executeFlowStep(restartJob.data, new AbortController().signal, {
                ...dependencies,
                onClaim: async () => {
                  recoveryClaims += 1;
                },
              });
            expect(await retry()).toEqual({ status: "paused" });
            expect(await f.read()).toEqual(originalState);
            expect(modelCalls).toBe(0);
            expect(recoveryClaims).toBe(0);
            clock = new Date(
              original.startedAt.getTime() + FLOW_STEP_LEASE_MS + 1,
            );
            if (interruption === "queue-write-failure-with-access-loss") {
              await changeFlowActorAccess({
                change: "matter-membership",
                database: observer.db,
                fixture: f,
              });
              const refused = await Result.tryPromise(retry);
              if (refused.isOk()) {
                panic("Expected lost matter access to refuse execution");
              }
              expect(await f.read()).toEqual(originalState);
              const settle = () =>
                failFlowRunFromWorker(restartJob.data, refused.error, {
                  database: worker.db,
                  now: () => clock,
                  makeScopedDb: () => scopedDb,
                  broadcastUpdate: dependencies.broadcastUpdate,
                });
              expect(await settle()).toEqual({ status: "completed" });
              const failed = await f.read();
              expect(failed.run).toMatchObject({ status: "failed" });
              expect(failed.steps.at(0)).toMatchObject({
                status: "failed",
                output: retainedOutput,
                startedAt: clock,
              });
              const noticeCount = await observer.db.$count(
                notifications,
                eq(notifications.workspaceId, f.workspaceId),
              );
              expect(await settle()).toEqual({ status: "completed" });
              expect(await f.read()).toEqual(failed);
              expect(
                await observer.db.$count(
                  notifications,
                  eq(notifications.workspaceId, f.workspaceId),
                ),
              ).toBe(noticeCount);
              expect(modelCalls).toBe(0);
              expect(recoveryClaims).toBe(0);
            } else {
              expect(await retry()).toEqual({ status: "completed" });
              const completed = await f.read();
              expect(completed.run).toMatchObject({ status: "completed" });
              expect(completed.steps.at(0)).toMatchObject({
                status: "completed",
                output: { kind: "ai", markdown: "Recovered output" },
                startedAt: clock,
              });
              expect(
                await observer.db.$count(
                  notifications,
                  eq(notifications.workspaceId, f.workspaceId),
                ),
              ).toBe(noticesBefore + 1);
              expect(await retry()).toEqual({ status: "completed" });
              expect(await f.read()).toEqual(completed);
              expect(
                await observer.db.$count(
                  notifications,
                  eq(notifications.workspaceId, f.workspaceId),
                ),
              ).toBe(noticesBefore + 1);
              expect(modelCalls).toBe(1);
              expect(recoveryClaims).toBe(1);
            }
            const replaced =
              (
                await observer.db
                  .select({ token: timestampCasToken(flowRunSteps.startedAt) })
                  .from(flowRunSteps)
                  .where(eq(flowRunSteps.runId, f.runId))
              ).at(0) ?? panic("Expected settled SQL source");
            expect(replaced.token).not.toBe(original.token);
          } finally {
            await f.cleanup();
          }
        });
      },
    );
  });
  describe("flow regrant timestamp admission (postgres)", () => {
    test.each(["earlier", "later"] as const)(
      "%s grant is ordered against the exact claim timestamp",
      async (grantOrder) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient();
          const worker = openClient();
          const f = await flowReviewGateFixture(observer.db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          let clock = new Date("2030-01-01T12:00:00.000Z");
          let modelCalls = 0;
          const safeDb = f.safeDb(worker.db);
          const scopedDb: ScopedDb = async (work) => {
            const result = await safeDb(work);
            if (result.isErr()) {
              throw result.error;
            }
            return result.value;
          };
          const job = { runId: f.runId, stepIndex: 0 };
          const grantWhere = and(
            eq(featureEnrolments.organizationId, f.organizationId),
            eq(featureEnrolments.userId, f.userId),
            eq(featureEnrolments.featureId, "flows"),
          );
          const dependencies = {
            database: worker.db,
            now: () => clock,
            admission: testModelAdmission(f.organizationId),
            makeScopedDb: () => scopedDb,
            makeSafeDb: () => safeDb,
            loadAIConfig: async () => Result.ok(null),
            enqueueStep: async () => panic("Unexpected step advancement"),
            broadcastUpdate: () => {},
            generateTextForRole: async () => {
              modelCalls += 1;
              return "Recovered output";
            },
          };
          const execute = () =>
            executeFlowStep(job, new AbortController().signal, dependencies);
          try {
            await prepareAiPersistenceRun(observer.db, f);
            if (grantOrder === "earlier") {
              await observer.db
                .update(featureEnrolments)
                .set({
                  createdAt: sql`date_trunc('milliseconds', clock_timestamp()) - interval '1 millisecond' + interval '100 microseconds'`,
                })
                .where(grantWhere);
              const grant =
                (await observer.db.query.featureEnrolments.findFirst({
                  where: {
                    organizationId: { eq: f.organizationId },
                    userId: { eq: f.userId },
                    featureId: { eq: "flows" },
                  },
                  columns: { createdAt: true },
                })) ?? panic("Expected initial grant");
              clock = grant.createdAt;
              const interrupted = await Result.tryPromise(
                async () =>
                  await executeFlowStep(job, new AbortController().signal, {
                    ...dependencies,
                    onClaim: async () => {
                      throw new FlowStepError({
                        message: "Worker unavailable",
                      });
                    },
                  }),
              );
              expect(interrupted.isErr()).toBe(true);
              const ordering = (
                await observer.db
                  .select({
                    afterGrant: sql<boolean>`${flowRunSteps.startedAt} > ${featureEnrolments.createdAt}::timestamptz`,
                  })
                  .from(flowRunSteps)
                  .innerJoin(
                    featureEnrolments,
                    eq(featureEnrolments.organizationId, f.organizationId),
                  )
                  .where(and(eq(flowRunSteps.runId, f.runId), grantWhere))
                  .limit(1)
              ).at(0);
              expect(ordering?.afterGrant).toBe(true);
              const claimed = await f.read();
              expect(claimed.steps.at(0)?.status).toBe("running");
              expect(await execute()).toEqual({ status: "paused" });
              expect(await f.read()).toEqual(claimed);
              expect(modelCalls).toBe(0);
              return;
            }
            const originalStartedAt = "2030-01-01T12:00:00.000100Z";
            const grantedAt = "2030-01-01T12:00:00.000900Z";
            await observer.db
              .update(flowRuns)
              .set({ status: "running" })
              .where(eq(flowRuns.id, f.runId));
            await observer.db
              .update(flowRunSteps)
              .set({
                status: "running",
                startedAt: sql`${originalStartedAt}::text::timestamptz`,
              })
              .where(eq(flowRunSteps.runId, f.runId));
            await observer.db.transaction(async (tx) => {
              await lockFeatureRecoveryAdmission({
                tx,
                organizationId: f.organizationId,
                featureId: "flows",
              });
              await tx.delete(featureEnrolments).where(grantWhere);
              await tx.insert(featureEnrolments).values({
                organizationId: f.organizationId,
                userId: f.userId,
                featureId: "flows",
                createdAt: sql`${grantedAt}::text::timestamptz`,
              });
            });
            const before = await f.read();
            expect(before.steps.at(0)?.startedAt).toEqual(clock);
            const grant = await observer.db.query.featureEnrolments.findFirst({
              where: {
                organizationId: { eq: f.organizationId },
                userId: { eq: f.userId },
                featureId: { eq: "flows" },
              },
              columns: { createdAt: true },
            });
            expect(grant?.createdAt).toEqual(clock);
            expect(await execute()).toEqual({ status: "completed" });
            const reclaimedOrdering = (
              await observer.db
                .select({
                  afterGrant: sql<boolean>`${flowRunSteps.startedAt} > ${featureEnrolments.createdAt}::timestamptz`,
                })
                .from(flowRunSteps)
                .innerJoin(
                  featureEnrolments,
                  eq(featureEnrolments.organizationId, f.organizationId),
                )
                .where(and(eq(flowRunSteps.runId, f.runId), grantWhere))
                .limit(1)
            ).at(0);
            expect(reclaimedOrdering?.afterGrant).toBe(true);
            const completed = await f.read();
            expect(completed.run).toMatchObject({ status: "completed" });
            expect(completed.steps.at(0)).toMatchObject({
              status: "completed",
              output: { kind: "ai", markdown: "Recovered output" },
            });
            expect(await execute()).toEqual({ status: "completed" });
            expect(await f.read()).toEqual(completed);
            expect(modelCalls).toBe(1);
          } finally {
            await f.cleanup();
          }
        });
      },
    );
  });
}
