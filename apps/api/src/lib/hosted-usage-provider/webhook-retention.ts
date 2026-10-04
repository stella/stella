import { sql } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { PROVIDER_EVENT_REPLAY_AUDIT_TEXT_PATH } from "@/api/lib/hosted-usage-provider/replay-audit";
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
  // Keep deduplication IDs and replay outcomes; remove free text from every attempt.
  const redacted = await db.execute(sql`
    update usage_provider_webhook_events
    set payload = '{}'::jsonb, error_message = null,
      replay_audit = case when replay_audit is null then null else (
        select coalesce(jsonb_agg(
          (attempt - array['previousReason', 'reason', 'dispatchReason'])
            #- '{event,metadata,reason}' #- '{event,metadata,dispatchReason}'
          order by attempt_index
        ), '[]'::jsonb)
        from jsonb_array_elements(replay_audit) with ordinality as attempts(attempt, attempt_index)
      ) end
    where ctid in (
      select ctid from usage_provider_webhook_events
      where processed_at < ${cutoff}::timestamptz and result IN ('ok', 'ignored')
        and (payload <> '{}'::jsonb or error_message is not null or replay_audit @? ${PROVIDER_EVENT_REPLAY_AUDIT_TEXT_PATH})
      order by processed_at limit ${WEBHOOK_RETENTION_BATCH_SIZE}
      for update skip locked
    ) returning event_id
  `);
  return redacted.length;
};
