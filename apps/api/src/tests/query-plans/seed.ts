import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawProvisionCitations,
  caseLawProvisionExtractions,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  caseLawSources,
  caseLawStatuteCitationMemberships,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationIndexJobs,
  legislationSearchDocuments,
  legislationSources,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

import { PLAN_GUARD_TABLES } from "../../db/plan-guard-tables";

export const QUERY_PLAN_ROW_COUNT = 3000;
const DECISION_ID_PREFIX = "00000000-0000-7000-8000-";
const LEGISLATION_DOCUMENT_ID_PREFIX = "00000000-0000-7000-9000-";
const SAMPLE_DECISION_NUMBER = 12;

const makeUuid = (prefix: string, number: number): string =>
  `${prefix}${String(number).padStart(12, "0")}`;

export const QUERY_PLAN_SAMPLE = {
  caseLaw: {
    country: "CZE",
    decisionId: toSafeId<"caseLawDecision">(
      makeUuid(DECISION_ID_PREFIX, SAMPLE_DECISION_NUMBER),
    ),
    sharedEcli: "ECLI:EU:C:2024:12",
  },
  legislation: {
    country: "cze",
    bucket: "00",
  },
} as const;

export type QueryPlanSeedResult = {
  caseLawSourceId: ReturnType<typeof createSafeId<"caseLawSource">>;
  sample: typeof QUERY_PLAN_SAMPLE;
};

type QueryPlanSeedDb = Pick<PgliteDatabase, "execute" | "insert">;

/** Seed physical, repeatable corpus rows for B1 query-plan contracts. */
export const seedQueryPlanData = async (
  db: QueryPlanSeedDb,
): Promise<QueryPlanSeedResult> => {
  const caseLawSourceId = createSafeId<"caseLawSource">();
  const legislationSourceId = createSafeId<"legislationSource">();

  await db.insert(caseLawSources).values(
    caseLawSourceRow({
      id: caseLawSourceId,
      adapterKey: "query-plan-seed-case-law",
      name: "Query plan seed case law",
    }),
  );

  await db.execute(sql`
    INSERT INTO ${caseLawDecisions}
      (id, source_id, case_number, court, country, language, ecli,
       language_group_key, decision_date, metadata, updated_at)
    SELECT
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      ${caseLawSourceId}::uuid,
      'qpg-case-' || n::text,
      'Query Plan Court ' || (n % 40)::text,
      CASE n % 3 WHEN 0 THEN 'CZE' WHEN 1 THEN 'SVK' ELSE 'POL' END,
      CASE ((n + 1) / 2) % 2 WHEN 0 THEN 'cs' ELSE 'en' END,
      CASE WHEN n % 7 = 0 THEN NULL
        ELSE 'ECLI:EU:C:2024:' || (n % 120)::text END,
      CASE WHEN n % 5 = 0 THEN NULL
        ELSE 'qpg-language-group-' || (n % 180)::text END,
      CASE WHEN n % 20 = 0 THEN NULL
        ELSE DATE '2010-01-01' + (n % 5800) END,
      '{}'::jsonb,
      TIMESTAMPTZ '2024-01-01 00:00:00+00' + n * INTERVAL '1 minute'
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawDecisionIdentifiers}
      (decision_id, type, value, normalized_value)
    SELECT
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      CASE n % 4
        WHEN 0 THEN ${DECISION_IDENTIFIER_TYPES.ECLI}
        WHEN 1 THEN ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
        WHEN 2 THEN ${DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION}
        ELSE ${DECISION_IDENTIFIER_TYPES.REPORTER_CITATION}
      END,
      CASE n % 4
        WHEN 0 THEN 'ECLI:EU:C:2024:' || (n % 120)::text
        WHEN 1 THEN 'qpg-case-' || n::text
        WHEN 2 THEN 'QPG ' || n::text || '/2024'
        ELSE (1000 + n)::text || ' QPG 1'
      END,
      CASE n % 4
        WHEN 0 THEN 'eclieuc2024' || (n % 120)::text
        WHEN 1 THEN 'qpgcase' || n::text
        WHEN 2 THEN 'qpg' || n::text || '2024'
        ELSE (1000 + n)::text || 'qpg1'
      END
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`VACUUM (ANALYZE) ${caseLawDecisions}`);
  await db.execute(sql`ANALYZE ${caseLawDecisionIdentifiers}`);
  await db.execute(sql`ANALYZE ${caseLawSources}`);

  await db.insert(legislationSources).values({
    id: legislationSourceId,
    adapterKey: "query-plan-seed-legislation",
    name: "Query plan seed legislation",
  });

  await db.execute(sql`
    INSERT INTO ${legislationDocuments}
      (id, source_id, eli, title, slug, country, language, updated_at)
    SELECT
      (${sql.raw(`'${LEGISLATION_DOCUMENT_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      ${legislationSourceId}::uuid,
      '/eli/cz/sb/2024/' || n::text,
      'Query Plan Act ' || n::text,
      'query-plan-act-' || n::text,
      CASE n % 3 WHEN 0 THEN 'CZE' WHEN 1 THEN 'SVK' ELSE 'POL' END,
      CASE n % 3 WHEN 0 THEN 'cs' WHEN 1 THEN 'sk' ELSE 'pl' END,
      TIMESTAMPTZ '2024-01-01 00:00:00+00' + n * INTERVAL '1 minute'
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);
  await db.execute(sql`ANALYZE ${legislationSources}`);

  await db.execute(sql`
    INSERT INTO ${caseLawCitations}
      (id, citing_decision_id, cited_decision_id, citation_text, citation_key)
    SELECT
      md5('qpg-citation-' || n::text)::uuid,
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad((n % ${QUERY_PLAN_ROW_COUNT} + 1)::text, 12, '0'))::uuid,
      'QPG citation ' || n::text,
      'qpg-key-' || (n % 120)::text
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawIndexJobs}
      (id, decision_id, generation, operation, status)
    SELECT
      md5('qpg-case-index-' || n::text)::uuid,
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      'case_law_v5', 'index', 'succeeded'
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawProvisionCitations}
      (id, decision_id, jurisdiction, work_identifier, work_number,
       work_year, work_collection, unit, section, anchor, decision_date,
       sentence_text, span_start, span_end, confidence)
    SELECT
      md5('qpg-provision-' || n::text)::uuid,
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      'cze', '/eli/cz/sb/2024/' || (n % 100 + 1)::text,
      n % 100 + 1, 2024, 'sb', 'section', n % 20 + 1,
      'section-' || (n % 20 + 1)::text,
      DATE '2024-01-01' + (n % 365),
      'Query plan provision citation', 0, 10, 0.9
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawProvisionExtractions}
      (decision_id, jurisdiction, desired_input_digest, lane)
    SELECT
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      'cze', decode(
        md5('qpg-extraction-' || n::text) ||
        md5('qpg-extraction-next-' || n::text), 'hex'
      ), 'backfill'
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
    ON CONFLICT (decision_id) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawStatuteCitationMemberships}
      (decision_id, source_id, jurisdiction, work_eli, target_type, anchor)
    SELECT
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      ${caseLawSourceId}::uuid, 'cze',
      '/eli/cz/sb/2024/' || (n % 100 + 1)::text, 'work', ''
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawSearchDocuments}
      (decision_id, title, searchable_text, language, tsv)
    SELECT
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      'Query Plan Case ' || n::text,
      'Query plan search text ' || n::text,
      CASE n % 3 WHEN 0 THEN 'cs' WHEN 1 THEN 'sk' ELSE 'pl' END,
      to_tsvector('simple', 'Query plan search text ' || n::text)
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${caseLawSearchDocumentPreviewPassages}
      (decision_id, generation, ordinal, content, tsv)
    SELECT
      (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      md5('qpg-preview-generation')::uuid, 0,
      'Query plan preview ' || n::text,
      to_tsvector('simple', 'Query plan preview ' || n::text)
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${corpusIndexGenerations}
      (family, generation, cluster, manifest_digest, status)
    VALUES
      ('case_law', 'case_law_v5', 'q09', repeat('a', 64), 'building'),
      ('legislation', 'legislation_v2', 'q09', repeat('b', 64), 'building')
  `);

  await db.execute(sql`
    INSERT INTO ${corpusIndexProjectionIntents}
      (id, family, generation, entity_id, epoch, fingerprint,
       index_id, status, cancelled_at)
    SELECT
      md5('qpg-intent-' || n::text)::uuid,
      CASE WHEN n % 2 = 0 THEN 'case_law' ELSE 'legislation' END,
      CASE WHEN n % 2 = 0 THEN 'case_law_v5' ELSE 'legislation_v2' END,
      CASE WHEN n % 2 = 0 THEN
        (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid
      ELSE
        (${sql.raw(`'${LEGISLATION_DOCUMENT_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid
      END,
      1, md5('qpg-fingerprint-' || n::text) || md5('qpg-fingerprint-' || n::text),
      'qpg_index', 'cancelled', TIMESTAMPTZ '2024-01-01 00:00:00+00'
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${corpusIndexProjectionStates}
      (family, generation, entity_id, desired_action, desired_epoch)
    SELECT
      CASE WHEN n % 2 = 0 THEN 'case_law' ELSE 'legislation' END,
      CASE WHEN n % 2 = 0 THEN 'case_law_v5' ELSE 'legislation_v2' END,
      CASE WHEN n % 2 = 0 THEN
        (${sql.raw(`'${DECISION_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid
      ELSE
        (${sql.raw(`'${LEGISLATION_DOCUMENT_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid
      END,
      'erase', 1
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${legislationIndexJobs}
      (id, document_id, generation, operation, status)
    SELECT
      md5('qpg-legislation-index-' || n::text)::uuid,
      (${sql.raw(`'${LEGISLATION_DOCUMENT_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      'legislation_v2', 'index', 'succeeded'
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  await db.execute(sql`
    INSERT INTO ${legislationSearchDocuments}
      (document_id, title, searchable_text, language, tsv)
    SELECT
      (${sql.raw(`'${LEGISLATION_DOCUMENT_ID_PREFIX}'`)} || lpad(n::text, 12, '0'))::uuid,
      'Query Plan Act ' || n::text,
      'Query plan legislation text ' || n::text,
      CASE n % 3 WHEN 0 THEN 'cs' WHEN 1 THEN 'sk' ELSE 'pl' END,
      to_tsvector('simple', 'Query plan legislation text ' || n::text)
    FROM generate_series(1, ${QUERY_PLAN_ROW_COUNT}) AS generated(n)
  `);

  for (const table of PLAN_GUARD_TABLES) {
    await db.execute(sql`ANALYZE ${sql.identifier(table)}`);
  }

  return { caseLawSourceId, sample: QUERY_PLAN_SAMPLE };
};
