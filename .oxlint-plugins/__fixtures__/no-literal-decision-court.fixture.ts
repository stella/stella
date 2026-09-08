// Passive regression fixture for
// no-literal-decision-court/no-literal-decision-court.
//
// A required report carries a disable. If detection regresses, that directive
// becomes unused and fixture lint fails. Unannotated cases must remain allowed.

declare const czDecisionCourt: (options: {
  adapterKey: string;
  ecli: string | undefined;
  publisherCourt: string;
  sourceDocumentId: string | undefined;
  statedCourt?: string | undefined;
}) => string;
declare const adapterKey: string;
declare const ecli: string | undefined;
declare const sourceDocumentId: string | undefined;
declare const statedCourt: string | undefined;
declare const application: string;

const PUBLISHER_COURT = "Nejvyšší soud";

const literalCourtRow = {
  caseNumber: "30 Cdo 3000/2011",
  // oxlint-disable-next-line no-literal-decision-court/no-literal-decision-court -- fixture: the publisher's name as a constant must be rejected
  court: "Nejvyšší soud",
  country: "CZE",
};

const assertedLiteralCourtRow = {
  // oxlint-disable-next-line no-literal-decision-court/no-literal-decision-court -- fixture: an asserted literal is still a literal
  court: "Ústavní soud" as const,
};

const templateCourtRow = {
  metadata: {
    // oxlint-disable-next-line no-literal-decision-court/no-literal-decision-court -- fixture: a template literal states a court just as a string does
    court: `RIS ${application}`,
  },
};

declare const parseDecisionHtml: (options: {
  caseNumber: string;
  court: string;
}) => void;

parseDecisionHtml({
  caseNumber: "1 As 1/2020",
  // oxlint-disable-next-line no-literal-decision-court/no-literal-decision-court -- fixture: a parser argument stores the same attribution
  court: "Nejvyšší správní soud",
});

// The resolved court: read off the decision's own ECLI, with the source's own
// court field and the publisher's name behind it.
const court = czDecisionCourt({
  adapterKey,
  ecli,
  publisherCourt: PUBLISHER_COURT,
  sourceDocumentId,
  statedCourt,
});

const resolvedRow = {
  court,
  metadata: { court },
};

declare const item: { sud?: { nazov?: string } | undefined };

const recordFieldRow = {
  court: item.sud?.nazov,
  metadata: {
    court: czDecisionCourt({
      adapterKey,
      ecli,
      publisherCourt: PUBLISHER_COURT,
      sourceDocumentId,
    }),
  },
};

// A court-valued query parameter is a filter token, not an attribution, and
// is named for what it filters.
declare const fetchListing: (options: { courtFilter?: string }) => void;
fetchListing({ courtFilter: "AUSL" });

export {
  assertedLiteralCourtRow,
  literalCourtRow,
  recordFieldRow,
  resolvedRow,
  templateCourtRow,
};
