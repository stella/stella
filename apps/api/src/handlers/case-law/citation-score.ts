/**
 * Citation authority scoring for case law decisions.
 *
 * Every incoming citation is weighted by three signals:
 * 1. Polarity — a citation classified as negative treatment confers no
 *    authority (weight 0); every other reading, including unclassified,
 *    counts in full
 * 2. Court-level weight — Supreme Court citations count more
 * 3. Recency decay — recent citations are stronger evidence
 *
 * Their sum is log-scaled to prevent outliers from dominating search results.
 *
 * The cited decision's own age is deliberately not part of this. The score
 * used to be a density — the weighted sum divided by the years since
 * publication — which charged recency twice: the citing-side decay already
 * says whether a decision is still being cited, and a decision nobody cites
 * any more decays through that term alone. Dividing again only penalized
 * decisions for having been available to be cited, so the divisor buried
 * landmark decisions under recent ones. Under the density, 200 citations
 * spread over 20 years scored 1.03 while 8 citations from the past year
 * scored 1.61; on the weighted sum alone the same two score 3.61 and 2.20.
 */

import { DAY_IN_MS } from "@stll/time";

import { courtWeightFromMap } from "@/api/handlers/case-law/court-weights";
import type {
  CourtWeightEntry,
  CourtWeightMap,
} from "@/api/handlers/case-law/court-weights";
import {
  POLARITY,
  POLARITY_AUTHORITY_WEIGHT,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";

/** Average (Julian) year, used for citation-age decay. A duration. */
const MS_PER_YEAR = 365.25 * DAY_IN_MS;

const DEFAULT_WEIGHT = 1;

// -- Court weight lookup -------------------------------------------------

/**
 * The authority weight of a court name under the seeded weights: the given
 * country's entries first, then any country's, else the default. The map is
 * the database's; there is no built-in list to fall back to.
 */
export const courtWeight = (
  court: string,
  weightMap: CourtWeightMap,
  country?: string,
): number => courtWeightFromMap(weightMap, court, country).weight;

// -- Recency decay -------------------------------------------------------

/**
 * Decay factor for a citation based on how old the *citing*
 * decision is. A citation from today has weight 1; a citation
 * from 10 years ago has weight ~0.09.
 *
 *   factor = 1 / (1 + yearsSinceCitation)
 *
 * This is a hyperbolic decay — gentler than exponential,
 * so old citations still contribute, just less.
 */
export const recencyFactor = (
  citingDate: Date | string | null,
  now: Date = new Date(),
): number => {
  if (citingDate === null) {
    return 0.5; // Unknown date → half weight
  }

  const d = typeof citingDate === "string" ? new Date(citingDate) : citingDate;

  const yearsAgo = (now.getTime() - d.getTime()) / MS_PER_YEAR;

  return 1 / (1 + Math.max(yearsAgo, 0));
};

// -- Combined score ------------------------------------------------------

/**
 * Authority weight for a citation's polarity. An unclassified citation (null)
 * weighs the same as `unknown`, which is what keeps the score from moving as
 * classification coverage grows rather than as the case law changes.
 */
export const polarityWeight = (polarity: Polarity | null): number =>
  POLARITY_AUTHORITY_WEIGHT[polarity ?? POLARITY.UNKNOWN];

/** One incoming citation, as the score reads it. */
export type CitationInput = {
  citingCourt: string;
  citingDate: Date | string | null;
  /** Null while the citation has not been classified. */
  polarity?: Polarity | null;
};

/**
 * Compute the weighted citation sum for a single decision.
 * Each citation contributes:
 *
 *   polarityWeight(polarity)
 *     * courtWeight(citingCourt)
 *     * recencyFactor(citingDate)
 *
 * A negative treatment therefore adds nothing: the court that overruled or
 * distinguished the decision is not vouching for it. It is still a citation
 * everywhere else — `citation_count` and the citator both keep it.
 */
export const weightedCitationSum = (
  citations: CitationInput[],
  now: Date,
  weightMap: CourtWeightMap,
): number => {
  let sum = 0;
  for (const c of citations) {
    sum +=
      polarityWeight(c.polarity ?? null) *
      courtWeight(c.citingCourt, weightMap) *
      recencyFactor(c.citingDate, now);
  }
  return sum;
};

/**
 * Full citation authority score for a decision.
 *
 *   score = ln(1 + weightedSum)
 *
 * Returns a non-negative float. Zero means no citations.
 */
export const citationScore = (
  citations: CitationInput[],
  now: Date,
  weightMap: CourtWeightMap,
): number => Math.log(1 + weightedCitationSum(citations, now, weightMap));

// -- SQL fragments -------------------------------------------------------

/**
 * The SQL twin of `polarityWeight()`, rendered from the same map so a new
 * polarity cannot reach the database with no weight decided for it. NULL
 * falls to the ELSE branch, which is `unknown`'s weight by construction.
 */
export const polarityWeightSql = (polarityColumn: string): string => {
  const cases = Object.entries(POLARITY_AUTHORITY_WEIGHT)
    .filter(([polarity]) => polarity !== POLARITY.UNKNOWN)
    .map(
      ([polarity, weight]) =>
        `WHEN ${polarityColumn} = '${polarity}' THEN ${weight}`,
    )
    .join("\n      ");

  return `CASE ${cases}\n      ELSE ${POLARITY_AUTHORITY_WEIGHT[POLARITY.UNKNOWN]} END`;
};

/**
 * The SQL CASE expression for court weights, rendered from the seeded
 * entries (highest tier first, so the first matching branch is the rank).
 * No entries renders a bare `ELSE`: every court weighs the default.
 */
export const courtWeightSql = (
  courtColumn: string,
  entries: readonly CourtWeightEntry[],
): string => {
  const cases = entries
    .map((e) => {
      const src = e.pattern.source.replace(/'/gu, "''");
      return `WHEN ${courtColumn} ~* '${src}' THEN ${e.weight}`;
    })
    .join("\n      ");

  return `CASE ${cases}\n      ELSE ${DEFAULT_WEIGHT} END`;
};
