/**
 * Citation authority scoring for case law decisions.
 *
 * Combines three signals:
 * 1. Citation density — citations per year since publication
 * 2. Court-level weight — Supreme Court citations count more
 * 3. Recency decay — recent citations are stronger evidence
 *
 * The final score is log-scaled to prevent outliers from
 * dominating search results.
 */

import type {
  CourtWeightEntry,
  CourtWeightMap,
} from "@/api/handlers/case-law/court-weights";

// -- Legacy fallback tiers -----------------------------------------------

/**
 * Hardcoded fallback used when the database table has not
 * been seeded yet. Prefer `loadCourtWeights()` in production.
 */
const LEGACY_COURT_TIERS: CourtWeightEntry[] = [
  {
    weight: 4,
    tier: 4,
    tierLabel: "constitutional",
    pattern: /ústavní soud|ústavný súd/iu,
  },
  {
    weight: 3,
    tier: 3,
    tierLabel: "supreme",
    pattern: /nejvyšší|najvyšší/iu,
  },
  {
    weight: 2,
    tier: 2,
    tierLabel: "regional",
    pattern: /vrchní soud|krajský soud|městský soud|krajský súd/iu,
  },
];

const DEFAULT_WEIGHT = 1;

// -- Court weight lookup -------------------------------------------------

/**
 * Return the authority weight for a court name.
 *
 * When `weightMap` is provided, uses the database-driven
 * weights. Otherwise falls back to the legacy hardcoded list.
 */
export const courtWeight = (
  court: string,
  weightMap?: CourtWeightMap,
  country?: string,
): number => {
  if (weightMap) {
    // Check country-specific entries first.
    if (country) {
      const entries = weightMap.get(country);
      if (entries) {
        for (const e of entries) {
          if (e.pattern.test(court)) {
            return e.weight;
          }
        }
      }
    }
    // Fallback: check all countries.
    for (const entries of weightMap.values()) {
      for (const e of entries) {
        if (e.pattern.test(court)) {
          return e.weight;
        }
      }
    }
    return DEFAULT_WEIGHT;
  }

  // Legacy path (no map loaded).
  for (const tier of LEGACY_COURT_TIERS) {
    if (tier.pattern.test(court)) {
      return tier.weight;
    }
  }
  return DEFAULT_WEIGHT;
};

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

  const yearsAgo =
    (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  return 1 / (1 + Math.max(yearsAgo, 0));
};

// -- Combined score ------------------------------------------------------

type CitationInput = {
  citingCourt: string;
  citingDate: Date | string | null;
};

/**
 * Compute the weighted citation sum for a single decision.
 * Each citation contributes:
 *
 *   courtWeight(citingCourt) * recencyFactor(citingDate)
 */
export const weightedCitationSum = (
  citations: CitationInput[],
  now: Date = new Date(),
  weightMap?: CourtWeightMap,
): number => {
  let sum = 0;
  for (const c of citations) {
    sum +=
      courtWeight(c.citingCourt, weightMap) * recencyFactor(c.citingDate, now);
  }
  return sum;
};

/**
 * Full citation authority score for a decision.
 *
 *   density = weightedSum / max(yearsSinceDecision, 1)
 *   score   = ln(1 + density)
 *
 * Returns a non-negative float. Zero means no citations.
 */
export const citationScore = (
  citations: CitationInput[],
  decisionDate: Date | string | null,
  now: Date = new Date(),
  weightMap?: CourtWeightMap,
): number => {
  if (citations.length === 0) {
    return 0;
  }

  const wSum = weightedCitationSum(citations, now, weightMap);

  let yearsOld = 1;
  if (decisionDate !== null) {
    const d =
      typeof decisionDate === "string" ? new Date(decisionDate) : decisionDate;
    yearsOld = Math.max(
      (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
      1,
    );
  }

  return Math.log(1 + wSum / yearsOld);
};

// -- SQL fragments -------------------------------------------------------

/**
 * Build a SQL CASE expression for court weights.
 *
 * When `entries` is provided, generates from database-driven
 * weights. Otherwise uses the legacy hardcoded list.
 */
export const courtWeightSql = (
  courtColumn: string,
  entries?: CourtWeightEntry[],
): string => {
  const source = entries ?? LEGACY_COURT_TIERS;

  const cases = source
    .map((e) => {
      const src = e.pattern.source.replace(/'/gu, "''");
      return `WHEN ${courtColumn} ~* '${src}' THEN ${e.weight}`;
    })
    .join("\n      ");

  return `CASE ${cases}\n      ELSE ${DEFAULT_WEIGHT} END`;
};
