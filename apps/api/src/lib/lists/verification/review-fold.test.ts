import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { CLAIM_REVIEW_EVENT_KINDS } from "@/api/lib/lists/verification/contract";
import type {
  ClaimReviewEventPayload,
  RecordConflict,
} from "@/api/lib/lists/verification/contract";
import {
  CLAIM_QUALIFIERS,
  QUALIFIER_REVIEW,
} from "@/api/lib/lists/verification/qualifiers";
import {
  claimDisposition,
  claimReviewSteps,
  contestedFactIds,
  EMPTY_CLAIM_REVIEW,
  foldClaimReview,
  linksChangedSinceGrade,
  needsAttention,
  rejectRecheck,
  rejectReviewEvent,
  REVIEWED_VIEW_EVENT_KINDS,
  reviewedView,
} from "@/api/lib/lists/verification/review-fold";
import type { ClaimReview } from "@/api/lib/lists/verification/review-fold";

const FACT_A = toSafeId<"entity">("11111111-1111-4111-8111-111111111111");
const FACT_B = toSafeId<"entity">("22222222-2222-4222-8222-222222222222");
const FACT_OTHER = toSafeId<"entity">("33333333-3333-4333-8333-333333333333");

const CONFLICT: RecordConflict = {
  subject: "Date of the first meeting",
  factEntityIds: [FACT_A, FACT_B],
  values: ["9 March 2021", "3 May 2021"],
  governingStates: ["contradicted", "supported"],
};

const PAYLOADS: readonly ClaimReviewEventPayload[] = [
  { kind: "status", status: "reviewed", origin: "single" },
  { kind: "status", status: "disputed", origin: "single", reason: "Misdated." },
  { kind: "status", status: "needs-evidence", origin: "single" },
  { kind: "status", status: "reviewed", origin: "bulk" },
  { kind: "status", status: null, origin: "single" },
  { kind: "override", state: "tension", reason: "The diary hedges." },
  { kind: "override", state: null, reason: "The tool was right." },
  { kind: "note", note: "Check the diary entry." },
  { kind: "note", note: "" },
  { kind: "reopen", reason: "The date can be checked." },
  {
    kind: "record-conflict",
    resolution: { kind: "escalated" },
    reason: "Needs the originals.",
  },
  {
    kind: "record-conflict",
    resolution: { kind: "governed", factEntityId: FACT_A },
    reason: "The bank record governs.",
  },
  { kind: "record-conflict", resolution: null, reason: "Decided too early." },
  { kind: "fact-link", factEntityId: FACT_A, change: "link" },
  {
    kind: "fact-link",
    factEntityId: FACT_B,
    change: "link",
    reason: "The ledger shows it.",
  },
  { kind: "fact-link", factEntityId: FACT_A, change: "unlink" },
  {
    kind: "recheck",
    requestKey: "key-1",
    grade: {
      state: "supported",
      score: 80,
      recordConflict: null,
      refs: [{ factEntityId: FACT_B, rel: "supports" }],
      qualifiers: [],
    },
    facts: { changed: [], removed: [] },
    modelRef: "test:model",
    assertedOn: { type: "none" },
  },
];

const at = (index: number) => new Date(Date.UTC(2026, 8, 23, 9, 0, index));

/** Deterministic pseudo-random sequences, so a failure reproduces. */
const sequences = (count: number, length: number) => {
  let seed = 0x2f_6b_1d_3a;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + (next() % length) }, (_, index) => ({
      payload:
        PAYLOADS.at(next() % PAYLOADS.length) ?? panic("index out of range"),
      actorId: `user-${String(next() % 3)}`,
      createdAt: at(index),
    })),
  );
};

describe("foldClaimReview", () => {
  test("notes and decisions preserve each other's independent fields", () => {
    assertProperty(
      "notes and decisions preserve each other's independent fields",
      fc.property(
        fc.array(fc.constantFrom(...PAYLOADS), { maxLength: 40 }),
        (payloads) => {
          const originalPayloads = structuredClone(payloads);
          const events = payloads.map((payload, index) => ({
            payload,
            actorId: `user-${String(index)}`,
            createdAt: at(index),
          }));
          const full = foldClaimReview(events);
          const notes = foldClaimReview(
            events.filter((event) => event.payload.kind === "note"),
          );
          const decisions = foldClaimReview(
            events.filter((event) => event.payload.kind !== "note"),
          );
          expect(full.note).toBe(notes.note);
          expect(full.noteSavedAt).toEqual(notes.noteSavedAt);
          expect(decisions).toEqual({ ...full, note: "", noteSavedAt: null });
          expect(events.map((event) => event.payload)).toEqual(
            originalPayloads,
          );
          expect(EMPTY_CLAIM_REVIEW).toMatchObject({
            status: null,
            override: null,
            note: "",
            reopened: false,
            recordConflictResolution: null,
          });
        },
      ),
    );
  });

  test("a grade is out of date while its links differ from those it was given with", () => {
    const recheck = {
      kind: "recheck",
      requestKey: "key",
      grade: {
        state: "supported",
        score: 80,
        recordConflict: null,
        refs: [{ factEntityId: FACT_A, rel: "supports" }],
        qualifiers: [],
      },
      facts: { changed: [], removed: [] },
      modelRef: null,
      assertedOn: { type: "none" },
    } as const satisfies ClaimReviewEventPayload;
    const link = (change: "link" | "unlink") =>
      ({
        kind: "fact-link",
        factEntityId: FACT_A,
        change,
      }) as const satisfies ClaimReviewEventPayload;
    const after = (...payloads: ClaimReviewEventPayload[]) =>
      linksChangedSinceGrade(
        foldClaimReview(
          payloads.map((payload, index) => ({
            payload,
            actorId: "a",
            createdAt: at(index),
          })),
        ),
      );

    // The run's grade was pointed at no fact.
    expect(after()).toBe(false);
    expect(after(link("link"))).toBe(true);
    // Linking and unlinking again leaves what the grade was given.
    expect(after(link("link"), link("unlink"))).toBe(false);
    // A re-check is given the links it finds; unlinking afterwards dates it.
    expect(after(link("link"), recheck)).toBe(false);
    expect(after(link("link"), recheck, link("unlink"))).toBe(true);
    expect(after(link("link"), recheck, link("unlink"), recheck)).toBe(false);
  });

  test("no events is the empty review", () => {
    expect(foldClaimReview([])).toEqual(EMPTY_CLAIM_REVIEW);
  });

  test("needs-evidence is a status of its own, set by one reviewer", () => {
    const review = foldClaimReview([
      {
        payload: { kind: "status", status: "needs-evidence", origin: "single" },
        actorId: "a",
        createdAt: at(1),
      },
    ]);
    expect(review).toMatchObject({
      status: "needs-evidence",
      statusOrigin: "single",
      decidedBy: "a",
    });
  });

  test("a status has an origin exactly when it is set", () => {
    for (const events of sequences(500, 12)) {
      const review = foldClaimReview(events);
      expect(review.status === null).toBe(review.statusOrigin === null);
    }
  });

  test("reopening, resolving a conflict or a re-check withdraws the earlier status and override", () => {
    let reached = 0;
    for (const events of sequences(500, 12)) {
      const last = events.at(-1);
      if (
        last?.payload.kind !== "reopen" &&
        last?.payload.kind !== "record-conflict" &&
        last?.payload.kind !== "recheck"
      ) {
        continue;
      }
      reached += 1;
      const review = foldClaimReview(events);
      expect(review.status).toBeNull();
      expect(review.override).toBeNull();
    }
    expect(reached).toBeGreaterThan(0);
  });

  test("a re-check is the grade the claim is read with until the next one", () => {
    const recheck = (state: "supported" | "nocover", index: number) => ({
      payload: {
        kind: "recheck",
        requestKey: `key-${String(index)}`,
        grade:
          state === "supported"
            ? {
                state,
                score: 75,
                recordConflict: null,
                refs: [{ factEntityId: FACT_B, rel: "supports" }],
                qualifiers: [],
              }
            : {
                state,
                score: null,
                recordConflict: null,
                refs: [],
                qualifiers: [],
              },
        facts: { changed: [], removed: [] },
        modelRef: null,
        assertedOn: { type: "none" },
      } satisfies ClaimReviewEventPayload,
      actorId: "checker",
      createdAt: at(index),
    });
    const claim = {
      state: "nocover",
      refs: [],
      recordConflict: null,
    } as const;
    const original = structuredClone(claim);
    const events = [
      {
        payload: {
          kind: "status",
          status: "needs-evidence",
          origin: "single",
        } satisfies ClaimReviewEventPayload,
        actorId: "reviewer",
        createdAt: at(1),
      },
      {
        payload: {
          kind: "note",
          note: "Ask for the ledger.",
        } satisfies ClaimReviewEventPayload,
        actorId: "reviewer",
        createdAt: at(2),
      },
      {
        payload: {
          kind: "fact-link",
          factEntityId: FACT_B,
          change: "link",
        } satisfies ClaimReviewEventPayload,
        actorId: "reviewer",
        createdAt: at(3),
      },
      recheck("supported", 4),
    ];
    const review = foldClaimReview(events);
    expect(reviewedView(claim, review)).toMatchObject({
      state: "supported",
      refs: [{ factEntityId: FACT_B, rel: "supports" }],
    });
    // The claim row is never touched; the run's grade stays readable.
    expect(claim).toEqual(original);
    expect(reviewedView(claim, EMPTY_CLAIM_REVIEW).state).toBe("nocover");
    expect(review).toMatchObject({
      status: null,
      note: "Ask for the ledger.",
      linkedFactIds: [FACT_B],
      recheck: { checkedBy: "checker", checkedAt: at(4) },
    });
    // History reads each step's verdict from the same fold.
    expect(
      claimReviewSteps(events).map(
        ({ before, after }) =>
          `${claimDisposition(claim, before).verdict}>${claimDisposition(claim, after).verdict}`,
      ),
    ).toEqual([
      "nocover>nocover",
      "nocover>nocover",
      "nocover>nocover",
      "nocover>supported",
    ]);
    const later = foldClaimReview([...events, recheck("nocover", 5)]);
    expect(reviewedView(claim, later)).toMatchObject({
      state: "nocover",
      refs: [],
    });
  });

  test("fact links fold to the linked facts in link order", () => {
    const link = (
      factEntityId: typeof FACT_A,
      change: "link" | "unlink",
      index: number,
    ) => ({
      payload: { kind: "fact-link", factEntityId, change } as const,
      actorId: "a",
      createdAt: at(index),
    });
    const review = foldClaimReview([
      link(FACT_A, "link", 1),
      link(FACT_B, "link", 2),
      link(FACT_A, "unlink", 3),
      link(FACT_OTHER, "link", 4),
    ]);
    expect(review.linkedFactIds).toEqual([FACT_B, FACT_OTHER]);
    // A link is no decision: it neither sets nor withdraws one.
    expect(review.decidedAt).toBeNull();
    expect(review.status).toBeNull();
  });

  test("a fact is linked once and unlinked only when linked", () => {
    const claim = { state: "nocover", recordConflict: null } as const;
    const linked = { ...EMPTY_CLAIM_REVIEW, linkedFactIds: [FACT_A] };
    const link = (change: "link" | "unlink") =>
      ({ kind: "fact-link", factEntityId: FACT_A, change }) as const;
    expect(rejectReviewEvent(claim, linked, link("link"))).toBe(
      "fact-already-linked",
    );
    expect(rejectReviewEvent(claim, EMPTY_CLAIM_REVIEW, link("link"))).toBe(
      null,
    );
    expect(rejectReviewEvent(claim, linked, link("unlink"))).toBe(null);
    expect(rejectReviewEvent(claim, EMPTY_CLAIM_REVIEW, link("unlink"))).toBe(
      "fact-not-linked",
    );
  });

  test("actions are held to the grade the claim is read with", () => {
    const setAside = { state: "notverifiable", recordConflict: null } as const;
    expect(rejectRecheck(setAside, EMPTY_CLAIM_REVIEW)).toBe(
      "recheck-set-aside-claim",
    );
    expect(
      rejectRecheck(setAside, { ...EMPTY_CLAIM_REVIEW, reopened: true }),
    ).toBe(null);
    // A re-check that found two records in conflict is resolved, not
    // overridden, though the run's own grade was a plain gap.
    const conflicted = {
      ...EMPTY_CLAIM_REVIEW,
      recheck: {
        grade: {
          state: "recordconflict",
          score: null,
          recordConflict: CONFLICT,
          refs: [],
          qualifiers: [],
        },
        facts: { changed: [], removed: [] },
        modelRef: null,
        assertedOn: { type: "none" },
        checkedAt: at(1),
        checkedBy: "a",
        linkedFactIds: [],
      },
    } satisfies ClaimReview;
    const gap = { state: "nocover", recordConflict: null } as const;
    expect(
      rejectReviewEvent(gap, conflicted, {
        kind: "override",
        state: "supported",
      }),
    ).toBe("override-on-record-conflict");
    expect(
      rejectReviewEvent(gap, conflicted, {
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId: FACT_B },
      }),
    ).toBe(null);
  });

  test("a note never moves the decision stamp", () => {
    for (const events of sequences(500, 12)) {
      const withNote = [
        ...events,
        {
          payload: { kind: "note", note: "later" } as const,
          actorId: "user-9",
          createdAt: at(99),
        },
      ];
      const before = foldClaimReview(events);
      const after = foldClaimReview(withNote);
      expect(after.decidedAt).toEqual(before.decidedAt);
      expect(after.decidedBy).toBe(before.decidedBy);
      expect(after.noteSavedAt).toEqual(at(99));
    }
  });

  test("clearing a note keeps when it was last saved", () => {
    const review = foldClaimReview([
      { payload: { kind: "note", note: "x" }, actorId: "a", createdAt: at(1) },
      { payload: { kind: "note", note: "" }, actorId: "a", createdAt: at(2) },
    ]);
    expect(review.note).toBe("");
    expect(review.noteSavedAt).toEqual(at(1));
  });

  test("the latest decision names its actor and moment", () => {
    const review = foldClaimReview([
      {
        payload: { kind: "status", status: "reviewed", origin: "bulk" },
        actorId: "a",
        createdAt: at(1),
      },
      {
        payload: { kind: "override", state: "tension" },
        actorId: "b",
        createdAt: at(2),
      },
    ]);
    expect(review).toMatchObject({
      status: "reviewed",
      statusOrigin: "bulk",
      override: "tension",
      decidedBy: "b",
      decidedAt: at(2),
    });
  });
});

describe("claimReviewSteps", () => {
  const CLAIMS = [
    { state: "supported", refs: [], recordConflict: null },
    { state: "notverifiable", refs: [], recordConflict: null },
    {
      state: "recordconflict",
      refs: [{ factEntityId: FACT_A, rel: "record" }],
      recordConflict: CONFLICT,
    },
  ] as const;

  test("every step's before and after agree with the fold over the events up to it", () => {
    assertProperty(
      "every step's before and after agree with the fold over the events up to it",
      fc.property(
        fc.array(
          fc.record({
            payload: fc.constantFrom(...PAYLOADS),
            actorId: fc.constantFrom("user-a", "user-b"),
          }),
          { maxLength: 30 },
        ),
        fc.constantFrom(...CLAIMS),
        (drawn, claim) => {
          const events = drawn.map((event, index) => ({
            ...event,
            createdAt: at(index),
          }));
          const steps = claimReviewSteps(events);
          expect(steps.map((step) => step.event)).toEqual(events);
          for (const [index, step] of steps.entries()) {
            expect(step.before).toEqual(
              foldClaimReview(events.slice(0, index)),
            );
            expect(step.after).toEqual(
              foldClaimReview(events.slice(0, index + 1)),
            );
            // A disposition is read off the review, so the chain of
            // before -> after pairs never skips or repeats a change.
            const next = steps.at(index + 1);
            if (next !== undefined) {
              expect(claimDisposition(claim, next.before)).toEqual(
                claimDisposition(claim, step.after),
              );
            }
          }
          expect(steps.at(-1)?.after ?? EMPTY_CLAIM_REVIEW).toEqual(
            foldClaimReview(events),
          );
        },
      ),
    );
  });

  test("a step's disposition reads the verdict as reviewers see it", () => {
    const steps = claimReviewSteps([
      {
        payload: {
          kind: "record-conflict",
          resolution: { kind: "governed", factEntityId: FACT_B },
          reason: "The minutes govern.",
        },
        actorId: "a",
        createdAt: at(1),
      },
      {
        payload: { kind: "override", state: "tension", reason: "Hedged." },
        actorId: "a",
        createdAt: at(2),
      },
    ]);
    const conflicted = CLAIMS[2];
    expect(
      steps.map(({ before, after }) => [
        claimDisposition(conflicted, before),
        claimDisposition(conflicted, after),
      ]),
    ).toEqual([
      [
        { verdict: "recordconflict", override: null, status: null },
        { verdict: "supported", override: null, status: null },
      ],
      [
        { verdict: "supported", override: null, status: null },
        { verdict: "supported", override: "tension", status: null },
      ],
    ]);
  });
});

describe("rejectReviewEvent", () => {
  const scored = { state: "supported", recordConflict: null } as const;
  const setAside = { state: "notverifiable", recordConflict: null } as const;
  const conflicted = {
    state: "recordconflict",
    recordConflict: CONFLICT,
  } as const;

  test("a record conflict is governed, not overridden", () => {
    expect(
      rejectReviewEvent(conflicted, EMPTY_CLAIM_REVIEW, {
        kind: "override",
        state: "supported",
      }),
    ).toBe("override-on-record-conflict");
    expect(
      rejectReviewEvent(conflicted, EMPTY_CLAIM_REVIEW, {
        kind: "override",
        state: null,
      }),
    ).toBeNull();
  });

  test("only a set-aside claim reopens, and only once", () => {
    const reopen = { kind: "reopen" } as const;
    expect(rejectReviewEvent(scored, EMPTY_CLAIM_REVIEW, reopen)).toBe(
      "reopen-checkable-claim",
    );
    expect(rejectReviewEvent(setAside, EMPTY_CLAIM_REVIEW, reopen)).toBeNull();
    expect(
      rejectReviewEvent(
        setAside,
        { ...EMPTY_CLAIM_REVIEW, reopened: true },
        reopen,
      ),
    ).toBe("already-reopened");
  });

  test("a governing fact must be one of the conflicting records", () => {
    const govern = (factEntityId: typeof FACT_A) =>
      ({
        kind: "record-conflict",
        resolution: { kind: "governed", factEntityId },
      }) as const;
    expect(
      rejectReviewEvent(conflicted, EMPTY_CLAIM_REVIEW, govern(FACT_B)),
    ).toBeNull();
    expect(
      rejectReviewEvent(conflicted, EMPTY_CLAIM_REVIEW, govern(FACT_OTHER)),
    ).toBe("governing-fact-not-in-conflict");
    expect(rejectReviewEvent(scored, EMPTY_CLAIM_REVIEW, govern(FACT_A))).toBe(
      "no-record-conflict",
    );
  });
});

describe("needsAttention over the reviewed view", () => {
  const contested = new Set([FACT_B]);
  const refsTo = (factEntityId: typeof FACT_A) =>
    [{ factEntityId, rel: "supports" }] as const;

  const none = [] as const;

  test("a conflict verdict or a contested fact needs a human", () => {
    expect(
      needsAttention(
        { state: "contradicted", refs: [], qualifiers: none },
        contested,
      ),
    ).toBe(true);
    expect(
      needsAttention(
        { state: "supported", refs: refsTo(FACT_B), qualifiers: none },
        contested,
      ),
    ).toBe(true);
    expect(
      needsAttention(
        { state: "supported", refs: refsTo(FACT_A), qualifiers: none },
        contested,
      ),
    ).toBe(false);
    expect(
      needsAttention(
        { state: "notverifiable", refs: refsTo(FACT_B), qualifiers: none },
        contested,
      ),
    ).toBe(false);
  });

  // Each qualifier's own review decides a clean verdict: a held or
  // differently scoped footing needs a human, a disclosed caveat does not.
  test.each(CLAIM_QUALIFIERS)(
    "a clean verdict qualified %s follows that qualifier's review",
    (kind) => {
      expect(
        needsAttention(
          {
            state: "supported",
            refs: refsTo(FACT_A),
            qualifiers: [{ review: QUALIFIER_REVIEW[kind] }],
          },
          contested,
        ),
      ).toBe(QUALIFIER_REVIEW[kind] === "needs-judgement");
    },
  );

  test("a governed conflict takes the governing record's verdict", () => {
    const claim = {
      state: "recordconflict",
      refs: refsTo(FACT_A),
      recordConflict: CONFLICT,
    } as const;
    const governedBy = (factEntityId: typeof FACT_A) => ({
      ...EMPTY_CLAIM_REVIEW,
      recordConflictResolution: { kind: "governed", factEntityId } as const,
    });
    expect(reviewedView(claim, governedBy(FACT_A)).state).toBe("contradicted");
    expect(reviewedView(claim, governedBy(FACT_B)).state).toBe("supported");
    expect(reviewedView(claim, EMPTY_CLAIM_REVIEW).state).toBe(
      "recordconflict",
    );
  });

  // Run summaries fold only these kinds for the claims they count, so any
  // other kind that changed the view would leave a summary behind it.
  test("the reviewed view reads only the view event kinds", () => {
    expect(new Set(PAYLOADS.map((payload) => payload.kind))).toEqual(
      new Set(CLAIM_REVIEW_EVENT_KINDS),
    );
    const viewKinds: ReadonlySet<string> = new Set(REVIEWED_VIEW_EVENT_KINDS);
    const claims = [
      { state: "notverifiable", refs: [], recordConflict: null },
      {
        state: "recordconflict",
        refs: refsTo(FACT_A),
        recordConflict: CONFLICT,
      },
      { state: "contradicted", refs: refsTo(FACT_B), recordConflict: null },
    ] as const;
    assertProperty(
      "the reviewed view reads only the view event kinds",
      fc.property(
        fc.array(fc.constantFrom(...PAYLOADS), { maxLength: 40 }),
        (payloads) => {
          const events = payloads.map((payload, index) => ({
            payload,
            actorId: `user-${String(index)}`,
            createdAt: at(index),
          }));
          const full = foldClaimReview(events);
          const viewOnly = foldClaimReview(
            events.filter((event) => viewKinds.has(event.payload.kind)),
          );
          for (const claim of claims) {
            expect(reviewedView(claim, viewOnly)).toEqual(
              reviewedView(claim, full),
            );
          }
        },
      ),
    );
  });

  test("a reopened set-aside claim is uncovered with nothing cited", () => {
    const view = reviewedView(
      { state: "notverifiable", refs: refsTo(FACT_B), recordConflict: null },
      { ...EMPTY_CLAIM_REVIEW, reopened: true },
    );
    expect(view).toEqual({ state: "nocover", refs: [] });
    expect(needsAttention({ ...view, qualifiers: none }, contested)).toBe(
      false,
    );
  });

  test("contested facts are the ones with an interpretation note", () => {
    const fact = (factEntityId: typeof FACT_A, note: string | null) => ({
      factEntityId,
      text: "",
      occurredOn: null,
      occurredOnPrecision: null,
      evidenceKind: null,
      medium: null,
      confidence: "high" as const,
      interpretationNote: note,
      sources: [],
    });
    const ids = contestedFactIds({
      listId: toSafeId<"legalList">("44444444-4444-4444-8444-444444444444"),
      facts: [fact(FACT_A, null), fact(FACT_B, "Could mean either payment.")],
    });
    expect([...ids]).toEqual([FACT_B]);
  });
});
