import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  estimateSimilarity,
  lshBandKeys,
  MIN_WORDS,
  minHashSeeds,
  minHashSignature,
  NEAR_DUPLICATE_THRESHOLD,
  signatureFromBytes,
  signatureToBytes,
} from "@/api/lib/uploads/near-duplicates/minhash";

const SEEDS = minHashSeeds("organization-a");

const word = fc.stringMatching(/^[a-z]{3,9}$/u);

const text = fc
  .array(word, { minLength: MIN_WORDS, maxLength: 400 })
  .map((words) => words.join(" "));

const signatureOf = (value: string): Uint32Array => {
  const signature = minHashSignature(value, SEEDS);
  if (!signature) {
    throw new Error("expected a signature");
  }
  return signature;
};

describe("near-duplicate MinHash (properties)", () => {
  test("identical text has similarity 1 and identical band keys", () => {
    assertProperty(
      "identical text has similarity 1 and identical band keys",
      fc.property(text, (value) => {
        const left = signatureOf(value);
        const right = signatureOf(value);
        expect(estimateSimilarity(left, right)).toBe(1);
        expect(lshBandKeys(left)).toEqual(lshBandKeys(right));
      }),
      { numRuns: 100 },
    );
  });

  test("case, accents and whitespace do not change the signature", () => {
    assertProperty(
      "case, accents and whitespace do not change the signature",
      fc.property(text, (value) => {
        const reformatted = value
          .toUpperCase()
          .replaceAll("E", "É")
          .replaceAll(" ", "\n  ");
        expect([...signatureOf(reformatted)]).toEqual([...signatureOf(value)]);
      }),
      { numRuns: 100 },
    );
  });

  test("a signature survives its byte encoding", () => {
    assertProperty(
      "a signature survives its byte encoding",
      fc.property(text, (value) => {
        const signature = signatureOf(value);
        expect([...signatureFromBytes(signatureToBytes(signature))]).toEqual([
          ...signature,
        ]);
      }),
      { numRuns: 50 },
    );
  });

  test("the estimate does not depend on comparison order", () => {
    assertProperty(
      "the estimate does not depend on comparison order",
      fc.property(text, text, (first, second) => {
        const left = signatureOf(first);
        const right = signatureOf(second);
        expect(estimateSimilarity(left, right)).toBe(
          estimateSimilarity(right, left),
        );
      }),
      { numRuns: 100 },
    );
  });

  test("unrelated random texts stay below the threshold", () => {
    assertProperty(
      "unrelated random texts stay below the threshold",
      fc.property(text, text, (first, second) => {
        fc.pre(first !== second);
        expect(
          estimateSimilarity(signatureOf(first), signatureOf(second)),
        ).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
      }),
      { numRuns: 100 },
    );
  });
});
