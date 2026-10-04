import { env } from "@/api/env";
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
  scheduleContinuation: (nextRunAt: Date) => void;
};

export const drainWebhookEvents = async ({
  signal,
  retentionDays,
  redact,
  scheduleContinuation,
}: DrainWebhookEventsOptions) => {
  if (retentionDays === undefined) {
    return;
  }
  for (let batch = 0; batch < MAX_RETENTION_BATCHES_PER_RUN; batch += 1) {
    if (signal.aborted) {
      return;
    }
    if ((await redact(retentionDays)) < WEBHOOK_RETENTION_BATCH_SIZE) {
      return;
    }
  }
  if (!signal.aborted) {
    scheduleContinuation(new Date());
  }
};

export const redactHostedUsageWebhookEvents: SchedulerTask = async ({
  db,
  runId,
  signal,
  scheduleContinuation,
}) => {
  let redactedEvents = 0;
  await drainWebhookEvents({
    signal,
    retentionDays: env.HOSTED_USAGE_WEBHOOK_RETENTION_DAYS,
    scheduleContinuation,
    redact: async (retentionDays) => {
      const redacted = await redactCompletedWebhookEvents({
        db,
        retentionDays,
        now: new Date(),
      });
      redactedEvents += redacted;
      return redacted;
    },
  });
  await recordSystemAudit(db, "system:usage-webhook-retention", {
    subject: runId,
    counts: { redactedEvents },
  });
};
