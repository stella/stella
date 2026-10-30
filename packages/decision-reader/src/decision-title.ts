export const DECISION_TITLE_SEPARATOR = "·";

type DecisionTitleSource = {
  caseNumber: string;
  /** Court display name as the decision record carries it, not the route slug. */
  court?: string | null | undefined;
};

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
