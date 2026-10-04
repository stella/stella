import { CZ_PROFILE } from "./cz-provision-citation-profile";
import type {
  JurisdictionProfile,
  ProvisionCitationJurisdiction,
} from "./provision-citation-profile";
import { SK_PROFILE } from "./sk-provision-citation-profile";

export const PROVISION_CITATION_PROFILES = {
  CZE: CZ_PROFILE,
  SVK: SK_PROFILE,
} as const satisfies Record<ProvisionCitationJurisdiction, JurisdictionProfile>;
