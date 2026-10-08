import { panic } from "better-result";
import { and, asc, eq, getTableColumns, lte, not, or, sql } from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import type { Transaction } from "@/api/db/root";
import {
  flowDefinitions,
  flowUploadTriggerIntents,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { backgroundFeatureActorExists } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import type {
  StartAutomatedFlowRunArgs,
  StartAutomatedFlowRunOutcome,
} from "@/api/lib/flows/start-automated-flow-run";
import { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import { logger as recoveryLogger } from "@/api/lib/observability/logger";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const RECOVER_UPLOAD_FLOW_TRIGGERS_TASK =
  "flows.recoverUploadTriggers" as const;
const UPLOAD_TRIGGER_BATCH_SIZE = 32;
const UPLOAD_TRIGGER_RETRY_MS = 5 * 60_000;
// Step zero waits for the independently queued extraction to usually finish.
const FLOW_UPLOAD_TRIGGER_DELAY_MS = 30_000;

type UploadTriggerIntent = typeof flowUploadTriggerIntents.$inferSelect;
type UploadTriggerCandidate = {
  intent: UploadTriggerIntent;
  definition: Pick<typeof flowDefinitions.$inferSelect, "createdByUserId">;
  workspaceStatus: string;
};

type SelectedUploadTriggerCandidate = UploadTriggerCandidate & {
  originalRetryAt: TimestampCasToken;
};

type DispatchUploadFlowTriggerOptions = {
  candidate: UploadTriggerCandidate & { claimToken: TimestampCasToken };
  start: (
    input: StartAutomatedFlowRunArgs,
  ) => Promise<StartAutomatedFlowRunOutcome>;
};

/** The run transaction rechecks the current trigger against the durable receipt. */
export const dispatchUploadFlowTrigger = async ({
  candidate: { intent, definition, workspaceStatus, claimToken },
  start,
}: DispatchUploadFlowTriggerOptions): Promise<StartAutomatedFlowRunOutcome> => {
  if (workspaceStatus !== "active") {
    return { status: "paused" };
  }
  return await start({
    definitionId: intent.definitionId,
    uploadTriggerClaimToken: claimToken,
    organizationId: intent.organizationId,
    workspaceId: intent.workspaceId,
    createdByUserId: definition.createdByUserId,
    triggerSource: { type: "file-upload", entityId: intent.entityId },
    inputEntityIds: [intent.entityId],
    enqueueDelayMs: FLOW_UPLOAD_TRIGGER_DELAY_MS,
    logContext: {
      definitionId: intent.definitionId,
      workspaceId: intent.workspaceId,
      trigger: "file-upload",
    },
  });
};

type RecoverUploadFlowTriggerOptions = {
  database: SchedulerDb;
  now: Date;
  entityId?: SafeId<"entity">;
  signal?: AbortSignal;
  start?: DispatchUploadFlowTriggerOptions["start"];
};

type ClaimUploadTriggerCandidatesOptions = {
  database: SchedulerDb;
  now: Date;
  selected: SelectedUploadTriggerCandidate[];
};

const claimUploadTriggerCandidates = async ({
  database,
  now,
  selected,
}: ClaimUploadTriggerCandidatesOptions) => {
  const groups = Map.groupBy(
    selected,
    (candidate) => candidate.intent.organizationId,
  );
  const pages = await mapWithConcurrency({
    items: [...groups],
    limit: 4,
    operation: async ([organizationId, rows]) =>
      await withAggregateTransaction(database, async (tx) => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "flows",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
          return [];
        }
        const retryAt = new Date(now.getTime() + UPLOAD_TRIGGER_RETRY_MS);
        // audit: skip — tokenized claim bookkeeping; accepted runs own their audit trail.
        const claimed = await tx
          .update(flowUploadTriggerIntents)
          .set({ retryAt })
          .where(
            and(
              eq(flowUploadTriggerIntents.organizationId, organizationId),
              eq(flowUploadTriggerIntents.status, "pending"),
              uploadTriggerActorExists(),
              or(
                ...rows.map(({ intent, originalRetryAt }) =>
                  and(
                    eq(
                      flowUploadTriggerIntents.definitionId,
                      intent.definitionId,
                    ),
                    eq(flowUploadTriggerIntents.entityId, intent.entityId),
                    timestampMatchesCasToken(
                      flowUploadTriggerIntents.retryAt,
                      originalRetryAt,
                    ),
                  ),
                ),
              ),
            ),
          )
          .returning({
            ...getTableColumns(flowUploadTriggerIntents),
            claimToken: timestampCasToken(flowUploadTriggerIntents.retryAt),
          });
        return claimed.flatMap((intent) => {
          const candidate = rows.find(
            (row) =>
              row.intent.definitionId === intent.definitionId &&
              row.intent.entityId === intent.entityId,
          );
          return candidate === undefined
            ? panic("Claimed upload receipt was not selected")
            : [{ ...candidate, intent, claimToken: intent.claimToken }];
        });
      }),
  });
  return pages.flat();
};

type SettleUploadTriggerClaimOptions = {
  database: SchedulerDb;
  intent: UploadTriggerIntent;
  claimToken: TimestampCasToken;
};

const settleUploadTriggerClaim = async ({
  database,
  intent,
  claimToken,
}: SettleUploadTriggerClaimOptions): Promise<"settled" | "paused" | "stale"> =>
  await withAggregateTransaction(database, async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: intent.organizationId,
      featureId: "flows",
    });
    if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      return "paused";
    }
    const acquired = await withAggregateRowQuery({
      aggregate: "uploadReceipt",
      id: {
        definitionId: intent.definitionId,
        entityId: intent.entityId,
        organizationId: intent.organizationId,
      },
      mode: "update",
      tx,
      select: (queryTx) =>
        queryTx
          .select({
            definitionId: flowUploadTriggerIntents.definitionId,
            entityId: flowUploadTriggerIntents.entityId,
            organizationId: flowUploadTriggerIntents.organizationId,
            status: flowUploadTriggerIntents.status,
            admitted: uploadTriggerActorExists(),
          })
          .from(flowUploadTriggerIntents)
          .limit(1),
      where: and(
        eq(flowUploadTriggerIntents.organizationId, intent.organizationId),
        eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
        eq(flowUploadTriggerIntents.entityId, intent.entityId),
        timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, claimToken),
      ),
    });
    if (acquired.status === "busy") {
      throw acquired.error;
    }
    const current = acquired.rows.at(0);
    if (current === undefined || current.status !== "pending") {
      return "stale";
    }
    if (
      current.admitted !== true ||
      !isDeploymentFeatureEnabled("FEATURE_FLOWS")
    ) {
      return "paused";
    }
    // audit: skip — settle only the admitted delivery token after its durable run.
    const removed = await tx
      .delete(flowUploadTriggerIntents)
      .where(
        and(
          eq(flowUploadTriggerIntents.organizationId, intent.organizationId),
          eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
          eq(flowUploadTriggerIntents.entityId, intent.entityId),
          eq(flowUploadTriggerIntents.status, "pending"),
          timestampMatchesCasToken(
            flowUploadTriggerIntents.retryAt,
            claimToken,
          ),
          uploadTriggerActorExists(),
        ),
      )
      .returning({ entityId: flowUploadTriggerIntents.entityId });
    return removed.length === 0 ? "stale" : "settled";
  });

/** Owner-level sweep; ordinary upload writes persist receipts through workspace RLS. */
export const recoverUploadFlowTriggerIntents = async ({
  database,
  now,
  entityId,
  signal,
  start,
}: RecoverUploadFlowTriggerOptions) => {
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return { settled: 0, paused: 0, retry: 0, skipped: 0, stale: 0 };
  }
  if (entityId === undefined) {
    await reconcileUploadTriggerGrantState({ database, now });
  }
  const selected = (
    await readCursorPage(
      database
        .select({
          intent: flowUploadTriggerIntents,
          originalRetryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
          definition: {
            createdByUserId: flowDefinitions.createdByUserId,
          },
          workspaceStatus: workspaces.status,
        })
        .from(flowUploadTriggerIntents)
        .innerJoin(
          flowDefinitions,
          and(
            eq(flowDefinitions.id, flowUploadTriggerIntents.definitionId),
            eq(
              flowDefinitions.organizationId,
              flowUploadTriggerIntents.organizationId,
            ),
          ),
        )
        .innerJoin(
          workspaces,
          and(
            eq(workspaces.id, flowUploadTriggerIntents.workspaceId),
            eq(
              workspaces.organizationId,
              flowUploadTriggerIntents.organizationId,
            ),
          ),
        )
        .where(
          and(
            eq(flowUploadTriggerIntents.status, "pending"),
            eq(workspaces.status, "active"),
            uploadTriggerActorExists(),
            lte(flowUploadTriggerIntents.retryAt, sql`${now}::timestamptz`),
            entityId === undefined
              ? undefined
              : eq(flowUploadTriggerIntents.entityId, entityId),
          ),
        )
        .orderBy(
          asc(flowUploadTriggerIntents.retryAt),
          asc(flowUploadTriggerIntents.definitionId),
          asc(flowUploadTriggerIntents.entityId),
        ),
      {
        limit: UPLOAD_TRIGGER_BATCH_SIZE,
        cursorForItem: (row) => row.intent.entityId,
      },
    )
  ).items;

  const candidates = await claimUploadTriggerCandidates({
    database,
    now,
    selected,
  });
  const dependencies = automatedFlowRunDependencies(database);
  const outcomes = {
    settled: 0,
    paused: 0,
    retry: 0,
    skipped: 0,
    stale: selected.length - candidates.length,
  };
  for (const candidate of candidates) {
    if (signal?.aborted) {
      break;
    }
    const outcome = await dispatchUploadFlowTrigger({
      candidate,
      start:
        start ??
        (async (input) => await startAutomatedFlowRun(input, dependencies)),
    });
    switch (outcome.status) {
      case "skipped":
        outcomes.skipped += 1;
        break;
      case "stale":
        outcomes.stale += 1;
        break;
      case "settled": {
        // db-await-in-loop: settle one claimed receipt under its organization admission lock.
        const settled = await settleUploadTriggerClaim({
          database,
          intent: candidate.intent,
          claimToken: candidate.claimToken,
        });
        if (settled === "stale") {
          outcomes.stale += 1;
        } else if (settled === "paused") {
          outcomes.paused += 1;
        } else {
          outcomes.settled += 1;
        }
        break;
      }
      case "paused":
        outcomes.paused += 1;
        break;
      case "retry":
        outcomes.retry += 1;
        break;
      default: {
        outcome satisfies never;
        panic("Unexpected upload flow trigger outcome");
      }
    }
  }
  return outcomes;
};

export const recoverUploadFlowTriggers: SchedulerTask = async ({
  db,
  dueAt,
  logger,
  signal,
}) => {
  if (signal.aborted) {
    return;
  }
  const outcomes = await recoverUploadFlowTriggerIntents({
    database: db,
    now: dueAt.claimedAtDate(),
    signal,
  });
  logger.info("scheduler.upload_flow_triggers_recovered", outcomes);
};

const uploadTriggerActorExists = (userId?: SafeId<"user">) => sql`EXISTS (
  SELECT 1 FROM ${flowDefinitions}
  WHERE ${flowDefinitions.id} = ${flowUploadTriggerIntents.definitionId}
    AND ${flowDefinitions.organizationId} = ${flowUploadTriggerIntents.organizationId}
    AND (${flowDefinitions.createdByUserId} IS NULL OR (
      ${userId === undefined ? sql`true` : sql`${flowDefinitions.createdByUserId} = ${userId}`}
      AND ${backgroundFeatureActorExists({ organizationId: flowUploadTriggerIntents.organizationId, workspaceId: flowUploadTriggerIntents.workspaceId, featureId: "flows", userId: flowDefinitions.createdByUserId })}
    ))
)`;

type ResumeUploadTriggersAfterGrantOptions = {
  tx: Pick<Transaction, "select" | "execute" | "rollback">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  now: Date;
};

export const resumeUploadTriggersAfterGrant = async ({
  tx,
  organizationId,
  userId,
  now,
}: ResumeUploadTriggersAfterGrantOptions): Promise<void> => {
  await transitionScopedCount({
    tx,
    spec: UPLOAD_TRIGGER_TRANSITIONS,
    where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), eq(flowUploadTriggerIntents.status, "awaiting_grant"), uploadTriggerActorExists(userId))}`,
    options: {
      from: ["awaiting_grant"],
      to: "pending",
      set: { retryAt: now },
    },
    recordTransitionAuditEvent: (_tx, count) =>
      recoveryLogger.info("flow.upload_trigger_grant_resumed", { count }),
  });
};

type ReconcileUploadTriggerGrantStateOptions = {
  database: SchedulerDb;
  now: Date;
};

const reconcileUploadTriggerGrantState = async ({
  database,
  now,
}: ReconcileUploadTriggerGrantStateOptions) => {
  // Grant repair has its own budget; an older ungranted prefix cannot consume it.
  const resumed = (
    await readCursorPage(
      database
        .select({
          ...getTableColumns(flowUploadTriggerIntents),
          retryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
        })
        .from(flowUploadTriggerIntents)
        .where(
          and(
            eq(flowUploadTriggerIntents.status, "awaiting_grant"),
            uploadTriggerActorExists(),
          ),
        )
        .orderBy(
          asc(flowUploadTriggerIntents.retryAt),
          asc(flowUploadTriggerIntents.entityId),
        ),
      {
        limit: UPLOAD_TRIGGER_BATCH_SIZE,
        cursorForItem: (row) => row.entityId,
      },
    )
  ).items;
  const blocked = (
    await readCursorPage(
      database
        .select({
          ...getTableColumns(flowUploadTriggerIntents),
          retryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
        })
        .from(flowUploadTriggerIntents)
        .where(
          and(
            eq(flowUploadTriggerIntents.status, "pending"),
            not(uploadTriggerActorExists()),
          ),
        )
        .orderBy(
          asc(flowUploadTriggerIntents.retryAt),
          asc(flowUploadTriggerIntents.entityId),
        ),
      {
        limit: UPLOAD_TRIGGER_BATCH_SIZE,
        cursorForItem: (row) => row.entityId,
      },
    )
  ).items;
  const candidates = [...resumed, ...blocked];
  const groups = new Map<SafeId<"organization">, typeof candidates>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.organizationId);
    if (group === undefined) {
      groups.set(candidate.organizationId, [candidate]);
      continue;
    }
    group.push(candidate);
  }
  await mapWithConcurrency({
    items: [...groups],
    limit: 4,
    operation: async ([organizationId, rows]) =>
      withAggregateTransaction(database, async (tx) => {
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "flows",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
          return;
        }
        const identities = or(
          ...rows.map((row) =>
            and(
              eq(flowUploadTriggerIntents.entityId, row.entityId),
              eq(flowUploadTriggerIntents.definitionId, row.definitionId),
              timestampMatchesCasToken(
                flowUploadTriggerIntents.retryAt,
                row.retryAt,
              ),
            ),
          ),
        );
        await transitionScopedCount({
          tx,
          spec: UPLOAD_TRIGGER_TRANSITIONS,
          where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identities, not(uploadTriggerActorExists()))}`,
          options: { from: ["pending"], to: "awaiting_grant" },
          recordTransitionAuditEvent: (_tx, count) =>
            recoveryLogger.info("flow.upload_trigger_awaiting_grant", {
              count,
            }),
        });
        await transitionScopedCount({
          tx,
          spec: UPLOAD_TRIGGER_TRANSITIONS,
          where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identities, uploadTriggerActorExists())}`,
          options: {
            from: ["awaiting_grant"],
            to: "pending",
            set: { retryAt: now },
          },
          recordTransitionAuditEvent: (_tx, count) =>
            recoveryLogger.info("flow.upload_trigger_grant_repaired", {
              count,
            }),
        });
      }),
  });
};
