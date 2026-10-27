import { useQuery } from "@tanstack/react-query";

import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { InspectorRailIconProps } from "@/components/inspector/view-registry";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * The court's chip stands for the tab, the way it stands beside the court in
 * the results table: a reader with three decisions open tells them apart by
 * court, not by a document glyph they all share. The chip comes from the
 * decision record the view reads (the same cache entry), so a court nothing
 * abbreviates to a chip, or a record not in yet, falls back to the glyph.
 */
export const CaseDecisionRailIcon = ({
  tab,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => {
  const decisionQuery = useQuery(decisionOptions(tab.payload.decisionId));
  const decisionView = queryView(decisionQuery);
  useQueryViewError(decisionView, "CaseDecisionRailIcon:query");
  const decision =
    decisionView.type === "items" ? decisionView.items : undefined;
  return (
    <DocumentIdentityBadge
      identity={{
        kind: "decision",
        courtAbbreviation: decision?.courtAbbreviation,
        courtTier: decision?.courtTier,
      }}
    />
  );
};
