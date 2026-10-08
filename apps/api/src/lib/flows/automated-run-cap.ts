import { panic } from "better-result";
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
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  fileUploadTriggerMatches,
  isAutomatedRunCapReached,
} from "@/api/lib/flows/flow-trigger-logic";
import type {
  FlowTriggerSource,
  FlowUploadTriggerSkipReason,
} from "@/api/lib/flows/flow-types";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import type { FlowRunRows } from "@/api/lib/flows/start-flow-run";
import { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import { logger } from "@/api/lib/observability/logger";
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

/**
 * Namespace for the per-definition advisory lock. `pg_advisory_xact_lock` keys
 * are process-global, so a fixed first key isolates this rail from unrelated
 * advisory locks; the definition-id hash is the second key.
 */
const FLOW_RUN_CAP_LOCK_NAMESPACE = 0x0f_10_cc_a9;

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
    await transitionScopedCount({
      tx,
      spec: UPLOAD_TRIGGER_TRANSITIONS,
      where: sql`${and(eq(flowUploadTriggerIntents.organizationId, definition.organizationId), eq(flowUploadTriggerIntents.workspaceId, rows.run.workspaceId), eq(flowUploadTriggerIntents.definitionId, definitionId), eq(flowUploadTriggerIntents.entityId, entityId), eq(flowUploadTriggerIntents.status, "pending"), timestampMatchesCasToken(flowUploadTriggerIntents.retryAt, receipt.retryAtToken))}`,
      options: {
        from: ["pending"],
        to: "skipped",
        set: { skipReason: reason },
      },
      recordTransitionAuditEvent: (_tx, count) => {
        logger.info("flow.upload_trigger_skipped", { count, reason });
      },
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

export const insertAutomatedFlowRunWithinCap = async ({
  organizationId,
  userId,
  definitionId,
  rows,
  uploadTriggerClaimToken,
  schedulerClaim,
  now = new Date(),
  reservePeriod,
  database,
}: InsertAutomatedFlowRunWithinCapInput): Promise<InsertAutomatedFlowRunWithinCapResult> =>
  await database.transaction(async (tx) => {
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
      const owned = await tx
        .select({ id: schedulerJobs.id })
        .from(schedulerJobs)
        .where(
          and(
            eq(schedulerJobs.id, schedulerClaim.jobId),
            eq(schedulerJobs.lockedBy, schedulerClaim.lockedBy),
          ),
        )
        .limit(1)
        .for("update");
      if (owned.length === 0) {
        return { outcome: "stale" };
      }
    }
    // Serialize concurrent automated starts for this definition. The xact lock
    // releases on commit/rollback, after the prior holder's run row is visible,
    // so the count below can never miss a committed sibling.
    await tx.execute(
      sql`select pg_advisory_xact_lock(${FLOW_RUN_CAP_LOCK_NAMESPACE}, hashtext(${definitionId}))`,
    );

    // Keep the cap's advisory lock before the definition lock already
    // required by run insertion. NO KEY UPDATE also permits receipt FK checks.
    const uploadDefinition =
      rows.run.triggerSource.type === "file-upload"
        ? (
            await tx
              .select()
              .from(flowDefinitions)
              .where(
                and(
                  eq(flowDefinitions.id, definitionId),
                  eq(flowDefinitions.organizationId, organizationId),
                ),
              )
              .limit(1)
              .for("no key update")
          ).at(0)
        : undefined;

    if (rows.run.triggerSource.type === "file-upload") {
      if (uploadTriggerClaimToken === undefined) {
        return { outcome: "stale" };
      }
      const owned = await tx
        .select({ entityId: flowUploadTriggerIntents.entityId })
        .from(flowUploadTriggerIntents)
        .where(
          and(
            eq(flowUploadTriggerIntents.definitionId, definitionId),
            eq(flowUploadTriggerIntents.organizationId, organizationId),
            eq(flowUploadTriggerIntents.workspaceId, rows.run.workspaceId),
            eq(
              flowUploadTriggerIntents.entityId,
              brandPersistedEntityId(rows.run.triggerSource.entityId),
            ),
            eq(flowUploadTriggerIntents.status, "pending"),
            timestampMatchesCasToken(
              flowUploadTriggerIntents.retryAt,
              uploadTriggerClaimToken,
            ),
          ),
        )
        .limit(1)
        .for("update");
      if (owned.length === 0) {
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
    if (rows.run.triggerSource.type === "file-upload") {
      const validation = await revalidateUploadIntent({
        tx,
        definitionId,
        definition: uploadDefinition,
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
        // audit: skip — durable delivery retry bookkeeping; the source upload is audited.
        await tx
          .update(flowUploadTriggerIntents)
          .set({
            retryAt: new Date(startOfUtcDay(now).getTime() + DAY_IN_MS),
            updatedAt: now,
          })
          .where(
            and(
              eq(flowUploadTriggerIntents.organizationId, organizationId),
              eq(flowUploadTriggerIntents.workspaceId, rows.run.workspaceId),
              eq(flowUploadTriggerIntents.definitionId, definitionId),
              eq(
                flowUploadTriggerIntents.entityId,
                brandPersistedEntityId(rows.run.triggerSource.entityId),
              ),
              eq(flowUploadTriggerIntents.status, "pending"),
              timestampMatchesCasToken(
                flowUploadTriggerIntents.retryAt,
                uploadTriggerClaimToken,
              ),
            ),
          );
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
