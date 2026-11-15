import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  ClaimRef,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import {
  claimStaleness,
  gradePins,
  listFactsNow,
  NEW_FACT_REASONS_MAX,
  STALENESS_REASON_KINDS,
} from "@/api/lib/lists/verification/staleness";
import type {
  StalenessReason,
  StalenessTarget,
} from "@/api/lib/lists/verification/staleness";

const factId = (index: number) =>
  toSafeId<"entity">(
    `0199a3c4-5b6d-7e8f-9a0b-${String(index).padStart(12, "0")}`,
  );
const documentId = (index: number) =>
  toSafeId<"entity">(
    `0199a3c4-5b6d-7e8f-9a0c-${String(index).padStart(12, "0")}`,
  );

/** Words no other fact or claim of a fixture uses: fact `index` speaks of
 *  its own point only. */
const ownWords = (index: number) =>
  `subject${String(index)}alpha subject${String(index)}bravo subject${String(index)}charlie`;

const fact = (
  index: number,
  overrides: Partial<VerificationEvidenceFact> = {},
): VerificationEvidenceFact => ({
  factEntityId: factId(index),
  text: `Record of ${ownWords(index)}`,
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  confidence: "high",
  interpretationNote: null,
  sources: [
    {
      sourceEntityId: documentId(index),
      sourceEntityVersionId: toSafeId<"entityVersion">(
        `0199a3c4-5b6d-7e8f-9a0d-${String(index).padStart(12, "0")}`,
      ),
      sourceName: `Bundle ${String(index)}.pdf`,
      locator: { type: "document" },
      quote: null,
    },
  ],
  ...overrides,
});

const supports = (index: number): ClaimRef => ({
  factEntityId: factId(index),
  rel: "supports",
});

type ClaimFixture = { cites: readonly number[] };

const target = (
  claim: ClaimFixture,
  pinned: readonly VerificationEvidenceFact[],
  overrides: Partial<StalenessTarget> = {},
): StalenessTarget => ({
  text: `The witness says ${claim.cites.map(ownWords).join(" and ")}.`,
  grade: { refs: claim.cites.map(supports), recordConflict: null },
  pins: gradePins(pinned),
  linkedFactIds: [],
  recheckable: true,
  ...overrides,
});

/** Every way a fact can change on the list after a grade read it. */
const MUTATIONS = {
  "edit-text": {
    reason: "fact-changed",
    apply: (current: VerificationEvidenceFact) => ({
      scored: { ...current, text: `${current.text} (corrected)` },
    }),
  },
  "edit-details": {
    reason: "fact-changed",
    apply: (current: VerificationEvidenceFact) => ({
      scored: {
        ...current,
        occurredOn: "2021-08-23",
        occurredOnPrecision: "day" as const,
      },
    }),
  },
  "change-source": {
    reason: "fact-changed",
    apply: (current: VerificationEvidenceFact) => ({
      scored: { ...current, sources: [] },
    }),
  },
  hold: { reason: "fact-held", apply: () => ({ held: true }) },
  remove: { reason: "fact-removed", apply: () => ({}) },
} as const satisfies Record<
  string,
  {
    reason: StalenessReason["kind"];
    apply: (current: VerificationEvidenceFact) => {
      scored?: VerificationEvidenceFact;
      held?: true;
    };
  }
>;
type MutationKind = keyof typeof MUTATIONS;
const MUTATION_KINDS = [
  "edit-text",
  "edit-details",
  "change-source",
  "hold",
  "remove",
] as const satisfies readonly MutationKind[];

test("every mutation kind is drawn", () => {
  expect(new Set<string>(MUTATION_KINDS)).toEqual(
    new Set(Object.keys(MUTATIONS)),
  );
});

/** The list after one fact changed in one way; every other fact as read. */
const mutated = (
  pinned: readonly VerificationEvidenceFact[],
  index: number,
  kind: MutationKind,
) => {
  const scored: VerificationEvidenceFact[] = [];
  const held: SafeId<"entity">[] = [];
  for (const entry of pinned) {
    if (entry.factEntityId !== factId(index)) {
      scored.push(entry);
      continue;
    }
    const change: { scored?: VerificationEvidenceFact; held?: true } =
      MUTATIONS[kind].apply(entry);
    if (change.scored !== undefined) {
      scored.push(change.scored);
    }
    if (change.held === true) {
      held.push(entry.factEntityId);
    }
  }
  return { scored, held };
};

const listArbitrary = fc.integer({ min: 1, max: 8 }).chain((factCount) =>
  fc.record({
    factCount: fc.constant(factCount),
    claims: fc.array(
      fc.record({
        cites: fc.uniqueArray(fc.integer({ min: 0, max: factCount - 1 }), {
          maxLength: 3,
        }),
      }),
      { minLength: 1, maxLength: 8 },
    ),
    changed: fc.integer({ min: 0, max: factCount - 1 }),
    kind: fc.constantFrom(...MUTATION_KINDS),
  }),
);

describe("claim staleness", () => {
  test("the reason kinds are exactly the ones the mutations produce", () => {
    expect(
      new Set([
        ...Object.values(MUTATIONS).map((mutation) => mutation.reason),
        "new-fact-related",
      ]),
    ).toEqual(new Set(STALENESS_REASON_KINDS));
  });

  test("every fact mutation marks exactly the claims whose grade cites that fact", () => {
    assertProperty(
      "every fact mutation marks exactly the claims whose grade cites that fact",
      fc.property(listArbitrary, ({ factCount, claims, changed, kind }) => {
        const pinned = Array.from({ length: factCount }, (_, index) =>
          fact(index),
        );
        const now = listFactsNow(mutated(pinned, changed, kind));
        for (const claim of claims) {
          const reasons = claimStaleness(target(claim, pinned), now);
          expect(reasons).toEqual(
            claim.cites.includes(changed)
              ? [
                  {
                    kind: MUTATIONS[kind].reason,
                    factEntityId: factId(changed),
                    text: expect.any(String),
                  },
                ]
              : [],
          );
        }
      }),
    );
  });

  test("a re-check against the list as it stands clears every reason", () => {
    assertProperty(
      "a re-check against the list as it stands clears every reason",
      fc.property(listArbitrary, ({ factCount, claims, changed, kind }) => {
        const pinned = Array.from({ length: factCount }, (_, index) =>
          fact(index),
        );
        const list = mutated(pinned, changed, kind);
        // A fact added since, on the very point of every claim.
        const added = fact(factCount, {
          text: claims.flatMap((claim) => claim.cites.map(ownWords)).join(" "),
        });
        const now = listFactsNow({ ...list, scored: [...list.scored, added] });
        const still = new Set(list.scored.map((entry) => entry.factEntityId));
        for (const claim of claims) {
          // The re-check cites what is still scored and pins the whole list.
          const recheck = {
            cites: claim.cites.filter((index) => still.has(factId(index))),
          };
          expect(
            claimStaleness(target(recheck, [...list.scored, added]), now),
          ).toEqual([]);
        }
      }),
    );
  });

  test("a fact added on an unrelated point marks no claim", () => {
    assertProperty(
      "a fact added on an unrelated point marks no claim",
      fc.property(listArbitrary, ({ factCount, claims }) => {
        const pinned = Array.from({ length: factCount }, (_, index) =>
          fact(index),
        );
        // Its own words and its own document: nothing a claim cites.
        const now = listFactsNow({
          scored: [...pinned, fact(factCount + 1)],
          held: [],
        });
        for (const claim of claims) {
          expect(claimStaleness(target(claim, pinned), now)).toEqual([]);
        }
      }),
    );
  });

  test("renaming a source document changes no fact", () => {
    const pinned = [fact(0)];
    const renamed = fact(0);
    const now = listFactsNow({
      scored: [
        {
          ...renamed,
          sources: renamed.sources.map((source) => ({
            ...source,
            sourceName: "Renamed bundle.pdf",
          })),
        },
      ],
      held: [],
    });
    expect(claimStaleness(target({ cites: [0] }, pinned), now)).toEqual([]);
  });

  test("a record conflict is out of date when either record changes", () => {
    const pinned = [fact(0), fact(1)];
    const grade = {
      refs: [],
      recordConflict: {
        subject: "Date of the payment",
        factEntityIds: [factId(0), factId(1)] as const,
        values: ["23 August", "25 August"] as const,
        governingStates: ["supported", "contradicted"] as const,
      },
    };
    const now = listFactsNow(mutated(pinned, 1, "remove"));
    expect(
      claimStaleness(target({ cites: [] }, pinned, { grade }), now),
    ).toEqual([
      { kind: "fact-removed", factEntityId: factId(1), text: fact(1).text },
    ]);
  });

  test("a claim set aside as not verifiable is never out of date", () => {
    const pinned = [fact(0)];
    const now = listFactsNow(mutated(pinned, 0, "edit-text"));
    expect(
      claimStaleness(
        target({ cites: [0] }, pinned, { recheckable: false }),
        now,
      ),
    ).toEqual([]);
  });

  describe("a fact the grade never read", () => {
    const pinned = [fact(0)];

    test("bears on the claim when a reviewer linked it", () => {
      const added = fact(5);
      const now = listFactsNow({ scored: [...pinned, added], held: [] });
      expect(
        claimStaleness(
          target({ cites: [0] }, pinned, { linkedFactIds: [factId(5)] }),
          now,
        ),
      ).toEqual([
        { kind: "new-fact-related", factEntityId: factId(5), text: added.text },
      ]);
    });

    test("bears on the claim when it shares a cited fact's document", () => {
      const added = fact(5, { sources: fact(0).sources });
      const now = listFactsNow({ scored: [...pinned, added], held: [] });
      expect(
        claimStaleness(target({ cites: [0] }, pinned), now).map(
          (reason) => reason.factEntityId,
        ),
      ).toEqual([factId(5)]);
    });

    // The sample case's own words: each claim meets the facts on its point.
    test.each([
      [
        "I signed the engagement letter on 14 June 2021.",
        "Engagement letter bearing E. Whitfield's signature, dated 14 June 2021.",
        true,
      ],
      [
        "I notified compliance of the arrangement on 10 August 2021.",
        "Email from E. Whitfield to Compliance disclosing the arrangement, header timestamp 10 Aug 2021.",
        true,
      ],
      [
        "I was on annual leave for the whole of August 2021.",
        'Calendar "Annual leave" blocked across 2–20 August.',
        true,
      ],
      [
        "I signed the engagement letter on 14 June 2021.",
        'Calendar "Brightwater review — Boardroom 2", 09:30.',
        false,
      ],
      // A shared year says nothing: every fact of the matter names it.
      [
        "I first met Mr Harrow in March 2021.",
        "Board minutes of 9 September 2021 note that the board was first informed of the arrangement then.",
        false,
      ],
      [
        "I did not receive any personal benefit from the arrangement.",
        "Email from E. Whitfield to Compliance disclosing the arrangement, header timestamp 10 Aug 2021.",
        false,
      ],
    ])("%s / %s bears on it: %p", (claimText, factText, related) => {
      const now = listFactsNow({
        scored: [fact(7, { text: factText, sources: [] })],
        held: [],
      });
      expect(
        claimStaleness(
          {
            text: claimText,
            grade: { refs: [], recordConflict: null },
            pins: gradePins([]),
            linkedFactIds: [],
            recheckable: true,
          },
          now,
        ).length,
      ).toBe(related ? 1 : 0);
    });

    test("is named at most a few times, the strongest first", () => {
      const strongest = fact(9, { text: ownWords(0) });
      const others = [10, 11, 12, 13].map((index) =>
        fact(index, {
          text: `${ownWords(0).split(" ").slice(0, 2).join(" ")} elsewhere${String(index)}`,
        }),
      );
      const now = listFactsNow({
        scored: [...pinned, ...others, strongest],
        held: [],
      });
      const reasons = claimStaleness(target({ cites: [0] }, pinned), now);
      expect(reasons).toHaveLength(NEW_FACT_REASONS_MAX);
      expect(reasons.at(0)?.factEntityId).toBe(factId(9));
    });
  });
});
