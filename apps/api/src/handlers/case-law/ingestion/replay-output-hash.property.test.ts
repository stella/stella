import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { parsedOutputRequiresWrite } from "./replay";

const hash = fc
  .array(fc.constantFrom(...Array.from("0123456789abcdef")), {
    minLength: 64,
    maxLength: 64,
  })
  .map((digits) => digits.join(""));

test("a re-parse writes if and only if its parsed-output hash differs", () => {
  assertProperty(
    "a re-parse writes if and only if its parsed-output hash differs",
    fc.property(hash, hash, (storedHash, parsedHash) => {
      expect(parsedOutputRequiresWrite(storedHash, parsedHash)).toBe(
        storedHash !== parsedHash,
      );
    }),
  );
});
