import type { BusinessRegistrySlug } from "@stll/api-contract";
import { validateKrsNumber } from "@stll/business-registries/krs/number";
import { validateVatFormat } from "@stll/business-registries/vies/validation";

import { LOOKUP_REGISTRY_OPTIONS } from "@/components/templates/registry-options";
import type { TranslationKey } from "@/i18n/types";

export const getRegistryQueryHint = (
  registry: BusinessRegistrySlug,
  query: string | null,
) => {
  if (query === null) {
    return null;
  }
  if (registry === "krs" && !validateKrsNumber(query)) {
    return "search.registryKrsHint" as const satisfies TranslationKey;
  }
  if (registry === "vies" && !validateVatFormat(query)) {
    return "search.registryVatHint" as const satisfies TranslationKey;
  }
  return null;
};

export const REGISTRY_COUNTRY_GROUPS = Array.from(
  new Set(LOOKUP_REGISTRY_OPTIONS.map((registry) => registry.country)),
  (country) => ({
    country,
    registries: LOOKUP_REGISTRY_OPTIONS.filter(
      (registry) => registry.country === country,
    ),
  }),
);

type ExpandedRegistryCountriesOptions = {
  preferredCountry: string | null;
  override: {
    organizationId: string;
    countries: readonly string[];
  } | null;
  organizationId: string;
};

export const resolveExpandedRegistryCountries = ({
  preferredCountry,
  override,
  organizationId,
}: ExpandedRegistryCountriesOptions): readonly string[] => {
  if (override?.organizationId === organizationId) {
    return override.countries;
  }
  if (
    preferredCountry !== null &&
    REGISTRY_COUNTRY_GROUPS.some((group) => group.country === preferredCountry)
  ) {
    return [preferredCountry];
  }
  return [];
};
