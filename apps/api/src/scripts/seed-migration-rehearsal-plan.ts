/**
 * What `seed-migration-rehearsal.ts` writes, separated from the script that
 * runs it so a database test can prove every seeder satisfies the tables'
 * constraints, and so the set of seeded tables is the set of registered
 * high-volume tables by type rather than by discipline.
 *
 * The rows are shaped, not real: enough columns to be valid, distributed so
 * the indexes a migration might use look the way they do in production (a
 * decision cites several others, most citations resolve, a few stay pending
 * or unmatched, dates spread over decades with a share of NULLs). Only
 * columns that have existed since the tables were created are written, on
 * purpose: the seed runs against the previously promoted release's schema,
 * before this checkout's migrations, and a column added by a pending
 * migration is not there yet.
 *
 * Every statement is plain SQL over `generate_series`; the one runtime input
 * is the decision count, and every other table is a fixed multiple of it. A
 * temporary table numbers the decisions so dependent rows can pick their
 * decision by an indexed integer instead of a random row.
 */

import { panic } from "better-result";

import type { HIGH_VOLUME_TABLES } from "../db/high-volume-tables";

type HighVolumeTable = (typeof HIGH_VOLUME_TABLES)[number];

/** Decisions written when no count is given: production's order of magnitude, scaled to a CI runner. */
export const REHEARSAL_DEFAULT_DECISIONS = 200_000;

/** Per-decision multiples; the totals a run reports are `decisions * ratio`. */
export const REHEARSAL_ROWS_PER_DECISION = {
  case_law_citations: 5,
  case_law_decision_identifiers: 1,
  case_law_decisions: 1,
  case_law_index_jobs: 1,
  case_law_provision_citations: 2,
  case_law_search_document_preview_passages: 2,
  case_law_search_documents: 1,
  corpus_index_projection_intents: 1,
  corpus_index_projection_states: 1,
  legislation_index_jobs: 1,
} as const satisfies Record<HighVolumeTable, number>;

const SOURCE_ID = "0b4f7d84-2f5e-4d8c-9a1a-6c8b7e2d5f01";
const PREVIEW_GENERATION = "0b4f7d84-2f5e-4d8c-9a1a-6c8b7e2d5f02";
const CORPUS_GENERATION = "case_law_v999";
const LEGISLATION_GENERATION = "legislation_v999";
const CORPUS_INDEX_ID = "rehearsal_cze";
const ZERO_DIGEST = "repeat('0', 64)";
/**
 * One epoch shared by every decision and its projection rows: the state
 * guard requires the desired epoch to match the decision's, and the intent
 * guard requires the intent to match the state.
 */
const PROJECTION_EPOCH = 1;

const assertCount = (decisions: number): void => {
  if (!Number.isSafeInteger(decisions) || decisions <= 0) {
    panic(
      `Rehearsal decision count must be a positive integer, got ${String(decisions)}`,
    );
  }
};

/**
 * Rows the seeders depend on that are not themselves high-volume: the
 * source every decision belongs to, the corpus generation the projection
 * rows reference, and the numbered decision list the dependents join.
 * The temporary table is per session, so the runner keeps one connection.
 */
export const rehearsalFixtureStatements = (): readonly string[] => [
  `INSERT INTO case_law_sources (id, adapter_key, name)
   VALUES ('${SOURCE_ID}', 'rehearsal', 'Migration rehearsal')
   ON CONFLICT DO NOTHING`,
  `INSERT INTO corpus_index_generations (family, generation, cluster, manifest_digest, status)
   VALUES ('case_law', '${CORPUS_GENERATION}', 'q09', ${ZERO_DIGEST}, 'building')
   ON CONFLICT DO NOTHING`,
];

/** Numbers the decisions once they exist; run between the decisions seeder and the rest. */
export const rehearsalDecisionIndexStatements = (): readonly string[] => [
  `CREATE TEMPORARY TABLE rehearsal_decisions AS
   SELECT row_number() OVER (ORDER BY id) AS rn, id, case_number, citation_key
   FROM case_law_decisions`,
  `CREATE INDEX rehearsal_decisions_rn_idx ON rehearsal_decisions (rn)`,
  `ANALYZE rehearsal_decisions`,
];

/** Every this-many-th decision carries a date past the tightened ceiling. */
const FUTURE_DATED_EVERY = 5000;

/**
 * A small cohort of decisions dated past the ceiling that
 * 20260902100000_case_law_decision_date_ceiling tightens, so its online
 * repair has rows to clear and edges to reopen against the seeded citation
 * table rather than returning on an empty first batch. Applied only while
 * the base schema still admits such dates: once every base a rehearsal
 * starts from carries the tightened CHECK, the predicate is false, the cohort
 * is empty, and this statement can be removed with the repair it exercises.
 */
export const rehearsalFutureDatedCohortStatement = (): string => `
  UPDATE case_law_decisions
     SET decision_date = (now() AT TIME ZONE 'UTC')::date + 40
   WHERE id IN (SELECT id FROM rehearsal_decisions WHERE rn % ${String(FUTURE_DATED_EVERY)} = 0)
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint
        WHERE conname = 'case_law_decisions_decision_date_bounds'
          AND pg_get_constraintdef(oid) LIKE '%::date + 2)%'
     )`;

/**
 * `((k - 1) / per) + 1`: the decision number that row `k` of a table with
 * `per` rows per decision belongs to. `(k * 7919) % n + 1`: a different
 * decision, spread over the whole population, for the cited side.
 */
const owner = (per: number) => `((g.k - 1) / ${String(per)}) + 1`;
// `bigint` before the multiply: `k` is int4 and reaches the millions.
const other = (decisions: number) =>
  `((g.k::bigint * 7919) % ${String(decisions)}) + 1`;

type Seeder = (decisions: number) => string;

/**
 * One INSERT per registered table, keyed by the table it fills. Total by
 * construction: a table added to the registry without a seeder does not
 * compile.
 */
export const REHEARSAL_SEEDERS = {
  case_law_decisions: (decisions) => `
    INSERT INTO case_law_decisions
      (id, source_id, case_number, citation_key, court, country, language,
       decision_date, metadata, content_hash, projection_epoch)
    SELECT gen_random_uuid(),
           '${SOURCE_ID}',
           g.k || ' Cdo ' || (g.k % 9000) || '/' || (2000 + g.k % 26),
           'cze:' || g.k || '-cdo-' || (g.k % 9000) || '/' || (2000 + g.k % 26),
           CASE g.k % 3
             WHEN 0 THEN 'Nejvyšší soud'
             WHEN 1 THEN 'Krajský soud v Brně'
             ELSE 'Okresní soud v Praze'
           END,
           'CZE',
           'cs',
           CASE WHEN g.k % 50 = 0 THEN NULL ELSE date '1995-01-01' + (g.k % 11000) END,
           '{}'::jsonb,
           ${ZERO_DIGEST},
           ${PROJECTION_EPOCH}
    FROM generate_series(1, ${String(decisions)}) AS g(k)`,
  case_law_decision_identifiers: () => `
    INSERT INTO case_law_decision_identifiers (decision_id, type, value, normalized_value)
    SELECT d.id, 'case-number', d.case_number, lower(d.case_number)
    FROM rehearsal_decisions d`,
  case_law_citations: (decisions) => `
    INSERT INTO case_law_citations
      (id, citing_decision_id, cited_decision_id, citation_text, citation_key,
       kind, resolution_status, resolution_attempted_at)
    SELECT gen_random_uuid(),
           citing.id,
           CASE WHEN g.k % 10 < 7 THEN cited.id END,
           'sp. zn. ' || cited.case_number,
           CASE WHEN g.k % 10 BETWEEN 7 AND 8 THEN cited.citation_key END,
           'precedent',
           CASE WHEN g.k % 10 < 7 THEN 'resolved'
                WHEN g.k % 10 < 9 THEN 'unmatched'
                ELSE 'pending' END,
           CASE WHEN g.k % 10 < 9 THEN now() END
    FROM generate_series(1, ${String(decisions * REHEARSAL_ROWS_PER_DECISION.case_law_citations)}) AS g(k)
    JOIN rehearsal_decisions citing ON citing.rn = ${owner(REHEARSAL_ROWS_PER_DECISION.case_law_citations)}
    JOIN rehearsal_decisions cited ON cited.rn = ${other(decisions)}`,
  case_law_provision_citations: (decisions) => `
    INSERT INTO case_law_provision_citations
      (id, decision_id, jurisdiction, work_identifier, work_number, work_year,
       work_collection, unit, section, anchor, sentence_text, span_start,
       span_end, confidence)
    SELECT gen_random_uuid(),
           d.id,
           'CZE',
           (g.k % 500 + 1) || '/2012 Sb.',
           g.k % 500 + 1,
           2012,
           'Sb.',
           'section',
           g.k % 3000 + 1,
           '§ ' || (g.k % 3000 + 1),
           'Podle § ' || (g.k % 3000 + 1) || ' zákona č. ' || (g.k % 500 + 1) || '/2012 Sb.',
           (g.k % ${String(REHEARSAL_ROWS_PER_DECISION.case_law_provision_citations)}) * 1000,
           (g.k % ${String(REHEARSAL_ROWS_PER_DECISION.case_law_provision_citations)}) * 1000 + 40,
           0.9
    FROM generate_series(1, ${String(decisions * REHEARSAL_ROWS_PER_DECISION.case_law_provision_citations)}) AS g(k)
    JOIN rehearsal_decisions d ON d.rn = ${owner(REHEARSAL_ROWS_PER_DECISION.case_law_provision_citations)}`,
  case_law_search_documents: () => `
    INSERT INTO case_law_search_documents
      (decision_id, title, searchable_text, language, regconfig, preview_generation)
    SELECT d.id, d.case_number, 'Rozsudek ' || d.case_number, 'cs', 'simple',
           '${PREVIEW_GENERATION}'
    FROM rehearsal_decisions d`,
  case_law_search_document_preview_passages: (decisions) => `
    INSERT INTO case_law_search_document_preview_passages
      (decision_id, generation, ordinal, content, tsv)
    SELECT d.id,
           '${PREVIEW_GENERATION}',
           g.k % ${String(REHEARSAL_ROWS_PER_DECISION.case_law_search_document_preview_passages)},
           'Odstavec ' || g.k || ' odůvodnění rozsudku ' || d.case_number,
           to_tsvector('simple', 'odstavec ' || g.k || ' odůvodnění rozsudku ' || d.case_number)
    FROM generate_series(1, ${String(decisions * REHEARSAL_ROWS_PER_DECISION.case_law_search_document_preview_passages)}) AS g(k)
    JOIN rehearsal_decisions d ON d.rn = ${owner(REHEARSAL_ROWS_PER_DECISION.case_law_search_document_preview_passages)}`,
  corpus_index_projection_intents: () => `
    INSERT INTO corpus_index_projection_intents
      (id, family, generation, entity_id, epoch, fingerprint, index_id, status,
       lease_token, lease_expires_at)
    SELECT gen_random_uuid(), 'case_law', '${CORPUS_GENERATION}', d.id, ${PROJECTION_EPOCH},
           ${ZERO_DIGEST}, '${CORPUS_INDEX_ID}', 'reserved', gen_random_uuid(),
           now() + interval '1 hour'
    FROM rehearsal_decisions d`,
  corpus_index_projection_states: () => `
    INSERT INTO corpus_index_projection_states
      (family, generation, entity_id, desired_action, desired_epoch,
       desired_fingerprint, desired_index_id)
    SELECT 'case_law', '${CORPUS_GENERATION}', d.id, 'upsert', ${PROJECTION_EPOCH},
           ${ZERO_DIGEST}, '${CORPUS_INDEX_ID}'
    FROM rehearsal_decisions d`,
  case_law_index_jobs: () => `
    INSERT INTO case_law_index_jobs
      (id, decision_id, generation, operation, status, content_hash)
    SELECT gen_random_uuid(), d.id, '${CORPUS_GENERATION}', 'index', 'succeeded',
           ${ZERO_DIGEST}
    FROM rehearsal_decisions d`,
  // The rehearsal seeds no legislation documents, so these are the rows the
  // trail keeps for a whole-index operation, which carry no document. The
  // volume is what a migration meets; the shape of the trail is the same.
  legislation_index_jobs: () => `
    INSERT INTO legislation_index_jobs
      (id, document_id, generation, operation, status, content_hash)
    SELECT gen_random_uuid(), NULL, '${LEGISLATION_GENERATION}', 'rebuild',
           'succeeded', ${ZERO_DIGEST}
    FROM rehearsal_decisions d`,
} as const satisfies Record<HighVolumeTable, Seeder>;

/**
 * Dependency order: decisions first, then everything that references them
 * (the search documents before their passages, the projection states before
 * the intents whose insert guard matches them against the desired state).
 * `seed-migration-rehearsal-plan.db.test.ts` proves this lists every
 * registered table exactly once.
 */
export const REHEARSAL_SEED_ORDER = [
  "case_law_decisions",
  "case_law_decision_identifiers",
  "case_law_citations",
  "case_law_provision_citations",
  "case_law_search_documents",
  "case_law_search_document_preview_passages",
  "corpus_index_projection_states",
  "corpus_index_projection_intents",
  "case_law_index_jobs",
  "legislation_index_jobs",
] as const satisfies readonly HighVolumeTable[];

export type RehearsalSeedStep = {
  statement: string;
  table: HighVolumeTable | null;
};

/**
 * Every statement of one seed run, in order: fixtures, the decisions, the
 * numbering, each dependent table, then statistics so the planner sees the
 * rows the way it would after autovacuum caught up.
 */
export const rehearsalSeedSteps = (
  decisions: number,
): readonly RehearsalSeedStep[] => {
  assertCount(decisions);
  const [decisionsTable, ...dependents] = REHEARSAL_SEED_ORDER;
  return [
    ...rehearsalFixtureStatements().map((statement) => ({
      statement,
      table: null,
    })),
    {
      statement: REHEARSAL_SEEDERS[decisionsTable](decisions),
      table: decisionsTable,
    },
    ...rehearsalDecisionIndexStatements().map((statement) => ({
      statement,
      table: null,
    })),
    ...dependents.map((table) => ({
      statement: REHEARSAL_SEEDERS[table](decisions),
      table,
    })),
    { statement: rehearsalFutureDatedCohortStatement(), table: null },
    ...REHEARSAL_SEED_ORDER.map((table) => ({
      statement: `ANALYZE ${table}`,
      table: null,
    })),
  ];
};
