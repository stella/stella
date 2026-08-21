import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import {
  assertPropertyDependencyReadWithinLimit,
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

  test("the workspace read is the linear product of the write-time caps", () => {
    // The per-property cap is a fixed fan-in, not derived from the column
    // cap, so raising the column cap grows this read linearly.
    expect(PROPERTY_DEPENDENCY_LIMITS.perProperty).toBe(
      LIMITS.propertyDependenciesPerProperty,
    );
    expect(PROPERTY_DEPENDENCY_LIMITS.perProperty).toBeLessThan(
      LIMITS.propertiesCount - 1,
    );
    expect(PROPERTY_DEPENDENCY_LIMITS.perWorkspace).toBe(
      PROPERTY_DEPENDENCY_LIMITS.ownersPerWorkspace *
        PROPERTY_DEPENDENCY_LIMITS.perProperty,
    );
  });
});
