/**
 * Two-stage retrieve-then-rerank: the engine returns lexical (BM25)
 * candidates; the API blends in the precomputed citation authority.
 * corpus index cannot express this blend in-engine (no function_score), so
 * it lives here.
 *
 * `rrfMerge` fuses several lexical candidate lists (the AI query planner
 * issues multiple searches). `blendCitationAuthority` combines a single
 * fused lexical signal with citation authority.
 *
 * Everything the blend adds on top of the lexical score is a `BlendSignal`:
 * a weight and a per-candidate value in [0, 1]. Citation authority is one;
 * the court a decision comes from is another. Sum of the weights is
 * therefore the whole of the non-lexical side, which is what lets
 * `stableBlendUpperBound` stop a paginated scan without reading the corpus.
 */

import { panic } from "better-result";

export type ScoredCandidate = {
  id: string;
  /** Lexical relevance (BM25, or a fused RRF score). Higher is better. */
  score: number;
};

export type RankedHit = {
  id: string;
  /** Final blended score; the cursor sort key. */
  score: number;
  lexicalScore: number;
  citationAuthority: number;
};

const DEFAULT_RRF_K = 60;
/**
 * Default weight on the authority term. Exported because the Postgres
 * ranking paths blend in SQL and must not retype it.
 */
export const DEFAULT_AUTHORITY_WEIGHT = 0.3;

/**
 * Half-saturation point of the log-scaled citation authority: the authority
 * value at which the signal contributes half of `weight`, i.e. half of all it
 * can ever contribute. Authority is already `ln(1 + weightedCitationSum)`, so
 * 1 is roughly a decision with a couple of recent higher-court citations.
 *
 * A tuning constant, not a law: move it with relevance judgments, which is
 * also the only thing that can say whether it is in the right place.
 */
export const AUTHORITY_PIVOT = 1;

/**
 * Map citation authority onto [0, 1) on an absolute scale:
 *
 *   saturate(a) = a / (a + AUTHORITY_PIVOT)
 *
 * Monotone, bounded, and independent of every other candidate — a decision's
 * authority contribution is a property of the decision, not of the page it
 * lands on. Negative authority is not representable in the corpus; clamping
 * keeps a corrupt row from inverting the signal.
 */
export const saturateAuthority = (authority: number): number => {
  const bounded = Math.max(authority, 0);
  return bounded / (bounded + AUTHORITY_PIVOT);
};

/**
 * The court tiers the weight registry assigns: 1 for a court no pattern
 * matches, up to 4 for a constitutional court. `court-weight-seed.test.ts`
 * holds the seeded registry to this range, so the two cannot drift apart.
 */
export const LOWEST_COURT_TIER = 1;
export const HIGHEST_COURT_TIER = 4;

/**
 * Map a court tier onto [0, 1]:
 *
 *   courtTierValue(t) = (t - 1) / 3
 *
 * The tier every unmatched court falls back to contributes nothing, an apex
 * court contributes the whole weight, and the ranks between are evenly
 * spaced. Clamping keeps a registry row outside the seeded range from
 * breaking the bound the pagination early-stop reads.
 */
export const courtTierValue = (tier: number): number => {
  const bounded = Math.min(
    Math.max(tier, LOWEST_COURT_TIER),
    HIGHEST_COURT_TIER,
  );
  return (
    (bounded - LOWEST_COURT_TIER) / (HIGHEST_COURT_TIER - LOWEST_COURT_TIER)
  );
};

/**
 * Default weight on the court-tier term: how far up the ranking an apex
 * court can carry a decision the lexical side placed lower.
 *
 * A tuning constant, like `AUTHORITY_PIVOT`. Relevance measurements move it,
 * and those are kept outside this repository.
 */
export const DEFAULT_COURT_TIER_WEIGHT = 0.2;

/**
 * One additive term of the blend: a weight, and the candidate's value on that
 * term already mapped onto [0, 1]. Bounding every value is what makes the sum
 * of the weights the whole of what the non-lexical side can add, which is
 * what `stableBlendUpperBound` reads.
 */
export type BlendSignal = {
  /** Identifies the term when its value escapes [0, 1]. */
  name: string;
  weight: number;
  /** An id the caller knows nothing about scores at the bottom of the range. */
  valueFor: (candidateId: string) => number;
};

/** How much a decision is cited, saturated onto an absolute scale. */
const citationAuthoritySignal = (
  authorityById: ReadonlyMap<string, number>,
  weight: number,
): BlendSignal => ({
  name: "citation-authority",
  weight,
  valueFor: (candidateId) =>
    saturateAuthority(authorityById.get(candidateId) ?? 0),
});

/**
 * How high the deciding court sits in its jurisdiction. Unlike citation
 * authority this is known the day a decision is published, so it is what
 * carries a fresh apex judgment nothing has cited yet.
 */
export const courtTierSignal = (
  tierById: ReadonlyMap<string, number>,
): BlendSignal => ({
  name: "court-tier",
  weight: DEFAULT_COURT_TIER_WEIGHT,
  valueFor: (candidateId) =>
    courtTierValue(tierById.get(candidateId) ?? LOWEST_COURT_TIER),
});

/**
 * Sum of `weight * value` over the blend's signals. The pagination bound is
 * the summed weight and nothing else, so it holds only while every weight is
 * finite and non-negative and every value lands in [0, 1]. A negative weight
 * would subtract from a score the bound assumes it can only add to, and a
 * non-finite one makes the bound meaningless: both are programmer errors, not
 * something to quietly clamp here.
 */
const addedBySignals = (
  signals: readonly BlendSignal[],
  candidateId: string,
): number => {
  let added = 0;
  for (const signal of signals) {
    if (!Number.isFinite(signal.weight) || signal.weight < 0) {
      panic(
        `Blend signal ${signal.name} weighs ${signal.weight}, which is not a finite non-negative number`,
      );
    }
    const value = signal.valueFor(candidateId);
    if (!(value >= 0 && value <= 1)) {
      panic(`Blend signal ${signal.name} produced ${value}, outside [0, 1]`);
    }
    added += signal.weight * value;
  }
  return added;
};

/** Larger id first — deterministic, keyset-cursor-stable tiebreak. */
const byScoreThenId = (
  a: { id: string; score: number },
  b: { id: string; score: number },
): number => {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
};

/**
 * Reciprocal Rank Fusion. Each input list must be sorted best-first.
 * An item appearing high across many lists outranks one appearing high
 * in a single list. Scale-free, so it needs no score normalization.
 */
export const rrfMerge = (
  lists: readonly (readonly ScoredCandidate[])[],
  k: number = DEFAULT_RRF_K,
): Map<string, number> => {
  const fused = new Map<string, number>();
  for (const list of lists) {
    for (const [rank, candidate] of list.entries()) {
      const contribution = 1 / (k + rank + 1);
      fused.set(candidate.id, (fused.get(candidate.id) ?? 0) + contribution);
    }
  }
  return fused;
};

/** Min-max normalize to [0, 1]; all-equal collapses to 0 (no signal). */
const normalize = (values: readonly number[]): number[] => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range <= 0) {
    return values.map(() => 0);
  }
  return values.map((v) => (v - min) / range);
};

type BlendOptions = {
  candidates: readonly ScoredCandidate[];
  authorityById: ReadonlyMap<string, number>;
  /** How much citation authority moves results vs lexical relevance. */
  weight?: number;
};

/**
 * Blend lexical relevance with citation authority:
 *
 *   blended = minMax(lexical) + weight * saturate(authority)
 *
 * The lexical side is min-max normalized because BM25's scale is unbounded
 * and query-dependent, so it is only comparable within one result set.
 * Authority is not: it is a static, log-scaled property of the decision, and
 * min-max normalizing it made a decision's contribution depend on which other
 * candidates happened to share its page — the same decision scoring 1.0 next
 * to unremarkable neighbours and 0.01 next to one landmark. Search engines
 * bound static signals on an absolute scale for exactly this reason, which is
 * what `saturateAuthority` is. Equal lexical scores let authority decide;
 * ties break deterministically by id for cursor stability.
 */
export const blendCitationAuthority = ({
  candidates,
  authorityById,
  weight = DEFAULT_AUTHORITY_WEIGHT,
}: BlendOptions): RankedHit[] => {
  if (candidates.length === 0) {
    return [];
  }

  const scored = candidates.map((c) => ({
    id: c.id,
    lexical: c.score,
    authority: authorityById.get(c.id) ?? 0,
  }));
  const lexicalNorm = normalize(scored.map((s) => s.lexical));

  const hits = scored.map((s, i) => ({
    id: s.id,
    score: (lexicalNorm[i] ?? 0) + weight * saturateAuthority(s.authority),
    lexicalScore: s.lexical,
    citationAuthority: s.authority,
  }));

  hits.sort(byScoreThenId);
  return hits;
};

type StableBlendOptions = {
  candidates: readonly ScoredCandidate[];
  authorityById: ReadonlyMap<string, number>;
  /** How much citation authority moves results vs lexical relevance. */
  weight?: number;
  /** Additive signals the caller blends alongside citation authority. */
  signals?: readonly BlendSignal[];
};

/**
 * Every term the stable blend adds on top of the lexical score: the citation
 * authority it always carries, then the caller's own signals. Their summed
 * weight is what `stableBlendUpperBound` must be given.
 */
const stableBlendSignals = (
  authorityById: ReadonlyMap<string, number>,
  weight: number,
  signals: readonly BlendSignal[],
): BlendSignal[] => [
  citationAuthoritySignal(authorityById, weight),
  ...signals,
];

/**
 * Highest blended score any not-yet-scanned candidate could reach under
 * blendStableCitationAuthority, given the next rank's lexical score.
 * Pagination scans until this drops below the page cursor so reranking cannot
 * promote an unseen candidate past an already-emitted page.
 *
 * Every signal's value is bounded by 1, so `weight` — the summed weight of
 * the signals the caller blended — is the whole of what they can add and the
 * bound needs nothing from the corpus. That is why search does not pay for a
 * `max(citation_authority)` aggregate per query.
 */
export const stableBlendUpperBound = (
  nextLexicalScore: number,
  weight: number = DEFAULT_AUTHORITY_WEIGHT,
): number => nextLexicalScore + weight;

/**
 * Stable cursor score for corpus-index pagination. Callers provide a lexical
 * score already normalized against the index-wide hit count, so adding later
 * candidate windows does not change scores for earlier hits.
 *
 * `citationAuthority` stays the raw column value; only the blend saturates.
 */
export const blendStableCitationAuthority = ({
  candidates,
  authorityById,
  weight = DEFAULT_AUTHORITY_WEIGHT,
  signals = [],
}: StableBlendOptions): RankedHit[] => {
  const blended = stableBlendSignals(authorityById, weight, signals);
  const hits = candidates.map((candidate) => ({
    id: candidate.id,
    score: candidate.score + addedBySignals(blended, candidate.id),
    lexicalScore: candidate.score,
    citationAuthority: authorityById.get(candidate.id) ?? 0,
  }));

  hits.sort(byScoreThenId);
  return hits;
};
