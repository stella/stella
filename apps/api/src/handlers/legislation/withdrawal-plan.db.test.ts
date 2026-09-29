/**
 * A withdrawal finds its version within one work, however large
 * `legislation_documents` grows: the lookup seeks the work by its identifier
 * and filters the work's own rows, never walks the primary key in id order
 * or scans the table. The plan is checked under the fixture's physical
 * statistics and again with the table scaled to the synthetic profile, and
 * the statement runs against the fixture so the index path is also the right
 * answer.
 */

import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  withdrawalTargetQuery,
  type LegislationWithdrawal,
} from "@/api/handlers/legislation/withdrawal";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";
import {
  explainRoot,
  scanOccurrences,
} from "@/api/tests/query-plans/plan-walker";
import { SYNTHETIC_SCALE_PROFILE } from "@/api/tests/query-plans/scale-profile";

const DB_TEST_TIMEOUT_MS = 120_000;
const TABLE = "legislation_documents";
/** The indexes that seek one work's rows by its identifier. */
const WORK_INDEXES: readonly string[] = [
  "legislation_documents_eli_idx",
  "legislation_documents_eli_lang_valid_from_idx",
];
const WORKS = 1500;
const VERSIONS = 8;
const INSERT_BATCH = 500;
/** Coprime with the row count, so ids interleave sources and works. */
const ID_STRIDE = 7919;

const SOURCES = [
  toSafeId<"legislationSource">("0198e331-e578-7000-8000-000000000d01"),
  // Shares every identifier with the first.
  toSafeId<"legislationSource">("0198e331-e578-7000-8000-000000000d02"),
] as const;

const publisherIdOf = (source: number, work: number, version: number) =>
  `plan${source}:https://example.test/eli/plan/${work}/v${version}`;

const PER_SOURCE = WORKS * VERSIONS;
const ROW_COUNT = SOURCES.length * PER_SOURCE;

const rows = SOURCES.flatMap((sourceId, source) =>
  Array.from({ length: PER_SOURCE }, (_, index) => {
    const position =
      (((source * PER_SOURCE + index) * ID_STRIDE) % ROW_COUNT) + 1;
    return {
      id: toSafeId<"legislationDocument">(
        `00000000-0000-7000-8d00-${String(position).padStart(12, "0")}`,
      ),
      sourceId,
      source,
      work: index % WORKS,
      version: Math.floor(index / WORKS),
    };
  }),
);

const target =
  rows.find(
    (row) => row.source === 1 && row.work === 777 && row.version === 5,
  ) ?? panic("the fixture has no target row");

const withdrawal = {
  sourceId: target.sourceId,
  eli: `eli/plan/${target.work}`,
  language: "cs",
  publisherId: publisherIdOf(target.source, target.work, target.version),
} satisfies Partial<LegislationWithdrawal>;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const asRoot = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (rootTx) => {
    // SAFETY: the PGlite transaction exposes the production root query surface.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction stands in for the production root transaction
    const tx = rootTx as unknown as Transaction;
    return await fn(tx);
  });

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(legislationSources).values(
      SOURCES.map((id, source) => ({
        id,
        adapterKey: `withdrawal-plan-${source}`,
        name: `Withdrawal plan ${source}`,
        expressionNamespace: `plan${source}`,
      })),
    );
    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      await db.insert(legislationDocuments).values(
        rows.slice(start, start + INSERT_BATCH).map((row) => ({
          id: row.id,
          sourceId: row.sourceId,
          eli: `eli/plan/${row.work}`,
          title: `Act ${row.work}`,
          country: "CZE",
          language: "cs",
          versionValidFrom: `2000-01-${String(row.version + 1).padStart(2, "0")}`,
          publisherExpressionId: publisherIdOf(
            row.source,
            row.work,
            row.version,
          ),
        })),
      );
    }
    await db.execute(sql`VACUUM (ANALYZE) legislation_documents`);
    await db.execute(sql`ANALYZE legislation_sources`);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

const expectWorkSeek = async () => {
  const root = await asRoot(async (tx) =>
    explainRoot(
      await tx.execute(
        sql`EXPLAIN (FORMAT JSON) ${withdrawalTargetQuery(tx, withdrawal).getSQL()}`,
      ),
    ),
  );
  const scans = scanOccurrences(root).filter(
    ({ relation }) => relation === TABLE,
  );
  expect(scans).toHaveLength(1);
  const [scan] = scans;
  expect(["Index Scan", "Index Only Scan", "Bitmap Heap Scan"]).toContain(
    scan?.nodeType ?? "missing",
  );
  expect(WORK_INDEXES).toContain(scan?.index ?? "missing");
  expect(scan?.indexCond ?? "").toContain("eli");
};

/** Physical statistics restored at the synthetic profile's size. */
const scaleDocumentsToProfile = async () => {
  const scale = SYNTHETIC_SCALE_PROFILE.tables.legislation_documents;
  const restored = (result: unknown, what: string) => {
    const [row] = executedRows(result);
    if (!isRecord(row) || row["restored"] !== true) {
      panic(`could not scale ${what}`);
    }
  };
  const [pages] = executedRows(
    await db.execute(
      sql`SELECT relpages, reltuples FROM pg_class WHERE oid = ${TABLE}::regclass`,
    ),
  );
  const relpages = isRecord(pages) ? pages["relpages"] : undefined;
  const reltuples = isRecord(pages) ? pages["reltuples"] : undefined;
  if (typeof relpages !== "number" || typeof reltuples !== "number") {
    return panic("the documents table has no physical pages");
  }
  const growth = scale.reltuples / reltuples;
  const indexes = executedRows(
    await db.execute(sql`
      SELECT c.relname, c.relpages, c.reltuples
        FROM pg_index AS i
        JOIN pg_class AS c ON c.oid = i.indexrelid
       WHERE i.indrelid = ${TABLE}::regclass
    `),
  );
  for (const index of indexes) {
    if (
      !isRecord(index) ||
      typeof index["relname"] !== "string" ||
      typeof index["relpages"] !== "number" ||
      typeof index["reltuples"] !== "number"
    ) {
      return panic("index statistics are malformed");
    }
    restored(
      await db.execute(sql`
        SELECT pg_restore_relation_stats(
          'schemaname', 'public', 'relname', ${index["relname"]}::text,
          'relpages', ${Math.ceil(index["relpages"] * growth)}::integer,
          'reltuples', ${Math.max(index["reltuples"], 0) * growth}::real
        ) AS restored
      `),
      index["relname"],
    );
  }
  restored(
    await db.execute(sql`
      SELECT pg_restore_relation_stats(
        'schemaname', 'public', 'relname', ${TABLE}::text,
        'reltuples', ${scale.reltuples}::real,
        'relallvisible', ${Math.round(relpages * scale.allVisibleFraction)}::integer
      ) AS restored
    `),
    TABLE,
  );
  for (const attribute of SYNTHETIC_SCALE_PROFILE.attributes) {
    if (attribute.table !== TABLE) {
      continue;
    }
    await db.execute(sql`
      SELECT pg_clear_attribute_stats(
        'public', ${TABLE}::text, ${attribute.column}::text, false
      )
    `);
    restored(
      await db.execute(sql`
        SELECT pg_restore_attribute_stats(
          'schemaname', 'public', 'relname', ${TABLE}::text,
          'attname', ${attribute.column}::text, 'inherited', false,
          'null_frac', ${attribute.nullFraction}::real,
          'n_distinct', ${attribute.distinctValues}::real
        ) AS restored
      `),
      `${TABLE}.${attribute.column}`,
    );
  }
};

test(
  "the lookup answers with the one version the id names",
  async () => {
    const found = await asRoot(
      async (tx) => await withdrawalTargetQuery(tx, withdrawal),
    );
    expect(found).toEqual([{ id: target.id }]);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the lookup seeks the work by its identifier, and still does at scale",
  async () => {
    await expectWorkSeek();
    await scaleDocumentsToProfile();
    await expectWorkSeek();
  },
  DB_TEST_TIMEOUT_MS,
);
