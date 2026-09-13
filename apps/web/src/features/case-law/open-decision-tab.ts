/**
 * The one action that opens a public decision beside the results.
 *
 * Every gesture that opens a decision from a results row goes through it: the
 * row itself, the case-number link, the matched passage, a question's source
 * chip. Kept apart from the row host so a cell can open a decision without
 * pulling the table's row — and the grid behind it — into its bundle.
 */

import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { DecisionTabTarget } from "@/features/case-law/decision-inspector.logic";

export const useOpenDecisionTab = () => {
  const openView = useInspectorTabsStore((s) => s.openView);

  return (target: DecisionTabTarget) => {
    openView(createCaseDecisionViewTab(target));
  };
};
