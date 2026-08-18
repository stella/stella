/**
 * Two-stage retrieve-then-rerank: the engine returns lexical (BM25)
 * candidates; the API blends in the precomputed citation authority.
 * corpus index cannot express this blend in-engine (no function_score), so
 * it lives here.
 *
 * `rrfMerge` fuses several lexical candidate lists (the AI query planner
 * issues multiple searches). `blendCitationAuthority` combines a single
 * fused lexical signal with citation authority.
 */

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
const DEFAULT_AUTHORITY_WEIGHT = 0.3;

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

/**
 * Highest blended score any not-yet-scanned candidate could reach under
 * blendStableCitationAuthority, given the next rank's lexical score.
 * Pagination scans until this drops below the page cursor so reranking cannot
 * promote an unseen candidate past an already-emitted page.
 *
 * Saturated authority is strictly below 1, so `weight` is the whole of what
 * authority can add and the bound needs nothing from the corpus. That is why
 * search no longer pays for a `max(citation_authority)` aggregate per query.
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
}: BlendOptions): RankedHit[] => {
  const hits = candidates.map((candidate) => {
    const authority = authorityById.get(candidate.id) ?? 0;
    return {
      id: candidate.id,
      score: candidate.score + weight * saturateAuthority(authority),
      lexicalScore: candidate.score,
      citationAuthority: authority,
    };
  });

  hits.sort(byScoreThenId);
  return hits;
};
