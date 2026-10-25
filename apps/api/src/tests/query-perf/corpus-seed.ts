import { sql } from "drizzle-orm";

import { corpusIndexGenerations } from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

/**
 * The corpus profile: public corpus tables seeded in the shape production
 * has, at a fraction of its size. Round synthetic values only; no corpus
 * content or catalog observation belongs here.
 *
 * Each case-law scenario exists at two sizes, so a scheduled job is measured
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

export const CASE_LAW_SCENARIOS = {
  quiet: { size: "case_law_v5", double: "case_law_v6" },
  busy: { size: "case_law_v7", double: "case_law_v8" },
} as const;

export type CaseLawScenarioGeneration =
  (typeof CASE_LAW_SCENARIOS)[keyof typeof CASE_LAW_SCENARIOS][
    "size" | "double"];

const SCENARIO_GENERATIONS = [
  { generation: "case_law_v5", kind: "quiet", rows: CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v6", kind: "quiet", rows: 2 * CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v7", kind: "busy", rows: CORPUS_SCENARIO_ROWS },
  { generation: "case_law_v8", kind: "busy", rows: 2 * CORPUS_SCENARIO_ROWS },
] as const satisfies readonly {
  generation: CaseLawScenarioGeneration;
  kind: keyof typeof CASE_LAW_SCENARIOS;
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
  database: GatedTestDb,
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
  database: GatedTestDb,
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
  database: GatedTestDb,
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

/** Moves `serving` to one case-law generation; the others are building. */
export const serveCaseLawGeneration = async (
  database: GatedTestDb,
  generation: CaseLawScenarioGeneration,
) => {
  await database.transaction(async (tx) => {
    await tx.execute(sql`UPDATE corpus_index_generations SET status = 'building'
      WHERE family = 'case_law' AND status = 'serving'`);
    await tx.execute(sql`UPDATE corpus_index_generations SET status = 'serving'
      WHERE family = 'case_law' AND generation = ${generation}`);
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
  for (const { generation, kind, rows } of SCENARIO_GENERATIONS) {
    for (const chunk of chunks(rows)) {
      // db-await-in-loop: bounded seed chunks keep each statement inside the fixture's statement timeout.
      await (kind === "quiet"
        ? seedQuietChunk(database, generation, chunk)
        : seedBusyChunk(database, generation, rows, chunk));
    }
  }
  await database.execute(sql`INSERT INTO legislation_sources (id, adapter_key, name)
    VALUES (${LEGISLATION_SOURCE_ID}, 'read-budget-fixture', 'Read budget fixture')`);
  for (const chunk of chunks(
    LEGISLATION_WORKS * LEGISLATION_VERSIONS_PER_WORK,
  )) {
    // db-await-in-loop: bounded seed chunks keep each statement inside the fixture's statement timeout.
    await seedLegislationChunk(database, chunk);
  }
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
