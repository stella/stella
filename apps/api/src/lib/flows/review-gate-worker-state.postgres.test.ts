import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import {
  parseWorkspaceRealtimeEvent,
  REALTIME_EVENT_TYPE,
  RESOURCE_TYPE,
} from "@stll/api-contract";
import { createTestClock, settledWithin } from "@stll/test-kit";

import { session } from "@/api/db/auth-schema";
import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { entities, flowRuns, flowRunSteps } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createDatabase } from "@/api/db/sql-client";
import { realtimeAuthorizers } from "@/api/lib/auth";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";
import {
  executeFlowStep,
  failFlowRunFromWorker,
} from "@/api/lib/flows/flow-executor";
import { broadcastFlowRunUpdate } from "@/api/lib/flows/flow-run-events";
import { startSse, stopSse, subscribe } from "@/api/lib/sse";
import { createSseBroadcastPublisher } from "@/api/lib/sse-broadcast";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { flowReviewGateFixture } from "@/api/tests/helpers/flow-review-gate";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";
import { HAPPY_PATH_TIMEOUT_MS } from "@/api/tests/test-timeouts";

const stateClock = createTestClock();

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const PHASES = ["start", "complete", "pause", "fail"] as const;

const backendPid = async (db: GatedTestDb) => {
  const rows = await db.execute<{ pid: number }>(
    sql`select pg_backend_pid() as pid`,
  );
  const pid = rows.at(0)?.pid;
  if (pid === undefined) {
    throw new Error("Expected the database session PID");
  }
  return pid;
};

const settleLaunched = async (launched: Promise<unknown>[]) => {
  const results = await Promise.allSettled(launched);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") {
    throw failure.reason;
  }
};

type PausedWorkerOptions = {
  db: GatedTestDb;
  f: Awaited<ReturnType<typeof flowReviewGateFixture>>;
  phase: (typeof PHASES)[number];
};

const pausedWorker = async ({ db, f, phase }: PausedWorkerOptions) => {
  if (phase === "complete") {
    await db
      .update(flowRuns)
      .set({
        definitionSnapshot: {
          name: "Worker flow",
          steps: [
            {
              kind: "ai",
              name: "Generate",
              prompt: "Generate a result",
              includeDocuments: false,
            },
            {
              kind: "review-gate",
              name: "Review",
              instructions: "Review output",
            },
          ],
        },
      })
      .where(eq(flowRuns.id, f.runId));
    await db
      .update(flowRunSteps)
      .set({ kind: "ai" })
      .where(eq(flowRunSteps.reviewTaskEntityId, f.taskEntityId));
  }
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const scoped = createScopedDb(
    markRlsDatabase(db),
    [f.workspaceId],
    f.organizationId,
    f.userId,
  );
  let transactions = 0;
  const dependencies = {
    admission: testModelAdmission(f.organizationId),
    database: db,
    makeScopedDb:
      () =>
      async <T>(work: (tx: Transaction) => Promise<T>) => {
        transactions += 1;
        if (
          ((phase === "start" || phase === "fail") && transactions === 1) ||
          (phase === "pause" && transactions === 2)
        ) {
          reached.resolve(undefined);
          await release.promise;
        }
        return await scoped(work);
      },
    makeSafeDb: () => f.safeDb(db),
    broadcastUpdate: () => undefined,
    enqueueStep: async () => undefined,
    generateTextForTask: async () => {
      reached.resolve(undefined);
      await release.promise;
      return "A generated result";
    },
    loadAIConfig: async () => Result.ok(null),
    taskFeatures: { governedWorkflow: true, legalLists: false },
  } satisfies Parameters<typeof executeFlowStep>[2];
  const job = { runId: f.runId, stepIndex: 0 };
  const running =
    phase === "fail"
      ? failFlowRunFromWorker(job, new Error("Worker stopped"), dependencies)
      : executeFlowStep(job, new AbortController().signal, dependencies);
  await Promise.race([
    reached.promise,
    running.then(() => {
      throw new Error("Worker missed its phase barrier");
    }),
  ]);
  return { running, release: () => release.resolve(undefined) };
};

type GateFixture = Awaited<ReturnType<typeof flowReviewGateFixture>>;

/** Real SSE delivery/database authorization; only Redis is a fixture. */
const observeGateResources = async (db: GatedTestDb, f: GateFixture) => {
  const sessionId = mintAuthProviderIdValue();
  await db.insert(session).values({
    id: sessionId,
    token: `review-stream-${sessionId}`,
    userId: f.userId,
    activeOrganizationId: f.organizationId,
    // A long-lived fixture for delivery authorization, not an expiry test.
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  const abort = new AbortController();
  try {
    startSse(realtimeAuthorizers, {
      createClient: () => ({
        connected: false,
        close: () => undefined,
        onReconnect: () => () => undefined,
        subscribe: async () => 0,
      }),
      publisher: createSseBroadcastPublisher({
        createClient: () => ({
          connect: async () => undefined,
          close: () => undefined,
          onClose: () => () => undefined,
          publish: async () => 0,
        }),
      }),
    });
    const reader = subscribe({
      organizationId: f.organizationId,
      userId: f.userId,
      sessionId,
      workspaceId: f.workspaceId,
      signal: abort.signal,
    }).getReader();
    const entityIds: string[] = [];
    const progressStatuses: string[] = [];
    let barrier = Promise.withResolvers<undefined>();
    const watching = Result.tryPromise({
      try: async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            return;
          }
          const data = new TextDecoder()
            .decode(chunk.value)
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!data) {
            continue;
          }
          const event = parseWorkspaceRealtimeEvent(JSON.parse(data.slice(6)));
          expect(event).not.toBeNull();
          if (
            event?.type === REALTIME_EVENT_TYPE.RESOURCE_UPDATED &&
            event.resource.type === RESOURCE_TYPE.ENTITY
          ) {
            entityIds.push(event.resource.id);
          }
          if (event?.type === REALTIME_EVENT_TYPE.FLOW_RUN_UPDATE) {
            if (event.data.steps.length === 0) {
              barrier.resolve(undefined);
            } else {
              progressStatuses.push(event.data.status);
            }
          }
        }
      },
      catch: (cause) => cause,
    });
    return {
      entityIds,
      progressStatuses,
      // The valid empty-progress marker drains ordered workspace delivery.
      flush: async () => {
        barrier = Promise.withResolvers<undefined>();
        broadcastFlowRunUpdate(f.workspaceId, {
          runId: f.runId,
          status: "running",
          currentStepIndex: 0,
          steps: [],
        });
        await settledWithin(
          Promise.race([
            barrier.promise,
            watching.then((outcome) => {
              if (outcome.isErr()) {
                throw outcome.error;
              }
              throw new Error("Review stream closed before its marker");
            }),
          ]),
          {
            description: "review stream delivery barrier",
            timeoutMs: HAPPY_PATH_TIMEOUT_MS,
          },
        );
      },
      close: async () => {
        try {
          abort.abort();
          const outcome = await watching;
          if (outcome.isErr()) {
            throw outcome.error;
          }
        } finally {
          try {
            reader.releaseLock();
          } finally {
            try {
              stopSse();
            } finally {
              await db.transaction(
                async (tx) =>
                  await revokeOrganizationMemberAuthArtifacts(tx, {
                    organizationId: f.organizationId,
                    userId: f.userId,
                  }),
              );
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      abort.abort();
    } finally {
      try {
        stopSse();
      } finally {
        await db.transaction(
          async (tx) =>
            await revokeOrganizationMemberAuthArtifacts(tx, {
              organizationId: f.organizationId,
              userId: f.userId,
            }),
        );
      }
    }
    throw error;
  }
};

if (!databaseUrl || !enabled) {
  describe.skip("worker review gate state (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("worker review gate state (postgres)", () => {
    for (const phase of PHASES) {
      for (const first of ["worker", "cancel"] as const) {
        test(`${phase}: ${first} commits first while the other session waits`, async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const { db, sql: observer } = openClient();
            const workerClient = openClient();
            const cancelClient = openClient();
            const blockerClient = openClient();
            const f = await flowReviewGateFixture(db, {
              intermediate: phase === "complete",
              governed: true,
              initialRunStatus: "pending",
            });
            const workerPid = await backendPid(workerClient.db);
            const cancelPid = await backendPid(cancelClient.db);
            const blockerPid = await backendPid(blockerClient.db);
            const launched: Promise<unknown>[] = [];
            const targetReached = Promise.withResolvers<undefined>();
            const permitTarget = Promise.withResolvers<undefined>();
            const blockerHeld = Promise.withResolvers<undefined>();
            const releaseBlocker = Promise.withResolvers<undefined>();
            const cancelWritten = Promise.withResolvers<undefined>();
            const releaseCancel = Promise.withResolvers<undefined>();
            const target = phase === "start" || phase === "fail" ? 1 : 2;
            let stepReads = 0;
            const phaseReadRequested = Promise.withResolvers<undefined>();
            const workerDb = createDatabase({
              client: workerClient.sql,
              relations: databaseRelations,
              logger: {
                logQuery: (query) => {
                  if (
                    query.startsWith("select") &&
                    query.includes('from "flow_run_steps"') &&
                    query.includes("for update")
                  ) {
                    stepReads += 1;
                    if (stepReads === target) {
                      phaseReadRequested.resolve(undefined);
                    }
                  }
                },
              },
            });
            const scoped = createScopedDb(
              markRlsDatabase(workerDb),
              [f.workspaceId],
              f.organizationId,
              f.userId,
            );
            // Gate only the transaction owning the selected writer. For the AI
            // completion case the provider stub is the pre-completion barrier.
            let transactions = 0;
            const makeScopedDb =
              () =>
              async <T>(work: (tx: Transaction) => Promise<T>) => {
                transactions += 1;
                if (
                  ((phase === "start" || phase === "fail") &&
                    transactions === 1) ||
                  (phase === "pause" && transactions === 2)
                ) {
                  targetReached.resolve(undefined);
                  await permitTarget.promise;
                }
                return await scoped(work);
              };
            const dependencies = {
              admission: testModelAdmission(f.organizationId),
              database: workerDb,
              makeScopedDb,
              makeSafeDb: () => f.safeDb(workerDb),
              broadcastUpdate: () => undefined,
              enqueueStep: async () => undefined,
              generateTextForTask: async () => {
                targetReached.resolve(undefined);
                await permitTarget.promise;
                return "A generated result";
              },
              loadAIConfig: async () => Result.ok(null),
              taskFeatures: { governedWorkflow: true, legalLists: false },
            } satisfies Parameters<typeof executeFlowStep>[2];
            const ordinaryCancelDb = f.safeDb(cancelClient.db);
            const gatedCancelDb: SafeDb = async (work, retry) =>
              await ordinaryCancelDb(async (tx) => {
                const value = await work(tx);
                if (
                  typeof value === "object" &&
                  value !== null &&
                  "steps" in value
                ) {
                  cancelWritten.resolve(undefined);
                  await releaseCancel.promise;
                }
                return value;
              }, retry);
            try {
              if (phase === "complete") {
                await db
                  .update(flowRuns)
                  .set({
                    definitionSnapshot: {
                      name: "Worker flow",
                      steps: [
                        {
                          kind: "ai",
                          name: "Generate",
                          prompt: "Generate a result",
                          includeDocuments: false,
                        },
                        {
                          kind: "review-gate",
                          name: "Review",
                          instructions: "Review output",
                        },
                      ],
                    },
                  })
                  .where(eq(flowRuns.id, f.runId));
                await db
                  .update(flowRunSteps)
                  .set({ kind: "ai" })
                  .where(eq(flowRunSteps.reviewTaskEntityId, f.taskEntityId));
              }
              const job = { runId: f.runId, stepIndex: 0 };
              const worker =
                phase === "fail"
                  ? failFlowRunFromWorker(
                      job,
                      new Error("Worker stopped"),
                      dependencies,
                    )
                  : executeFlowStep(
                      job,
                      new AbortController().signal,
                      dependencies,
                    );
              launched.push(worker);
              await Promise.race([
                targetReached.promise,
                worker.then(() => {
                  throw new Error("Worker missed its phase barrier");
                }),
              ]);
              if (first === "cancel") {
                const cancel = f.act(gatedCancelDb, "cancel");
                launched.push(cancel);
                await Promise.race([
                  cancelWritten.promise,
                  cancel.then(() => {
                    throw new Error("Cancel missed its commit barrier");
                  }),
                ]);
                permitTarget.resolve(undefined);
                await waitForBlockedPid(observer, {
                  waitingPid: workerPid,
                  holdingPid: cancelPid,
                });
                releaseCancel.resolve(undefined);
                expect((await cancel).isOk()).toBe(true);
                await worker;
                const state = await f.read();
                expect(state.run?.status).toBe("cancelled");
                expect(
                  state.steps.every((step) => step.status === "skipped"),
                ).toBe(true);
              } else {
                const holding = blockerClient.db.transaction(async (tx) => {
                  await tx
                    .select()
                    .from(flowRunSteps)
                    .where(eq(flowRunSteps.runId, f.runId))
                    .for("update");
                  blockerHeld.resolve(undefined);
                  await releaseBlocker.promise;
                });
                launched.push(holding);
                await blockerHeld.promise;
                permitTarget.resolve(undefined);
                await phaseReadRequested.promise;
                await waitForBlockedPid(observer, {
                  waitingPid: workerPid,
                  holdingPid: blockerPid,
                });
                const cancel = f.act(ordinaryCancelDb, "cancel");
                launched.push(cancel);
                // The worker has re-read and locked the run, and is waiting on
                // the step row before it can write. Removing the run lock lets
                // cancel bypass it, so this assertion fails for every writer.
                await waitForBlockedPid(observer, {
                  waitingPid: cancelPid,
                  holdingPid: workerPid,
                });
                releaseBlocker.resolve(undefined);
                await holding;
                await worker;
                const result = await cancel;
                if (phase === "fail") {
                  expect(result.isErr()).toBe(true);
                  if (result.isErr()) {
                    expect(result.error).toMatchObject({ status: 409 });
                  }
                  expect((await f.read()).run?.status).toBe("failed");
                } else {
                  expect(result.isOk()).toBe(true);
                  expect((await f.read()).run?.status).toBe("cancelled");
                }
              }
            } finally {
              permitTarget.resolve(undefined);
              releaseBlocker.resolve(undefined);
              releaseCancel.resolve(undefined);
              try {
                await settleLaunched(launched);
              } finally {
                await f.cleanup();
              }
            }
          });
        });
      }
    }
    for (const phase of PHASES) {
      for (const first of ["worker", "approve"] as const) {
        test(`${phase}: stale worker and approval serialize with ${first} first`, async () => {
          await withGatedTestClients(databaseUrl, async ({ openClient }) => {
            const { db, sql: observer } = openClient();
            const workerClient = openClient();
            const approveClient = openClient();
            const blockerClient = openClient();
            const f = await flowReviewGateFixture(db, {
              intermediate: phase === "complete",
              governed: true,
              initialRunStatus: "pending",
            });
            const workerPid = await backendPid(workerClient.db);
            const approvePid = await backendPid(approveClient.db);
            const blockerPid = await backendPid(blockerClient.db);
            const worker = await pausedWorker({
              db: workerClient.db,
              f,
              phase,
            });
            const launched: Promise<unknown>[] = [worker.running];
            const held = Promise.withResolvers<undefined>();
            const release = Promise.withResolvers<undefined>();
            const written = Promise.withResolvers<undefined>();
            const releaseApprove = Promise.withResolvers<undefined>();
            const ordinary = f.safeDb(approveClient.db);
            const gated: SafeDb = async (work, retry) =>
              await ordinary(async (tx) => {
                const value = await work(tx);
                if (
                  typeof value === "object" &&
                  value !== null &&
                  "nextStatus" in value
                ) {
                  written.resolve(undefined);
                  await releaseApprove.promise;
                }
                return value;
              }, retry);
            try {
              await db
                .update(flowRuns)
                .set({
                  status: "running",
                  startedAt: new Date(stateClock.now()),
                })
                .where(eq(flowRuns.id, f.runId));
              await db
                .update(flowRunSteps)
                .set({
                  status: "running",
                  startedAt: new Date(stateClock.now()),
                })
                .where(eq(flowRunSteps.reviewTaskEntityId, f.taskEntityId));
              // Another delivery reached a gate while this worker held its
              // earlier snapshot. AI completion is now behind the next gate;
              // the other writers are duplicate work on the same gate.
              if (phase === "complete") {
                await db
                  .update(flowRunSteps)
                  .set({
                    status: "completed",
                    finishedAt: new Date(stateClock.now()),
                    reviewTaskEntityId: null,
                  })
                  .where(eq(flowRunSteps.reviewTaskEntityId, f.taskEntityId));
                const next = (await f.read()).steps.at(1);
                if (!next) {
                  throw new Error("Expected the subsequent review gate");
                }
                await db
                  .update(flowRunSteps)
                  .set({
                    status: "running",
                    startedAt: new Date(stateClock.now()),
                  })
                  .where(eq(flowRunSteps.id, next.id));
                await db
                  .update(flowRunSteps)
                  .set({
                    status: "awaiting_review",
                    reviewTaskEntityId: f.taskEntityId,
                  })
                  .where(eq(flowRunSteps.id, next.id));
                await db
                  .update(flowRuns)
                  .set({ status: "awaiting_review", currentStepIndex: 1 })
                  .where(eq(flowRuns.id, f.runId));
              } else {
                await db
                  .update(flowRuns)
                  .set({ status: "awaiting_review" })
                  .where(eq(flowRuns.id, f.runId));
                await db
                  .update(flowRunSteps)
                  .set({
                    status: "awaiting_review",
                    startedAt: new Date(stateClock.now()),
                  })
                  .where(eq(flowRunSteps.runId, f.runId));
              }
              if (first === "approve") {
                const approving = f.act(gated, "approved");
                launched.push(approving);
                await Promise.race([
                  written.promise,
                  approving.then(() => {
                    throw new Error("Approval missed its commit barrier");
                  }),
                ]);
                worker.release();
                await waitForBlockedPid(observer, {
                  waitingPid: workerPid,
                  holdingPid: approvePid,
                });
                releaseApprove.resolve(undefined);
                expect((await approving).isOk()).toBe(true);
                await worker.running;
              } else {
                const holding = blockerClient.db.transaction(async (tx) => {
                  await tx
                    .select()
                    .from(flowRunSteps)
                    .where(eq(flowRunSteps.runId, f.runId))
                    .for("update");
                  held.resolve(undefined);
                  await release.promise;
                });
                launched.push(holding);
                await held.promise;
                worker.release();
                await waitForBlockedPid(observer, {
                  waitingPid: workerPid,
                  holdingPid: blockerPid,
                });
                const approving = f.act(ordinary, "approved");
                launched.push(approving);
                await waitForBlockedPid(observer, {
                  waitingPid: approvePid,
                  holdingPid: workerPid,
                });
                release.resolve(undefined);
                await holding;
                await worker.running;
                expect((await approving).isOk()).toBe(true);
              }
              const state = await f.read();
              expect(state.run?.status).toBe("completed");
              expect(state.task?.status).toBe("done");
              expect(state.obligation?.status).toBe("completed");
              expect(
                state.steps.at(phase === "complete" ? 1 : 0)?.output,
              ).toEqual({
                kind: "review-gate",
                decision: "approved",
                userId: f.userId,
                note: "approved:0",
              });
            } finally {
              worker.release();
              release.resolve(undefined);
              releaseApprove.resolve(undefined);
              try {
                await settleLaunched(launched);
              } finally {
                await f.cleanup();
              }
            }
          });
        });
      }
      test(`${phase}: deletion after a worker snapshot quietly ends the job`, async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db } = openClient();
          const f = await flowReviewGateFixture(db, {
            intermediate: phase === "complete",
            governed: true,
            initialRunStatus: "pending",
          });
          const worker = await pausedWorker({ db, f, phase });
          try {
            await db.delete(flowRuns).where(eq(flowRuns.id, f.runId));
            worker.release();
            await worker.running;
            const state = await f.read();
            expect(state.run).toBeUndefined();
            expect(state.steps).toEqual([]);
            expect(state.task?.status).toBe("open");
          } finally {
            worker.release();
            try {
              await worker.running;
            } finally {
              await f.cleanup();
            }
          }
        });
      });
    }
  });
}

if (enabled && databaseUrl) {
  for (const scenario of ["commit", "rollback", "reuse"] as const) {
    test(`review task ENTITY delivery follows ${scenario} transaction outcome`, async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const workerDb = openClient().db;
        const f = await flowReviewGateFixture(db, {
          intermediate: false,
          initialRunStatus: "pending",
        });
        let stream:
          Awaited<ReturnType<typeof observeGateResources>> | undefined;
        const reached = Promise.withResolvers<typeof f.taskEntityId>();
        const release = Promise.withResolvers<undefined>();
        const scoped = createScopedDb(
          markRlsDatabase(workerDb),
          [f.workspaceId],
          f.organizationId,
          f.userId,
        );
        let transactions = 0;
        let worker:
          | Promise<{ type: "ok" } | { type: "error"; cause: unknown }>
          | undefined;
        try {
          stream = await observeGateResources(db, f);
          if (scenario !== "reuse") {
            await db
              .update(flowRunSteps)
              .set({ reviewTaskEntityId: null })
              .where(eq(flowRunSteps.runId, f.runId));
          }
          worker = executeFlowStep(
            { runId: f.runId, stepIndex: 0 },
            new AbortController().signal,
            {
              admission: testModelAdmission(f.organizationId),
              database: workerDb,
              makeSafeDb: () => f.safeDb(workerDb),
              makeScopedDb:
                () =>
                async <T>(work: (tx: Transaction) => Promise<T>) => {
                  transactions += 1;
                  const hold = transactions === 2;
                  return await scoped(async (tx) => {
                    const value = await work(tx);
                    if (hold) {
                      const [step] = await tx
                        .select({ entityId: flowRunSteps.reviewTaskEntityId })
                        .from(flowRunSteps)
                        .where(eq(flowRunSteps.runId, f.runId));
                      if (!step?.entityId) {
                        throw new Error(
                          "Review task missing at commit barrier",
                        );
                      }
                      reached.resolve(step.entityId);
                      await release.promise;
                      if (scenario === "rollback") {
                        tx.rollback();
                      }
                    }
                    return value;
                  });
                },
              enqueueStep: async () => undefined,
              flushSearchRepairs: async () => ({ failed: 0, repaired: 0 }),
              taskFeatures: { governedWorkflow: false, legalLists: false },
            },
          ).then(
            () => ({ type: "ok" as const }),
            (error: unknown) => ({ type: "error" as const, cause: error }),
          );
          const entityId = await settledWithin(
            Promise.race([
              reached.promise,
              worker.then(() => {
                throw new Error("Worker finished before task commit barrier");
              }),
            ]),
            {
              description: "review task transaction barrier",
              timeoutMs: HAPPY_PATH_TIMEOUT_MS,
            },
          );
          await stream.flush();
          expect(stream.entityIds).toEqual([]);
          const before = await db
            .select({ id: entities.id })
            .from(entities)
            .where(eq(entities.id, entityId));
          expect(before.length).toBe(scenario === "reuse" ? 1 : 0);
          release.resolve(undefined);
          const outcome = await worker;
          expect(outcome.type).toBe(scenario === "rollback" ? "error" : "ok");
          await stream.flush();
          expect(stream.entityIds).toEqual(
            scenario === "commit" ? [entityId] : [],
          );
          expect(stream.progressStatuses.includes("awaiting_review")).toBe(
            scenario !== "rollback",
          );
          const after = await db
            .select({ id: entities.id })
            .from(entities)
            .where(eq(entities.id, entityId));
          expect(after.length).toBe(scenario === "rollback" ? 0 : 1);
        } finally {
          release.resolve(undefined);
          if (worker) {
            await worker;
          }
          try {
            if (stream) {
              await stream.close();
            }
          } finally {
            await f.cleanup();
          }
        }
      });
    });
  }
}
