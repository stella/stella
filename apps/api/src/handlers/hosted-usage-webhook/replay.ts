import { Result, TaggedError } from "better-result";
import { and, eq, notInArray, or, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { hostedUsageWebhookEvents, usageEntitlements } from "@/api/db/schema";
import type { UsageProviderWebhookResult } from "@/api/db/schema";
import { dispatchEvent } from "@/api/handlers/hosted-usage-webhook/dispatch";
import type { DispatchOutcome } from "@/api/lib/hosted-usage-provider/dispatch-outcome";
import { hostedUsageWebhookEventSchema } from "@/api/lib/hosted-usage-provider/event-schemas";
import type { ProviderEventReplayPerformer } from "@/api/lib/hosted-usage-provider/replay-audit";
import { recordProviderEventReplayAuditInTx } from "@/api/lib/hosted-usage-provider/webhook-store";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

const MAX_RELATED_RECEIPTS = 1000;

export type ProviderEventReplayRow = {
  id: string;
  previousResult: UsageProviderWebhookResult | null;
  mode: "dry_run" | "apply";
} & (
  | {
      kind: "related_receipts_unselected";
      reason: string;
      unselectedEventIds: string[];
      selectionStatus: "complete" | "truncated";
    }
  | {
      kind:
        | DispatchOutcome["kind"]
        | "not_found"
        | "not_ignored"
        | "already_replayed"
        | "payload_unavailable"
        | "allocation_period_elapsed"
        | "error";
      reason: string | null;
    }
);

class ProviderEventReplayError extends TaggedError("ProviderEventReplayError")<{
  message: string;
  cause?: unknown;
}> {}

const replayFailure = failureSink({
  event: "usage_provider.replay.failed",
  expected: [],
});

type ReplayContext = {
  mode: ProviderEventReplayRow["mode"];
  performer: ProviderEventReplayPerformer;
  requestedBy: string | null;
  reason: string;
  selectedEventIds: readonly string[];
};

type ReplayReceiptOptions = ReplayContext & {
  tx: Transaction;
  eventId: string;
};

/** Receipt locks serialize attempts; dispatch's entitlement locks retain
 * live delivery ordering. Related identifiers are queried through partial indexes. */
const replayReceiptInTx = async ({
  tx,
  eventId,
  mode,
  performer,
  requestedBy,
  reason,
  selectedEventIds,
}: ReplayReceiptOptions): Promise<ProviderEventReplayRow> => {
  const receipt = (
    await tx
      .select()
      .from(hostedUsageWebhookEvents)
      .where(eq(hostedUsageWebhookEvents.eventId, eventId))
      .limit(1)
      .for("update")
  ).at(0);
  const base = { id: eventId, previousResult: receipt?.result ?? null, mode };
  if (!receipt) {
    return { ...base, kind: "not_found", reason: "Receipt not found" };
  }
  if (receipt.replayAudit?.some(({ outcome }) => outcome !== "ignored")) {
    return {
      ...base,
      kind: "already_replayed",
      reason: "Receipt already replayed to a terminal outcome",
    };
  }
  if (receipt.result !== "ignored") {
    return {
      ...base,
      kind: "not_ignored",
      reason: "Only ignored receipts are eligible",
    };
  }
  const event = v.safeParse(hostedUsageWebhookEventSchema, receipt.payload);
  if (receipt.payload["signatureVerified"] !== true || !event.success) {
    return {
      ...base,
      kind: "payload_unavailable",
      reason: "Verified dispatch projection unavailable",
    };
  }
  const related = await tx
    .select({ id: hostedUsageWebhookEvents.eventId })
    .from(hostedUsageWebhookEvents)
    .where(
      and(
        eq(hostedUsageWebhookEvents.result, "ignored"),
        notInArray(hostedUsageWebhookEvents.eventId, [...selectedEventIds]),
        or(
          sql`${hostedUsageWebhookEvents.payload}->'data'->>'id' = ${event.output.data.id}`,
          sql`${hostedUsageWebhookEvents.payload}->'data'->>'account_ref' = ${event.output.data.account_ref}`,
        ),
        sql`not coalesce(${hostedUsageWebhookEvents.replayAudit} @? '$[*] ? (@.outcome != "ignored")', false)`,
      ),
    )
    .orderBy(hostedUsageWebhookEvents.eventId)
    .limit(MAX_RELATED_RECEIPTS + 1);
  if (related.length > 0) {
    return {
      ...base,
      kind: "related_receipts_unselected",
      reason:
        "Select all related unresolved receipts before replaying this event",
      unselectedEventIds: related
        .slice(0, MAX_RELATED_RECEIPTS)
        .map(({ id }) => id),
      selectionStatus:
        related.length > MAX_RELATED_RECEIPTS ? "truncated" : "complete",
    };
  }
  if (event.output.type === "allocation.created") {
    const entitlement = (
      await tx
        .select({
          start: usageEntitlements.currentPeriodStart,
          end: usageEntitlements.currentPeriodEnd,
        })
        .from(usageEntitlements)
        .where(
          eq(usageEntitlements.hostedAccountRef, event.output.data.account_ref),
        )
        .limit(1)
        .for("update")
    ).at(0);
    // Earlier projections did not store an allocation occurrence time. Their
    // receipt timestamp is the only retained date; never invent a provider date.
    const eventAt =
      event.output.data.occurred_at === undefined
        ? receipt.processedAt
        : new Date(event.output.data.occurred_at);
    if (
      entitlement &&
      (eventAt < entitlement.start || eventAt >= entitlement.end)
    ) {
      return {
        ...base,
        kind: "allocation_period_elapsed",
        reason: "Allocation event falls outside the current entitlement period",
      };
    }
  }
  const dispatched = await dispatchEvent({
    tx,
    event: event.output,
    eventId,
    mode: mode === "dry_run" ? "replay_dry_run" : "replay_apply",
  });
  const newResult = dispatched.kind === "ignored" ? "ignored" : "ok";
  const dispatchReason =
    dispatched.kind === "ignored" ? dispatched.reason : null;
  await recordProviderEventReplayAuditInTx({
    tx,
    eventId,
    performer,
    requestedBy,
    reason,
    previousReason: receipt.errorMessage,
    previousAttempts: receipt.replayAudit,
    newResult,
    outcome: dispatched.kind,
    dispatchReason,
  });
  return { ...base, kind: dispatched.kind, reason: dispatchReason };
};

type ReplayProviderEventOptions = ReplayContext & {
  eventId: string;
  runTransaction: WebhookTransactionRunner;
};

const validateReplayContext = ({
  mode,
  requestedBy,
  reason,
  selectedEventIds,
}: ReplayContext) => {
  if (
    !reason.trim() ||
    (mode === "apply" && !requestedBy?.trim()) ||
    selectedEventIds.length === 0
  ) {
    return new ProviderEventReplayError({
      message:
        "A selection and reason are required; apply also requires requestedBy",
    });
  }
  return null;
};

type ObserveReplayErrorOptions = {
  error: ProviderEventReplayError;
  mode: ReplayContext["mode"];
  eventId: string;
};
const observeReplayError = ({
  error,
  mode,
  eventId,
}: ObserveReplayErrorOptions) =>
  observeFailure(error, {
    sink: replayFailure,
    ctx: { source: "usage_provider.replay", mode, requestId: eventId },
  });

export const replayProviderEvent = async (
  options: ReplayProviderEventOptions,
) => {
  const invalid = validateReplayContext(options);
  if (
    invalid ||
    !options.eventId.trim() ||
    !options.selectedEventIds.includes(options.eventId)
  ) {
    return Result.err(
      invalid ??
        new ProviderEventReplayError({
          message: "Event id must be in the explicit selection",
        }),
    );
  }
  const operation = await Result.tryPromise({
    try: async () =>
      await options.runTransaction(async (tx) => {
        if (options.mode === "apply") {
          return Result.ok(await replayReceiptInTx({ ...options, tx }));
        }
        await tx.execute(sql`SAVEPOINT provider_event_replay_preview`);
        const evaluated = await Result.tryPromise({
          try: async () =>
            await tx.transaction(
              async (nested) =>
                await replayReceiptInTx({ ...options, tx: nested }),
            ),
          catch: (cause) =>
            new ProviderEventReplayError({
              message: "Provider event replay preview failed",
              cause,
            }),
        });
        await tx.execute(
          sql`ROLLBACK TO SAVEPOINT provider_event_replay_preview`,
        );
        await tx.execute(sql`RELEASE SAVEPOINT provider_event_replay_preview`);
        return evaluated;
      }),
    catch: (cause) =>
      new ProviderEventReplayError({
        message: "Provider event replay failed",
        cause,
      }),
  });
  const result = operation.andThen((evaluated) => evaluated);
  if (Result.isError(result)) {
    observeReplayError({
      error: result.error,
      mode: options.mode,
      eventId: options.eventId,
    });
  }
  return result;
};

type ReplayProviderEventsBatchOptions = Omit<
  ReplayContext,
  "selectedEventIds"
> & {
  eventIds: readonly string[];
  runTransaction: WebhookTransactionRunner;
  onRow?: (row: ProviderEventReplayRow) => void | Promise<void>;
};

/** Apply commits each ID in order. A preview releases each successful ID's
 * savepoint so later IDs see it, then rolls back the whole simulation. */
export const replayProviderEventsBatch = async ({
  eventIds,
  runTransaction,
  onRow,
  ...context
}: ReplayProviderEventsBatchOptions) => {
  const selectedEventIds = [...new Set(eventIds)];
  const invalid = validateReplayContext({ ...context, selectedEventIds });
  if (invalid) {
    return Result.err(invalid);
  }
  const run = async (runAttemptTransaction: WebhookTransactionRunner) => {
    const rows: ProviderEventReplayRow[] = [];
    for (const eventId of eventIds) {
      const attempt = await Result.tryPromise({
        try: async () =>
          // db-await-in-loop: ordered replay transactions/savepoints let later receipts see earlier effects and isolate each failure
          await runAttemptTransaction(
            async (tx) =>
              await replayReceiptInTx({
                ...context,
                selectedEventIds,
                eventId,
                tx,
              }),
          ),
        catch: (cause) =>
          new ProviderEventReplayError({
            message: "Provider event replay failed; check operator logs",
            cause,
          }),
      });
      if (Result.isError(attempt)) {
        observeReplayError({
          error: attempt.error,
          mode: context.mode,
          eventId,
        });
      }
      const row = Result.isError(attempt)
        ? ({
            id: eventId,
            previousResult: null,
            kind: "error",
            reason: attempt.error.message,
            mode: context.mode,
          } as const satisfies ProviderEventReplayRow)
        : attempt.value;
      rows.push(row);
      await onRow?.(row);
    }
    return rows;
  };
  return await Result.tryPromise({
    try: async () => {
      if (context.mode === "apply") {
        return await run(runTransaction);
      }
      return await runTransaction(async (tx) => {
        await tx.execute(sql`SAVEPOINT provider_event_replay_batch`);
        const rows = await run(async (fn) => await tx.transaction(fn));
        await tx.execute(
          sql`ROLLBACK TO SAVEPOINT provider_event_replay_batch`,
        );
        await tx.execute(sql`RELEASE SAVEPOINT provider_event_replay_batch`);
        return rows;
      });
    },
    catch: (cause) => {
      const error = new ProviderEventReplayError({
        message: "Provider event replay batch failed",
        cause,
      });
      observeReplayError({ error, mode: context.mode, eventId: "batch" });
      return error;
    },
  });
};
