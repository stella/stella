import { env } from "@/api/env";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  redactCompletedWebhookEvents,
  WEBHOOK_RETENTION_BATCH_SIZE,
} from "@/api/lib/hosted-usage-provider/webhook-retention";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export const REDACT_HOSTED_USAGE_WEBHOOK_EVENTS_TASK =
  "usage.redactWebhookEvents" as const;
const MAX_RETENTION_BATCHES_PER_RUN = 16;

type DrainWebhookEventsOptions = {
  signal: AbortSignal;
  retentionDays: number | undefined;
  redact: (retentionDays: number) => Promise<number>;
};

export const drainWebhookEvents = async ({
  signal,
  retentionDays,
  redact,
}: DrainWebhookEventsOptions): Promise<boolean> => {
  if (retentionDays === undefined) {
    return false;
  }
  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_RUN; batch += 1) {
    if (signal.aborted) {
      return false;
    }
    if ((await redact(retentionDays)) < WEBHOOK_RETENTION_BATCH_SIZE) {
      return false;
    }
  }
  return !signal.aborted;
};

export const redactHostedUsageWebhookEvents: SchedulerTask = async ({
  db,
  runId,
  signal,
  scheduleContinuation,
  dueAt,
}) => {
  const now = dueAt.claimedAtDate();
  const shouldContinue = await withAggregateTransaction(db, async (tx) => {
    let redactedEvents = 0;
    const hasMore = await drainWebhookEvents({
      signal,
      retentionDays: env.HOSTED_USAGE_WEBHOOK_RETENTION_DAYS,
      redact: async (retentionDays) => {
        const redacted = await redactCompletedWebhookEvents({
          db: tx,
          retentionDays,
          now,
        });
        redactedEvents += redacted;
        return redacted;
      },
    });
    await recordSystemAudit(tx, "system:usage-webhook-retention", {
      subject: runId,
      counts: { redactedEvents },
    });
    return hasMore;
  });
  if (shouldContinue && !signal.aborted) {
    scheduleContinuation(now);
  }
};
