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
  /**
   * A decision named by its own case number, where a court chip would not
   * tell several open decisions apart (one court's tabs side by side).
   */
  | { kind: "caseNumber"; caseNumber: string | null | undefined }
  | { kind: "unknown" };

/** A reference label in its narrow and its full form. */
export type IdentityLabels = { short: string; long: string };

export const statuteIdentityLabels = ({
  number,
  year,
}: Extract<DocumentIdentity, { kind: "statute" }>): IdentityLabels | null => {
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

/** A four-digit year closing a case number: `1234/2019`, `C-1/2004`. */
const TRAILING_FULL_YEAR = /\/\d{2}(\d{2})$/u;

/**
 * A case number in the two forms a statute number takes: the full one, and
 * one whose closing four-digit year is cut to two, the way `165/2012` reads
 * `165/12`. A number already printed with a two-digit year (`C-359/25`) is
 * its own short form.
 */
export const caseNumberIdentityLabels = ({
  caseNumber,
}: Extract<
  DocumentIdentity,
  { kind: "caseNumber" }
>): IdentityLabels | null => {
  const long = caseNumber?.trim().replaceAll(/\s+/gu, " ") ?? "";
  if (long === "") {
    return null;
  }
  return { short: long.replace(TRAILING_FULL_YEAR, "/$1"), long };
};
