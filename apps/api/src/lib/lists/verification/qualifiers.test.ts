import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { FACT_SCORING } from "@/api/lib/lists/fact-details";
import { CLAIM_STATES } from "@/api/lib/lists/verification/contract";
import type {
  ClaimRef,
  ClaimVerdict,
} from "@/api/lib/lists/verification/contract";
import {
  CLAIM_QUALIFIERS,
  claimQualifiers,
  GRADER_CLAIM_QUALIFIERS,
  graderQualifierFits,
  QUALIFIER_REVIEW,
  QUALIFIER_REVIEWS,
  qualifiersNeedJudgement,
  restingFactIds,
} from "@/api/lib/lists/verification/qualifiers";
import type {
  FactStanding,
  GraderClaimQualifier,
} from "@/api/lib/lists/verification/qualifiers";
import { EMPTY_CLAIM_REVIEW } from "@/api/lib/lists/verification/review-fold";
import type { ClaimReview } from "@/api/lib/lists/verification/review-fold";

const factId = (n: number) =>
  toSafeId<"entity">(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const A = factId(1);
const B = factId(2);

const standingArbitrary: fc.Arbitrary<FactStanding> = fc.record({
  scoring: fc.constantFrom(...FACT_SCORING),
  sourcing: fc.constantFrom("sourced" as const, "unsourced" as const),
});
const gradedArbitrary: fc.Arbitrary<GraderClaimQualifier[]> = fc.uniqueArray(
  fc.record({
    kind: fc.constantFrom(...GRADER_CLAIM_QUALIFIERS),
    explanation: fc.string({ minLength: 1, maxLength: 20 }),
  }),
  { selector: (qualifier) => qualifier.kind },
);

const kindsOf = (args: Parameters<typeof claimQualifiers>[0]) =>
  claimQualifiers(args).map((qualifier) => qualifier.kind);

describe("claimQualifiers", () => {
  test("each kind at most once, in the declared order", () => {
    assertProperty(
      "each kind at most once, in the declared order",
      fc.property(
        gradedArbitrary,
        fc.array(standingArbitrary, { maxLength: 6 }),
        (graded, resting) => {
          const kinds = kindsOf({ graded, resting });
          const order = kinds.map((kind) => CLAIM_QUALIFIERS.indexOf(kind));
          expect(new Set(kinds).size).toBe(kinds.length);
          expect(order).toEqual(order.toSorted((a, b) => a - b));
        },
      ),
    );
  });

  test("the facts a verdict rests on count as a set, not a sequence", () => {
    assertProperty(
      "the facts a verdict rests on count as a set, not a sequence",
      fc.property(
        gradedArbitrary,
        fc.array(standingArbitrary, { maxLength: 6 }),
        (graded, resting) => {
          expect(kindsOf({ graded, resting: resting.toReversed() })).toEqual(
            kindsOf({ graded, resting }),
          );
        },
      ),
    );
  });

  test("one sourced fact is enough to lift unsourced-only", () => {
    assertProperty(
      "one sourced fact is enough to lift unsourced-only",
      fc.property(
        fc.array(standingArbitrary, { maxLength: 6 }),
        fc.constantFrom(...FACT_SCORING),
        (resting, scoring) => {
          const unsourced = resting.map((fact) => ({
            ...fact,
            sourcing: "unsourced" as const,
          }));
          expect(kindsOf({ graded: [], resting: unsourced })).toEqual(
            expect.arrayContaining(
              unsourced.length > 0 ? ["unsourced-only"] : [],
            ),
          );
          expect(
            kindsOf({
              graded: [],
              resting: [...unsourced, { scoring, sourcing: "sourced" }],
            }),
          ).not.toContain("unsourced-only");
        },
      ),
    );
  });

  test("holding any one resting fact marks the verdict, releasing all clears it", () => {
    assertProperty(
      "holding any one resting fact marks the verdict, releasing all clears it",
      fc.property(
        fc.array(standingArbitrary, { minLength: 1, maxLength: 6 }),
        fc.nat(),
        (resting, pick) => {
          const included = resting.map((fact) => ({
            ...fact,
            scoring: "included" as const,
          }));
          expect(kindsOf({ graded: [], resting: included })).not.toContain(
            "rests-on-held",
          );
          const held = included.map((fact, index) =>
            index === pick % included.length
              ? { ...fact, scoring: "held" as const }
              : fact,
          );
          expect(kindsOf({ graded: [], resting: held })).toContain(
            "rests-on-held",
          );
        },
      ),
    );
  });

  test("a verdict resting on nothing carries only what the grader gave", () => {
    const graded: GraderClaimQualifier[] = [
      { kind: "record-silent", explanation: "Background only." },
    ];
    expect(claimQualifiers({ graded, resting: [] })).toEqual([
      { ...graded[0], review: "routine" },
    ]);
  });

  test("system qualifiers carry no explanation of their own", () => {
    expect(
      claimQualifiers({
        graded: [],
        resting: [{ scoring: "held", sourcing: "unsourced" }],
      }),
    ).toEqual([
      { kind: "unsourced-only", explanation: null, review: "routine" },
      { kind: "rests-on-held", explanation: null, review: "needs-judgement" },
    ]);
  });
});

describe("QUALIFIER_REVIEW", () => {
  // The map is total at compile time; this holds it to the closed list at
  // run time as well, so a qualifier is never routine by omission.
  test("every qualifier names the review it asks for", () => {
    expect(Object.keys(QUALIFIER_REVIEW).toSorted()).toEqual(
      [...CLAIM_QUALIFIERS].toSorted(),
    );
    for (const kind of CLAIM_QUALIFIERS) {
      expect(QUALIFIER_REVIEWS).toContain(QUALIFIER_REVIEW[kind]);
    }
  });

  test("a held footing needs judgement; unsourced knowledge is disclosed, not doubted", () => {
    expect(QUALIFIER_REVIEW["rests-on-held"]).toBe("needs-judgement");
    expect(QUALIFIER_REVIEW["unsourced-only"]).toBe("routine");
    const read = (resting: FactStanding[]) =>
      claimQualifiers({ graded: [], resting });
    expect(
      qualifiersNeedJudgement(
        read([{ scoring: "included", sourcing: "unsourced" }]),
      ),
    ).toBe(false);
    expect(
      qualifiersNeedJudgement(
        read([{ scoring: "held", sourcing: "unsourced" }]),
      ),
    ).toBe(true);
  });
});

describe("graderQualifierFits", () => {
  test("record-silent explains only missing coverage; scope-mismatch fits any verdict", () => {
    expect(
      CLAIM_STATES.filter((state) =>
        graderQualifierFits("record-silent", state),
      ),
    ).toEqual(["nocover"]);
    expect(
      CLAIM_STATES.filter((state) =>
        graderQualifierFits("scope-mismatch", state),
      ),
    ).toEqual([...CLAIM_STATES]);
  });
});

describe("restingFactIds", () => {
  const refs: ClaimRef[] = [
    { factEntityId: A, rel: "supports" },
    { factEntityId: B, rel: "record" },
  ];
  const conflict = {
    subject: "Meeting date",
    factEntityIds: [A, B] as const,
    values: ["9 March 2021", "3 May 2021"] as const,
    governingStates: ["supported", "contradicted"] as const,
  };
  const recordConflict: ClaimVerdict = {
    state: "recordconflict",
    score: null,
    recordConflict: conflict,
  };
  const review = (patch: Partial<ClaimReview>): ClaimReview => ({
    ...EMPTY_CLAIM_REVIEW,
    ...patch,
  });

  test("a scored verdict rests on every fact it cites", () => {
    expect(
      restingFactIds(
        {
          verdict: { state: "supported", score: 90, recordConflict: null },
          refs,
        },
        null,
      ),
    ).toEqual([A, B]);
  });

  test("missing coverage and a set-aside claim rest on nothing", () => {
    for (const state of ["nocover", "notverifiable"] as const) {
      expect(
        restingFactIds(
          { verdict: { state, score: null, recordConflict: null }, refs },
          review({ reopened: true }),
        ),
      ).toEqual([]);
    }
  });

  test("a record conflict rests only on the record a reviewer chose", () => {
    const target = { verdict: recordConflict, refs };
    expect(restingFactIds(target, null)).toEqual([]);
    expect(
      restingFactIds(
        target,
        review({ recordConflictResolution: { kind: "escalated" } }),
      ),
    ).toEqual([]);
    expect(
      restingFactIds(
        target,
        review({
          recordConflictResolution: { kind: "governed", factEntityId: B },
        }),
      ),
    ).toEqual([B] satisfies SafeId<"entity">[]);
  });

  test("an override annotates the verdict without moving what it rests on", () => {
    const target = {
      verdict: { state: "contradicted", score: 10, recordConflict: null },
      refs,
    } as const;
    expect(restingFactIds(target, review({ override: "supported" }))).toEqual(
      restingFactIds(target, null),
    );
  });
});
