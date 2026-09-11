import { eq, sql } from "drizzle-orm";

import {
  caseLawStatuteCitationCountState,
  legislationDocuments,
  STATUTE_CITATION_COUNT_STATE_KEY,
  STATUTE_CITATION_COUNT_STATUS,
  STATUTE_CITATION_TARGET_TYPE,
} from "@/api/db/schema";
import { redistributableCaseLawSourceSqlFor } from "@/api/lib/case-law/redistribution-sql";

const COUNT_ALIAS = "statute_citation_count";
const SOURCE_ALIAS = "statute_citation_source";

export const statuteCitationCaseCount = sql<number | null>`CASE
  WHEN ${caseLawStatuteCitationCountState.status} = ${STATUTE_CITATION_COUNT_STATUS.READY}
  THEN coalesce((
    SELECT sum(${sql.raw(COUNT_ALIAS)}.decision_count)::integer
    FROM case_law_statute_citation_counts AS ${sql.raw(COUNT_ALIAS)}
    INNER JOIN case_law_sources AS ${sql.raw(SOURCE_ALIAS)}
      ON ${sql.raw(SOURCE_ALIAS)}.id = ${sql.raw(COUNT_ALIAS)}.source_id
    WHERE ${sql.raw(COUNT_ALIAS)}.jurisdiction = ${legislationDocuments.country}
      AND ${sql.raw(COUNT_ALIAS)}.work_eli = ${legislationDocuments.eli}
      AND ${sql.raw(COUNT_ALIAS)}.target_type = ${STATUTE_CITATION_TARGET_TYPE.WORK}
      AND ${sql.raw(COUNT_ALIAS)}.anchor = ''
      AND ${sql.raw(redistributableCaseLawSourceSqlFor(SOURCE_ALIAS))}
  ), 0)
  ELSE NULL
END`;

export const statuteCitationCountStateJoin = eq(
  caseLawStatuteCitationCountState.key,
  STATUTE_CITATION_COUNT_STATE_KEY,
);
