import { describe, expect, test } from "bun:test";

import { LOOKUP_REGISTRY_OPTIONS } from "@/components/templates/registry-options";

import {
  getRegistryQueryHint,
  REGISTRY_COUNTRY_GROUPS,
  resolveExpandedRegistryCountries,
} from "./search-company-result.logic";

test("KRS guides noncanonical input without restricting name-search registries", () => {
  for (const query of ["ALZA", "6865", "", "12345678901", "000000686X"]) {
    expect(getRegistryQueryHint("krs", query)).toBe("search.registryKrsHint");
  }
  for (const query of ["0000006865", " 0000 006865 ", null]) {
    expect(getRegistryQueryHint("krs", query)).toBeNull();
  }
  expect(getRegistryQueryHint("ares", "ALZA")).toBeNull();
  expect(getRegistryQueryHint("vies", "ALZA")).toBe("search.registryVatHint");
});

describe("country-grouped registry search", () => {
  test("places each offered registry exactly once in its own country group", () => {
    const sourceCountries = new Set(
      LOOKUP_REGISTRY_OPTIONS.map((registry) => registry.country),
    );
    expect(REGISTRY_COUNTRY_GROUPS.map((group) => group.country)).toEqual([
      ...sourceCountries,
    ]);
    const groupedRegistries = REGISTRY_COUNTRY_GROUPS.flatMap(
      (group) => group.registries,
    );
    expect(groupedRegistries).toHaveLength(LOOKUP_REGISTRY_OPTIONS.length);
    for (const registry of LOOKUP_REGISTRY_OPTIONS) {
      expect(
        groupedRegistries.filter((item) => item.slug === registry.slug),
      ).toEqual([registry]);
    }
    for (const group of REGISTRY_COUNTRY_GROUPS) {
      expect(group.registries.length).toBeGreaterThan(0);
      expect(
        group.registries.every(
          (registry) => registry.country === group.country,
        ),
      ).toBe(true);
    }
    expect(
      REGISTRY_COUNTRY_GROUPS.find(
        (group) => group.country === "EU",
      )?.registries.some((registry) => registry.slug === "vies"),
    ).toBe(true);
  });

  test("defaults to only the preferred country when that country has a registry", () => {
    for (const { country } of REGISTRY_COUNTRY_GROUPS) {
      expect(
        resolveExpandedRegistryCountries({
          preferredCountry: country,
          override: null,
          organizationId: "org_a",
        }),
      ).toEqual([country]);
    }
  });

  test.each([null, "", "not-a-country"])(
    "does not invent a default for unavailable jurisdiction %s",
    (preferredCountry) => {
      expect(
        resolveExpandedRegistryCountries({
          preferredCountry,
          override: null,
          organizationId: "org_a",
        }),
      ).toEqual([]);
    },
  );

  test("preserves the current organization's explicit choice, including all groups collapsed", () => {
    const choices = [
      [],
      ["CZ"],
      ["EU", "SK"],
      REGISTRY_COUNTRY_GROUPS.map((group) => group.country),
    ];
    for (const countries of choices) {
      for (const preferredCountry of [null, "CZ", "SK"]) {
        expect(
          resolveExpandedRegistryCountries({
            preferredCountry,
            override: { organizationId: "org_a", countries },
            organizationId: "org_a",
          }),
        ).toEqual(countries);
      }
    }
  });

  test("does not carry expanded countries into another organization", () => {
    for (const countries of [[], ["EU"], ["CZ", "SK"]]) {
      expect(
        resolveExpandedRegistryCountries({
          preferredCountry: "SK",
          override: { organizationId: "org_a", countries },
          organizationId: "org_b",
        }),
      ).toEqual(["SK"]);
      expect(
        resolveExpandedRegistryCountries({
          preferredCountry: null,
          override: { organizationId: "org_a", countries },
          organizationId: "org_b",
        }),
      ).toEqual([]);
    }
  });
});
