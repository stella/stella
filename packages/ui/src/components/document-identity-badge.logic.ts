import type { CourtBadgeWeight } from "./court-badge";

export const COURT_TIER_WEIGHT = {
  constitutional: "solid",
  supreme: "tinted",
  regional: "outline",
  other: "dashed",
} as const satisfies Record<string, CourtBadgeWeight>;

export type DocumentIdentity =
  | { kind: "statute"; number: string | null; year: string | null }
  | {
      kind: "decision";
      courtAbbreviation: string | null | undefined;
      courtTier?: keyof typeof COURT_TIER_WEIGHT | undefined;
    }
  | { kind: "unknown" };

export const statuteIdentityLabels = ({
  number,
  year,
}: Extract<DocumentIdentity, { kind: "statute" }>) => {
  const ordinal = number?.trim() || null;
  const fullYear = year?.trim() || null;
  if (ordinal === null) {
    return fullYear === null ? null : { short: fullYear, long: fullYear };
  }
  if (fullYear === null) {
    return { short: ordinal, long: ordinal };
  }
  return {
    short: `${ordinal}/${fullYear.slice(-2)}`,
    long: `${ordinal}/${fullYear}`,
  };
};
