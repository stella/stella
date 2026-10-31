import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { LANGUAGES } from "@stll/locales";

import { CZ_PROFILE } from "./cz-provision-citation-profile";
import type {
  JurisdictionProfile,
  ProvisionCitationJurisdiction,
} from "./provision-citation-profile";

/**
 * National profiles admitted alongside jurisdiction-agnostic EU extraction.
 * National admission is a subset of the profiles,
 * so the map is partial; each entry must be the profile of its own key, so
 * an admitted jurisdiction without a profile does not compile.
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

/** Every known decision country/language runs EU extraction, including multilingual text. */
export const PROVISION_EXTRACTION_ADMISSION_SCOPES =
  CASE_LAW_JURISDICTIONS.flatMap((jurisdiction) =>
    LANGUAGES.map(({ code }) => ({ jurisdiction, language: code })),
  );

/**
 * Bumped with every change to `PROVISION_EXTRACTION_ADMISSION_SCOPES`. The database
 * stores the highest revision a deployment has applied, and a binary built
 * with a lower one leaves scopes alone, so a replica still running the
 * previous release cannot undo a newer admission during a rolling deploy.
 * The admission test pins each revision to the scopes it admits.
 */
export const PROVISION_EXTRACTION_ADMISSION_REVISION = 2;
