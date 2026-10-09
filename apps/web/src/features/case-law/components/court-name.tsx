import { CourtTierBadge } from "@stll/decision-reader/court-tier-badge";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import type { CourtTier } from "@/features/case-law/decision-filter-facets.logic";

type CourtNameProps = {
  /**
   * The court's short form as the API derived it, or nothing where the corpus
   * states none. Never invented here: an unknown court is shown by name alone.
   */
  abbreviation?: string | null | undefined;
  court: string;
  /** Absent on a row whose surface does not carry the court's rank. */
  tier?: CourtTier | undefined;
  className?: string;
};

/**
 * A court as the public case-law surfaces write it: its abbreviation, then
 * its name. One component for all three of them, so the results table, the
 * decision header and the corpus status draw the same court the same way.
 */
export const CourtName = ({
  abbreviation,
  className,
  court,
  tier,
}: CourtNameProps) => (
  <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
    {abbreviation && tier !== undefined && (
      <CourtTierBadge abbreviation={abbreviation} tier={tier} />
    )}
    <BidiText as="span" className="truncate" title={court}>
      {court}
    </BidiText>
  </span>
);
