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

// -- Court hierarchy tiers -------------------------------------------

/**
 * Court tier weights in general. Higher = more authoritative.
 *
 * Tier 4: Constitutional courts
 * Tier 3: Supreme courts
 * Tier 2: High/regional courts
 * Tier 1: District courts
 */
const COURT_TIERS = [
  { weight: 4, patterns: [/ústavní soud/i, /ústavný súd/i] },
  {
    weight: 3,
    patterns: [/nejvyšší/i, /najvyšší/i],
  },
  {
    weight: 2,
    patterns: [
      /vrchní soud/i,
      /krajský soud/i,
      /městský soud/i,
      /krajský súd/i,
    ],
  },
] as const;

const DEFAULT_WEIGHT = 1;

/**
 * Return the authority weight for a court name.
 * Matches against known patterns; defaults to 1.
 */
export const courtWeight = (court: string): number => {
  for (const tier of COURT_TIERS) {
    if (tier.patterns.some((p) => p.test(court))) {
      return tier.weight;
    }
  }
  return DEFAULT_WEIGHT;
};

// -- Recency decay ---------------------------------------------------

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
  if (citingDate === undefined || citingDate === null) {
    return 0.5; // Unknown date → half weight
  }

  const d = typeof citingDate === "string" ? new Date(citingDate) : citingDate;

  const yearsAgo =
    (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);

  return 1 / (1 + Math.max(yearsAgo, 0));
};

// -- Combined score --------------------------------------------------

export type CitationInput = {
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
): number => {
  let sum = 0;
  for (const c of citations) {
    sum += courtWeight(c.citingCourt) * recencyFactor(c.citingDate, now);
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
): number => {
  if (citations.length === 0) {
    return 0;
  }

  const wSum = weightedCitationSum(citations, now);

  let yearsOld = 1;
  if (decisionDate !== undefined && decisionDate !== null) {
    const d =
      typeof decisionDate === "string" ? new Date(decisionDate) : decisionDate;
    yearsOld = Math.max(
      (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000),
      1,
    );
  }

  return Math.log(1 + wSum / yearsOld);
};

// -- SQL fragments ---------------------------------------------------

/**
 * Build a SQL CASE expression for court weights.
 * Used in the search query to mirror courtWeight() in SQL.
 */
export const courtWeightSql = (courtColumn: string): string => {
  const cases = COURT_TIERS.map((tier) => {
    const conditions = tier.patterns
      .map((p) => {
        const src = p.source.replace(/'/g, "''");
        return `${courtColumn} ~* '${src}'`;
      })
      .join(" OR ");
    return `WHEN ${conditions} THEN ${tier.weight}`;
  }).join("\n      ");

  return `CASE ${cases}\n      ELSE ${DEFAULT_WEIGHT} END`;
};
