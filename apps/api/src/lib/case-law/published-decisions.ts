/**
 * The publication gate for a decision row, beside the redistribution gate its
 * source carries.
 *
 * A listing-only row is one the publisher listed and then would not serve: the
 * identity is real, the document is not there, and the date, the author and
 * the ECLI are usually absent with it. Rule 20 of the case-law guide keeps
 * that identity durable so a later observation can enrich the same row instead
 * of leaving a hole or minting a duplicate. Durable is not published: search,
 * browse, the latest shelf, the corpus projection and the sitemaps exclude it,
 * and it becomes public when a later observation carries its detail.
 *
 * One predicate, three spellings, because the public reads are written three
 * ways: Drizzle conditions on the table, Drizzle conditions on an alias of it,
 * and raw laterals. All three come from `storedObservationHasDetail`, which
 * owns where the marker is stored.
 */
import type { SQL } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import { publishedCaseLawDecisionFor } from "@/api/lib/case-law/published-decisions-sql";

export {
  publishedCaseLawDecisionFor,
  publishedCaseLawDecisionSqlFor,
} from "@/api/lib/case-law/published-decisions-sql";

/** For a query selecting from `case_law_decisions` under Drizzle's own name. */
export const publishedCaseLawDecision: SQL = publishedCaseLawDecisionFor(
  caseLawDecisions.metadata,
);
