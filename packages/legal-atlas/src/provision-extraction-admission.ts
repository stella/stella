import { CZ_PROFILE } from "./cz-provision-citation-profile";
import type {
  JurisdictionProfile,
  ProvisionCitationJurisdiction,
} from "./provision-citation-profile";

/**
 * The jurisdictions whose decisions stored provision extraction admits, each
 * with the profile it extracts with. Admission is a subset of the profiles,
 * so the map is partial; each entry must be the profile of its own key, so
 * an admitted jurisdiction without a profile does not compile. The scope a
 * decision needs is `(profile.jurisdiction, profile.language)`.
 */
export const PROVISION_EXTRACTION_ADMISSION = {
  CZE: CZ_PROFILE,
} as const satisfies {
  readonly [
    Jurisdiction in ProvisionCitationJurisdiction
  ]?: JurisdictionProfile & {
    readonly jurisdiction: Jurisdiction;
  };
};

/**
 * Bumped with every change to `PROVISION_EXTRACTION_ADMISSION`. The database
 * stores the highest revision a deployment has applied, and a binary built
 * with a lower one leaves scopes alone, so a replica still running the
 * previous release cannot undo a newer admission during a rolling deploy.
 * The admission test pins each revision to the scopes it admits.
 */
export const PROVISION_EXTRACTION_ADMISSION_REVISION = 1;
