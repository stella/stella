import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { registryString } from "../shared/property-test-helpers.test.js";
import { normalizeCnpj, validateCnpj } from "./validation.js";

const checkDigit = (prefix: string): string => {
  const remainder =
    [...prefix]
      .toReversed()
      .reduce(
        (sum, digit, index) => sum + Number(digit) * (2 + (index % 8)),
        0,
      ) % 11;
  return String(remainder < 2 ? 0 : 11 - remainder);
};

const cnpjDigits = (prefix: string): string => {
  const first = checkDigit(prefix);
  return `${first}${checkDigit(`${prefix}${first}`)}`;
};

const numericCnpj = fc.oneof(
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 12 })
    .map((value) => {
      const prefix = value.join("");
      return `${prefix}${cnpjDigits(prefix)}`;
    }),
  fc
    .array(fc.integer({ min: 0, max: 9 }), { minLength: 0, maxLength: 19 })
    .map((value) => value.join("")),
  fc.integer({ min: 0, max: 9 }).map((digit) => String(digit).repeat(14)),
);

const formatCnpj = (value: string): string =>
  `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`;

describe("Brazilian company identifiers", () => {
  test(
    "numeric and punctuated values agree with independent check digits",
    () => {
      fc.assert(
        fc.property(numericCnpj, (value) => {
          const valid =
            /^\d{14}$/u.test(value) &&
            !/^(\d)\1{13}$/u.test(value) &&
            value.slice(12) === cnpjDigits(value.slice(0, 12));
          expect(validateCnpj(value)).toBe(valid);
          if (value.length === 14) {
            const formatted = formatCnpj(value);
            expect(validateCnpj(formatted)).toBe(valid);
            expect(normalizeCnpj(formatted)).toBe(value);
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
          const normalized = normalizeCnpj(value);
          expect(normalizeCnpj(normalized)).toBe(normalized);
          expect(validateCnpj(normalized)).toBe(validateCnpj(value));
        }),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(5000),
  );
});
