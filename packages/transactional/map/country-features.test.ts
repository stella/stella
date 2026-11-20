import { describe, expect, test } from "bun:test";

import { COUNTRY_CODES } from "@stll/country-codes";

import { COUNTRY_FEATURES, UNASSIGNED_FEATURES } from "./country-features";
import { getBaseMap, selectsFeature } from "./location-map";

const { countries } = await getBaseMap();

const drawnSelectors = COUNTRY_CODES.flatMap((countryCode) => {
  const entry = COUNTRY_FEATURES[countryCode];
  return entry.type === "drawn"
    ? entry.features.map((selector) => ({ countryCode, selector }))
    : [];
});

describe("country features", () => {
  test.each(drawnSelectors)(
    "$countryCode finds its feature on the base map: $selector",
    ({ selector }) => {
      expect(
        countries.filter((country) => selectsFeature(selector, country)),
      ).not.toHaveLength(0);
    },
  );

  test("every base map feature belongs to a country or is listed as unassigned", () => {
    const unclaimed = countries
      .filter(
        (country) =>
          !drawnSelectors.some(({ selector }) =>
            selectsFeature(selector, country),
          ),
      )
      .map(({ name }) => name);

    expect(unclaimed.toSorted()).toEqual([...UNASSIGNED_FEATURES].toSorted());
  });
});
