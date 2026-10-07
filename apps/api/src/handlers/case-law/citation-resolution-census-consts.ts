/**
 * Closed vocabularies of the citation-resolution census, kept apart from
 * the census itself so the schema can declare its CHECKs from them without
 * importing the module that reads the schema.
 */

import { CITATION_RESOLUTION_RULES } from "@/api/handlers/case-law/citation-resolution-status";

/**
 * Shapes of an ambiguous key's bounded candidate set, shared with the schema.
 */
export const CITATION_AMBIGUITY_SHAPES = [
  "at-cap",
  "cross-court",
  "untyped",
  "one-file-merits",
  "orders-only",
  "merits-only",
  "other",
] as const;

/** Which population a census row counts. */
export const CITATION_CENSUS_ROW_KINDS = ["status", "rule", "shape"] as const;

/**
 * The rule buckets a census reports resolved citations under: every rule,
 * plus the rows resolved before rules were recorded. Those rows are not
 * revisited by the resolver, so without a bucket of their own they would be
 * missing from every rule count for as long as the database lives.
 */
const CITATION_CENSUS_UNATTRIBUTED_RULE = "unattributed" as const;

export const CITATION_CENSUS_RULE_BUCKETS = [
  ...CITATION_RESOLUTION_RULES,
  CITATION_CENSUS_UNATTRIBUTED_RULE,
] as const;

/**
 * Where a run stands. A run walks two populations in order, each in bounded
 * batches: first every precedent citation for its status and rule counts,
 * then every ambiguous key for its shape. Both walks read only rows whose
 * last resolution attempt is not after the run's `started_at`; rows settled
 * later belong to the next run, so the two walks count one population.
 */
export const CITATION_CENSUS_RUN_STATUSES = [
  "scanning-baseline",
  "scanning-shapes",
  "complete",
] as const;
