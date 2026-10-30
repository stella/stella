import { panic } from "better-result";
import { and, eq, getColumns, type SQL, sql } from "drizzle-orm";

import { withOrgScope } from "@/api/db/org-scope";
import type { OrgScope } from "@/api/db/org-scope";
import type { ScopedTransaction } from "@/api/db/safe-db";
import {
  documentProcessingRuns,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
  scoutRuns,
} from "@/api/db/schema";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  type TimestampCasToken,
  timestampCasToken,
} from "@/api/lib/db/timestamp-cas";
import {
  defineScopedTransitions,
  transitionScopedCount,
} from "@/api/lib/db/transitions";
import { logger } from "@/api/lib/observability/logger";
// Recovery owns lease retirement and recoverable admission parking.
export const DEADLINE_DISPATCH_RECOVERY = defineScopedTransitions({
  table: documentProcessingRuns,
  key: "id",
  scope: [],
  stateColumn: "deadlineScoutStatus",
  edges: {
    not_requested: [],
    pending: ["awaiting_grant", "running"],
    awaiting_grant: ["pending"],
    running: ["pending", "awaiting_grant", "succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    cancelled: [],
  },
  initial: [],
});

const DEADLINE_CENSUS_RECOVERY = defineScopedTransitions({
  table: scoutRuns,
  key: "id",
  scope: [],
  stateColumn: "status",
  edges: {
    running: ["failed"],
    succeeded: [],
    failed: [],
  },
  initial: [],
});

type UploadClaim = {
  type: "upload-claim";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  retryAt: Date;
};
type UploadDefer = {
  type: "upload-defer";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  retryAt: Date;
};
type ScoutClaim = {
  type: "scout-claim";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  nextAttemptAt: Date;
};
type ScoutRetry = {
  type: "scout-retry";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  nextAttemptAt: Date;
  lastError: string;
};
type DeadlineClaim = {
  type: "deadline-claim";
  tx: ScopedTransaction;
  scope: OrgScope;
  sourceRunId: typeof documentProcessingRuns.$inferSelect.id;
  where: SQL;
  now: Date;
};
type DeadlineSettlement = {
  type: "deadline-settlement";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  now: Date;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
  skippedUntil: Date | null;
  attemptRefund: 0 | 1;
};
type DeadlineExpiry = {
  type: "deadline-expiry";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  now: Date;
};
type ScoutExpiry = {
  type: "scout-expiry";
  tx: ScopedTransaction;
  scope: OrgScope;
  where: SQL;
  now: Date;
};
type ClaimedUpload = typeof flowUploadTriggerIntents.$inferSelect & {
  claimToken: TimestampCasToken;
};
type ClaimedScout = Pick<
  typeof pendingScoutEmissions.$inferSelect,
  "sourceId"
> & {
  claimToken: TimestampCasToken;
};
type ClaimedDeadline = typeof documentProcessingRuns.$inferSelect & {
  deadlineScoutClaimedAtToken: TimestampCasToken | null;
};
type DeadlineClaimResult =
  { status: "claimed"; run: ClaimedDeadline } | { status: "stale_claim" };

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
  return await withOrgScope({
    tx: op.tx,
    scope: op.scope,
    actor: { type: "system" },
    fn: async (tx) => {
      // audit: skip — token-fenced recovery claims, lease retirement and retry bookkeeping retain their audited source outcomes. Pure recovery bookkeeping; no user/customer data or auth/permission change.
      switch (op.type) {
        case "upload-claim":
          return await tx
            .update(flowUploadTriggerIntents)
            .set({ retryAt: op.retryAt })
            .where(op.where)
            .returning({
              ...getColumns(flowUploadTriggerIntents),
              claimToken: timestampCasToken(flowUploadTriggerIntents.retryAt),
            });
        case "upload-defer":
          await tx
            .update(flowUploadTriggerIntents)
            .set({ retryAt: op.retryAt })
            .where(op.where);
          return;
        case "scout-claim":
          return await tx
            .update(pendingScoutEmissions)
            .set({ nextAttemptAt: op.nextAttemptAt })
            .where(op.where)
            .returning({
              sourceId: pendingScoutEmissions.sourceId,
              claimToken: timestampCasToken(
                pendingScoutEmissions.nextAttemptAt,
              ),
            });
        case "scout-retry":
          await tx
            .update(pendingScoutEmissions)
            .set({ nextAttemptAt: op.nextAttemptAt, lastError: op.lastError })
            .where(op.where);
          return;
        case "deadline-claim": {
          const count = await transitionScopedCount({
            tx,
            spec: DEADLINE_DISPATCH_RECOVERY,
            where: op.where,
            options: {
              from: ["pending"],
              to: "running",
              set: {
                deadlineScoutAttemptCount: sql`${documentProcessingRuns.deadlineScoutAttemptCount} + 1`,
                deadlineScoutClaimedAt: op.now,
                deadlineScoutErrorCode: null,
                deadlineScoutSkippedUntil: null,
                updatedAt: op.now,
              },
            },
            recordTransitionAuditEvent: (_tx, changed) =>
              logger.info("scout.document_deadlines.claimed", {
                count: changed,
              }),
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
            tx
              .select({
                ...getColumns(documentProcessingRuns),
                deadlineScoutClaimedAtToken: timestampCasToken(
                  documentProcessingRuns.deadlineScoutClaimedAt,
                ),
              })
              .from(documentProcessingRuns)
              .where(
                and(
                  eq(documentProcessingRuns.id, op.sourceRunId),
                  sql`${documentProcessingRuns.deadlineScoutClaimedAt} = ${op.now}::timestamptz`,
                  eq(documentProcessingRuns.deadlineScoutStatus, "running"),
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
          const count = await transitionScopedCount({
            tx,
            spec: DEADLINE_DISPATCH_RECOVERY,
            where: op.where,
            options: {
              from: ["running"],
              to: op.status,
              set: {
                deadlineScoutAttemptCount: sql`GREATEST(${documentProcessingRuns.deadlineScoutAttemptCount} - ${op.attemptRefund}, 0)`,
                deadlineScoutClaimedAt: null,
                deadlineScoutErrorCode: op.errorCode,
                deadlineScoutSkippedUntil: op.skippedUntil,
                updatedAt: op.now,
              },
            },
            recordTransitionAuditEvent: (_tx, changed) =>
              logger.info("scout.document_deadlines.settled", {
                count: changed,
              }),
          });
          if (count > 1) {
            return panic(
              "A deadline settlement changed more than its source row",
            );
          }
          return count;
        }
        case "deadline-expiry":
          return await transitionScopedCount({
            tx,
            spec: DEADLINE_DISPATCH_RECOVERY,
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
          return await transitionScopedCount({
            tx,
            spec: DEADLINE_CENSUS_RECOVERY,
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
    },
  });
}
