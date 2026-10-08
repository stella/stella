/**
 * Boot-time orphan reconciler: after a restart that lost queued step jobs, every
 * pending/running run must be re-enqueued, not just the first batch. Driven
 * against a real (PGlite) database with a small batch size so the keyset
 * pagination's multi-batch path is exercised without seeding thousands of rows.
 */

import { panic } from "better-result";
import { Queue } from "bullmq";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { NOTIFICATION_ENTITY_TYPE } from "@stll/api-contract/notifications";
import { withTimeout } from "@stll/concurrency/with-timeout";
import { RUNTIME_MODE } from "@stll/runtime-mode";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  featureEnrolments,
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  notifications,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { BullMqWorker } from "@/api/lib/bullmq-queue";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import {
  fileFlowRunCompletionNotice,
  resolveActorUserId,
} from "@/api/lib/flows/flow-run-actor";
import {
  enqueueFlowStep,
  FLOW_RUN_QUEUE_NAME,
  FLOW_STEP_JOB_OPTIONS,
} from "@/api/lib/flows/flow-run-queue";
import type { FlowStepJobData } from "@/api/lib/flows/flow-run-queue";
import { reconcileOrphanedFlowRuns } from "@/api/lib/flows/flow-run-worker";
import type {
  FlowDefinitionSnapshot,
  FlowStep,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import { createBullMqConnection } from "@/api/lib/redis-client";
import { setRuntimeModeForTesting } from "@/api/runtime-mode";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const testDb: TestDatabase = await getTestDb();

const enqueuedRunIds: string[] = [];

const reconcileDependencies = asTestRaw<
  NonNullable<Parameters<typeof reconcileOrphanedFlowRuns>[1]>
>({
  database: testDb,
  enqueueStep: async ({ runId }: { runId: SafeId<"flowRun"> }) => {
    enqueuedRunIds.push(runId);
  },
});

const SNAPSHOT: FlowDefinitionSnapshot = {
  name: "Reconcile test flow",
  steps: [
    {
      kind: "ai",
      name: "Draft",
      prompt: "Draft.",
      includeDocuments: false,
    } satisfies FlowStep,
  ],
};

describe("reconcileOrphanedFlowRuns", () => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const userId = mintAuthProviderId<"user">();
  const historicalCompletedRunId = createSafeId<"flowRun">();
  const nonTerminalRunIds: SafeId<"flowRun">[] = [];
  const stalledRunIds: SafeId<"flowRun">[] = [];
  const STALL_WINDOW_MS = 15 * 60 * 1000;
  const STALLED_AT = new Date(Date.now() - 60 * 60 * 1000);

  beforeAll(async () => {
    await testDb.insert(organization).values({
      id: organizationId,
      name: "Reconcile Org",
      slug: `reconcile-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: userId,
      name: "Flow actor",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
    await testDb
      .insert(featureEnrolments)
      .values({ featureId: "flows", organizationId, userId });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Reconcile matter",
      reference: "RECONCILE",
    });

    const triggerSource: FlowTriggerSource = { type: "manual", userId };
    // Five non-terminal runs (more than the batchSize below, so recovery must
    // cross batch boundaries) plus ordinary terminal history with no delivery work.
    const rows = [
      { status: "pending" as const },
      { status: "running" as const },
      { status: "pending" as const },
      { status: "running" as const },
      { status: "pending" as const },
    ].map((row) => {
      const id = createSafeId<"flowRun">();
      nonTerminalRunIds.push(id);
      stalledRunIds.push(id);
      return {
        id,
        workspaceId,
        definitionSnapshot: SNAPSHOT,
        triggerSource,
        status: row.status,
        currentStepIndex: 0,
        createdAt: STALLED_AT,
      };
    });
    await testDb.insert(flowRuns).values(rows);

    // Just started: the standing sweep must leave it to the queue.
    const freshRunId = createSafeId<"flowRun">();
    nonTerminalRunIds.push(freshRunId);
    await testDb.insert(flowRuns).values({
      id: freshRunId,
      workspaceId,
      definitionSnapshot: SNAPSHOT,
      triggerSource,
      status: "running",
      currentStepIndex: 0,
      startedAt: new Date(),
    });
    await testDb.insert(flowRuns).values({
      id: historicalCompletedRunId,
      workspaceId,
      definitionSnapshot: SNAPSHOT,
      triggerSource,
      status: "completed",
      currentStepIndex: 0,
    });
  });

  beforeEach(() => {
    enqueuedRunIds.length = 0;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  test("re-enqueues every pending/running run across batch boundaries", async () => {
    await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);

    expect(enqueuedRunIds.toSorted()).toEqual(
      [...nonTerminalRunIds].toSorted(),
    );
    expect(
      await testDb.$count(
        notifications,
        eq(notifications.entityId, historicalCompletedRunId),
      ),
    ).toBe(0);
    expect(
      await testDb.query.flowRuns.findFirst({
        where: { id: { eq: historicalCompletedRunId } },
        columns: { status: true, recoveryState: true },
      }),
    ).toEqual({ status: "completed", recoveryState: null });
  });

  test("a completion notice waits for a live actor grant and is recovered once", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    const runId = createSafeId<"flowRun">();
    const triggerSource = { type: "schedule" } as const;
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: SNAPSHOT.name,
      steps: SNAPSHOT.steps,
      trigger: {
        type: "schedule",
        workspaceId,
        schedule: { frequency: "daily", hourUtc: 0 },
      },
      createdByUserId: userId,
    });
    await testDb.insert(flowRuns).values({
      id: runId,
      workspaceId,
      definitionId,
      definitionSnapshot: SNAPSHOT,
      triggerSource,
      status: "completed",
      currentStepIndex: 0,
    });
    const notice = {
      run: { definitionId, triggerSource },
      organizationId,
      workspaceId,
      runId,
      flowName: SNAPSHOT.name,
    };
    const noticeWhere = and(
      eq(notifications.userId, userId),
      eq(notifications.idempotencyKey, `flow-run-completed:${runId}`),
    );
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    try {
      // The earlier actor lookup cannot authorize a later notification write.
      expect(
        await resolveActorUserId(
          notice.run,
          asTestRaw<Parameters<typeof resolveActorUserId>[1]>(testDb),
        ),
      ).toBe(userId);
      await testDb
        .delete(featureEnrolments)
        .where(
          and(
            eq(featureEnrolments.organizationId, organizationId),
            eq(featureEnrolments.userId, userId),
            eq(featureEnrolments.featureId, "flows"),
          ),
        );
      await fileFlowRunCompletionNotice(notice, reconcileDependencies.database);
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { status: true, recoveryState: true },
        }),
      ).toEqual({
        status: "completed",
        recoveryState: "completion-notice-pending",
      });
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      expect(await testDb.$count(notifications, noticeWhere)).toBe(0);
      expect(enqueuedRunIds).not.toContain(runId);

      await testDb.insert(featureEnrolments).values({
        featureId: "flows",
        organizationId,
        userId,
      });
      await reconcileOrphanedFlowRuns(
        { batchSize: 2, principal: { organizationId, userId } },
        reconcileDependencies,
      );
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      await fileFlowRunCompletionNotice(notice, reconcileDependencies.database);
      expect(await testDb.$count(notifications, noticeWhere)).toBe(1);
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { status: true, recoveryState: true },
        }),
      ).toEqual({ status: "completed", recoveryState: null });
      expect(enqueuedRunIds).not.toContain(runId);
    } finally {
      await testDb.delete(notifications).where(noticeWhere);
      await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
      await testDb
        .delete(flowDefinitions)
        .where(eq(flowDefinitions.id, definitionId));
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId })
        .onConflictDoNothing();
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });

  test("ordinary completed history and paused notice heads do not become delivery work ahead of an eligible notice", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    const pausedUserId = mintAuthProviderId<"user">();
    const runIds = Array.from({ length: 20 }, () =>
      createSafeId<"flowRun">(),
    ).toSorted();
    const historicalIds = runIds.slice(0, 12);
    const pausedIds = runIds.slice(12, -1);
    const eligibleId =
      runIds.at(-1) ?? panic("Missing eligible notice fixture");
    const noticeCondition = and(
      eq(notifications.entityType, NOTIFICATION_ENTITY_TYPE.FLOW_RUN),
      inArray(notifications.entityId, runIds),
    );
    try {
      await testDb.insert(user).values({
        id: pausedUserId,
        name: "Paused notice actor",
        email: `${pausedUserId}@example.test`,
        emailVerified: true,
      });
      await testDb.insert(member).values({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId: pausedUserId,
        role: "member",
        createdAt: new Date(),
      });
      await testDb.insert(flowRuns).values([
        ...historicalIds.map((id) => ({
          id,
          workspaceId,
          definitionSnapshot: SNAPSHOT,
          triggerSource: { type: "manual" as const, userId },
          status: "completed" as const,
          recoveryState: null,
          createdAt: STALLED_AT,
        })),
        ...pausedIds.map((id) => ({
          id,
          workspaceId,
          definitionSnapshot: SNAPSHOT,
          triggerSource: { type: "manual" as const, userId: pausedUserId },
          status: "completed" as const,
          recoveryState: "completion-notice-pending" as const,
          createdAt: STALLED_AT,
        })),
        {
          id: eligibleId,
          workspaceId,
          definitionSnapshot: SNAPSHOT,
          triggerSource: { type: "manual" as const, userId },
          status: "completed" as const,
          recoveryState: "completion-notice-pending" as const,
        },
      ]);
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      expect(await testDb.$count(notifications, noticeCondition)).toBe(1);
      expect(
        await testDb.query.notifications.findFirst({
          where: { entityId: { eq: eligibleId } },
          columns: { userId: true },
        }),
      ).toEqual({ userId });
      const history = await testDb
        .select({
          id: flowRuns.id,
          recoveryState: flowRuns.recoveryState,
          status: flowRuns.status,
        })
        .from(flowRuns)
        .where(inArray(flowRuns.id, historicalIds))
        .orderBy(flowRuns.id);
      expect(history).toEqual(
        historicalIds.map((id) => ({
          id,
          recoveryState: null,
          status: "completed" as const,
        })),
      );
      const paused = await testDb
        .select({
          id: flowRuns.id,
          recoveryState: flowRuns.recoveryState,
          status: flowRuns.status,
        })
        .from(flowRuns)
        .where(inArray(flowRuns.id, pausedIds))
        .orderBy(flowRuns.id);
      expect(paused).toEqual(
        pausedIds.map((id) => ({
          id,
          recoveryState: "completion-notice-pending" as const,
          status: "completed" as const,
        })),
      );
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: eligibleId } },
          columns: { recoveryState: true },
        }),
      ).toEqual({ recoveryState: null });
      for (const id of runIds) {
        expect(enqueuedRunIds).not.toContain(id);
      }
    } finally {
      await testDb.delete(notifications).where(noticeCondition);
      await testDb.delete(flowRuns).where(inArray(flowRuns.id, runIds));
      await testDb.delete(user).where(eq(user.id, pausedUserId));
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });

  test("a pending notice whose actor was removed retains completed output and stops replaying", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    const removedUserId = mintAuthProviderId<"user">();
    const runId = createSafeId<"flowRun">();
    const stepId = createSafeId<"flowRunStep">();
    const output = {
      kind: "ai",
      markdown: "Retained completed output",
    } as const;
    try {
      await testDb.insert(user).values({
        id: removedUserId,
        name: "Removed notice actor",
        email: `${removedUserId}@example.test`,
        emailVerified: true,
      });
      await testDb.insert(flowRuns).values({
        id: runId,
        workspaceId,
        definitionSnapshot: SNAPSHOT,
        triggerSource: { type: "manual", userId: removedUserId },
        status: "completed",
        recoveryState: "completion-notice-pending",
      });
      await testDb.insert(flowRunSteps).values({
        id: stepId,
        workspaceId,
        runId,
        index: 0,
        kind: "ai",
        status: "completed",
        output,
      });
      await testDb.delete(user).where(eq(user.id, removedUserId));
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      const retained = await testDb.query.flowRuns.findFirst({
        where: { id: { eq: runId } },
        columns: { status: true, recoveryState: true },
      });
      expect(retained).toEqual({
        status: "completed",
        recoveryState: "actor-removed",
      });
      expect(
        await testDb.query.flowRunSteps.findFirst({
          where: { id: { eq: stepId } },
          columns: { status: true, output: true },
        }),
      ).toEqual({ status: "completed", output });
      expect(
        await testDb.$count(notifications, eq(notifications.entityId, runId)),
      ).toBe(0);
      expect(enqueuedRunIds).not.toContain(runId);
      await reconcileOrphanedFlowRuns(
        { batchSize: 2, principal: { organizationId, userId: removedUserId } },
        reconcileDependencies,
      );
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { status: true, recoveryState: true },
        }),
      ).toEqual(retained);
      expect(
        await testDb.$count(notifications, eq(notifications.entityId, runId)),
      ).toBe(0);
      expect(enqueuedRunIds).not.toContain(runId);
    } finally {
      await testDb
        .delete(notifications)
        .where(eq(notifications.entityId, runId));
      await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
      await testDb.delete(user).where(eq(user.id, removedUserId));
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });

  test("a notice with a deleted definition waits for global cleanup and preserves its output", async () => {
    const previousFlag = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = true;
    const definitionId = createSafeId<"flowDefinition">();
    const runId = createSafeId<"flowRun">();
    const stepId = createSafeId<"flowRunStep">();
    const output = {
      kind: "ai",
      markdown: "Retained automated output",
    } as const;
    try {
      await testDb.insert(flowDefinitions).values({
        id: definitionId,
        organizationId,
        name: SNAPSHOT.name,
        steps: SNAPSHOT.steps,
        trigger: {
          type: "schedule",
          workspaceId,
          schedule: { frequency: "daily", hourUtc: 0 },
        },
        createdByUserId: userId,
      });
      await testDb.insert(flowRuns).values({
        id: runId,
        workspaceId,
        definitionId,
        definitionSnapshot: SNAPSHOT,
        triggerSource: { type: "schedule" },
        status: "completed",
        recoveryState: "completion-notice-pending",
      });
      await testDb.insert(flowRunSteps).values({
        id: stepId,
        workspaceId,
        runId,
        index: 0,
        kind: "ai",
        status: "completed",
        output,
      });
      await testDb
        .delete(flowDefinitions)
        .where(eq(flowDefinitions.id, definitionId));
      await reconcileOrphanedFlowRuns(
        { batchSize: 2, principal: { organizationId, userId } },
        reconcileDependencies,
      );
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { status: true, recoveryState: true, definitionId: true },
        }),
      ).toEqual({
        status: "completed",
        recoveryState: "completion-notice-pending",
        definitionId: null,
      });
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { status: true, recoveryState: true },
        }),
      ).toEqual({ status: "completed", recoveryState: "actor-removed" });
      expect(
        await testDb.query.flowRunSteps.findFirst({
          where: { id: { eq: stepId } },
          columns: { status: true, output: true },
        }),
      ).toEqual({ status: "completed", output });
      expect(
        await testDb.$count(notifications, eq(notifications.entityId, runId)),
      ).toBe(0);
      expect(enqueuedRunIds).not.toContain(runId);
    } finally {
      await testDb
        .delete(notifications)
        .where(eq(notifications.entityId, runId));
      await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
      await testDb
        .delete(flowDefinitions)
        .where(eq(flowDefinitions.id, definitionId));
      env.FEATURE_FLOWS = previousFlag;
      restore();
    }
  });

  describe.skipIf(process.env["STELLA_RUN_VALKEY_TESTS"] !== "true")(
    "step regrant over Valkey",
    () => {
      test("a completed admission pause is delivered again after regrant without unrelated queue activity", async () => {
        const runId =
          nonTerminalRunIds.at(0) ?? panic("Missing recovery fixture");
        const prefix = `flow-regrant-${Bun.randomUUIDv7()}`;
        const queueConnection = createBullMqConnection({
          storeClass: "durable-coordination",
        });
        const workerConnection = createBullMqConnection({
          storeClass: "durable-coordination",
        });
        const queue = new Queue<FlowStepJobData>(FLOW_RUN_QUEUE_NAME, {
          connection: queueConnection,
          prefix,
          defaultJobOptions: FLOW_STEP_JOB_OPTIONS,
        });
        const paused = Promise.withResolvers<undefined>();
        const resumed = Promise.withResolvers<undefined>();
        const executed: FlowStepJobData[] = [];
        let completed = 0;
        const errors: Error[] = [];
        const worker = new BullMqWorker<FlowStepJobData>(
          queue.name,
          async (job) => {
            if (
              await isBackgroundFeatureEnabled({
                tx: asTestRaw<
                  Parameters<typeof isBackgroundFeatureEnabled>[0]["tx"]
                >(testDb),
                organizationId,
                userId,
                featureId: "flows",
              })
            ) {
              executed.push(job.data);
            }
          },
          { connection: workerConnection, prefix },
        );
        worker.on("error", (error) => {
          errors.push(error);
        });
        worker.on("completed", () => {
          completed += 1;
          if (completed === 1) {
            paused.resolve(undefined);
          }
          if (completed === 2) {
            resumed.resolve(undefined);
          }
        });
        const target = await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { currentStepIndex: true },
        });
        const stepIndex =
          target?.currentStepIndex ?? panic("Missing durable step");
        try {
          await testDb
            .delete(featureEnrolments)
            .where(
              and(
                eq(featureEnrolments.organizationId, organizationId),
                eq(featureEnrolments.featureId, "flows"),
              ),
            );
          await enqueueFlowStep({ runId, stepIndex }, { queue });
          await withTimeout(async () => await paused.promise, {
            label: "paused flow completion",
            timeoutMs: 5000,
          });
          expect(executed).toEqual([]);
          await testDb
            .insert(featureEnrolments)
            .values({ featureId: "flows", organizationId, userId });
          await reconcileOrphanedFlowRuns(
            {},
            {
              database: reconcileDependencies.database,
              enqueueStep: async (step) => {
                if (step.runId === runId) {
                  await enqueueFlowStep(step, { queue });
                }
              },
            },
          );
          await withTimeout(async () => await resumed.promise, {
            label: "regranted flow delivery",
            timeoutMs: 5000,
          });
          expect(executed).toEqual([{ runId, stepIndex }]);
          expect(completed).toBe(2);
          expect(errors).toEqual([]);
        } finally {
          await worker.close();
          await queue.obliterate({ force: true });
          await queue.close();
          queueConnection.disconnect();
          workerConnection.disconnect();
          await testDb
            .insert(featureEnrolments)
            .values({ featureId: "flows", organizationId, userId })
            .onConflictDoNothing();
        }
      });
    },
  );

  test("the standing sweep skips runs inside the stall window", async () => {
    await reconcileOrphanedFlowRuns(
      {
        batchSize: 2,
        stalledBefore: new Date(Date.now() - STALL_WINDOW_MS),
      },
      reconcileDependencies,
    );

    expect(enqueuedRunIds.toSorted()).toEqual([...stalledRunIds].toSorted());
  });
  test("opt-out pauses recovery without changing runs and regrant resumes", async () => {
    await testDb
      .delete(featureEnrolments)
      .where(
        and(
          eq(featureEnrolments.organizationId, organizationId),
          eq(featureEnrolments.featureId, "flows"),
        ),
      );
    try {
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      expect(enqueuedRunIds).toEqual([]);
      expect(
        await testDb
          .select({ id: flowRuns.id })
          .from(flowRuns)
          .where(eq(flowRuns.workspaceId, workspaceId)),
      ).toHaveLength(nonTerminalRunIds.length + 1);
    } finally {
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId });
    }
    await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
    expect(enqueuedRunIds.toSorted()).toEqual(nonTerminalRunIds.toSorted());
  });

  test("a scoped regrant wakes only its actor's runs, including recent pauses", async () => {
    await reconcileOrphanedFlowRuns(
      {
        batchSize: 2,
        principal: { organizationId, userId: mintAuthProviderId<"user">() },
      },
      reconcileDependencies,
    );
    expect(enqueuedRunIds).toEqual([]);
    await reconcileOrphanedFlowRuns(
      { batchSize: 2, principal: { organizationId, userId } },
      reconcileDependencies,
    );
    expect(enqueuedRunIds.toSorted()).toEqual(nonTerminalRunIds.toSorted());
  });

  test("deployment off pauses recovery for enrolled actors", async () => {
    const previous = env.FEATURE_FLOWS;
    const restore = setRuntimeModeForTesting({ mode: RUNTIME_MODE.strict });
    env.FEATURE_FLOWS = false;
    try {
      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);
      expect(enqueuedRunIds).toEqual([]);
    } finally {
      env.FEATURE_FLOWS = previous;
      restore();
    }
  });

  test("deleted-definition orphans reach terminal refusal while ungranted actors remain paused", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    const runId = createSafeId<"flowRun">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: SNAPSHOT.name,
      steps: SNAPSHOT.steps,
      trigger: {
        type: "schedule",
        workspaceId,
        schedule: { frequency: "daily", hourUtc: 0 },
      },
      createdByUserId: userId,
    });
    await testDb.insert(flowRuns).values({
      id: runId,
      workspaceId,
      definitionId,
      definitionSnapshot: SNAPSHOT,
      triggerSource: { type: "schedule" },
      status: "running",
      currentStepIndex: 0,
      createdAt: STALLED_AT,
    });
    await testDb.insert(flowRunSteps).values({
      id: createSafeId<"flowRunStep">(),
      workspaceId,
      runId,
      index: 0,
      kind: "ai",
      status: "pending",
    });
    try {
      await testDb
        .delete(flowDefinitions)
        .where(eq(flowDefinitions.id, definitionId));
      await testDb
        .delete(featureEnrolments)
        .where(
          and(
            eq(featureEnrolments.organizationId, organizationId),
            eq(featureEnrolments.featureId, "flows"),
          ),
        );
      expect(
        await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { definitionId: true, status: true },
        }),
      ).toEqual({ definitionId: null, status: "running" });

      await reconcileOrphanedFlowRuns({ batchSize: 2 }, reconcileDependencies);

      expect(enqueuedRunIds).toEqual([runId]);
      const retained = await testDb
        .select({ id: flowRuns.id })
        .from(flowRuns)
        .where(
          and(
            eq(flowRuns.workspaceId, workspaceId),
            inArray(flowRuns.status, ["pending", "running"]),
          ),
        );
      expect(retained.map(({ id }) => id).toSorted()).toEqual(
        [...nonTerminalRunIds, runId].toSorted(),
      );
    } finally {
      await testDb.delete(flowRuns).where(eq(flowRuns.id, runId));
      await testDb
        .delete(flowDefinitions)
        .where(eq(flowDefinitions.id, definitionId));
      await testDb
        .insert(featureEnrolments)
        .values({ featureId: "flows", organizationId, userId })
        .onConflictDoNothing();
    }
  });
});
