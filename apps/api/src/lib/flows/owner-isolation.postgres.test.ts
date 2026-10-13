import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { flowRunUpdateRealtimeEvent } from "@stll/api-contract";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, user } from "@/api/db/auth-schema";
import { proveOrgScope, withOrgScope } from "@/api/db/org-scope";
import {
  featureEnrolments,
  flowUploadTriggerIntents,
  workspaceMembers,
  workspaces,
  flowDefinitions,
  flowRuns,
  notifications,
  schedulerJobs,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { realtimeAuthorizers } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { resumeFeatureAfterGrant } from "@/api/lib/feature-access/grant-recovery";
import { insertAutomatedFlowRunWithinCap } from "@/api/lib/flows/automated-run-cap";
import {
  executeFlowStep,
  failFlowRunFromWorker,
  FlowStepError,
} from "@/api/lib/flows/flow-executor";
import { fileFlowRunCompletionNotice } from "@/api/lib/flows/flow-run-actor";
import { notifyFlowRunActorOfCompletion } from "@/api/lib/flows/flow-run-completion-notice";
import { deliverFlowRunWorkspaceEvent } from "@/api/lib/flows/flow-run-events";
import { reconcileOrphanedFlowRuns } from "@/api/lib/flows/flow-run-worker";
import { resumeFlowsAfterGrant as resumeFacade } from "@/api/lib/flows/grant-recovery";
import { maybeStartUploadTriggeredFlows as dispatchUploadOwner } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import { cleanupFlowDefinitions } from "@/api/lib/flows/reset-cleanup";
import { resumeFlowsAfterGrant as resumeOwner } from "@/api/lib/flows/resume-after-grant";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import { syncFlowScheduleTriggerInTransaction } from "@/api/lib/flows/sync-flow-schedule-trigger";
import {
  recordUploadTriggeredFlowIntents,
  maybeStartUploadTriggeredFlows as dispatchUploadFacade,
} from "@/api/lib/flows/upload-trigger-recording";
import {
  FLOW_RUN_TASK,
  flowScheduleJobId,
} from "@/api/lib/scheduler/tasks/flow-run";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { withOrgScopedFixture } from "@/api/tests/helpers/org-scoped-fixture";
import { createTestState } from "@/api/tests/helpers/test-state";

const testState = createTestState({ file: import.meta.path, config: env });

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const databaseUrl = () =>
  process.env["DATABASE_URL"] ?? panic("Missing PostgreSQL test URL");

describe.skipIf(!enabled)(
  "flow owner organization isolation (postgres)",
  () => {
    test("schedule synchronization retains other organizations' source jobs", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const definitionId = createSafeId<"flowDefinition">();
        const jobId = flowScheduleJobId(definitionId);
        try {
          await db.insert(flowDefinitions).values({
            id: definitionId,
            organizationId: b.organizationId,
            createdByUserId: b.userId,
            name: "Scheduled fixture",
            steps: [],
            trigger: {
              type: "schedule",
              workspaceId: b.workspaceId,
              schedule: { frequency: "daily", hourUtc: 7 },
            },
          });
          await db.insert(schedulerJobs).values({
            id: jobId,
            task: FLOW_RUN_TASK,
            schedule: { type: "daily", hour: 7, minute: 0, timeZone: "UTC" },
            payload: { definitionId },
            nextRunAt: new Date("2040-01-01T07:00:00.000Z"),
          });
          const before = await db.query.schedulerJobs.findFirst({
            where: { id: { eq: jobId } },
          });
          expect(before).toBeDefined();
          await withAggregateTransaction(
            db,
            async (tx) =>
              await syncFlowScheduleTriggerInTransaction({
                tx,
                organizationId: a.organizationId,
                definitionId,
              }),
          );
          expect(
            await db.query.schedulerJobs.findFirst({
              where: { id: { eq: jobId } },
            }),
          ).toEqual(before);
        } finally {
          await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("completion notice admission retains other organizations' run state", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        try {
          await db
            .update(flowRuns)
            .set({ status: "completed" })
            .where(eq(flowRuns.id, b.runId));
          const read = async () => ({
            run: await db.query.flowRuns.findFirst({
              where: { id: { eq: b.runId } },
            }),
            notices: await db
              .select()
              .from(notifications)
              .where(eq(notifications.organizationId, b.organizationId))
              .orderBy(notifications.id),
          });
          const before = await read();
          expect(before.run?.status).toBe("completed");
          await fileFlowRunCompletionNotice(
            {
              organizationId: a.organizationId,
              workspaceId: b.workspaceId,
              runId: b.runId,
              flowName: "Completed fixture",
              run: {
                definitionId: null,
                triggerSource: { type: "manual", userId: b.userId },
              },
            },
            db,
          );
          expect(await read()).toEqual(before);
          expect(
            await db.$count(
              notifications,
              eq(notifications.organizationId, a.organizationId),
            ),
          ).toBe(0);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test.each(["resume owner", "grant facade", "worker recovery"] as const)(
      "%s retains other organizations' runnable sources",
      async (entry) => {
        await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
          const { db } = openClient();
          const a = await flowReviewGateFixture(db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          const b = await flowReviewGateFixture(db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          const restoreRuntime = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          testState.setConfig("FEATURE_FLOWS", true);
          try {
            await db.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId: b.organizationId,
              userId: a.userId,
              role: "member",
              createdAt: new Date(),
            });
            await db
              .insert(workspaceMembers)
              .values({ workspaceId: b.workspaceId, userId: a.userId });
            await db.insert(featureEnrolments).values([
              {
                organizationId: b.organizationId,
                userId: a.userId,
                featureId: "flows",
              },
              {
                organizationId: b.organizationId,
                userId: a.userId,
                featureId: "signals",
              },
            ]);
            await db
              .update(flowRuns)
              .set({ triggerSource: { type: "manual", userId: a.userId } })
              .where(eq(flowRuns.id, b.runId));
            const definitions = [
              { fixture: a, id: createSafeId<"flowDefinition">() },
              { fixture: b, id: createSafeId<"flowDefinition">() },
            ];
            for (const { fixture, id } of definitions) {
              await db.insert(flowDefinitions).values({
                id,
                organizationId: fixture.organizationId,
                createdByUserId: a.userId,
                name: "Grant source",
                steps: [],
                trigger: {
                  type: "file-upload",
                  workspaceIds: null,
                  fileExtensions: null,
                },
              });
              await withOrgScopedFixture({
                database: db,
                workspaceId: fixture.workspaceId,
                fn: async (fixtureTx) =>
                  await fixtureTx.insert(flowUploadTriggerIntents).values({
                    definitionId: id,
                    entityId: fixture.taskEntityId,
                    organizationId: fixture.organizationId,
                    workspaceId: fixture.workspaceId,
                    status: "awaiting_grant",
                  }),
              });
            }
            const readB = async () => ({
              source: await b.read(),
              receipts: await db
                .select()
                .from(flowUploadTriggerIntents)
                .where(
                  eq(flowUploadTriggerIntents.organizationId, b.organizationId),
                )
                .orderBy(flowUploadTriggerIntents.entityId),
              notices: await db
                .select()
                .from(notifications)
                .where(eq(notifications.organizationId, b.organizationId))
                .orderBy(notifications.id),
            });
            const before = await readB();
            const enqueued: { runId: string; stepIndex: number }[] = [];
            const dependencies = {
              database: db,
              enqueueStep: async (job: {
                runId: string;
                stepIndex: number;
              }) => {
                enqueued.push(job);
              },
            };
            const principal = {
              organizationId: a.organizationId,
              userId: a.userId,
            };
            const resume = async () => {
              switch (entry) {
                case "resume owner":
                  return await resumeOwner(principal, dependencies);
                case "grant facade":
                  return await resumeFacade(principal, dependencies);
                case "worker recovery":
                  return await reconcileOrphanedFlowRuns(
                    { principal },
                    dependencies,
                  );
                default:
                  entry satisfies never;
              }
            };
            await resumeFacade(
              { organizationId: a.organizationId, userId: b.userId },
              dependencies,
            );
            expect(enqueued).toEqual([]);
            expect(await readB()).toEqual(before);
            testState.setConfig("FEATURE_FLOWS", false);
            await resume();
            expect(enqueued).toEqual([]);
            expect(await readB()).toEqual(before);
            testState.setConfig("FEATURE_FLOWS", true);
            await db
              .delete(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, a.organizationId),
                  eq(featureEnrolments.userId, a.userId),
                  eq(featureEnrolments.featureId, "flows"),
                ),
              );
            await resume();
            expect(enqueued).toEqual([]);
            expect(await readB()).toEqual(before);
            await db.insert(featureEnrolments).values({
              organizationId: a.organizationId,
              userId: a.userId,
              featureId: "flows",
            });
            await resume();
            expect(enqueued).toEqual([{ runId: a.runId, stepIndex: 0 }]);
            expect(await readB()).toEqual(before);
          } finally {
            restoreRuntime();
            await b.cleanup();
            await a.cleanup();
          }
        });
      },
    );

    test("completion notice recovery retains other organizations' pending notices", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: b.organizationId,
            userId: a.userId,
            role: "member",
            createdAt: new Date(),
          });
          await db
            .insert(workspaceMembers)
            .values({ workspaceId: b.workspaceId, userId: a.userId });
          await db.insert(featureEnrolments).values({
            organizationId: b.organizationId,
            userId: a.userId,
            featureId: "flows",
          });
          for (const fixture of [a, b]) {
            await db
              .update(flowRuns)
              .set({
                status: "completed",
                recoveryState: "completion-notice-pending",
                triggerSource: { type: "manual", userId: a.userId },
              })
              .where(eq(flowRuns.id, fixture.runId));
          }
          const readB = async () => ({
            source: await b.read(),
            notices: await db
              .select()
              .from(notifications)
              .where(eq(notifications.organizationId, b.organizationId))
              .orderBy(notifications.id),
          });
          const before = await readB();
          await reconcileOrphanedFlowRuns(
            {
              principal: { organizationId: a.organizationId, userId: a.userId },
            },
            {
              database: db,
              enqueueStep: async () =>
                panic("Completed source must not enqueue"),
            },
          );
          expect(await readB()).toEqual(before);
          expect(
            await db.$count(
              notifications,
              eq(notifications.organizationId, a.organizationId),
            ),
          ).toBe(1);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("automated start and its cap retain other organizations' sources", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        const definitionId = createSafeId<"flowDefinition">();
        const runId = createSafeId<"flowRun">();
        const trigger = {
          type: "schedule",
          workspaceId: b.workspaceId,
          schedule: { frequency: "daily", hourUtc: 7 },
        } as const;
        try {
          await db.insert(flowDefinitions).values({
            id: definitionId,
            organizationId: b.organizationId,
            createdByUserId: b.userId,
            name: "Automated fixture",
            steps: [],
            trigger,
          });
          const before = await b.read();
          const enqueued: unknown[] = [];
          const started = await startAutomatedFlowRun(
            {
              definitionId,
              organizationId: a.organizationId,
              workspaceId: b.workspaceId,
              createdByUserId: a.userId,
              triggerSource: { type: "schedule" },
              inputEntityIds: [],
              logContext: {},
              expectedScheduleTrigger: trigger,
            },
            {
              ...automatedFlowRunDependencies(db),
              enqueueStep: async (job) => {
                enqueued.push(job);
              },
            },
          );
          expect(started).toEqual({ status: "settled" });
          const capped = await insertAutomatedFlowRunWithinCap({
            organizationId: a.organizationId,
            userId: a.userId,
            definitionId,
            rows: buildFlowRunRows({
              runId,
              workspaceId: b.workspaceId,
              definitionId,
              definition: { name: "Automated fixture", steps: [] },
              triggerSource: { type: "schedule" },
              inputEntityIds: [],
            }),
            expectedScheduleTrigger: trigger,
            database: db,
          });
          expect(capped.outcome).not.toBe("started");
          expect(await b.read()).toEqual(before);
          expect(
            await db.$count(flowRuns, eq(flowRuns.definitionId, definitionId)),
          ).toBe(0);
          expect(enqueued).toEqual([]);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("flow reset cleanup retains other organizations' definitions", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const definitionId = createSafeId<"flowDefinition">();
        try {
          await db.insert(flowDefinitions).values({
            id: definitionId,
            organizationId: b.organizationId,
            createdByUserId: b.userId,
            name: "Retained fixture",
            steps: [],
            trigger: { type: "manual" },
          });
          const before = {
            definition: await db.query.flowDefinitions.findFirst({
              where: { id: { eq: definitionId } },
            }),
            source: await b.read(),
          };
          await withAggregateTransaction(
            db,
            async (tx) =>
              await cleanupFlowDefinitions({
                tx,
                organizationId: a.organizationId,
                subject: createSafeId<"schedulerJobRun">(),
              }),
          );
          expect({
            definition: await db.query.flowDefinitions.findFirst({
              where: { id: { eq: definitionId } },
            }),
            source: await b.read(),
          }).toEqual(before);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("upload receipt recording retains other organizations' source receipts", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const definitionId = createSafeId<"flowDefinition">();
        const ownDefinitionId = createSafeId<"flowDefinition">();
        try {
          for (const [fixture, id] of [
            [a, ownDefinitionId],
            [b, definitionId],
          ] as const) {
            await db.insert(flowDefinitions).values({
              id,
              organizationId: fixture.organizationId,
              createdByUserId: fixture.userId,
              name: "Upload fixture",
              steps: [],
              trigger: {
                type: "file-upload",
                workspaceIds: null,
                fileExtensions: null,
              },
            });
          }
          await withOrgScopedFixture({
            database: db,
            workspaceId: b.workspaceId,
            fn: async (fixtureTx) =>
              await fixtureTx.insert(flowUploadTriggerIntents).values({
                definitionId,
                entityId: b.taskEntityId,
                workspaceId: b.workspaceId,
                organizationId: b.organizationId,
                status: "awaiting_grant",
              }),
          });
          const readB = async () => ({
            source: await b.read(),
            receipts: await db
              .select()
              .from(flowUploadTriggerIntents)
              .where(
                eq(flowUploadTriggerIntents.organizationId, b.organizationId),
              )
              .orderBy(flowUploadTriggerIntents.entityId),
          });
          const before = await readB();
          await withAggregateTransaction(
            db,
            async (tx) =>
              await recordUploadTriggeredFlowIntents(tx, {
                organizationId: a.organizationId,
                workspaceId: b.workspaceId,
                entityId: b.taskEntityId,
                fileName: "fixture.pdf",
              }),
          );
          expect(await readB()).toEqual(before);
          expect(
            await db.$count(
              flowUploadTriggerIntents,
              eq(flowUploadTriggerIntents.organizationId, a.organizationId),
            ),
          ).toBe(0);
          expect(
            await db.$count(flowRuns, eq(flowRuns.definitionId, definitionId)),
          ).toBe(0);
        } finally {
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("flow event delivery retains other organizations' recipient admission", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: b.organizationId,
            userId: a.userId,
            role: "member",
            createdAt: new Date(),
          });
          await db
            .insert(workspaceMembers)
            .values({ workspaceId: b.workspaceId, userId: a.userId });
          await db.insert(featureEnrolments).values({
            organizationId: b.organizationId,
            userId: a.userId,
            featureId: "flows",
          });
          const before = await b.read();
          const delivered = new Set<string>();
          await deliverFlowRunWorkspaceEvent({
            database: db,
            organizationId: a.organizationId,
            workspaceId: b.workspaceId,
            userIds: [a.userId],
            event: flowRunUpdateRealtimeEvent({
              runId: b.runId,
              status: "awaiting_review",
              currentStepIndex: 0,
              steps: [],
            }).toJSON(),
            deliver: (recipients) => {
              for (const recipient of recipients) {
                delivered.add(recipient);
              }
            },
          });
          expect(delivered).toEqual(new Set());
          expect(await b.read()).toEqual(before);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test.each(["execution", "failure fallback"] as const)(
      "%s scoped database control retains other organizations' source state",
      async (entry) => {
        await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
          const { db } = openClient();
          const a = await flowReviewGateFixture(db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          const b = await flowReviewGateFixture(db, {
            intermediate: false,
            initialRunStatus: "pending",
          });
          const restoreRuntime = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          testState.setConfig("FEATURE_FLOWS", true);
          try {
            const before = await b.read();
            let broadcasts = 0;
            let enqueues = 0;
            let modelCalls = 0;
            await withAggregateTransaction(db, async (tx) => {
              const scope = await proveOrgScope(tx, {
                table: "workspaces",
                where: eq(workspaces.id, a.workspaceId),
              });
              if (scope.isErr()) {
                panic("Fixture matter must have a scope");
              }
              await withOrgScope({
                tx,
                scope: scope.value,
                actor: { type: "system" },
                fn: async (scopedTx) => {
                  const database = {
                    query: scopedTx.query,
                    select: scopedTx.select.bind(scopedTx),
                    transaction: scopedTx.transaction.bind(scopedTx),
                  };
                  const job = { runId: b.runId, stepIndex: 0 };
                  const broadcastUpdate = () => {
                    broadcasts += 1;
                  };
                  switch (entry) {
                    case "execution":
                      expect(
                        await executeFlowStep(
                          job,
                          new AbortController().signal,
                          {
                            admission: null,
                            database,
                            broadcastUpdate,
                            enqueueStep: async () => {
                              enqueues += 1;
                            },
                            generateTextForRole: async () => {
                              modelCalls += 1;
                              return "Fixture output";
                            },
                          },
                        ),
                      ).toEqual({ status: "completed" });
                      break;
                    case "failure fallback":
                      expect(
                        await failFlowRunFromWorker(
                          job,
                          new FlowStepError({
                            message: "Fixture step unavailable",
                          }),
                          { database, broadcastUpdate },
                        ),
                      ).toEqual({ status: "completed" });
                      break;
                    default:
                      entry satisfies never;
                  }
                },
              });
            });
            expect(await b.read()).toEqual(before);
            expect({ broadcasts, enqueues, modelCalls }).toEqual({
              broadcasts: 0,
              enqueues: 0,
              modelCalls: 0,
            });
            expect(
              await db.$count(
                notifications,
                eq(notifications.organizationId, b.organizationId),
              ),
            ).toBe(0);
          } finally {
            restoreRuntime();
            await b.cleanup();
            await a.cleanup();
          }
        });
      },
    );

    test.each(["upload owner", "upload facade"] as const)(
      "%s retains other organizations' pending upload sources",
      async (entry) => {
        await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
          const { db } = openClient();
          const a = await flowReviewGateFixture(db, { intermediate: false });
          const b = await flowReviewGateFixture(db, { intermediate: false });
          const restoreRuntime = setRuntimeModeForTesting({
            mode: RUNTIME_MODE.strict,
          });
          testState.setConfig("FEATURE_FLOWS", true);
          const definitionId = createSafeId<"flowDefinition">();
          try {
            await db.insert(flowDefinitions).values({
              id: definitionId,
              organizationId: b.organizationId,
              createdByUserId: b.userId,
              name: "Upload source",
              enabled: false,
              steps: [],
              trigger: {
                type: "file-upload",
                workspaceIds: null,
                fileExtensions: null,
              },
            });
            await withOrgScopedFixture({
              database: db,
              workspaceId: b.workspaceId,
              fn: async (tx) =>
                await tx.insert(flowUploadTriggerIntents).values({
                  definitionId,
                  entityId: b.taskEntityId,
                  organizationId: b.organizationId,
                  workspaceId: b.workspaceId,
                  status: "pending",
                }),
            });
            const readB = async () => ({
              source: await b.read(),
              definition: await db.query.flowDefinitions.findFirst({
                where: { id: { eq: definitionId } },
              }),
              receipts: await db
                .select()
                .from(flowUploadTriggerIntents)
                .where(
                  eq(flowUploadTriggerIntents.organizationId, b.organizationId),
                )
                .orderBy(flowUploadTriggerIntents.entityId),
              runs: await db.query.flowRuns.findMany({
                where: { definitionId: { eq: definitionId } },
              }),
              notices: await db
                .select()
                .from(notifications)
                .where(eq(notifications.organizationId, b.organizationId))
                .orderBy(notifications.id),
            });
            const before = await readB();
            const dispatch =
              entry === "upload owner"
                ? dispatchUploadOwner
                : dispatchUploadFacade;
            await dispatch({
              organizationId: a.organizationId,
              workspaceId: b.workspaceId,
              entityId: b.taskEntityId,
              fileName: "fixture.pdf",
            });
            expect(await readB()).toEqual(before);
            await dispatch({
              organizationId: a.organizationId,
              workspaceId: a.workspaceId,
              entityId: a.taskEntityId,
              fileName: "fixture.pdf",
            });
            expect(await readB()).toEqual(before);
            expect(
              await db.$count(
                flowUploadTriggerIntents,
                eq(flowUploadTriggerIntents.organizationId, a.organizationId),
              ),
            ).toBe(0);
          } finally {
            restoreRuntime();
            await b.cleanup();
            await a.cleanup();
          }
        });
      },
    );

    test("completion facade retains other organizations' completed sources", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          await db
            .update(flowRuns)
            .set({ status: "completed" })
            .where(eq(flowRuns.id, b.runId));
          const readB = async () => ({
            source: await b.read(),
            notices: await db
              .select()
              .from(notifications)
              .where(eq(notifications.organizationId, b.organizationId))
              .orderBy(notifications.id),
          });
          const before = await readB();
          expect(before.source.run?.status).toBe("completed");
          await notifyFlowRunActorOfCompletion({
            organizationId: a.organizationId,
            workspaceId: b.workspaceId,
            runId: b.runId,
            flowName: "Completed fixture",
            run: {
              definitionId: null,
              triggerSource: { type: "manual", userId: b.userId },
            },
          });
          expect(await readB()).toEqual(before);
          await notifyFlowRunActorOfCompletion({
            organizationId: a.organizationId,
            workspaceId: a.workspaceId,
            runId: a.runId,
            flowName: "Review fixture",
            run: {
              definitionId: null,
              triggerSource: { type: "manual", userId: a.userId },
            },
          });
          expect(await readB()).toEqual(before);
          expect(
            await db.$count(
              notifications,
              eq(notifications.organizationId, a.organizationId),
            ),
          ).toBe(0);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("feature grant facade retains other organizations' flow grant sources", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        const aDefinitionId = createSafeId<"flowDefinition">();
        const bDefinitionId = createSafeId<"flowDefinition">();
        try {
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: b.organizationId,
            userId: a.userId,
            role: "member",
            createdAt: new Date(),
          });
          await db
            .insert(workspaceMembers)
            .values({ workspaceId: b.workspaceId, userId: a.userId });
          await db.insert(featureEnrolments).values([
            {
              organizationId: b.organizationId,
              userId: a.userId,
              featureId: "flows",
            },
            {
              organizationId: b.organizationId,
              userId: a.userId,
              featureId: "signals",
            },
          ]);
          await db
            .update(flowRuns)
            .set({ triggerSource: { type: "manual", userId: a.userId } })
            .where(eq(flowRuns.id, b.runId));
          await db.insert(flowDefinitions).values([
            {
              id: aDefinitionId,
              organizationId: a.organizationId,
              createdByUserId: a.userId,
              name: "Grant source",
              steps: [],
              trigger: {
                type: "file-upload",
                workspaceIds: null,
                fileExtensions: null,
              },
            },
            {
              id: bDefinitionId,
              organizationId: b.organizationId,
              createdByUserId: a.userId,
              name: "Grant source",
              steps: [],
              trigger: {
                type: "file-upload",
                workspaceIds: null,
                fileExtensions: null,
              },
            },
          ]);
          await withOrgScopedFixture({
            database: db,
            workspaceId: a.workspaceId,
            fn: async (tx) =>
              await tx.insert(flowUploadTriggerIntents).values({
                definitionId: aDefinitionId,
                entityId: a.taskEntityId,
                organizationId: a.organizationId,
                workspaceId: a.workspaceId,
                status: "awaiting_grant",
              }),
          });
          await withOrgScopedFixture({
            database: db,
            workspaceId: b.workspaceId,
            fn: async (tx) =>
              await tx.insert(flowUploadTriggerIntents).values({
                definitionId: bDefinitionId,
                entityId: b.taskEntityId,
                organizationId: b.organizationId,
                workspaceId: b.workspaceId,
                status: "awaiting_grant",
              }),
          });
          const readB = async () => ({
            source: await b.read(),
            receipts: await db
              .select()
              .from(flowUploadTriggerIntents)
              .where(
                eq(flowUploadTriggerIntents.organizationId, b.organizationId),
              )
              .orderBy(flowUploadTriggerIntents.entityId),
            grants: await db
              .select()
              .from(featureEnrolments)
              .where(
                and(
                  eq(featureEnrolments.organizationId, b.organizationId),
                  eq(featureEnrolments.userId, a.userId),
                ),
              )
              .orderBy(featureEnrolments.featureId),
            notices: await db
              .select()
              .from(notifications)
              .where(eq(notifications.organizationId, b.organizationId))
              .orderBy(notifications.id),
          });
          const before = await readB();
          expect(
            before.grants.map(({ featureId }) => featureId).toSorted(),
          ).toEqual(["flows", "signals"]);
          await resumeFeatureAfterGrant({
            organizationId: a.organizationId,
            userId: a.userId,
            featureId: "flows",
          });
          expect(await readB()).toEqual(before);
          expect(
            (
              await db
                .select()
                .from(flowUploadTriggerIntents)
                .where(
                  and(
                    eq(flowUploadTriggerIntents.definitionId, aDefinitionId),
                    eq(flowUploadTriggerIntents.entityId, a.taskEntityId),
                  ),
                )
                .limit(1)
            ).at(0)?.status,
          ).toBe("pending");
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("realtime workspace facade retains other organizations' recipient admission", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, { intermediate: false });
        const b = await flowReviewGateFixture(db, { intermediate: false });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          await db.insert(member).values({
            id: mintAuthProviderIdValue(),
            organizationId: b.organizationId,
            userId: a.userId,
            role: "member",
            createdAt: new Date(),
          });
          await db
            .insert(workspaceMembers)
            .values({ workspaceId: b.workspaceId, userId: a.userId });
          await db.insert(featureEnrolments).values({
            organizationId: b.organizationId,
            userId: a.userId,
            featureId: "flows",
          });
          const before = await b.read();
          const delivered = new Set<string>();
          await realtimeAuthorizers.workspaceEvent({
            organizationId: a.organizationId,
            workspaceId: b.workspaceId,
            userIds: [a.userId],
            event: flowRunUpdateRealtimeEvent({
              runId: b.runId,
              status: "awaiting_review",
              currentStepIndex: 0,
              steps: [],
            }).toJSON(),
            deliver: (recipients) => {
              for (const recipient of recipients) {
                delivered.add(recipient);
              }
            },
          });
          expect(delivered).toEqual(new Set());
          expect(await b.read()).toEqual(before);
          await realtimeAuthorizers.workspaceEvent({
            organizationId: a.organizationId,
            workspaceId: a.workspaceId,
            userIds: [a.userId],
            event: flowRunUpdateRealtimeEvent({
              runId: a.runId,
              status: "awaiting_review",
              currentStepIndex: 0,
              steps: [],
            }).toJSON(),
            deliver: (recipients) => {
              for (const recipient of recipients) {
                delivered.add(recipient);
              }
            },
          });
          expect(delivered).toEqual(new Set([a.userId]));
          expect(await b.read()).toEqual(before);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("executor retains other organizations' source state during review admission", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const b = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          const before = await b.read();
          const localBefore = await a.read();
          expect(localBefore.run?.status).toBe("pending");
          expect(localBefore.steps.at(0)?.reviewTaskEntityId).toBe(
            a.taskEntityId,
          );
          const broadcasts: {
            workspaceId: string;
            runId: string;
            status: string;
          }[] = [];
          expect(
            await executeFlowStep(
              { runId: a.runId, stepIndex: 0 },
              new AbortController().signal,
              {
                database: db,
                admission: null,
                broadcastUpdate: (workspaceId, payload) => {
                  broadcasts.push({
                    workspaceId,
                    runId: payload.runId,
                    status: payload.status,
                  });
                },
                flushSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
              },
            ),
          ).toEqual({ status: "completed" });
          const after = await a.read();
          expect(after.run?.status).toBe("awaiting_review");
          expect(after.steps.at(0)?.status).toBe("awaiting_review");
          expect(after.steps.at(0)?.startedAt).toBeInstanceOf(Date);
          expect(after.steps.at(0)?.reviewTaskEntityId).toBe(a.taskEntityId);
          expect(after.task).toEqual(localBefore.task);
          expect(broadcasts).toEqual([
            { workspaceId: a.workspaceId, runId: a.runId, status: "running" },
            {
              workspaceId: a.workspaceId,
              runId: a.runId,
              status: "awaiting_review",
            },
          ]);
          expect(await b.read()).toEqual(before);
          expect(
            await db.$count(
              notifications,
              eq(notifications.organizationId, b.organizationId),
            ),
          ).toBe(0);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });

    test("executor failure recovery retains other organizations' source state", async () => {
      await withGatedTestClients(databaseUrl(), async ({ openClient }) => {
        const { db } = openClient();
        const a = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const b = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        const restoreRuntime = setRuntimeModeForTesting({
          mode: RUNTIME_MODE.strict,
        });
        testState.setConfig("FEATURE_FLOWS", true);
        try {
          const before = await b.read();
          expect((await a.read()).run?.status).toBe("pending");
          await db.delete(user).where(eq(user.id, a.userId));
          const broadcasts: { workspaceId: string; runId: string }[] = [];
          expect(
            await failFlowRunFromWorker(
              { runId: a.runId, stepIndex: 0 },
              new FlowStepError({ message: "Fixture step unavailable" }),
              {
                database: db,
                broadcastUpdate: (workspaceId, payload) => {
                  broadcasts.push({ workspaceId, runId: payload.runId });
                },
              },
            ),
          ).toEqual({ status: "completed" });
          const after = await a.read();
          expect(after.run?.status).toBe("failed");
          expect(after.run?.recoveryState).toBe("actor-removed");
          expect(after.steps.at(0)?.status).toBe("failed");
          expect(after.steps.at(0)?.error).toBe("actor-removed");
          expect(broadcasts).toEqual([]);
          expect(await b.read()).toEqual(before);
          expect(
            await db.$count(
              notifications,
              eq(notifications.organizationId, b.organizationId),
            ),
          ).toBe(0);
        } finally {
          restoreRuntime();
          await b.cleanup();
          await a.cleanup();
        }
      });
    });
  },
);
