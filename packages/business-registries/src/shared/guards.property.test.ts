import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { hasOptionalNumber, hasOptionalString, isRecord } from "./guards.js";
import {
  registryExtras,
  registryString,
  registryValue,
} from "./property-test-helpers.test.js";

const recordShape = fc.oneof(
  registryExtras.map((value) => ({ value, accepted: true })),
  fc
    .array(registryValue, { maxLength: 8 })
    .map((value) => ({ value, accepted: false })),
  fc
    .oneof(
      registryString,
      fc.boolean(),
      fc.double(),
      fc.constant(null),
      fc.constant(undefined),
    )
    .map((value) => ({ value, accepted: false })),
);

const optionalField = fc.oneof(
  registryString.map((value) => ({ value, string: true, number: false })),
  fc.double().map((value) => ({ value, string: false, number: true })),
  fc.constant({ value: undefined, string: true, number: true }),
  fc
    .oneof(
      fc.constant(null),
      fc.boolean(),
      registryExtras,
      fc.array(registryValue, { maxLength: 5 }),
    )
    .map((value) => ({ value, string: false, number: false })),
);

describe("registry response shapes", () => {
  test(
    "only object records pass the structural boundary",
    () => {
      fc.assert(
        fc.property(recordShape, ({ value, accepted }) => {
          expect(isRecord(value)).toBe(accepted);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "optional fields accept absent values and their declared primitive type",
    () => {
      fc.assert(
        fc.property(registryString, optionalField, (key, field) => {
          const record = { [key]: field.value };
          expect(hasOptionalString(record, key)).toBe(field.string);
          expect(hasOptionalNumber(record, key)).toBe(field.number);
          expect(hasOptionalString(record, `${key}\u0000absent`)).toBe(true);
          expect(hasOptionalNumber(record, `${key}\u0000absent`)).toBe(true);
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );
});
