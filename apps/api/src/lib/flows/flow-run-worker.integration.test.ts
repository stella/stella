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

import { Panic, Result, UnhandledException } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { and, asc, eq } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { inspectDocxPackage } from "@stll/folio-core/server";
import { parseTimeZoneId } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  taskAssignees,
  fields,
  flowDefinitions,
  flowRunSteps,
  notifications,
  organizationSettings,
  properties,
  WORK_OBLIGATION_SOURCE,
  WORK_OBLIGATION_STATUS,
  workObligations,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { envBase } from "@/api/env-base";
import { createUpdateKanbanPlacement } from "@/api/handlers/fields/kanban-placement/update";
import readTaskById from "@/api/handlers/tasks/get";
import transitionWorkObligation from "@/api/handlers/work-obligations/transition";
import updateWorkObligation from "@/api/handlers/work-obligations/update";
import { removeWorkspaceMemberHandler } from "@/api/handlers/workspaces/members/remove";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import type { CreateEntityFromBufferDependencies } from "@/api/lib/entities/create-from-buffer";
import {
  ProviderCallError,
  PROVIDER_CALL_ERROR_MESSAGE,
} from "@/api/lib/errors/provider-call-error";
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
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { updateTaskHandler } from "@/api/lib/tasks/update-task";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import {
  instanceWireErrorModel,
  providerCallErrorCassettes,
  providerCallErrorSentinel,
} from "@/api/tests/helpers/provider-call-error-wire";
import { installProviderWireReplay } from "@/api/tests/helpers/provider-wire-replay";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
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
const flushedEntityIds: (readonly SafeId<"entity">[])[] = [];
const flushSearchRepairs = async (entityIds: readonly SafeId<"entity">[]) => {
  flushedEntityIds.push(entityIds);
  return { failed: 0, repaired: 0 };
};
const updateKanbanPlacement = createUpdateKanbanPlacement({
  flushSearchRepairs,
});

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

// The test model ignores which organization admitted it.
const TEST_FLOW_MODEL_ADMISSION =
  testModelAdmission(mintAuthProviderId<"organization">());

const executeFlowStepWithTestModel = async (
  job: Parameters<typeof executeFlowStep>[0],
  signal: AbortSignal,
) =>
  await executeFlowStep(job, signal, {
    generateTextForRole: generateTextForTest,
    admission: TEST_FLOW_MODEL_ADMISSION,
    database: flowDatabase,
    makeScopedDb,
    makeSafeDb,
    enqueueStep: enqueueFlowStepMock,
    broadcastUpdate,
    createEntity,
    loadAIConfig: async () => Result.ok(null),
    // Governed workflow on: the gate's task must carry an obligation.
    taskFeatures: { governedWorkflow: true, legalLists: false },
    flushSearchRepairs,
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

const SENTINEL_FOREIGN_TEXT = "foreign exception text must not be persisted";

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
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId,
      role: "owner",
      createdAt: new Date(),
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

  beforeEach(() => {
    enqueuedSteps.length = 0;
    enqueueFlowStepMock.mockClear();
    generateTanStackTextForRoleMock.mockClear();
    flushedEntityIds.length = 0;
  });

  afterAll(async () => {
    fake.stop();
    await releaseTestDb();
  });

  const createWaitingGate = async (
    governedWorkflow: boolean,
    {
      nextStep = CREATE_DOCUMENT_STEP,
      initialStep = REVIEW_GATE_STEP,
      initialRunStatus = "awaiting_review",
    }: {
      nextStep?: FlowStep;
      initialStep?: FlowStep;
      initialRunStatus?: "pending" | "awaiting_review";
    } = {},
  ) => {
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Task-owned review flow",
      steps: [initialStep, nextStep],
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
    if (initialRunStatus === "pending") {
      const taskEntityId = createSafeId<"entity">();
      await testDb.insert(entities).values({
        id: taskEntityId,
        workspaceId,
        kind: "task",
        name: "Review task",
        status: "open",
      });
      if (governedWorkflow) {
        await testDb.insert(workObligations).values({
          entityId: taskEntityId,
          workspaceId,
          sourceType: WORK_OBLIGATION_SOURCE.FLOW,
          status: WORK_OBLIGATION_STATUS.ACTIVE,
          ownerUserId: userId,
          acknowledgedAt: new Date(),
          acknowledgedByUserId: userId,
          createdByUserId: userId,
        });
      }
      await testDb
        .update(flowRunSteps)
        .set({ reviewTaskEntityId: taskEntityId })
        .where(and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, 0)));
    } else {
      await executeFlowStep(
        { runId, stepIndex: 0 },
        new AbortController().signal,
        {
          admission: testModelAdmission(organizationId),
          database: flowDatabase,
          makeScopedDb,
          makeSafeDb,
          enqueueStep: enqueueFlowStepMock,
          broadcastUpdate,
          taskFeatures: { governedWorkflow, legalLists: false },
          flushSearchRepairs,
        },
      );
    }
    const gate = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { status: true, reviewTaskEntityId: true },
    });
    expect(gate?.status).toBe(initialRunStatus);
    const taskEntityId = gate?.reviewTaskEntityId;
    if (!taskEntityId) {
      throw new Error("expected the waiting gate to own a task");
    }
    if (initialRunStatus === "awaiting_review") {
      expect(flushedEntityIds.at(-1)).toEqual([taskEntityId]);
    }
    const obligation = await testDb.query.workObligations.findFirst({
      where: { entityId: { eq: taskEntityId } },
    });
    expect(obligation !== undefined).toBe(governedWorkflow);
    const recordAuditEvent = async () => undefined;
    const context = createTestHandlerContext({
      safeDb,
      scopedDb: asTestRaw<ScopedDb>(
        createScopedDb(testDb, [workspaceId], organizationId, userId),
      ),
      workspaceId,
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
      recordAuditEvent,
      createAuditRecorder: () => recordAuditEvent,
      orgAIConfig: null,
      managedAIResidency: "eu",
      request: new Request("https://example.test/review-task"),
    });
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

  test.each([
    [true, "done", "Kanban"],
    [true, "cancelled", "Kanban"],
    [false, "done", "Kanban"],
    [false, "cancelled", "Kanban"],
    [true, "done", "save_task"],
    [true, "cancelled", "save_task"],
    [false, "done", "save_task"],
    [false, "cancelled", "save_task"],
  ] as const)(
    "settled review status replay applies other edits with governed=%s, status=%s, path=%s",
    async (governedWorkflow, status, path) => {
      const { runId, taskEntityId, safeDb, context } =
        await createWaitingGate(governedWorkflow);
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
      // Persisted settled tasks may carry either closing status. The run
      // decision remains authoritative when such a task is edited again.
      await testDb
        .update(entities)
        .set({ status })
        .where(eq(entities.id, taskEntityId));
      await testDb
        .update(workObligations)
        .set({
          status:
            status === "done"
              ? WORK_OBLIGATION_STATUS.COMPLETED
              : WORK_OBLIGATION_STATUS.CANCELLED,
        })
        .where(eq(workObligations.entityId, taskEntityId));
      const before = await testDb.query.flowRunSteps.findMany({
        where: { runId: { eq: runId } },
        orderBy: { index: "asc" },
      });
      const previousGovernedWorkflow = env.FEATURE_GOVERNED_WORKFLOW;
      env.FEATURE_GOVERNED_WORKFLOW = governedWorkflow;
      try {
        if (path === "Kanban") {
          const lanePropertyId = createSafeId<"property">();
          await testDb.insert(properties).values({
            id: lanePropertyId,
            workspaceId,
            name: "Lane",
            status: "fresh",
            content: { type: "text", version: 1 },
            tool: { type: "manual-input", version: 1 },
          });
          const flushCount = flushedEntityIds.length;
          expect(
            await updateKanbanPlacement.handler(
              asTestRaw<Parameters<typeof updateKanbanPlacement.handler>[0]>({
                ...context,
                body: {
                  entityId: taskEntityId,
                  status,
                  fields: [
                    {
                      propertyId: lanePropertyId,
                      content: { type: "text", version: 1, value: "Reviewed" },
                    },
                  ],
                },
              }),
            ),
          ).toEqual({});
          expect(flushedEntityIds.slice(flushCount)).toEqual([[taskEntityId]]);
          const lane = await testDb.query.fields.findFirst({
            where: { propertyId: { eq: lanePropertyId } },
            columns: { content: true },
          });
          expect(lane?.content).toEqual({
            type: "text",
            version: 1,
            value: "Reviewed",
          });
        } else {
          const mcpContext = {
            accessibleWorkspaceIds: [workspaceId],
            accessibleWorkspaceIdSet: new Set([workspaceId]),
            accessibleWorkspaceStatusById: new Map([
              [workspaceId, "active" as const],
            ]),
            accessibleWorkspaces: [],
            grantedScopes: [],
            memberRole: "owner",
            organizationId,
            recordAuditEvent: context.recordAuditEvent,
            safeDb,
            scopedDb: asTestRaw<McpRequestContext["scopedDb"]>(
              context.scopedDb,
            ),
            userId,
            userEmail: `${userId}@example.com`,
          } satisfies McpRequestContext;
          const result = await handleMcpToolCall({
            toolName: "save_task",
            args: { task_id: taskEntityId, status, name: "Reviewed task" },
            context: mcpContext,
          });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toEqual({
            taskId: taskEntityId,
            updated: true,
          });
          const task = await testDb.query.entities.findFirst({
            where: { id: { eq: taskEntityId } },
            columns: { name: true },
          });
          expect(task?.name).toBe("Reviewed task");
        }
      } finally {
        env.FEATURE_GOVERNED_WORKFLOW = previousGovernedWorkflow;
      }
      const after = await testDb.query.flowRunSteps.findMany({
        where: { runId: { eq: runId } },
        orderBy: { index: "asc" },
      });
      expect(after).toEqual(before);
      expect(
        await testDb.query.entities.findFirst({
          where: { id: { eq: taskEntityId } },
          columns: { status: true },
        }),
      ).toEqual({ status });
      expect(enqueuedSteps.filter((step) => step.runId === runId)).toEqual([]);
    },
  );

  test("a review gate's task is due on the organization's day", async () => {
    // 12:00 UTC on 10 June is already 02:00 on 11 June in UTC+14.
    const timeZone = parseTimeZoneId("Pacific/Kiritimati");
    await testDb
      .insert(organizationSettings)
      .values({
        id: createSafeId<"organizationSettings">(),
        organizationId,
        timeZone,
      })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { timeZone },
      });
    setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    try {
      const { taskEntityId } = await createWaitingGate(true);
      const obligation = await testDb.query.workObligations.findFirst({
        where: { entityId: { eq: taskEntityId } },
        columns: { workingTargetDate: true },
      });
      expect(obligation?.workingTargetDate).toBe("2026-06-11");
    } finally {
      setSystemTime();
      await testDb
        .update(organizationSettings)
        .set({ timeZone: null })
        .where(eq(organizationSettings.organizationId, organizationId));
    }
  });

  test("deleting a review task leaves its waiting gate decidable from the run panel", async () => {
    const { runId, taskEntityId, safeDb } = await createWaitingGate(true);
    await testDb.delete(entities).where(eq(entities.id, taskEntityId));
    expect(
      await testDb.query.flowRunSteps.findFirst({
        where: { runId: { eq: runId }, index: { eq: 0 } },
        columns: { status: true, reviewTaskEntityId: true },
      }),
    ).toEqual({ status: "awaiting_review", reviewTaskEntityId: null });
    const resolved = await resolveFlowReviewGate({
      safeDb,
      workspaceId,
      organizationId,
      runId,
      userId,
      decision: "approved",
      note: null,
      recordAuditEvent: async () => undefined,
    });
    if (Result.isError(resolved)) {
      throw resolved.error;
    }
    expect(resolved.value.status).toBe("running");
    expect(
      await testDb.query.flowRunSteps.findFirst({
        where: { runId: { eq: runId }, index: { eq: 0 } },
        columns: { status: true, output: true },
      }),
    ).toEqual({
      status: "completed",
      output: { kind: "review-gate", decision: "approved", userId, note: null },
    });
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 1 });
  });

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
    const { runId, taskEntityId, safeDb } = await createWaitingGate(true, {
      nextStep: REVIEW_GATE_STEP,
    });
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
      const { runId, taskEntityId, safeDb } = await createWaitingGate(false, {
        initialRunStatus: "pending",
      });
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
        notices: await testDb
          .select()
          .from(notifications)
          .where(eq(notifications.entityId, runId))
          .orderBy(asc(notifications.id)),
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
              admission: testModelAdmission(organizationId),
              database: flowDatabase,
              makeScopedDb: gatedMakeScopedDb,
              makeSafeDb,
              enqueueStep: enqueueFlowStepMock,
              broadcastUpdate,
              taskFeatures: { governedWorkflow: false, legalLists: false },
              flushSearchRepairs,
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
    const { runId, taskEntityId, safeDb } = await createWaitingGate(false, {
      initialRunStatus: "pending",
      initialStep: AI_STEP,
    });
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
      notices: await testDb
        .select()
        .from(notifications)
        .where(eq(notifications.entityId, runId))
        .orderBy(asc(notifications.id)),
    });
    const worker = executeFlowStep(
      { runId, stepIndex: 0 },
      new AbortController().signal,
      {
        admission: testModelAdmission(organizationId),
        database: flowDatabase,
        makeScopedDb,
        makeSafeDb,
        generateTextForRole,
        loadAIConfig: async () => Result.ok(null),
        enqueueStep: enqueueFlowStepMock,
        broadcastUpdate,
        taskFeatures: { governedWorkflow: false, legalLists: false },
        flushSearchRepairs,
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

  test.each(["approved", "rejected", "closed"] as const)(
    "an eligible member can finish an unassigned review gate: %s",
    async (decision) => {
      const reviewer = mintAuthProviderId<"user">();
      await testDb.insert(user).values({
        id: reviewer,
        name: "Departing reviewer",
        email: `${reviewer}@example.test`,
      });
      await testDb.insert(member).values({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId: reviewer,
        role: "member",
        createdAt: new Date(),
      });
      await testDb
        .insert(workspaceMembers)
        .values({ workspaceId, userId: reviewer });
      const definitionId = createSafeId<"flowDefinition">();
      await testDb.insert(flowDefinitions).values({
        id: definitionId,
        organizationId,
        name: "Unassigned review",
        steps: [REVIEW_GATE_STEP],
        trigger: MANUAL_TRIGGER,
        enabled: true,
        createdByUserId: reviewer,
      });
      const reviewerDb = asTestRaw<SafeDb>(
        createSafeDb(testDb, [workspaceId], organizationId, reviewer),
      );
      const started = await startFlowRun({
        safeDb: reviewerDb,
        workspaceId,
        organizationId,
        definitionId,
        triggerSource: { type: "manual", userId: reviewer },
        inputEntityIds: [],
        enqueueStep: enqueueFlowStepMock,
      });
      if (Result.isError(started)) {
        throw started.error;
      }
      const runId = started.value.runId;
      await executeFlowStepWithTestModel(
        { runId, stepIndex: 0 },
        new AbortController().signal,
      );
      const raised = await loadReviewTask(runId, 0);
      expect(
        await testDb.$count(taskAssignees, eq(taskAssignees.userId, reviewer)),
      ).toBe(1);
      const safeDb = asTestRaw<SafeDb>(
        createSafeDb(testDb, [workspaceId], organizationId, userId),
      );
      const removed = await Result.gen(() =>
        removeWorkspaceMemberHandler({
          safeDb,
          workspaceId,
          userId: reviewer,
          actorUserId: userId,
          recordAuditEvent: async () => undefined,
          dependencies: {
            broadcastSessionEvent: () => undefined,
            broadcastWorkspaceResourceSetUpdated: () => undefined,
            closeSessionConnections: () => undefined,
            revokeWorkspaceSseAccess: async () => undefined,
          },
        }),
      );
      if (Result.isError(removed)) {
        throw removed.error;
      }
      expect(
        await testDb.$count(
          taskAssignees,
          eq(taskAssignees.entityId, raised.taskEntityId),
        ),
      ).toBe(0);
      expect(
        await testDb.$count(entities, eq(entities.id, raised.taskEntityId)),
      ).toBe(1);
      if (decision === "closed") {
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
      } else {
        const resolved = await resolveFlowReviewGate({
          safeDb,
          workspaceId,
          organizationId,
          runId,
          userId,
          decision,
          note: null,
          recordAuditEvent: async () => undefined,
        });
        if (Result.isError(resolved)) {
          throw resolved.error;
        }
      }
      const run = await testDb.query.flowRuns.findFirst({
        where: { id: { eq: runId } },
        columns: { status: true },
      });
      expect(run?.status).toBe(
        decision === "rejected" ? "cancelled" : "completed",
      );
      expect((await loadReviewTask(runId, 0)).obligation.status).toBe(
        WORK_OBLIGATION_STATUS.COMPLETED,
      );
    },
  );

  test("a queued step revalidates its actor before invoking the model", async () => {
    const departed = mintAuthProviderId<"user">();
    await testDb.insert(user).values({
      id: departed,
      name: "Former actor",
      email: `${departed}@example.test`,
    });
    await testDb.insert(member).values({
      id: Bun.randomUUIDv7(),
      organizationId,
      userId: departed,
      role: "member",
      createdAt: new Date(),
    });
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Actor checked step",
      steps: [AI_STEP],
      trigger: MANUAL_TRIGGER,
      enabled: true,
      createdByUserId: departed,
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
      triggerSource: { type: "manual", userId: departed },
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const calls = generateTanStackTextForRoleMock.mock.calls.length;
    const attempted = await Result.tryPromise(
      async () =>
        await executeFlowStepWithTestModel(
          { runId: started.value.runId, stepIndex: 0 },
          new AbortController().signal,
        ),
    );
    expect(Result.isError(attempted)).toBe(true);
    if (Result.isError(attempted)) {
      expect(attempted.error.cause).toBeInstanceOf(FlowStepError);
    }
    expect(generateTanStackTextForRoleMock.mock.calls.length).toBe(calls);
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

  test.each(providerCallErrorCassettes())(
    "provider failure settles a flow with $scenario/$variant",
    async (cassette) => {
      const definitionId = createSafeId<"flowDefinition">();
      await testDb.insert(flowDefinitions).values({
        id: definitionId,
        organizationId,
        name: "Provider failure flow",
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
        triggerSource: { type: "manual", userId },
        inputEntityIds: [],
        enqueueStep: enqueueFlowStepMock,
      });
      if (Result.isError(started)) {
        throw started.error;
      }
      const { runId } = started.value;
      const job = { runId, stepIndex: 0 };
      const replay = installProviderWireReplay({ retryAfterMs: 1 });
      const analytics = installRecordingAnalytics();
      const logs = installRecordingLogger();
      const previousMockAI = env.USE_MOCK_AI;
      env.USE_MOCK_AI = false;
      try {
        replay.serve(cassette);
        const model = instanceWireErrorModel(cassette.model);
        const failure = await Result.tryPromise(async () =>
          executeFlowStep(job, new AbortController().signal, {
            admission: testModelAdmission(organizationId),
            database: flowDatabase,
            makeScopedDb,
            makeSafeDb,
            enqueueStep: enqueueFlowStepMock,
            broadcastUpdate,
            loadAIConfig: async () => Result.ok(null),
            generateTextForRole: async (options) =>
              generateTanStackTextForRole({
                ...options,
                resolveTextModel: async () => model,
              }),
          }),
        );
        expect(Result.isError(failure)).toBe(true);
        if (Result.isOk(failure)) {
          throw new TypeError("The provider fixture fails the step");
        }
        const error = failure.error.cause;
        expect(error).toBeInstanceOf(ProviderCallError);
        if (!(error instanceof ProviderCallError)) {
          throw new TypeError("The step returns a provider failure");
        }
        // The executor throws this message to the queue's retry contract.
        expect(error.message).toBe(PROVIDER_CALL_ERROR_MESSAGE);
        const exchange = cassette.exchanges.at(0);
        if (exchange === undefined) {
          throw new TypeError("The fixture has an exchange");
        }
        expect(error.providerStatus).toBe(exchange.response.status);
        expect(error.provider).toBe("openrouter");
        expect(error.keySource).toBe("instance");
        expect(error.requestId).toBe(exchange.response.headers["x-request-id"]);
        if (cassette.expect.outcome !== "error") {
          throw new TypeError("The fixture has an error outcome");
        }
        expect(error.kind).toBe(cassette.expect.errorKind);
        await failFlowRunFromWorker(job, error, {
          database:
            asTestRaw<Parameters<typeof failFlowRunFromWorker>[2]["database"]>(
              testDb,
            ),
          makeScopedDb,
          broadcastUpdate,
        });
        const run = await testDb.query.flowRuns.findFirst({
          where: { id: { eq: runId } },
          columns: { error: true, status: true },
        });
        const step = await testDb.query.flowRunSteps.findFirst({
          where: { runId: { eq: runId }, index: { eq: 0 } },
          columns: { error: true, status: true },
        });
        expect(run).toEqual({
          status: "failed",
          error: PROVIDER_CALL_ERROR_MESSAGE,
        });
        expect(step).toEqual({
          status: "failed",
          error: PROVIDER_CALL_ERROR_MESSAGE,
        });
        expect(replay.requests().length).toBeGreaterThan(0);
        expect(replay.takeFindings()).toEqual({
          unconsumed: [],
          unexpected: [],
        });
        expect(logs.records.length).toBeGreaterThan(0);
        expect(analytics.exceptions()).toEqual([]);
        expect(
          JSON.stringify({
            error,
            run,
            step,
            logs: logs.records,
            analytics: analytics.events,
          }),
        ).not.toContain(providerCallErrorSentinel(cassette));
      } finally {
        env.USE_MOCK_AI = previousMockAI;
        logs.restore();
        analytics.restore();
        replay.restore();
      }
    },
  );

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

  test.each([
    ["Panic", new Panic({ message: SENTINEL_FOREIGN_TEXT })],
    [
      "UnhandledException",
      new UnhandledException({ cause: SENTINEL_FOREIGN_TEXT }),
    ],
  ])("stores a safe fallback for %s worker errors", async (_name, error) => {
    expect(error.message).toContain(SENTINEL_FOREIGN_TEXT);
    const definitionId = createSafeId<"flowDefinition">();
    await testDb.insert(flowDefinitions).values({
      id: definitionId,
      organizationId,
      name: "Worker error flow",
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
      triggerSource: { type: "manual", userId },
      inputEntityIds: [],
      enqueueStep: enqueueFlowStepMock,
    });
    if (Result.isError(started)) {
      throw started.error;
    }
    const { runId } = started.value;
    expect(enqueuedSteps.pop()).toEqual({ runId, stepIndex: 0 });

    await failFlowRunFromWorker({ runId, stepIndex: 0 }, error, {
      database:
        asTestRaw<Parameters<typeof failFlowRunFromWorker>[2]["database"]>(
          testDb,
        ),
      makeScopedDb,
      broadcastUpdate,
    });

    const run = await testDb.query.flowRuns.findFirst({
      where: { id: { eq: runId } },
      columns: { error: true, status: true },
    });
    const step = await testDb.query.flowRunSteps.findFirst({
      where: { runId: { eq: runId }, index: { eq: 0 } },
      columns: { error: true, status: true },
    });
    expect(run).toEqual({ status: "failed", error: "Flow step failed" });
    expect(step).toEqual({ status: "failed", error: "Flow step failed" });
    expect(JSON.stringify({ run, step })).not.toContain(SENTINEL_FOREIGN_TEXT);
  });
});
