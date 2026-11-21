import type { CourtTierLabel as CourtTier } from "@stll/api-contract/case-law-court-tiers";
import type { CourtBadgeSize } from "@stll/ui/court-badge";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { cn } from "@stll/ui/utils";

type CourtTierBadgeProps = {
  abbreviation: string;
  tier: CourtTier;
  size?: CourtBadgeSize | undefined;
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
  size,
  tier,
}: CourtTierBadgeProps) => (
  <span className={cn(className)}>
    <DocumentIdentityBadge
      size={size}
      identity={{
        kind: "decision",
        courtAbbreviation: abbreviation,
        courtTier: tier,
      }}
    />
  </span>
);
