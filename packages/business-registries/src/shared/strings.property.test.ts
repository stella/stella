import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { trimToNull } from "./strings.js";
import { registryValue } from "./tests/test-helpers.js";

describe("optional registry strings", () => {
  test(
    "normalization preserves nonempty text and reaches a fixed point",
    () => {
      assertProperty(
        "normalization preserves nonempty text and reaches a fixed point",
        fc.property(registryValue, (value) => {
          const normalized = trimToNull(value);
          expect(trimToNull(normalized)).toBe(normalized);
          if (typeof value !== "string" || /^\s*$/u.test(value)) {
            expect(normalized).toBeNull();
            return;
          }
          expect(normalized).toBe(value.replace(/^\s+|\s+$/gu, ""));
        }),
        { seed: propertySeed() },
      );
    },
    propertyTestTimeout(5000),
  );
});
