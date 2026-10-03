import { Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { hostedUsageWebhookEvents } from "@/api/db/schema";
import type { UsageProviderWebhookResult } from "@/api/db/schema";
import { dispatchEvent } from "@/api/handlers/hosted-usage-webhook/dispatch";
import type { DispatchOutcome } from "@/api/lib/hosted-usage-provider/dispatch-outcome";
import { hostedUsageWebhookEventSchema } from "@/api/lib/hosted-usage-provider/event-schemas";
import { recordProviderEventReplayAuditInTx } from "@/api/lib/hosted-usage-provider/webhook-store";
import type { WebhookTransactionRunner } from "@/api/lib/hosted-usage-provider/webhook-store";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

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

const replayFailure = failureSink({
  event: "usage_provider.replay.failed",
  expected: [],
});

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
        if (mode === "dry_run") {
          await tx.execute(sql`SAVEPOINT provider_event_replay_dry_run`);
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
          // Roll back the evaluated dispatch and both audit writes, then
          // return its outcome through the ordinary transaction boundary.
          await tx.execute(
            sql`ROLLBACK TO SAVEPOINT provider_event_replay_dry_run`,
          );
          await tx.execute(
            sql`RELEASE SAVEPOINT provider_event_replay_dry_run`,
          );
        }
        return row;
      }),
    catch: (cause) =>
      new ProviderEventReplayError({
        message: "Provider event replay failed",
        cause,
      }),
  });
  if (result.isOk()) {
    return Result.ok(result.value);
  }
  observeFailure(result.error, {
    sink: replayFailure,
    ctx: { source: "usage_provider.replay", requestId: eventId },
  });
  return Result.err(result.error);
};
