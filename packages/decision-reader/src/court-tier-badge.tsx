import type { CourtTierLabel as CourtTier } from "@stll/api-contract/case-law-court-tiers";
import {
  CourtBadge,
  type CourtBadgeSize,
  type CourtBadgeWeight,
} from "@stll/ui/court-badge";
import { cn } from "@stll/ui/utils";

/**
 * How each tier's chip is drawn: a firm edge at the apex, lighter down the
 * instances. Weight rather than colour, because a chip must not be the only
 * carrier of a fact — and it never is: the court's name stands beside it.
 */
const TIER_BADGE_WEIGHT = {
  constitutional: "solid",
  supreme: "tinted",
  regional: "outline",
  other: "dashed",
} as const satisfies Record<CourtTier, CourtBadgeWeight>;

type CourtTierBadgeProps = {
  abbreviation: string;
  tier: CourtTier;
  size?: CourtBadgeSize | undefined;
  className?: string;
};

/**
 * The chip alone, weighted by tier: for a place that already names the court
 * beside it, or that stands for the decision as a whole (an inspector tab).
 */
export const CourtTierBadge = ({
  abbreviation,
  className,
  size,
  tier,
}: CourtTierBadgeProps) => (
  <CourtBadge
    abbreviation={abbreviation}
    className={cn(className)}
    size={size}
    weight={TIER_BADGE_WEIGHT[tier]}
  />
);
