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
import { putCorpusPacks } from "@/api/lib/legal-search/corpus-pack-writer";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { IMPORT_SOURCE_KEYS } from "@/api/lib/legal-search/parser-registry.gen";
import { isRecord } from "@/api/lib/type-guards";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

type Executor = Pick<GatedTestDb, "execute">;

const stringColumn = (row: unknown, column: string): string => {
  const value = isRecord(row) ? row[column] : undefined;
  return typeof value === "string"
    ? value
    : panic(`Catalog row without ${column}`);
};

/**
 * The tables one run owns: every case-law and corpus table, empty, with the
 * foreign keys the deployed schema declares between them (`LIKE` copies
 * columns, checks and indexes, not foreign keys). Created in one
 * transaction, so a setup that fails leaves no schema behind.
 */
export const cloneCaseLawSchema = async (
  db: Pick<GatedTestDb, "transaction">,
  schemaName: string,
): Promise<string[]> =>
  await db.transaction(async (tx) => {
    const schema = sql.identifier(schemaName);
    // The definitions below name public tables unqualified only while
    // public is the schema names resolve in.
    await tx.execute(sql`SELECT set_config('search_path', 'public', true)`);
    await tx.execute(sql`CREATE SCHEMA ${schema}`);
    const tables = executedRows(
      await tx.execute(sql`
        SELECT tablename::text AS name FROM pg_tables
         WHERE schemaname = 'public'
           AND (tablename LIKE 'case_law_%' OR tablename LIKE 'corpus_%')
         ORDER BY tablename`),
    ).map((row) => stringColumn(row, "name"));
    await tx.execute(
      sql.join(
        tables.map(
          (name) =>
            sql`CREATE TABLE ${schema}.${sql.identifier(name)} (LIKE public.${sql.identifier(name)} INCLUDING ALL);`,
        ),
        sql` `,
      ),
    );
    const cloned = new Set(tables);
    const foreignKeys = executedRows(
      await tx.execute(sql`
        SELECT r.relname::text AS "table", c.conname::text AS name,
               pg_get_constraintdef(c.oid) AS definition
          FROM pg_constraint c
          JOIN pg_class r ON r.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE c.contype = 'f' AND n.nspname = 'public'
         ORDER BY r.relname, c.conname`),
    )
      .map((row) => ({
        table: stringColumn(row, "table"),
        name: stringColumn(row, "name"),
        definition: stringColumn(row, "definition"),
      }))
      .filter(({ table }) => cloned.has(table));
    if (foreignKeys.length > 0) {
      // Resolved in the run's schema first: a key between two cloned
      // tables references the copy, one to any other table the original.
      await tx.execute(
        sql`SELECT set_config('search_path', ${`${schemaName}, public`}, true)`,
      );
      await tx.execute(
        sql.join(
          foreignKeys.map(
            ({ table, name, definition }) =>
              sql`ALTER TABLE ${schema}.${sql.identifier(table)} ADD CONSTRAINT ${sql.identifier(name)} ${sql.raw(definition)};`,
          ),
          sql` `,
        ),
      );
    }
    return tables;
  });

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

export const insertIngestSource = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
  adapterKey: string = IMPORT_SOURCE_KEYS.COURTLISTENER,
): Promise<void> => {
  await scopedDb(async (tx) => {
    await tx.insert(caseLawSources).values({
      id: sourceId,
      adapterKey,
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
  /**
   * The batch to start at, as a crawl resumes at its held page; earlier
   * batches are not applied, and the orders keep their place in the stream.
   */
  fromBatch?: number;
  signal?: AbortSignal;
};

/**
 * Packs written to the object store `lib/s3.ts` points at (the in-process
 * store in these runs), as the deployment writes them, so a later
 * observation reads the stored payload back. `put` wraps the write, for a
 * caller that counts or fails it.
 */
export const objectStoreCorpus = (
  put: (
    write: () => ReturnType<typeof putCorpusPacks>,
  ) => ReturnType<typeof putCorpusPacks> = async (write) => await write(),
): CaseLawCorpusDependencies => ({
  mode: "canonical",
  transfer: {
    layout: "packs",
    putPacks: async (options) =>
      await put(async () => await putCorpusPacks(options)),
  },
});

const isRejection = (
  record: IngestionResult | RejectedCaseLawIngestionRecord,
): record is RejectedCaseLawIngestionRecord => "recordKey" in record;

export type AppliedBatch = Awaited<ReturnType<typeof applyDecisionBatch>>;

/**
 * Apply a stream the way a crawl applies its pages: one batch per bounded
 * part, each under its own observation, in order. A batch that stops holds
 * the stream there, as a crawl holds its cursor on the page: the batches
 * after it are not applied, and the caller resumes at the held one
 * (`fromBatch`).
 */
export const applyIngestStream = async ({
  scopedDb,
  sourceId,
  decisions,
  concurrency,
  corpus,
  batchSize = 200,
  firstOrder = 1n,
  fromBatch = 0,
  signal,
}: ApplyStreamOptions): Promise<AppliedBatch[]> => {
  const resolveSourceContract = createSourceContractResolver(scopedDb);
  const applied: AppliedBatch[] = [];
  let order = firstOrder + BigInt(fromBatch);
  const records = decisions.map((record): CaseLawIngestionBatchRecord =>
    isRejection(record) ? record : { type: "decision", decision: record },
  );
  for (const part of chunk(records, batchSize).slice(fromBatch)) {
    const batch = prepareCaseLawIngestionBatch({ records: part });
    if (Result.isError(batch)) {
      return panic(batch.error.message);
    }
    const appliedBatch = await applyDecisionBatch(
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
    );
    applied.push(appliedBatch);
    if (appliedBatch.halt !== null) {
      break;
    }
    order += 1n;
  }
  return applied;
};

/**
 * A payload's place in its pack: the pack key and offset follow the order
 * payloads joined the pack, so only the member's own digest is compared.
 */
const PACK_PLACE = /pack:[^"@]+@\d+\+\d+#/gu;
const PACK_KEY = /[^"]*\/packs\/[^"]*\.stlpack/gu;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/u;

/** Columns whose value is a clock reading or a serial counter. */
const isVolatile = (key: string, value: unknown): boolean =>
  key.endsWith("_at") ||
  (typeof value === "string" && TIMESTAMP.test(value)) ||
  (key === "id" && typeof value === "number");

/**
 * Columns holding what the publisher stated: compared as stored, so two
 * texts that differ only in a literal UUID still differ.
 */
const PUBLISHER_COLUMNS = new Set([
  "case_number",
  "citation_text",
  "document_ast",
  "document_url",
  "ecli",
  "fulltext",
  "metadata",
  "normalized_identifier_value",
  "sections",
  "source_document_id",
  "source_raw",
  "source_url",
  "title",
]);

/**
 * A generated column with its ids named across runs: a decision id as its
 * row's publisher identity, any other as `uuid`, a pack key and place as
 * the member's digest alone.
 */
const withGeneratedIdsNamed = (
  column: unknown,
  tokens: ReadonlyMap<string, string>,
): unknown =>
  JSON.parse(
    JSON.stringify(column)
      .replaceAll(PACK_PLACE, "pack:#")
      .replaceAll(PACK_KEY, "pack")
      .replaceAll(UUID, (id) =>
        JSON.stringify(tokens.get(id) ?? "uuid").slice(1, -1),
      ),
  );

export type CanonicalCaseLawState = Record<string, string[]>;

/**
 * Every row of the run's tables, comparable across runs: in generated
 * columns a decision id reads as the publisher identity of its row, any
 * other generated id as `uuid`, and a payload's pack and place in it as its
 * digest alone; publisher columns are compared as stored. Clock readings
 * and serial counters are dropped, and each table's rows are sorted.
 * `exclude` names columns a comparison leaves out, with its reason at the
 * call site.
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
              .toSorted(([left], [right]) => (left < right ? -1 : 1))
              .map(([key, column]) => [
                key,
                PUBLISHER_COLUMNS.has(key)
                  ? column
                  : withGeneratedIdsNamed(column, tokens),
              ]),
          );
          return JSON.stringify(kept);
        })
        .toSorted();
    }
    return state;
  });
