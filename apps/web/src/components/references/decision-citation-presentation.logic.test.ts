import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { decisionCitationPresentations } from "./decision-citation-presentation.logic";
import type { DecisionCitationIdentity } from "./decision-citation-presentation.logic";

const GENERATOR_MIN_NONEMPTY_LENGTH = 1;
const GENERATOR_MAX_COURT_CODE_LENGTH = 6;
const GENERATOR_MAX_COURT_CODES = 3;
const GENERATOR_MAX_DECISIONS = 8;
const GENERATOR_MAX_CASE_NUMBER_LENGTH = 24;
const GENERATOR_MAX_PASSAGE_LENGTH = 64;
const GENERATOR_MAX_CITATIONS = 36;

const canonicalDecisions = fc
  .uniqueArray(
    fc.string({
      minLength: GENERATOR_MIN_NONEMPTY_LENGTH,
      maxLength: GENERATOR_MAX_COURT_CODE_LENGTH,
    }),
    {
      minLength: GENERATOR_MIN_NONEMPTY_LENGTH,
      maxLength: GENERATOR_MAX_COURT_CODES,
    },
  )
  .chain((courtCodes) =>
    fc.uniqueArray(
      fc.record({
        decisionId: fc.uuid(),
        courtShortCode: fc.constantFrom(...courtCodes),
      }),
      {
        selector: ({ decisionId }) => decisionId,
        minLength: GENERATOR_MIN_NONEMPTY_LENGTH,
        maxLength: GENERATOR_MAX_DECISIONS,
      },
    ),
  );

const answerCitations = canonicalDecisions.chain((decisions) =>
  fc
    .array(
      fc.record({
        decisionIndex: fc.integer({ min: 0, max: decisions.length - 1 }),
        caseNumber: fc.string({ maxLength: GENERATOR_MAX_CASE_NUMBER_LENGTH }),
        passage: fc.string({ maxLength: GENERATOR_MAX_PASSAGE_LENGTH }),
      }),
      { maxLength: GENERATOR_MAX_CITATIONS },
    )
    .map(
      (citations) =>
        citations.map(({ decisionIndex, ...text }) => {
          const identity = decisions.at(decisionIndex);
          if (identity === undefined) {
            return panic(
              "Generated citations must refer to a generated decision",
            );
          }
          return { ...identity, ...text };
        }) satisfies DecisionCitationIdentity[],
    ),
);

test("decision citations expand exactly when their code names distinct canonical decisions", () => {
  assertProperty(
    "decision citations expand exactly when their code names distinct canonical decisions",
    fc.property(answerCitations, (citations) => {
      const before = structuredClone(citations);
      const presentations = decisionCitationPresentations(citations);
      expect(presentations).toHaveLength(citations.length);
      for (const [index, citation] of citations.entries()) {
        // Pairwise identity comparison is independent of the production grouping.
        const ambiguous = citations.some(
          (other) =>
            other.courtShortCode === citation.courtShortCode &&
            other.decisionId !== citation.decisionId,
        );
        expect(presentations.at(index)).toBe(
          ambiguous ? "expanded" : "compact",
        );
      }
      expect(citations).toEqual(before);
    }),
    { numRuns: 150 },
  );
});

test("decision citation presentation is independent of citation order", () => {
  assertProperty(
    "decision citation presentation is independent of citation order",
    fc.property(
      answerCitations.chain((citations) =>
        fc.tuple(
          fc.constant(citations),
          fc.shuffledSubarray(citations, {
            minLength: citations.length,
            maxLength: citations.length,
          }),
        ),
      ),
      ([citations, reordered]) => {
        const before = decisionCitationPresentations(citations);
        const after = decisionCitationPresentations(reordered);
        for (const [index, citation] of reordered.entries()) {
          const originalIndex = citations.findIndex(
            (original) =>
              original.decisionId === citation.decisionId &&
              original.courtShortCode === citation.courtShortCode,
          );
          expect(originalIndex).toBeGreaterThanOrEqual(0);
          expect(after.at(index)).toBe(before.at(originalIndex));
        }
      },
    ),
    { numRuns: 150 },
  );
});

test("repeating a decision with different citation text cannot change its presentation", () => {
  assertProperty(
    "repeating a decision with different citation text cannot change its presentation",
    fc.property(
      answerCitations,
      fc.string(),
      fc.string(),
      (citations, caseNumber, passage) => {
        const original = decisionCitationPresentations(citations);
        const repeated = decisionCitationPresentations([
          ...citations,
          ...citations.map((citation) => ({
            ...citation,
            caseNumber,
            passage,
          })),
        ]);
        expect(repeated).toEqual([...original, ...original]);
      },
    ),
    { numRuns: 150 },
  );
});
