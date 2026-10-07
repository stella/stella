import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  AI_CITATION_REVIEW_ORIGINS,
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGINS,
  citationReviewMayReplace,
} from "@/api/handlers/case-law/polarity/consts";

const originArb = fc.constantFrom(...CITATION_REVIEW_ORIGINS);

describe("review origin precedence", () => {
  test("a review replaces a stored one exactly when its origin ranks no lower", () => {
    assertProperty(
      "a review replaces a stored one exactly when its origin ranks no lower",
      fc.property(originArb, originArb, (stored, incoming) => {
        const replaces = citationReviewMayReplace({ stored, incoming });
        // The declared order is human, adjudicated, annotation.
        expect(replaces).toBe(
          CITATION_REVIEW_ORIGINS.indexOf(incoming) <=
            CITATION_REVIEW_ORIGINS.indexOf(stored),
        );
        if (stored !== incoming) {
          expect(
            citationReviewMayReplace({ stored: incoming, incoming: stored }),
          ).toBe(!replaces);
        }
        if (
          stored === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW &&
          incoming !== CITATION_REVIEW_ORIGIN.HUMAN_REVIEW
        ) {
          expect(replaces).toBe(false);
        }
      }),
    );
  });

  test("the declared order is human review, then adjudication, then annotation", () => {
    expect(CITATION_REVIEW_ORIGINS).toEqual([
      CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
      CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
      CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
    ]);
    expect(AI_CITATION_REVIEW_ORIGINS).toEqual([
      CITATION_REVIEW_ORIGIN.AI_ADJUDICATED,
      CITATION_REVIEW_ORIGIN.AI_ANNOTATION,
    ]);
  });
});
