import type { DesktopRegistryConfig } from "@stll/api-contract/desktop-registry";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";

const sole = <T>(entries: T[]): T | null => {
  const [first, ...rest] = entries;
  return first !== undefined && rest.length === 0 ? first : null;
};

type DefaultRegistryOptions = {
  registries: DesktopRegistryConfig["registries"];
  practiceJurisdictions: readonly PracticeJurisdiction[];
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
  return sole(primaryRegistries)?.id ?? sole(domesticRegistries)?.id ?? null;
};
