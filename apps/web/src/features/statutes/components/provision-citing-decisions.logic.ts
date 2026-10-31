type CitingDecision = { decisionId: string };

/** One row of the provision's citing decisions, as the list draws it. */
export type OrderedCitingDecision<T extends CitingDecision> = {
  decision: T;
  /** Among the decisions carrying the most authority on the provision. */
  leading: boolean;
};

type OrderCitingDecisionsOptions<T extends CitingDecision> = {
  /** The most authoritative citing decisions, strongest first. */
  leading: readonly T[];
  /** The citing decisions read so far, in the order the reader asked for. */
  rest: readonly T[];
  /**
   * Whether the leading decisions head the list. A court or year filter
   * narrows the list to what it matches, which the leading decisions were
   * not read against, so they then keep only their mark.
   */
  pinLeading: boolean;
};

/**
 * One list of the decisions citing a provision, each decision once: the
 * leading ones first, then everything else in the order asked for. A
 * decision that leads is marked wherever it appears.
 */
export const orderCitingDecisions = <T extends CitingDecision>({
  leading,
  pinLeading,
  rest,
}: OrderCitingDecisionsOptions<T>): OrderedCitingDecision<T>[] => {
  const leadingIds = new Set(leading.map((decision) => decision.decisionId));
  const seen = new Set<string>();
  const ordered: OrderedCitingDecision<T>[] = [];
  for (const decision of pinLeading ? [...leading, ...rest] : rest) {
    if (seen.has(decision.decisionId)) {
      continue;
    }
    seen.add(decision.decisionId);
    ordered.push({ decision, leading: leadingIds.has(decision.decisionId) });
  }
  return ordered;
};
