import { Result, TaggedError } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db";
import { flowRuns, flowRunSteps } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { enqueueFlowStep } from "@/api/lib/flows/flow-run-queue";
import type {
  FlowDefinitionSnapshot,
  FlowRunStatus,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";

/**
 * Start a flow run: snapshot the definition, insert the run + all its step
 * rows (pending), and enqueue step 0. The single entry point for every trigger
 * mode — the manual start endpoint (Phase 2) and, server-side, the scheduler
 * and file-upload triggers (Phase 3) construct a root-scoped `safeDb` and call
 * this directly.
 *
 * Ownership invariants are the caller's responsibility: `workspaceId` must
 * belong to `organizationId` and `inputEntityIds` must belong to `workspaceId`
 * (the manual endpoint validates the entities; automated callers pass a
 * workspace they already own). `safeDb` must be scoped to `organizationId` and
 * `workspaceId` so its RLS enforces the definition read + run insert.
 */
export class FlowRunStartError extends TaggedError("FlowRunStartError")<{
  message: string;
  reason: "definition-not-found" | "definition-disabled" | "enqueue-failed";
  cause?: unknown;
}>() {}

export type StartFlowRunOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  definitionId: SafeId<"flowDefinition">;
  triggerSource: FlowTriggerSource;
  inputEntityIds: SafeId<"entity">[];
  /**
   * Optional delay (ms) before step 0 becomes visible to the worker. Used by
   * the file-upload trigger to defer the first step past async extraction so an
   * `ai` step with `includeDocuments` sees populated `extractedContent`.
   */
  enqueueDelayMs?: number;
};

export type StartFlowRunResult = {
  runId: SafeId<"flowRun">;
  status: FlowRunStatus;
};

export const startFlowRun = async ({
  safeDb,
  organizationId,
  workspaceId,
  definitionId,
  triggerSource,
  inputEntityIds,
  enqueueDelayMs,
}: StartFlowRunOptions): Promise<
  Result<StartFlowRunResult, FlowRunStartError | SafeDbError>
> =>
  await Result.gen(async function* () {
    const definition = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowDefinitions.findFirst({
          where: {
            id: { eq: definitionId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, name: true, steps: true, enabled: true },
        }),
      ),
    );
    if (!definition) {
      return Result.err(
        new FlowRunStartError({
          reason: "definition-not-found",
          message: "Flow definition not found",
        }),
      );
    }
    if (!definition.enabled) {
      return Result.err(
        new FlowRunStartError({
          reason: "definition-disabled",
          message: "This flow is disabled and cannot be run.",
        }),
      );
    }

    const runId = createSafeId<"flowRun">();
    const snapshot: FlowDefinitionSnapshot = {
      name: definition.name,
      steps: definition.steps,
    };

    yield* Result.await(
      safeDb(async (tx) => {
        await tx.insert(flowRuns).values({
          id: runId,
          workspaceId,
          definitionId,
          definitionSnapshot: snapshot,
          status: "pending",
          currentStepIndex: 0,
          triggerSource,
          inputEntityIds,
          startedAt: new Date(),
        });
        await tx.insert(flowRunSteps).values(
          definition.steps.map((step, index) => ({
            id: createSafeId<"flowRunStep">(),
            workspaceId,
            runId,
            index,
            kind: step.kind,
            status: "pending" as const,
          })),
        );
      }),
    );

    // Enqueue after the rows commit. A failure here leaves the run `pending`;
    // the worker's boot reconciler re-enqueues its current step, so the run is
    // never permanently stranded.
    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await enqueueFlowStep({
            runId,
            stepIndex: 0,
            ...(enqueueDelayMs !== undefined && { delayMs: enqueueDelayMs }),
          }),
        catch: (cause) =>
          new FlowRunStartError({
            reason: "enqueue-failed",
            message: "Could not enqueue the flow run.",
            cause,
          }),
      }),
    );

    return Result.ok({ runId, status: "pending" as const });
  });
