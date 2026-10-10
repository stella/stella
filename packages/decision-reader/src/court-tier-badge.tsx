import type { CourtTierLabel as CourtTier } from "@stll/api-contract/case-law-court-tiers";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { cn } from "@stll/ui/utils";

type CourtTierBadgeProps = {
  abbreviation: string;
  tier: CourtTier;
  className?: string;
};

/**
 * The chip alone, weighted by tier: for a place that already names the court
 * beside it, or that stands for the decision as a whole (an inspector tab).
 * It draws the shared document identity badge, so a decision looks the same
 * in every list, rail and reader.
 */
export const CourtTierBadge = ({
  abbreviation,
  className,
  tier,
}: CourtTierBadgeProps) => (
  <span className={cn(className)}>
    <DocumentIdentityBadge
      identity={{
        kind: "decision",
        courtAbbreviation: abbreviation,
        courtTier: tier,
      }}
    />
  </span>
);
