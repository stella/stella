import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

import { RAW_SOURCE_FAMILY } from "@/api/lib/legal-search/raw-source-family";

type LegacyReferenceColumns = {
  decisionId: SQLWrapper;
  redactedAt: SQLWrapper;
  sourceId: SQLWrapper;
  sourceRawS3Key: SQLWrapper;
};

const CASE_LAW_RAW_PREFIX_SQL = sql.raw(`'${RAW_SOURCE_FAMILY.CASE_LAW}/raw/'`);

/** Matches a live row whose pointer is outside its own document prefix. */
// sql-perf-allow: index case_law_decisions_live_legacy_raw_source_idx contains matching live pointers
export const liveCaseLawLegacyReferenceSql = ({
  decisionId,
  redactedAt,
  sourceId,
  sourceRawS3Key,
}: LegacyReferenceColumns) => sql`
  ${redactedAt} IS NULL
  AND ${sourceRawS3Key} IS NOT NULL
  AND ${sourceRawS3Key} NOT LIKE (
    ${CASE_LAW_RAW_PREFIX_SQL} || ${sourceId}::text || '/documents/' || ${decisionId}::text || '/%'
  )
`;
