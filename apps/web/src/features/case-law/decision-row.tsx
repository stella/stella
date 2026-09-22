/**
 * One decision as a row of the public-law results table: the shared row, told
 * which decision the inspector is showing and when a cell changed the row's
 * height (a headnote shown whole).
 */

import { PublicLawRow } from "@/components/public-law-table/public-law-row";
import type { TableRowRenderInput } from "@/components/workspaces/table/row-host";
import type { DecisionRowData } from "@/components/workspaces/table/types";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { isDecisionRowActive } from "@/features/case-law/decision-inspector.logic";
import { useDecisionRenderScope } from "@/features/case-law/decision-table-columns";

type DecisionRowProps = TableRowRenderInput<DecisionRowData> & {
  /** The inspector's active tab, so the open row is marked as such. */
  activeTabId: string | null;
  onOpen: (decision: Decision) => void;
};

export const DecisionRow = ({
  activeTabId,
  onOpen,
  ...input
}: DecisionRowProps) => {
  const decision = input.row.original.decision;
  const { expandedHeadnoteIds } = useDecisionRenderScope();

  return (
    <PublicLawRow
      {...input}
      isActive={isDecisionRowActive(activeTabId, decision)}
      onOpen={() => onOpen(decision)}
      remeasureKey={expandedHeadnoteIds.has(decision.id)}
    />
  );
};
