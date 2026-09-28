import { sql } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

const QUERY_PLAN_ROW_COUNT = 3000;
const DECISION_ID_PREFIX = "00000000-0000-7000-8000-";
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

  return { caseLawSourceId, sample: QUERY_PLAN_SAMPLE };
};
