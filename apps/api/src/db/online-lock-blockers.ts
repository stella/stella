import { panic } from "better-result";

import { includes, isRecord } from "../lib/type-guards";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const ONLINE_LOCK_BLOCKER_REASONS = [
  "lock_queue",
  "idle_in_transaction",
  "long_transaction",
] as const;

type OnlineLockBlockerReason = (typeof ONLINE_LOCK_BLOCKER_REASONS)[number];

export type OnlineLockBlocker = {
  pid: number;
  reason: OnlineLockBlockerReason;
  state: string | null;
  transactionAgeMs: number | null;
  stateAgeMs: number | null;
  heldModes: readonly string[];
  queryId: string | null;
};

const IDLE_IN_TRANSACTION = `a.state IN ('idle in transaction', 'idle in transaction (aborted)')
  AND clock_timestamp() - a.state_change >= $2::double precision * interval '1 millisecond'`;

const LOCK_BLOCKERS_SQL = `WITH target AS (
  SELECT to_regclass(format('public.%I', $1::text)) AS oid
  UNION SELECT i.indexrelid FROM pg_catalog.pg_index i
  WHERE i.indrelid = to_regclass(format('public.%I', $1::text))
), here AS (
  SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()
), held AS (
  SELECT l.pid, string_agg(DISTINCT l.mode, ',' ORDER BY l.mode) AS modes
  FROM pg_catalog.pg_locks l
  JOIN target t ON l.relation = t.oid
  JOIN here h ON l.database = h.oid
  WHERE l.granted
  GROUP BY l.pid
), queued AS (
  SELECT DISTINCT blocking.pid
  FROM pg_catalog.pg_locks l
  JOIN target t ON l.relation = t.oid
  JOIN here h ON l.database = h.oid
  CROSS JOIN LATERAL unnest(pg_blocking_pids(l.pid)) AS blocking(pid)
  WHERE NOT l.granted AND l.pid <> pg_backend_pid()
)
SELECT a.pid,
  CASE WHEN q.pid IS NOT NULL THEN 'lock_queue'
    WHEN ${IDLE_IN_TRANSACTION} THEN 'idle_in_transaction'
    ELSE 'long_transaction' END AS reason,
  a.state,
  (EXTRACT(EPOCH FROM clock_timestamp() - a.xact_start) * 1000)::double precision AS "transactionAgeMs",
  (EXTRACT(EPOCH FROM clock_timestamp() - a.state_change) * 1000)::double precision AS "stateAgeMs",
  COALESCE(h.modes, '') AS "heldModes",
  a.query_id::text AS "queryId"
FROM pg_catalog.pg_stat_activity a
LEFT JOIN held h ON h.pid = a.pid
LEFT JOIN queued q ON q.pid = a.pid
WHERE a.pid <> pg_backend_pid()
  AND (q.pid IS NOT NULL OR (h.pid IS NOT NULL AND (
    (${IDLE_IN_TRANSACTION})
    OR clock_timestamp() - a.xact_start >= $3::double precision * interval '1 millisecond')))
ORDER BY a.pid`;

const invalid = (field: string): never =>
  panic(`Invalid online lock blocker response: ${field}`);

const nullableNumber = (row: Record<string, unknown>, field: string) => {
  const value = row[field];
  if (value === null) {
    return null;
  }
  return typeof value === "number" ? value : invalid(field);
};

const parseBlocker = (row: unknown): OnlineLockBlocker => {
  if (!isRecord(row)) {
    return invalid("row");
  }
  const { pid, reason, state, heldModes, queryId } = row;
  if (typeof pid !== "number") {
    return invalid("pid");
  }
  if (
    typeof reason !== "string" ||
    !includes(ONLINE_LOCK_BLOCKER_REASONS, reason)
  ) {
    return invalid("reason");
  }
  if (state !== null && typeof state !== "string") {
    return invalid("state");
  }
  if (typeof heldModes !== "string") {
    return invalid("heldModes");
  }
  if (queryId !== null && typeof queryId !== "string") {
    return invalid("queryId");
  }
  return {
    pid,
    reason,
    state,
    transactionAgeMs: nullableNumber(row, "transactionAgeMs"),
    stateAgeMs: nullableNumber(row, "stateAgeMs"),
    heldModes: heldModes === "" ? [] : heldModes.split(","),
    queryId,
  };
};

type ReadOnlineLockBlockersOptions = {
  connection: Pick<OnlineMigrationConnection, "query">;
  tableName: string;
  idleInTransactionMs: number;
  longTransactionMs: number;
};

export const readOnlineLockBlockers = async ({
  connection,
  tableName,
  idleInTransactionMs,
  longTransactionMs,
}: ReadOnlineLockBlockersOptions): Promise<readonly OnlineLockBlocker[]> =>
  (
    await connection.query(LOCK_BLOCKERS_SQL, [
      tableName,
      idleInTransactionMs,
      longTransactionMs,
    ])
  ).map(parseBlocker);
