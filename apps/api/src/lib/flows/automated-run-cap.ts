import { panic } from "better-result";
import { deepEquals } from "bun";
import { and, eq, getTableColumns, gte, sql } from "drizzle-orm";

import { DAY_IN_MS, Temporal } from "@stll/time";

import type { rootDb, Transaction } from "@/api/db/root";
import {
  flowDefinitions,
  flowRuns,
  flowRunSteps,
  flowUploadTriggerIntents,
  schedulerJobs,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateTransaction,
  withAggregateRowQuery,
  withAggregateLock,
} from "@/api/lib/db/aggregate-lock";
import { mutateRecoveryClaim } from "@/api/lib/db/recovery-bookkeeping/claims";
import { transitionRecoveryGrantState } from "@/api/lib/db/recovery-bookkeeping/grant-state";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  fileUploadTriggerMatches,
  isAutomatedRunCapReached,
} from "@/api/lib/flows/flow-trigger-logic";
import type {
  FlowTrigger,
  FlowTriggerSource,
  FlowUploadTriggerSkipReason,
} from "@/api/lib/flows/flow-types";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import type { FlowRunRows } from "@/api/lib/flows/start-flow-run";
import { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

/**
 * Atomic daily spend rail for automated (schedule / file-upload) flow runs,
 * enforcing `MAX_AUTOMATED_FLOW_RUNS_PER_DEFINITION_PER_DAY`. "Today" is the
 * current UTC calendar day; manual runs are excluded via the `triggerSource`
 * discriminator.
 *
 * The count and the insert are one atomic decision: a plain count-then-insert
 * lets two concurrent triggers (a schedule tick and a file upload) both pass the
 * check and overshoot the cap. Here a per-definition advisory transaction lock
 * serializes concurrent starts for the same definition, so the count sees every
 * committed sibling run before deciding whether to insert.
 *
 * Runs on the caller's owner connection (the scheduler's, or the upload
 * trigger's, like `processExtraction`): the cap is org-wide per definition, so the count must span every workspace, which
 * an RLS-scoped, single-workspace session could not see. The run's
 * `workspace_id` still comes from a server-validated trigger source.
 */

const replayIdentityFor = (triggerSource: FlowTriggerSource) => {
  switch (triggerSource.type) {
    case "file-upload":
      return and(
        sql`${flowRuns.triggerSource}->>'type' = 'file-upload'`,
        sql`${flowRuns.triggerSource}->>'entityId' = ${triggerSource.entityId}`,
      );
    case "schedule":
      return triggerSource.dueSlot === undefined
        ? undefined
        : and(
            sql`${flowRuns.triggerSource}->>'type' = 'schedule'`,
            sql`${flowRuns.triggerSource}->>'dueSlot' = ${triggerSource.dueSlot}`,
          );
    case "manual":
      return undefined;
    default:
      triggerSource satisfies never;
      return panic("Unknown flow trigger source");
  }
};

const startOfUtcDay = (now: Date): Date =>
  new Date(
    Temporal.Instant.fromEpochMilliseconds(now.getTime())
      .toZonedDateTimeISO("UTC")
      .startOfDay().epochMilliseconds,
  );

export type InsertAutomatedFlowRunWithinCapInput = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  definitionId: SafeId<"flowDefinition">;
  /** Pre-built run + step rows (see `buildFlowRunRows`). */
  rows: FlowRunRows;
  expectedScheduleTrigger?:
    | Extract<FlowTrigger, { type: "schedule" }>
    | undefined;
  now?: Date;
  reservePeriod?: () => Promise<void>;
  uploadTriggerClaimToken?: TimestampCasToken | undefined;
  schedulerClaim?:
    | {
        jobId: string;
        lockedBy: string;
      }
    | undefined;
  database: Pick<typeof rootDb, "transaction">;
};

/**
 * Outcome of the gated insert. `capped` carries the observed count so the
 * caller can surface it exactly like the previous best-effort guard did; the
 * insert simply did not happen. The caller already holds the run id it built
 * the rows with, so `started` need not echo it back.
 */
export type InsertAutomatedFlowRunWithinCapResult =
  | { outcome: "stale" }
  | { outcome: "paused" }
  | { outcome: "started" }
  | { outcome: "already-started" }
  | { outcome: "source-removed" }
  | { outcome: "skipped"; reason: FlowUploadTriggerSkipReason }
  | { outcome: "capped"; dailyRunCount: number };

type RevalidateUploadIntentOptions = {
  tx: Transaction;
  definitionId: SafeId<"flowDefinition">;
  definition: typeof flowDefinitions.$inferSelect | undefined;
  entityId: SafeId<"entity">;
  rows: FlowRunRows;
};

type RevalidatedUploadIntent =
  | { type: "current"; rows: FlowRunRows }
  | { type: "source-removed" }
  | { type: "skipped"; reason: FlowUploadTriggerSkipReason };

/** The caller holds the definition row until either the skip or run commits. */
const revalidateUploadIntent = async ({
  tx,
  definitionId,
  definition,
  entityId,
  rows,
}: RevalidateUploadIntentOptions): Promise<RevalidatedUploadIntent> => {
  if (definition === undefined) {
    return { type: "source-removed" };
  }
  const receipt = (
    await tx
      .select({
        ...getTableColumns(flowUploadTriggerIntents),
        retryAtToken: timestampCasToken(flowUploadTriggerIntents.retryAt),
      })
      .from(flowUploadTriggerIntents)
      .where(
        and(
          eq(flowUploadTriggerIntents.definitionId, definitionId),
          eq(flowUploadTriggerIntents.entityId, entityId),
          eq(
            flowUploadTriggerIntents.organizationId,
            definition.organizationId,
          ),
          eq(flowUploadTriggerIntents.workspaceId, rows.run.workspaceId),
        ),
      )
      .limit(1)
  ).at(0);
  if (receipt === undefined) {
    return { type: "source-removed" };
  }
  if (receipt.status === "skipped") {
    return {
      type: "skipped",
      reason:
        receipt.skipReason ?? panic("Skipped upload receipt requires a reason"),
    };
  }
  const reason = (() => {
    if (definition.createdByUserId === null) {
      return "actor_missing" as const;
    }
    if (!definition.enabled) {
      return "definition_disabled" as const;
    }
    if (
      definition.trigger.type !== "file-upload" ||
      !fileUploadTriggerMatches({
        trigger: definition.trigger,
        workspaceId: receipt.workspaceId,
        extension: receipt.fileExtension,
      })
    ) {
      return "trigger_no_longer_matches" as const;
    }
    return undefined;
  })();
  if (reason !== undefined) {
    await transitionRecoveryGrantState({
      type: "upload",
      tx,
      table: flowUploadTriggerIntents,
      spec: UPLOAD_TRIGGER_TRANSITIONS,
      where: sql`${and(eq(flowUploadTriggerIntents.organizationId, definition.organizationId), eq(flowUploadTriggerIntents.workspaceId, rows.run.workspaceId), eq(flowUploadTriggerIntents.definitionId, definitionId), eq(flowUploadTriggerIntents.entityId, entityId), eq(flowUploadTriggerIntents.status, "pending"), timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, receipt.retryAtToken))}`,
      options: {
        from: ["pending"],
        to: "skipped",
        set: { skipReason: reason },
      },
      log: { event: "flow.upload_trigger_skipped", reason },
    });
    return { type: "skipped", reason };
  }
  return {
    type: "current",
    rows: buildFlowRunRows({
      runId: rows.run.id,
      workspaceId: rows.run.workspaceId,
      definitionId,
      definition: { name: definition.name, steps: definition.steps },
      triggerSource: rows.run.triggerSource,
      inputEntityIds: rows.run.inputEntityIds,
    }),
  };
};

type DeferCappedUploadIntentOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  definitionId: SafeId<"flowDefinition">;
  entityId: SafeId<"entity">;
  claimToken: TimestampCasToken;
  now: Date;
};

const deferCappedUploadIntent = async ({
  tx,
  organizationId,
  workspaceId,
  definitionId,
  entityId,
  claimToken,
  now,
}: DeferCappedUploadIntentOptions): Promise<void> => {
  await mutateRecoveryClaim({
    type: "upload-defer",
    tx,
    table: flowUploadTriggerIntents,
    retryAt: new Date(startOfUtcDay(now).getTime() + DAY_IN_MS),
    where: sql`${and(
      eq(flowUploadTriggerIntents.organizationId, organizationId),
      eq(flowUploadTriggerIntents.workspaceId, workspaceId),
      eq(flowUploadTriggerIntents.definitionId, definitionId),
      eq(flowUploadTriggerIntents.entityId, entityId),
      eq(flowUploadTriggerIntents.status, "pending"),
      timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, claimToken),
    )}`,
  });
};

export const insertAutomatedFlowRunWithinCap = async ({
  organizationId,
  userId,
  definitionId,
  rows,
  expectedScheduleTrigger,
  uploadTriggerClaimToken,
  schedulerClaim,
  now = new Date(),
  reservePeriod,
  database,
}: InsertAutomatedFlowRunWithinCapInput): Promise<InsertAutomatedFlowRunWithinCapResult> =>
  await withAggregateTransaction(database, async (tx) => {
    // Admission precedes resource locks; the existing cap -> definition order stays intact.
    await lockFeatureRecoveryAdmission({
      tx,
      organizationId,
      featureId: "flows",
    });
    if (
      !(await isBackgroundFeatureEnabled({
        tx,
        organizationId,
        userId,
        featureId: "flows",
      }))
    ) {
      return { outcome: "paused" };
    }
    if (schedulerClaim !== undefined) {
      const owned = await withAggregateRowQuery({
        aggregate: "schedulerClaim",
        id: { id: schedulerClaim.jobId },
        tx,
        mode: "update",
        where: eq(schedulerJobs.lockedBy, schedulerClaim.lockedBy),
        select: (queryTx) =>
          queryTx.select({ id: schedulerJobs.id }).from(schedulerJobs).limit(1),
      });
      if (owned.status === "busy") {
        panic("Blocking aggregate acquisition returned busy");
      }
      if (owned.rows.length === 0) {
        return { outcome: "stale" };
      }
    }
    // Serialize concurrent automated starts for this definition. The xact lock
    // releases on commit/rollback, after the prior holder's run row is visible,
    // so the count below can never miss a committed sibling.
    await withAggregateLock({
      aggregate: "definitionCap",
      id: { definitionId },
      tx,
    });

    // Keep the cap's advisory lock before the definition lock already
    // required by run insertion. NO KEY UPDATE also permits receipt FK checks.
    let currentDefinition: typeof flowDefinitions.$inferSelect | undefined;
    if (
      rows.run.triggerSource.type === "file-upload" ||
      rows.run.triggerSource.type === "schedule"
    ) {
      const definition = await withAggregateRowQuery({
        aggregate: "definition",
        id: { id: definitionId, organizationId },
        tx,
        mode: "no key update",
        select: (queryTx) => queryTx.select().from(flowDefinitions).limit(1),
      });
      if (definition.status === "busy") {
        panic("Blocking aggregate acquisition returned busy");
      }
      currentDefinition = definition.rows.at(0);
    }

    if (rows.run.triggerSource.type === "file-upload") {
      if (uploadTriggerClaimToken === undefined) {
        return { outcome: "stale" };
      }
      const owned = await withAggregateRowQuery({
        aggregate: "uploadReceipt",
        id: {
          definitionId,
          organizationId,
          entityId: brandPersistedEntityId(rows.run.triggerSource.entityId),
        },
        tx,
        mode: "update",
        where: and(
          eq(flowUploadTriggerIntents.workspaceId, rows.run.workspaceId),
          eq(flowUploadTriggerIntents.status, "pending"),
          timestampMatchesCasToken(
            flowUploadTriggerIntents.retryAt,
            uploadTriggerClaimToken,
          ),
        ),
        select: (queryTx) =>
          queryTx
            .select({
              definitionId: flowUploadTriggerIntents.definitionId,
              organizationId: flowUploadTriggerIntents.organizationId,
              entityId: flowUploadTriggerIntents.entityId,
            })
            .from(flowUploadTriggerIntents)
            .limit(1),
      });
      if (owned.status === "busy") {
        panic("Blocking aggregate acquisition returned busy");
      }
      if (owned.rows.length === 0) {
        return { outcome: "stale" };
      }
    }

    // Recovery may replay after the run committed but before its receipt settled.
    // The same definition lock makes this decision atomic with every insertion.
    const replayIdentity = replayIdentityFor(rows.run.triggerSource);
    if (replayIdentity !== undefined) {
      const existing = await tx
        .select({ id: flowRuns.id })
        .from(flowRuns)
        .where(
          and(
            eq(flowRuns.definitionId, definitionId),
            eq(flowRuns.workspaceId, rows.run.workspaceId),
            replayIdentity,
          ),
        )
        .limit(1);
      if (existing.length !== 0) {
        return { outcome: "already-started" };
      }
    }

    let currentRows = rows;
    if (rows.run.triggerSource.type === "schedule") {
      if (
        !currentDefinition?.enabled ||
        currentDefinition.trigger.type !== "schedule" ||
        currentDefinition.trigger.workspaceId !== rows.run.workspaceId ||
        expectedScheduleTrigger === undefined ||
        !deepEquals(currentDefinition.trigger, expectedScheduleTrigger)
      ) {
        return { outcome: "stale" };
      }
      currentRows = buildFlowRunRows({
        runId: rows.run.id,
        workspaceId: rows.run.workspaceId,
        definitionId,
        definition: currentDefinition,
        triggerSource: rows.run.triggerSource,
        inputEntityIds: rows.run.inputEntityIds,
      });
    }
    if (rows.run.triggerSource.type === "file-upload") {
      const validation = await revalidateUploadIntent({
        tx,
        definitionId,
        definition: currentDefinition,
        entityId: brandPersistedEntityId(rows.run.triggerSource.entityId),
        rows,
      });
      switch (validation.type) {
        case "source-removed":
          return { outcome: "source-removed" };
        case "skipped":
          return { outcome: "skipped", reason: validation.reason };
        case "current":
          currentRows = validation.rows;
          break;
        default:
          validation satisfies never;
          return panic("Unknown upload intent validation");
      }
    }

    const dailyRunCount = await tx.$count(
      flowRuns,
      and(
        eq(flowRuns.definitionId, definitionId),
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
        gte(flowRuns.createdAt, startOfUtcDay(now)),
        sql`${flowRuns.triggerSource}->>'type' in ('schedule', 'file-upload')`,
      ),
    );
    if (isAutomatedRunCapReached(dailyRunCount)) {
      if (
        rows.run.triggerSource.type === "file-upload" &&
        uploadTriggerClaimToken !== undefined
      ) {
        await deferCappedUploadIntent({
          tx,
          organizationId,
          workspaceId: rows.run.workspaceId,
          definitionId,
          entityId: brandPersistedEntityId(rows.run.triggerSource.entityId),
          claimToken: uploadTriggerClaimToken,
          now,
        });
      }
      return { outcome: "capped", dailyRunCount };
    }

    await tx.insert(flowRuns).values(currentRows.run);
    await tx.insert(flowRunSteps).values(currentRows.steps);
    // A refusal rolls the inserted run back. A later commit failure may rarely
    // over-count the operational throttle; reservations are never refunded.
    await reservePeriod?.();
    return { outcome: "started" };
  });
