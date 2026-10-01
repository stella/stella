import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { registryValue } from "./property-test-helpers.test.js";
import { trimToNull } from "./strings.js";

describe("optional registry strings", () => {
  test(
    "normalization preserves nonempty text and reaches a fixed point",
    () => {
      fc.assert(
        fc.property(registryValue, (value) => {
          const normalized = trimToNull(value);
          expect(trimToNull(normalized)).toBe(normalized);
          if (typeof value !== "string" || /^\s*$/u.test(value)) {
            expect(normalized).toBeNull();
            return;
          }
          expect(normalized).toBe(value.replace(/^\s+|\s+$/gu, ""));
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );
});
