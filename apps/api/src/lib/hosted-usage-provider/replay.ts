import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { hostedUsageWebhookEvents } from "@/api/db/schema";
import type { UsageProviderWebhookResult } from "@/api/db/schema";
import { dispatchEvent } from "@/api/handlers/hosted-usage-webhook/dispatch";
import type { DispatchOutcome } from "@/api/handlers/hosted-usage-webhook/dispatch";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { hostedUsageWebhookEventSchema } from "@/api/lib/hosted-usage-provider/event-schemas";
import type { ProviderEventReplayAudit } from "@/api/lib/hosted-usage-provider/replay-audit";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";

export type ProviderEventReplayRow = {
  id: string;
  previousResult: UsageProviderWebhookResult | null;
  kind:
    | DispatchOutcome["kind"]
    | "not_found"
    | "not_ignored"
    | "already_replayed"
    | "payload_unavailable";
  reason: string | null;
  mode: "dry_run" | "apply";
};

export class ProviderEventReplayError extends TaggedError(
  "ProviderEventReplayError",
)<{ message: string; cause?: unknown }> {}

class ReplayDryRunRollback extends TaggedError("ReplayDryRunRollback")<{
  message: string;
  row: ProviderEventReplayRow;
}> {}

type ReplayProviderEventOptions = {
  eventId: string;
  mode: ProviderEventReplayRow["mode"];
  actor: string;
  reason: string;
  runTransaction: WebhookTransactionRunner;
};

/** The selected receipt lock serializes operators; dispatch retains its own
 * entitlement locks and stale-event rules, shared with verified deliveries. */
export const replayProviderEvent = async ({
  eventId,
  mode,
  actor,
  reason,
  runTransaction,
}: ReplayProviderEventOptions) => {
  if (!eventId.trim() || !actor.trim() || !reason.trim()) {
    return Result.err(
      new ProviderEventReplayError({
        message: "Event id, actor and reason must be non-empty",
      }),
    );
  }
  const result = await Result.tryPromise({
    try: async () =>
      await runTransaction(async (tx) => {
        const receipt = (
          await tx
            .select()
            .from(hostedUsageWebhookEvents)
            .where(eq(hostedUsageWebhookEvents.eventId, eventId))
            .limit(1)
            .for("update")
        ).at(0);
        const base = {
          id: eventId,
          previousResult: receipt?.result ?? null,
          mode,
        };
        if (!receipt) {
          return {
            ...base,
            kind: "not_found",
            reason: "Receipt not found",
          } as const;
        }
        if (receipt.replayAudit !== null) {
          return {
            ...base,
            kind: "already_replayed",
            reason: "Receipt already replayed",
          } as const;
        }
        if (receipt.result !== "ignored") {
          return {
            ...base,
            kind: "not_ignored",
            reason: "Only ignored receipts are eligible",
          } as const;
        }
        // Stored known events are already normalized. Unknown projections do not
        // hold enough information to rebuild a signed event and are never guessed.
        const event = v.safeParse(
          hostedUsageWebhookEventSchema,
          receipt.payload,
        );
        if (receipt.payload["signatureVerified"] !== true || !event.success) {
          return {
            ...base,
            kind: "payload_unavailable",
            reason: "Verified dispatch projection unavailable",
          } as const;
        }
        const dispatched = await dispatchEvent({
          tx,
          event: event.output,
          eventId,
        });
        const newResult = dispatched.kind === "ignored" ? "ignored" : "ok";
        const dispatchReason =
          dispatched.kind === "ignored" ? dispatched.reason : null;
        await recordProviderEventReplayAuditInTx({
          tx,
          eventId,
          actor,
          reason,
          newResult,
          outcome: dispatched.kind,
          dispatchReason,
        });
        const row = { ...base, kind: dispatched.kind, reason: dispatchReason };
        if (mode === "dry_run") {
          // Throwing the typed boundary signal rolls back dispatch, receipt and
          // all audit writes, including when the caller supplies a savepoint.
          throw new ReplayDryRunRollback({ message: "Replay dry run", row });
        }
        return row;
      }),
    catch: (cause) =>
      cause instanceof ReplayDryRunRollback
        ? cause
        : new ProviderEventReplayError({
            message: "Provider event replay failed",
            cause,
          }),
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  if (result.error instanceof ReplayDryRunRollback) {
    return Result.ok(result.error.row);
  }
  captureError(result.error, { source: "usage_provider.replay", eventId });
  return Result.err(result.error);
};

type RecordProviderEventReplayAuditOptions = {
  tx: Transaction;
  eventId: string;
  actor: string;
  reason: string;
  newResult: UsageProviderWebhookResult;
  outcome: DispatchOutcome["kind"];
  dispatchReason: string | null;
};

/** System receipts can precede organization resolution, so their audit lives
 * on the deny-by-default receipt rather than inventing a tenant audit owner.
 * Dispatch's organization audit records remain in the same transaction. */
const recordProviderEventReplayAuditInTx = async ({
  tx,
  eventId,
  actor,
  reason,
  newResult,
  outcome,
  dispatchReason,
}: RecordProviderEventReplayAuditOptions) => {
  const replayAudit = {
    actor,
    at: Temporal.Now.instant().toString(),
    previousResult: "ignored",
    newResult,
    outcome,
    reason,
    execution: {
      performer: { type: "service", id: actor, name: null },
      trigger: {
        type: "system",
        source: "usage_provider.replay",
        sourceId: eventId,
      },
    },
    event: {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.USAGE_PROVIDER_EVENT,
      resourceId: eventId,
      changes: { result: { old: "ignored", new: newResult } },
      metadata: { reason, outcome, dispatchReason },
    },
  } as const satisfies ProviderEventReplayAudit;
  await tx
    .update(hostedUsageWebhookEvents)
    .set({ result: newResult, errorMessage: dispatchReason, replayAudit })
    .where(eq(hostedUsageWebhookEvents.eventId, eventId));
};
