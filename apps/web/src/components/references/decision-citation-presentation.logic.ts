import { panic } from "better-result";

/** Resolved corpus identity and the court registry's display code. */
export type DecisionCitationIdentity = {
  decisionId: string;
  courtShortCode: string;
};

export const DECISION_CITATION_PRESENTATION = {
  compact: "compact",
  expanded: "expanded",
} as const;

export type DecisionCitationPresentation =
  (typeof DECISION_CITATION_PRESENTATION)[keyof typeof DECISION_CITATION_PRESENTATION];

/** Presentations align with the answer's citations, including repetitions.
 * Distinct decisions sharing a visible code must remain distinguishable. */
export const decisionCitationPresentations = (
  citations: readonly DecisionCitationIdentity[],
) => {
  const decisionsByCourt = new Map<string, Set<string>>();
  for (const { courtShortCode, decisionId } of citations) {
    const decisions = decisionsByCourt.get(courtShortCode) ?? new Set<string>();
    decisionsByCourt.set(courtShortCode, decisions);
    decisions.add(decisionId);
  }

  return citations.map(({ courtShortCode }) => {
    const decisions = decisionsByCourt.get(courtShortCode);
    if (decisions === undefined) {
      return panic("Every answer citation must have a collected court code");
    }
    return decisions.size >= 2
      ? DECISION_CITATION_PRESENTATION.expanded
      : DECISION_CITATION_PRESENTATION.compact;
  });
};

/** Canonical identity lookup for hosts that render citation spans separately. */
export const decisionCitationPresentationsById = (
  citations: readonly DecisionCitationIdentity[],
) => {
  const aligned = decisionCitationPresentations(citations);
  const byId = new Map<string, DecisionCitationPresentation>();
  for (const [index, { decisionId }] of citations.entries()) {
    const presentation = aligned.at(index);
    if (presentation === undefined) {
      return panic("Every citation must have an aligned presentation");
    }
    byId.set(decisionId, presentation);
  }
  return byId;
};
