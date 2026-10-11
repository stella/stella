// parser-output-unchanged: Publication predicates serve database reads and indexes; parsed decision output is unchanged.
import { panic } from "better-result";
import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  storedObservationHasDetail,
  storedObservationHasDetailSqlFor,
} from "@/api/lib/legal-search/partial-observation-sql";
import type { LegalSearchEngine } from "@/api/lib/legal-search/types";

/** Leaf publication owner shared by reads and partial indexes without importing the schema. */
export const publishedCaseLawDecisionFor = storedObservationHasDetail;

/** The alias is a code constant, never request input. */
export const publishedCaseLawDecisionSqlFor = (alias: string): string =>
  storedObservationHasDetailSqlFor(`${alias}.metadata`);

/** Coverage bounds describe published dates whose decisions have not been withdrawn. */
export const publishedUnredactedCaseLawDecisionFor = (decision: {
  metadata: Column;
  redactedAt: Column;
}): SQL =>
  sql`(${decision.redactedAt} IS NULL AND ${publishedCaseLawDecisionFor(decision.metadata)})`;

/** Raw spelling of the same coverage predicate for a code-owned alias. */
export const publishedUnredactedCaseLawDecisionSqlFor = (
  alias: string,
): string =>
  `(${alias}.redacted_at IS NULL AND ${publishedCaseLawDecisionSqlFor(alias)})`;

/** Exact SQL eligibility for the serving provider; null when it cannot be read in SQL. */
export const servedCaseLawDecisionFor = (
  alias: string,
  engine: LegalSearchEngine,
): SQL | null => {
  switch (engine) {
    case "pg-fts":
      return sql`(${sql.raw(publishedUnredactedCaseLawDecisionSqlFor(alias))} AND EXISTS (
        SELECT 1 FROM case_law_search_documents AS serving_document
        WHERE serving_document.decision_id = ${sql.identifier(alias)}.id
      ))`;
    case "corpus-index":
      return null;
    default:
      engine satisfies never;
      return panic("Unhandled serving provider");
  }
};
