import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { FACT_SCORING } from "@/api/lib/lists/fact-details";
import { FACT_TIERS } from "@/api/lib/lists/source-kind";
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
const C = factId(3);

const standingArbitrary: fc.Arbitrary<FactStanding> = fc.record({
  scoring: fc.constantFrom(...FACT_SCORING),
  tier: fc.constantFrom(...FACT_TIERS),
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

  const FOOTING_QUALIFIERS = ["testimony-only", "unsourced-only"] as const;
  const footingOf = (resting: readonly FactStanding[]) =>
    kindsOf({ graded: [], resting }).filter((kind) =>
      FOOTING_QUALIFIERS.some((footing) => footing === kind),
    );

  test("a verdict no record backs discloses its footing exactly once", () => {
    assertProperty(
      "a verdict no record backs discloses its footing exactly once",
      fc.property(fc.array(standingArbitrary, { maxLength: 6 }), (resting) => {
        const footing = footingOf(resting);
        const recordBehind = resting.some((fact) => fact.tier === "document");
        if (resting.length === 0 || recordBehind) {
          expect(footing).toEqual([]);
          return;
        }
        // Any account among them makes it testimony; only when none is it
        // knowledge without a source.
        expect(footing).toEqual([
          resting.some((fact) => fact.tier === "testimony")
            ? "testimony-only"
            : "unsourced-only",
        ]);
      }),
    );
  });

  test("one document record among the resting facts lifts the disclosure", () => {
    assertProperty(
      "one document record among the resting facts lifts the disclosure",
      fc.property(
        fc.array(standingArbitrary, { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...FACT_SCORING),
        (resting, scoring) => {
          expect(
            footingOf([...resting, { scoring, tier: "document" }]),
          ).toEqual([]);
        },
      ),
    );
  });

  test("testimony beside an unsourced fact reads as testimony", () => {
    expect(
      footingOf([
        { scoring: "included", tier: "unsourced" },
        { scoring: "included", tier: "testimony" },
      ]),
    ).toEqual(["testimony-only"]);
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
        resting: [{ scoring: "held", tier: "unsourced" }],
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

  test("a held footing needs judgement; testimony and unsourced knowledge are disclosed, not doubted", () => {
    expect(QUALIFIER_REVIEW["rests-on-held"]).toBe("needs-judgement");
    expect(QUALIFIER_REVIEW["testimony-only"]).toBe("routine");
    expect(QUALIFIER_REVIEW["unsourced-only"]).toBe("routine");
    const read = (resting: FactStanding[]) =>
      claimQualifiers({ graded: [], resting });
    for (const tier of FACT_TIERS) {
      expect(
        qualifiersNeedJudgement(read([{ scoring: "included", tier }])),
      ).toBe(false);
      expect(qualifiersNeedJudgement(read([{ scoring: "held", tier }]))).toBe(
        true,
      );
    }
    expect(
      claimQualifiers({
        graded: [],
        resting: [{ scoring: "included", tier: "testimony" }],
      }),
    ).toEqual([
      { kind: "testimony-only", explanation: null, review: "routine" },
    ]);
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

  test("a scored verdict rests on the facts that support or conflict, never on context", () => {
    for (const state of ["supported", "tension", "contradicted"] as const) {
      expect(
        restingFactIds(
          {
            verdict: { state, score: 50, recordConflict: null },
            refs: [
              { factEntityId: A, rel: "supports" },
              { factEntityId: B, rel: "record" },
              { factEntityId: C, rel: "conflicts" },
            ],
          },
          null,
        ),
      ).toEqual([A, C]);
    }
  });

  // Regression: a document's record cited only as context hid the
  // testimony-only and unsourced-only qualifiers of a verdict resting on a
  // witness's account or on knowledge without a source.
  test("a document cited as context does not hide the footing the verdict rests on", () => {
    const standing: Record<string, FactStanding> = {
      [A]: { scoring: "included", tier: "testimony" },
      [B]: { scoring: "included", tier: "document" },
      [C]: { scoring: "included", tier: "unsourced" },
    };
    const qualifiersFor = (cited: ClaimRef[]) =>
      kindsOf({
        graded: [],
        resting: restingFactIds(
          {
            verdict: { state: "supported", score: 80, recordConflict: null },
            refs: cited,
          },
          null,
        ).map((id) => standing[id] ?? panic("fixture standing")),
      });
    expect(
      qualifiersFor([
        { factEntityId: A, rel: "supports" },
        { factEntityId: B, rel: "record" },
      ]),
    ).toEqual(["testimony-only"]);
    expect(
      qualifiersFor([
        { factEntityId: C, rel: "supports" },
        { factEntityId: B, rel: "record" },
      ]),
    ).toEqual(["unsourced-only"]);
    // A document the verdict does rest on still backs it.
    expect(
      qualifiersFor([
        { factEntityId: A, rel: "supports" },
        { factEntityId: B, rel: "supports" },
      ]),
    ).toEqual([]);
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
