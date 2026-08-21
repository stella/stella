/**
 * Dormant closed vocabularies of the citation-resolution census, kept apart from
 * the census itself so the schema can declare its CHECKs from them without
 * importing the module that reads the schema.
 */

import {
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_RULES,
  type CitationResolutionRule,
} from "@/api/handlers/case-law/citation-resolution-status";
import type { ConstantMap } from "@/api/lib/constant-map";

/**
 * What an ambiguous key's bounded candidate set looks like. The list is the
 * taxonomy: a shape added here without a disposition below fails typecheck,
 * and the classifier's CASE is generated from the same names.
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

export type CitationAmbiguityShape = (typeof CITATION_AMBIGUITY_SHAPES)[number];

export const CITATION_AMBIGUITY_SHAPE = {
  /** As many holders as the resolver reads: the set may be truncated. */
  AT_CAP: "at-cap",
  /** Holders at more than one court: the same number means different files. */
  CROSS_COURT: "cross-court",
  /** A holder with no recorded decision type, so the file cannot be read. */
  UNTYPED: "untyped",
  /** One merits decision among procedural orders, at one court. */
  ONE_FILE_MERITS: "one-file-merits",
  /** Procedural orders only. */
  ORDERS_ONLY: "orders-only",
  /** Two or more merits decisions under one number. */
  MERITS_ONLY: "merits-only",
  /** Anything else, including a key whose holders have since shrunk. */
  OTHER: "other",
} as const satisfies ConstantMap<CitationAmbiguityShape>;

/**
 * What a shape means for the resolver: a rule already claims it (the rows
 * are backlog the rule settles once its preconditions hold), the scan bound
 * produced it, or no rule speaks to it.
 */
export type CitationAmbiguityShapeDisposition =
  | { kind: "ruled"; rule: CitationResolutionRule }
  | { kind: "bounded" }
  | { kind: "unruled" };

export const CITATION_AMBIGUITY_SHAPE_DISPOSITION = {
  [CITATION_AMBIGUITY_SHAPE.AT_CAP]: { kind: "bounded" },
  [CITATION_AMBIGUITY_SHAPE.CROSS_COURT]: { kind: "unruled" },
  [CITATION_AMBIGUITY_SHAPE.UNTYPED]: { kind: "unruled" },
  [CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS]: {
    kind: "ruled",
    rule: CITATION_RESOLUTION_RULE.ONE_FILE_MERITS,
  },
  [CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY]: { kind: "unruled" },
  [CITATION_AMBIGUITY_SHAPE.MERITS_ONLY]: { kind: "unruled" },
  [CITATION_AMBIGUITY_SHAPE.OTHER]: { kind: "unruled" },
} as const satisfies Record<
  CitationAmbiguityShape,
  CitationAmbiguityShapeDisposition
>;

/** Which population a census row counts. */
export const CITATION_CENSUS_ROW_KINDS = ["status", "rule", "shape"] as const;

export type CitationCensusRowKind = (typeof CITATION_CENSUS_ROW_KINDS)[number];

export const CITATION_CENSUS_ROW_KIND = {
  /** Precedent citations by `resolution_status`. */
  STATUS: "status",
  /** Resolved precedent citations by the rule that linked them. */
  RULE: "rule",
  /** Ambiguous precedent citations by the shape of their key's holders. */
  SHAPE: "shape",
} as const satisfies ConstantMap<CitationCensusRowKind>;

/**
 * The rule buckets a census reports resolved citations under: every rule,
 * plus the rows resolved before rules were recorded. Those rows are not
 * revisited by the resolver, so without a bucket of their own they would be
 * missing from every rule count for as long as the database lives.
 */
export const CITATION_CENSUS_UNATTRIBUTED_RULE = "unattributed" as const;

export const CITATION_CENSUS_RULE_BUCKETS = [
  ...CITATION_RESOLUTION_RULES,
  CITATION_CENSUS_UNATTRIBUTED_RULE,
] as const;

export type CitationCensusRuleBucket =
  (typeof CITATION_CENSUS_RULE_BUCKETS)[number];

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

export type CitationCensusRunStatus =
  (typeof CITATION_CENSUS_RUN_STATUSES)[number];

export const CITATION_CENSUS_RUN_STATUS = {
  /** Walking precedent citations for status and rule counts. */
  SCANNING_BASELINE: "scanning-baseline",
  /** Walking ambiguous keys for their shapes. */
  SCANNING_SHAPES: "scanning-shapes",
  /** Both walks reached the end. */
  COMPLETE: "complete",
} as const satisfies ConstantMap<CitationCensusRunStatus>;
