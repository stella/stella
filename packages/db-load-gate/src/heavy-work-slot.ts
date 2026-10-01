import { panic } from "better-result";

export type HeavyWorkKind = "index_repair" | "index_build" | "backfill_batch";

export type HeavyWorkSession = {
  /** A dedicated physical session, retained until close; never a pool query. */
  query: (
    statement: string,
    parameters: readonly number[],
  ) => Promise<readonly { acquired: boolean }[]>;
};

// Two-key advisory locks are database-local and separate from bigint locks.
const LOCK_NAMESPACE = 1_937_007_724;
const WORK_LOCK = 0;
const PRIORITIES = {
  index_repair: 1,
  index_build: 2,
  backfill_batch: 3,
} as const;
const READ_HIGHER_PRIORITY_SQL = `SELECT NOT EXISTS (
  SELECT 1 FROM pg_locks
  WHERE locktype = 'advisory' AND granted AND mode = 'ShareLock'
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid = $1::oid AND objid > 0 AND objid < $2::oid AND objsubid = 2
) AS acquired`;

/** The work and its slot end together on commit, rollback or backend death. */
export const tryAcquireBackfillTransactionSlot = async (
  session: HeavyWorkSession,
) => {
  const waiting = (
    await session.query(READ_HIGHER_PRIORITY_SQL, [
      LOCK_NAMESPACE,
      PRIORITIES.backfill_batch,
    ])
  ).at(0);
  if (waiting === undefined) {
    panic("Advisory priority query returned no result");
  }
  if (!waiting.acquired) {
    return false;
  }
  const work = (
    await session.query(
      "SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired",
      [LOCK_NAMESPACE, WORK_LOCK],
    )
  ).at(0);
  if (work === undefined) {
    panic("Advisory lock query returned no result");
  }
  if (!work.acquired) {
    return false;
  }
  const priority = (
    await session.query(READ_HIGHER_PRIORITY_SQL, [
      LOCK_NAMESPACE,
      PRIORITIES.backfill_batch,
    ])
  ).at(0);
  if (priority === undefined) {
    panic("Advisory priority query returned no result");
  }
  // A rejected batch commits only its hold checkpoint, releasing the xact lock.
  return priority.acquired;
};

type HeavyWorkSlotOptions = { session: HeavyWorkSession; kind: HeavyWorkKind };

/**
 * Shared intent locks survive unsuccessful attempts, but disappear on session
 * death. Under the exclusive work lock, a snapshot of higher-priority intents
 * establish the batch boundary at which lower-priority work must yield.
 * Calls on one handle must be sequential. No operation waits for a lock.
 */
export const createHeavyWorkSlot = ({
  session,
  kind,
}: HeavyWorkSlotOptions) => {
  const priority = PRIORITIES[kind];
  let registered = false;
  let held = false;
  let closed = false;
  const query = async (statement: string, key: number) => {
    const row = (await session.query(statement, [LOCK_NAMESPACE, key])).at(0);
    if (row === undefined) {
      panic("Advisory lock query returned no result");
    }
    return row.acquired;
  };
  const release = async () => {
    if (!held) {
      return;
    }
    if (
      !(await query(
        "SELECT pg_advisory_unlock($1::int, $2::int) AS acquired",
        WORK_LOCK,
      ))
    ) {
      panic("Heavy-work slot ownership was lost");
    }
    held = false;
  };
  const tryAcquire = async () => {
    if (closed) {
      panic("Cannot acquire a closed heavy-work slot");
    }
    if (held) {
      return true;
    }
    if (!registered) {
      registered = await query(
        "SELECT pg_try_advisory_lock_shared($1::int, $2::int) AS acquired",
        priority,
      );
      if (!registered) {
        return false;
      }
    }
    // Registered higher priorities must not compete with transient low-priority
    // attempts for the work lock, even while a rejected batch records its hold.
    if (!(await query(READ_HIGHER_PRIORITY_SQL, priority))) {
      return false;
    }
    held = await query(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
      WORK_LOCK,
    );
    if (!held) {
      return false;
    }
    try {
      // Inspect shared intents without briefly taking an exclusive intent lock:
      // that probe would prevent a higher-priority waiter from registering.
      if (!(await query(READ_HIGHER_PRIORITY_SQL, priority))) {
        await release();
        return false;
      }
      return true;
    } catch (error) {
      // This resource boundary propagates the original error after cleanup.
      await release();
      throw error;
    }
  };
  const close = async () => {
    if (closed) {
      return;
    }
    await release();
    if (registered) {
      if (
        !(await query(
          "SELECT pg_advisory_unlock_shared($1::int, $2::int) AS acquired",
          priority,
        ))
      ) {
        panic("Heavy-work intent ownership was lost");
      }
      registered = false;
    }
    closed = true;
  };
  return { tryAcquire, release, close };
};
