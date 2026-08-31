import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { compileLegalSourceToDocx } from "@stll/docx-core";

import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createTanStackAIAnalyticsCallbacks } from "@/api/lib/analytics/tanstack-ai";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { AuditExecutionContext } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
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
  MAX_FLOW_STEPS,
} from "@/api/lib/flows/flow-types";
import type {
  FlowReviewDecision,
  FlowRunStatus,
  FlowStep,
  FlowStepOutput,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import {
  createNotificationsInTransaction,
  fanOutNotifications,
  pingNotificationRecipients,
} from "@/api/lib/notifications";
import type {
  NewNotification,
  NotificationPing,
} from "@/api/lib/notifications";
import { logger } from "@/api/lib/observability/logger";
import { createRootSafeDb, createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedFlowRunId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { generateTanStackTextForRole } from "@/api/lib/tanstack-ai-generate";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/**
 * The flow run engine. `executeFlowStep` runs one step of one run per BullMQ
 * job (throwing to trigger the queue's retry/backoff, since the queue boundary
 * is where throw-to-retry is the framework contract). `resolveFlowReviewGate`
 * and `cancelFlowRun` are request-time services consumed by the API handlers.
 */

const FLOW_AI_GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

/** Expected step-execution failure (bad AI output, doc-compile error, etc). */
export class FlowStepError extends TaggedError("FlowStepError")<{
  message: string;
  cause?: unknown;
}> {}

// ── Per-job step execution (queue side) ─────────────────

/**
 * Execute one step of a run. Idempotent: a retry after a successful step (or a
 * run that has since been cancelled/failed) no-ops. Throws on failure so the
 * BullMQ worker retries; the run is only flipped to `failed` from the worker's
 * final-attempt `failed` handler (`failFlowRunFromWorker`).
 */
export const executeFlowStep = async (
  { runId: rawRunId, stepIndex }: FlowStepJobData,
  signal: AbortSignal,
  {
    generateTextForRole = generateTanStackTextForRole,
    database = rootDb,
    makeScopedDb = createRootScopedDb,
    makeSafeDb = createRootSafeDb,
    enqueueStep = enqueueFlowStep,
    broadcastUpdate = broadcastFlowRunUpdate,
    createEntity = createEntityFromBuffer,
    loadAIConfig = loadOrgAIConfig,
  }: {
    /** External model-dispatch boundary; supplied by focused integration tests. */
    generateTextForRole?: typeof generateTanStackTextForRole | undefined;
    database?: Pick<typeof rootDb, "query"> | undefined;
    makeScopedDb?: typeof createRootScopedDb | undefined;
    makeSafeDb?: typeof createRootSafeDb | undefined;
    enqueueStep?: typeof enqueueFlowStep | undefined;
    broadcastUpdate?: typeof broadcastFlowRunUpdate | undefined;
    createEntity?: typeof createEntityFromBuffer | undefined;
    loadAIConfig?: typeof loadOrgAIConfig | undefined;
  } = {},
): Promise<void> => {
  const runId = brandPersistedFlowRunId(rawRunId);
  const run = await loadRun(runId, database);
  if (!run) {
    logger.warn("flow.run_missing", { runId, stepIndex: String(stepIndex) });
    return;
  }
  if (isTerminalFlowRunStatus(run.status)) {
    // Cancelled/failed/completed run: a queued step must not resurrect it.
    return;
  }

  const step = await loadStep(runId, stepIndex, database);
  if (!step) {
    return panic("flow run step row missing for an in-flight run");
  }
  if (step.status === "completed" || step.status === "skipped") {
    return; // A retry after this step already finished.
  }

  const stepDef = run.definitionSnapshot.steps.at(stepIndex);
  if (!stepDef) {
    return panic("flow step index out of snapshot bounds");
  }

  const scope = await resolveRunScope(run, database);
  if (scope.actorUserId === null) {
    // The trigger guarantees an actor before starting an automated run; a null
    // here means the definition's author was deleted mid-flight. Fail cleanly
    // with a TaggedError (never a panic) so the worker finalizes the run.
    throw new FlowStepError({
      message:
        "The user who owns this automated flow was removed; the run cannot continue.",
    });
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
    await tx
      .update(flowRunSteps)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, stepIndex)),
      );
    await tx
      .update(flowRuns)
      .set({ status: "running" })
      .where(eq(flowRuns.id, runId));
    return await readRunProgress(tx, runId);
  });
  broadcastUpdate(run.workspaceId, startedPayload);

  switch (stepDef.kind) {
    case "review-gate":
      await pauseAtReviewGate({
        runId,
        stepIndex,
        workspaceId: run.workspaceId,
        organizationId: scope.organizationId,
        actorUserId,
        flowName: run.definitionSnapshot.name,
        scopedDb,
        broadcastUpdate,
      });
      return;
    case "ai": {
      const output = await runAiStep({
        stepDef,
        stepIndex,
        run,
        organizationId: scope.organizationId,
        actorUserId,
        scopedDb,
        safeDb: makeSafeDb({
          organizationId: scope.organizationId,
          userId: actorUserId,
          workspaceIds: [run.workspaceId],
        }),
        signal,
        generateTextForRole,
        loadAIConfig,
      });
      await completeStepAndAdvance({
        runId,
        stepIndex,
        stepCount: run.definitionSnapshot.steps.length,
        output,
        workspaceId: run.workspaceId,
        organizationId: scope.organizationId,
        actorUserId,
        flowName: run.definitionSnapshot.name,
        scopedDb,
        broadcastUpdate,
        enqueueStep,
      });
      return;
    }
    case "create-document": {
      const output = await runCreateDocumentStep({
        stepDef,
        stepIndex,
        run,
        organizationId: scope.organizationId,
        actorUserId,
        scopedDb,
        createEntity,
      });
      await completeStepAndAdvance({
        runId,
        stepIndex,
        stepCount: run.definitionSnapshot.steps.length,
        output,
        workspaceId: run.workspaceId,
        organizationId: scope.organizationId,
        actorUserId,
        flowName: run.definitionSnapshot.name,
        scopedDb,
        broadcastUpdate,
        enqueueStep,
      });
      return;
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

/**
 * The user credited as the run's actor (document `createdBy`, audit rows). A
 * manual run carries the launcher's id; an automated run falls back to the
 * definition author. Returns `null` for an automated run whose author was
 * deleted mid-flight — the trigger already refuses to start such a run, so this
 * only happens if the author is removed after the run begins; callers fail the
 * run cleanly rather than panicking.
 */
const resolveActorUserId = async (
  run: Pick<LoadedRun, "definitionId" | "triggerSource">,
  database: Pick<typeof rootDb, "query">,
): Promise<SafeId<"user"> | null> => {
  if (run.triggerSource.type === "manual") {
    return brandPersistedUserId(run.triggerSource.userId);
  }
  if (run.definitionId) {
    const definition = await database.query.flowDefinitions.findFirst({
      where: { id: { eq: run.definitionId } },
      columns: { createdByUserId: true },
    });
    if (definition?.createdByUserId) {
      return brandPersistedUserId(definition.createdByUserId);
    }
  }
  return null;
};

// ── Step executors ──────────────────────────────────────

type RunAiStepArgs = {
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

  const orgAIConfig = await loadAIConfig(organizationId);
  // Every step settles against the organization's usage as it runs; the
  // initiator pre-flighted the whole run's estimate under the same action
  // type before enqueueing it.
  const analytics = createTanStackAIAnalyticsCallbacks({
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
    role: "chat",
    organizationId,
    tenantWorkspaceIds: [run.workspaceId],
    orgAIConfig,
    analytics,
    system: FLOW_AI_SYSTEM_PROMPT,
    prompt,
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

  return Promise.all(
    rows.map(async (row) => ({
      label: row.entity?.name ?? "Document",
      text: await decryptContent(organizationId, row.ciphertext, row.iv),
    })),
  );
};

type RunCreateDocumentArgs = {
  stepDef: Extract<FlowStep, { kind: "create-document" }>;
  stepIndex: number;
  run: LoadedRun;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  createEntity: typeof createEntityFromBuffer;
};

const runCreateDocumentStep = async ({
  stepDef,
  stepIndex,
  run,
  organizationId,
  actorUserId,
  scopedDb,
  createEntity,
}: RunCreateDocumentArgs): Promise<FlowStepOutput> => {
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

  const compiled = await compileLegalSourceToDocx(markdown, {
    titleFallback: stepDef.documentTitle,
  });
  if (compiled.status !== "ok") {
    throw new FlowStepError({
      message: `The generated content could not be rendered to a document: ${compiled.errors
        .map((error) => error.message)
        .join("; ")}`,
    });
  }

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
        const exhaustive: never = run.triggerSource;
        return exhaustive;
      }
    }
  })();

  const recordAuditEvent = createAuditRecorder({
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

  const created = await createEntity({
    scopedDb,
    organizationId,
    workspaceId: run.workspaceId,
    userId: actorUserId,
    recordAuditEvent,
    buffer: compiled.buffer,
    // Pass the raw title: `createEntityFromBuffer` sanitizes with
    // `sanitizeFilenamePreservingExtension`, which truncates the base name
    // rather than the extension. Pre-sanitizing with the plain
    // `sanitizeFilename` here would drop the `.docx` for near-max-length titles
    // before the extension-preserving pass could protect it.
    fileName: `${stepDef.documentTitle}.docx`,
    mimeType: DOCX_MIME_TYPE,
  });

  if (Result.isError(created)) {
    throw new FlowStepError({
      message:
        "The document could not be created for this workspace (entity limit reached or missing file property).",
      cause: created.error,
    });
  }

  return { kind: "create-document", entityId: created.value.entityId };
};

// ── Shared transition writers ───────────────────────────

type CompleteStepArgs = {
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

const completeStepAndAdvance = async ({
  runId,
  stepIndex,
  stepCount,
  output,
  workspaceId,
  organizationId,
  actorUserId,
  flowName,
  scopedDb,
  broadcastUpdate,
  enqueueStep,
}: CompleteStepArgs): Promise<void> => {
  const advance = advanceAfterStep({ stepIndex, stepCount });
  const now = new Date();

  const { payload, pings } = await scopedDb(async (tx) => {
    await tx
      .update(flowRunSteps)
      .set({ status: "completed", output, finishedAt: now })
      .where(
        and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, stepIndex)),
      );

    if (advance.kind !== "finish") {
      await tx
        .update(flowRuns)
        .set({ status: "running", currentStepIndex: advance.nextStepIndex })
        .where(eq(flowRuns.id, runId));
      return { payload: await readRunProgress(tx, runId), pings: [] };
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
        }),
      ],
      tx,
    );
    return { payload: await readRunProgress(tx, runId), pings: runPings };
  });

  broadcastUpdate(workspaceId, payload);
  pingNotificationRecipients(pings);

  if (advance.kind === "advance") {
    await enqueueStep({ runId, stepIndex: advance.nextStepIndex });
  }
};

type FlowRunCompletedNotificationArgs = {
  actorUserId: SafeId<"user">;
  flowName: string;
  organizationId: SafeId<"organization">;
  runId: SafeId<"flowRun">;
};

/**
 * The "your run finished" pointer, shared by both paths that can make a run
 * terminal: the last step completing on the worker, and a reviewer approving a
 * final review gate. One definition so the two cannot drift, and one
 * run-derived idempotency key so whichever path gets there first wins and the
 * other is a no-op.
 */
const flowRunCompletedNotification = ({
  actorUserId,
  flowName,
  organizationId,
  runId,
}: FlowRunCompletedNotificationArgs): NewNotification => ({
  kind: NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
  metadata: { flowName },
  entityType: "flow_run",
  entityId: runId,
  organizationId,
  userId: actorUserId,
  idempotencyKey: `flow-run-completed:${runId}`,
});

const pauseAtReviewGate = async ({
  runId,
  stepIndex,
  workspaceId,
  organizationId,
  actorUserId,
  flowName,
  scopedDb,
  broadcastUpdate,
}: {
  runId: SafeId<"flowRun">;
  stepIndex: number;
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
  flowName: string;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  broadcastUpdate: typeof broadcastFlowRunUpdate;
}): Promise<void> => {
  const { payload, pings } = await scopedDb(async (tx) => {
    await tx
      .update(flowRunSteps)
      .set({ status: "awaiting_review" })
      .where(
        and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, stepIndex)),
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
          organizationId,
          userId: actorUserId,
          idempotencyKey: `flow-run-review-gate:${runId}:${stepIndex}`,
        },
      ],
      tx,
    );
    return { payload: await readRunProgress(tx, runId), pings: gatePings };
  });
  broadcastUpdate(workspaceId, payload);
  pingNotificationRecipients(pings);
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Flow step failed";

/**
 * Flip a run (and its current step) to `failed` after the worker exhausts its
 * retries. Reads the run unscoped to recover its workspace/org, then writes
 * through the RLS-scoped handle. A no-op if the run is already terminal.
 */
export const failFlowRunFromWorker = async (
  { runId: rawRunId, stepIndex }: FlowStepJobData,
  error: unknown,
): Promise<void> => {
  const runId = brandPersistedFlowRunId(rawRunId);
  const run = await loadRun(runId, rootDb);
  if (!run || isTerminalFlowRunStatus(run.status)) {
    return;
  }
  const scope = await resolveRunScope(run, rootDb);
  const message = errorMessage(error);
  const now = new Date();

  const writeFailure = async (
    tx: Transaction,
  ): Promise<{ payload: FlowRunUpdatePayload; pings: NotificationPing[] }> => {
    await tx
      .update(flowRunSteps)
      .set({ status: "failed", error: message, finishedAt: now })
      .where(
        and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, stepIndex)),
      );
    await tx
      .update(flowRuns)
      .set({ status: "failed", error: message, finishedAt: now })
      .where(eq(flowRuns.id, runId));
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
                organizationId: scope.organizationId,
                userId: actorUserId,
                idempotencyKey: `flow-run-failed:${runId}`,
              },
            ],
            tx,
          );
    return { payload: await readRunProgress(tx, runId), pings };
  };

  // A null actor (automated run whose author was deleted) has no RLS-scoped
  // handle to write through; fall back to `rootDb` so the run still finalizes
  // instead of being stranded non-terminal.
  const { payload, pings } =
    scope.actorUserId === null
      ? await rootDb.transaction(writeFailure)
      : await createRootScopedDb({
          organizationId: scope.organizationId,
          userId: scope.actorUserId,
          workspaceIds: [run.workspaceId],
        })(writeFailure);
  broadcastFlowRunUpdate(run.workspaceId, payload);
  pingNotificationRecipients(pings);
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
  userId: SafeId<"user">;
  decision: FlowReviewDecision;
  note: string | null;
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
    userId,
    decision,
    note,
  }: ResolveFlowReviewGateOptions,
  {
    broadcastUpdate = broadcastFlowRunUpdate,
    enqueueStep = enqueueFlowStep,
    database = rootDb,
  }: {
    broadcastUpdate?: typeof broadcastFlowRunUpdate;
    enqueueStep?: typeof enqueueFlowStep;
    /**
     * Owner connection used only to address the completion pointer: the run's
     * actor is usually not the reviewer, so neither resolving them nor writing
     * their row fits the caller's scope.
     */
    database?: Pick<typeof rootDb, "query" | "select" | "transaction">;
  } = {},
): Promise<Result<FlowRunActionResult, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const run = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowRuns.findFirst({
          where: { id: { eq: runId }, workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            status: true,
            currentStepIndex: true,
            definitionId: true,
            triggerSource: true,
            definitionSnapshot: true,
          },
        }),
      ),
    );
    if (!run) {
      return Result.err(
        new HandlerError({ status: 404, message: "Flow run not found" }),
      );
    }
    if (!canReviewFlowRun(run.status)) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This run is not awaiting review.",
        }),
      );
    }

    const stepIndex = run.currentStepIndex;
    const step = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowRunSteps.findFirst({
          where: { runId: { eq: runId }, index: { eq: stepIndex } },
          columns: { kind: true, status: true },
        }),
      ),
    );
    if (
      !step ||
      step.kind !== "review-gate" ||
      step.status !== "awaiting_review"
    ) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This run has no open review gate.",
        }),
      );
    }

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

    const result = yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .update(flowRunSteps)
          .set({ status: "completed", output, finishedAt: now })
          .where(
            and(
              eq(flowRunSteps.runId, runId),
              eq(flowRunSteps.index, stepIndex),
            ),
          );

        const nextStatus = reviewGateNextStatus(resolution.kind);

        await tx
          .update(flowRuns)
          .set({
            status: nextStatus,
            ...(resolution.kind === "advance"
              ? { currentStepIndex: resolution.nextStepIndex }
              : { finishedAt: now }),
          })
          .where(eq(flowRuns.id, runId));

        // A rejected gate makes the run terminal without advancing, so any
        // later step rows stay `pending` and no worker ever enqueues them.
        // Mirror `cancelFlowRun`: mark the abandoned non-terminal steps
        // `skipped` so the run history reflects what actually happened. The
        // just-resolved gate is already `completed` above, so it is excluded.
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

        return {
          nextStatus,
          payload: await readRunProgress(tx, runId),
        };
      }),
    );

    broadcastUpdate(workspaceId, result.payload);

    // Approving the last gate is the run's other terminal path: the worker
    // never sees it, so without this the advertised completion pointer would
    // exist only for runs whose last step was not a review gate. Addressed to
    // the run's actor, who is usually not the reviewer, so it cannot be
    // written under the reviewer's own scope; the run-derived key makes it a
    // no-op if `completeStepAndAdvance` also reaches it.
    if (resolution.kind === "finish") {
      const actorUserId = yield* Result.await(
        Result.tryPromise(async () => await resolveActorUserId(run, database)),
      );
      if (actorUserId !== null) {
        yield* Result.await(
          Result.tryPromise(
            async () =>
              await fanOutNotifications(
                [
                  flowRunCompletedNotification({
                    actorUserId,
                    flowName: run.definitionSnapshot.name,
                    organizationId,
                    runId,
                  }),
                ],
                database,
              ),
          ),
        );
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
};

/**
 * Cancel a non-terminal run. Any queued step job is not removed here; the
 * executor's terminal-status guard makes it a no-op when it dequeues.
 */
export const cancelFlowRun = async ({
  safeDb,
  workspaceId,
  runId,
}: CancelFlowRunOptions): Promise<
  Result<FlowRunActionResult, HandlerError | SafeDbError>
> =>
  await Result.gen(async function* () {
    const run = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowRuns.findFirst({
          where: { id: { eq: runId }, workspaceId: { eq: workspaceId } },
          columns: { id: true, status: true },
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
      safeDb(async (tx) => {
        await tx
          .update(flowRuns)
          .set({ status: "cancelled", finishedAt: now })
          .where(eq(flowRuns.id, runId));
        // Any not-yet-terminal step is abandoned.
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
        return await readRunProgress(tx, runId);
      }),
    );

    broadcastFlowRunUpdate(workspaceId, payload);
    return Result.ok({ runId, status: "cancelled" as const });
  });
