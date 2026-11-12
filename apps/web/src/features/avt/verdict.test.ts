import { describe, expect, test } from "bun:test";

import {
  contradicted,
  factId,
  makeClaim,
  makeFact,
  noCover,
  notVerifiable,
  recordConflict,
  supported,
} from "@/features/avt/avt.test-fixtures";
import { EMPTY_CLAIM_REVIEW } from "@/features/avt/claim-review.logic";
import type { ClaimReview } from "@/features/avt/types";
import {
  confirmLabel,
  contestedFactIds,
  countClaims,
  dispositionGuidance,
  effectiveState,
  needsAttention,
  resolveClaimView,
  routineUnsettledClaimIds,
} from "@/features/avt/verdict";

const review = (patch: Partial<ClaimReview>): ClaimReview => ({
  ...EMPTY_CLAIM_REVIEW,
  ...patch,
});

const NONE_CONTESTED = new Set<ReturnType<typeof factId>>();

describe("AVT displayed verdict", () => {
  test("keeps an override separate from the tool verdict", () => {
    const claim = makeClaim({ suffix: 2, verdict: contradicted() });

    expect(effectiveState(claim, review({ override: "supported" }))).toBe(
      "contradicted",
    );
  });

  test("keeps unresolved and escalated record conflicts open", () => {
    const claim = makeClaim({ suffix: 12, verdict: recordConflict });

    expect(effectiveState(claim, null)).toBe("recordconflict");
    expect(
      effectiveState(
        claim,
        review({ recordConflictResolution: { kind: "escalated" } }),
      ),
    ).toBe("recordconflict");
  });

  test("uses the verdict attached to the governing record", () => {
    const claim = makeClaim({ suffix: 12, verdict: recordConflict });

    expect(
      effectiveState(
        claim,
        review({
          recordConflictResolution: {
            kind: "governed",
            factEntityId: factId(5),
          },
        }),
      ),
    ).toBe("supported");
    expect(
      effectiveState(
        claim,
        review({
          recordConflictResolution: {
            kind: "governed",
            factEntityId: factId(6),
          },
        }),
      ),
    ).toBe("contradicted");
  });

  test("a reopened set-aside claim reads as uncovered, with no facts", () => {
    const claim = makeClaim({
      suffix: 3,
      type: "opinion",
      verdict: notVerifiable,
      refs: [{ factEntityId: factId(1), rel: "supports" }],
      review: review({ reopened: true }),
    });

    const view = resolveClaimView(claim);

    expect(view.verdict.state).toBe("nocover");
    expect(view.type).toBe("fact");
    expect(view.refs).toEqual([]);
  });
});

describe("AVT triage", () => {
  test("a clean claim resting on a contested fact needs attention", () => {
    const facts = [
      makeFact(1, { interpretationNote: "Initials may be a draft mark" }),
    ];
    const claim = makeClaim({
      suffix: 1,
      verdict: supported(),
      refs: [{ factEntityId: factId(1), rel: "supports" }],
    });

    expect(
      needsAttention(
        { state: "supported", refs: claim.refs, qualifiers: [], recheck: null },
        contestedFactIds(facts),
      ),
    ).toBe(true);
    expect(
      needsAttention(
        { state: "supported", refs: claim.refs, qualifiers: [], recheck: null },
        NONE_CONTESTED,
      ),
    ).toBe(false);
  });

  test("a re-checked claim is contested by the facts its re-check read, not the run's", () => {
    const pinned = contestedFactIds([
      makeFact(1, { interpretationNote: "Initials may be a draft mark" }),
    ]);
    const refs = [{ factEntityId: factId(1), rel: "supports" as const }];
    const recheck = (interpretationNote: string | null) => ({
      checkedAt: "2026-11-11T10:00:00.000Z",
      checkedBy: "0199a3c4-5b6d-7e8f-9a0b-000000009098",
      modelRef: null,
      factCount: 1,
      facts: [makeFact(1, { interpretationNote })],
      original: { verdict: noCover, refs: [], qualifiers: [] },
    });

    // The note was cleared before the re-check: its grade no longer rests
    // on a contested reading, whatever the run pinned.
    expect(
      needsAttention(
        { state: "supported", refs, qualifiers: [], recheck: recheck(null) },
        pinned,
      ),
    ).toBe(false);
    // A note added since the run counts for the claim that read it.
    expect(
      needsAttention(
        {
          state: "supported",
          refs,
          qualifiers: [],
          recheck: recheck("Initials may be a draft mark"),
        },
        NONE_CONTESTED,
      ),
    ).toBe(true);
  });

  // The review each qualifier asks for comes from the server; a clean
  // verdict on a held footing leaves the routine claims, and the count, the
  // bulk accept and the claim's own copy agree about it.
  test("a qualifier that asks for judgement takes a clean verdict out of the routine claims", () => {
    const held = makeClaim({
      suffix: 1,
      verdict: supported(),
      refs: [{ factEntityId: factId(1), rel: "supports" }],
      qualifiers: [
        { kind: "unsourced-only", explanation: null, review: "routine" },
        { kind: "rests-on-held", explanation: null, review: "needs-judgement" },
      ],
    });
    const unsourced = makeClaim({
      suffix: 2,
      verdict: supported(),
      refs: [{ factEntityId: factId(2), rel: "supports" }],
      qualifiers: [
        { kind: "unsourced-only", explanation: null, review: "routine" },
      ],
    });
    const counts = countClaims([held, unsourced], NONE_CONTESTED);
    expect({
      attnTotal: counts.attnTotal,
      routine: counts.routineTotal,
    }).toEqual({ attnTotal: 1, routine: 1 });
    expect(routineUnsettledClaimIds([held, unsourced], NONE_CONTESTED)).toEqual(
      [unsourced.id],
    );
    expect(
      dispositionGuidance(
        {
          state: "supported",
          refs: held.refs,
          qualifiers: held.qualifiers,
          recheck: null,
        },
        NONE_CONTESTED,
      ),
    ).toEqual({
      tone: "manual",
      guideKey: "avt.guidance.manualJudgement",
      askKey: "avt.disposition.restsOnHeld",
    });
    // Confirming it is confirming a verdict, not a claim that is ready.
    expect(confirmLabel("supported", "manual")).toBe("avt.confirm.verdict");
    expect(confirmLabel("supported", "ready")).toBe("avt.confirm.supported");
    expect(
      dispositionGuidance(
        {
          state: "supported",
          refs: unsourced.refs,
          qualifiers: unsourced.qualifiers,
          recheck: null,
        },
        NONE_CONTESTED,
      ),
    ).toEqual({
      tone: "ready",
      guideKey: "avt.guidance.readyToConfirm",
      askKey: "avt.disposition.unsourcedOnly",
    });
  });

  test("set-aside claims never need attention, even on contested facts", () => {
    const facts = [makeFact(1, { interpretationNote: "Ambiguous" })];

    expect(
      needsAttention(
        {
          state: "notverifiable",
          refs: [{ factEntityId: factId(1), rel: "supports" }],
          qualifiers: [],
          recheck: null,
        },
        contestedFactIds(facts),
      ),
    ).toBe(false);
  });

  test("counts outcomes without treating overrides as verdicts", () => {
    const claims = [
      makeClaim({
        suffix: 2,
        verdict: contradicted(),
        review: review({ override: "supported" }),
      }),
      makeClaim({
        suffix: 12,
        verdict: recordConflict,
        review: review({
          recordConflictResolution: {
            kind: "governed",
            factEntityId: factId(5),
          },
        }),
      }),
    ];

    const counts = countClaims(claims, NONE_CONTESTED);

    expect(counts.byState.contradicted).toBe(1);
    expect(counts.byState.supported).toBe(1);
    expect(counts.byState.recordconflict).toBe(0);
  });

  test("accepting routine claims skips conflicts and settled claims", () => {
    const routine = makeClaim({ suffix: 1, verdict: supported() });
    const uncovered = makeClaim({ suffix: 2, verdict: noCover });
    const settled = makeClaim({
      suffix: 3,
      verdict: supported(),
      review: review({ status: "reviewed", statusOrigin: "single" }),
    });
    const conflict = makeClaim({ suffix: 4, verdict: contradicted() });

    expect(
      routineUnsettledClaimIds(
        [routine, uncovered, settled, conflict],
        NONE_CONTESTED,
      ),
    ).toEqual([routine.id, uncovered.id]);
  });

  test("the routine set and the attention count partition every claim", () => {
    const claims = [
      makeClaim({ suffix: 1, verdict: supported() }),
      makeClaim({ suffix: 2, verdict: contradicted() }),
      makeClaim({ suffix: 3, verdict: recordConflict }),
      makeClaim({ suffix: 4, verdict: noCover }),
      makeClaim({ suffix: 5, verdict: notVerifiable }),
    ];

    const counts = countClaims(claims, NONE_CONTESTED);

    expect(counts.attnTotal + counts.routineTotal).toBe(claims.length);
    expect(routineUnsettledClaimIds(claims, NONE_CONTESTED)).toHaveLength(
      counts.routineUnsettled,
    );
  });
});
