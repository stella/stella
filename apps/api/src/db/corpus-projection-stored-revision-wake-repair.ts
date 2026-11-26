/**
 * Code-owned online repair: in a generation whose hits carry their revision,
 * no projection state waits for an older revision's delete to settle.
 *
 * Such a generation appends a new revision beside an older one whose exact
 * delete is in flight (`CORPUS_INDEX_INTENT_APPEND_GATE`), and a state that
 * stops naming its copy is runnable at once
 * (`corpusProjectionRetiredRevisionRunnableAt`). An earlier release queued
 * those states at the retired revision's settlement bound instead, an
 * `updated_at` in the future, which keeps them out of the append walk until
 * then. This repair moves each one the walk would now take to the present:
 * an active stored-revision generation's state that needs work, has no
 * failure backoff (`retry_not_before`), is queued for a later instant than
 * the database's, and has no other revision left that holds its append back.
 * Nothing else is touched: a backoff, a query-only generation and a state an
 * append in flight or a stall still holds keep their instant.
 *
 * Batches are bounded, take only rows no writer holds, and are paced by the
 * backfill runtime. A woken row leaves the predicate, so it is idempotent,
 * and an interrupted or partial run is finished by running it again. The
 * postcondition is read live, so it stays complete once this release writes
 * no such state.
 */

import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";

import { loadGateHealthConfig } from "../env-online-index";
import { wakeCorpusProjectionStatesQuery } from "../lib/db/aggregate-lock";
import {
  compiledStoredRevisionCorpusIndexGenerations,
  type CorpusRevisionRetrieval,
} from "../lib/legal-search/corpus-index-manifest";
import {
  corpusIndexProjectionIntentHoldsAppend,
  corpusIndexProjectionNeedsWork,
} from "../lib/legal-search/corpus-index-projection-sql";
import { createBackfillRuntime } from "./backfill-runtime";
import type {
  CodeOwnedOnlineStep,
  OnlineMigrationConnection,
  OnlineRepair,
  OnlineRepairCompletion,
} from "./online-migration-connection";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "./schema";

const REPAIR_NAME = "corpus-projection-stored-revision-wake";
const STATES_TABLE = "corpus_index_projection_states";
/** States per batch: a few hundred row locks and one probe each. */
const BATCH_STATES = 500;

const STORED: CorpusRevisionRetrieval = {
  type: "stored",
  field: "projection_revision",
};

const states = corpusIndexProjectionStates;
const dialect = new PgDialect();

/**
 * The states owed a wake. The stored-revision generations travel as one JSON
 * parameter, so the statement's text does not vary with how many there are,
 * and only those the registry holds as building or serving count, as the
 * append walk reads no other. The queue instant is spelled as the pending
 * index keys it and compared with the transaction's `now()`, so the index
 * answers the range.
 */
const deferredStoredState = () => sql`
  (${states.family}, ${states.generation}) IN (
    SELECT stored.family, stored.generation
    FROM jsonb_to_recordset(${JSON.stringify(
      compiledStoredRevisionCorpusIndexGenerations(),
    )}::text::jsonb) AS stored (family text, generation text)
    JOIN ${corpusIndexGenerations} registered
      ON registered.family = stored.family
      AND registered.generation = stored.generation
    WHERE registered.status IN ('building', 'serving')
  )
  AND ${corpusIndexProjectionNeedsWork(states)}
  AND ${states.retryNotBefore} IS NULL
  AND coalesce(${states.retryNotBefore}, ${states.updatedAt}) > now()
  AND NOT EXISTS (
    SELECT 1
    FROM ${corpusIndexProjectionIntents} other
    WHERE other.family = ${states.family}
      AND other.generation = ${states.generation}
      AND other.entity_id = ${states.entityId}
      AND ${corpusIndexProjectionIntentHoldsAppend(sql.raw("other.status"), STORED)}
  )`;

const rendered = (statement: SQL) => {
  const { sql: text, params } = dialect.sqlToQuery(statement);
  return { text, params };
};

const readAnyDeferred = () =>
  rendered(sql`
    SELECT 1
    FROM ${states}
    WHERE ${deferredStoredState()}
    LIMIT 1`);

const readCompletion = async (
  connection: Pick<OnlineMigrationConnection, "query">,
): Promise<OnlineRepairCompletion> => {
  const { text, params } = readAnyDeferred();
  return (await connection.query(text, params)).length === 0
    ? { type: "complete" }
    : {
        type: "incomplete",
        reason:
          "A stored-revision projection state still waits for an older revision's delete to settle",
      };
};

export type CorpusProjectionStoredRevisionWakeRuntime = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
  /** States per batch; tests lower it to wake in several batches. */
  batchStates?: number;
};

const wakeDeferredStates = async (
  connection: OnlineMigrationConnection,
  {
    readVerdict,
    sleep = Bun.sleep,
    clock,
    log,
    batchStates = BATCH_STATES,
  }: CorpusProjectionStoredRevisionWakeRuntime,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: STATES_TABLE,
    initialSize: batchStates,
    config: {
      ...loadGateHealthConfig(),
      batchLockTimeoutMs: 30_000,
      batchStatementTimeoutMs: 60_000,
    },
    connection,
    readVerdict,
    clock,
    log,
  });
  try {
    return await runBackfillPass({
      holdPolicy: "propagate",
      sleep,
      // No cursor: a woken row leaves the predicate, so each batch takes the
      // next rows still owed. A batch short of its size ends the pass; what a
      // writer held then is woken by the next run.
      step: async () =>
        await runtime.step(async ({ tx, size }) => {
          const { text, params } = rendered(
            wakeCorpusProjectionStatesQuery({
              where: deferredStoredState(),
              limit: size,
            }),
          );
          const woken = await tx.query(text, params);
          return { cursor: null, done: woken.length < size, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};

export const createCorpusProjectionStoredRevisionWakeRepair = (
  options: CorpusProjectionStoredRevisionWakeRuntime = {},
) =>
  ({
    introducedBy: {
      type: "code",
      owner: "src/db/corpus-projection-stored-revision-wake-repair.ts",
    },
    name: REPAIR_NAME,
    readCompletion,
    repair: async (connection: OnlineMigrationConnection) => {
      // A database with nothing deferred owes nothing and starts no walk.
      if ((await readCompletion(connection)).type === "complete") {
        return { type: "complete" } as const;
      }
      const pass = await wakeDeferredStates(connection, options);
      if (pass.isErr()) {
        throw pass.error;
      }
      return { type: "complete" } as const;
    },
  }) satisfies OnlineRepair & { introducedBy: CodeOwnedOnlineStep };

export const CORPUS_PROJECTION_STORED_REVISION_WAKE_REPAIR =
  createCorpusProjectionStoredRevisionWakeRepair();
