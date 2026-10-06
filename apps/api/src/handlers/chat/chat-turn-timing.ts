import { Column, getColumnTable, getTableName, is, sql } from "drizzle-orm";
import type { AnyColumn, SQL, Table } from "drizzle-orm";

import {
  CHAT_TURN_STATUSES,
  CHAT_TURN_TIMING_DISPOSITION,
} from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnStatus } from "@/api/handlers/chat/chat-turn-state";
import type { ChatTurnTiming } from "@/api/handlers/chat/types";

const timingStatuses = (
  disposition: (typeof CHAT_TURN_TIMING_DISPOSITION)[ChatTurnStatus],
) =>
  sql.join(
    CHAT_TURN_STATUSES.filter(
      (status) => CHAT_TURN_TIMING_DISPOSITION[status] === disposition,
    ).map((status) => sql`${status}`),
    sql`, `,
  );
const hiddenStatuses = timingStatuses("hidden");
const runningStatuses = timingStatuses("running");
const finishedStatuses = timingStatuses("finished");

type MessageTurnTimingOptions = {
  messageId: AnyColumn | SQL;
  threadId: AnyColumn | SQL;
  /** A first execution has no persisted assistant message until settlement. */
  fallbackTurnId?: AnyColumn | SQL;
};

/** One database projection owns both streaming reads and transcript hydration. */
export const messageTurnTiming = ({
  messageId,
  threadId,
  fallbackTurnId,
}: MessageTurnTimingOptions) => {
  // Drizzle strips Column qualification in a single-table selection. Explicit
  // identifiers keep the inner aggregate correlated to the outer row.
  const outerReference = (value: AnyColumn | SQL) =>
    is(value, Column)
      ? sql`${sql.identifier(getTableName(getColumnTable<Table>(value)))}.${sql.identifier(value.name)}`
      : value;
  const message = outerReference(messageId);
  const thread = outerReference(threadId);
  const fallback =
    fallbackTurnId === undefined ? undefined : outerReference(fallbackTurnId);
  return sql<ChatTurnTiming | null>`(
    select case
      when count(*) = 0 or count(active_duration_ms) <> count(*)
        or min(active_duration_ms) < 0
        or sum(active_duration_ms) > ${Number.MAX_SAFE_INTEGER}
        or bool_or(status IN (${hiddenStatuses}))
        or bool_or(status IN (${runningStatuses}) and (active_started_at is null or active_started_at > now()))
        or bool_or(status IN (${finishedStatuses}) and active_started_at is not null)
        then null
      when bool_or(status IN (${runningStatuses})) then
        case when count(*) filter (where status IN (${runningStatuses})) = 1 then
          jsonb_build_object('status', 'running', 'durationMs', sum(active_duration_ms),
            'startedAt', to_char(max(active_started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        else null end
      else jsonb_build_object('status', 'finished', 'durationMs', sum(active_duration_ms))
    end
    from chat_turns t
    where t.thread_id = ${thread}
      and (t.timing_message_id = ${message}${fallback === undefined ? sql`` : sql` or (${message} IS NULL and t.id = ${fallback})`})
  )`;
};
