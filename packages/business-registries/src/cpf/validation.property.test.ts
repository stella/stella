import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { registryString } from "../shared/property-test-helpers.test.js";
import { normalizeCpf, validateCpf } from "./validation.js";

const digits = fc.array(fc.integer({ min: 0, max: 9 }), {
  minLength: 9,
  maxLength: 9,
});

// Ascending positional weights are the complement of the usual descending
// weights modulo 11; the second digit includes the first at position 9.
const cpfDigits = (prefix: string): string => {
  const first =
    (prefix
      .split("")
      .reduce((sum, digit, index) => sum + Number(digit) * (index + 1), 0) %
      11) %
    10;
  const extended = `${prefix}${first}`;
  const second =
    (extended
      .split("")
      .reduce((sum, digit, index) => sum + Number(digit) * index, 0) %
      11) %
    10;
  return `${first}${second}`;
};

const numericCpf = fc.oneof(
  digits.map((value) => {
    const prefix = value.join("");
    return `${prefix}${cpfDigits(prefix)}`;
  }),
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 16 })
    .map((value) => value.join("")),
  fc.integer({ min: 0, max: 9 }).map((digit) => String(digit).repeat(11)),
);

const formatCpf = (value: string): string =>
  `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`;

describe("Brazilian personal identifiers", () => {
  test(
    "numeric and punctuated values agree with independent check digits",
    () => {
      fc.assert(
        fc.property(numericCpf, (value) => {
          const valid =
            /^\d{11}$/u.test(value) &&
            !/^(\d)\1{10}$/u.test(value) &&
            value.slice(9) === cpfDigits(value.slice(0, 9));
          expect(validateCpf(value)).toBe(valid);
          if (value.length === 11) {
            const formatted = formatCpf(value);
            expect(validateCpf(formatted)).toBe(valid);
            expect(normalizeCpf(formatted)).toBe(value);
          }
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );

  test(
    "normalization reaches a fixed point for hostile strings",
    () => {
      fc.assert(
        fc.property(registryString, (value) => {
          const normalized = normalizeCpf(value);
          expect(normalizeCpf(normalized)).toBe(normalized);
          expect(validateCpf(normalized)).toBe(validateCpf(value));
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );
});
