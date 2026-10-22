/**
 * Online data repair behind 20261022120000_case_law_batch_slots.
 *
 * Fetch and parse were one atomic write before that migration, so a persisted
 * parsed representation came from the decision's current raw generation. The
 * corpus is walked in bounded primary-key ranges; the cursor is committed with
 * each batch, and the write predicate makes retries and rescans idempotent.
 * Only after the walk completes is the parse queue's partial index built: an
 * early build would contain almost the entire historical corpus.
 */
import { panic } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import { createIndexConcurrently } from "./online-ddl";
import type { OnlineIndexDeclaration, OnlineTableGate } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
  OnlineRepair,
} from "./online-migration-connection";

const REPAIR_NAME = "case-law-parsed-source-hash";
const TABLE_NAME = "case_law_decisions";
export const CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE = 1000;
const ID_FLOOR = "00000000-0000-0000-0000-000000000000";

export const CASE_LAW_PARSE_PENDING_INDEX = {
  createSql:
    'CREATE INDEX CONCURRENTLY "case_law_decisions_parse_pending_idx" ON public."case_law_decisions" USING btree ("id") WHERE "parsed_source_hash" IS DISTINCT FROM "source_hash"',
  definitionBody:
    "ON public.case_law_decisions USING btree (id) WHERE ((parsed_source_hash)::text IS DISTINCT FROM (source_hash)::text)",
  isUnique: false,
  name: "case_law_decisions_parse_pending_idx",
  tableName: TABLE_NAME,
} as const satisfies OnlineIndexDeclaration;

const READ_BOUNDARY_SQL = `
  SELECT id FROM public."${TABLE_NAME}"
  WHERE id > $1 ORDER BY id OFFSET $2 LIMIT 1
`;
const parsedOutputExists = `(
  "fulltext" IS NOT NULL OR "sections" IS NOT NULL OR "document_ast" IS NOT NULL OR
  "text_s3_key" IS NOT NULL OR "normalized_s3_key" IS NOT NULL OR "ast_s3_key" IS NOT NULL
)`;
const updateRangeSql = (tail: boolean) => `
  UPDATE public."${TABLE_NAME}"
  SET "parsed_source_hash" = "source_hash"
  WHERE id > $1 ${tail ? "" : "AND id <= $2"}
    AND "parsed_source_hash" IS NULL AND ${parsedOutputExists}
`;

export const repairCaseLawParsedSourceHashBatch = async (
  connection: Pick<OnlineMigrationConnection, "execute" | "query">,
  cursor: string | null,
  size: number,
): Promise<{ cursor: string; done: boolean }> => {
  const floor = cursor ?? ID_FLOOR;
  const boundary = await readBoundary(connection, floor, size);
  if (boundary === null) {
    await connection.execute(updateRangeSql(true), [floor]);
    return { cursor: floor, done: true };
  }
  await connection.execute(updateRangeSql(false), [floor, boundary]);
  return { cursor: boundary, done: false };
};

const readBoundary = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  cursor: string,
  size: number,
): Promise<string | null> => {
  const row = (
    await connection.query(READ_BOUNDARY_SQL, [cursor, size - 1])
  ).at(0);
  if (row === undefined) {
    return null;
  }
  if (!isRecord(row) || typeof row["id"] !== "string") {
    return panic(
      `Online repair ${REPAIR_NAME}: batch boundary has an invalid shape`,
    );
  }
  return row["id"];
};

type RepairOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  clock?: () => number;
  log?: (record: unknown) => void;
};

const backfill = async (
  connection: OnlineMigrationConnection,
  { readVerdict, sleep = Bun.sleep, clock, log }: RepairOptions,
) => {
  const runtime = createBackfillRuntime({
    name: REPAIR_NAME,
    tableName: TABLE_NAME,
    initialSize: CASE_LAW_PARSED_SOURCE_HASH_REPAIR_BATCH_SIZE,
    config: {
      ...defaultConfig,
      batchLockTimeoutMs: 30_000,
      batchStatementTimeoutMs: 30_000,
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
          await tx.execute("SET LOCAL lock_timeout = '30s'");
          await tx.execute("SET LOCAL statement_timeout = '30s'");
          const batch = await repairCaseLawParsedSourceHashBatch(
            tx,
            cursor,
            size,
          );
          return { ...batch, value: null };
        }),
    });
  } finally {
    await runtime.close();
  }
};

const readIndexComplete = async (connection: OnlineMigrationConnection) => {
  const row = (
    await connection.query(
      `
    SELECT i.indisready AS "isReady", i.indisvalid AS "isValid"
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = $1
  `,
      [CASE_LAW_PARSE_PENDING_INDEX.name],
    )
  ).at(0);
  if (row === undefined) {
    return {
      type: "incomplete",
      reason: "parse-pending index is missing",
    } as const;
  }
  if (!isRecord(row) || row["isReady"] !== true || row["isValid"] !== true) {
    return {
      type: "incomplete",
      reason: "parse-pending index is not valid",
    } as const;
  }
  return { type: "complete" } as const;
};

const buildIndex = async (
  tables: OnlineTableGate,
): Promise<OnlineMigrationOutcome> =>
  await tables.run({
    target: CASE_LAW_PARSE_PENDING_INDEX,
    kind: "index_build",
    work: async (session) =>
      await session.run(createIndexConcurrently(CASE_LAW_PARSE_PENDING_INDEX)),
  });

export const createCaseLawParsedSourceHashRepair = (
  options: RepairOptions = {},
): OnlineRepair => ({
  name: REPAIR_NAME,
  readCompletion: readIndexComplete,
  repair: async (connection, tables) => {
    const pass = await backfill(connection, options);
    if (pass.isErr()) {
      throw pass.error;
    }
    return await buildIndex(tables);
  },
});

export const CASE_LAW_PARSED_SOURCE_HASH_REPAIR =
  createCaseLawParsedSourceHashRepair();
