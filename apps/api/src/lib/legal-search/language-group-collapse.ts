/**
 * Fold every language version of one decision into a single search unit.
 *
 * Candidates arrive best-first, so the first one seen for a group is the
 * group's best-scoring member: it keeps its own score and stands for the
 * group. Later members are folded into it and never emitted. Because the
 * representative is the highest-ranked member and the scan replays the same
 * engine order from offset 0 on every page, the same member represents the
 * group on every page, which is what keeps the keyset cursor stable.
 */
export type LanguageGroupCollapse<TCandidate extends { id: string }> = {
  /** Candidates that stand for their group, in input order. */
  representatives: TCandidate[];
  /** Folded candidate id → the id of the representative it folded into. */
  foldedInto: Map<string, string>;
};

export const collapseByLanguageGroup = <TCandidate extends { id: string }>(
  candidates: readonly TCandidate[],
  groupKeyOf: (candidateId: string) => string | null,
): LanguageGroupCollapse<TCandidate> => {
  const representativeByGroup = new Map<string, string>();
  const representatives: TCandidate[] = [];
  const foldedInto = new Map<string, string>();

  for (const candidate of candidates) {
    const groupKey = groupKeyOf(candidate.id);
    if (groupKey === null) {
      representatives.push(candidate);
      continue;
    }
    const representative = representativeByGroup.get(groupKey);
    if (representative === undefined) {
      representativeByGroup.set(groupKey, candidate.id);
      representatives.push(candidate);
      continue;
    }
    foldedInto.set(candidate.id, representative);
  }

  return { representatives, foldedInto };
};
