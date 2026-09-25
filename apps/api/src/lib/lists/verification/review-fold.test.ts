import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type {
  RecordConflict,
  ClaimReviewEventPayload,
} from "@/api/lib/lists/verification/contract";
import {
  EMPTY_CLAIM_REVIEW,
  contestedFactIds,
  foldClaimReview,
  needsAttention,
  rejectReviewEvent,
  reviewedView,
} from "@/api/lib/lists/verification/review-fold";

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
  { kind: "status", status: "disputed", origin: "single" },
  { kind: "status", status: "reviewed", origin: "bulk" },
  { kind: "status", status: null, origin: "single" },
  { kind: "override", state: "tension" },
  { kind: "override", state: null },
  { kind: "note", note: "Check the diary entry." },
  { kind: "note", note: "" },
  { kind: "reopen" },
  { kind: "record-conflict", resolution: { kind: "escalated" } },
  {
    kind: "record-conflict",
    resolution: { kind: "governed", factEntityId: FACT_A },
  },
  { kind: "record-conflict", resolution: null },
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
  test("no events is the empty review", () => {
    expect(foldClaimReview([])).toEqual(EMPTY_CLAIM_REVIEW);
  });

  test("a status has an origin exactly when it is set", () => {
    for (const events of sequences(500, 12)) {
      const review = foldClaimReview(events);
      expect(review.status === null).toBe(review.statusOrigin === null);
    }
  });

  test("reopening or resolving a conflict withdraws the earlier status and override", () => {
    for (const events of sequences(500, 12)) {
      const last = events.at(-1);
      if (
        last?.payload.kind !== "reopen" &&
        last?.payload.kind !== "record-conflict"
      ) {
        continue;
      }
      const review = foldClaimReview(events);
      expect(review.status).toBeNull();
      expect(review.override).toBeNull();
    }
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

  test("a conflict verdict or a contested fact needs a human", () => {
    expect(needsAttention({ state: "contradicted", refs: [] }, contested)).toBe(
      true,
    );
    expect(
      needsAttention({ state: "supported", refs: refsTo(FACT_B) }, contested),
    ).toBe(true);
    expect(
      needsAttention({ state: "supported", refs: refsTo(FACT_A) }, contested),
    ).toBe(false);
    expect(
      needsAttention(
        { state: "notverifiable", refs: refsTo(FACT_B) },
        contested,
      ),
    ).toBe(false);
  });

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

  test("a reopened set-aside claim is uncovered with nothing cited", () => {
    const view = reviewedView(
      { state: "notverifiable", refs: refsTo(FACT_B), recordConflict: null },
      { ...EMPTY_CLAIM_REVIEW, reopened: true },
    );
    expect(view).toEqual({ state: "nocover", refs: [] });
    expect(needsAttention(view, contested)).toBe(false);
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
