import type { DesktopRegistryConfig } from "@stll/api-contract/desktop-registry";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";

type DefaultRegistryOptions = {
  registries: DesktopRegistryConfig["registries"];
  practiceJurisdictions: PracticeJurisdiction[];
};

export const getDefaultDesktopRegistry = ({
  registries,
  practiceJurisdictions,
}: DefaultRegistryOptions) => {
  const domesticRegistries = registries.filter(({ id }) =>
    practiceJurisdictions.some(
      ({ countryCode }) =>
        countryCode === BUSINESS_REGISTRY_DISPATCH[id].country,
    ),
  );
  const primaryRegistries = domesticRegistries.filter(({ id }) =>
    practiceJurisdictions.some(
      ({ countryCode, isPrimary }) =>
        isPrimary && countryCode === BUSINESS_REGISTRY_DISPATCH[id].country,
    ),
  );
  if (primaryRegistries.length === 1) {
    return primaryRegistries[0].id;
  }
  return domesticRegistries.length === 1 ? domesticRegistries[0].id : null;
};
