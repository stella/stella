/**
 * A private copy of the case-law and corpus tables for one ingestion run on
 * the gated PostgreSQL server: two runs over the same records (a serial and
 * a concurrent batch, a crashed run and its resume) each start from empty
 * tables and can be compared row for row, slugs and citation targets
 * included, without another suite's rows or the other run's in the way.
 */
import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";

import { chunk } from "@stll/concurrency/chunk";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { applyDecisionBatch } from "@/api/handlers/case-law/ingestion/pipeline/batch";
import {
  type CaseLawIngestionBatchRecord,
  prepareCaseLawIngestionBatch,
  type RejectedCaseLawIngestionRecord,
} from "@/api/handlers/case-law/ingestion/pipeline/batch-types";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { createSourceContractResolver } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { IMPORT_SOURCE_KEYS } from "@/api/lib/legal-search/parser-registry.gen";
import { isRecord } from "@/api/lib/type-guards";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

type Executor = Pick<GatedTestDb, "execute">;

/** The tables one run owns: every case-law and corpus table, empty. */
export const cloneCaseLawSchema = async (
  db: Executor,
  schemaName: string,
): Promise<string[]> => {
  const schema = sql.identifier(schemaName);
  await db.execute(sql`CREATE SCHEMA ${schema}`);
  const tables = executedRows(
    await db.execute(sql`
      SELECT tablename::text AS name FROM pg_tables
       WHERE schemaname = 'public'
         AND (tablename LIKE 'case_law_%' OR tablename LIKE 'corpus_%')
       ORDER BY tablename`),
  ).map((row) =>
    isRecord(row) && typeof row["name"] === "string"
      ? row["name"]
      : panic("pg_tables row without a name"),
  );
  await db.execute(
    sql.join(
      tables.map(
        (name) =>
          sql`CREATE TABLE ${schema}.${sql.identifier(name)} (LIKE public.${sql.identifier(name)} INCLUDING ALL);`,
      ),
      sql` `,
    ),
  );
  return tables;
};

export const dropCaseLawSchema = async (
  db: Executor,
  schemaName: string,
): Promise<void> => {
  await db.execute(sql`DROP SCHEMA ${sql.identifier(schemaName)} CASCADE`);
};

/** Pin a transaction's unqualified table names to the run's copy. */
export const useCaseLawSchema = async (
  tx: Pick<Transaction, "execute">,
  schemaName: string,
): Promise<void> => {
  await tx.execute(
    sql`SELECT set_config('search_path', ${`${schemaName}, public`}, true)`,
  );
};

export const schemaScopedDb =
  (db: Pick<GatedTestDb, "transaction">, schemaName: string): ScopedDb =>
  async (callback) =>
    await db.transaction(async (tx) => {
      await useCaseLawSchema(tx, schemaName);
      return await callback(tx);
    });

export const insertCourtListenerSource = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<void> => {
  await scopedDb(async (tx) => {
    await tx.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      name: "Ingest fixture",
    });
  });
};

type ApplyStreamOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  /** Decisions, or source rejections among them. */
  decisions: readonly (IngestionResult | RejectedCaseLawIngestionRecord)[];
  concurrency: number;
  corpus: CaseLawCorpusDependencies;
  /** Records per applied batch; the crawl bound by default. */
  batchSize?: number;
  /** The observation order of the stream's first batch. */
  firstOrder?: bigint;
  signal?: AbortSignal;
  /** Called before each batch is applied. */
  beforeBatch?: () => void;
};

export type AppliedBatch = Awaited<ReturnType<typeof applyDecisionBatch>>;

/**
 * Apply a stream the way a crawl applies its pages: one batch per bounded
 * part, each under its own observation, in order.
 */
export const applyIngestStream = async ({
  scopedDb,
  sourceId,
  decisions,
  concurrency,
  corpus,
  batchSize = 200,
  firstOrder = 1n,
  signal,
  beforeBatch,
}: ApplyStreamOptions): Promise<AppliedBatch[]> => {
  const resolveSourceContract = createSourceContractResolver(scopedDb);
  const applied: AppliedBatch[] = [];
  let order = firstOrder;
  const records = decisions.map((record): CaseLawIngestionBatchRecord =>
    "type" in record && record.type === "rejected"
      ? record
      : { type: "decision", decision: record },
  );
  for (const part of chunk(records, batchSize)) {
    const batch = prepareCaseLawIngestionBatch({ records: part });
    if (Result.isError(batch)) {
      return panic(batch.error.message);
    }
    beforeBatch?.();
    applied.push(
      await applyDecisionBatch(
        {
          batch: batch.value,
          sourceId,
          scopedDb,
          observation: { order, observedAt: new Date() },
          refresh: DECISION_REFRESH.WHEN_SOURCE_CHANGED,
          corpus,
          polarityRules: new Map(),
          context: {
            adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
            cursor: null,
          },
          concurrency,
          ...(signal === undefined ? {} : { signal }),
        },
        resolveSourceContract,
      ),
    );
    order += 1n;
  }
  return applied;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/u;

/** Columns whose value is a clock reading or a serial counter. */
const isVolatile = (key: string, value: unknown): boolean =>
  key.endsWith("_at") ||
  (typeof value === "string" && TIMESTAMP.test(value)) ||
  (key === "id" && typeof value === "number");

export type CanonicalCaseLawState = Record<string, string[]>;

/**
 * Every row of the run's tables, comparable across runs: a decision id reads
 * as the publisher identity of its row, any other generated id as `uuid`,
 * clock readings and serial counters are dropped, and each table's rows are
 * sorted. `exclude` names columns a comparison leaves out, with its reason
 * at the call site.
 */
export const canonicalCaseLawState = async (
  scopedDb: ScopedDb,
  tables: readonly string[],
  exclude: Readonly<Record<string, readonly string[]>> = {},
): Promise<CanonicalCaseLawState> =>
  await scopedDb(async (tx) => {
    const decisions = executedRows(
      await tx.execute(
        sql`SELECT id::text AS id, coalesce(source_document_id, case_number) AS identity FROM case_law_decisions`,
      ),
    );
    const tokens = new Map<string, string>(
      decisions.map((row) =>
        isRecord(row) &&
        typeof row["id"] === "string" &&
        typeof row["identity"] === "string"
          ? [row["id"], `decision:${row["identity"]}`]
          : panic("Decision row without an identity"),
      ),
    );
    const state: CanonicalCaseLawState = {};
    for (const table of tables) {
      const rows = executedRows(
        await tx.execute(
          sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(table)} AS t`,
        ),
      );
      const excluded = new Set(exclude[table]);
      state[table] = rows
        .map((row) => {
          const value = isRecord(row) ? row["row"] : undefined;
          const parsed: unknown =
            typeof value === "string" ? JSON.parse(value) : value;
          if (!isRecord(parsed)) {
            return panic(`Unreadable ${table} row`);
          }
          const kept = Object.fromEntries(
            Object.entries(parsed)
              .filter(
                ([key, column]) =>
                  !excluded.has(key) && !isVolatile(key, column),
              )
              .toSorted(([left], [right]) => (left < right ? -1 : 1)),
          );
          return JSON.stringify(kept).replaceAll(
            UUID,
            (id) => tokens.get(id) ?? "uuid",
          );
        })
        .toSorted();
    }
    return state;
  });
