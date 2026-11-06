/**
 * The walk behind the online repairs that visit every projection revision.
 *
 * Rows go per transaction in primary-key order, as a bounded index range rather
 * than a scan for the rows a repair still owes: those have no index of their
 * own, and the table keeps one row per append attempt of the whole corpus. The
 * keyset cursor and adaptive holds commit with each batch, and a repaired row
 * leaves the repair's predicate, so an interrupted run resumes by running again.
 */

import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import type { Verdict } from "@stll/db-load-gate/health";

import { loadGateHealthConfig } from "../env-online-index";
import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const REVISIONS_TABLE = "corpus_index_projection_intents";
const BATCH = 1000;
const BATCH_LOCK_TIMEOUT = "30s";
const BATCH_STATEMENT_TIMEOUT = "1min";

/** Primary-key floor: every UUID sorts after it, so the walk starts here. */
const ID_FLOOR = "00000000-0000-0000-0000-000000000000";

const READ_BATCH_BOUNDARY_SQL = `
  SELECT id
  FROM public."${REVISIONS_TABLE}"
  WHERE id > $1
  ORDER BY id
  OFFSET $2
  LIMIT 1
`;

export type CorpusProjectionRevisionWalkRuntime = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

type CorpusProjectionRevisionWalk = {
  /** The repair's name, which is also its backfill checkpoint's. */
  name: string;
  /** The table the repair writes, which the load gate watches. */
  tableName: string;
  /** Repairs revisions above `$1` and up to and including `$2`. */
  repairRangeSql: string;
  /** Repairs every revision above `$1`, for the final partial batch. */
  repairTailSql: string;
};

const readBatchBoundary = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  name: string,
  cursor: string,
  size: number,
): Promise<string | null> => {
  const row = (
    await connection.query(READ_BATCH_BOUNDARY_SQL, [cursor, size - 1])
  ).at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return panic(`Online repair ${name}: batch boundary has an invalid shape`);
  }
  return row["id"];
};

export const walkCorpusProjectionRevisions = async (
  connection: OnlineMigrationConnection,
  {
    name,
    tableName,
    repairRangeSql,
    repairTailSql,
  }: CorpusProjectionRevisionWalk,
  {
    readVerdict,
    sleep = Bun.sleep,
    clock,
    log,
  }: CorpusProjectionRevisionWalkRuntime,
) => {
  const runtime = createBackfillRuntime({
    name,
    tableName,
    initialSize: BATCH,
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
      step: async () =>
        await runtime.step(async ({ tx, cursor, size }) => {
          await tx.execute(`SET LOCAL lock_timeout = '${BATCH_LOCK_TIMEOUT}'`);
          await tx.execute(
            `SET LOCAL statement_timeout = '${BATCH_STATEMENT_TIMEOUT}'`,
          );
          const floor = cursor ?? ID_FLOOR;
          const boundary = await readBatchBoundary(tx, name, floor, size);
          if (boundary === null) {
            await tx.execute(repairTailSql, [floor]);
            return { cursor: floor, done: true, value: null };
          }
          await tx.execute(repairRangeSql, [floor, boundary]);
          return { cursor: boundary, done: false, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};
