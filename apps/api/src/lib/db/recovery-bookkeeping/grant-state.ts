import { panic } from "better-result";
import { sql, type SQL } from "drizzle-orm";

import type { ScopedTransaction } from "@/api/db/safe-db";
import type {
  documentProcessingRuns,
  flowUploadTriggerIntents,
  pendingScoutEmissions,
} from "@/api/db/schema";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import type { FlowUploadTriggerSkipReason } from "@/api/lib/flows/flow-types";
import type { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import { logger } from "@/api/lib/observability/logger";
import type { DeadlineDispatchRecoverySpec } from "@/api/lib/scouts/document-deadline-recovery";
import type { SCOUT_EMISSION_TRANSITIONS } from "@/api/lib/signals/scout-emission-transitions";

type GrantDb = Pick<ScopedTransaction, "execute" | "rollback">;
type UploadMove =
  | { from: readonly ["pending", ..."pending"[]]; to: "awaiting_grant" }
  | {
      from: readonly [
        "awaiting_grant" | "skipped",
        ...("awaiting_grant" | "skipped")[],
      ];
      to: "pending";
      set: { retryAt: Date; skipReason: null };
    }
  | {
      from: readonly [
        "pending" | "awaiting_grant",
        ...("pending" | "awaiting_grant")[],
      ];
      to: "skipped";
      set: { skipReason: FlowUploadTriggerSkipReason };
    };
type ScoutMove =
  | { from: readonly ["pending", ..."pending"[]]; to: "awaiting_grant" }
  | { from: readonly ["awaiting_grant", ..."awaiting_grant"[]]; to: "pending" };
type DeadlineMetadata = {
  deadlineScoutClaimedAt?: null;
  deadlineScoutErrorCode: string | null;
  updatedAt: Date;
};
type DeadlineMove =
  | {
      from: readonly ["pending" | "running", ...("pending" | "running")[]];
      to: "awaiting_grant";
      set: DeadlineMetadata;
    }
  | {
      from: readonly [
        "awaiting_grant" | "running",
        ...("awaiting_grant" | "running")[],
      ];
      to: "pending";
      set: DeadlineMetadata;
    };
type GrantOperation =
  | {
      type: "upload";
      tx: GrantDb;
      table: typeof flowUploadTriggerIntents;
      spec: typeof UPLOAD_TRIGGER_TRANSITIONS;
      where: SQL;
      options: UploadMove;
      log: {
        event:
          | "flow.upload_trigger_skipped"
          | "flow.upload_trigger_grant_resumed"
          | "flow.upload_trigger_awaiting_grant"
          | "flow.upload_trigger_grant_repaired";
        reason?: FlowUploadTriggerSkipReason;
      };
    }
  | {
      type: "scout";
      tx: GrantDb;
      table: typeof pendingScoutEmissions;
      spec: typeof SCOUT_EMISSION_TRANSITIONS;
      where: SQL;
      options: ScoutMove;
      log: {
        event:
          | "scout.emission_grant_resumed"
          | "scout.emission_awaiting_grant"
          | "scout.emission_grant_repaired";
      };
    }
  | {
      type: "deadline";
      tx: GrantDb;
      table: typeof documentProcessingRuns;
      spec: DeadlineDispatchRecoverySpec;
      where: SQL;
      options: DeadlineMove;
      attemptRefund?: 0 | 1;
      log: {
        event:
          | "scout.document_deadlines.grant_resumed"
          | "scout.document_deadlines.grant_paused"
          | "scout.document_deadlines.admission_retry"
          | "scout.document_deadlines.admission_reconciled";
        direction?: "pause" | "resume";
      };
    };

export const transitionRecoveryGrantState = async (
  op: GrantOperation,
): Promise<number> => {
  // audit: skip — recoverable feature-admission parking and replay change only durable source bookkeeping, not feature effects.
  if (op.table !== op.spec.table) {
    return panic("Recovery grant table and lifecycle disagree");
  }
  switch (op.type) {
    case "upload":
      return await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: op.options,
        recordTransitionAuditEvent: (_tx, count) =>
          logger.info(op.log.event, {
            count,
            ...(op.log.reason === undefined ? {} : { reason: op.log.reason }),
          }),
      });
    case "scout":
      return await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: op.options,
        recordTransitionAuditEvent: (_tx, count) =>
          logger.info(op.log.event, { count }),
      });
    case "deadline":
      return await transitionScopedCount({
        tx: op.tx,
        spec: op.spec,
        where: op.where,
        options: {
          ...op.options,
          set: {
            ...op.options.set,
            ...(op.attemptRefund === undefined
              ? {}
              : {
                  deadlineScoutAttemptCount: sql`GREATEST(${op.table.deadlineScoutAttemptCount} - ${op.attemptRefund}, 0)`,
                }),
          },
        },
        recordTransitionAuditEvent: (_tx, count) =>
          logger.info(op.log.event, {
            count,
            ...(op.log.direction === undefined
              ? {}
              : { direction: op.log.direction }),
          }),
      });
    default:
      op satisfies never;
      return panic("Unknown recovery grant operation");
  }
};
