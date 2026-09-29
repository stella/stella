/**
 * The parked-document count and the requeue's id selection must read the
 * parked rows alone. Parked decisions are a handful inside a pending backlog
 * that covers most of the source, so a plan that reaches them through the
 * pending index or a sequential scan visits the whole backlog on every call.
 *
 * The fixture has that shape: a large pending backlog, a few parked rows, and
 * a second source. The plans are checked under the physical statistics and
 * again with the decision table's size scaled up, and the same statements run
 * against the fixture so the index path is also the correct answer.
 */

import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  countParkedDocuments,
  parkedDocumentCountQuery,
  parkedDocumentIdsQuery,
  requeueParkedDocuments,
} from "@/api/lib/legal-search/sk-document-backfill";
import { MAX_DOCUMENT_FETCH_ATTEMPTS } from "@/api/lib/legal-search/sk-document-parking-sql";
import { isRecord } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import type { ScanOccurrence } from "@/api/tests/query-plans/plan-walker";

const DB_TEST_TIMEOUT_MS = 120_000;
const PARKED_INDEX = "case_law_decisions_document_parked_idx";
const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../../drizzle/20261003120600_case_law_document_parked_idx/migration.sql",
);

/** Pending decisions of the queue's source, none of them parked. */
const PENDING_ROWS = 20_000;
/** Parked decisions of the queue's source. */
const PARKED_ROWS = 12;
/** Decisions of another source: filled, and a few parked-shaped rows. */
const OTHER_SOURCE_ROWS = 4000;
/** Synthetic table size for the scaled pass; a round number, not a measurement. */
const SCALED_DECISION_ROWS = 100_000_000;
const REQUEUE_BATCH = 5;

const ID_PREFIX = "00000000-0000-7000-8a00-";
const OTHER_ID_PREFIX = "00000000-0000-7000-8b00-";

const sourceId = createSafeId<"caseLawSource">();
const otherSourceId = createSafeId<"caseLawSource">();

/**
 * Parked rows take the highest ids, so an id-ordered walk of the backlog
 * would reach them only after every pending row.
 */
const parkedIds = Array.from(
  { length: PARKED_ROWS },
  (_, index) =>
    `${ID_PREFIX}${String(PENDING_ROWS + index + 1).padStart(12, "0")}`,
);

let client: PGlite;
let db: ReturnType<typeof drizzle>;

/** Run `fn` in a root transaction, typed as the production one. */
const asRoot = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (rootTx) => {
    // SAFETY: the PGlite transaction exposes the production root query surface.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction stands in for the production root transaction
    const tx = rootTx as unknown as Transaction;
    return await fn(tx);
  });

/** The queue functions' database handle, over the same root transaction. */
const scopedDb: ScopedDb = asRoot;

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(caseLawSources).values([
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.SK_COURTS,
        id: sourceId,
        name: "parked plan",
      }),
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.CZ_NS,
        id: otherSourceId,
        name: "parked plan other",
      }),
    ]);
    // The backlog: retried up to one below the threshold, never parked.
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, court, country, language, decision_date,
         document_url, document_fetch_attempts, metadata)
      SELECT (${sql.raw(`'${ID_PREFIX}'`)} || lpad(i::text, 12, '0'))::uuid,
        ${sourceId}::uuid, 'pending-' || i, 'Okresný súd', 'SVK', 'sk',
        DATE '2020-01-01' + (i % 1500),
        'https://example.test/' || i || '.pdf',
        CASE WHEN i % 10 = 0 THEN i % ${MAX_DOCUMENT_FETCH_ATTEMPTS}::int
          ELSE 0 END,
        '{}'::jsonb
      FROM generate_series(1, ${PENDING_ROWS}::int) AS i
    `);
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, court, country, language, decision_date,
         document_url, document_fetch_attempts, metadata)
      SELECT (${sql.raw(`'${ID_PREFIX}'`)} || lpad(i::text, 12, '0'))::uuid,
        ${sourceId}::uuid, 'parked-' || i, 'Okresný súd', 'SVK', 'sk',
        DATE '2021-06-01', 'https://example.test/' || i || '.pdf',
        ${MAX_DOCUMENT_FETCH_ATTEMPTS}::int + (i % 2), '{}'::jsonb
      FROM generate_series(${PENDING_ROWS + 1}::int,
        ${PENDING_ROWS + PARKED_ROWS}::int) AS i
    `);
    // Another source's rows, which neither parked read may count.
    await db.execute(sql`
      INSERT INTO case_law_decisions
        (id, source_id, case_number, court, country, language, decision_date,
         document_url, fulltext, document_fetch_attempts, metadata)
      SELECT (${sql.raw(`'${OTHER_ID_PREFIX}'`)} || lpad(i::text, 12, '0'))::uuid,
        ${otherSourceId}::uuid, 'other-' || i, 'Nejvyšší soud', 'CZE', 'cs',
        DATE '2020-01-01' + (i % 1500), 'https://example.test/o' || i || '.pdf',
        CASE WHEN i % 500 = 0 THEN NULL ELSE 'text ' || i END,
        CASE WHEN i % 500 = 0 THEN ${MAX_DOCUMENT_FETCH_ATTEMPTS}::int
          ELSE 0 END,
        '{}'::jsonb
      FROM generate_series(1, ${OTHER_SOURCE_ROWS}::int) AS i
    `);
    await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
    await db.execute(sql`ANALYZE case_law_sources`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const countQuery = (tx: Transaction) => parkedDocumentCountQuery(tx, sourceId);
const idsQuery = (tx: Transaction) =>
  parkedDocumentIdsQuery({ limit: REQUEUE_BATCH, sourceId, tx });

const decisionScans = async (
  build: (tx: Transaction) => SQLWrapper,
): Promise<ScanOccurrence[]> =>
  await asRoot(async (tx) =>
    scanOccurrences(
      explainRoot(
        await tx.execute(sql`EXPLAIN (FORMAT JSON) ${build(tx).getSQL()}`),
      ),
    ).filter(({ relation }) => relation === "case_law_decisions"),
  );

/** One scan of the decisions, from the parked index. */
const expectParkedIndexOnly = async (
  build: (tx: Transaction) => SQLWrapper,
) => {
  const scans = await decisionScans(build);
  expect(
    scans.map(({ nodeType, index }) => ({
      seqScan: nodeType === "Seq Scan",
      index,
    })),
  ).toEqual([{ seqScan: false, index: PARKED_INDEX }]);
};

test("the migration builds the schema's index, with the queue's threshold", async () => {
  // The fixture's index comes from the schema, so the plan tests below never
  // see the shipped migration. Build the migration's statement under another
  // name and require the same definition, keys and predicate alike.
  const migration = await Bun.file(MIGRATION_PATH).text();
  const create = migration
    .split("--> statement-breakpoint")
    .find((part) =>
      part.includes(`CREATE INDEX CONCURRENTLY "${PARKED_INDEX}"`),
    );
  if (create === undefined) {
    panic(`Migration has no CREATE INDEX for ${PARKED_INDEX}.`);
  }
  const copyName = `${PARKED_INDEX}_migration`;
  await client.query(
    create
      .slice(create.indexOf("CREATE INDEX CONCURRENTLY"))
      .trim()
      .replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX")
      .replace(`"${PARKED_INDEX}"`, () => `"${copyName}"`),
  );
  try {
    const [row] = executedRows(
      await db.execute(
        sql`SELECT pg_get_indexdef(${PARKED_INDEX}::regclass) AS schema_definition,
                   pg_get_indexdef(${copyName}::regclass) AS migration_definition`,
      ),
    );
    if (!isRecord(row)) {
      panic("Index comparison returned no row.");
    }
    const schemaDefinition = row["schema_definition"];
    const migrationDefinition = row["migration_definition"];
    if (
      typeof schemaDefinition !== "string" ||
      typeof migrationDefinition !== "string"
    ) {
      panic("Index comparison returned no definitions.");
    }
    expect(migrationDefinition.replace(copyName, () => PARKED_INDEX)).toBe(
      schemaDefinition,
    );
    expect(schemaDefinition).toContain(
      `(document_fetch_attempts >= ${MAX_DOCUMENT_FETCH_ATTEMPTS})`,
    );
  } finally {
    // The copy would otherwise compete with the schema's index in the plans.
    await client.query(`DROP INDEX "${copyName}"`);
  }
});

test(
  "the parked count and the requeue's selection read only the parked index",
  async () => {
    await expectParkedIndexOnly(countQuery);
    await expectParkedIndexOnly(idsQuery);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "count and requeue answer from the parked rows in id order",
  async () => {
    expect(await countParkedDocuments(scopedDb, sourceId)).toBe(PARKED_ROWS);
    const before = await asRoot(async (tx) => await idsQuery(tx));
    expect(before.map(({ id }): string => id)).toEqual(
      parkedIds.slice(0, REQUEUE_BATCH),
    );

    expect(
      await requeueParkedDocuments({
        scopedDb,
        sourceId,
        limit: REQUEUE_BATCH,
      }),
    ).toBe(REQUEUE_BATCH);
    expect(await countParkedDocuments(scopedDb, sourceId)).toBe(
      PARKED_ROWS - REQUEUE_BATCH,
    );

    // A requeued row leaves the index, so the next batch starts after it.
    const after = await asRoot(async (tx) => await idsQuery(tx));
    expect(after.map(({ id }): string => id)).toEqual(
      parkedIds.slice(REQUEUE_BATCH, REQUEUE_BATCH * 2),
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the parked reads keep the parked index when the table is scaled up",
  async () => {
    const [row] = executedRows(
      await db.execute(sql`
        SELECT pg_restore_relation_stats(
          'schemaname', 'public', 'relname', 'case_law_decisions',
          'reltuples', ${SCALED_DECISION_ROWS}::real
        ) AS restored
      `),
    );
    if (!isRecord(row) || row["restored"] !== true) {
      panic("could not scale the decision table's statistics");
    }
    await expectParkedIndexOnly(countQuery);
    await expectParkedIndexOnly(idsQuery);
  },
  DB_TEST_TIMEOUT_MS,
);
