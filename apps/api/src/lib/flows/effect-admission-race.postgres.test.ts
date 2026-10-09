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
  schedulerJobs,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import createDefinition from "@/api/handlers/flows/create";
import deleteDefinition from "@/api/handlers/flows/delete";
import cancelRun from "@/api/handlers/flows/runs/cancel";
import reviewRun from "@/api/handlers/flows/runs/review";
import updateDefinition from "@/api/handlers/flows/update";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
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
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import {
  FlowRunStartError,
  startFlowRun,
} from "@/api/lib/flows/start-flow-run";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "@/api/lib/scheduler/tasks/flow-run";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  flowReviewGateFixture,
  waitForBlockedPid,
} from "@/api/tests/helpers/flow-review-gate";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
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
    audit: f.recordAuditEvent,
    scopedDb: NO_DB,
    getActiveWorkspaceIds: async () => [f.workspaceId],
    getWorkspaceAccess: async (workspaceId: typeof f.workspaceId) =>
      workspaceId === f.workspaceId
        ? { id: workspaceId, status: "active" as const }
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
        kickoff: async ({ run }) =>
          await run(new AbortController().signal, reservePeriod),
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
    test.each(
      (
        [
          "disabled",
          "time",
          "frequency",
          "manual",
          "workspace",
          "unchanged",
        ] as const
      ).flatMap((change) => [
        [change, "before preflight"] as const,
        [change, "after preflight"] as const,
      ]),
    )(
      "scheduled start revalidates the definition: %s (%s)",
      async (change, phase) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const worker = openClient();
          const writer = openClient();
          const f = await flowReviewGateFixture(worker.db, {
            intermediate: false,
          });
          const definitionId = createSafeId<"flowDefinition">();
          const otherWorkspaceId = createSafeId<"workspace">();
          const jobId = flowScheduleJobId(definitionId);
          const lockedBy = createSafeId<"flowRun">();
          const dueSlot = "2040-01-01T07:00:00.000Z";
          const originalTrigger = {
            type: "schedule" as const,
            workspaceId: f.workspaceId,
            schedule: { frequency: "daily" as const, hourUtc: 7 },
          };
          const currentSteps = [
            {
              kind: "review-gate" as const,
              name: "Current review",
              instructions: "Current instructions",
            },
          ];
          const patchForChange = () => {
            switch (change) {
              case "disabled":
                return { enabled: false };
              case "time":
                return {
                  trigger: {
                    ...originalTrigger,
                    schedule: { frequency: "daily" as const, hourUtc: 8 },
                  },
                };
              case "frequency":
                return {
                  trigger: {
                    ...originalTrigger,
                    schedule: {
                      frequency: "weekly" as const,
                      hourUtc: 7,
                      dayOfWeek: 1,
                    },
                  },
                };
              case "manual":
                return { trigger: { type: "manual" as const } };
              case "workspace":
                return {
                  trigger: {
                    ...originalTrigger,
                    workspaceId: otherWorkspaceId,
                  },
                };
              case "unchanged":
                return { name: "Current definition", steps: currentSteps };
              default:
                change satisfies never;
                return panic("Unknown scheduled definition change");
            }
          };
          let inserts = 0;
          let reservations = 0;
          let enqueues = 0;
          const production = automatedFlowRunDependencies(worker.db);
          const dependencies = {
            ...production,
            insertWithinCap: async (
              input: Parameters<typeof production.insertWithinCap>[0],
            ) => {
              inserts += 1;
              if (inserts === 1 && phase === "after preflight") {
                // The separate session commits after the actual preflight snapshot, before locked insertion.
                await writer.db
                  .update(flowDefinitions)
                  .set(patchForChange())
                  .where(eq(flowDefinitions.id, definitionId));
              }
              return await production.insertWithinCap(input);
            },
            enqueueStep: async () => {
              enqueues += 1;
            },
            kickoff: async ({ run }) =>
              await run(new AbortController().signal, async () => {
                reservations += 1;
              }),
          } satisfies Parameters<typeof startAutomatedFlowRun>[1];
          const start = async () =>
            await startAutomatedFlowRun(
              {
                definitionId,
                organizationId: f.organizationId,
                workspaceId: f.workspaceId,
                createdByUserId: f.userId,
                triggerSource: { type: "schedule", dueSlot },
                expectedScheduleTrigger: originalTrigger,
                inputEntityIds: [],
                schedulerClaim: { jobId, lockedBy },
                logContext: { definitionId },
              },
              dependencies,
            );
          try {
            await worker.db.insert(workspaces).values({
              id: otherWorkspaceId,
              organizationId: f.organizationId,
              name: "Alternate matter",
              reference: otherWorkspaceId.slice(0, 8),
            });
            await worker.db.insert(flowDefinitions).values({
              id: definitionId,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: "Preflight definition",
              enabled: true,
              trigger: originalTrigger,
              steps: [
                {
                  kind: "review-gate",
                  name: "Preflight review",
                  instructions: "Preflight instructions",
                },
              ],
            });
            await worker.db.insert(schedulerJobs).values({
              id: jobId,
              task: FLOW_RUN_TASK,
              schedule: { type: "daily", hour: 7, minute: 0, timeZone: "UTC" },
              payload: { definitionId },
              enabled: true,
              lockedBy,
              nextRunAt: new Date(dueSlot),
            });
            if (phase === "before preflight") {
              // The original scheduler snapshot precedes this committed edit and the starter's read.
              await writer.db
                .update(flowDefinitions)
                .set(patchForChange())
                .where(eq(flowDefinitions.id, definitionId));
            }
            const outcome = await start();
            const runs = await worker.db
              .select()
              .from(flowRuns)
              .where(eq(flowRuns.definitionId, definitionId));
            if (change !== "unchanged") {
              const status =
                phase === "before preflight" && change === "disabled"
                  ? "settled"
                  : "stale";
              expect(outcome).toEqual({ status });
              expect(inserts).toBe(phase === "before preflight" ? 0 : 1);
              expect(runs).toHaveLength(0);
              expect(reservations).toBe(0);
              expect(enqueues).toBe(0);
              return;
            }
            expect(outcome).toEqual({ status: "settled" });
            expect(runs).toHaveLength(1);
            const run = runs.at(0) ?? panic("Expected admitted scheduled run");
            expect(run.definitionSnapshot).toEqual({
              name: "Current definition",
              steps: currentSteps,
            });
            const steps = await worker.db
              .select()
              .from(flowRunSteps)
              .where(eq(flowRunSteps.runId, run.id));
            expect(steps).toHaveLength(1);
            expect(steps.at(0)?.kind).toBe("review-gate");
            expect(reservations).toBe(1);
            expect(enqueues).toBe(1);
            expect(await start()).toEqual({ status: "settled" });
            expect(
              await worker.db
                .select()
                .from(flowRuns)
                .where(eq(flowRuns.definitionId, definitionId)),
            ).toHaveLength(1);
            expect(reservations).toBe(1);
            expect(enqueues).toBe(1);
          } finally {
            await worker.db
              .delete(schedulerJobs)
              .where(eq(schedulerJobs.id, jobId));
            await f.cleanup();
          }
        });
      },
    );

    test.each(["steps changed", "steps unchanged"] as const)(
      "manual confirmation covers the current definition steps: %s",
      async (change) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const worker = openClient();
          const writer = openClient();
          const f = await flowReviewGateFixture(worker.db, {
            intermediate: false,
          });
          const definitionId = createSafeId<"flowDefinition">();
          const originalSteps = [
            {
              kind: "review-gate" as const,
              name: "Original review",
              instructions: "Original instructions",
            },
          ];
          const changedSteps = [
            {
              kind: "review-gate" as const,
              name: "Different review",
              instructions: "Different instructions",
            },
          ];
          let confirmations = 0;
          let reservations = 0;
          let enqueues = 0;
          try {
            await worker.db.insert(flowDefinitions).values({
              id: definitionId,
              organizationId: f.organizationId,
              createdByUserId: f.userId,
              name: "Original definition",
              enabled: true,
              trigger: { type: "manual" },
              steps: originalSteps,
            });
            const started = await startFlowRun({
              safeDb: f.safeDb(worker.db),
              organizationId: f.organizationId,
              workspaceId: f.workspaceId,
              definitionId,
              triggerSource: { type: "manual", userId: f.userId },
              inputEntityIds: [],
              admit: async ({ steps }) => {
                confirmations += 1;
                expect(steps).toEqual(originalSteps);
                // The confirmed snapshot precedes this separate committed definition write.
                await withAggregateTransaction(writer.db, async (tx) => {
                  await lockFeatureRecoveryAdmission({
                    tx,
                    organizationId: f.organizationId,
                    featureId: "flows",
                  });
                  await tx
                    .update(flowDefinitions)
                    .set({
                      name: "Current definition",
                      steps:
                        change === "steps changed"
                          ? changedSteps
                          : originalSteps,
                    })
                    .where(eq(flowDefinitions.id, definitionId));
                });
                return null;
              },
              kickoff: async ({ run }) =>
                await run(new AbortController().signal, async () => {
                  reservations += 1;
                }),
              enqueueStep: async () => {
                enqueues += 1;
              },
            });
            expect(confirmations).toBe(1);
            const runs = await worker.db
              .select()
              .from(flowRuns)
              .where(eq(flowRuns.definitionId, definitionId));
            if (change === "steps changed") {
              if (started.isOk()) {
                panic("Changed confirmation unexpectedly started a run");
              }
              expect(FlowRunStartError.is(started.error)).toBe(true);
              if (
                !FlowRunStartError.is(started.error) ||
                !HandlerError.is(started.error.cause)
              ) {
                panic("Expected a typed stale confirmation refusal");
              }
              expect(started.error.reason).toBe("admission-refused");
              expect(started.error.cause.status).toBe(409);
              expect(runs).toHaveLength(0);
              expect(reservations).toBe(0);
              expect(enqueues).toBe(0);
              return;
            }
            if (started.isErr()) {
              throw started.error;
            }
            expect(runs).toHaveLength(1);
            expect(runs.at(0)?.definitionSnapshot).toEqual({
              name: "Current definition",
              steps: originalSteps,
            });
            expect(reservations).toBe(1);
            expect(enqueues).toBe(1);
          } finally {
            await f.cleanup();
          }
        });
      },
    );

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
            if (claim.token === null) {
              panic("Expected running source claim timestamp");
            }
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
    test("an expired replacement claim refuses a previous worker's failure", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const observer = openClient();
        const worker = openClient();
        const f = await flowReviewGateFixture(observer.db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const clock = new Date("2030-01-01T12:00:00.000Z");
        const originalStartedAt = new Date(
          clock.getTime() - FLOW_STEP_LEASE_MS * 3,
        );
        const replacementStartedAt = new Date(
          clock.getTime() - FLOW_STEP_LEASE_MS * 2,
        );
        const safeDb = f.safeDb(worker.db);
        const scopedDb: ScopedDb = async (work) => {
          const result = await safeDb(work);
          if (result.isErr()) {
            throw result.error;
          }
          return result.value;
        };
        let broadcasts = 0;
        const readToken = async () => {
          const row = (
            await observer.db
              .select({ token: timestampCasToken(flowRunSteps.startedAt) })
              .from(flowRunSteps)
              .where(
                and(eq(flowRunSteps.runId, f.runId), eq(flowRunSteps.index, 0)),
              )
          ).at(0);
          return row?.token ?? panic("Expected committed claim token");
        };
        try {
          await observer.db
            .update(flowRuns)
            .set({ status: "running", startedAt: originalStartedAt })
            .where(eq(flowRuns.id, f.runId));
          await observer.db
            .update(flowRunSteps)
            .set({ status: "running", startedAt: originalStartedAt })
            .where(eq(flowRunSteps.runId, f.runId));
          const originalToken = await readToken();
          await observer.db
            .update(flowRunSteps)
            .set({ startedAt: replacementStartedAt })
            .where(eq(flowRunSteps.runId, f.runId));
          const replacementToken = await readToken();
          expect(replacementToken).not.toBe(originalToken);
          expect(replacementStartedAt.getTime()).toBeLessThan(
            clock.getTime() - FLOW_STEP_LEASE_MS,
          );
          const replacementState = await f.read();
          const noticeCount = await observer.db.$count(
            notifications,
            eq(notifications.workspaceId, f.workspaceId),
          );
          const failure = new FlowStepError({ message: "Step unavailable" });
          const dependencies = {
            database: worker.db,
            now: () => clock,
            makeScopedDb: () => scopedDb,
            broadcastUpdate: () => {
              broadcasts += 1;
            },
          };
          expect(
            await failFlowRunFromWorker(
              { runId: f.runId, stepIndex: 0 },
              failure,
              {
                ...dependencies,
                claimedStartedAt: originalToken,
              },
            ),
          ).toEqual({ status: "stale" });
          expect(await f.read()).toEqual(replacementState);
          expect(
            await observer.db.$count(
              notifications,
              eq(notifications.workspaceId, f.workspaceId),
            ),
          ).toBe(noticeCount);
          expect(broadcasts).toBe(0);
          expect(
            await failFlowRunFromWorker(
              { runId: f.runId, stepIndex: 0 },
              failure,
              {
                ...dependencies,
                claimedStartedAt: replacementToken,
              },
            ),
          ).toEqual({ status: "completed" });
          expect((await f.read()).steps.at(0)).toMatchObject({
            status: "failed",
            startedAt: replacementStartedAt,
          });
        } finally {
          await f.cleanup();
        }
      });
    });
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
                (
                  await observer.db
                    .select({ createdAt: featureEnrolments.createdAt })
                    .from(featureEnrolments)
                    .where(grantWhere)
                    .limit(1)
                ).at(0) ?? panic("Expected initial grant");
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
            const grant = (
              await observer.db
                .select({ createdAt: featureEnrolments.createdAt })
                .from(featureEnrolments)
                .where(grantWhere)
                .limit(1)
            ).at(0);
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
