/**
 * The decision table's rows.
 *
 * Everything the table shell would otherwise have to know about a decision
 * lives here: what a row draws, what opening one means, and the one control
 * beside the grid a results page has (the rail that adds a question column).
 * A decision has no name to rename, contains no other rows, and is not dragged
 * anywhere, so the host simply omits those behaviours rather than stubbing
 * them.
 */

import type { ReactNode } from "react";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { TableRowHost } from "@/components/workspaces/table/row-host";
import type { DecisionRowData } from "@/components/workspaces/table/types";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { decisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import { DecisionRow } from "@/features/case-law/decision-row";
import { useOpenDecisionTab } from "@/features/case-law/open-decision-tab";

/** Opens a decision beside the results, at a passage when one is named. */
export const useOpenDecisionInspector = () => {
  const openDecision = useOpenDecisionTab();

  return (decision: Decision, anchorId?: string) => {
    openDecision.open(decisionTabTarget(decision, anchorId));
  };
};

type DecisionRowHostInput = {
  /**
   * The rail beside the add-column column. Omitted for a reader without an
   * organization, who has nothing to hang a question on.
   */
  addColumnRail?: ReactNode | undefined;
};

export const useDecisionRowHost = ({
  addColumnRail,
}: DecisionRowHostInput): TableRowHost<DecisionRowData> => {
  const activeTabId = useInspectorTabsStore((s) => s.activeId);
  const openDecision = useOpenDecisionInspector();

  return {
    renderRow: (input) => (
      <DecisionRow {...input} activeTabId={activeTabId} onOpen={openDecision} />
    ),
    ...(addColumnRail === undefined ? {} : { addColumnRail }),
  };
};
