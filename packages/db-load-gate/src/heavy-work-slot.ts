import { panic, Result, TaggedError } from "better-result";

export class HeavyWorkSlotError extends TaggedError("HeavyWorkSlotError")<{
  message: string;
  cause: unknown;
}> {}

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
const INTENT_KEYS = {
  index_repair: 1,
  index_build: 2,
  backfill_batch: 3,
  operator_job: 4,
} as const;
export type HeavyWorkKind = keyof typeof INTENT_KEYS;
const PRIORITIES = {
  index_repair: 1,
  index_build: 2,
  operator_job: 3,
  backfill_batch: 4,
} as const satisfies Record<HeavyWorkKind, number>;

const higherPriorityQuery = (kind: HeavyWorkKind) => {
  const keys = Object.entries(INTENT_KEYS).flatMap(([candidate, key]) => {
    const rank = Object.entries(PRIORITIES)
      .find(([name]) => name === candidate)
      ?.at(1);
    if (typeof rank !== "number") {
      panic("Heavy-work intent has no priority");
    }
    return rank < PRIORITIES[kind] ? [key] : [];
  });
  return {
    statement: `SELECT NOT EXISTS (
      SELECT 1 FROM pg_locks AS intent
      WHERE intent.locktype = 'advisory' AND intent.granted AND intent.mode = 'ShareLock'
        AND intent.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND intent.classid = $1::oid AND intent.objsubid = 2
        AND intent.pid <> pg_backend_pid()
        AND ${keys.length === 0 ? "FALSE" : `intent.objid IN (${keys.map((_, offset) => `$${offset + 2}::oid`).join(", ")})`}
        AND NOT (intent.objid = ${INTENT_KEYS.index_build} AND EXISTS (
          SELECT 1 FROM pg_locks AS operator_intent
          WHERE operator_intent.locktype = 'advisory' AND operator_intent.granted
            AND operator_intent.mode = 'ShareLock' AND operator_intent.database = intent.database
            AND operator_intent.classid = intent.classid AND operator_intent.objsubid = 2
            AND operator_intent.pid = intent.pid AND operator_intent.objid = ${INTENT_KEYS.operator_job}
        ))
    ) AS acquired`,
    parameters: [LOCK_NAMESPACE, ...keys],
  };
};

/** The work and its slot end together on commit, rollback or backend death. */
export const tryAcquireBackfillTransactionSlot = async (
  session: HeavyWorkSession,
) => {
  const higher = higherPriorityQuery("backfill_batch");
  const waiting = (await session.query(higher.statement, higher.parameters)).at(
    0,
  );
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
    await session.query(higher.statement, higher.parameters)
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
  const higher = higherPriorityQuery(kind);
  // Until all pre-operator processes have drained, key 2 makes operators visible
  // to their objid < 3 probes. Register key 4 first so peers identify the alias.
  const intentKeys =
    kind === "operator_job"
      ? [INTENT_KEYS.operator_job, INTENT_KEYS.index_build]
      : [INTENT_KEYS[kind]];
  const registeredKeys: number[] = [];
  let held = false;
  let closed = false;
  const query = async (statement: string, parameters: readonly number[]) => {
    const row = (await session.query(statement, parameters)).at(0);
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
      !(await query("SELECT pg_advisory_unlock($1::int, $2::int) AS acquired", [
        LOCK_NAMESPACE,
        WORK_LOCK,
      ]))
    ) {
      panic("Heavy-work slot ownership was lost");
    }
    held = false;
  };
  const acquire = async () => {
    if (closed) {
      panic("Cannot acquire a closed heavy-work slot");
    }
    if (held) {
      return true;
    }
    for (const key of intentKeys) {
      if (registeredKeys.includes(key)) {
        continue;
      }
      if (
        !(await query(
          "SELECT pg_try_advisory_lock_shared($1::int, $2::int) AS acquired",
          [LOCK_NAMESPACE, key],
        ))
      ) {
        return false;
      }
      registeredKeys.push(key);
    }
    // Registered higher priorities must not compete with transient low-priority
    // attempts for the work lock, even while a rejected batch records its hold.
    if (!(await query(higher.statement, higher.parameters))) {
      return false;
    }
    held = await query(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
      [LOCK_NAMESPACE, WORK_LOCK],
    );
    if (!held) {
      return false;
    }
    // Recheck under the work lock so newly registered higher priorities win.
    if (!(await query(higher.statement, higher.parameters))) {
      await release();
      return false;
    }
    return true;
  };
  const tryAcquire = async () => {
    const acquisition = await Result.tryPromise({
      try: acquire,
      catch: (cause) =>
        new HeavyWorkSlotError({
          message: "Heavy-work slot acquisition failed",
          cause,
        }),
    });
    if (acquisition.isErr()) {
      await release();
    }
    return acquisition;
  };
  const close = async () => {
    if (closed) {
      return;
    }
    await release();
    // Remove aliases before their identifying key, including after partial registration.
    while (registeredKeys.length > 0) {
      const key = registeredKeys.at(-1);
      if (key === undefined) {
        panic("Heavy-work intent registration was lost");
      }
      if (
        !(await query(
          "SELECT pg_advisory_unlock_shared($1::int, $2::int) AS acquired",
          [LOCK_NAMESPACE, key],
        ))
      ) {
        panic("Heavy-work intent ownership was lost");
      }
      registeredKeys.pop();
    }
    closed = true;
  };
  return { tryAcquire, release, close };
};
