import { useQuery } from "@tanstack/react-query";

import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { InfoIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { InspectorRailIconProps } from "@/components/inspector/view-registry";
import { decisionOptions } from "@/features/case-law/queries/decisions";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

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
  const decisionView = useQueryView(decisionQuery);
  useQueryViewError(decisionView);
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

/**
 * The same chip, badged: the facts of a decision and its text are two tabs of
 * one decision, so they share the court chip and differ only in the badge.
 * Two identical chips in the rail would be the confusing part.
 */
export const CaseDecisionDetailsRailIcon = ({
  active,
  tab,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => (
  <span className="relative inline-flex">
    <CaseDecisionRailIcon active={active} tab={tab} />
    <InfoIcon
      aria-hidden="true"
      className={cn(
        "bg-background text-muted-foreground absolute -end-1 -bottom-1 size-2.5 rounded-full",
        !active && "opacity-70",
      )}
    />
  </span>
);
