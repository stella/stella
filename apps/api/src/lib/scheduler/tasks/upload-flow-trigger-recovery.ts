import { panic } from "better-result";
import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lte,
  not,
  or,
  sql,
} from "drizzle-orm";

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
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
import { transitionRecoveryGrantState } from "@/api/lib/db/recovery-bookkeeping/grant-state";
import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { backgroundFeatureActorExists } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import { fileUploadTriggerMatchesSql } from "@/api/lib/flows/flow-trigger-logic";
import type { FlowUploadTriggerSkipReason } from "@/api/lib/flows/flow-types";
import {
  automatedFlowRunDependencies,
  startAutomatedFlowRun,
} from "@/api/lib/flows/start-automated-flow-run";
import type {
  StartAutomatedFlowRunArgs,
  StartAutomatedFlowRunOutcome,
} from "@/api/lib/flows/start-automated-flow-run";
import { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const RECOVER_UPLOAD_FLOW_TRIGGERS_TASK =
  "flows.recoverUploadTriggers" as const;
export const UPLOAD_TRIGGER_BATCH_SIZE = 32;
const UPLOAD_TRIGGER_RETRY_MS = 5 * 60_000;
// Step zero waits for the independently queued extraction to usually finish.
const FLOW_UPLOAD_TRIGGER_DELAY_MS = 30_000;

type UploadTriggerIntent = typeof flowUploadTriggerIntents.$inferSelect;
type UploadTriggerCandidate = {
  intent: UploadTriggerIntent;
  definition: Pick<typeof flowDefinitions.$inferSelect, "createdByUserId">;
  workspaceStatus: string;
};

type UploadReceiptIdentity = Pick<
  UploadTriggerIntent,
  "organizationId" | "definitionId" | "entityId"
>;

const lockUploadReceiptRows = async (
  tx: Pick<Transaction, "execute">,
  rows: readonly UploadReceiptIdentity[],
): Promise<void> => {
  const ordered = rows.toSorted((left, right) => {
    const leftKey = JSON.stringify([left.definitionId, left.entityId]);
    const rightKey = JSON.stringify([right.definitionId, right.entityId]);
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
  for (const id of ordered) {
    // db-await-in-loop: acquire physical composite receipt keys in the owner's deterministic order before multi-row mutations.
    const acquired = await withAggregateLock({
      aggregate: "uploadReceipt",
      id,
      tx,
      mode: "update",
    });
    if (acquired.status === "busy") {
      panic("Blocking aggregate acquisition returned busy");
    }
  }
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
const dispatchUploadFlowTrigger = async ({
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
        await lockUploadReceiptRows(
          tx,
          rows.map((row) => row.intent),
        );
        const retryAt = new Date(now.getTime() + UPLOAD_TRIGGER_RETRY_MS);
        const claimed = await mutateRecoveryClaim({
          type: "upload-claim",
          tx,
          table: flowUploadTriggerIntents,
          retryAt,
          where: sql`${and(
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
          )}`,
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
      where:
        and(
          eq(flowUploadTriggerIntents.organizationId, intent.organizationId),
          eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
          eq(flowUploadTriggerIntents.entityId, intent.entityId),
          timestampMatchesCasToken(
            flowUploadTriggerIntents.retryAt,
            claimToken,
          ),
        ) ?? panic("Missing upload trigger claim predicates"),
    });
    if (acquired.status === "busy") {
      panic("Blocking aggregate acquisition returned busy");
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
    const removed = await mutateRecoveryReceipt({
      type: "settle-upload",
      tx,
      table: flowUploadTriggerIntents,
      where: sql`${and(
        eq(flowUploadTriggerIntents.organizationId, intent.organizationId),
        eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
        eq(flowUploadTriggerIntents.entityId, intent.entityId),
        eq(flowUploadTriggerIntents.status, "pending"),
        timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, claimToken),
        uploadTriggerActorExists(),
      )}`,
    });
    return removed.length === 0 ? "stale" : "settled";
  });

type RecordSkippedUploadClaimOptions = SettleUploadTriggerClaimOptions & {
  reason: FlowUploadTriggerSkipReason;
};
const recordSkippedUploadClaim = async ({
  database,
  intent,
  claimToken,
  reason,
}: RecordSkippedUploadClaimOptions): Promise<"skipped" | "paused" | "stale"> =>
  withAggregateTransaction(database, async (tx) => {
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: intent.organizationId,
      featureId: "flows",
    });
    if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      return "paused" as const;
    }
    await lockUploadReceiptRows(tx, [intent]);
    const updatedCount = await transitionRecoveryGrantState({
      type: "upload",
      tx,
      table: flowUploadTriggerIntents,
      spec: UPLOAD_TRIGGER_TRANSITIONS,
      where: sql`${and(eq(flowUploadTriggerIntents.organizationId, intent.organizationId), eq(flowUploadTriggerIntents.definitionId, intent.definitionId), eq(flowUploadTriggerIntents.entityId, intent.entityId), timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, claimToken), reason === "actor_missing" ? uploadTriggerActorMissing() : undefined)}`,
      options: {
        from: ["pending"],
        to: "skipped",
        set: { skipReason: reason },
      },
      log: { event: "flow.upload_trigger_skipped", reason },
    });
    if (updatedCount !== 0) {
      return "skipped" as const;
    }
    const recorded = await tx
      .select({ entityId: flowUploadTriggerIntents.entityId })
      .from(flowUploadTriggerIntents)
      .where(
        and(
          eq(flowUploadTriggerIntents.organizationId, intent.organizationId),
          eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
          eq(flowUploadTriggerIntents.entityId, intent.entityId),
          eq(flowUploadTriggerIntents.status, "skipped"),
          eq(flowUploadTriggerIntents.skipReason, reason),
          timestampMatchesCasToken(
            flowUploadTriggerIntents.retryAt,
            claimToken,
          ),
        ),
      )
      .limit(1);
    return recorded.length === 0 ? "stale" : "skipped";
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
      case "skipped": {
        // db-await-in-loop: retain the exact claimed receipt and its typed skip instead of deleting it.
        const recorded = await recordSkippedUploadClaim({
          database,
          intent: candidate.intent,
          claimToken: candidate.claimToken,
          reason: outcome.reason,
        });
        switch (recorded) {
          case "skipped":
            outcomes.skipped += 1;
            break;
          case "paused":
            outcomes.paused += 1;
            break;
          case "stale":
            outcomes.stale += 1;
            break;
          default:
            recorded satisfies never;
            return panic("Unknown upload recovery settlement");
        }
        break;
      }
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

const uploadTriggerActorMissing = () => sql`EXISTS (
  SELECT 1 FROM ${flowDefinitions}
  WHERE ${flowDefinitions.id} = ${flowUploadTriggerIntents.definitionId}
    AND ${flowDefinitions.organizationId} = ${flowUploadTriggerIntents.organizationId}
    AND ${flowDefinitions.createdByUserId} IS NULL
)`;

const uploadTriggerReplayEligible = () => sql`EXISTS (
  SELECT 1 FROM ${flowDefinitions}
  WHERE ${flowDefinitions.id} = ${flowUploadTriggerIntents.definitionId}
    AND ${flowDefinitions.organizationId} = ${flowUploadTriggerIntents.organizationId}
    AND ${flowDefinitions.enabled} = true
    AND ${flowDefinitions.createdByUserId} IS NOT NULL
    AND ${fileUploadTriggerMatchesSql({ trigger: flowDefinitions.trigger, workspaceId: flowUploadTriggerIntents.workspaceId, extension: flowUploadTriggerIntents.fileExtension })}
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
  await lockFeatureRecoveryAdmission({
    tx,
    organizationId,
    featureId: "flows",
  });
  const page = await readCursorPage(
    tx
      .select({
        ...getTableColumns(flowUploadTriggerIntents),
        retryAtToken: timestampCasToken(flowUploadTriggerIntents.retryAt),
      })
      .from(flowUploadTriggerIntents)
      .where(
        and(
          eq(flowUploadTriggerIntents.organizationId, organizationId),
          inArray(flowUploadTriggerIntents.status, [
            "awaiting_grant",
            "skipped",
          ]),
          uploadTriggerActorExists(userId),
          uploadTriggerReplayEligible(),
        ),
      )
      .orderBy(
        flowUploadTriggerIntents.definitionId,
        flowUploadTriggerIntents.entityId,
      ),
    { limit: UPLOAD_TRIGGER_BATCH_SIZE, cursorForItem: (row) => row.entityId },
  );
  const rows = page.items;
  if (rows.length === 0 || !isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return;
  }
  await lockUploadReceiptRows(tx, rows);
  await transitionRecoveryGrantState({
    type: "upload",
    tx,
    table: flowUploadTriggerIntents,
    spec: UPLOAD_TRIGGER_TRANSITIONS,
    // sql-perf-allow: bounded by 32 preselected and prelocked exact (definition_id, entity_id) primary-key identities; actor/trigger subqueries only narrow those receipts.
    where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), uploadTriggerActorExists(userId), uploadTriggerReplayEligible(), or(...rows.map((row) => and(eq(flowUploadTriggerIntents.definitionId, row.definitionId), eq(flowUploadTriggerIntents.entityId, row.entityId), timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, row.retryAtToken)))))}`,
    options: {
      from: ["awaiting_grant", "skipped"],
      to: "pending",
      set: { retryAt: now, skipReason: null },
    },
    log: { event: "flow.upload_trigger_grant_resumed" },
  });
};

type UploadTriggerGrantRepairStatus = "awaiting_grant" | "skipped";

// Literal predicates preserve the partial-index path for generic prepared plans too.
const uploadTriggerGrantRepairStatusCondition = (
  status: UploadTriggerGrantRepairStatus,
) => {
  switch (status) {
    case "awaiting_grant":
      return sql`${flowUploadTriggerIntents.status} = 'awaiting_grant'`;
    case "skipped":
      return sql`${flowUploadTriggerIntents.status} = 'skipped'`;
    default:
      status satisfies never;
      return panic("Unknown upload grant repair status");
  }
};

type UploadTriggerGrantRepairQueryOptions = {
  database: SchedulerDb;
  status: UploadTriggerGrantRepairStatus;
  limit: number;
};

export const uploadTriggerGrantRepairQuery = ({
  database,
  status,
  limit,
}: UploadTriggerGrantRepairQueryOptions) =>
  database
    .select({
      ...getTableColumns(flowUploadTriggerIntents),
      retryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
    })
    .from(flowDefinitions)
    .innerJoin(
      flowUploadTriggerIntents,
      and(
        eq(flowUploadTriggerIntents.definitionId, flowDefinitions.id),
        eq(
          flowUploadTriggerIntents.organizationId,
          flowDefinitions.organizationId,
        ),
      ),
    )
    .where(
      and(
        eq(flowDefinitions.enabled, true),
        isNotNull(flowDefinitions.createdByUserId),
        uploadTriggerGrantRepairStatusCondition(status),
        backgroundFeatureActorExists({
          organizationId: flowDefinitions.organizationId,
          workspaceId: flowUploadTriggerIntents.workspaceId,
          featureId: "flows",
          userId: flowDefinitions.createdByUserId,
        }),
        fileUploadTriggerMatchesSql({
          trigger: flowDefinitions.trigger,
          workspaceId: flowUploadTriggerIntents.workspaceId,
          extension: flowUploadTriggerIntents.fileExtension,
        }),
      ),
    )
    .orderBy(
      asc(flowUploadTriggerIntents.definitionId),
      asc(flowUploadTriggerIntents.retryAt),
      asc(flowUploadTriggerIntents.entityId),
    )
    .limit(limit)
    .$dynamic();

const selectResumedUploadTriggerState = async (
  database: SchedulerDb,
  status: UploadTriggerGrantRepairStatus,
) =>
  (
    await readCursorPage(
      uploadTriggerGrantRepairQuery({
        database,
        status,
        limit: UPLOAD_TRIGGER_BATCH_SIZE + 1,
      }),
      {
        limit: UPLOAD_TRIGGER_BATCH_SIZE,
        cursorForItem: (row) => row.entityId,
      },
    )
  ).items;

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
    await Promise.all([
      selectResumedUploadTriggerState(database, "awaiting_grant"),
      selectResumedUploadTriggerState(database, "skipped"),
    ])
  ).flat();
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
  const missingAuthors = (
    await readCursorPage(
      database
        .select({
          ...getTableColumns(flowUploadTriggerIntents),
          retryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
        })
        .from(flowUploadTriggerIntents)
        .where(
          and(
            inArray(flowUploadTriggerIntents.status, [
              "pending",
              "awaiting_grant",
            ]),
            uploadTriggerActorMissing(),
          ),
        )
        .orderBy(
          flowUploadTriggerIntents.definitionId,
          flowUploadTriggerIntents.entityId,
        ),
      {
        limit: UPLOAD_TRIGGER_BATCH_SIZE,
        cursorForItem: (row) => row.entityId,
      },
    )
  ).items;
  const candidates = [...resumed, ...blocked, ...missingAuthors];
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
        await lockUploadReceiptRows(tx, rows);
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
        await transitionRecoveryGrantState({
          type: "upload",
          tx,
          table: flowUploadTriggerIntents,
          spec: UPLOAD_TRIGGER_TRANSITIONS,
          where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identities, uploadTriggerActorMissing())}`,
          options: {
            from: ["pending", "awaiting_grant"],
            to: "skipped",
            set: { skipReason: "actor_missing" },
          },
          log: {
            event: "flow.upload_trigger_skipped",
            reason: "actor_missing",
          },
        });
        await transitionRecoveryGrantState({
          type: "upload",
          tx,
          table: flowUploadTriggerIntents,
          spec: UPLOAD_TRIGGER_TRANSITIONS,
          where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identities, not(uploadTriggerActorExists()))}`,
          options: { from: ["pending"], to: "awaiting_grant" },
          log: { event: "flow.upload_trigger_awaiting_grant" },
        });
        await transitionRecoveryGrantState({
          type: "upload",
          tx,
          table: flowUploadTriggerIntents,
          spec: UPLOAD_TRIGGER_TRANSITIONS,
          where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identities, uploadTriggerActorExists(), uploadTriggerReplayEligible())}`,
          options: {
            from: ["awaiting_grant", "skipped"],
            to: "pending",
            set: { retryAt: now, skipReason: null },
          },
          log: { event: "flow.upload_trigger_grant_repaired" },
        });
      }),
  });
};
