import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";

/**
 * Registered inspector view kind for the facts of the decision the main view
 * shows: court, date, area of law, rapporteur, source. Route-owned, so it
 * leaves with the page.
 */
export const CASE_DECISION_DETAILS_VIEW = "case-law-decision-details";

export const caseDecisionDetailsTabId = (decisionId: string): string =>
  `${CASE_DECISION_DETAILS_VIEW}:${decisionId}`;

export type CaseDecisionDetailsViewTab = {
  type: typeof CASE_DECISION_DETAILS_VIEW;
  id: string;
  label: string;
  payload: CaseDecisionViewPayload;
  ownerRouteId: string;
};

export const createCaseDecisionDetailsTab = (
  target: Parameters<typeof createCaseDecisionViewTab>[0],
  ownerRouteId: string,
): CaseDecisionDetailsViewTab => {
  const { label, payload } = createCaseDecisionViewTab(target);
  return {
    type: CASE_DECISION_DETAILS_VIEW,
    id: caseDecisionDetailsTabId(target.decisionId),
    label,
    payload,
    ownerRouteId,
  };
};
