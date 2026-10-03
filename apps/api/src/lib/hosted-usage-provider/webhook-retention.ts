import { sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import type { SchedulerDb } from "@/api/lib/scheduler/types";

export const WEBHOOK_RETENTION_BATCH_SIZE = 128;

type RedactWebhookEventsOptions = {
  db: Pick<SchedulerDb, "execute">;
  retentionDays: number;
  now: Date;
};

export const redactCompletedWebhookEvents = async ({
  db,
  retentionDays,
  now,
}: RedactWebhookEventsOptions) => {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_IN_MS);
  // Keep IDs as deduplication tombstones and retain unresolved receipts.
  const redacted = await db.execute(sql`
    update usage_provider_webhook_events set payload = '{}'::jsonb, error_message = null
    where ctid in (
      select ctid from usage_provider_webhook_events
      where processed_at < ${cutoff}::timestamptz and result = 'ok'
        and (payload <> '{}'::jsonb or error_message is not null)
      order by processed_at limit ${WEBHOOK_RETENTION_BATCH_SIZE}
      for update skip locked
    ) returning event_id
  `);
  return redacted.length;
};
