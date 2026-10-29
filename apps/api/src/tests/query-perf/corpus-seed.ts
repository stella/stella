import { panic } from "better-result";
import { sql } from "drizzle-orm";
import * as v from "valibot";

import { corpusIndexGenerations } from "@/api/db/schema";
import type { TransactionOf } from "@/api/db/scoped";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import {
  tryLockCaseLawSitemapMonth,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { SCHEDULER_BACKFILL_IDS } from "@/api/lib/scheduler/backfill-config";
import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";

/**
 * The corpus profile: public corpus tables seeded in the shape production
 * has, at a fraction of its size. Round synthetic values only; no corpus
 * content or catalog observation belongs here.
 *
 * Most case-law scenarios exist at two sizes, so a scheduled job is measured
 * once against each and must read the same pages at both: a bounded read
 * passes at any size, and a read that grows with the corpus cannot pass by
 * being measured on a small fixture.
 *
 * - quiet generations: every state applied and converged, every revision
 *   applied and long published (a converged generation, the common case);
 * - busy generations: every state queued and never applied, each with a
 *   leased revision, in an update order unrelated to the heap order, so a
 *   walk of the queue index touches one heap page per entry as it does on a
 *   table written over months.
 */
const CORPUS_SCENARIO_ROWS = 60_000;

export type CaseLawScenarioGeneration =
  "case_law_v5" | "case_law_v6" | "case_law_v7" | "case_law_v8" | "case_law_v9";

/**
 * The generations readers are served: the family's serving generation, and
 * the generation each flipped jurisdiction points at.
 */
export type ServedCaseLaw = {
  serving: CaseLawScenarioGeneration;
  flipped?: readonly (readonly [string, CaseLawScenarioGeneration])[];
};

type CaseLawScenario = { size: ServedCaseLaw; double?: ServedCaseLaw };

export const CASE_LAW_SCENARIOS = {
  quiet: {
    size: { serving: "case_law_v5" },
    double: { serving: "case_law_v6" },
  },
  busy: {
    size: { serving: "case_law_v7" },
    double: { serving: "case_law_v8" },
  },
  // Two jurisdictions flipped to generations of their own: three served
  // generations, each with a queue past the report's scan cap. A cap per
  // generation reads three windows; the run's budget holds one.
  servedThree: {
    size: {
      serving: "case_law_v7",
      flipped: [
        ["CZE", "case_law_v8"],
        ["SVK", "case_law_v9"],
      ],
    },
  },
} as const satisfies Record<string, CaseLawScenario>;

export const describeServed = ({ serving, flipped = [] }: ServedCaseLaw) =>
  [
    serving,
    ...flipped.map(
      ([jurisdiction, generation]) => `${jurisdiction}:${generation}`,
    ),
  ].join("+");

const SCENARIO_GENERATIONS = [
  { generation: "case_law_v5", kind: "quiet", rows: CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v6", kind: "quiet", rows: 2 * CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v7", kind: "busy", rows: CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v8", kind: "busy", rows: 2 * CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v9", kind: "busy", rows: CORPUS_SCENARIO_ROWS },
] as const satisfies readonly {
  generation: CaseLawScenarioGeneration;
  kind: "quiet" | "busy";
  rows: number;
}[];

export const LEGISLATION_GENERATION = "legislation_v2";
const LEGISLATION_INDEX_ID = "legislation_v2_cze";
const LEGISLATION_WORKS = 20_000;
const LEGISLATION_VERSIONS_PER_WORK = 5;
/** One page of candidates, as the corpus index returns them. */
export const LEGISLATION_CANDIDATE_COUNT = 300;

/** Rows per seed statement, inside the fixture connection's statement timeout. */
const SEED_CHUNK_ROWS = 20_000;

const LEGISLATION_SOURCE_ID = "01990000-00a0-7000-8000-000000000001";

type SeedHandle = Pick<TransactionOf<GatedTestDb>, "execute">;

/** The seeded tables whose guard triggers the fixture's writes skip. */
const GUARDED_TABLES = [
  "corpus_index_generations",
  "corpus_index_jurisdiction_serving",
  "corpus_index_projection_states",
  "corpus_index_projection_intents",
  "legislation_documents",
] as const;

/**
 * Writes rows in their final state directly. The projection tables' triggers
 * admit only the projector's own transitions (a revision starts reserved, a
 * state changes under the mutation fence), so the fixture's transaction turns
 * the tables' own triggers off around its writes, as a restore does. Foreign
 * keys and checks still apply; the rows written satisfy all of them.
 */
const withoutTriggers = async (
  database: GatedTestDb,
  write: (tx: SeedHandle) => Promise<void>,
) => {
  await database.transaction(async (tx) => {
    for (const table of GUARDED_TABLES) {
      // db-await-in-loop: five fixed tables; ALTER TABLE takes one table per statement.
      await tx.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`));
    }
    await write(tx);
    for (const table of GUARDED_TABLES) {
      // db-await-in-loop: five fixed tables; ALTER TABLE takes one table per statement.
      await tx.execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER USER`));
    }
  });
};

/**
 * Secondary indexes of the bulk-loaded tables, dropped before the load and
 * rebuilt from their own definitions after it: building an index once over
 * the loaded rows is far cheaper than maintaining a dozen of them per row.
 * Indexes that back a constraint stay, so keys and checks hold throughout.
 */
const deferSecondaryIndexes = async (database: GatedTestDb) => {
  const definitions = v.parse(
    v.array(v.object({ name: v.string(), definition: v.string() })),
    executedRows(
      await database.execute(sql`SELECT index_class.relname AS name,
        pg_get_indexdef(entry.indexrelid) AS definition
      FROM pg_index entry
      JOIN pg_class index_class ON index_class.oid = entry.indexrelid
      JOIN pg_class table_class ON table_class.oid = entry.indrelid
      WHERE table_class.relnamespace = 'public'::regnamespace
        AND table_class.relname IN ('corpus_index_projection_states',
          'corpus_index_projection_intents', 'legislation_documents')
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint owner WHERE owner.conindid = entry.indexrelid
        )
      ORDER BY index_class.relname`),
    ),
  );
  await database.transaction(async (tx) => {
    for (const { name } of definitions) {
      // db-await-in-loop: one DROP INDEX per secondary index of three fixed tables.
      await tx.execute(sql`DROP INDEX ${sql.identifier(name)}`);
    }
  });
  return async () => {
    await database.transaction(async (tx) => {
      for (const { definition } of definitions) {
        // db-await-in-loop: one CREATE INDEX per dropped index, from its own definition.
        await tx.execute(sql.raw(definition));
      }
    });
  };
};

/** A UUID whose last group carries `n`, under a per-table prefix. */
const uuidOf = (prefix: string, n: string) =>
  `('01990000-${prefix}-7000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;

const generationPrefix = (generation: string) =>
  generation.replaceAll(/\D/gu, "").padStart(4, "0");

const chunks = (rows: number) =>
  Array.from({ length: Math.ceil(rows / SEED_CHUNK_ROWS) }, (_, index) => ({
    first: index * SEED_CHUNK_ROWS + 1,
    last: Math.min((index + 1) * SEED_CHUNK_ROWS, rows),
  }));

const seedQuietChunk = async (
  database: SeedHandle,
  generation: string,
  { first, last }: { first: number; last: number },
) => {
  const prefix = generationPrefix(generation);
  const indexId = `${generation}_cs_sk`;
  await database.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         applied_at, created_at, updated_at)
      SELECT ${uuidOf(`9${prefix.slice(1)}`, "i")}, 'case_law', '${generation}',
        ${uuidOf(`8${prefix.slice(1)}`, "i")}, 1, lpad(to_hex(i), 64, '0'),
        '${indexId}', 'applied', 3, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS i
    `),
  );
  await database.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      SELECT 'case_law', '${generation}', ${uuidOf(`8${prefix.slice(1)}`, "i")},
        'upsert', 1, lpad(to_hex(i), 64, '0'), '${indexId}', 'eligible',
        'upsert', 1, ${uuidOf(`9${prefix.slice(1)}`, "i")},
        lpad(to_hex(i), 64, '0'), '${indexId}', '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS i
    `),
  );
};

const seedBusyChunk = async (
  database: SeedHandle,
  generation: string,
  rows: number,
  { first, last }: { first: number; last: number },
) => {
  const prefix = generationPrefix(generation);
  const indexId = `${generation}_cs_sk`;
  // 7919 is prime and coprime with the row count, so the update order is a
  // permutation of the insert order that keeps no two neighbours together.
  await database.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, created_at,
         updated_at)
      SELECT 'case_law', '${generation}', ${uuidOf(`8${prefix.slice(1)}`, "i")},
        'upsert', 1, lpad(to_hex(i), 64, 'c'), '${indexId}', 'eligible',
        '2026-09-01'::timestamptz,
        '2026-09-01'::timestamptz + ((i::bigint * 7919) % ${rows}) * interval '1 second'
      FROM generate_series(${first}, ${last}) AS i
    `),
  );
  await database.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         lease_token, lease_expires_at, created_at, updated_at)
      SELECT ${uuidOf(`9${prefix.slice(1)}`, "i")}, 'case_law', '${generation}',
        ${uuidOf(`8${prefix.slice(1)}`, "i")}, 1, lpad(to_hex(i), 64, 'c'),
        '${indexId}', 'reserved', gen_random_uuid(), '2026-09-02'::timestamptz,
        '2026-09-01'::timestamptz, '2026-09-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS i
    `),
  );
};

/** Works with several consolidations each; every version converged. */
const seedLegislationChunk = async (
  database: SeedHandle,
  { first, last }: { first: number; last: number },
) => {
  const versions = LEGISLATION_VERSIONS_PER_WORK;
  // Row n is version ((n - 1) % versions) + 1 of work ((n - 1) / versions) + 1.
  await database.execute(
    sql.raw(`
      INSERT INTO legislation_documents
        (id, source_id, eli, title, country, language, status,
         version_valid_from, version_valid_to, created_at, updated_at)
      SELECT ${uuidOf("00a2", "n")}, '${LEGISLATION_SOURCE_ID}',
        'https://legislation.example.test/eli/cz/act/' || ((n - 1) / ${versions} + 1),
        'Fixture act ' || ((n - 1) / ${versions} + 1), 'CZE', 'cs', 'current',
        DATE '2001-01-01' + (((n - 1) % ${versions}) * 730),
        CASE WHEN (n - 1) % ${versions} = ${versions - 1} THEN NULL
          ELSE DATE '2001-01-01' + (((n - 1) % ${versions}) * 730 + 729) END,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS n
    `),
  );
  await database.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
         expected_document_count, append_started_at, append_committed_at,
         applied_at, created_at, updated_at)
      SELECT ${uuidOf("00b2", "n")}, 'legislation', '${LEGISLATION_GENERATION}',
        ${uuidOf("00a2", "n")}, 1, lpad(to_hex(n), 64, '0'),
        '${LEGISLATION_INDEX_ID}', 'applied', 1, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS n
    `),
  );
  await database.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_states
        (family, generation, entity_id, desired_action, desired_epoch,
         desired_fingerprint, desired_index_id, work_status, applied_action,
         applied_epoch, applied_revision, applied_fingerprint, applied_index_id,
         applied_at, created_at, updated_at)
      SELECT 'legislation', '${LEGISLATION_GENERATION}', ${uuidOf("00a2", "n")},
        'upsert', 1, lpad(to_hex(n), 64, '0'), '${LEGISLATION_INDEX_ID}',
        'eligible', 'upsert', 1, ${uuidOf("00b2", "n")},
        lpad(to_hex(n), 64, '0'), '${LEGISLATION_INDEX_ID}',
        '2026-08-01'::timestamptz, '2026-08-01'::timestamptz,
        '2026-08-01'::timestamptz
      FROM generate_series(${first}, ${last}) AS n
    `),
  );
};

/**
 * Serves case law from `served`: `serving` becomes the family's serving
 * generation (the others are building) and each flipped jurisdiction points
 * at its generation, replacing any earlier pointers.
 */
export const serveCaseLaw = async (
  database: GatedTestDb,
  { serving, flipped = [] }: ServedCaseLaw,
) => {
  await withoutTriggers(database, async (tx) => {
    await tx.execute(sql`UPDATE corpus_index_generations SET status = 'building'
      WHERE family = 'case_law' AND status = 'serving'`);
    await tx.execute(sql`UPDATE corpus_index_generations SET status = 'serving'
      WHERE family = 'case_law' AND generation = ${serving}`);
    await tx.execute(
      sql`DELETE FROM corpus_index_jurisdiction_serving WHERE family = 'case_law'`,
    );
    for (const [jurisdiction, generation] of flipped) {
      // db-await-in-loop: a scenario flips at most a handful of jurisdictions.
      await tx.execute(sql`INSERT INTO corpus_index_jurisdiction_serving
        (family, jurisdiction, generation, from_generation)
        VALUES ('case_law', ${jurisdiction}, ${generation}, ${serving})`);
    }
  });
};

export const seedCorpusReadBudgets = async (database: GatedTestDb) => {
  await database.insert(corpusIndexGenerations).values([
    ...SCENARIO_GENERATIONS.map(({ generation }) => ({
      family: "case_law" as const,
      generation,
      cluster: "q09" as const,
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[generation],
      ),
      status: "building" as const,
    })),
    {
      family: "legislation" as const,
      generation: LEGISLATION_GENERATION,
      cluster: "q09" as const,
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[LEGISLATION_GENERATION],
      ),
      status: "serving" as const,
    },
  ]);
  const rebuildIndexes = await deferSecondaryIndexes(database);
  for (const { generation, kind, rows } of SCENARIO_GENERATIONS) {
    for (const chunk of chunks(rows)) {
      // db-await-in-loop: bounded seed chunks keep each statement inside the fixture's statement timeout.
      await withoutTriggers(database, async (tx) => {
        await (kind === "quiet"
          ? seedQuietChunk(tx, generation, chunk)
          : seedBusyChunk(tx, generation, rows, chunk));
      });
    }
  }
  await database.execute(sql`INSERT INTO legislation_sources (id, adapter_key, name)
    VALUES (${LEGISLATION_SOURCE_ID}, 'read-budget-fixture', 'Read budget fixture')`);
  for (const chunk of chunks(
    LEGISLATION_WORKS * LEGISLATION_VERSIONS_PER_WORK,
  )) {
    // db-await-in-loop: bounded seed chunks keep each statement inside the fixture's statement timeout.
    await withoutTriggers(database, async (tx) => {
      await seedLegislationChunk(tx, chunk);
    });
  }
  await rebuildIndexes();
  for (const table of [
    "corpus_index_generations",
    "corpus_index_projection_states",
    "corpus_index_projection_intents",
    "legislation_sources",
    "legislation_documents",
  ]) {
    // db-await-in-loop: one VACUUM per seeded table; VACUUM cannot share a statement.
    await database.execute(sql.raw(`VACUUM (ANALYZE) ${table}`));
  }
  const works = Array.from(
    { length: LEGISLATION_CANDIDATE_COUNT },
    // Spread over the works, as hits for a common term are.
    (_, index) => ((index * 61) % LEGISLATION_WORKS) + 1,
  );
  const candidateIds: SafeId<"legislationDocument">[] = works.map((work) =>
    toSafeId<"legislationDocument">(
      `01990000-00a2-7000-8000-${(work * LEGISLATION_VERSIONS_PER_WORK).toString(16).padStart(12, "0")}`,
    ),
  );
  return { candidateIds };
};

export type CorpusReadBudgetSeed = Awaited<
  ReturnType<typeof seedCorpusReadBudgets>
>;

type SeedSitemapReadBudgetOptions = {
  database: GatedTestDb;
  served: ServedCaseLaw;
  openClient: GatedTestClientScope["openClient"];
};

/** The sitemap fixture's source; any registered adapter serves, its rows are synthetic. */
const SITEMAP_FIXTURE_ADAPTER_KEY = ADAPTER_KEYS.CZ_REGIONAL;

/** One available dirty month beside a growing backlog held by another run. */
export const seedSitemapReadBudget = async ({
  database,
  served: { serving },
  openClient,
}: SeedSitemapReadBudgetOptions) => {
  const scenario =
    SCENARIO_GENERATIONS.find(({ generation }) => generation === serving) ??
    panic(`Unknown sitemap scenario ${serving}`);
  const sourceId = "01990000-00c0-7000-8000-000000000001";
  // A registered adapter key: the coverage refresh reads every source through
  // the adapter registry, and an unregistered key is reported as an error.
  await database.execute(sql`INSERT INTO case_law_sources (id, adapter_key, name, enabled)
    VALUES (${sourceId}::uuid, ${SITEMAP_FIXTURE_ADAPTER_KEY}, 'Sitemap fixture', false)
    ON CONFLICT (id) DO NOTHING`);
  await database.execute(
    sql`DELETE FROM case_law_decisions WHERE source_id = ${sourceId}::uuid`,
  );
  for (let first = 1; first <= scenario.rows; first += SEED_CHUNK_ROWS) {
    const last = Math.min(first + SEED_CHUNK_ROWS - 1, scenario.rows);
    // Synthetic seed rows form no case files.
    await database.execute(sql`INSERT INTO case_law_decisions
      (id, source_id, country, court, language, case_number, docket_family_key, decision_date)
      SELECT ('01990000-00c1-7000-8000-' || lpad(to_hex(i), 12, '0'))::uuid,
        ${sourceId}::uuid, CASE WHEN i = 1 THEN 'XQT' ELSE 'XQN' END,
        'Fixture court', 'xx', i::text, NULL, DATE '2024-01-01'
      FROM generate_series(${first}, ${last}) i`);
  }
  // Existing shards represent the unrelated, previously refreshed months.
  await database.execute(sql`DELETE FROM case_law_sitemap_shards`);
  await database.execute(sql`INSERT INTO case_law_sitemap_shards
    (country, year, month, bucket, total, last_modified_at)
    SELECT 'XQN', (1000 + i / 12)::text, lpad((1 + i % 12)::text, 2, '0'),
      'all', 1, '2026-01-01'::timestamptz FROM generate_series(1, ${scenario.rows}) i`);
  await database.execute(sql`DELETE FROM case_law_sitemap_changes`);
  // Many committed changes of the same month exercise the bounded queue
  // page and its full-month consumption without adding dirty months.
  await database.execute(sql`INSERT INTO case_law_sitemap_changes (country, year, month, xact)
    SELECT 'XQT', '2024', '01', (1000000 + i)::text::xid8
    FROM generate_series(1, 2000) i`);
  await database.execute(sql`INSERT INTO case_law_sitemap_changes (country, year, month, xact)
    SELECT 'XQN', '2024', '01', (2000000 + i)::text::xid8
    FROM generate_series(1, ${scenario.rows}) i`);
  await database.execute(sql`VACUUM (ANALYZE) case_law_decisions`);
  await database.execute(sql`VACUUM (ANALYZE) case_law_sitemap_shards`);
  await database.execute(sql`VACUUM (ANALYZE) case_law_sitemap_changes`);
  const acquired = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const holding = withAggregateTransaction(openClient().db, async (tx) => {
    if (
      !(await tryLockCaseLawSitemapMonth({
        tx,
        month: { country: "XQN", year: "2024", month: "01" },
      }))
    ) {
      panic("Sitemap fixture backlog month is already held");
    }
    acquired.resolve(undefined);
    await release.promise;
  });
  await Promise.race([
    acquired.promise,
    holding.then(() => panic("Sitemap fixture lock released before capture")),
  ]);
  return async () => {
    release.resolve(undefined);
    await holding;
  };
};

/**
 * The rows the coverage refresh writes: its summary, its backfill checkpoint
 * and its audit runs. Table names are code constants.
 */
const COVERAGE_REFRESH_STATE = [
  { table: "case_law_coverage_summaries", where: sql`true` },
  {
    table: "database_backfill_states",
    where: sql`name = ${SCHEDULER_BACKFILL_IDS.coverage}`,
  },
  {
    table: "system_audit_runs",
    where: sql`actor = 'system:case-law-coverage-refresh'`,
  },
] as const;

/** Every row the coverage refresh owns, exactly as stored, per table. */
export const readCoverageRefreshState = async (database: GatedTestDb) => {
  const state: Record<string, string> = {};
  for (const { table, where } of COVERAGE_REFRESH_STATE) {
    // db-await-in-loop: three fixed tables, read one at a time on one connection.
    const row = executedRows(
      await database.execute(sql`SELECT coalesce(
          jsonb_agg(to_jsonb(stored) ORDER BY to_jsonb(stored)::text),
          '[]'::jsonb
        )::text AS rows
        FROM ${sql.raw(table)} AS stored WHERE ${where}`),
    ).at(0);
    const rows =
      typeof row === "object" && row !== null && "rows" in row
        ? row.rows
        : undefined;
    state[table] =
      typeof rows === "string" ? rows : panic(`Unreadable ${table} state`);
  }
  return state;
};

/** The refresh ran its computation: its summary row is stored. */
export const coverageRefreshWroteSummary = async (database: GatedTestDb) =>
  (await readCoverageRefreshState(database))["case_law_coverage_summaries"] !==
  "[]";

const replaceCoverageRefreshState = async (
  database: GatedTestDb,
  state: Readonly<Record<string, string>>,
) => {
  for (const { table, where } of COVERAGE_REFRESH_STATE) {
    // db-await-in-loop: three fixed tables, replaced one at a time on one connection.
    await database.execute(sql`DELETE FROM ${sql.raw(table)} WHERE ${where}`);
    // db-await-in-loop: the table's stored rows go back right after its delete.
    await database.execute(sql`INSERT INTO ${sql.raw(table)}
      SELECT * FROM jsonb_populate_recordset(
        NULL::${sql.raw(table)},
        ${state[table] ?? panic(`No ${table} state to restore`)}::text::jsonb
      )`);
  }
};

/**
 * The coverage refresh commits its writes, as the measure-in-place adapter
 * requires. Each measured run starts without refresh state, so every run takes
 * the same path, and the fixture is put back exactly as it was found.
 */
export const isolateCoverageRefreshMeasurement = async ({
  database,
}: SeedSitemapReadBudgetOptions) => {
  const found = await readCoverageRefreshState(database);
  await replaceCoverageRefreshState(
    database,
    Object.fromEntries(
      COVERAGE_REFRESH_STATE.map(({ table }) => [table, "[]"]),
    ),
  );
  return async () => {
    await replaceCoverageRefreshState(database, found);
  };
};
