// parser-output-unchanged: Database publication predicates reached through schema imports do not change adapter parsing or emitted document content.
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

export const unredactedCaseLawDecisionFor = (
  decision: Pick<DecisionPublicationColumns, "redactedAt">,
): SQL => sql`${decision.redactedAt} IS NULL`;

export const publishedCaseLawDecisionFor = (
  decision: DecisionPublicationColumns,
): SQL =>
  sql`(${unredactedCaseLawDecisionFor(decision)} AND ${storedObservationHasDetail(decision.metadata)})`;

type PublishedCaseLawDecisionPredicateOptions = {
  redactedAtColumn: string;
  metadataColumn: string;
};

const publishedCaseLawDecisionPredicateSqlFor = ({
  redactedAtColumn,
  metadataColumn,
}: PublishedCaseLawDecisionPredicateOptions): string =>
  `(${redactedAtColumn} IS NULL AND ${storedObservationHasDetailSqlFor(metadataColumn)})`;

/** The alias is a code-owned identifier. */
export const publishedCaseLawDecisionSqlFor = (alias: string): string =>
  publishedCaseLawDecisionPredicateSqlFor({
    redactedAtColumn: `${alias}.redacted_at`,
    metadataColumn: `${alias}.metadata`,
  });

/** The same publication gate, unqualified for a case-law index predicate. */
export const publishedCaseLawDecisionIndexPredicateSql = (): string =>
  publishedCaseLawDecisionPredicateSqlFor({
    redactedAtColumn: "redacted_at",
    metadataColumn: "metadata",
  });

/** PostgreSQL's normalized form used to verify the online index definition. */
export const publishedCaseLawDecisionIndexDefinitionPredicateSql = (): string =>
  `${publishedCaseLawDecisionIndexPredicateSql()
    .replaceAll(/'([^']*)'/gu, "'$1'::text")
    .replace(
      /jsonb_extract_path_text\(([^,]+), ([^)]+)\)/u,
      "jsonb_extract_path_text($1, VARIADIC ARRAY[$2])",
    )
    .replace("(", "((")
    .replace(" IS NULL AND ", " IS NULL) AND (")
    .replace(" is distinct from ", " IS DISTINCT FROM ")})`;

/** Database materializers use the same rendered policy as public reads. */
export const caseLawPublicationFunctionSql =
  (): string => `CREATE OR REPLACE FUNCTION "case_law_statute_citation_is_published"(metadata jsonb, redacted_at timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$ SELECT ${publishedCaseLawDecisionSqlFor("decision")}
FROM (SELECT metadata, redacted_at) decision $$;`;
