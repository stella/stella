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
  contestedFactIds,
  countClaims,
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
        { state: "supported", refs: claim.refs },
        contestedFactIds(facts),
      ),
    ).toBe(true);
    expect(
      needsAttention({ state: "supported", refs: claim.refs }, NONE_CONTESTED),
    ).toBe(false);
  });

  test("set-aside claims never need attention, even on contested facts", () => {
    const facts = [makeFact(1, { interpretationNote: "Ambiguous" })];

    expect(
      needsAttention(
        {
          state: "notverifiable",
          refs: [{ factEntityId: factId(1), rel: "supports" }],
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
