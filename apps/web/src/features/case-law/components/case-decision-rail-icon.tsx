import { useQuery } from "@tanstack/react-query";
import { FileTextIcon, InfoIcon } from "lucide-react";

import { cn } from "@stll/ui/utils";

import type { CaseDecisionViewPayload } from "@/components/inspector/case-decision-view";
import type { InspectorRailIconProps } from "@/components/inspector/view-registry";
import { railCourtAbbreviation } from "@/features/case-law/components/case-decision-rail-icon.logic";
import { CourtTierBadge } from "@/features/case-law/components/court-name";
import { decisionOptions } from "@/features/case-law/queries/decisions";

/**
 * The court's chip stands for the tab, the way it stands beside the court in
 * the results table: a reader with three decisions open tells them apart by
 * court, not by a document glyph they all share. The chip comes from the
 * decision record the view reads (the same cache entry), so a court nothing
 * abbreviates to a chip, or a record not in yet, falls back to the glyph.
 */
export const CaseDecisionRailIcon = ({
  active,
  tab,
}: InspectorRailIconProps<CaseDecisionViewPayload>) => {
  const { data: decision } = useQuery(decisionOptions(tab.payload.decisionId));
  const abbreviation = railCourtAbbreviation(decision?.courtAbbreviation);
  if (decision === undefined || abbreviation === null) {
    return <FileTextIcon className={cn("size-3.5", !active && "opacity-70")} />;
  }
  // Never faded, unlike the fallback glyph above: two capitals at chip size
  // have no contrast to spare, and the tab's spine and fill already say which
  // one is open. The rails hold the other half of that invariant: the app rail
  // through `railIconInactive: "legible"` on the registration, the public rail
  // by not fading a rail icon at all.
  return (
    <CourtTierBadge abbreviation={abbreviation} tier={decision.courtTier} />
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
