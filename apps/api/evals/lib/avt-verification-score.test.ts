import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import sample from "../fixtures/avt-verification-sample.json" with { type: "json" };
import { matchLabelledSpan } from "./avt-verification-match";
import { scoreOutcomes } from "./avt-verification-score";
import type { ClaimOutcome, PredictedGrade } from "./avt-verification-score";
import { labelledSetSchema, labelProblems } from "./avt-verification-set";
import type { LabelledSet } from "./avt-verification-set";

const set: LabelledSet = v.parse(labelledSetSchema, sample);
const [item] = set.cases;
if (item === undefined) {
  throw new Error("The sample set has a case");
}

/** The answer a label describes: its verdict, its cited facts, its pair. */
const answerOf = (label: ClaimOutcome["label"]): PredictedGrade => ({
  state: label.verdict,
  refs: label.cites.map((factId) => ({ factId, rel: "supports" })),
  conflict: label.conflict ?? null,
  qualifiers: label.qualifiers,
});

const outcomes = (
  answer: (label: ClaimOutcome["label"]) => PredictedGrade | null,
): ClaimOutcome[] =>
  item.claims.map((label) => {
    const predicted = answer(label);
    return {
      setId: set.id,
      caseId: item.id,
      label,
      predicted,
      missedBecause: predicted === null ? "not-extracted" : null,
    };
  });

describe("verification eval scoring", () => {
  test("the sample set is well formed and covers every verdict", () => {
    expect(labelProblems(set)).toEqual([]);
    expect(new Set(item.claims.map((claim) => claim.verdict)).size).toBe(6);
  });

  test("the labels' own answers score full marks", () => {
    const card = scoreOutcomes(outcomes(answerOf));
    expect(card.accuracy).toEqual({ hits: 10, of: 10 });
    expect(card.strictAccuracy).toEqual({ hits: 10, of: 10 });
    expect(card.citationHit.hits).toBe(card.citationHit.of);
    expect(card.conflictPair).toEqual({ hits: 1, of: 1 });
    expect(card.falseNoCoverage.hits).toBe(0);
    expect(card.qualifiers["scope-mismatch"]?.recall).toEqual({
      hits: 1,
      of: 1,
    });
  });

  test("an accepted alternative is right but not strictly right", () => {
    const card = scoreOutcomes(
      outcomes((label) =>
        label.id === "c9"
          ? { ...answerOf(label), state: "tension" }
          : answerOf(label),
      ),
    );
    expect(card.accuracy.hits).toBe(10);
    expect(card.strictAccuracy.hits).toBe(9);
    expect(card.confusion.nocover.tension).toBe(1);
  });

  test("calling a checkable claim nocover counts as a false No coverage", () => {
    const card = scoreOutcomes(
      outcomes((label) =>
        label.id === "c3"
          ? { state: "nocover", refs: [], conflict: null, qualifiers: [] }
          : answerOf(label),
      ),
    );
    expect(card.falseNoCoverage).toEqual({ hits: 1, of: 8 });
    expect(card.perVerdict.contradicted.recall).toEqual({ hits: 0, of: 1 });
    expect(card.perVerdict.nocover.precision).toEqual({ hits: 2, of: 3 });
  });

  test("a citation outside the label's facts is a hit only when one is right", () => {
    const citing: Record<string, PredictedGrade["refs"]> = {
      // The right fact and an unrelated one.
      c1: [
        { factId: "F1", rel: "supports" },
        { factId: "F8", rel: "supports" },
      ],
      // Only an unrelated fact.
      c4: [{ factId: "F5", rel: "supports" }],
    };
    const card = scoreOutcomes(
      outcomes((label) => ({
        ...answerOf(label),
        refs: citing[label.id] ?? answerOf(label).refs,
      })),
    );
    expect(card.citationHit.of - card.citationHit.hits).toBe(1);
    expect(card.citationClean.of - card.citationClean.hits).toBe(2);
  });

  test("a missed claim is wrong, and uncertain labels stay out of the headline", () => {
    const uncertain = outcomes((label) =>
      label.id === "c2" ? null : answerOf(label),
    ).map((outcome) =>
      outcome.label.id === "c5"
        ? {
            ...outcome,
            label: { ...outcome.label, uncertain: true },
            predicted: {
              ...answerOf(outcome.label),
              state: "supported" as const,
            },
          }
        : outcome,
    );
    const card = scoreOutcomes(uncertain);
    expect(card.scored).toBe(9);
    expect(card.missed).toBe(1);
    expect(card.accuracy).toEqual({ hits: 8, of: 9 });
    expect(card.confusion.supported.missed).toBe(1);
    expect(card.uncertainAccuracy).toEqual({ hits: 0, of: 1 });
  });
});

describe("matching a labelled claim to an extracted one", () => {
  const label = { passageIndex: 2, start: 10, end: 30 };

  test("picks the extracted claim covering most of the label's words", () => {
    expect(
      matchLabelledSpan(label, [
        { passageIndex: 2, start: 0, end: 18 },
        { passageIndex: 2, start: 12, end: 40 },
        { passageIndex: 3, start: 10, end: 30 },
      ]),
    ).toBe(1);
  });

  test("covering less than half, or another passage, is no match", () => {
    expect(
      matchLabelledSpan(label, [
        { passageIndex: 2, start: 25, end: 60 },
        { passageIndex: 1, start: 10, end: 30 },
      ]),
    ).toBeNull();
  });
});

describe("a set's labels", () => {
  test("refuses unknown facts, misplaced quotes and conflicts without a pair", () => {
    const [first, second] = item.claims;
    if (first === undefined || second === undefined) {
      throw new Error("The sample case has claims");
    }
    const broken: LabelledSet = {
      ...set,
      cases: [
        {
          ...item,
          claims: [
            { ...first, cites: ["F99"] },
            { ...second, paragraph: 1 },
            { ...first, id: "c-conflict", verdict: "recordconflict" },
          ],
        },
      ],
    };
    expect(labelProblems(broken)).toEqual([
      "harbour-supply/c1: names unknown fact F99",
      "harbour-supply/c2: quote is not in its paragraph",
      "harbour-supply/c-conflict: a record conflict, and only one, names its two facts",
    ]);
  });
});
