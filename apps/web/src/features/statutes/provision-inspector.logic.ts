import { panic } from "better-result";

import { filterBySearchQuery } from "@stll/text-normalize/search-query-matcher";

import { decisionCitationCourtLabel } from "@/components/references/decision-citation-chip.logic";
import { decisionCitationPresentationsById } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";

export {
  createProvisionViewTab,
  isProvisionViewPayload,
  PROVISION_VIEW,
  provisionTabId,
  provisionTabLabel,
} from "@/features/statutes/provision-inspector-contract";
export type { ProvisionViewPayload } from "@/features/statutes/provision-inspector-contract";

type CitingDecisionRow = {
  caseNumber: string;
  court: string;
  sentenceText: string | null;
};

/**
 * Narrows the loaded pages to the rows whose case number, court, or cited
 * sentence contains the query. Case and accents are folded on both sides, so
 * a query typed without them still finds the decision.
 */
export const filterCitingDecisions = <T extends CitingDecisionRow>(
  decisions: readonly T[],
  query: string,
): T[] =>
  filterBySearchQuery({
    items: decisions,
    query,
    fields: ({ caseNumber, court, sentenceText }) => [
      `${caseNumber} ${court} ${sentenceText ?? ""}`,
    ],
  });

type PresentedCitingDecisionRow = CitingDecisionRow & {
  country: string;
  courtAbbreviation?: string | null | undefined;
  decisionId: string;
  ecli?: string | null | undefined;
};

/**
 * The rows the filter leaves, each with the chip size it is shown at. Chips
 * are sized against the rows on screen, not everything loaded: a shared court
 * code only needs the expanded chip while both decisions are visible.
 */
export const presentedCitingDecisions = <T extends PresentedCitingDecisionRow>(
  decisions: readonly T[],
  query: string,
): { decision: T; presentation: DecisionCitationPresentation }[] => {
  const visible = filterCitingDecisions(decisions, query);
  const presentations = decisionCitationPresentationsById(
    visible.map((decision) => ({
      decisionId: decision.decisionId,
      courtShortCode: decisionCitationCourtLabel(decision),
    })),
  );

  return visible.map((decision) => ({
    decision,
    presentation:
      presentations.get(decision.decisionId) ??
      panic("Citing decision missing collected identity"),
  }));
};
