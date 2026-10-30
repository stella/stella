// The contending writer of scripts/rehearse-migration-upgrade.sh, as a
// module: `migration-rehearsal-db.ts contend` runs it against the corpus
// tables, and the Postgres-gated suite runs it against a lane held on
// purpose.

import type { SQL } from "bun";

import {
  CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
  isCorpusSchemaLaneGranted,
  runUnderCorpusSchemaLane,
} from "../apps/api/src/db/corpus-schema-lane";

/**
 * How long each contending transaction holds its row locks: longer than a
 * short DDL lock wait, the way the corpus workers' batches are.
 */
export const CONTENTION_HOLD_MS = 5000;
/**
 * Two holders half a hold out of phase: whenever one is about to commit the
 * other has half a hold left, so a wait shorter than that never finds both
 * gone at once.
 */
export const CONTENDERS = 2;
/** Printed once every contending session holds its locks. */
export const CONTENTION_HELD_LINE = "contending: locks held";

/** What a session reports: a committed transaction, or a refused lane try. */
export const WRITER_EVENT_KINDS = ["commit", "refused"] as const;
export type WriterEventKind = (typeof WRITER_EVENT_KINDS)[number];

type RawTransaction = { execute: (query: string) => Promise<unknown> };
type ContendedUpdate =
  | string
  | { readonly parameters: readonly string[]; readonly statement: string };

/**
 * One session's `BEGIN`/`COMMIT` pair as the lane helper's database. A lane
 * try the server refuses is reported through `onRefused`.
 */
const rawTransactions = (connection: SQL, onRefused: () => void) => ({
  transaction: async <TResult>(
    fn: (tx: RawTransaction) => Promise<TResult>,
  ): Promise<TResult> => {
    await connection.unsafe("BEGIN");
    try {
      const result = await fn({
        execute: async (query) => {
          const rows: unknown = await connection.unsafe(query);
          if (
            query === CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL &&
            !isCorpusSchemaLaneGranted(rows)
          ) {
            onRefused();
          }
          return rows;
        },
      });
      await connection.unsafe("COMMIT");
      return result;
    } catch (error: unknown) {
      await connection.unsafe("ROLLBACK");
      throw error;
    }
  },
});

export type ContendSessionOptions = {
  /** A client of its own with one connection: one session. */
  connection: SQL;
  /** Statements run in each transaction, while it holds the lane shared. */
  updates: readonly ContendedUpdate[];
  holdMs: number;
  /** Fires once, after the first transaction's updates hold their locks. */
  onHeld: (() => void) | null;
  /** Every committed transaction and every refused lane try, as it happens. */
  onEvent: (kind: WriterEventKind, at: number) => void;
  /** Ends the session after the transaction in flight commits. */
  signal: AbortSignal;
};

/**
 * One held transaction after another on one session, until `signal` aborts.
 * Each transaction holds the corpus schema lane shared, tried and backed off
 * exactly as createIngestionDb does. Recursive rather than a loop with an
 * awaited body: each transaction must commit before the next begins, so the
 * sequencing is structural.
 */
export const contendSession = async ({
  connection,
  updates,
  holdMs,
  onHeld,
  onEvent,
  signal,
}: ContendSessionOptions): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  await runUnderCorpusSchemaLane({
    database: rawTransactions(connection, () => {
      onEvent("refused", Date.now());
    }),
    work: async () => {
      for (const update of updates) {
        if (typeof update === "string") {
          await connection.unsafe(update);
          continue;
        }
        await connection.unsafe(update.statement, [...update.parameters]);
      }
      onHeld?.();
      await Bun.sleep(holdMs);
    },
  });
  onEvent("commit", Date.now());
  await contendSession({
    connection,
    updates,
    holdMs,
    onHeld: null,
    onEvent,
    signal,
  });
};
