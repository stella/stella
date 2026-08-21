import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import {
  assertPropertyDependencyReadWithinLimit,
  dependencyCountExceedsCap,
  PROPERTY_DEPENDENCY_LIMITS,
  propertyDependencyReadLimit,
} from "@/api/lib/properties/dependency-limits";

describe("property dependency read limits", () => {
  for (const scope of [
    "perProperty",
    "perWorkspace",
    "ownersPerWorkspace",
  ] as const) {
    test(`${scope} accepts the maximum and detects the first overflowing row`, () => {
      const maximum = PROPERTY_DEPENDENCY_LIMITS[scope];

      expect(propertyDependencyReadLimit(scope)).toBe(maximum + 1);
      expect(() =>
        assertPropertyDependencyReadWithinLimit(maximum, scope),
      ).not.toThrow();
      expect(() =>
        assertPropertyDependencyReadWithinLimit(maximum + 1, scope),
      ).toThrow(`Property dependency ${scope} invariant exceeded`);
    });
  }

  test("the read ceiling is structural and admits lists written under an earlier cap", () => {
    // One row per other column at most (unique pair, no self reference), so
    // the ceiling follows the column cap while the write cap stays below it.
    expect(PROPERTY_DEPENDENCY_LIMITS.perProperty).toBe(
      LIMITS.propertiesCount - 1,
    );
    expect(LIMITS.propertyDependenciesPerProperty).toBeLessThan(
      PROPERTY_DEPENDENCY_LIMITS.perProperty,
    );
    expect(PROPERTY_DEPENDENCY_LIMITS.perWorkspace).toBe(
      PROPERTY_DEPENDENCY_LIMITS.ownersPerWorkspace *
        PROPERTY_DEPENDENCY_LIMITS.perProperty,
    );
  });
});

describe("dependency write cap", () => {
  const cap = LIMITS.propertyDependenciesPerProperty;

  test("a create admits the cap and rejects one more", () => {
    expect(dependencyCountExceedsCap({ incoming: cap, stored: 0 })).toBe(false);
    expect(dependencyCountExceedsCap({ incoming: cap + 1, stored: 0 })).toBe(
      true,
    );
  });

  test("a stored list past the cap may be kept or shrunk but not grown", () => {
    const stored = cap + 4;
    expect(dependencyCountExceedsCap({ incoming: stored, stored })).toBe(false);
    expect(dependencyCountExceedsCap({ incoming: stored - 1, stored })).toBe(
      false,
    );
    expect(dependencyCountExceedsCap({ incoming: stored + 1, stored })).toBe(
      true,
    );
  });
});
