import { Result, TaggedError } from "better-result";
import { deepEquals } from "bun";
import { eq, sql } from "drizzle-orm";

import {
  assertCallerOrg,
  combineOrgScopes,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { abortableTx, abortTransaction } from "@/api/db/safe-db";
import {
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  workspaces,
} from "@/api/db/schema";
import type { authorizeHandlerRunSize } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { requireFlowEffectAdmission } from "@/api/lib/flows/effect-admission";
import { enqueueFlowStep } from "@/api/lib/flows/flow-run-queue";
import type {
  FlowDefinitionSnapshot,
  FlowRunStatus,
  FlowStep,
  FlowTriggerSource,
} from "@/api/lib/flows/flow-types";
import { snapshotOperationInput } from "@/api/lib/proofs/checked-transaction";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { QUEUED_ACTION_KIND } from "@/api/lib/rate-limit/action-kinds";
import { runQueuedKickoff } from "@/api/lib/rate-limit/queued-action-admission";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * Start a flow run: snapshot the definition, insert the run + all its step
 * rows (pending), and enqueue step 0. The single entry point for every trigger
 * mode — the manual start endpoint (Phase 2) and, server-side, the scheduler
 * and file-upload triggers (Phase 3) construct a root-scoped `safeDb` and call
 * this directly.
 *
 * The persisted matter binds the organization for run and step writes.
 * Callers validate input entities against that matter before invoking this owner.
 */
export class FlowRunStartError extends TaggedError("FlowRunStartError")<{
  message: string;
  reason:
    | "definition-not-found"
    | "definition-disabled"
    | "admission-refused"
    | "enqueue-failed";
  cause?: unknown;
}> {}

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
  /**
   * Runs once the definition is loaded and before any row is written.
   * A checked authorization admits execution; a refusal returns
   * `admission-refused` with the checking error as its cause; the manual entry point uses this for the
   * whole-run usage pre-flight, which needs the definition's steps.
   */
  admit: (definition: {
    steps: FlowStep[];
  }) => ReturnType<typeof authorizeHandlerRunSize>;
  enqueueStep?: typeof enqueueFlowStep;
  kickoff?: typeof runQueuedKickoff;
};

type StartFlowRunResult = {
  runId: SafeId<"flowRun">;
  status: FlowRunStatus;
};

/** Snapshot fields a run freezes from its definition at start. */
type FlowRunDefinitionSnapshotInput = {
  name: string;
  steps: FlowStep[];
};

export type BuildFlowRunRowsInput = {
  runId: SafeId<"flowRun">;
  workspaceId: SafeId<"workspace">;
  definitionId: SafeId<"flowDefinition">;
  definition: FlowRunDefinitionSnapshotInput;
  triggerSource: FlowTriggerSource;
  inputEntityIds: SafeId<"entity">[];
};

/** The run row plus its pending step rows, ready to insert in one transaction. */
export type FlowRunRows = {
  run: typeof flowRuns.$inferInsert & {
    id: SafeId<"flowRun">;
    inputEntityIds: SafeId<"entity">[];
  };
  steps: (typeof flowRunSteps.$inferInsert)[];
};

/**
 * Build the `flow_runs` row and its pending `flow_run_steps` rows from a
 * definition snapshot. Shared by the manual entry point (RLS-scoped insert) and
 * the automated triggers (cap-gated insert), so both write identical row shapes.
 */
export const buildFlowRunRows = ({
  runId,
  workspaceId,
  definitionId,
  definition,
  triggerSource,
  inputEntityIds,
}: BuildFlowRunRowsInput): FlowRunRows => {
  const snapshot: FlowDefinitionSnapshot = {
    name: definition.name,
    steps: definition.steps,
  };
  return {
    run: {
      id: runId,
      workspaceId,
      definitionId,
      definitionSnapshot: snapshot,
      status: "pending",
      currentStepIndex: 0,
      triggerSource,
      inputEntityIds,
      startedAt: new Date(),
    },
    steps: definition.steps.map((step, index) => ({
      id: createSafeId<"flowRunStep">(),
      workspaceId,
      runId,
      index,
      kind: step.kind,
      status: "pending" as const,
    })),
  };
};

type StartFlowRunOutcome = Result<
  StartFlowRunResult,
  FlowRunStartError | SafeDbError | ActionAdmissionError
>;

type PrepareAdmittedFlowRunOptions = Pick<
  StartFlowRunOptions,
  | "organizationId"
  | "workspaceId"
  | "definitionId"
  | "triggerSource"
  | "inputEntityIds"
> & {
  tx: Transaction;
  runId: SafeId<"flowRun">;
  actorId: string | null;
  definition: FlowRunDefinitionSnapshotInput;
};

const prepareAdmittedFlowRun = async ({
  tx,
  organizationId,
  workspaceId,
  definitionId,
  triggerSource,
  inputEntityIds,
  runId,
  actorId,
  definition,
}: PrepareAdmittedFlowRunOptions) => {
  await requireFlowEffectAdmission({
    tx,
    organizationId,
    userId: actorId,
  });
  const matterScope = await proveOrgScope(tx, {
    table: "workspaces",
    where: sql`${eq(workspaces.id, workspaceId)}`,
  });
  if (Result.isError(matterScope)) {
    abortTransaction(new HandlerError({ status: 404, message: "Not found" }));
  }
  if (Result.isError(assertCallerOrg(matterScope.value, organizationId))) {
    abortTransaction(new HandlerError({ status: 404, message: "Not found" }));
  }
  const definitionScope = await proveOrgScope(tx, {
    table: "flowDefinitions",
    where: sql`${eq(flowDefinitions.id, definitionId)}`,
  });
  if (Result.isError(definitionScope)) {
    abortTransaction(new HandlerError({ status: 404, message: "Not found" }));
  }
  const scope = combineOrgScopes(matterScope.value, definitionScope.value);
  if (Result.isError(scope)) {
    abortTransaction(new HandlerError({ status: 404, message: "Not found" }));
  }
  const currentDefinition = await tx.query.flowDefinitions.findFirst({
    where: {
      id: { eq: definitionId },
      organizationId: { eq: organizationId },
    },
    columns: {
      id: true,
      name: true,
      steps: true,
      enabled: true,
    },
  });
  if (!currentDefinition?.enabled) {
    abortTransaction(new HandlerError({ status: 404, message: "Not found" }));
  }
  if (!deepEquals(currentDefinition.steps, definition.steps)) {
    abortTransaction(
      new HandlerError({
        status: 409,
        message: "Flow definition changed. Retry the start.",
      }),
    );
  }
  const admittedRows = buildFlowRunRows({
    runId,
    workspaceId,
    definitionId,
    definition: currentDefinition,
    triggerSource,
    inputEntityIds,
  });
  return { scope: scope.value, rows: admittedRows };
};

export const startFlowRun = async (
  options: StartFlowRunOptions,
): Promise<StartFlowRunOutcome> => {
  const {
    safeDb,
    organizationId,
    workspaceId,
    definitionId,
    triggerSource,
    inputEntityIds,
    enqueueDelayMs,
    admit,
    enqueueStep = enqueueFlowStep,
    kickoff = runQueuedKickoff,
  } = snapshotOperationInput(options);
  return await Result.gen(async function* () {
    const loadedDefinition = yield* Result.await(
      safeDb((tx) =>
        tx.query.flowDefinitions.findFirst({
          where: {
            id: { eq: definitionId },
            organizationId: { eq: organizationId },
          },
          columns: {
            id: true,
            name: true,
            steps: true,
            enabled: true,
            createdByUserId: true,
          },
        }),
      ),
    );
    if (!loadedDefinition) {
      return Result.err(
        new FlowRunStartError({
          reason: "definition-not-found",
          message: "Flow definition not found",
        }),
      );
    }
    const definition = snapshotOperationInput(loadedDefinition);
    if (!definition.enabled) {
      return Result.err(
        new FlowRunStartError({
          reason: "definition-disabled",
          message: "This flow is disabled and cannot be run.",
        }),
      );
    }

    const authorization = await admit({ steps: definition.steps });
    if (Result.isError(authorization)) {
      return Result.err(
        new FlowRunStartError({
          reason: "admission-refused",
          message: authorization.error.message,
          cause: authorization.error,
        }),
      );
    }
    return await authorization.value.execute(
      async () =>
        await Result.gen(async function* () {
          const runId = createSafeId<"flowRun">();
          const actorId =
            triggerSource.type === "manual"
              ? triggerSource.userId
              : definition.createdByUserId;
          const createAndEnqueue = async (
            signal?: AbortSignal,
            reservePeriod?: () => Promise<void>,
          ) =>
            await Result.gen(async function* () {
              signal?.throwIfAborted();
              yield* (
                await abortableTx(safeDb, async (tx) => {
                  const prepared = await prepareAdmittedFlowRun({
                    tx,
                    organizationId,
                    workspaceId,
                    definitionId,
                    triggerSource,
                    inputEntityIds,
                    runId,
                    actorId,
                    definition,
                  });
                  await withOrgScope({
                    tx,
                    scope: prepared.scope,
                    actor: actorId
                      ? { type: "actor", userId: brandPersistedUserId(actorId) }
                      : { type: "system" },
                    fn: async (scopedTx) => {
                      await scopedTx.insert(flowRuns).values(prepared.rows.run);
                      await scopedTx
                        .insert(flowRunSteps)
                        .values(prepared.rows.steps);
                    },
                  });
                  await reservePeriod?.();
                })
              ).mapError((error) =>
                HandlerError.is(error)
                  ? new FlowRunStartError({
                      reason: "admission-refused",
                      message: error.message,
                      cause: error,
                    })
                  : error,
              );

              // Enqueue after the rows commit. A failure here leaves the run `pending`;
              // the worker's boot reconciler re-enqueues its current step, so the run is
              // never permanently stranded.
              yield* Result.await(
                Result.tryPromise({
                  try: async () =>
                    await enqueueStep({
                      runId,
                      stepIndex: 0,
                      ...(enqueueDelayMs !== undefined && {
                        delayMs: enqueueDelayMs,
                      }),
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
          if (!actorId) {
            // No caller to admit or count: run only while admission is off.
            if (!isDeploymentFeatureEnabled("FEATURE_ACTION_ADMISSION")) {
              return await createAndEnqueue();
            }
            return Result.err(
              new FlowRunStartError({
                reason: "admission-refused",
                message: "Flow run actor is unavailable",
              }),
            );
          }
          const started = yield* Result.await(
            Result.tryPromise({
              try: async () =>
                await kickoff({
                  organizationId,
                  userId: brandPersistedUserId(actorId),
                  organizationStateDb: async (run) =>
                    (await safeDb(run)).unwrap(
                      "Flow run admission state database must be available.",
                    ),
                  actionKind: QUEUED_ACTION_KIND.flow,
                  logicalPhaseId: runId,
                  periodReservation: "on-acceptance",
                  run: createAndEnqueue,
                }),
              catch: (cause) =>
                ActionAdmissionError.is(cause)
                  ? cause
                  : new FlowRunStartError({
                      reason: "admission-refused",
                      message: "Flow action admission refused",
                      cause,
                    }),
            }),
          );
          return started;
        }),
    );
  });
};
