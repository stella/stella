import { describe, expect, test } from "bun:test";

import {
  claimId,
  factId,
  makeClaim,
  makeRun,
  supported,
} from "@/features/avt/avt.test-fixtures";
import {
  EMPTY_CLAIM_REVIEW,
  predictBulkReviewed,
  predictClaimReview,
  withClaimReviews,
} from "@/features/avt/claim-review.logic";
import type { ClaimReview, ClaimReviewEvent } from "@/features/avt/types";

const FIRST = { at: "2026-01-01T12:00:00.000Z", actorId: "reviewer-a" };
const SECOND = { at: "2026-01-02T12:00:00.000Z", actorId: "reviewer-b" };

const decided: ClaimReview = {
  ...EMPTY_CLAIM_REVIEW,
  status: "reviewed",
  statusOrigin: "single",
  override: "supported",
  note: "Keep this note",
  noteSavedAt: FIRST.at,
  decidedAt: FIRST.at,
  decidedBy: FIRST.actorId,
};

describe("predicted claim reviews", () => {
  test("record who decided and when for status and override decisions", () => {
    const afterStatus = predictClaimReview(
      null,
      { kind: "status", status: "reviewed" },
      FIRST,
    );
    const afterOverride = predictClaimReview(
      afterStatus,
      { kind: "override", state: "tension" },
      SECOND,
    );

    expect(afterStatus).toMatchObject({
      status: "reviewed",
      statusOrigin: "single",
      decidedAt: FIRST.at,
      decidedBy: FIRST.actorId,
    });
    expect(afterOverride).toMatchObject({
      status: "reviewed",
      override: "tension",
      decidedAt: SECOND.at,
      decidedBy: SECOND.actorId,
    });
  });

  const withdrawing: ClaimReviewEvent[] = [
    { kind: "reopen" },
    { kind: "record-conflict", resolution: { kind: "escalated" } },
    {
      kind: "record-conflict",
      resolution: { kind: "governed", factEntityId: factId(5) },
    },
  ];

  for (const event of withdrawing) {
    test(`${event.kind} withdraws the status and override but keeps the note`, () => {
      const next = predictClaimReview(decided, event, SECOND);

      expect(next).toMatchObject({
        status: null,
        statusOrigin: null,
        override: null,
        note: "Keep this note",
        noteSavedAt: FIRST.at,
      });
    });
  }

  test("a note never changes the decision", () => {
    const next = predictClaimReview(
      decided,
      { kind: "note", note: "Explains the dispute" },
      SECOND,
    );

    expect(next).toMatchObject({
      status: decided.status,
      override: decided.override,
      decidedAt: decided.decidedAt,
      noteSavedAt: SECOND.at,
    });
  });

  test("clearing a note keeps when one was last saved", () => {
    const next = predictClaimReview(
      decided,
      { kind: "note", note: "" },
      SECOND,
    );

    expect(next.note).toBe("");
    expect(next.noteSavedAt).toBe(FIRST.at);
  });

  test("bulk acceptance marks only claims nobody has decided", () => {
    expect(predictBulkReviewed(null, SECOND)).toMatchObject({
      status: "reviewed",
      statusOrigin: "bulk",
    });
    expect(predictBulkReviewed(decided, SECOND)).toBe(decided);
  });
});

describe("replacing claim reviews in a run", () => {
  test("touches only the named claims", () => {
    const run = makeRun([
      makeClaim({ suffix: 1, verdict: supported() }),
      makeClaim({ suffix: 2, verdict: supported() }),
    ]);

    const next = withClaimReviews(run, [
      { claimId: claimId(2), review: decided },
    ]);

    expect(next.claims.at(0)).toBe(run.claims.at(0));
    expect(next.claims.at(1)?.review).toBe(decided);
  });

  test("restoring the previous reviews is a round trip", () => {
    const run = makeRun([makeClaim({ suffix: 1, verdict: supported() })]);
    const previous = run.claims.map((claim) => ({
      claimId: claim.id,
      review: claim.review,
    }));

    const optimistic = withClaimReviews(run, [
      { claimId: claimId(1), review: decided },
    ]);

    expect(withClaimReviews(optimistic, previous)).toEqual(run);
  });
});
