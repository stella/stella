import { CZ_PROFILE } from "./cz-provision-citation-profile";
import {
  type JurisdictionProfile,
  PROVISION_CITATION_JURISDICTIONS,
  type ProvisionCitationJurisdiction,
} from "./provision-citation-profile";
import { SK_PROFILE } from "./sk-provision-citation-profile";

export const PROVISION_CITATION_PROFILES = {
  CZE: CZ_PROFILE,
  SVK: SK_PROFILE,
} as const satisfies Record<ProvisionCitationJurisdiction, JurisdictionProfile>;

/**
 * The provision citation profile a jurisdiction has, or null when the
 * registry holds none for it. A new profile needs no change at the callers.
 */
export const provisionCitationProfileFor = (
  jurisdiction: string,
): JurisdictionProfile | null => {
  const known = PROVISION_CITATION_JURISDICTIONS.find(
    (candidate) => candidate === jurisdiction,
  );
  return known === undefined ? null : PROVISION_CITATION_PROFILES[known];
};
