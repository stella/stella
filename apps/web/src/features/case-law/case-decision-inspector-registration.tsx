import { lazy, Suspense } from "react";

import { useQuery } from "@tanstack/react-query";
import { FileTextIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import {
  CASE_DECISION_VIEW,
  isCaseDecisionViewPayload,
} from "@/components/inspector/case-decision-view";
import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import { registerInspectorView } from "@/components/inspector/view-registry";
import type {
  InspectorRailIconProps,
  InspectorViewRenderProps,
} from "@/components/inspector/view-registry";
import { CourtTierBadge } from "@/features/case-law/components/court-name";
import { isCourtTier } from "@/features/case-law/decision-filter-facets.logic";
import { decisionOptions } from "@/features/case-law/queries/decisions";

const LazyCaseDecisionInspectorView = lazy(async () => {
  const module =
    await import("@/features/case-law/components/case-decision-inspector-view");
  return { default: module.CaseDecisionInspectorView };
});

/**
 * The court's chip stands for the tab, the way it stands beside the court in
 * the results table: a reader with three decisions open tells them apart by
 * court, not by a document glyph they all share. The chip comes from the
 * decision record the view reads (the same cache entry), so a court nothing
 * abbreviates, or a record not in yet, falls back to the glyph.
 */
const CaseDecisionRailIcon = ({
  active,
  tab,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => {
  const { data: decision } = useQuery(decisionOptions(tab.payload.decisionId));
  const abbreviation = decision?.courtAbbreviation;
  if (decision === undefined || !abbreviation) {
    return <FileTextIcon className={cn("size-3.5", !active && "opacity-70")} />;
  }
  return (
    <CourtTierBadge
      abbreviation={abbreviation}
      className={cn(!active && "opacity-70")}
      tier={isCourtTier(decision.courtTier) ? decision.courtTier : "other"}
    />
  );
};

const CaseDecisionView = (
  props: InspectorViewRenderProps<CaseDecisionViewPayload>,
) => (
  <Suspense fallback={<div className="bg-background flex-1" />}>
    <LazyCaseDecisionInspectorView {...props} />
  </Suspense>
);

registerInspectorView<CaseDecisionViewPayload>({
  type: CASE_DECISION_VIEW,
  render: CaseDecisionView,
  railIcon: CaseDecisionRailIcon,
  navigationPolicy: "persist",
  validate: isCaseDecisionViewPayload,
  ariaLabel: (tab) => tab.label,
});
