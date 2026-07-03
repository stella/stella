import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import { compileLegalSourceToDocx } from "@stll/docx-core";

import type { SafeDb, SafeDbError, Transaction } from "@/api/db";
import { rootDb } from "@/api/db/root";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { resolveCaching } from "@/api/lib/ai-config";
import { loadOrgAIConfig } from "@/api/lib/ai-config-loader";
import { createAuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { decryptContent } from "@/api/lib/content-encryption";
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
  FLOW_DOCUMENT_CONTEXT_CHAR_CAP,
  FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP,
} from "@/api/lib/flows/flow-types";
import type {
  FlowReviewDecision,
  FlowRunStatus,
  FlowStep,
  FlowStepOutput,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import { logger } from "@/api/lib/observability/logger";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
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
}>() {}

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
): Promise<void> => {
  const runId = toSafeId<"flowRun">(rawRunId);
  const run = await loadRun(runId);
  if (!run) {
    logger.warn("flow.run_missing", { runId, stepIndex: String(stepIndex) });
    return;
  }
  if (isTerminalFlowRunStatus(run.status)) {
    // Cancelled/failed/completed run: a queued step must not resurrect it.
    return;
  }

  const step = await loadStep(runId, stepIndex);
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

  const scope = await resolveRunScope(run);
  const scopedDb = createRootScopedDb({
    organizationId: scope.organizationId,
    userId: scope.actorUserId,
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
  broadcastFlowRunUpdate(run.workspaceId, startedPayload);

  switch (stepDef.kind) {
    case "review-gate":
      await pauseAtReviewGate({
        runId,
        stepIndex,
        workspaceId: run.workspaceId,
        scopedDb,
      });
      return;
    case "ai": {
      const output = await runAiStep({
        stepDef,
        stepIndex,
        run,
        organizationId: scope.organizationId,
        scopedDb,
        signal,
      });
      await completeStepAndAdvance({
        runId,
        stepIndex,
        stepCount: run.definitionSnapshot.steps.length,
        output,
        workspaceId: run.workspaceId,
        scopedDb,
      });
      return;
    }
    case "create-document": {
      const output = await runCreateDocumentStep({
        stepDef,
        stepIndex,
        run,
        organizationId: scope.organizationId,
        actorUserId: scope.actorUserId,
        scopedDb,
      });
      await completeStepAndAdvance({
        runId,
        stepIndex,
        stepCount: run.definitionSnapshot.steps.length,
        output,
        workspaceId: run.workspaceId,
        scopedDb,
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

const loadRun = async (runId: SafeId<"flowRun">): Promise<LoadedRun | null> => {
  const row = await rootDb.query.flowRuns.findFirst({
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

const loadStep = async (runId: SafeId<"flowRun">, stepIndex: number) =>
  rootDb.query.flowRunSteps.findFirst({
    where: {
      runId: { eq: runId },
      index: { eq: stepIndex },
    },
    columns: { id: true, kind: true, status: true },
  });

type RunScope = {
  organizationId: SafeId<"organization">;
  actorUserId: SafeId<"user">;
};

const resolveRunScope = async (run: LoadedRun): Promise<RunScope> => {
  const workspace = await rootDb.query.workspaces.findFirst({
    where: { id: { eq: run.workspaceId } },
    columns: { organizationId: true },
  });
  if (!workspace) {
    return panic("flow run references a workspace that no longer exists");
  }
  return {
    organizationId: workspace.organizationId,
    actorUserId: await resolveActorUserId(run),
  };
};

/**
 * The user credited as the run's actor (document `createdBy`, audit rows). A
 * manual run carries the launcher's id; an automated run (Phase 3) falls back
 * to the definition author. Phase 2 only produces manual runs.
 */
const resolveActorUserId = async (run: LoadedRun): Promise<SafeId<"user">> => {
  if (run.triggerSource.type === "manual") {
    return brandPersistedUserId(run.triggerSource.userId);
  }
  if (run.definitionId) {
    const definition = await rootDb.query.flowDefinitions.findFirst({
      where: { id: { eq: run.definitionId } },
      columns: { createdByUserId: true },
    });
    if (definition?.createdByUserId) {
      return brandPersistedUserId(definition.createdByUserId);
    }
  }
  return panic("automated flow run has no resolvable actor user");
};

// ── Step executors ──────────────────────────────────────

type RunAiStepArgs = {
  stepDef: Extract<FlowStep, { kind: "ai" }>;
  stepIndex: number;
  run: LoadedRun;
  organizationId: SafeId<"organization">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
  signal: AbortSignal;
};

const FLOW_AI_SYSTEM_PROMPT =
  "You are a legal-workflow step executor. Follow the step instruction using the provided prior outputs and documents. Respond in Markdown with only the requested content, no preamble.";

const runAiStep = async ({
  stepDef,
  stepIndex,
  run,
  organizationId,
  scopedDb,
  signal,
}: RunAiStepArgs): Promise<FlowStepOutput> => {
  const priorOutputs = await scopedDb((tx) =>
    readPriorAiMarkdown(tx, run.id, stepIndex),
  );
  const documents = stepDef.includeDocuments
    ? await loadInputDocuments(scopedDb, organizationId, run.inputEntityIds)
    : [];

  const prompt = buildAiStepPrompt({
    instruction: stepDef.prompt,
    priorOutputs,
    documents,
  });

  const orgAIConfig = await loadOrgAIConfig(organizationId);

  // `generateTanStackTextForRole` throws on provider/config failure; that is
  // exactly the retry signal the worker wants, so we let it propagate. Works
  // unchanged under `USE_MOCK_AI` (model resolution short-circuits to the mock
  // adapter). No tools are ever passed.
  const markdown = await generateTanStackTextForRole({
    role: "chat",
    organizationId,
    orgAIConfig,
    system: FLOW_AI_SYSTEM_PROMPT,
    prompt,
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
    .orderBy(asc(flowRunSteps.index));

  const markdown: string[] = [];
  for (const row of rows) {
    if (row.output?.kind === "ai") {
      markdown.push(row.output.markdown);
    }
  }
  return markdown;
};

const loadInputDocuments = async (
  scopedDb: ReturnType<typeof createRootScopedDb>,
  organizationId: SafeId<"organization">,
  entityIds: SafeId<"entity">[],
): Promise<FlowStepDocument[]> => {
  if (entityIds.length === 0) {
    return [];
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
};

const runCreateDocumentStep = async ({
  stepDef,
  stepIndex,
  run,
  organizationId,
  actorUserId,
  scopedDb,
}: RunCreateDocumentArgs): Promise<FlowStepOutput> => {
  const priorMarkdown = await scopedDb((tx) =>
    readPriorAiMarkdown(tx, run.id, stepIndex),
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

  const recordAuditEvent = createAuditRecorder({
    organizationId,
    workspaceId: run.workspaceId,
    userId: actorUserId,
    request: new Request("http://flow-run.internal/"),
    server: null,
  });

  const created = await createEntityFromBuffer({
    scopedDb,
    organizationId,
    workspaceId: run.workspaceId,
    userId: actorUserId,
    recordAuditEvent,
    buffer: compiled.buffer,
    fileName: sanitizeFilename(`${stepDef.documentTitle}.docx`),
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
  scopedDb: ReturnType<typeof createRootScopedDb>;
};

const completeStepAndAdvance = async ({
  runId,
  stepIndex,
  stepCount,
  output,
  workspaceId,
  scopedDb,
}: CompleteStepArgs): Promise<void> => {
  const advance = advanceAfterStep({ stepIndex, stepCount });
  const now = new Date();

  const payload = await scopedDb(async (tx) => {
    await tx
      .update(flowRunSteps)
      .set({ status: "completed", output, finishedAt: now })
      .where(
        and(eq(flowRunSteps.runId, runId), eq(flowRunSteps.index, stepIndex)),
      );

    if (advance.kind === "finish") {
      await tx
        .update(flowRuns)
        .set({ status: "completed", finishedAt: now })
        .where(eq(flowRuns.id, runId));
    } else {
      await tx
        .update(flowRuns)
        .set({ status: "running", currentStepIndex: advance.nextStepIndex })
        .where(eq(flowRuns.id, runId));
    }
    return await readRunProgress(tx, runId);
  });

  broadcastFlowRunUpdate(workspaceId, payload);

  if (advance.kind === "advance") {
    await enqueueFlowStep({ runId, stepIndex: advance.nextStepIndex });
  }
};

const pauseAtReviewGate = async ({
  runId,
  stepIndex,
  workspaceId,
  scopedDb,
}: {
  runId: SafeId<"flowRun">;
  stepIndex: number;
  workspaceId: SafeId<"workspace">;
  scopedDb: ReturnType<typeof createRootScopedDb>;
}): Promise<void> => {
  const payload = await scopedDb(async (tx) => {
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
    return await readRunProgress(tx, runId);
  });
  broadcastFlowRunUpdate(workspaceId, payload);
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
    .orderBy(asc(flowRunSteps.index));

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
  const runId = toSafeId<"flowRun">(rawRunId);
  const run = await loadRun(runId);
  if (!run || isTerminalFlowRunStatus(run.status)) {
    return;
  }
  const scope = await resolveRunScope(run);
  const scopedDb = createRootScopedDb({
    organizationId: scope.organizationId,
    userId: scope.actorUserId,
    workspaceIds: [run.workspaceId],
  });
  const message = errorMessage(error);
  const now = new Date();

  const payload = await scopedDb(async (tx) => {
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
    return await readRunProgress(tx, runId);
  });
  broadcastFlowRunUpdate(run.workspaceId, payload);
};

// ── Request-time services (handler side) ────────────────

export type FlowRunActionResult = {
  runId: SafeId<"flowRun">;
  status: FlowRunStatus;
};

export type ResolveFlowReviewGateOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
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
export const resolveFlowReviewGate = ({
  safeDb,
  workspaceId,
  runId,
  userId,
  decision,
  note,
}: ResolveFlowReviewGateOptions): Promise<
  Result<FlowRunActionResult, HandlerError | SafeDbError>
> =>
  Result.gen(async function* () {
    const run = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowRuns.findFirst({
          where: { id: { eq: runId }, workspaceId: { eq: workspaceId } },
          columns: {
            id: true,
            status: true,
            currentStepIndex: true,
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

        const nextStatus: FlowRunStatus =
          resolution.kind === "cancel"
            ? "cancelled"
            : resolution.kind === "finish"
              ? "completed"
              : "running";

        await tx
          .update(flowRuns)
          .set({
            status: nextStatus,
            ...(resolution.kind === "advance"
              ? { currentStepIndex: resolution.nextStepIndex }
              : { finishedAt: now }),
          })
          .where(eq(flowRuns.id, runId));

        return {
          nextStatus,
          payload: await readRunProgress(tx, runId),
        };
      }),
    );

    broadcastFlowRunUpdate(workspaceId, result.payload);
    if (resolution.kind === "advance") {
      yield* Result.await(
        Result.tryPromise({
          try: () =>
            enqueueFlowStep({ runId, stepIndex: resolution.nextStepIndex }),
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
export const cancelFlowRun = ({
  safeDb,
  workspaceId,
  runId,
}: CancelFlowRunOptions): Promise<
  Result<FlowRunActionResult, HandlerError | SafeDbError>
> =>
  Result.gen(async function* () {
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
