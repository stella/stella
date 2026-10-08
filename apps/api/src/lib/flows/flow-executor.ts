import { panic, Result, TaggedError } from "better-result";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  lt,
  TransactionRollbackError,
} from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { drainFanOut } from "@stll/concurrency";
import { Temporal, todayFor } from "@stll/time";

import type { rootDb, Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { abortTransaction, resultTx } from "@/api/db/safe-db";
import {
  entities,
  flowRuns,
  workspaces,
  flowRunSteps,
  WORK_OBLIGATION_SOURCE,
  workspaceMembers,
} from "@/api/db/schema";
import { resolveCaching } from "@/api/lib/ai-config";
import {
  loadManagedAIResidency,
  loadOrgAIConfig,
} from "@/api/lib/ai-config-loader";
import { captureError } from "@/api/lib/analytics/capture";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditExecutionContext, AuditRecorder } from "@/api/lib/audit-log";
import { resolveMemberAuthorization } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { markdownToStellaDocx } from "@/api/lib/docx-authoring/from-markdown";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { lockWorkspacesForEntityCap } from "@/api/lib/entity-cap-lock";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { applicationErrorMessage } from "@/api/lib/errors/application-error-message";
import { FlowStepError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  isFlowEffectAdmitted,
  requireFlowEffectAdmission,
} from "@/api/lib/flows/effect-admission";
import {
  flowRunActorExists,
  flowRunCompletedNotification,
  resolveActorUserId,
} from "@/api/lib/flows/flow-run-actor";
import { notifyFlowRunActorOfCompletion } from "@/api/lib/flows/flow-run-completion-notice";
import {
  broadcastFlowRunUpdate,
  type FlowRunUpdatePayload,
} from "@/api/lib/flows/flow-run-events";
import type { FlowStepJobData } from "@/api/lib/flows/flow-run-queue";
import { enqueueFlowStep } from "@/api/lib/flows/flow-run-queue";
import {
  advanceAfterStep,
  canReviewFlowRun,
  isTerminalFlowRunStatus,
  resolveReviewGateTransition,
} from "@/api/lib/flows/flow-run-transitions";
import {
  FLOW_AI_STEP_MAX_OUTPUT_TOKENS,
  FLOW_DOCUMENT_CONTEXT_CHAR_CAP,
  FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP,
  FLOW_STEP_LEASE_MS,
  MAX_FLOW_STEPS,
} from "@/api/lib/flows/flow-types";
import type {
  FlowReviewDecision,
  FlowRunStatus,
  FlowRunStepStatus,
  FlowStep,
  FlowStepOutput,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import {
  createNotificationsInTransaction,
  pingNotificationRecipients,
} from "@/api/lib/notifications";
import { failureSink } from "@/api/lib/observability/failure";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { readWorkspaceOrganizationTimeZone } from "@/api/lib/organization-time-zone";
import type { ModelDispatchAdmission } from "@/api/lib/rate-limit/model-dispatch-admission";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedFlowRunId } from "@/api/lib/safe-id-boundaries";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { createTaskEntityHandler } from "@/api/lib/tasks/create-task-entity";
import { deployedTaskFeatures } from "@/api/lib/tasks/deployment-features";
import type { TaskDeploymentFeatures } from "@/api/lib/tasks/deployment-features";
import { lockWorkObligation } from "@/api/lib/work-obligations/lock-work-obligation";
import { settleWorkObligation } from "@/api/lib/work-obligations/settle-work-obligation";
import { WORK_OBLIGATION_SOURCE_SETTLEMENT } from "@/api/lib/work-obligations/transitions";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * The flow run engine. `executeFlowStep` runs one step of one run per BullMQ
 * job (throwing to trigger the queue's retry/backoff, since the queue boundary
 * is where throw-to-retry is the framework contract). `resolveFlowReviewGate`
 * and `cancelFlowRun` are request-time services consumed by the API handlers.
 */

const FLOW_AI_GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The value of a step's failable call, or the step failure that carries its
 * error: the one place a step turns a `Result` into the throw-to-retry the
 * queue boundary expects.
 */
const unwrapOrFlowStepError = <T>(
  result: Result<T, unknown>,
  message: string,
): T => {
  if (Result.isError(result)) {
    throw new FlowStepError({ message, cause: result.error });
  }
  return result.value;
};

export { FlowStepError } from "@/api/lib/errors/tagged-errors";

/**
 * The completion notice for a run a reviewer finished could not be filed.
 * The review has already committed, so this is observed, not answered.
 */
class FlowRunCompletionNoticeError extends TaggedError(
  "FlowRunCompletionNoticeError",
)<{
  message: string;
  cause: unknown;
  organizationId: SafeId<"organization">;
  runId: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
}> {}

const FLOW_RUN_COMPLETION_NOTICE_SINK = failureSink({
  event: "flow_run.completion_notice_failed",
  expected: [],
});

// ── Per-job step execution (queue side) ─────────────────

type HandleFlowStepStartOptions = {
  startedPayload:
    | null
    | { type: "paused" }
    | {
        type: "started";
        payload: FlowRunUpdatePayload;
        claimedStartedAt: TimestampCasToken;
      };
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"flowRun">;
  broadcastUpdate: typeof broadcastFlowRunUpdate;
};

const handleFlowStepStart = ({
  startedPayload,
  workspaceId,
  runId,
  broadcastUpdate,
}: HandleFlowStepStartOptions):
  | FlowStepExecutionOutcome
  | { status: "started"; claimedStartedAt: TimestampCasToken } => {
  if (startedPayload === null) {
    return { status: "completed" };
  }
  switch (startedPayload.type) {
    case "paused":
      logger.info("flow.work_skipped", { reason: "actor_not_granted", runId });
      return { status: "paused" };
    case "started":
      broadcastUpdate(workspaceId, startedPayload.payload);
      return {
        status: "started",
        claimedStartedAt: startedPayload.claimedStartedAt,
      };
    default:
      startedPayload satisfies never;
      return panic("Unknown flow step admission state");
  }
};

/**
 * Execute one step of a run. Idempotent: a retry after a successful step (or a
 * run that has since been cancelled/failed) no-ops. Throws on failure so the
 * BullMQ worker retries; the run is only flipped to `failed` from the worker's
 * final-attempt `failed` handler (`failFlowRunFromWorker`).
 */
export type FlowStepExecutionOutcome =
  | { status: "completed" }
  | { status: "paused" }
  | { status: "stale" };

type ExecuteFlowStepDependencies = {
  /**
   * The step job's admission. Null only when the worker found no tenant or
   * actor for the run, which the scope check below refuses before any step.
   */
  admission: ModelDispatchAdmission | null;
  onClaim?: (claimedStartedAt: TimestampCasToken) => void | Promise<void>;
  /** The worker's connection, for the run, step and scope reads. */
  database: Pick<typeof rootDb, "query" | "transaction">;
  now?: (() => Date) | undefined;
  /** External model-dispatch boundary; supplied by focused integration tests. */
  generateTextForRole?: typeof generateTanStackTextForRole | undefined;
  makeScopedDb?: typeof createRootScopedDb | undefined;
  makeSafeDb?: typeof createRootSafeDb | undefined;
  enqueueStep?: typeof enqueueFlowStep | undefined;
  broadcastUpdate?: typeof broadcastFlowRunUpdate | undefined;
  createEntity?: typeof createEntityFromBuffer | undefined;
  loadAIConfig?: typeof loadOrgAIConfig | undefined;
  /** Which task features the deployment enables; tests pin it. */
  taskFeatures?: TaskDeploymentFeatures | undefined;
  flushSearchRepairs?: typeof flushEntitySearchRepairs | undefined;
};

export const executeFlowStep = async (
  {
    runId: rawRunId,
    stepIndex,
    claimedStartedAt: retainedClaim,
  }: FlowStepJobData,
  signal: AbortSignal,
  {
    admission,
    database,
    now = () => new Date(Temporal.Now.instant().epochMilliseconds),
    generateTextForRole = generateTanStackTextForRole,
    makeScopedDb = createRootScopedDb,
    makeSafeDb = createRootSafeDb,
    enqueueStep = enqueueFlowStep,
    broadcastUpdate = broadcastFlowRunUpdate,
    createEntity = createEntityFromBuffer,
    loadAIConfig = loadOrgAIConfig,
    taskFeatures = deployedTaskFeatures(),
    flushSearchRepairs = flushEntitySearchRepairs,
    onClaim,
  }: ExecuteFlowStepDependencies,
): Promise<FlowStepExecutionOutcome> => {
  const runId = brandPersistedFlowRunId(rawRunId);
  const source = await loadExecutableFlowStep({ runId, stepIndex, database });
  if (source === null) {
    return { status: "completed" };
  }
  const { run } = source;

  const stepDef = run.definitionSnapshot.steps.at(stepIndex);
  if (!stepDef) {
    return panic("flow step index out of snapshot bounds");
  }

  const scope = await resolveRunScope(run, database);
  if (
    scope.actorUserId === null ||
    !(await flowRunActorExists(scope.actorUserId, database))
  ) {
    return await failFlowRunFromWorker(
      { runId, stepIndex },
      new FlowStepError({
        message: "The flow actor is no longer available.",
      }),
      {
        database,
        now,
        claimedStartedAt: retainedClaim,
        makeScopedDb,
        broadcastUpdate,
      },
    );
  }
  const actorUserId = scope.actorUserId;
  const scopedDb = makeScopedDb({
    organizationId: scope.organizationId,
    userId: actorUserId,
    workspaceIds: [run.workspaceId],
  });

  signal.throwIfAborted();

  // Mark the step (and run) running. Broadcast so the UI shows progress.
  const startedPayload = await scopedDb(async (tx) => {
    // Serialize the step boundary with grant/revoke, including an absent
    // enrolment row. Preflight admission alone can go stale before this write.
    const admitted = await isFlowEffectAdmitted({
      tx,
      organizationId: scope.organizationId,
      userId: actorUserId,
    });
    if (!admitted) {
      return { type: "paused" } as const;
    }
    const authorization = await resolveMemberAuthorization(
      {
        organizationId: scope.organizationId,
        workspaceId: run.workspaceId,
        userId: actorUserId,
      },
      tx,
    );
    if (!authorization?.workspace) {
      abortTransaction(
        new FlowStepError({
          message: "The workflow actor is no longer a member of this matter.",
        }),
      );
    }
    const current = await lockRunAndCurrentStep(tx, {
      workspaceId: run.workspaceId,
      runId,
    });
    if (
      current === undefined ||
      isTerminalFlowRunStatus(current.run.status) ||
      current.run.currentStepIndex !== stepIndex ||
      current.step?.status === "completed" ||
      current.step?.status === "skipped" ||
      current.step?.status === "awaiting_review"
    ) {
      return null;
    }
    if (
      current.step?.status === "running" &&
      !(await mayRecoverFlowStepClaim({
        tx,
        organizationId: scope.organizationId,
        actorUserId,
        startedAt: current.step.startedAt,
        token: current.step.startedAtToken,
        retainedClaim,
        now: now(),
      }))
    ) {
      return { type: "paused" } as const;
    }
    const startedAt = new Date(
      Math.max(now().getTime(), (current.step?.startedAt?.getTime() ?? 0) + 1),
    );
    const claimed = await tx
      .update(flowRunSteps)
      .set({ status: "running", startedAt })
      .where(
        and(
          eq(flowRunSteps.runId, runId),
          eq(flowRunSteps.index, stepIndex),
          timestampMatchesCasToken(
            flowRunSteps.startedAt,
            current.step?.startedAtToken ?? null,
          ),
        ),
      )
      .returning({ token: timestampCasToken(flowRunSteps.startedAt) });
    const claimedStartedAt =
      claimed.at(0)?.token ?? panic("Flow start claim missing");
    await tx
      .update(flowRuns)
      .set({ status: "running" })
      .where(eq(flowRuns.id, runId));
    return {
      type: "started",
      claimedStartedAt,
      payload: await readRunProgress(tx, runId),
    } as const;
  });
  const startOutcome = handleFlowStepStart({
    startedPayload,
    workspaceId: run.workspaceId,
    runId,
    broadcastUpdate,
  });
  if (startOutcome.status !== "started") {
    return startOutcome;
  }
  const { claimedStartedAt } = startOutcome;
  await onClaim?.(claimedStartedAt);
  return await executeClaimedFlowStep({
    claimedStartedAt,
    run,
    runId,
    stepIndex,
    stepDef,
    organizationId: scope.organizationId,
    actorUserId,
    scopedDb,
    admission,
    signal,
    broadcastUpdate,
    taskFeatures,
    flushSearchRepairs,
    makeSafeDb,
    generateTextForRole,
    loadAIConfig,
    enqueueStep,
    createEntity,
  });
};

type ExecuteClaimedFlowStepOptions = {
  claimedStartedAt: TimestampCasToken;
  run: LoadedRun;
  runId: SafeId<"flowRun">;
  stepIndex: number;
  stepDef: FlowStep;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  admission: ModelDispatchAdmission | null;
  signal: AbortSignal;
  broadcastUpdate: typeof broadcastFlowRunUpdate;
  taskFeatures: ReturnType<typeof deployedTaskFeatures>;
  flushSearchRepairs: typeof flushEntitySearchRepairs;
  makeSafeDb: typeof createRootSafeDb;
  generateTextForRole: typeof generateTanStackTextForRole;
  loadAIConfig: typeof loadOrgAIConfig;
  enqueueStep: typeof enqueueFlowStep;
  createEntity: typeof createEntityFromBuffer;
};

/** Dispatch only a claim that the database accepted under current admission. */
const executeClaimedFlowStep = async ({
  claimedStartedAt,
  run,
  runId,
  stepIndex,
  stepDef,
  organizationId,
  actorUserId,
  scopedDb,
  admission,
  signal,
  broadcastUpdate,
  taskFeatures,
  flushSearchRepairs,
  makeSafeDb,
  generateTextForRole,
  loadAIConfig,
  enqueueStep,
  createEntity,
}: ExecuteClaimedFlowStepOptions): Promise<FlowStepExecutionOutcome> => {
  switch (stepDef.kind) {
    case "review-gate":
      return await pauseAtReviewGate({
        claimedStartedAt,
        run,
        stepIndex,
        stepDef,
        organizationId,
        actorUserId,
        scopedDb,
        broadcastUpdate,
        taskFeatures,
        flushSearchRepairs,
      });
    case "ai": {
      const output = await runAiStep({
        admission:
          admission ??
          panic("flow ai step reached without the step job's admission"),
        stepDef,
        stepIndex,
        run,
        organizationId,
        actorUserId,
        scopedDb,
        safeDb: makeSafeDb({
          organizationId,
          userId: actorUserId,
          workspaceIds: [run.workspaceId],
        }),
        signal,
        generateTextForRole,
        loadAIConfig,
      });
      return await completeStepAndAdvance({
        claimedStartedAt,
        runId,
        stepIndex,
        stepCount: run.definitionSnapshot.steps.length,
        output,
        workspaceId: run.workspaceId,
        organizationId,
        actorUserId,
        flowName: run.definitionSnapshot.name,
        scopedDb,
        broadcastUpdate,
        enqueueStep,
      });
    }
    case "create-document": {
      return await runCreateDocumentStep({
        claimedStartedAt,
        stepDef,
        stepIndex,
        run,
        organizationId,
        actorUserId,
        scopedDb,
        createEntity,
        broadcastUpdate,
        enqueueStep,
      });
    }
    default:
      return panic("unhandled flow step kind");
  }
};

type LoadedRun = {
  id: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
  definitionId: SafeId<"flowDefinition"> | null;
  status: FlowRunStatus;
  currentStepIndex: number;
  triggerSource: FlowTriggerSource;
  inputEntityIds: SafeId<"entity">[];
  definitionSnapshot: { name: string; steps: FlowStep[] };
};

const loadRun = async (
  runId: SafeId<"flowRun">,
  database: Pick<typeof rootDb, "query">,
): Promise<LoadedRun | null> => {
  const row = await database.query.flowRuns.findFirst({
    where: { id: { eq: runId } },
    columns: {
      id: true,
      workspaceId: true,
      definitionId: true,
      status: true,
      currentStepIndex: true,
      triggerSource: true,
      inputEntityIds: true,
      definitionSnapshot: true,
    },
  });
  return row ?? null;
};

type RecoverFlowStepClaimOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  startedAt: Date | null;
  token: TimestampCasToken;
  retainedClaim: TimestampCasToken | undefined;
  now: Date;
};

const mayRecoverFlowStepClaim = async ({
  tx,
  organizationId,
  actorUserId,
  startedAt,
  token,
  retainedClaim,
  now,
}: RecoverFlowStepClaimOptions): Promise<boolean> => {
  if (startedAt === null) {
    return panic("Running flow step missing its claim timestamp");
  }
  if (
    retainedClaim === token ||
    startedAt.getTime() <= now.getTime() - FLOW_STEP_LEASE_MS
  ) {
    return true;
  }
  const grant = await tx.query.featureEnrolments.findFirst({
    where: {
      organizationId: { eq: organizationId },
      userId: { eq: actorUserId },
      featureId: { eq: "flows" },
    },
    columns: { createdAt: true },
  });
  return grant !== undefined && grant.createdAt.getTime() > startedAt.getTime();
};

type LoadExecutableFlowStepOptions = {
  runId: SafeId<"flowRun">;
  stepIndex: number;
  database: Pick<typeof rootDb, "query">;
};

const loadExecutableFlowStep = async ({
  runId,
  stepIndex,
  database,
}: LoadExecutableFlowStepOptions) => {
  const run = await loadRun(runId, database);
  if (!run) {
    logger.warn("flow.run_missing", { runId, stepIndex: String(stepIndex) });
    return null;
  }
  if (isTerminalFlowRunStatus(run.status)) {
    // Cancelled/failed/completed run: a queued step must not resurrect it.
    return null;
  }

  const step = await loadStep(runId, stepIndex, database);
  if (!step) {
    return panic("flow run step row missing for an in-flight run");
  }
  if (step.status === "completed" || step.status === "skipped") {
    return null; // A retry after this step already finished.
  }

  return { run, step };
};

const loadStep = (
  runId: SafeId<"flowRun">,
  stepIndex: number,
  database: Pick<typeof rootDb, "query">,
) =>
  database.query.flowRunSteps.findFirst({
    where: {
      runId: { eq: runId },
      index: { eq: stepIndex },
    },
    columns: { id: true, kind: true, status: true },
  });

type RunScope = {
  organizationId: SafeId<"organization">;
  // `null` only for an automated run whose definition author was deleted after
  // the run started; the trigger guarantees a non-null actor at start time.
  actorUserId: SafeId<"user"> | null;
};

const resolveRunScope = async (
  run: LoadedRun,
  database: Pick<typeof rootDb, "query">,
): Promise<RunScope> => {
  const workspace = await database.query.workspaces.findFirst({
    where: { id: { eq: run.workspaceId } },
    columns: { organizationId: true },
  });
  if (!workspace) {
    return panic("flow run references a workspace that no longer exists");
  }
  return {
    organizationId: workspace.organizationId,
    actorUserId: await resolveActorUserId(run, database),
  };
};

// ── Step executors ──────────────────────────────────────

type RunAiStepArgs = {
  admission: ModelDispatchAdmission;
  stepDef: Extract<FlowStep, { kind: "ai" }>;
  stepIndex: number;
  run: LoadedRun;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  safeDb: SafeDb;
  signal: AbortSignal;
  generateTextForRole: typeof generateTanStackTextForRole;
  loadAIConfig: typeof loadOrgAIConfig;
};

const FLOW_AI_SYSTEM_PROMPT =
  "You are a legal-workflow step executor. Follow the step instruction using the provided prior outputs and documents. Respond in Markdown with only the requested content, no preamble.";

const runAiStep = async ({
  admission,
  stepDef,
  stepIndex,
  run,
  organizationId,
  actorUserId,
  scopedDb,
  safeDb,
  signal,
  generateTextForRole,
  loadAIConfig,
}: RunAiStepArgs): Promise<FlowStepOutput> => {
  const priorOutputs = await scopedDb(
    async (tx) => await readPriorAiMarkdown(tx, run.id, stepIndex),
  );
  const documents = stepDef.includeDocuments
    ? await loadInputDocuments(scopedDb, organizationId, run.inputEntityIds)
    : [];

  const prompt = buildAiStepPrompt({
    instruction: stepDef.prompt,
    priorOutputs,
    documents,
  });

  const orgAIConfig = unwrapOrFlowStepError(
    await scopedDb(
      async (tx) =>
        await loadAIConfig(tx, { organizationId, userId: actorUserId }),
    ),
    "AI is not available for this organization.",
  );
  const managedAIResidency = await scopedDb(
    async (tx) => await loadManagedAIResidency(tx, organizationId),
  );
  // Every step settles against the organization's usage as it runs; the
  // initiator pre-flighted the whole run's estimate under the same action
  // type before enqueueing it.
  const analytics = createTanStackAIAnalyticsCallbacks({
    dataClass: "customer",
    feature: "flows.ai-step",
    modelRole: "chat",
    orgAIConfig,
    properties: {
      organization_id: organizationId,
      workspace_id: run.workspaceId,
      step_index: stepIndex,
    },
    traceId: Bun.randomUUIDv7(),
    usageMetering: {
      actionType: "background",
      organizationId,
      safeDb,
      serviceTier: "standard",
      userId: actorUserId,
      workspaceId: run.workspaceId,
    },
  });

  // `generateTanStackTextForRole` throws on provider/config failure; that is
  // exactly the retry signal the worker wants, so we let it propagate. Works
  // unchanged under `USE_MOCK_AI` (model resolution short-circuits to the mock
  // adapter). No tools are ever passed.
  const markdown = await generateTextForRole({
    dataClass: "customer",
    role: "chat",
    organizationId,
    admission,
    tenantWorkspaceIds: [run.workspaceId],
    orgAIConfig,
    managedAIResidency,
    analytics,
    system: FLOW_AI_SYSTEM_PROMPT,
    prompt,
    finishPolicy: "require-complete",
    // Enforced, not advisory: the initiator's estimate assumes this per
    // step, so the run cannot settle above what it was admitted for.
    maxOutputTokens: FLOW_AI_STEP_MAX_OUTPUT_TOKENS,
    caching: resolveCaching({
      promptCachingEnabled: false,
      role: "chat",
      scopeKey: organizationId,
    }),
    serviceTier: "standard",
    abortSignal: AbortSignal.any([
      signal,
      AbortSignal.timeout(FLOW_AI_GENERATION_TIMEOUT_MS),
    ]),
  });

  return { kind: "ai", markdown };
};

type FlowStepDocument = { label: string; text: string };

const capText = (value: string, cap: number): string =>
  value.length <= cap ? value : value.slice(0, cap);

const buildAiStepPrompt = ({
  instruction,
  priorOutputs,
  documents,
}: {
  instruction: string;
  priorOutputs: string[];
  documents: FlowStepDocument[];
}): string => {
  const sections: string[] = [`# Instruction\n\n${instruction}`];

  if (priorOutputs.length > 0) {
    const rendered = priorOutputs
      .map(
        (markdown, i) =>
          `## Prior step ${String(i + 1)}\n\n${capText(markdown, FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP)}`,
      )
      .join("\n\n");
    sections.push(`# Prior step outputs\n\n${rendered}`);
  }

  if (documents.length > 0) {
    const rendered = documents
      .map(
        (doc) =>
          `## ${doc.label}\n\n${capText(doc.text, FLOW_DOCUMENT_CONTEXT_CHAR_CAP)}`,
      )
      .join("\n\n");
    sections.push(`# Input documents\n\n${rendered}`);
  }

  return sections.join("\n\n");
};

const readPriorAiMarkdown = async (
  tx: Transaction,
  runId: SafeId<"flowRun">,
  stepIndex: number,
): Promise<string[]> => {
  const rows = await tx
    .select({ output: flowRunSteps.output })
    .from(flowRunSteps)
    .where(
      and(
        eq(flowRunSteps.runId, runId),
        lt(flowRunSteps.index, stepIndex),
        eq(flowRunSteps.status, "completed"),
      ),
    )
    .orderBy(asc(flowRunSteps.index))
    // Bounded: a run has at most MAX_FLOW_STEPS step rows (unique (runId,
    // index), snapshot length capped at start).
    .limit(MAX_FLOW_STEPS);

  const markdown: string[] = [];
  for (const row of rows) {
    if (row.output?.kind === "ai") {
      markdown.push(row.output.markdown);
    }
  }
  return markdown;
};

export const loadInputDocuments = async (
  scopedDb: ReturnType<typeof createRootScopedDb>,
  organizationId: SafeId<"organization">,
  entityIds: SafeId<"entity">[],
): Promise<FlowStepDocument[]> => {
  if (entityIds.length === 0) {
    return [];
  }

  // Detect unavailable inputs before reading or decrypting any content. A
  // selected input without an `extracted_content` row (extraction still pending
  // or failed, or a non-extraction entity that the summaries picker surfaced)
  // would otherwise drop out silently and let the step generate legal output
  // from an incomplete document set. Fail the step, naming the unavailable
  // inputs, instead of proceeding with fewer documents.
  const available = await scopedDb((tx) =>
    tx.query.extractedContent.findMany({
      where: { entityId: { in: entityIds } },
      columns: { entityId: true },
      limit: entityIds.length,
    }),
  );
  if (available.length < entityIds.length) {
    const loaded = new Set(available.map((row) => row.entityId));
    const missingIds = entityIds.filter((id) => !loaded.has(id));
    const missingEntities = await scopedDb((tx) =>
      tx.query.entities.findMany({
        where: { id: { in: missingIds } },
        columns: { name: true },
        limit: missingIds.length,
      }),
    );
    const names = missingEntities
      .map((row) => row.name)
      .filter((name) => name.length > 0);
    const named = names.length > 0 ? `: ${names.join(", ")}` : "";
    throw new FlowStepError({
      message: `${missingIds.length} selected input document(s) could not be loaded because their content is not available yet (extraction is still pending or has failed)${named}. Re-run this workflow once the document(s) have finished processing.`,
    });
  }

  const rows = await scopedDb((tx) =>
    tx.query.extractedContent.findMany({
      where: { entityId: { in: entityIds } },
      columns: { ciphertext: true, iv: true },
      with: { entity: { columns: { name: true } } },
      limit: entityIds.length,
    }),
  );

  const drained = await drainFanOut({
    items: rows,
    signal: new AbortController().signal,
    operation: async (row, signal) => {
      signal.throwIfAborted();
      return {
        label: row.entity?.name ?? "Document",
        text: await decryptContent(organizationId, row.ciphertext, row.iv),
      };
    },
  });
  if (Result.isError(drained)) {
    throw drained.error;
  }
  return drained.value;
};

/**
 * The audit identity of work a run performs on the actor's behalf: the flow
 * is the performer, and the trigger says whether a person dispatched it, a
 * schedule fired it, or an upload started it.
 */
const flowRunAuditRecorder = ({
  run,
  organizationId,
  actorUserId,
}: {
  run: LoadedRun;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
}): AuditRecorder => {
  const trigger = ((): AuditExecutionContext["trigger"] => {
    switch (run.triggerSource.type) {
      case "manual":
        return {
          source: "action",
          sourceId: run.id,
          type: "user_dispatch",
          userId: actorUserId,
        };
      case "schedule":
        return {
          ownerUserId: actorUserId,
          source: "flow",
          sourceId: run.definitionId ?? run.id,
          type: "schedule",
        };
      case "file-upload":
        return { source: "file-upload", type: "system" };
      default: {
        run.triggerSource satisfies never;
        return panic(`Unhandled trigger source: ${String(run.triggerSource)}`);
      }
    }
  })();

  return createAuditRecorder({
    execution: {
      performer: {
        type: "agent",
        id: run.definitionId
          ? `flow:${run.definitionId}`
          : `flow-run:${run.id}`,
        name: run.definitionSnapshot.name,
      },
      trigger,
      runId: run.id,
    },
    organizationId,
    workspaceId: run.workspaceId,
    userId: actorUserId,
    request: new Request("http://flow-run.internal/"),
    server: null,
  });
};

type ReviewTaskSettlement = keyof typeof WORK_OBLIGATION_SOURCE_SETTLEMENT;

/**
 * Settle the task a review gate raised once the gate is decided or the run
 * is cancelled. Under governed workflow the obligation carries the task and
 * is closed from whatever open status it holds; without it the task alone
 * records the outcome. A task already closed (or deleted) is left as it is.
 */
const settleReviewTask = async ({
  tx,
  taskEntityId,
  workspaceId,
  actorUserId,
  action,
  reason,
  recordAuditEvent,
}: {
  tx: Transaction;
  taskEntityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  actorUserId: SafeId<"user">;
  action: ReviewTaskSettlement;
  reason: string | null;
  recordAuditEvent: AuditRecorder;
}): Promise<void> => {
  const settlement = WORK_OBLIGATION_SOURCE_SETTLEMENT[action];
  const obligation = await lockWorkObligation(tx, {
    entityId: taskEntityId,
    workspaceId,
  });
  if (obligation === undefined) {
    await tx
      .update(entities)
      .set({ status: settlement.taskStatus, updatedAt: new Date() })
      .where(
        and(
          eq(entities.id, taskEntityId),
          eq(entities.workspaceId, workspaceId),
          eq(entities.kind, "task"),
          inArray(entities.status, [
            TASK_STATUS.OPEN,
            TASK_STATUS.IN_PROGRESS,
            TASK_STATUS.IN_REVIEW,
          ]),
        ),
      );
    return;
  }
  if (!settlement.from.some((status) => status === obligation.status)) {
    return;
  }
  await settleWorkObligation({
    tx,
    entityId: taskEntityId,
    workspaceId,
    actorUserId,
    action,
    transition: settlement,
    previousStatus: obligation.status,
    reason,
    recordAuditEvent,
  });
};

type RunCreateDocumentArgs = {
  claimedStartedAt: TimestampCasToken;
  stepDef: Extract<FlowStep, { kind: "create-document" }>;
  stepIndex: number;
  run: LoadedRun;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  createEntity: typeof createEntityFromBuffer;
  broadcastUpdate: typeof broadcastFlowRunUpdate;
  enqueueStep: typeof enqueueFlowStep;
};

const runCreateDocumentStep = async ({
  claimedStartedAt,
  stepDef,
  stepIndex,
  run,
  organizationId,
  actorUserId,
  scopedDb,
  createEntity,
  broadcastUpdate,
  enqueueStep,
}: RunCreateDocumentArgs): Promise<FlowStepExecutionOutcome> => {
  const priorMarkdown = await scopedDb(
    async (tx) => await readPriorAiMarkdown(tx, run.id, stepIndex),
  );
  const markdown = priorMarkdown.at(-1);
  if (markdown === undefined) {
    throw new FlowStepError({
      message:
        "The create-document step needs a preceding AI step output to render.",
    });
  }

  const docx = unwrapOrFlowStepError(
    await markdownToStellaDocx(markdown),
    "The generated content could not be rendered to a document.",
  );

  const recordAuditEvent = flowRunAuditRecorder({
    run,
    organizationId,
    actorUserId,
  });

  const completion: {
    result: Awaited<ReturnType<typeof completeStepInTransaction>> | undefined;
  } = { result: undefined };
  const completionArgs = {
    claimedStartedAt,
    runId: run.id,
    stepIndex,
    stepCount: run.definitionSnapshot.steps.length,
    workspaceId: run.workspaceId,
    organizationId,
    actorUserId,
    flowName: run.definitionSnapshot.name,
    scopedDb,
    broadcastUpdate,
    enqueueStep,
  };
  let admissionPaused = false;
  const created = await Result.tryPromise({
    try: async () =>
      await createEntity({
        scopedDb,
        organizationId,
        workspaceId: run.workspaceId,
        userId: actorUserId,
        recordAuditEvent,
        buffer: docx,
        // Pass the raw title: `createEntityFromBuffer` sanitizes with
        // `sanitizeFilenamePreservingExtension`, which truncates the base name
        // rather than the extension. Pre-sanitizing with the plain
        // `sanitizeFilename` here would drop the `.docx` for near-max-length titles
        // before the extension-preserving pass could protect it.
        fileName: `${stepDef.documentTitle}.docx`,
        mimeType: DOCX_MIME_TYPE,
        encryption: serverBuiltFileEncryption(),
        beforeCreate: async (tx) => {
          if (
            !(await isFlowEffectAdmitted({
              tx,
              organizationId,
              userId: actorUserId,
            }))
          ) {
            admissionPaused = true;
            tx.rollback();
          }
        },
        afterCreate: async (tx, document) => {
          // The entity creator holds the workspace cap lock before this run lock.
          // Keep the artifact and its owning step in the same commit: cancellation
          // or another worker winning the run lock rolls both back.
          completion.result = await completeStepInTransaction(tx, {
            ...completionArgs,
            output: { kind: "create-document", entityId: document.entityId },
          });
          if (
            completion.result === null ||
            completion.result.status !== "completed"
          ) {
            tx.rollback();
          }
        },
      }),
    catch: (cause) => cause,
  });
  if (
    (admissionPaused ||
      completion.result === null ||
      (completion.result !== undefined &&
        completion.result !== null &&
        completion.result.status !== "completed")) &&
    created.isErr() &&
    created.error instanceof TransactionRollbackError
  ) {
    if (admissionPaused) {
      return { status: "paused" };
    }
    if (
      completion.result !== undefined &&
      completion.result !== null &&
      completion.result.status !== "completed"
    ) {
      return completion.result;
    }
    return { status: "completed" };
  }
  unwrapOrFlowStepError(
    Result.flatten(created),
    "The document could not be created for this workspace (entity limit reached or missing file property).",
  );
  if (
    completion.result === null ||
    completion.result === undefined ||
    completion.result.status !== "completed"
  ) {
    panic("Created flow document without its owning step completion");
  }
  await publishCompletedStep(completionArgs, completion.result);
  return { status: "completed" };
};

// ── Shared transition writers ───────────────────────────

type CompleteStepArgs = {
  claimedStartedAt: TimestampCasToken;
  runId: SafeId<"flowRun">;
  stepIndex: number;
  stepCount: number;
  output: FlowStepOutput;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  flowName: string;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  broadcastUpdate: typeof broadcastFlowRunUpdate;
  enqueueStep: typeof enqueueFlowStep;
};

const completeStepInTransaction = async (
  tx: Transaction,
  {
    claimedStartedAt,
    runId,
    stepIndex,
    stepCount,
    output,
    workspaceId,
    organizationId,
    actorUserId,
    flowName,
  }: CompleteStepArgs,
) => {
  const admitted = await isFlowEffectAdmitted({
    tx,
    organizationId,
    userId: actorUserId,
  });
  const advance = advanceAfterStep({ stepIndex, stepCount });
  const now = new Date();

  const current = await lockRunAndCurrentStep(tx, { workspaceId, runId });
  if (
    current?.run.currentStepIndex === stepIndex &&
    current.step !== undefined &&
    current.step.startedAtToken !== claimedStartedAt
  ) {
    return { status: "stale" } as const;
  }
  if (
    current === undefined ||
    isTerminalFlowRunStatus(current.run.status) ||
    current.run.currentStepIndex !== stepIndex ||
    current.step?.status !== "running"
  ) {
    return null;
  }
  if (!admitted) {
    // The running claim remains recoverable; re-grant retries the current step.
    return { status: "paused" } as const;
  }
  await tx
    .update(flowRunSteps)
    .set({ status: "completed", output, finishedAt: now })
    .where(
      and(
        eq(flowRunSteps.runId, runId),
        eq(flowRunSteps.index, stepIndex),
        timestampMatchesCasToken(flowRunSteps.startedAt, claimedStartedAt),
      ),
    );

  if (advance.kind !== "finish") {
    await tx
      .update(flowRuns)
      .set({ status: "running", currentStepIndex: advance.nextStepIndex })
      .where(eq(flowRuns.id, runId));
    return {
      status: "completed",
      payload: await readRunProgress(tx, runId),
      pings: [],
    } as const;
  }

  await tx
    .update(flowRuns)
    .set({ status: "completed", finishedAt: now })
    .where(eq(flowRuns.id, runId));
  // Filed in the same transaction as the terminal status, so the badge and
  // the run can never disagree, and keyed on the run so a redelivered
  // worker job cannot raise it twice.
  const runPings = await createNotificationsInTransaction(
    [
      flowRunCompletedNotification({
        actorUserId,
        flowName,
        organizationId,
        runId,
        workspaceId,
      }),
    ],
    tx,
  );
  return {
    status: "completed",
    payload: await readRunProgress(tx, runId),
    pings: runPings,
  } as const;
};

const publishCompletedStep = async (
  {
    stepCount,
    stepIndex,
    workspaceId,
    runId,
    broadcastUpdate,
    enqueueStep,
  }: Omit<CompleteStepArgs, "output">,
  completed: Awaited<ReturnType<typeof completeStepInTransaction>>,
): Promise<void> => {
  const advance = advanceAfterStep({ stepIndex, stepCount });

  if (completed === null || completed.status !== "completed") {
    return;
  }
  const { payload, pings } = completed;
  broadcastUpdate(workspaceId, payload);
  pingNotificationRecipients(pings);

  if (advance.kind === "advance") {
    await enqueueStep({ runId, stepIndex: advance.nextStepIndex });
  }
};

const completeStepAndAdvance = async (
  args: CompleteStepArgs,
): Promise<FlowStepExecutionOutcome> => {
  const completed = await args.scopedDb(
    async (tx) => await completeStepInTransaction(tx, args),
  );
  await publishCompletedStep(args, completed);
  return completed !== null && completed.status !== "completed"
    ? completed
    : { status: "completed" };
};

/**
 * Raise the task a review gate hands its reviewer. A manual run's launcher is
 * a member of the matter; the author of an automated definition need not be
 * a member of every matter its trigger reaches. The task can only be
 * assigned to a member, so an outside author gets an unassigned task and the
 * bell notification the gate sends anyway.
 */
const raiseReviewTask = async ({
  tx,
  run,
  stepDef,
  actorUserId,
  features,
  recordAuditEvent,
}: {
  tx: Transaction;
  run: LoadedRun;
  stepDef: Extract<FlowStep, { kind: "review-gate" }>;
  actorUserId: SafeId<"user">;
  features: TaskDeploymentFeatures;
  recordAuditEvent: AuditRecorder;
}): Promise<SafeId<"entity">> => {
  const workspaceId = run.workspaceId;
  const membership = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, actorUserId),
      ),
    )
    .limit(1);
  const actorIsMember = membership.length > 0;
  const workingTargetDate = features.governedWorkflow
    ? todayFor(
        await readWorkspaceOrganizationTimeZone(tx, workspaceId),
      ).toString()
    : null;
  const task = await Result.gen(() =>
    createTaskEntityHandler({
      tx,
      workspaceId,
      userId: actorUserId,
      recordAuditEvent,
      body: {
        name: `${run.definitionSnapshot.name} · ${stepDef.name}`,
        assigneeIds: actorIsMember ? [actorUserId] : [],
        ...(features.governedWorkflow
          ? {
              ...(actorIsMember ? { ownerUserId: actorUserId } : {}),
              // A gate is due the moment the run reaches it, on the
              // organization's day.
              workingTargetDate,
            }
          : {}),
      },
      features,
      ...(features.governedWorkflow
        ? {
            workObligationSource: {
              type: WORK_OBLIGATION_SOURCE.FLOW,
              description: null,
            },
          }
        : {}),
    }),
  );
  return unwrapOrFlowStepError(
    task,
    "The review task for this gate could not be created.",
  ).entityId;
};

/**
 * Pause the run at a review gate. The gate raises a task for the run's actor
 * (the launcher, or the definition's author for an automated run) so the
 * decision sits in their task list and, under governed workflow, in My Work;
 * the bell notification stays as the ping. The step keeps the task it raised,
 * and settling either side settles the other.
 */
const pauseAtReviewGate = async ({
  claimedStartedAt,
  run,
  stepIndex,
  stepDef,
  organizationId,
  actorUserId,
  scopedDb,
  broadcastUpdate,
  taskFeatures,
  flushSearchRepairs,
}: {
  claimedStartedAt: TimestampCasToken;
  run: LoadedRun;
  stepIndex: number;
  stepDef: Extract<FlowStep, { kind: "review-gate" }>;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  broadcastUpdate: typeof broadcastFlowRunUpdate;
  taskFeatures: TaskDeploymentFeatures;
  flushSearchRepairs: typeof flushEntitySearchRepairs;
}): Promise<FlowStepExecutionOutcome> => {
  const runId = run.id;
  const workspaceId = run.workspaceId;
  const flowName = run.definitionSnapshot.name;
  const recordAuditEvent = flowRunAuditRecorder({
    run,
    organizationId,
    actorUserId,
  });
  const features = taskFeatures;
  const paused = await scopedDb(async (tx) => {
    if (
      !(await isFlowEffectAdmitted({ tx, organizationId, userId: actorUserId }))
    ) {
      return { status: "paused" } as const;
    }
    await lockWorkspacesForEntityCap(tx, [workspaceId]);
    const current = await lockRunAndCurrentStep(tx, { workspaceId, runId });
    if (
      current?.run.currentStepIndex === stepIndex &&
      current.step !== undefined &&
      current.step.startedAtToken !== claimedStartedAt
    ) {
      return { status: "stale" } as const;
    }
    if (
      current === undefined ||
      isTerminalFlowRunStatus(current.run.status) ||
      current.run.currentStepIndex !== stepIndex ||
      current.step?.status !== "running"
    ) {
      return null;
    }
    // A redelivered job must not raise a second task: the step keeps the one
    // it already raised and only the status writes below are repeated.
    const stepRows = await tx
      .select({ reviewTaskEntityId: flowRunSteps.reviewTaskEntityId })
      .from(flowRunSteps)
      .where(
        and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, stepIndex)),
      )
      .limit(1);
    const reviewTaskEntityId =
      stepRows.at(0)?.reviewTaskEntityId ??
      (await raiseReviewTask({
        tx,
        run,
        stepDef,
        actorUserId,
        features,
        recordAuditEvent,
      }));
    await tx
      .update(flowRunSteps)
      .set({ status: "awaiting_review", reviewTaskEntityId })
      .where(
        and(
          eq(flowRunSteps.runId, runId),
          eq(flowRunSteps.index, stepIndex),
          timestampMatchesCasToken(flowRunSteps.startedAt, claimedStartedAt),
        ),
      );
    await tx
      .update(flowRuns)
      .set({ status: "awaiting_review" })
      .where(eq(flowRuns.id, runId));
    const gatePings = await createNotificationsInTransaction(
      [
        {
          kind: NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL,
          metadata: { flowName },
          entityType: "flow_run",
          entityId: runId,
          workspaceId,
          organizationId,
          userId: actorUserId,
          idempotencyKey: `flow-run-review-gate:${runId}:${stepIndex}`,
        },
      ],
      tx,
    );
    return {
      status: "completed",
      payload: await readRunProgress(tx, runId),
      pings: gatePings,
      taskEntityId: reviewTaskEntityId,
    } as const;
  });
  if (paused === null) {
    return { status: "completed" };
  }
  if (paused.status !== "completed") {
    return paused;
  }
  const { payload, pings, taskEntityId } = paused;
  broadcastUpdate(workspaceId, payload);
  pingNotificationRecipients(pings);
  flushSearchRepairs([taskEntityId]).catch(captureError);
  return { status: "completed" };
};

const readRunProgress = async (
  tx: Transaction,
  runId: SafeId<"flowRun">,
): Promise<FlowRunUpdatePayload> => {
  const run = await tx
    .select({
      id: flowRuns.id,
      status: flowRuns.status,
      currentStepIndex: flowRuns.currentStepIndex,
    })
    .from(flowRuns)
    .where(eq(flowRuns.id, runId));
  const runRow = run.at(0) ?? panic("flow run vanished mid-transaction");

  const steps = await tx
    .select({ index: flowRunSteps.index, status: flowRunSteps.status })
    .from(flowRunSteps)
    .where(eq(flowRunSteps.runId, runId))
    .orderBy(asc(flowRunSteps.index))
    // Bounded: at most MAX_FLOW_STEPS step rows per run.
    .limit(MAX_FLOW_STEPS);

  return {
    runId: runRow.id,
    status: runRow.status,
    currentStepIndex: runRow.currentStepIndex,
    steps: steps.map((s) => ({ index: s.index, status: s.status })),
  };
};

// ── Worker failure finalization ─────────────────────────

const FLOW_STEP_FAILED_MESSAGE = "Flow step failed";

type FlowFailureClaimOptions = {
  step:
    | {
        status: FlowRunStepStatus;
        startedAt: Date | null;
        startedAtToken: TimestampCasToken;
      }
    | undefined;
  retainedClaim: TimestampCasToken | undefined;
  actorRemoved: boolean;
  now: Date;
};

const decideFlowFailureClaim = ({
  step,
  retainedClaim,
  actorRemoved,
  now,
}: FlowFailureClaimOptions) => {
  if (step === undefined) {
    return panic("Flow failure missing current step");
  }
  const expired =
    step.status === "running" &&
    step.startedAt !== null &&
    step.startedAt.getTime() <= now.getTime() - FLOW_STEP_LEASE_MS;
  if (
    retainedClaim !== step.startedAtToken &&
    !expired &&
    !(
      retainedClaim === undefined &&
      (actorRemoved || step.status === "pending")
    )
  ) {
    return { type: "stale" } as const;
  }
  return {
    type: "settle",
    token: step.startedAtToken,
    reclaimAt: expired ? now : null,
  } as const;
};

/**
 * Flip a run (and its current step) to `failed` after the worker exhausts its
 * retries. Reads the run on the worker's connection to recover its
 * workspace/org. Live actors retain their scoped writes; unavailable actors
 * settle with a recorded reason and preserved outputs. Terminal runs are a no-op.
 */
export const failFlowRunFromWorker = async (
  { runId: rawRunId, stepIndex }: FlowStepJobData,
  error: unknown,
  {
    database,
    claimedStartedAt,
    now: readNow = () => new Date(),
    makeScopedDb = createRootScopedDb,
    broadcastUpdate = broadcastFlowRunUpdate,
  }: {
    /** The worker's connection: the run and scope reads, and the write when the run has no actor left. */
    database: Pick<typeof rootDb, "query" | "transaction">;
    claimedStartedAt?: TimestampCasToken | undefined;
    now?: (() => Date) | undefined;
    makeScopedDb?: typeof createRootScopedDb | undefined;
    broadcastUpdate?: typeof broadcastFlowRunUpdate | undefined;
  },
): Promise<FlowStepExecutionOutcome> => {
  const runId = brandPersistedFlowRunId(rawRunId);
  const run = await loadRun(runId, database);
  if (!run || isTerminalFlowRunStatus(run.status)) {
    return { status: "completed" };
  }
  const scope = await resolveRunScope(run, database);
  const message = applicationErrorMessage(error, FLOW_STEP_FAILED_MESSAGE);
  const now = readNow();

  const writeFailure = async (tx: Transaction) => {
    const admitted = await isFlowEffectAdmitted({
      tx,
      organizationId: scope.organizationId,
      userId: scope.actorUserId,
    });
    const actorRemoved = !(await flowRunActorExists(scope.actorUserId, tx));
    const current = await lockRunAndCurrentStep(tx, {
      workspaceId: run.workspaceId,
      runId,
    });
    if (
      current === undefined ||
      isTerminalFlowRunStatus(current.run.status) ||
      current.run.currentStepIndex !== stepIndex ||
      current.run.status === "awaiting_review" ||
      current.step?.status === "awaiting_review"
    ) {
      return null;
    }
    const claim = decideFlowFailureClaim({
      step: current.step,
      retainedClaim: claimedStartedAt,
      actorRemoved,
      now,
    });
    if (claim.type === "stale") {
      return { status: "stale" } as const;
    }
    if (!actorRemoved && !admitted) {
      return { status: "paused" } as const;
    }
    const failureMessage = actorRemoved ? "actor-removed" : message;
    await tx
      .update(flowRunSteps)
      .set({
        status: "failed",
        error: failureMessage,
        finishedAt: now,
        ...(claim.reclaimAt === null ? {} : { startedAt: claim.reclaimAt }),
      })
      .where(
        and(
          eq(flowRunSteps.runId, runId),
          eq(flowRunSteps.index, stepIndex),
          timestampMatchesCasToken(flowRunSteps.startedAt, claim.token),
        ),
      );
    await tx
      .update(flowRuns)
      .set({
        status: "failed",
        recoveryState: actorRemoved ? "actor-removed" : null,
        error: failureMessage,
        finishedAt: now,
      })
      .where(
        and(
          eq(flowRuns.id, runId),
          eq(flowRuns.workspaceId, run.workspaceId),
          eq(flowRuns.currentStepIndex, stepIndex),
        ),
      );
    if (actorRemoved) {
      return { status: "actor-removed" } as const;
    }
    const actorUserId = scope.actorUserId;
    const pings =
      actorUserId === null
        ? []
        : await createNotificationsInTransaction(
            [
              {
                kind: NOTIFICATION_KIND.FLOW_RUN_FAILED,
                metadata: { flowName: run.definitionSnapshot.name },
                entityType: "flow_run",
                entityId: runId,
                workspaceId: run.workspaceId,
                organizationId: scope.organizationId,
                userId: actorUserId,
                idempotencyKey: `flow-run-failed:${runId}`,
              },
            ],
            tx,
          );
    return {
      status: "completed",
      payload: await readRunProgress(tx, runId),
      pings,
    } as const;
  };

  // Actor removal records a terminal reason without deleting outputs or admitting
  // another feature effect. A live actor's opt-out remains a recoverable pause.
  const actorAuthorization =
    scope.actorUserId === null
      ? null
      : await resolveMemberAuthorization(
          {
            organizationId: scope.organizationId,
            workspaceId: run.workspaceId,
            userId: scope.actorUserId,
          },
          database,
        );
  const failed =
    scope.actorUserId === null ||
    !actorAuthorization?.workspace ||
    !(await flowRunActorExists(scope.actorUserId, database))
      ? await withAggregateTransaction(database, writeFailure)
      : await makeScopedDb({
          organizationId: scope.organizationId,
          userId: scope.actorUserId,
          workspaceIds: [run.workspaceId],
        })(writeFailure);
  if (failed === null || failed.status === "actor-removed") {
    return { status: "completed" };
  }
  if (failed.status !== "completed") {
    return failed;
  }
  const { payload, pings } = failed;
  broadcastUpdate(run.workspaceId, payload);
  pingNotificationRecipients(pings);
  return { status: "completed" };
};

// ── Request-time services (handler side) ────────────────

/** Run status a review gate resolves the run to, by transition kind. */
const reviewGateNextStatus = (
  kind: "cancel" | "finish" | "advance",
): FlowRunStatus => {
  if (kind === "cancel") {
    return "cancelled";
  }
  if (kind === "finish") {
    return "completed";
  }
  return "running";
};

export type FlowRunActionResult = {
  runId: SafeId<"flowRun">;
  status: FlowRunStatus;
};

export type ResolveFlowReviewGateOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  runId: SafeId<"flowRun">;
  reviewTaskEntityId?: SafeId<"entity">;
  userId: SafeId<"user">;
  decision: FlowReviewDecision;
  note: string | null;
  /** Records the review task's settlement as the reviewer's own act. */
  recordAuditEvent: AuditRecorder;
};

type LockRunAndCurrentStepOptions = {
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"flowRun">;
};

/**
 * Existing workflow rows lock workspace → run → current step → obligation →
 * entity. Taking the workspace FK lock first also covers repeated entity
 * updates and field inserts inside an outer Kanban transaction. KEY SHARE
 * allows independent runs in one workspace to progress concurrently; creators
 * already hold the stronger workspace cap lock before entering this helper.
 */
const lockRunAndCurrentStep = async (
  tx: Transaction,
  { workspaceId, runId }: LockRunAndCurrentStepOptions,
) => {
  await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
    .for("key share");
  const runs = await tx
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.workspaceId, workspaceId)))
    .limit(1)
    .for("update");
  const run = runs.at(0);
  if (!run) {
    return undefined;
  }
  const steps = await tx
    .select({
      ...getTableColumns(flowRunSteps),
      startedAtToken: timestampCasToken(flowRunSteps.startedAt),
    })
    .from(flowRunSteps)
    .where(
      and(
        eq(flowRunSteps.runId, runId),
        eq(flowRunSteps.workspaceId, workspaceId),
        eq(flowRunSteps.index, run.currentStepIndex),
      ),
    )
    .limit(1)
    .for("update");
  return { run, step: steps.at(0) };
};

/**
 * Record a reviewer's decision on the run's current review gate and either
 * advance to the next step (approved) or cancel the run (rejected). Scoped to
 * the caller's workspace via the handler's `safeDb`.
 */
export const resolveFlowReviewGate = async (
  {
    safeDb,
    workspaceId,
    organizationId,
    runId,
    reviewTaskEntityId,
    userId,
    decision,
    note,
    recordAuditEvent,
  }: ResolveFlowReviewGateOptions,
  {
    broadcastUpdate = broadcastFlowRunUpdate,
    enqueueStep = enqueueFlowStep,
    notifyRunCompleted = notifyFlowRunActorOfCompletion,
  }: {
    broadcastUpdate?: typeof broadcastFlowRunUpdate;
    enqueueStep?: typeof enqueueFlowStep;
    /**
     * Files the completion pointer for the run's actor, who is usually not the
     * reviewer: a cross-user operation the caller's scope cannot perform.
     * An enclosing transaction collects the notice and files it after commit.
     */
    notifyRunCompleted?: (
      notice: Parameters<typeof notifyFlowRunActorOfCompletion>[0],
    ) => void | Promise<void>;
  } = {},
): Promise<Result<FlowRunActionResult, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const result = yield* Result.await(
      resultTx(safeDb, async (tx) => {
        await requireFlowEffectAdmission({ tx, organizationId, userId });
        const current = await lockRunAndCurrentStep(tx, { workspaceId, runId });
        if (current === undefined) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Flow run not found",
            }),
          );
        }
        const { run, step } = current;
        if (!canReviewFlowRun(run.status)) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "This run is not awaiting review.",
            }),
          );
        }
        if (
          !step ||
          step.kind !== "review-gate" ||
          step.status !== "awaiting_review" ||
          (reviewTaskEntityId !== undefined &&
            step.reviewTaskEntityId !== reviewTaskEntityId)
        ) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "This run has no open review gate.",
            }),
          );
        }
        const stepIndex = run.currentStepIndex;
        const resolution = resolveReviewGateTransition({
          decision,
          stepIndex,
          stepCount: run.definitionSnapshot.steps.length,
        });
        const output: FlowStepOutput = {
          kind: "review-gate",
          decision,
          userId,
          note,
        };
        const now = new Date();
        await tx
          .update(flowRunSteps)
          .set({ status: "completed", output, finishedAt: now })
          .where(
            and(
              eq(flowRunSteps.runId, runId),
              eq(flowRunSteps.index, stepIndex),
            ),
          );

        if (step.reviewTaskEntityId !== null) {
          // Either decision fulfils the task the gate raised; the decision
          // itself lives on the step.
          await settleReviewTask({
            tx,
            taskEntityId: step.reviewTaskEntityId,
            workspaceId,
            actorUserId: userId,
            action: "complete",
            reason: note,
            recordAuditEvent,
          });
        }

        const nextStatus = reviewGateNextStatus(resolution.kind);

        await tx
          .update(flowRuns)
          .set({
            status: nextStatus,
            recoveryState:
              nextStatus === "completed" ? "completion-notice-pending" : null,
            ...(resolution.kind === "advance"
              ? { currentStepIndex: resolution.nextStepIndex }
              : { finishedAt: now }),
          })
          .where(eq(flowRuns.id, runId));

        // Mark abandoned steps skipped when the decision is terminal. The
        // just-resolved gate is completed above and therefore excluded.
        if (resolution.kind !== "advance") {
          await tx
            .update(flowRunSteps)
            .set({ status: "skipped", finishedAt: now })
            .where(
              and(
                eq(flowRunSteps.runId, runId),
                inArray(flowRunSteps.status, [
                  "pending",
                  "running",
                  "awaiting_review",
                ]),
              ),
            );
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.REVIEW,
          resourceType: AUDIT_RESOURCE_TYPE.FLOW_RUN,
          resourceId: runId,
          changes: { review: { old: null, new: { decision } } },
        });

        return Result.ok({
          run,
          resolution,
          nextStatus,
          payload: await readRunProgress(tx, runId),
        });
      }),
    );

    const { run, resolution } = result;
    broadcastUpdate(workspaceId, result.payload);

    // Approving the last gate is the run's other terminal path: the worker
    // never sees it, so without this the advertised completion pointer would
    // exist only for runs whose last step was not a review gate. Addressed to
    // the run's actor, who is usually not the reviewer, so it cannot be
    // written under the reviewer's own scope; the run-derived key makes it a
    // no-op if `completeStepAndAdvance` also reaches it. The review and its
    // audit event commit before the notice is filed (an outer transaction
    // defers its callback until commit), so a notice that cannot be filed is
    // observed and the reviewer still gets the completed run: failing here
    // would answer an error for a decision that stands, and a retry would find
    // the run no longer awaiting review.
    if (resolution.kind === "finish") {
      const noticeFiled = await Result.tryPromise({
        try: async () =>
          await notifyRunCompleted({
            run,
            flowName: run.definitionSnapshot.name,
            organizationId,
            runId,
            workspaceId,
          }),
        catch: (cause) =>
          new FlowRunCompletionNoticeError({
            message: "Could not file the completion notice for a reviewed run",
            cause,
            organizationId,
            runId,
            workspaceId,
          }),
      });
      if (Result.isError(noticeFiled)) {
        observeFailure(noticeFiled.error, {
          sink: FLOW_RUN_COMPLETION_NOTICE_SINK,
          ctx: { organizationId, runId, workspaceId },
        });
      }
    }

    if (resolution.kind === "advance") {
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await enqueueStep({
              runId,
              stepIndex: resolution.nextStepIndex,
            }),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Could not enqueue the next flow step.",
              cause,
            }),
        }),
      );
    }

    return Result.ok({ runId, status: result.nextStatus });
  });

export type CancelFlowRunOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  runId: SafeId<"flowRun">;
  userId: SafeId<"user">;
  /** Records the cancellation of an open review task as the caller's act. */
  recordAuditEvent: AuditRecorder;
};

/**
 * Cancel a non-terminal run. Any queued step job is not removed here; the
 * executor's terminal-status guard makes it a no-op when it dequeues.
 */
export const cancelFlowRun = async ({
  safeDb,
  workspaceId,
  runId,
  userId,
  recordAuditEvent,
}: CancelFlowRunOptions): Promise<
  Result<FlowRunActionResult, HandlerError | SafeDbError>
> =>
  await Result.gen(async function* () {
    const run = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowRuns.findFirst({
          where: { id: { eq: runId }, workspaceId: { eq: workspaceId } },
          columns: { id: true, status: true, currentStepIndex: true },
        }),
      ),
    );
    if (!run) {
      return Result.err(
        new HandlerError({ status: 404, message: "Flow run not found" }),
      );
    }
    if (isTerminalFlowRunStatus(run.status)) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This run has already finished.",
        }),
      );
    }

    const now = new Date();
    const payload = yield* Result.await(
      resultTx(safeDb, async (tx) => {
        const workspace = await tx.query.workspaces.findFirst({
          where: { id: { eq: workspaceId } },
          columns: { organizationId: true },
        });
        if (workspace === undefined) {
          return Result.err(
            new HandlerError({ status: 404, message: "Flow run not found" }),
          );
        }
        await requireFlowEffectAdmission({
          tx,
          organizationId: workspace.organizationId,
          userId,
        });
        const current = await lockRunAndCurrentStep(tx, { workspaceId, runId });
        if (current === undefined) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Flow run not found",
            }),
          );
        }
        // Progressing work remains cancellable. A request that observed an
        // open gate cannot replace a decision committed while it waited.
        if (
          isTerminalFlowRunStatus(current.run.status) ||
          (run.status === "awaiting_review" &&
            current.run.status !== "awaiting_review")
        ) {
          return Result.err(
            new HandlerError({
              status: 409,
              message: "This run changed before it could be cancelled.",
            }),
          );
        }
        await tx
          .update(flowRuns)
          .set({ status: "cancelled", finishedAt: now })
          .where(eq(flowRuns.id, runId));
        // Any not-yet-terminal step is abandoned, and the task an open gate
        // raised is withdrawn with it.
        const abandoned = await tx
          .update(flowRunSteps)
          .set({ status: "skipped", finishedAt: now })
          .where(
            and(
              eq(flowRunSteps.runId, runId),
              inArray(flowRunSteps.status, [
                "pending",
                "running",
                "awaiting_review",
              ]),
            ),
          )
          .returning({ reviewTaskEntityId: flowRunSteps.reviewTaskEntityId });
        for (const step of abandoned) {
          if (step.reviewTaskEntityId === null) {
            continue;
          }
          // db-await-in-loop: each review task takes its own work-obligation row lock inside the transaction
          await settleReviewTask({
            tx,
            taskEntityId: step.reviewTaskEntityId,
            workspaceId,
            actorUserId: userId,
            action: "cancel",
            reason: null,
            recordAuditEvent,
          });
        }
        return Result.ok(await readRunProgress(tx, runId));
      }),
    );

    broadcastFlowRunUpdate(workspaceId, payload);
    return Result.ok({ runId, status: "cancelled" as const });
  });
