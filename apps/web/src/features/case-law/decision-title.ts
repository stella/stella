type DecisionTitleSource = {
  caseNumber: string;
  /** Court display name as the decision record carries it, not the route slug. */
  court?: string | null | undefined;
};

/**
 * Separator between a decision's name and the facts that qualify it. The
 * breadcrumb draws each qualifier as its own span (muted, and dropped on a
 * narrow screen), so it composes the parts itself and shares only this.
 */
export const DECISION_TITLE_SEPARATOR = "·";

/**
 * How a decision is named wherever it is shown among other things: the case
 * number, then the court whose file it is. A docket number is unique only
 * within one court, so "I. ÚS 281/97" on its own leaves two courts' files
 * looking alike. The court name is the publisher's own words and is shown
 * verbatim, never translated.
 */
export const decisionTitle = ({
  caseNumber,
  court,
}: DecisionTitleSource): string => {
  const name = court?.trim();

  return name
    ? `${caseNumber} ${DECISION_TITLE_SEPARATOR} ${name}`
    : caseNumber;
};
