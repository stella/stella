import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";

/**
 * Registered inspector view kind for the facts of one decision: court, date,
 * area of law, rapporteur, source, and who cites it. A second tab of the same
 * decision the text tab holds, so it is named and drawn like it and stays
 * open until it is closed.
 */
export const CASE_DECISION_DETAILS_VIEW = "case-law-decision-details";

export const caseDecisionDetailsTabId = (decisionId: string): string =>
  `${CASE_DECISION_DETAILS_VIEW}:${decisionId}`;

export type CaseDecisionDetailsViewTab = {
  type: typeof CASE_DECISION_DETAILS_VIEW;
  id: string;
  label: string;
  payload: CaseDecisionViewPayload;
};

export const createCaseDecisionDetailsTab = (
  target: Parameters<typeof createCaseDecisionViewTab>[0],
): CaseDecisionDetailsViewTab => {
  // Label and payload come from the text tab's factory, so the two tabs of
  // one decision cannot come to name it differently.
  const { label, payload } = createCaseDecisionViewTab(target);
  return {
    type: CASE_DECISION_DETAILS_VIEW,
    id: caseDecisionDetailsTabId(target.decisionId),
    label,
    payload,
  };
};
