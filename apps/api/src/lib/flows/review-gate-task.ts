import { Result } from "better-result";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { FLOW_RUN_TERMINAL_STATUSES } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { entities, flowRuns, flowRunSteps, workspaces } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { resolveFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { isFeatureEnabled } from "@/api/lib/feature-access/policy";
import {
  lockFeatureAdmissionShared,
  lockFeatureRecoveryAdmission,
  tryLockFeatureRecoveryAdmission,
} from "@/api/lib/feature-access/recovery-admission-lock";
import { resolveFlowReviewGate } from "@/api/lib/flows/flow-executor";
import type { FlowRunActionResult } from "@/api/lib/flows/flow-executor";
import type { FlowReviewDecision } from "@/api/lib/flows/flow-types";
import {
  classifyEntityResourceDeletions,
  flowFeatureActorVisibilitySql,
} from "@/api/lib/flows/visibility";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";
import { WORK_OBLIGATION_TRANSITION_ACTION } from "@/api/lib/work-obligations/transitions";
import type { WorkObligationTransitionAction } from "@/api/lib/work-obligations/transitions";

/**
 * Completing the task a review gate raised approves the gate and cancelling
 * it rejects the gate; the run then settles the task itself, so the decision
 * is recorded once. A gate cannot be reopened: its run has moved on.
 */
const GATE_DECISION_BY_ACTION = {
  complete: "approved",
  cancel: "rejected",
  reopen: null,
} as const satisfies Record<
  WorkObligationTransitionAction,
  FlowReviewDecision | null
>;

export const gateDecisionForTransition = <
  TAction extends WorkObligationTransitionAction,
>(
  action: TAction,
) => GATE_DECISION_BY_ACTION[action];

type ReviewGateForTaskOptions = {
  workspaceId: SafeId<"workspace">;
  taskEntityId: SafeId<"entity">;
};

/** Ownership survives task metadata changes and governed-workflow toggles. */
export const reviewGateForTask = async (
  tx: Transaction,
  { workspaceId, taskEntityId }: ReviewGateForTaskOptions,
) => {
  const gates = await tx
    .select({
      runId: flowRunSteps.runId,
      status: flowRunSteps.status,
      organizationId: workspaces.organizationId,
    })
    .from(flowRunSteps)
    .innerJoin(workspaces, eq(workspaces.id, flowRunSteps.workspaceId))
    .where(
      and(
        eq(flowRunSteps.workspaceId, workspaceId),
        eq(flowRunSteps.reviewTaskEntityId, taskEntityId),
      ),
    )
    .limit(1);
  return gates.at(0);
};

type AdmitTaskFlowAccessOptions = ReviewGateForTaskOptions & {
  access: "read" | "write";
  userId: SafeId<"user">;
};

/** Shared task entry points and native tools admit linked flow work here. */
export const admitTaskFlowAccess = async (
  tx: Transaction,
  { userId, access, ...task }: AdmitTaskFlowAccessOptions,
): Promise<Result<void, HandlerError>> => {
  const gate = await reviewGateForTask(tx, task);
  if (gate === undefined) {
    return Result.ok(undefined);
  }
  return await admitLinkedFlowAccess(tx, {
    organizationId: gate.organizationId,
    userId,
    access,
  });
};

type AdmitLinkedFlowAccessOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  access: "read" | "write";
};

const admitLinkedFlowAccess = async (
  tx: Transaction,
  { organizationId, userId, access }: AdmitLinkedFlowAccessOptions,
): Promise<Result<void, HandlerError>> => {
  if (access === "write") {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "flows",
    });
  }
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  const principal = { organizationId, userId };
  const snapshot = await resolveFeatureAccessSnapshot({ tx, ...principal });
  return isFeatureEnabled(snapshot, "flows", principal)
    ? Result.ok(undefined)
    : Result.err(new HandlerError({ status: 404, message: "Not found" }));
};

type EntityTransferAccessOptions = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  userId: SafeId<"user">;
  /**
   * `write` evaluates the grant for a transfer that keeps its source;
   * `remove` also deletes the source subtree, whose review-task deletion
   * admission needs the exclusive mode in the same transaction.
   */
  access: "read" | "write" | "remove";
};

type ReadEntityTransferEligibilityOptions = Omit<
  EntityTransferAccessOptions,
  "entityId" | "access"
> & { entityIds: readonly SafeId<"entity">[] };

const transferEligibilityRows = v.array(
  v.object({ entityId: v.string(), eligible: v.boolean() }),
);

/** Read only a decision for each supplied root, with no descendant identifiers. */
export const readEntityTransferEligibility = async (
  tx: Transaction,
  { workspaceId, entityIds, userId }: ReadEntityTransferEligibilityOptions,
) => {
  if (entityIds.length === 0) {
    return [];
  }
  const workspace = await tx.query.workspaces.findFirst({
    where: { id: { eq: workspaceId } },
    columns: { organizationId: true },
  });
  if (workspace === undefined) {
    return [];
  }
  const result = await tx.execute(sql`
    WITH roots AS (
      SELECT ${entities.id} AS root_id
      FROM ${entities}
      WHERE ${inArray(entities.id, [...entityIds])}
        AND ${entities.workspaceId} = ${workspaceId}
    )
    SELECT roots.root_id AS "entityId", eligibility.eligible
    FROM roots
    CROSS JOIN LATERAL (
      WITH RECURSIVE subtree AS (
        SELECT roots.root_id AS id, 1 AS depth
        UNION ALL
        SELECT child.id, subtree.depth + 1
        FROM ${entities} child
        JOIN subtree ON child.parent_id = subtree.id
        WHERE child.workspace_id = ${workspaceId}
          AND subtree.depth < ${LIMITS.entityAncestorWalkDepthMax}
      ), bounded AS MATERIALIZED (
        SELECT id, depth FROM subtree LIMIT ${LIMITS.entitiesCount + 1}
      )
      SELECT count(*) <= ${LIMITS.entitiesCount}
        AND max(depth) < ${LIMITS.entityAncestorWalkDepthMax}
        AND NOT EXISTS (
          SELECT 1 FROM bounded
          JOIN ${flowRunSteps} ON ${flowRunSteps.reviewTaskEntityId} = bounded.id
            AND ${flowRunSteps.workspaceId} = ${workspaceId}
          WHERE NOT (${flowFeatureActorVisibilitySql({
            organizationId: workspace.organizationId,
            workspaceId,
            userId,
          })})
        ) AS eligible
      FROM bounded
    ) eligibility
  `);
  // Drivers differ in how `execute` returns rows; decide per requested root so
  // only identifiers the caller supplied leave this function.
  const eligibility = new Map(
    v
      .parse(transferEligibilityRows, executedRows(result))
      .map(({ entityId, eligible }) => [entityId, eligible]),
  );
  return [...new Set(entityIds)].flatMap((entityId) => {
    const eligible = eligibility.get(entityId);
    return eligible === undefined ? [] : [{ entityId, eligible }];
  });
};

/**
 * Writers take admission before tree/entity locks and evaluate current links.
 * A transfer that keeps its source only reads the grant and links, so it
 * holds admission shared: grant changes and flow effects (exclusive) still
 * exclude it, while transfers in one organization serialize only on their
 * own matter locks. A transfer that removes its source takes the exclusive
 * mode up front, since its review-task deletion admission needs it later.
 */
const entityTransferIsEligible = async (
  tx: Transaction,
  { workspaceId, entityId, userId, access }: EntityTransferAccessOptions,
): Promise<boolean> => {
  if (access !== "read") {
    const workspace = await tx.query.workspaces.findFirst({
      where: { id: { eq: workspaceId } },
      columns: { organizationId: true },
    });
    if (workspace === undefined) {
      return false;
    }
    const admission = {
      tx,
      organizationId: workspace.organizationId,
      featureId: "flows",
    } as const;
    if (access === "remove") {
      await lockFeatureRecoveryAdmission(admission);
    } else {
      await lockFeatureAdmissionShared(admission);
    }
  }
  const rows = await readEntityTransferEligibility(tx, {
    workspaceId,
    entityIds: [entityId],
    userId,
  });
  return rows.at(0)?.eligible === true;
};

export const admitEntityTransferAccess = async (
  tx: Transaction,
  options: EntityTransferAccessOptions,
): Promise<Result<void, HandlerError>> =>
  (await entityTransferIsEligible(tx, options))
    ? Result.ok(undefined)
    : Result.err(new HandlerError({ status: 404, message: "Not found" }));

type AdmitFlowReviewTaskDeletionOptions = {
  workspaceId: SafeId<"workspace">;
  taskEntityIds: SafeId<"entity">[];
  userId: SafeId<"user">;
};

/** Active gates retain their task pointer; terminal history may use the FK's SET NULL. */
export const admitFlowReviewTaskDeletion = async (
  tx: Transaction,
  { workspaceId, taskEntityIds, userId }: AdmitFlowReviewTaskDeletionOptions,
): Promise<Result<void, HandlerError>> => {
  const { linkedOrganizationId } = await classifyEntityResourceDeletions(tx, {
    workspaceId,
    entityIds: taskEntityIds,
  });
  if (linkedOrganizationId === undefined) {
    return Result.ok(undefined);
  }
  // Deletion owners already hold entity locks; never wait on the inverse
  // feature-admission order used by review workers and grant changes.
  if (
    !(await tryLockFeatureRecoveryAdmission({
      tx,
      organizationId: linkedOrganizationId,
      featureId: "flows",
    }))
  ) {
    return Result.err(new HandlerError({ status: 404, message: "Not found" }));
  }
  const admission = await admitLinkedFlowAccess(tx, {
    organizationId: linkedOrganizationId,
    userId,
    access: "read",
  });
  if (admission.isErr()) {
    return admission;
  }
  const active = await tx
    .select({ id: flowRunSteps.id })
    .from(flowRunSteps)
    .innerJoin(
      flowRuns,
      and(
        eq(flowRuns.id, flowRunSteps.runId),
        eq(flowRuns.workspaceId, flowRunSteps.workspaceId),
      ),
    )
    .where(
      and(
        eq(flowRunSteps.workspaceId, workspaceId),
        inArray(flowRunSteps.reviewTaskEntityId, taskEntityIds),
        notInArray(flowRuns.status, FLOW_RUN_TERMINAL_STATUSES),
      ),
    )
    .limit(1);
  return active.length === 0
    ? Result.ok(undefined)
    : Result.err(
        new HandlerError({
          status: 409,
          message: "An active workflow review task cannot be deleted",
        }),
      );
};

export const FLOW_TASK_FEATURE_ACCESS = {
  featureId: "flows",
  type: "conditional",
  decision: "always",
  usesFeature: async (context) => {
    const { body, params, workspaceId, scopedDb } = context;
    if (workspaceId === undefined) {
      return false;
    }
    const taskId = isRecord(params)
      ? (params["taskId"] ?? params["entityId"])
      : undefined;
    const entityId =
      taskId ??
      (isRecord(body) ? (body["taskId"] ?? body["entityId"]) : undefined);
    const entityIds = typeof entityId === "string" ? [entityId] : [];
    if (isRecord(body) && Array.isArray(body["entityIds"])) {
      for (const id of body["entityIds"]) {
        if (typeof id === "string") {
          entityIds.push(id);
        }
      }
    }
    if (entityIds.length === 0) {
      return false;
    }
    const gates = await scopedDb((tx) =>
      tx
        .select({ runId: flowRunSteps.runId })
        .from(flowRunSteps)
        .where(
          and(
            eq(flowRunSteps.workspaceId, workspaceId),
            sql`${flowRunSteps.reviewTaskEntityId} IN (${sql.join(
              entityIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .limit(1),
    );
    return gates.length !== 0;
  },
  // The feature is selected by the persisted task link, not an input option.
  projectInputSchema: (schemas) => schemas,
} as const satisfies FeatureAccessRequirement;

type GateDecisionForTaskStatusOptions = ReviewGateForTaskOptions & {
  requestedStatus: string | undefined;
};

/** Closing the linked task decides its gate even without an obligation. */
export const gateDecisionForTaskStatus = async (
  tx: Transaction,
  { requestedStatus, ...task }: GateDecisionForTaskStatusOptions,
): Promise<Result<FlowReviewDecision | null, HandlerError>> => {
  if (requestedStatus === undefined) {
    return Result.ok(null);
  }
  const gate = await reviewGateForTask(tx, task);
  if (!gate) {
    return Result.ok(null);
  }
  if (gate.status !== "awaiting_review") {
    const currentTask = await tx.query.entities.findFirst({
      where: {
        id: { eq: task.taskEntityId },
        workspaceId: { eq: task.workspaceId },
      },
      columns: { status: true },
    });
    if (currentTask?.status === requestedStatus) {
      return Result.ok(null);
    }
  }
  if (requestedStatus === TASK_STATUS.CANCELLED) {
    return Result.ok(
      gateDecisionForTransition(WORK_OBLIGATION_TRANSITION_ACTION.CANCEL),
    );
  }
  if (requestedStatus === TASK_STATUS.DONE) {
    return Result.ok(
      gateDecisionForTransition(WORK_OBLIGATION_TRANSITION_ACTION.COMPLETE),
    );
  }
  if (gate.status !== "awaiting_review") {
    return Result.err(
      new HandlerError({
        status: 409,
        message:
          "A workflow review cannot be reopened; start the workflow again instead",
      }),
    );
  }
  return Result.ok(null);
};

type DecideGateForTaskOptions = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  taskEntityId: SafeId<"entity">;
  userId: SafeId<"user">;
  decision: FlowReviewDecision;
  note: string | null;
  recordAuditEvent: AuditRecorder;
};

/**
 * Decide the review gate that raised a task. Every path that closes such a
 * task (the obligation transition, a task status change, the `save_task`
 * capability) lands here, so the gate is decided once and the run settles
 * the task itself; a caller that closed the task on its own would leave the
 * run waiting forever.
 */
export const decideGateForTask = async (
  {
    safeDb,
    workspaceId,
    taskEntityId,
    userId,
    decision,
    note,
    recordAuditEvent,
  }: DecideGateForTaskOptions,
  /** The resolver's side effects, including notices deferred until commit. */
  dependencies: Parameters<typeof resolveFlowReviewGate>[1] = {},
): Promise<Result<FlowRunActionResult, HandlerError | SafeDbError>> =>
  await Result.gen(async function* () {
    const gate = yield* Result.await(
      safeDb(
        async (tx) =>
          await reviewGateForTask(tx, { workspaceId, taskEntityId }),
      ),
    );
    if (gate === undefined) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "The workflow run this task reviewed no longer exists",
        }),
      );
    }
    const admission = yield* Result.await(
      safeDb(
        async (tx) =>
          await admitTaskFlowAccess(tx, {
            workspaceId,
            taskEntityId,
            userId,
            access: "read",
          }),
      ),
    );
    yield* admission;
    const resolved = yield* Result.await(
      resolveFlowReviewGate(
        {
          safeDb,
          workspaceId,
          organizationId: gate.organizationId,
          runId: gate.runId,
          reviewTaskEntityId: taskEntityId,
          userId,
          decision,
          note,
          recordAuditEvent,
        },
        dependencies,
      ),
    );
    return Result.ok(resolved);
  });
