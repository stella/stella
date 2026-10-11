// parser-output-unchanged: Publication predicates serve database reads and indexes; parsed decision output is unchanged.
import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import {
  storedObservationHasDetail,
  storedObservationHasDetailSqlFor,
} from "@/api/lib/legal-search/partial-observation-sql";

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
