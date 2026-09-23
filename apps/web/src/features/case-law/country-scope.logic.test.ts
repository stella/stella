import { describe, expect, test } from "bun:test";

import {
  COUNTRY_SCOPED_LAW_ROUTE_IDS,
  countryScopedLawRoute,
} from "@/features/case-law/country-scope.logic";

describe("where the top bar offers a jurisdiction", () => {
  test("on the listing screens whose URL carries the country, and names which", () => {
    expect(countryScopedLawRoute(COUNTRY_SCOPED_LAW_ROUTE_IDS.home)).toBe(
      "home",
    );
    expect(countryScopedLawRoute(COUNTRY_SCOPED_LAW_ROUTE_IDS.cases)).toBe(
      "cases",
    );
    expect(countryScopedLawRoute(COUNTRY_SCOPED_LAW_ROUTE_IDS.statutes)).toBe(
      "statutes",
    );
  });

  test("nowhere else, so exactly one control can ever be showing", () => {
    for (const routeId of [
      "/law/$country/cases/$court/$slug",
      "/law/$country/cases/$court/$language/$slug",
      "/law/$country/statutes/$slug/",
      "/law/$country/statutes/$slug/v/$version",
      "/law/cases/research/",
      "/law/cases/research/$tableId",
      "/law",
      "/law/cases",
      "",
    ]) {
      expect(countryScopedLawRoute(routeId)).toBeNull();
    }
    expect(countryScopedLawRoute(null)).toBeNull();
    expect(countryScopedLawRoute(undefined)).toBeNull();
  });

  test("matches the whole route id, not a word inside one", () => {
    // The research tables and the per-country reader both spell "cases"; a
    // substring rule would light the control up on all four.
    expect("/law/cases/research/$tableId").toContain(
      COUNTRY_SCOPED_LAW_ROUTE_IDS.cases,
    );
    expect(countryScopedLawRoute("/law/cases/research/$tableId")).toBeNull();
  });
});
