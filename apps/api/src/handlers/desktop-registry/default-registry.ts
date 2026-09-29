import type { DesktopRegistryConfig } from "@stll/api-contract/desktop-registry";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";

const sole = <T>(entries: T[]): T | null => {
  const [first, ...rest] = entries;
  return first !== undefined && rest.length === 0 ? first : null;
};

type DefaultRegistryOptions = {
  registries: readonly Pick<
    DesktopRegistryConfig["registries"][number],
    "id" | "name"
  >[];
  practiceJurisdictions: readonly PracticeJurisdiction[];
};

export const getDefaultDesktopRegistry = ({
  registries,
  practiceJurisdictions,
}: DefaultRegistryOptions) => {
  // A supplementary register (RPO beside ORSR) never competes with its
  // jurisdiction's enabled primary register for the default.
  const hasEnabledPrimary = (country: string): boolean =>
    registries.some(
      ({ id }) =>
        BUSINESS_REGISTRY_DISPATCH[id].country === country &&
        BUSINESS_REGISTRY_DISPATCH[id].jurisdictionRole.type === "primary",
    );
  const candidates = registries.filter(({ id }) => {
    const { country, jurisdictionRole } = BUSINESS_REGISTRY_DISPATCH[id];
    return jurisdictionRole.type === "primary" || !hasEnabledPrimary(country);
  });
  const domesticRegistries = candidates.filter(({ id }) =>
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
