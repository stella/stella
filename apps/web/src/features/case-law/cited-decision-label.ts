type LabelSource = {
  caseNumber: string;
  decisionDate: string | null;
  decisionType?: string | null | undefined;
};

/**
 * The label a cited decision is shown under.
 *
 * A docket number names a file, not a document: a constitutional court's
 * nález and the orders issued in the same file all carry it. Two rows that
 * read "II. ÚS 2766/14" cannot be told apart, so where the decision's type is
 * stored the label carries it, with the year, in the court's own words:
 * "II. ÚS 2766/14 (nález, 2015)". The type is court language and is shown
 * verbatim, never translated.
 */
export const citedDecisionLabel = ({
  caseNumber,
  decisionDate,
  decisionType,
}: LabelSource): string => {
  const type = decisionType?.trim();
  if (!type) {
    return caseNumber;
  }
  const year = decisionDate?.slice(0, 4);
  return year ? `${caseNumber} (${type}, ${year})` : `${caseNumber} (${type})`;
};
