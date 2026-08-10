import { describe, expect, test } from "bun:test";

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
});
