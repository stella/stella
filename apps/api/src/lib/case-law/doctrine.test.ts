import { describe, expect, test } from "bun:test";

import {
  DOCTRINAL_TREATMENTS,
  DOCTRINE_GUIDANCE,
} from "@stll/api-contract/case-law-doctrine";

import {
  caseLawCitationDoctrineReviews,
  caseLawCitations,
} from "@/api/db/schema";

describe("reviewed doctrine vocabulary", () => {
  test("binds persisted domains and every reading criterion to the contract", () => {
    expect([...caseLawCitations.doctrinalTreatment.enumValues]).toEqual([
      ...DOCTRINAL_TREATMENTS,
    ]);
    expect([
      ...caseLawCitationDoctrineReviews.doctrinalTreatment.enumValues,
    ]).toEqual([...DOCTRINAL_TREATMENTS]);
    expect(Object.keys(DOCTRINE_GUIDANCE).toSorted()).toEqual(
      [...DOCTRINAL_TREATMENTS].toSorted(),
    );
  });
});
