import type {
  CensusCourtEvidence,
  CensusListingIdentity,
  ReconciliationListingItem,
} from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";

export const censusListingIdentity = ({
  identity,
  censusCourtEvidence,
}: ReconciliationListingItem): CensusListingIdentity =>
  identity.type === "case-number"
    ? {
        type: "case-number",
        caseNumber: identity.caseNumber,
        language: identity.language,
        censusCourtEvidence: censusCourtEvidence ?? { type: "unknown" },
      }
    : identity;

/** Raw publisher evidence verifies the passes; SQL's canonical court owner derives the final census key. */
export const censusListingEvidenceKey = (
  identity: CensusListingIdentity,
): string | null => {
  const key = listingIdentityKey(identity);
  if (key === null) {
    return null;
  }
  return identity.type === "case-number"
    ? JSON.stringify([key, identity.censusCourtEvidence ?? { type: "unknown" }])
    : key;
};

/** A publisher must actually name the court; a general court tier is insufficient. */
export const observedCensusCourt = (
  court: string | null | undefined,
): CensusCourtEvidence =>
  court !== undefined && court !== null && court.trim().length > 0
    ? { type: "known", court, courtId: null }
    : { type: "unknown" };
