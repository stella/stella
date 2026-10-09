import { panic } from "better-result";
import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type {
  documentProcessingRuns,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
  scoutRuns,
} from "@/api/db/schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  timestampCasToken,
  type TimestampCasToken,
} from "@/api/lib/db/timestamp-cas";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { logger } from "@/api/lib/observability/logger";
import type {
  DeadlineDispatchRecoverySpec,
  DeadlineCensusRecoverySpec,
} from "@/api/lib/scouts/document-deadline-recovery";

type UpdateDb = Pick<ScopedTransaction, "update">;
type TransitionDb = Pick<ScopedTransaction, "execute" | "rollback">;
type UploadClaim = {
  type: "upload-claim";
  tx: UpdateDb;
  table: typeof flowUploadTriggerIntents;
  where: SQL;
  retryAt: Date;
};
type UploadDefer = {
  type: "upload-defer";
  tx: UpdateDb;
  table: typeof flowUploadTriggerIntents;
  where: SQL;
  retryAt: Date;
};
type ScoutClaim = {
  type: "scout-claim";
  tx: UpdateDb;
  table: typeof pendingScoutEmissions;
  where: SQL;
  nextAttemptAt: Date;
};
type ScoutRetry = {
  type: "scout-retry";
  tx: UpdateDb;
  table: typeof pendingScoutEmissions;
  where: SQL;
  nextAttemptAt: Date;
  lastError: string;
};
type DeadlineClaim = {
  type: "deadline-claim";
  tx: Pick<ScopedTransaction, "execute" | "rollback" | "select">;
  spec: DeadlineDispatchRecoverySpec;
  sourceRunId: typeof documentProcessingRuns.$inferSelect.id;
  table: typeof documentProcessingRuns;
  where: SQL;
  now: Date;
};
type DeadlineSettlement = {
  type: "deadline-settlement";
  tx: TransitionDb;
  spec: DeadlineDispatchRecoverySpec;
  table: typeof documentProcessingRuns;
  where: SQL;
  now: Date;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
  skippedUntil: Date | null;
  attemptRefund: 0 | 1;
};
type DeadlineExpiry = {
  type: "deadline-expiry";
  tx: TransitionDb;
  table: typeof documentProcessingRuns;
  spec: DeadlineDispatchRecoverySpec;
  where: SQL;
  now: Date;
};
type ScoutExpiry = {
  type: "scout-expiry";
  tx: TransitionDb;
  table: typeof scoutRuns;
  spec: DeadlineCensusRecoverySpec;
  where: SQL;
  now: Date;
};
type ClaimedUpload = typeof flowUploadTriggerIntents.$inferSelect & {
  claimToken: TimestampCasToken;
};
type ClaimedScout = Pick<
  typeof pendingScoutEmissions.$inferSelect,
  "sourceId"
> & { claimToken: TimestampCasToken };
type ClaimedDeadline = typeof documentProcessingRuns.$inferSelect & {
  deadlineScoutClaimedAtToken: TimestampCasToken | null;
};
type DeadlineClaimResult =
  | { status: "claimed"; run: ClaimedDeadline }
  | { status: "stale_claim" };

export function mutateRecoveryClaim(op: UploadClaim): Promise<ClaimedUpload[]>;
export function mutateRecoveryClaim(op: ScoutClaim): Promise<ClaimedScout[]>;
export function mutateRecoveryClaim(
  op: DeadlineClaim,
): Promise<DeadlineClaimResult>;
export function mutateRecoveryClaim(
  op: DeadlineSettlement | DeadlineExpiry | ScoutExpiry,
): Promise<number>;
export function mutateRecoveryClaim(
  op: UploadDefer | ScoutRetry,
): Promise<void>;
export async function mutateRecoveryClaim(
  op:
    | UploadClaim
    | UploadDefer
    | ScoutClaim
    | ScoutRetry
    | DeadlineClaim
    | DeadlineSettlement
    | DeadlineExpiry
    | ScoutExpiry,
): Promise<
  ClaimedUpload[] | ClaimedScout[] | DeadlineClaimResult | void | number
> {
  // audit: skip — token-fenced recovery claims, lease retirement and retry bookkeeping retain their audited source outcomes.
  switch (op.type) {
    case "upload-claim":
      return await op.tx
        .update(op.table)
        .set({ retryAt: op.retryAt })
        .where(op.where)
        .returning({
          ...getTableColumns(op.table),
          claimToken: timestampCasToken(op.table.retryAt),
        });
    case "upload-defer":
      await op.tx.update(op.table).set({ retryAt: op.retryAt }).where(op.where);
      return;
    case "scout-claim":
      return await op.tx
        .update(op.table)
        .set({ nextAttemptAt: op.nextAttemptAt })
        .where(op.where)
        .returning({
          sourceId: op.table.sourceId,
          claimToken: timestampCasToken(op.table.nextAttemptAt),
        });
    case "scout-retry":
      await op.tx
        .update(op.table)
        .set({ nextAttemptAt: op.nextAttemptAt, lastError: op.lastError })
        .where(op.where);
      return;
    case "deadline-claim": {
      if (op.spec.table !== op.table) {
        return panic("Recovery claim table and lifecycle disagree");
      }
      const count = await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: {
          from: ["pending"],
          to: "running",
          set: {
            deadlineScoutAttemptCount: sql`${op.table.deadlineScoutAttemptCount} + 1`,
            deadlineScoutClaimedAt: op.now,
            deadlineScoutErrorCode: null,
            deadlineScoutSkippedUntil: null,
            updatedAt: op.now,
          },
        },
        recordTransitionAuditEvent: (_tx, changed) =>
          logger.info("scout.document_deadlines.claimed", { count: changed }),
      });
      if (count === 0) {
        return { status: "stale_claim" };
      }
      if (count !== 1) {
        return panic("A deadline claim changed more than its source row");
      }
      // The UPDATE retains its row lock in this required transaction. The
      // timestamp input is the exact value just written, not a decoded token.
      const claimed = await readBounded(
        op.tx
          .select({
            ...getTableColumns(op.table),
            deadlineScoutClaimedAtToken: timestampCasToken(
              op.table.deadlineScoutClaimedAt,
            ),
          })
          .from(op.table)
          .where(
            and(
              eq(op.table.id, op.sourceRunId),
              sql`${op.table.deadlineScoutClaimedAt} = ${op.now}::timestamptz`,
              eq(op.table.deadlineScoutStatus, "running"),
            ),
          ),
        1,
      );
      if (claimed.type === "overflow") {
        return panic("A deadline claim returned more than its source row");
      }
      if (claimed.rows.length !== 1) {
        return panic("A deadline claim lost its locked projection");
      }
      const run =
        claimed.rows.at(0) ?? panic("A deadline claim lost its locked row");
      return { status: "claimed", run };
    }
    case "deadline-settlement": {
      if (op.spec.table !== op.table) {
        return panic("Recovery claim table and lifecycle disagree");
      }
      const count = await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: {
          from: ["running"],
          to: op.status,
          set: {
            deadlineScoutAttemptCount: sql`GREATEST(${op.table.deadlineScoutAttemptCount} - ${op.attemptRefund}, 0)`,
            deadlineScoutClaimedAt: null,
            deadlineScoutErrorCode: op.errorCode,
            deadlineScoutSkippedUntil: op.skippedUntil,
            updatedAt: op.now,
          },
        },
        recordTransitionAuditEvent: (_tx, changed) =>
          logger.info("scout.document_deadlines.settled", { count: changed }),
      });
      if (count > 1) {
        return panic("A deadline settlement changed more than its source row");
      }
      return count;
    }
    case "deadline-expiry":
      if (op.spec.table !== op.table) {
        return panic("Recovery claim table and lifecycle disagree");
      }
      return await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: {
          from: ["running"],
          to: "pending",
          set: {
            deadlineScoutClaimedAt: null,
            deadlineScoutErrorCode: "worker_lease_expired",
            updatedAt: op.now,
          },
        },
        recordTransitionAuditEvent: (_tx, count) =>
          logger.info("scout.document_deadlines.dispatches_reclaimed", {
            count,
          }),
      });
    case "scout-expiry":
      if (op.spec.table !== op.table) {
        return panic("Recovery claim table and lifecycle disagree");
      }
      return await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: {
          from: ["running"],
          to: "failed",
          set: { error: "worker_lease_expired", finishedAt: op.now },
        },
        recordTransitionAuditEvent: (_tx, count) =>
          logger.info("scout.document_deadlines.census_runs_expired", {
            count,
          }),
      });
    default:
      op satisfies never;
      return panic("Unknown recovery claim operation");
  }
}
