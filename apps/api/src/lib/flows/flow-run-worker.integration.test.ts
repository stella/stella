/**
 * Integration test for the Workflows run pipeline: an `ai` step, a
 * `review-gate` step, and a `create-document` step chained through the
 * real state machine (`flow-executor.ts`) against a real (PGlite) Postgres
 * database, driven the same way the BullMQ worker drives it — one
 * `executeFlowStep` call per queued job.
 *
 * Only genuine external I/O is stubbed: the AI provider call, the
 * derivative/extraction queues, SSE broadcast, and the BullMQ queue itself
 * (so the test never needs a live Redis). Object storage runs the real
 * `lib/s3.ts` against an in-process store. Everything else — the run/step
 * transitions, RLS-scoped reads and writes, the DOCX compiler, and entity
 * creation — is the real production code.
 */

import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { inspectDocxPackage } from "@stll/folio-core/server";

import { organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  fields,
  entities,
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  notifications,
  properties,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  workObligations,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { envBase } from "@/api/env-base";
import readTaskById from "@/api/handlers/tasks/get";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import updateWorkObligation from "@/api/handlers/work-obligations/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import { createFileKey } from "@/api/lib/files/utils";
import {
  cancelFlowRun,
  executeFlowStep,
  failFlowRunFromWorker,
  FlowStepError,
  resolveFlowReviewGate as resolveFlowReviewGateWithDependencies,
} from "@/api/lib/flows/flow-executor";
import { fileFlowRunCompletionNotice } from "@/api/lib/flows/flow-run-actor";
import type { notifyFlowRunActorOfCompletion } from "@/api/lib/flows/flow-run-completion-notice";
import type { FlowStep, FlowTrigger } from "@/api/lib/flows/flow-types";
import { decideGateForTask } from "@/api/lib/flows/review-gate-task";
import { startFlowRun } from "@/api/lib/flows/start-flow-run";
import type { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { installRecordingAnalytics } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(60_000);

const testDb: TestDatabase = await getTestDb();
type ExecuteFlowStepDependencies = NonNullable<
  Parameters<typeof executeFlowStep>[2]
>;
const flowDatabase =
  asTestRaw<NonNullable<ExecuteFlowStepDependencies["database"]>>(testDb);

// ── Boundary mocks ───────────────────────────────────────
//
// Route both the executor's direct `rootDb` reads and its RLS-scoped writes
// (`createRootScopedDb`/`createRootSafeDb`) at the real test database, so the
// run/step transitions execute as real SQL under RLS, exactly like production.

type RootScopeArgs = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceIds: SafeId<"workspace">[];
};

const makeScopedDb = asTestRaw<
  NonNullable<ExecuteFlowStepDependencies["makeScopedDb"]>
>(({ organizationId, userId, workspaceIds }: RootScopeArgs) =>
  createScopedDb(testDb, workspaceIds, organizationId, userId),
);
const makeSafeDb = asTestRaw<
  NonNullable<ExecuteFlowStepDependencies["makeSafeDb"]>
>(({ organizationId, userId, workspaceIds }: RootScopeArgs) =>
  createSafeDb(testDb, workspaceIds, organizationId, userId),
);

// The BullMQ queue is the only piece that would otherwise need live Redis.
// Capture what the executor enqueues instead so the test can drive each
// step itself, the same way the worker's job processor would.
type EnqueuedStep = { runId: string; stepIndex: number };
const enqueuedSteps: EnqueuedStep[] = [];
const enqueueFlowStepMock = mock(
  async ({ runId, stepIndex }: EnqueuedStep & { delayMs?: number }) => {
    enqueuedSteps.push({ runId, stepIndex });
  },
);
const broadcastUpdate = () => undefined;

const MOCK_AI_MARKDOWN =
  "# Mock Memo\n\nThis memo was generated by the mock AI adapter for the flow-run integration test.";
const generateTanStackTextForRoleMock = mock(
  async () => await Promise.resolve(MOCK_AI_MARKDOWN),
);
const generateTextForTest = asTestRaw<typeof generateTanStackTextForRole>(
  generateTanStackTextForRoleMock,
);
const createEntityDependencies = {
  broadcastWorkspaceResourceUpdated: () => undefined,
  enqueueImageThumbnailOrMarkFailed: async () => undefined,
  enqueuePdfDerivativeOrMarkFailed: async () => undefined,
  processExtraction: async () => undefined,
  requestNativeExtractionRun: async () => null,
} satisfies CreateEntityFromBufferDependencies;

const createEntity: typeof createEntityFromBuffer = async (input) =>
  await createEntityFromBuffer({
    ...input,
    dependencies: createEntityDependencies,
  });

const executeFlowStepWithTestModel = async (
  job: Parameters<typeof executeFlowStep>[0],
  signal: AbortSignal,
) =>
  await executeFlowStep(job, signal, {
    generateTextForRole: generateTextForTest,
    database: flowDatabase,
    makeScopedDb,
    makeSafeDb,
    enqueueStep: enqueueFlowStepMock,
    broadcastUpdate,
    createEntity,
    loadAIConfig: async () => Result.ok(null),
    // Governed workflow on: the gate's task must carry an obligation.
    taskFeatures: { governedWorkflow: true, legalLists: false },
  });

/** The task a run's review gate raised, with the obligation that governs it. */
const loadReviewTask = async (runId: SafeId<"flowRun">, stepIndex: number) => {
  const step = await testDb.query.flowRunSteps.findFirst({
    where: { runId: { eq: runId }, index: { eq: stepIndex } },
    columns: { reviewTaskEntityId: true },
  });
  const taskEntityId = step?.reviewTaskEntityId ?? null;
  if (taskEntityId === null) {
    throw new Error("expected the review gate to have raised a task");
  }
  const task = await testDb.query.entities.findFirst({
    where: { id: { eq: taskEntityId } },
    columns: { kind: true, name: true, status: true, workspaceId: true },
  });
  const obligation = await testDb.query.workObligations.findFirst({
    where: { entityId: { eq: taskEntityId } },
    columns: { status: true, ownerUserId: true, sourceType: true },
  });
  if (!task || !obligation) {
    throw new Error("expected the review task and its obligation to exist");
  }
  return { taskEntityId, task, obligation };
};

// The completion pointer for a run's actor is a cross-user write; production
// files it on the owner connection, the test on its own database.
const notifyRunCompleted: typeof notifyFlowRunActorOfCompletion = async (
  notice,
) =>
  await fileFlowRunCompletionNotice(
    notice,
    asTestRaw<Parameters<typeof fileFlowRunCompletionNotice>[1]>(testDb),
  );

const resolveFlowReviewGate = async (
  options: Parameters<typeof resolveFlowReviewGateWithDependencies>[0],
) =>
  await resolveFlowReviewGateWithDependencies(options, {
    broadcastUpdate,
    enqueueStep: enqueueFlowStepMock,
    notifyRunCompleted,
  });

// ── Fixture data ─────────────────────────────────────────

const MANUAL_TRIGGER = { type: "manual" } as const satisfies FlowTrigger;

const AI_STEP: FlowStep = {
  kind: "ai",
  name: "Draft memo",
  prompt: "Draft a short legal memo.",
  includeDocuments: false,
};
const REVIEW_GATE_STEP: FlowStep = {
  kind: "review-gate",
  name: "Legal review",
  instructions: "Confirm the memo is accurate.",
};
const CREATE_DOCUMENT_STEP: FlowStep = {
  kind: "create-document",
  name: "Create document",
  documentTitle: "Flow Test Memo",
};

describe("flow run worker pipeline (ai -> review-gate -> create-document)", () => {
  let organizationId: SafeId<"organization">;
  let userId: SafeId<"user">;
  let workspaceId: SafeId<"workspace">;
  let fake: FakeS3;

  beforeAll(async () => {
    fake = startFakeS3();
    organizationId = mintAuthProviderId<"organization">();
    userId = mintAuthProviderId<"user">();
    workspaceId = createSafeId<"workspace">();
    const propertyId = createSafeId<"property">();

    await testDb.insert(organization).values({
      id: organizationId,
      name: "Flow Worker Test Org",
      slug: `flow-worker-test-${organizationId}`,
      createdAt: new Date(),
    });
    await testDb.insert(user).values({
      id: userId,
      name: "Flow Worker Test User",
      email: `${userId}@example.com`,
    });
    await testDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "Flow worker test matter",
      reference: workspaceId.slice(0, 8),
    });
    await testDb.insert(workspaceMembers).values({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId,
    });
    await testDb.insert(properties).values({
      id: propertyId,
      workspaceId,
      name: "File",
      status: "fresh",
      content: { type: "file", version: 1 },
      tool: { type: "manual-input", version: 1 },
    });
  });

  afterAll(async () => {
    fake.stop();
    await releaseTestDb();
  });

  const createWaitingGate = async (
    governedWorkflow: boolean,
    nextStep: FlowStep = CREATE_DOCUMENT_STEP,
  ) => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Task-owned review flow",
      steps: [REVIEW_GATE_STEP, nextStep],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );
    const started = await startFlowRun({
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "manual", userId },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 0 });
    await executeFlowStep(
      { runId, stepIndex: 0 },
      new AbortController().signal,
      {
        database: flowDatabase,
        makeScopedDb,
        makeSafeDb,
        enqueueStep: enqueueFlowStepMock,
        broadcastUpdate,
        taskFeatures: { governedWorkflow, legalLists: false },
      },
    );
    const gate = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { status: true, reviewTaskEntityId: true },
    });
    expect(gate?.status).toBe("awaiting_review");
    const taskEntityId = gate?.reviewTaskEntityId;
    if (!taskEntityId) {
      throw new Error("expected the waiting gate to own a task");
    }
    const obligation = await testDb.query.workObligations.findFirst({
      where: { entityId: { eq: taskEntityId } },
    });
    expect(obligation !== undefined).toBe(governedWorkflow);
    const recordAuditEvent = async () => undefined;
    const context = {
      safeDb,
      scopedDb: createScopedDb(testDb, [workspaceId], organizationId, userId),
      workspaceId,
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
      memberRole: { role: "owner" },
      recordAuditEvent,
      createAuditRecorder: () => recordAuditEvent,
      orgAIConfig: null,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      managedAIResidency: "eu",
      request: new Request("https://example.test/review-task"),
    };
    return { runId, taskEntityId, safeDb, context };
  };

  const expectRejectedGate = async (runId: SafeId<"flowRun">) => {
    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true, currentStepIndex: true },
    });
    const steps = await testDb.query.flowRunSteps.findMany({
      where: { runId: { eq: runId } },
      columns: { status: true, output: true },
      orderBy: { index: "asc" },
    });
    expect(run).toEqual({ status: "cancelled", currentStepIndex: 0 });
    expect(steps).toEqual([
      {
        status: "completed",
        output: {
          kind: "review-gate",
          decision: "rejected",
          userId,
          note: null,
        },
      },
      { status: "skipped", output: null },
    ]);
    const gate = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { reviewTaskEntityId: true },
    });
    if (!gate?.reviewTaskEntityId) {
      throw new Error("expected the settled gate to retain its review task");
    }
    const task = await testDb.query.entities.findFirst({
      where: { id: { eq: gate.reviewTaskEntityId } },
      columns: { status: true },
    });
    expect(task?.status).toBe("done");
    expect(enqueuedSteps.filter((step) => step.runId === runId)).toEqual([]);
  };

  // Manual provenance represents already-edited persisted obligations;
  // feature-off gates intentionally have no obligation to edit.
  test.each([
    [true, "original", "task update"],
    [true, "original", "obligation transition"],
    [true, "manual", "task update"],
    [true, "manual", "obligation transition"],
    [false, "original", "task update"],
    [false, "original", "obligation transition"],
  ] as const)(
    "gate task cancellation rejects with governed=%s, metadata=%s, path=%s",
    async (governedWorkflow, metadata, closingPath) => {
      const { runId, taskEntityId, safeDb, context } =
        await createWaitingGate(governedWorkflow);
      if (metadata === "manual") {
        await testDb
          .update(workObligations)
          .set({ sourceType: WORK_OBLIGATION_SOURCE.MANUAL })
          .where(eq(workObligations.entityId, taskEntityId));
      }
      if (closingPath === "task update") {
        const result = await Result.gen(() =>
          updateTaskHandler({
            safeDb,
            workspaceId,
            userId,
            recordAuditEvent: async () => undefined,
            body: { taskId: taskEntityId, status: "cancelled" },
            features: { governedWorkflow, legalLists: false },
            decideGate: async (options) =>
              await decideGateForTask(options, {
                broadcastUpdate,
                enqueueStep: enqueueFlowStepMock,
                notifyRunCompleted,
              }),
          }),
        );
        if (Result.isError(result)) {
          throw result.error;
        }
      } else {
        expect(
          await transitionWorkObligation.handler(
            asTestRaw<Parameters<typeof transitionWorkObligation.handler>[0]>({
              ...context,
              params: { workspaceId, entityId: taskEntityId },
              body: { action: "cancel" },
            }),
          ),
        ).toEqual({ success: true });
      }
      await expectRejectedGate(runId);
    },
  );

  test.each([
    [true, "original"],
    [true, "manual"],
    [false, "original"],
  ] as const)(
    "gate task read exposes its review with governed=%s, metadata=%s",
    async (governedWorkflow, metadata) => {
      const { runId, taskEntityId, context } =
        await createWaitingGate(governedWorkflow);
      if (metadata === "manual") {
        await testDb
          .update(workObligations)
          .set({ sourceType: WORK_OBLIGATION_SOURCE.MANUAL })
          .where(eq(workObligations.entityId, taskEntityId));
      }
      const read = await readTaskById.handler(
        asTestRaw<Parameters<typeof readTaskById.handler>[0]>({
          ...context,
          params: { workspaceId, taskId: taskEntityId },
        }),
      );
      expect(read).toMatchObject({ id: taskEntityId, flowReview: { runId } });
    },
  );

  test.each([true, false])(
    "gate task provenance edit is refused with governed=%s",
    async (governedWorkflow) => {
      const { runId, taskEntityId, safeDb, context } =
        await createWaitingGate(governedWorkflow);
      const before = await testDb.query.workObligations.findFirst({
        where: { entityId: { eq: taskEntityId } },
      });
      const edited = await updateWorkObligation.handler(
        asTestRaw<Parameters<typeof updateWorkObligation.handler>[0]>({
          ...context,
          params: { workspaceId, entityId: taskEntityId },
          body: { sourceType: WORK_OBLIGATION_SOURCE.MANUAL },
        }),
      );
      expect(edited).toMatchObject({ code: 409 });
      expect(
        await testDb.query.workObligations.findFirst({
          where: { entityId: { eq: taskEntityId } },
        }),
      ).toEqual(before);
      const run = await testDb.query.flowRuns.findFirst({
        where: { id: { eq: runId } },
        columns: { status: true },
      });
      expect(run?.status).toBe("awaiting_review");
      const cancelled = await Result.gen(() =>
        updateTaskHandler({
          safeDb,
          workspaceId,
          userId,
          recordAuditEvent: async () => undefined,
          body: { taskId: taskEntityId, status: "cancelled" },
          features: { governedWorkflow, legalLists: false },
          decideGate: async (options) =>
            await decideGateForTask(options, {
              broadcastUpdate,
              enqueueStep: enqueueFlowStepMock,
              notifyRunCompleted,
            }),
        }),
      );
      if (Result.isError(cancelled)) {
        throw cancelled.error;
      }
      await expectRejectedGate(runId);
    },
  );

  test("a settled review task without an obligation cannot be reopened", async () => {
    const { runId, taskEntityId, safeDb } = await createWaitingGate(false);
    const rejected = await resolveFlowReviewGate({
      safeDb,
      workspaceId,
      organizationId,
      runId,
      userId,
      decision: "rejected",
      note: null,
      recordAuditEvent: async () => undefined,
    });
    if (Result.isError(rejected)) {
      throw rejected.error;
    }
    await expectRejectedGate(runId);
    const reopened = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => undefined,
        body: { taskId: taskEntityId, status: "open" },
        features: { governedWorkflow: false, legalLists: false },
        decideGate: async (options) =>
          await decideGateForTask(options, {
            broadcastUpdate,
            enqueueStep: enqueueFlowStepMock,
            notifyRunCompleted,
          }),
      }),
    );
    expect(reopened.isErr()).toBe(true);
    if (Result.isError(reopened)) {
      expect(reopened.error).toMatchObject({
        status: 409,
        message:
          "A workflow review cannot be reopened; start the workflow again instead",
      });
    }
    await expectRejectedGate(runId);
  });

  test("cancellation resolves a waiting gate whose obligation was already cancelled", async () => {
    const { runId, taskEntityId, safeDb } = await createWaitingGate(true);
    await testDb
      .update(workObligations)
      .set({ status: WORK_OBLIGATION_STATUS.CANCELLED })
      .where(eq(workObligations.entityId, taskEntityId));
    await testDb
      .update(entities)
      .set({ status: "cancelled" })
      .where(eq(entities.id, taskEntityId));
    const before = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { status: true, output: true },
    });
    expect(before).toEqual({ status: "awaiting_review", output: null });
    const cancelled = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => undefined,
        body: { taskId: taskEntityId, status: "cancelled" },
        features: { governedWorkflow: true, legalLists: false },
        decideGate: async (options) =>
          await decideGateForTask(options, {
            broadcastUpdate,
            enqueueStep: enqueueFlowStepMock,
            notifyRunCompleted,
          }),
      }),
    );
    if (Result.isError(cancelled)) {
      throw cancelled.error;
    }
    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true },
    });
    const steps = await testDb.query.flowRunSteps.findMany({
      where: { runId: { eq: runId } },
      columns: { status: true, output: true },
      orderBy: { index: "asc" },
    });
    expect(run?.status).toBe("cancelled");
    expect(steps).toEqual([
      {
        status: "completed",
        output: {
          kind: "review-gate",
          decision: "rejected",
          userId,
          note: null,
        },
      },
      { status: "skipped", output: null },
    ]);
    expect(enqueuedSteps.filter((step) => step.runId === runId)).toEqual([]);
  });

  test("a previous review task cannot decide the run's next waiting gate", async () => {
    const { runId, taskEntityId, safeDb } = await createWaitingGate(
      true,
      REVIEW_GATE_STEP,
    );
    const approved = await resolveFlowReviewGate({
      safeDb,
      workspaceId,
      organizationId,
      runId,
      userId,
      decision: "approved",
      note: null,
      recordAuditEvent: async () => undefined,
    });
    if (Result.isError(approved)) {
      throw approved.error;
    }
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 1 },
      new AbortController().signal,
    );
    const nextTask = await loadReviewTask(runId, 1);
    expect(nextTask.taskEntityId).not.toBe(taskEntityId);
    const readState = async () => ({
      run: await testDb.query.flowRuns.findFirst({
        where: { id: { eq: runId } },
      }),
      steps: await testDb.query.flowRunSteps.findMany({
        where: { runId: { eq: runId } },
        orderBy: { index: "asc" },
      }),
      task: await testDb.query.entities.findFirst({
        where: { id: { eq: nextTask.taskEntityId } },
      }),
    });
    const before = await readState();
    expect(before.run?.status).toBe("awaiting_review");
    expect(before.run?.currentStepIndex).toBe(1);
    expect(before.steps.at(1)?.status).toBe("awaiting_review");
    const stale = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => undefined,
        body: { taskId: taskEntityId, status: "cancelled" },
        features: { governedWorkflow: true, legalLists: false },
        decideGate: async (options) =>
          await decideGateForTask(options, {
            broadcastUpdate,
            enqueueStep: enqueueFlowStepMock,
            notifyRunCompleted,
          }),
      }),
    );
    expect(stale.isErr()).toBe(true);
    if (Result.isError(stale)) {
      expect(stale.error).toMatchObject({
        status: 409,
        message: "This run has no open review gate.",
      });
    }
    expect(await readState()).toEqual(before);
    expect(enqueuedSteps.filter((step) => step.runId === runId)).toEqual([]);
  });

  test.each(["before start", "before pause", "before failure"] as const)(
    "worker preserves cancellation committed %s",
    async (boundary) => {
      const { runId, taskEntityId, safeDb } = await createWaitingGate(false);
      await testDb
        .update(flowRuns)
        .set({ status: "pending", currentStepIndex: 0 })
        .where(eq(flowRuns.id, runId));
      await testDb
        .update(flowRunSteps)
        .set({ status: "pending", startedAt: null, finishedAt: null })
        .where(eq(flowRunSteps.runId, runId));
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let transactionIndex = 0;
      const blockedIndex = boundary === "before pause" ? 2 : 1;
      // Hold before opening the scoped transaction: cancellation can commit
      // while the worker retains its earlier root reads or start result.
      const gatedMakeScopedDb: typeof makeScopedDb =
        (scope) => async (work) => {
          transactionIndex += 1;
          if (transactionIndex === blockedIndex) {
            entered.resolve(undefined);
            await release.promise;
          }
          return await makeScopedDb(scope)(work);
        };
      const readState = async () => ({
        run: await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
        }),
        steps: await testDb.query.flowRunSteps.findMany({
          where: { runId: { eq: runId } },
          orderBy: { index: "asc" },
        }),
        tasks: await testDb.query.entities.findMany({
          where: { workspaceId: { eq: workspaceId }, kind: { eq: "task" } },
          orderBy: { id: "asc" },
        }),
        notices: await testDb.query.notifications.findMany({
          where: { entityId: { eq: runId } },
          orderBy: { id: "asc" },
        }),
      });
      const job = { runId, stepIndex: 0 };
      const worker =
        boundary === "before failure"
          ? failFlowRunFromWorker(
              job,
              new FlowStepError({ message: "Step refused" }),
              {
                database:
                  asTestRaw<
                    Parameters<typeof failFlowRunFromWorker>[2]["database"]
                  >(testDb),
                makeScopedDb: gatedMakeScopedDb,
                broadcastUpdate,
              },
            )
          : executeFlowStep(job, new AbortController().signal, {
              database: flowDatabase,
              makeScopedDb: gatedMakeScopedDb,
              makeSafeDb,
              enqueueStep: enqueueFlowStepMock,
              broadcastUpdate,
              taskFeatures: { governedWorkflow: false, legalLists: false },
            });
      try {
        await Promise.race([
          entered.promise,
          worker.then(() => {
            throw new Error(
              "Worker finished before reaching the transaction barrier",
            );
          }),
        ]);
        const running = await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { status: true },
        });
        expect(running?.status).toBe(
          boundary === "before pause" ? "running" : "pending",
        );
        const cancelled = await cancelFlowRun({
          safeDb,
          workspaceId,
          runId,
          userId,
          recordAuditEvent: async () => undefined,
        });
        if (Result.isError(cancelled)) {
          throw cancelled.error;
        }
        const before = await readState();
        expect(before.run?.status).toBe("cancelled");
        expect(before.steps.map((step) => step.status)).toEqual([
          "skipped",
          "skipped",
        ]);
        expect(
          before.tasks.find((task) => task.id === taskEntityId)?.status,
        ).toBe("cancelled");
        release.resolve(undefined);
        await worker;
        expect(await readState()).toEqual(before);
        expect(enqueuedSteps.filter((step) => step.runId === runId)).toEqual(
          [],
        );
      } finally {
        release.resolve(undefined);
        await worker;
      }
    },
  );

  test("worker completion preserves cancellation committed during generation", async () => {
    const { runId, taskEntityId, safeDb } = await createWaitingGate(false);
    await testDb
      .update(flowRuns)
      .set({
        status: "pending",
        currentStepIndex: 0,
        definitionSnapshot: {
          name: "Task-owned review flow",
          steps: [AI_STEP, CREATE_DOCUMENT_STEP],
        },
      })
      .where(eq(flowRuns.id, runId));
    await testDb
      .update(flowRunSteps)
      .set({ kind: "ai", status: "pending", startedAt: null, finishedAt: null })
      .where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, 0)));
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const generateTextForRole: typeof generateTanStackTextForRole =
      async () => {
        entered.resolve(undefined);
        await release.promise;
        return MOCK_AI_MARKDOWN;
      };
    const readState = async () => ({
      run: await testDb.query.flowRuns.findFirst({
        where: { id: { eq: runId } },
      }),
      steps: await testDb.query.flowRunSteps.findMany({
        where: { runId: { eq: runId } },
        orderBy: { index: "asc" },
      }),
      task: await testDb.query.entities.findFirst({
        where: { id: { eq: taskEntityId } },
      }),
      notices: await testDb.query.notifications.findMany({
        where: { entityId: { eq: runId } },
        orderBy: { id: "asc" },
      }),
    });
    const worker = executeFlowStep(
      { runId, stepIndex: 0 },
      new AbortController().signal,
      {
        database: flowDatabase,
        makeScopedDb,
        makeSafeDb,
        generateTextForRole,
        loadAIConfig: async () => Result.ok(null),
        enqueueStep: enqueueFlowStepMock,
        broadcastUpdate,
        taskFeatures: { governedWorkflow: false, legalLists: false },
      },
    );
    try {
      await Promise.race([
        entered.promise,
        worker.then(() => {
          throw new Error("Worker finished before reaching generation");
        }),
      ]);
      const running = await readState();
      expect(running.run?.status).toBe("running");
      expect(running.steps.at(0)?.status).toBe("running");
      const cancelled = await cancelFlowRun({
        safeDb,
        workspaceId,
        runId,
        userId,
        recordAuditEvent: async () => undefined,
      });
      if (Result.isError(cancelled)) {
        throw cancelled.error;
      }
      const before = await readState();
      expect(before.run?.status).toBe("cancelled");
      expect(before.steps.map((step) => step.status)).toEqual([
        "skipped",
        "skipped",
      ]);
      expect(before.task?.status).toBe("cancelled");
      release.resolve(undefined);
      await worker;
      expect(await readState()).toEqual(before);
      expect(enqueuedSteps.filter((step) => step.runId === runId)).toEqual([]);
    } finally {
      release.resolve(undefined);
      await worker;
    }
  });

  test("advances through ai, an approved review gate, and create-document to completion", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Contract memo flow",
      steps: [AI_STEP, REVIEW_GATE_STEP, CREATE_DOCUMENT_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });

    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );

    const started = await startFlowRun({
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "manual", userId },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;

    // Step 0 (`ai`) was enqueued by `startFlowRun`; drive it the way the
    // worker's job processor would.
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 0 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 0 },
      new AbortController().signal,
    );
    expect(generateTanStackTextForRoleMock).toHaveBeenCalledTimes(1);

    // Completing the `ai` step advances and enqueues the `review-gate` step.
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 1 },
      new AbortController().signal,
    );

    const awaitingReview = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true },
    });
    expect(awaitingReview?.status).toBe("awaiting_review");
    // A review gate pauses for a human; the executor does not self-enqueue.
    expect(enqueuedSteps).toHaveLength(0);

    // The gate raised a task for the run's actor, owned and already
    // acknowledged by them, sourced from the flow so its completion routes
    // back to the gate.
    const raised = await loadReviewTask(runId, 1);
    expect(raised.task).toEqual({
      kind: "task",
      name: "Contract memo flow · Legal review",
      status: "open",
      workspaceId,
    });
    expect(raised.obligation).toEqual({
      status: WORK_OBLIGATION_STATUS.ACTIVE,
      ownerUserId: userId,
      sourceType: WORK_OBLIGATION_SOURCE.FLOW,
    });

    const reviewed = await resolveFlowReviewGate({
      safeDb,
      workspaceId,
      organizationId,
      runId,
      userId,
      decision: "approved",
      note: null,
      recordAuditEvent: async () => undefined,
    });
    if (Result.isError(reviewed)) {
      throw reviewed.error;
    }
    expect(reviewed.value.status).toBe("running");

    // Deciding the gate fulfils the task it raised.
    const settled = await loadReviewTask(runId, 1);
    expect(settled.task.status).toBe("done");
    expect(settled.obligation.status).toBe(WORK_OBLIGATION_STATUS.COMPLETED);

    // Approving advances to `create-document`.
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 2 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 2 },
      new AbortController().signal,
    );

    const finished = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true, currentStepIndex: true },
    });
    expect(finished?.status).toBe("completed");

    const steps = await testDb
      .select({
        index: flowRunSteps.index,
        status: flowRunSteps.status,
        output: flowRunSteps.output,
      })
      .from(flowRunSteps)
      .where(eq(flowRunSteps.runId, runId))
      .orderBy(asc(flowRunSteps.index));

    expect(steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    const aiOutput = steps[0]?.output;
    if (aiOutput?.kind !== "ai") {
      throw new Error(
        `expected an "ai" step output, got ${JSON.stringify(aiOutput)}`,
      );
    }
    expect(aiOutput.markdown).toBe(MOCK_AI_MARKDOWN);

    const reviewOutput = steps[1]?.output;
    if (reviewOutput?.kind !== "review-gate") {
      throw new Error(
        `expected a "review-gate" step output, got ${JSON.stringify(reviewOutput)}`,
      );
    }
    expect(reviewOutput.decision).toBe("approved");

    const createOutput = steps[2]?.output;
    if (createOutput?.kind !== "create-document") {
      throw new Error(
        `expected a "create-document" step output, got ${JSON.stringify(createOutput)}`,
      );
    }

    const documentEntity = await testDb.query.entities.findFirst({
      where: { id: { eq: toSafeId<"entity">(createOutput.entityId) } },
      columns: { id: true, name: true, currentVersionId: true },
    });
    expect(documentEntity?.name).toBe("Flow Test Memo.docx");

    // The row and the object must agree: the file field names the object the
    // step published, and the bytes under that key hash to what the row
    // recorded. A key or payload the row does not describe is a document the
    // reader cannot open.
    const currentVersionId = documentEntity?.currentVersionId ?? null;
    if (currentVersionId === null) {
      throw new Error("expected the created document to have a version");
    }
    const fileContent = (
      await testDb
        .select({ content: fields.content })
        .from(fields)
        .where(eq(fields.entityVersionId, currentVersionId))
    ).at(0)?.content;
    if (fileContent?.type !== "file") {
      throw new Error(
        `expected a file field, got ${JSON.stringify(fileContent)}`,
      );
    }

    const documentKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: fileContent.id,
      mimeType: DOCX_MIME_TYPE,
    });
    expect(
      fake.requests
        .filter((request) => request.method === "PUT")
        .map((request) => request.key),
    ).toEqual([documentKey]);
    const stored = fake.objects.get(`${envBase.S3_BUCKET}/${documentKey}`);
    if (stored === undefined) {
      throw new Error(`no object was stored at ${documentKey}`);
    }
    expect(stored.contentType).toBe(DOCX_MIME_TYPE);
    expect(
      new Bun.CryptoHasher("sha256").update(stored.bytes).digest("hex"),
    ).toBe(fileContent.sha256Hex);

    // The step renders the AI step's Markdown on stella's house preset:
    // "BodyText" is absent from folio's default style catalog, so its
    // presence proves the document was composed through the owner rather
    // than a bare Markdown-to-DOCX conversion.
    const inspection = await inspectDocxPackage(stored.bytes, {
      xmlParts: ["word/styles.xml"],
    });
    expect(
      inspection.xmlParts.find((part) => part.path === "word/styles.xml")?.text,
    ).toContain('w:styleId="BodyText"');
  });

  test("closing the gate's task through a task status change approves the gate", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Task-decided flow",
      steps: [AI_STEP, REVIEW_GATE_STEP, CREATE_DOCUMENT_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );
    const started = await startFlowRun({
      safeDb,
      workspaceId,
      organizationId,
      definitionId,
      inputEntityIds: [],
      triggerSource: { type: "manual", userId },
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const runId = started.value.runId;
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 0 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 0 },
      new AbortController().signal,
    );
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 1 },
      new AbortController().signal,
    );
    const raised = await loadReviewTask(runId, 1);

    // The task panel, the kanban board, and the save_task capability all
    // change a task's status this way; for a gate task that is the decision.
    const updated = await Result.gen(() =>
      updateTaskHandler({
        safeDb,
        workspaceId,
        userId,
        recordAuditEvent: async () => undefined,
        body: { taskId: raised.taskEntityId, status: "done" },
        features: { governedWorkflow: true, legalLists: false },
        decideGate: async (options) =>
          await decideGateForTask(options, {
            broadcastUpdate,
            enqueueStep: enqueueFlowStepMock,
            notifyRunCompleted,
          }),
      }),
    );
    if (Result.isError(updated)) {
      throw updated.error;
    }

    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true, currentStepIndex: true },
    });
    expect(run).toEqual({ status: "running", currentStepIndex: 2 });
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 2 });
    const settled = await loadReviewTask(runId, 1);
    expect(settled.task.status).toBe("done");
    expect(settled.obligation.status).toBe(WORK_OBLIGATION_STATUS.COMPLETED);
  });

  test("rejecting the review gate cancels the run instead of creating a document", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Reject-path flow",
      steps: [AI_STEP, REVIEW_GATE_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });

    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );
    const started = await startFlowRun({
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "manual", userId },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;

    enqueuedSteps.length = 0;
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 0 },
      new AbortController().signal,
    );
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 1 },
      new AbortController().signal,
    );

    const rejected = await resolveFlowReviewGate({
      safeDb,
      workspaceId,
      organizationId,
      runId,
      userId,
      decision: "rejected",
      note: "Not approved.",
      recordAuditEvent: async () => undefined,
    });
    if (Result.isError(rejected)) {
      throw rejected.error;
    }
    expect(rejected.value.status).toBe("cancelled");

    // A rejection is a decision too: the review task is done, not abandoned.
    const settled = await loadReviewTask(runId, 1);
    expect(settled.task.status).toBe("done");
    expect(settled.obligation.status).toBe(WORK_OBLIGATION_STATUS.COMPLETED);

    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true },
    });
    expect(run?.status).toBe("cancelled");
    // Rejecting must never chain into the (absent) create-document step.
    expect(enqueuedSteps).toHaveLength(0);
  });

  test("approving a final review gate completes the run and files its pointer", async () => {
    // The worker never sees this terminal path: the gate is the last step, so
    // `completeStepAndAdvance` is not what finishes the run. Without the
    // review-resolution branch the advertised completion notification would
    // exist only for runs that end on some other kind of step.
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Gate-terminated flow",
      steps: [AI_STEP, REVIEW_GATE_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });

    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );
    const started = await startFlowRun({
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "manual", userId },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;

    enqueuedSteps.length = 0;
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 0 },
      new AbortController().signal,
    );
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 1 },
      new AbortController().signal,
    );

    const approved = await resolveFlowReviewGate({
      safeDb,
      workspaceId,
      organizationId,
      runId,
      userId,
      decision: "approved",
      note: null,
      recordAuditEvent: async () => undefined,
    });
    if (Result.isError(approved)) {
      throw approved.error;
    }
    expect(approved.value.status).toBe("completed");
    expect(enqueuedSteps).toHaveLength(0);

    const filed = await testDb
      .select({
        userId: notifications.userId,
        organizationId: notifications.organizationId,
        kind: notifications.kind,
        entityId: notifications.entityId,
        metadata: notifications.metadata,
      })
      .from(notifications)
      .where(eq(notifications.idempotencyKey, `flow-run-completed:${runId}`));

    expect(filed).toEqual([
      {
        userId,
        organizationId,
        kind: NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
        entityId: runId,
        metadata: { flowName: "Gate-terminated flow" },
      },
    ]);
  });

  test("a completion notice that cannot be filed still answers the completed review", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Gate-terminated flow, notice refused",
      steps: [AI_STEP, REVIEW_GATE_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });

    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );
    const started = await startFlowRun({
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "manual", userId },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;

    enqueuedSteps.length = 0;
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 0 },
      new AbortController().signal,
    );
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
    await executeFlowStepWithTestModel(
      { runId, stepIndex: 1 },
      new AbortController().signal,
    );

    const refusingNotice = mock(async () => {
      await Promise.resolve();
      throw new Error("notice refused");
    });
    const recordAuditEvent = mock(async () => undefined);
    const analytics = installRecordingAnalytics();
    try {
      const approved = await resolveFlowReviewGateWithDependencies(
        {
          safeDb,
          workspaceId,
          organizationId,
          runId,
          userId,
          decision: "approved",
          note: null,
          recordAuditEvent,
        },
        {
          broadcastUpdate,
          enqueueStep: enqueueFlowStepMock,
          notifyRunCompleted: refusingNotice,
        },
      );
      if (Result.isError(approved)) {
        throw approved.error;
      }
      expect(approved.value.status).toBe("completed");
      expect(refusingNotice).toHaveBeenCalledTimes(1);
      expect(recordAuditEvent).toHaveBeenCalled();
      expect(
        analytics.exceptions().map((event) => event.properties["error.class"]),
      ).toEqual(["FlowRunCompletionNoticeError"]);
    } finally {
      analytics.restore();
    }

    const finished = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true },
    });
    expect(finished?.status).toBe("completed");
  });

  // An automated run whose author was deleted mid-flight has no actor to
  // scope a write to. The worker still finalizes it, on the connection the
  // host handed the worker, rather than leaving it non-terminal.
  test("finalizes a failed automated run whose author is gone on the worker's connection", async () => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Orphaned schedule flow",
      steps: [AI_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: userId,
    });
    const safeDb = asTestRaw<SafeDb>(
      createSafeDb(testDb, [workspaceId], organizationId, userId),
    );
    const started = await startFlowRun({
      safeDb,
      organizationId,
      workspaceId,
      definitionId,
      triggerSource: { type: "schedule" },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;
    const job = enqueuedSteps.pop();
    expect(job).toEqual({ runId, stepIndex: 0 });
    if (job === undefined) {
      throw new Error("expected the run's first step to be enqueued");
    }
    await testDb
      .update(flowDefinitions)
      .set({ createdByUserId: null })
      .where(eq(flowDefinitions.id, definitionId));

    // The step itself refuses to run without an actor...
    const stepError: unknown = await executeFlowStepWithTestModel(
      job,
      new AbortController().signal,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stepError).toBeInstanceOf(FlowStepError);

    // ...and the final-attempt handler records the failure.
    const broadcasts: string[] = [];
    await failFlowRunFromWorker(job, stepError, {
      database:
        asTestRaw<Parameters<typeof failFlowRunFromWorker>[2]["database"]>(
          testDb,
        ),
      makeScopedDb,
      broadcastUpdate: (broadcastWorkspaceId) => {
        broadcasts.push(broadcastWorkspaceId);
      },
    });

    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { status: true, error: true, finishedAt: true },
    });
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("was removed");
    expect(run?.finishedAt).toBeInstanceOf(Date);
    const step = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { status: true },
    });
    expect(step?.status).toBe("failed");
    expect(broadcasts).toEqual([workspaceId]);
    // Nobody is left to tell.
    expect(
      await testDb
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.idempotencyKey, `flow-run-failed:${runId}`)),
    ).toEqual([]);

    // A redelivered final-attempt event finds the run terminal and does nothing.
    await failFlowRunFromWorker(job, stepError, {
      database:
        asTestRaw<Parameters<typeof failFlowRunFromWorker>[2]["database"]>(
          testDb,
        ),
      makeScopedDb,
      broadcastUpdate: (broadcastWorkspaceId) => {
        broadcasts.push(broadcastWorkspaceId);
      },
    });
    expect(broadcasts).toEqual([workspaceId]);
  });
});
