import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";

/** Base ledger weight per action type. */
export const ACTION_WEIGHTS = {
  chat: 1,
  anonymise: 3,
  doc_review: 5,
  case_law: 8,
  // System-initiated background enrichment; recorded for accounting
  // but never pre-flight-checked (no user is waiting on it).
  background: 1,
} as const satisfies Record<UsageActionType, number>;

/** Service-tier multiplier for immediate, queued, and batch work. */
export const SERVICE_TIER_MULTIPLIERS = {
  standard: 1.5,
  flex: 1,
  batch: 1,
} as const satisfies Record<UsageServiceTier, number>;

/**
 * BYOK ("bring your own key") attribution: the ledger records a
 * usage row for audit and reporting, but no units are consumed
 * because model work is attributed to the org's configured
 * provider account.
 */
export const BYOK_MULTIPLIER = 0;

type UsageUnitCostInput = {
  actionType: UsageActionType;
  serviceTier: UsageServiceTier;
  isByok: boolean;
};

/**
 * Resolve the integer unit cost of a single AI action.
 *
 * A non-BYOK action is floored at 1 unit so every platform-side
 * action leaves a visible ledger entry. BYOK actions skip the
 * floor but still write usage rows for attribution.
 */
export const computeUsageUnitCost = ({
  actionType,
  serviceTier,
  isByok,
}: UsageUnitCostInput): number => {
  const base = ACTION_WEIGHTS[actionType];
  const tier = SERVICE_TIER_MULTIPLIERS[serviceTier];
  const byok = isByok ? BYOK_MULTIPLIER : 1;
  const raw = Math.ceil(base * tier * byok);
  return isByok ? Math.max(0, raw) : Math.max(1, raw);
};
