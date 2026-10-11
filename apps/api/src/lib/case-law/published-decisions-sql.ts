import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  storedObservationHasDetail,
  storedObservationHasDetailSqlFor,
} from "@/api/lib/legal-search/partial-observation-sql";

type DecisionPublicationColumns = {
  metadata: Column;
  redactedAt: Column;
};

export const publishedCaseLawDecisionFor = (
  decision: DecisionPublicationColumns,
): SQL =>
  sql`(${decision.redactedAt} IS NULL AND ${storedObservationHasDetail(decision.metadata)})`;

/** The alias is a code-owned identifier. */
export const publishedCaseLawDecisionSqlFor = (alias: string): string =>
  `(${alias}.redacted_at IS NULL AND ${storedObservationHasDetailSqlFor(`${alias}.metadata`)})`;

/** Database materializers use the same rendered policy as public reads. */
export const caseLawPublicationFunctionSql =
  (): string => `CREATE OR REPLACE FUNCTION "case_law_statute_citation_is_published"(metadata jsonb, redacted_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ${publishedCaseLawDecisionSqlFor("decision")}
FROM (SELECT metadata, redacted_at) decision $$;`;
