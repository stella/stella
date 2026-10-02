import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toJsonObject } from "@/api/lib/json-value";

test("JSON conversion retains own object keys through persistence", () => {
  assertProperty(
    "JSON conversion retains own object keys through persistence",
    fc.property(
      fc.constantFrom("__proto__", "constructor", "toString"),
      fc.jsonValue(),
      (key, nested) => {
        const value = Object.fromEntries([[key, nested]]);
        const converted = toJsonObject(value);
        expect(JSON.stringify(converted)).toBe(JSON.stringify(value));
        expect(Object.hasOwn(converted, key)).toBe(true);
        expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
      },
    ),
  );
});
