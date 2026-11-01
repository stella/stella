import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";

import type { OrgScopedTransaction } from "@/api/db/org-scope";
import { documentProcessingRuns } from "@/api/db/schema";
import { DEADLINE_DISPATCH_RECOVERY } from "@/api/lib/db/recovery-bookkeeping/claims";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import type { FlowUploadTriggerSkipReason } from "@/api/lib/flows/flow-types";
import { UPLOAD_TRIGGER_TRANSITIONS } from "@/api/lib/flows/upload-trigger-transitions";
import { logger } from "@/api/lib/observability/logger";
import { SCOUT_EMISSION_TRANSITIONS } from "@/api/lib/signals/scout-emission-transitions";

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
      tx: OrgScopedTransaction;
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
      tx: OrgScopedTransaction;
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
      tx: OrgScopedTransaction;
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
  const tx = op.tx.tx;
  // audit: skip — recoverable feature-admission parking and replay change only durable source bookkeeping, not feature effects. Pure recovery bookkeeping; no user/customer data or auth/permission change.
  switch (op.type) {
    case "upload":
      return await transitionScopedCount({
        tx,
        spec: UPLOAD_TRIGGER_TRANSITIONS,
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
        tx,
        spec: SCOUT_EMISSION_TRANSITIONS,
        where: op.where,
        options: op.options,
        recordTransitionAuditEvent: (_tx, count) =>
          logger.info(op.log.event, { count }),
      });
    case "deadline":
      return await transitionScopedCount({
        tx,
        spec: DEADLINE_DISPATCH_RECOVERY,
        where: op.where,
        options: {
          ...op.options,
          set: {
            ...op.options.set,
            ...(op.options.to === "pending"
              ? {
                  // Regrant removes admission parking while the budget deadline remains binding.
                  deadlineScoutErrorCode: sql`CASE
                    WHEN ${documentProcessingRuns.deadlineScoutSkippedUntil} IS NOT NULL
                    THEN ${ACTION_ADMISSION_CODES.periodExhausted}
                    ELSE ${op.options.set.deadlineScoutErrorCode}
                  END`,
                }
              : {}),
            ...(op.attemptRefund === undefined
              ? {}
              : {
                  deadlineScoutAttemptCount: sql`GREATEST(${documentProcessingRuns.deadlineScoutAttemptCount} - ${op.attemptRefund}, 0)`,
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
