import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  getColumns,
  inArray,
  isNotNull,
  lte,
  not,
  sql,
} from "drizzle-orm";

import { mapWithConcurrency } from "@stll/concurrency";

import { proveOrgScope, withOrgScope } from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import {
  flowDefinitions,
  flowUploadTriggerIntents,
  workspaces,
} from "@/api/db/schema";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateLock,
  withAggregateRowQuery,
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
import { SchedulerTaskFailure } from "@/api/lib/scheduler/types";
import type {
  SchedulerDb,
  SchedulerTask,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";

import {
  checkpointRecoveryScan,
  readRecoveryScanState,
} from "./recovery-scan-cursor";
import type {
  RecoveryScanContext,
  UploadRecoveryCursor,
  UploadRecoveryState,
} from "./recovery-scan-cursor";
import {
  RECOVERY_SCAN_IDENTITIES,
  RECOVERY_SCAN_PAGE_SIZES,
  RECOVERY_SCAN_PHASES,
} from "./recovery-scan-identity";

export const RECOVER_UPLOAD_FLOW_TRIGGERS_TASK =
  RECOVERY_SCAN_IDENTITIES.upload.task;
export const UPLOAD_TRIGGER_BATCH_SIZE = 32;
export const UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS = 5000;
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
  recovery?: RecoveryScanContext & { state: UploadRecoveryState };
};

type ReadUploadTriggerDispatchPageOptions = Pick<
  RecoverUploadFlowTriggerOptions,
  "database" | "now"
> & {
  entityId: RecoverUploadFlowTriggerOptions["entityId"];
  recovery: RecoverUploadFlowTriggerOptions["recovery"];
};

const readUploadTriggerDispatchPage = async ({
  database,
  now,
  entityId,
  recovery,
}: ReadUploadTriggerDispatchPageOptions) =>
  await withAggregateTransaction(database, async (tx) => {
    await setSharedStatementTimeout(
      tx,
      UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
    );
    return await readCursorPage(
      tx
        .select({
          intent: flowUploadTriggerIntents,
          originalRetryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
          definition: { createdByUserId: flowDefinitions.createdByUserId },
          workspaceStatus: workspaces.status,
          actorExists: uploadTriggerActorExists(),
          due: sql<boolean>`${flowUploadTriggerIntents.retryAt} <= ${now}::timestamptz`,
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
          entityId === undefined
            ? afterUploadRecoveryCursor(recovery?.state.dispatch ?? null)
            : and(
                eq(flowUploadTriggerIntents.entityId, entityId),
                eq(flowUploadTriggerIntents.status, "pending"),
                eq(workspaces.status, "active"),
                uploadTriggerActorExists(),
                lte(flowUploadTriggerIntents.retryAt, sql`${now}::timestamptz`),
              ),
        )
        .orderBy(
          ...(entityId === undefined
            ? [
                flowUploadTriggerIntents.definitionId,
                flowUploadTriggerIntents.entityId,
              ]
            : [
                flowUploadTriggerIntents.retryAt,
                flowUploadTriggerIntents.definitionId,
                flowUploadTriggerIntents.entityId,
              ]),
        ),
      {
        limit:
          entityId === undefined
            ? RECOVERY_SCAN_PAGE_SIZES.dispatch
            : UPLOAD_TRIGGER_BATCH_SIZE,
        cursorForItem: (row) =>
          `${row.intent.definitionId}:${row.intent.entityId}`,
      },
    );
  });

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
        await setSharedStatementTimeout(
          tx,
          UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
        );
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
        const claims = await mapWithConcurrency({
          items: rows,
          limit: 1,
          operation: async (candidate) => {
            const { intent, originalRetryAt } = candidate;
            const where = sql`${and(
              eq(flowUploadTriggerIntents.organizationId, organizationId),
              eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
              eq(flowUploadTriggerIntents.entityId, intent.entityId),
              eq(flowUploadTriggerIntents.status, "pending"),
              uploadTriggerActorExists(),
              timestampMatchesCasToken(
                flowUploadTriggerIntents.retryAt,
                originalRetryAt,
              ),
            )}`;
            const scopeResult = await proveOrgScope(tx, {
              table: "flowUploadTriggerIntents",
              where,
            });
            const scope = scopeResult.unwrapOr(null);
            if (scope === null) {
              return [];
            }
            return await withOrgScope({
              tx,
              scope,
              actor: { type: "system" },
              fn: async (scopedTx) => {
                const claimed = await mutateRecoveryClaim({
                  type: "upload-claim",
                  tx: scopedTx,
                  scope,
                  retryAt,
                  where,
                });
                return claimed.map((current) => {
                  if (
                    current.definitionId !== intent.definitionId ||
                    current.entityId !== intent.entityId
                  ) {
                    return panic("Claimed upload receipt was not selected");
                  }
                  return {
                    ...candidate,
                    intent: current,
                    claimToken: current.claimToken,
                  };
                });
              },
            });
          },
        });
        return claims.flat();
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
    await setSharedStatementTimeout(
      tx,
      UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
    );
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
    const current = acquired.rows.at(0);
    if (current?.status !== "pending") {
      return "stale";
    }
    if (!current.admitted || !isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      return "paused";
    }
    const where = sql`${and(
      eq(flowUploadTriggerIntents.organizationId, intent.organizationId),
      eq(flowUploadTriggerIntents.definitionId, intent.definitionId),
      eq(flowUploadTriggerIntents.entityId, intent.entityId),
      eq(flowUploadTriggerIntents.status, "pending"),
      timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, claimToken),
      uploadTriggerActorExists(),
    )}`;
    const scopeResult = await proveOrgScope(tx, {
      table: "flowUploadTriggerIntents",
      where,
    });
    const scope = scopeResult.unwrapOr(null);
    if (scope === null) {
      return "stale";
    }
    return await withOrgScope({
      tx,
      scope,
      actor: { type: "system" },
      fn: async (scopedTx) => {
        const removed = await mutateRecoveryReceipt({
          type: "settle-upload",
          tx: scopedTx,
          scope,
          where,
        });
        return removed.length === 0 ? "stale" : "settled";
      },
    });
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
    await setSharedStatementTimeout(
      tx,
      UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
    );
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId: intent.organizationId,
      featureId: "flows",
    });
    if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
      return "paused" as const;
    }
    await lockUploadReceiptRows(tx, [intent]);
    const where = sql`${and(eq(flowUploadTriggerIntents.organizationId, intent.organizationId), eq(flowUploadTriggerIntents.definitionId, intent.definitionId), eq(flowUploadTriggerIntents.entityId, intent.entityId), timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, claimToken), reason === "actor_missing" ? uploadTriggerActorMissing() : undefined)}`;
    const scopeResult = await proveOrgScope(tx, {
      table: "flowUploadTriggerIntents",
      where,
    });
    const scope = scopeResult.unwrapOr(null);
    if (scope === null) {
      return "stale" as const;
    }
    return await withOrgScope({
      tx,
      scope,
      actor: { type: "system" },
      fn: async (scopedTx, grantScope) => {
        const updatedCount = await transitionRecoveryGrantState({
          type: "upload",
          tx: grantScope,
          where,
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
        const recorded = await scopedTx
          .select({ entityId: flowUploadTriggerIntents.entityId })
          .from(flowUploadTriggerIntents)
          .where(
            and(
              eq(
                flowUploadTriggerIntents.organizationId,
                intent.organizationId,
              ),
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
      },
    });
  });

/** Owner-level sweep; ordinary upload writes persist receipts through workspace RLS. */
export const recoverUploadFlowTriggerIntents = async ({
  database,
  now,
  entityId,
  signal,
  start,
  recovery,
}: RecoverUploadFlowTriggerOptions) => {
  if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
    return { settled: 0, paused: 0, retry: 0, skipped: 0, stale: 0 };
  }
  if (entityId === undefined) {
    const phase = recovery?.state.phase ?? RECOVERY_SCAN_PHASES.census;
    switch (phase) {
      case RECOVERY_SCAN_PHASES.census: {
        const census = await reconcileUploadTriggerGrantState({
          database,
          now,
          cursor: recovery?.state.census ?? null,
        });
        if (recovery !== undefined) {
          const state = {
            phase: RECOVERY_SCAN_PHASES.dispatch,
            census: census.cursor,
            dispatch: recovery.state.dispatch,
          };
          const saved = await checkpointRecoveryScan({
            database: recovery.database,
            job: recovery.job,
            statementTimeoutMs:
              UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
            state: { type: "upload", value: state },
          });
          if (!saved) {
            return { settled: 0, paused: 0, retry: 0, skipped: 0, stale: 0 };
          }
          recovery.state = state;
          recovery.scheduleContinuation(new Date(now.getTime() + 1000));
          return { settled: 0, paused: 0, retry: 0, skipped: 0, stale: 0 };
        }
        break;
      }
      case RECOVERY_SCAN_PHASES.dispatch:
        break;
      default:
        phase satisfies never;
        panic("Unknown upload recovery phase");
    }
  }
  const dispatchPage = await readUploadTriggerDispatchPage({
    database,
    now,
    entityId,
    recovery,
  });
  const selected = dispatchPage.items.filter(
    ({ intent, workspaceStatus, actorExists, due }) =>
      intent.status === "pending" &&
      workspaceStatus === "active" &&
      actorExists &&
      due &&
      (entityId === undefined || intent.entityId === entityId),
  );

  const candidates = await claimUploadTriggerCandidates({
    database,
    now,
    selected,
  });
  const dependencies = automatedFlowRunDependencies(database, {
    statementTimeoutMs: UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
  });
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
  if (
    entityId === undefined &&
    recovery !== undefined &&
    signal?.aborted !== true
  ) {
    const last = dispatchPage.items.at(-1)?.intent;
    const state = {
      phase: RECOVERY_SCAN_PHASES.census,
      census: recovery.state.census,
      dispatch:
        dispatchPage.nextCursor === null || last === undefined
          ? null
          : { definitionId: last.definitionId, entityId: last.entityId },
    };
    const saved = await checkpointRecoveryScan({
      database: recovery.database,
      job: recovery.job,
      statementTimeoutMs: UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
      state: { type: "upload", value: state },
    });
    if (!saved) {
      return outcomes;
    }
    recovery.state = state;
    if (
      state.census !== null ||
      dispatchPage.nextCursor !== null ||
      selected.length > 0
    ) {
      recovery.scheduleContinuation(new Date(now.getTime() + 1000));
    }
  }
  return outcomes;
};

const runUploadFlowTriggerRecovery = async ({
  db,
  dueAt,
  job,
  payload,
  logger,
  scheduleContinuation,
  signal,
}: SchedulerTaskContext) => {
  if (signal.aborted) {
    return;
  }
  const cursorState = readRecoveryScanState(job, payload);
  if (cursorState.type !== "upload") {
    panic("Upload recovery received a scout cursor state");
  }
  const outcomes = await recoverUploadFlowTriggerIntents({
    database: db,
    now: dueAt.claimedAtDate(),
    signal,
    recovery: {
      database: db,
      job,
      scheduleContinuation,
      state: cursorState.value,
    },
  });
  logger.info("scheduler.upload_flow_triggers_recovered", outcomes);
};

export const recoverUploadFlowTriggers: SchedulerTask = async (context) => {
  const outcome = await Result.tryPromise({
    try: async () => await runUploadFlowTriggerRecovery(context),
    catch: (cause) =>
      cause instanceof SchedulerTaskFailure
        ? cause
        : new SchedulerTaskFailure({
            message: "Upload flow recovery failed",
            cause,
          }),
  });
  if (outcome.isErr()) {
    return outcome;
  }
  return undefined;
};

const uploadTriggerActorExists = (
  userId?: SafeId<"user">,
) => sql<boolean>`EXISTS (
  SELECT 1 FROM ${flowDefinitions}
  WHERE ${flowDefinitions.id} = ${flowUploadTriggerIntents.definitionId}
    AND ${flowDefinitions.organizationId} = ${flowUploadTriggerIntents.organizationId}
    AND (${flowDefinitions.createdByUserId} IS NULL OR (
      ${userId === undefined ? sql`true` : sql`${flowDefinitions.createdByUserId} = ${userId}`}
      AND ${backgroundFeatureActorExists({ organizationId: flowUploadTriggerIntents.organizationId, workspaceId: flowUploadTriggerIntents.workspaceId, featureId: "flows", userId: flowDefinitions.createdByUserId })}
    ))
)`;

// A scalar primary-key lookup keeps a projected author check correlated;
// EXISTS can become a hashed subplan that scans every flow definition.
const uploadTriggerActorMissing = () => sql<boolean>`coalesce((
  SELECT ${flowDefinitions.createdByUserId} IS NULL FROM ${flowDefinitions}
  WHERE ${flowDefinitions.id} = ${flowUploadTriggerIntents.definitionId}
    AND ${flowDefinitions.organizationId} = ${flowUploadTriggerIntents.organizationId}
), false)`;

const uploadTriggerReplayEligible = () => sql<boolean>`EXISTS (
  SELECT 1 FROM ${flowDefinitions}
  WHERE ${flowDefinitions.id} = ${flowUploadTriggerIntents.definitionId}
    AND ${flowDefinitions.organizationId} = ${flowUploadTriggerIntents.organizationId}
    AND ${flowDefinitions.enabled} = true
    AND ${flowDefinitions.createdByUserId} IS NOT NULL
    AND ${fileUploadTriggerMatchesSql({ trigger: flowDefinitions.trigger, workspaceId: flowUploadTriggerIntents.workspaceId, extension: flowUploadTriggerIntents.fileExtension })}
)`;

type ResumeUploadTriggersAfterGrantOptions = {
  tx: Transaction;
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
        ...getColumns(flowUploadTriggerIntents),
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
  await mapWithConcurrency({
    items: rows,
    limit: 1,
    operation: async (row) => {
      const where = sql`${and(
        eq(flowUploadTriggerIntents.organizationId, organizationId),
        eq(flowUploadTriggerIntents.definitionId, row.definitionId),
        eq(flowUploadTriggerIntents.entityId, row.entityId),
        timestampMatchesCasToken(
          flowUploadTriggerIntents.retryAt,
          row.retryAtToken,
        ),
        uploadTriggerActorExists(userId),
        uploadTriggerReplayEligible(),
      )}`;
      const scopeResult = await proveOrgScope(tx, {
        table: "flowUploadTriggerIntents",
        where,
      });
      const scope = scopeResult.unwrapOr(null);
      if (scope === null) {
        return;
      }
      await withOrgScope({
        tx,
        scope,
        actor: { type: "system" },
        fn: async (_scopedTx, grantScope) => {
          await transitionRecoveryGrantState({
            type: "upload",
            tx: grantScope,
            where,
            options: {
              from: ["awaiting_grant", "skipped"],
              to: "pending",
              set: { retryAt: now, skipReason: null },
            },
            log: { event: "flow.upload_trigger_grant_resumed" },
          });
        },
      });
    },
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
      ...getColumns(flowUploadTriggerIntents),
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

const afterUploadRecoveryCursor = (cursor: UploadRecoveryCursor | null) =>
  cursor === null
    ? undefined
    : sql`(${flowUploadTriggerIntents.definitionId}, ${flowUploadTriggerIntents.entityId}) > (${cursor.definitionId}, ${cursor.entityId})`;

type ReconcileUploadTriggerGrantStateOptions = {
  database: SchedulerDb;
  now: Date;
  cursor: UploadRecoveryCursor | null;
};

const reconcileUploadTriggerGrantState = async ({
  database,
  now,
  cursor,
}: ReconcileUploadTriggerGrantStateOptions) => {
  const page = await withAggregateTransaction(database, async (tx) => {
    await setSharedStatementTimeout(
      tx,
      UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
    );
    return await readCursorPage(
      tx
        .select({
          ...getColumns(flowUploadTriggerIntents),
          retryAt: timestampCasToken(flowUploadTriggerIntents.retryAt),
          actorExists: uploadTriggerActorExists(),
          actorMissing: uploadTriggerActorMissing(),
          replayEligible: uploadTriggerReplayEligible(),
        })
        .from(flowUploadTriggerIntents)
        .where(afterUploadRecoveryCursor(cursor))
        .orderBy(
          asc(flowUploadTriggerIntents.definitionId),
          asc(flowUploadTriggerIntents.entityId),
        ),
      {
        limit: RECOVERY_SCAN_PAGE_SIZES.census,
        cursorForItem: (row) => `${row.definitionId}:${row.entityId}`,
      },
    );
  });
  const candidates = page.items.filter(
    ({ status, actorExists, actorMissing, replayEligible }) =>
      (status === "pending" && (!actorExists || actorMissing)) ||
      (status === "awaiting_grant" &&
        (actorMissing || (actorExists && replayEligible))) ||
      (status === "skipped" && actorExists && replayEligible),
  );
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
        await setSharedStatementTimeout(
          tx,
          UPLOAD_FLOW_TRIGGER_RECOVERY_STATEMENT_TIMEOUT_MS,
        );
        await lockFeatureRecoveryAdmission({
          tx,
          organizationId,
          featureId: "flows",
        });
        if (!isDeploymentFeatureEnabled("FEATURE_FLOWS")) {
          return;
        }
        await lockUploadReceiptRows(tx, rows);
        await mapWithConcurrency({
          items: rows,
          limit: 1,
          operation: async (row) => {
            const identity = and(
              eq(flowUploadTriggerIntents.entityId, row.entityId),
              eq(flowUploadTriggerIntents.definitionId, row.definitionId),
              timestampMatchesCasToken(
                flowUploadTriggerIntents.retryAt,
                row.retryAt,
              ),
            );
            const scopeResult = await proveOrgScope(tx, {
              table: "flowUploadTriggerIntents",
              where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identity)}`,
            });
            const scope = scopeResult.unwrapOr(null);
            if (scope === null) {
              return;
            }
            await withOrgScope({
              tx,
              scope,
              actor: { type: "system" },
              fn: async (_scopedTx, grantScope) => {
                await transitionRecoveryGrantState({
                  type: "upload",
                  tx: grantScope,
                  where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identity, uploadTriggerActorMissing())}`,
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
                  tx: grantScope,
                  where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identity, not(uploadTriggerActorExists()))}`,
                  options: { from: ["pending"], to: "awaiting_grant" },
                  log: { event: "flow.upload_trigger_awaiting_grant" },
                });
                await transitionRecoveryGrantState({
                  type: "upload",
                  tx: grantScope,
                  where: sql`${and(eq(flowUploadTriggerIntents.organizationId, organizationId), identity, uploadTriggerActorExists(), uploadTriggerReplayEligible())}`,
                  options: {
                    from: ["awaiting_grant", "skipped"],
                    to: "pending",
                    set: { retryAt: now, skipReason: null },
                  },
                  log: { event: "flow.upload_trigger_grant_repaired" },
                });
              },
            });
          },
        });
      }),
  });
  const last = page.items.at(-1);
  return {
    hasMore: page.nextCursor !== null,
    cursor:
      page.nextCursor === null || last === undefined
        ? null
        : { definitionId: last.definitionId, entityId: last.entityId },
  };
};
