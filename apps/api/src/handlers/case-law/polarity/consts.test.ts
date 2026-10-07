import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  AI_CITATION_REVIEW_ORIGINS,
  CITATION_REVIEW_ORIGIN,
  CITATION_REVIEW_ORIGINS,
  citationReviewMayReplace,
  citationReviewOutranks,
} from "@/api/handlers/case-law/polarity/consts";
import type { CitationReviewStanding } from "@/api/handlers/case-law/polarity/consts";

const EPOCH = Temporal.Instant.from("2026-10-07T08:00:00Z");

/** A few instants only, so equal `producedAt` pairs are common. */
const standingArb: fc.Arbitrary<CitationReviewStanding> = fc.oneof(
  fc.constant({ origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW }),
  fc.record({
    origin: fc.constantFrom(...AI_CITATION_REVIEW_ORIGINS),
    producedAt: fc
      .integer({ min: 0, max: 3 })
      .map((minutes) => EPOCH.add({ minutes })),
  }),
);

const rankOf = (standing: CitationReviewStanding): number =>
  CITATION_REVIEW_ORIGINS.indexOf(standing.origin);

describe("review origin precedence", () => {
  test("a better origin replaces a worse one, never the reverse, whatever was produced when", () => {
    assertProperty(
      "citation-review-precedence-across-origins",
      fc.property(standingArb, standingArb, (stored, incoming) => {
        fc.pre(stored.origin !== incoming.origin);
        // The declared order is human, adjudicated, annotation.
        const replaces = rankOf(incoming) < rankOf(stored);
        expect(citationReviewMayReplace({ stored, incoming })).toBe(replaces);
        expect(
          citationReviewMayReplace({ stored: incoming, incoming: stored }),
        ).toBe(!replaces);
      }),
    );
  });

  test("at one model origin only a later label replaces, so an older run applied late is refused", () => {
    assertProperty(
      "citation-review-precedence-same-ai-origin-produced-at",
      fc.property(
        fc.constantFrom(...AI_CITATION_REVIEW_ORIGINS),
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        (origin, storedMinute, incomingMinute) => {
          const stored = {
            origin,
            producedAt: EPOCH.add({ minutes: storedMinute }),
          };
          const incoming = {
            origin,
            producedAt: EPOCH.add({ minutes: incomingMinute }),
          };
          expect(citationReviewMayReplace({ stored, incoming })).toBe(
            incomingMinute > storedMinute,
          );
          // An identical instant orders neither way: a different run at the
          // same instant cannot flip a label in either direction.
          if (incomingMinute === storedMinute) {
            expect(
              citationReviewMayReplace({ stored: incoming, incoming: stored }),
            ).toBe(false);
          }
        },
      ),
    );
  });

  test("a human review replaces a human review, and no model label replaces one", () => {
    assertProperty(
      "citation-review-precedence-human-review",
      fc.property(standingArb, (incoming) => {
        const human = { origin: CITATION_REVIEW_ORIGIN.HUMAN_REVIEW };
        expect(citationReviewMayReplace({ stored: human, incoming })).toBe(
          incoming.origin === CITATION_REVIEW_ORIGIN.HUMAN_REVIEW,
        );
      }),
    );
  });

  test("outranking is a strict order", () => {
    assertProperty(
      "citation-review-outranks-strict-order",
      fc.property(
        standingArb,
        standingArb,
        standingArb,
        (first, second, third) => {
          expect(citationReviewOutranks({ upper: first, lower: first })).toBe(
            false,
          );
          if (citationReviewOutranks({ upper: first, lower: second })) {
            expect(
              citationReviewOutranks({ upper: second, lower: first }),
            ).toBe(false);
            if (citationReviewOutranks({ upper: second, lower: third })) {
              expect(
                citationReviewOutranks({ upper: first, lower: third }),
              ).toBe(true);
            }
          }
        },
      ),
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
