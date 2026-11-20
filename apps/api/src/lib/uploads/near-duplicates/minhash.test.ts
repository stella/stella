import { describe, expect, test } from "bun:test";

import {
  estimateSimilarity,
  lshBandKeys,
  MIN_WORDS,
  minHashSeeds,
  minHashSignature,
  NEAR_DUPLICATE_THRESHOLD,
} from "@/api/lib/uploads/near-duplicates/minhash";

const SEEDS = minHashSeeds("organization-a");

const CLAUSES = [
  "The Supplier shall deliver the Goods to the Delivery Address on the Delivery Date stated in the Order.",
  "Risk in the Goods passes to the Customer on completion of delivery, and title passes on payment in full.",
  "The Customer shall pay each invoice within thirty days of its date by transfer to the account the Supplier names.",
  "Either party may terminate this Agreement by written notice if the other commits a material breach it does not remedy within fourteen days.",
  "Neither party limits its liability for death or personal injury caused by its negligence, or for fraud.",
  "This Agreement is governed by the law of England and Wales and the courts of London have exclusive jurisdiction.",
  "Any notice under this Agreement must be in writing and delivered by hand, by recorded post or by email to the address in the Schedule.",
  "The Supplier warrants that the Goods conform to their description, are of satisfactory quality and are fit for any stated purpose.",
];

const contract = CLAUSES.join("\n\n");

const signature = (text: string): Uint32Array => {
  const value = minHashSignature(text, SEEDS);
  if (!value) {
    throw new Error("expected a signature");
  }
  return value;
};

describe("minHashSignature", () => {
  test("returns null below the minimum word count", () => {
    const short = Array.from({ length: MIN_WORDS - 1 }, () => "clause").join(
      " ",
    );
    expect(minHashSignature(short, SEEDS)).toBeNull();
  });

  test("the same text in another organization shares no band key", () => {
    const other = minHashSignature(contract, minHashSeeds("organization-b"));
    if (!other) {
      throw new Error("expected a signature");
    }
    expect(estimateSimilarity(signature(contract), other)).toBeLessThan(0.1);
    const otherKeys = new Set(lshBandKeys(other));
    expect(
      lshBandKeys(signature(contract)).some((key) => otherKeys.has(key)),
    ).toBe(false);
  });

  test("a PDF-style re-flow of the same text is a full match", () => {
    const reflowed = contract.replaceAll(" ", "\n").replaceAll(",", " ,");
    expect(estimateSimilarity(signature(contract), signature(reflowed))).toBe(
      1,
    );
  });

  test("one changed clause stays above the threshold and shares a band", () => {
    const edited = contract.replace("thirty days", "sixty days");
    const left = signature(contract);
    const right = signature(edited);
    expect(estimateSimilarity(left, right)).toBeGreaterThanOrEqual(
      NEAR_DUPLICATE_THRESHOLD,
    );
    const rightKeys = new Set(lshBandKeys(right));
    expect(lshBandKeys(left).some((key) => rightKeys.has(key))).toBe(true);
  });

  test("a different contract of the same type falls below the threshold", () => {
    const other = CLAUSES.toReversed().map((clause) =>
      clause.split(" ").toReversed().join(" "),
    );
    expect(
      estimateSimilarity(signature(contract), signature(other.join(" "))),
    ).toBeLessThan(NEAR_DUPLICATE_THRESHOLD);
  });
});
