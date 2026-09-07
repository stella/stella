import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ANCHOR_FACTS,
  CLAIMS,
} from "@/routes/dev_.avt/-components/avt/sample-data";
import type { ClaimReview } from "@/routes/dev_.avt/-components/avt/types";
import { EMPTY_REVIEW } from "@/routes/dev_.avt/-components/avt/types";
import {
  countClaims,
  effectiveState,
} from "@/routes/dev_.avt/-components/avt/verdict";

const claimById = (id: string) =>
  CLAIMS.find((claim) => claim.id === id) ?? panic(`Missing claim ${id}`);

const review = (patch: Partial<ClaimReview>): ClaimReview => ({
  ...EMPTY_REVIEW,
  ...patch,
});

describe("AVT displayed verdict", () => {
  test("keeps an override separate from the tool verdict", () => {
    const claim = claimById("c2");

    expect(effectiveState(claim, review({ override: "supported" }))).toBe(
      claim.state,
    );
  });

  test("keeps unresolved and escalated record conflicts open", () => {
    const claim = claimById("c12");

    expect(effectiveState(claim, review({ override: "supported" }))).toBe(
      "recordconflict",
    );
    expect(
      effectiveState(
        claim,
        review({
          override: "supported",
          recordConflictResolution: { kind: "escalated" },
        }),
      ),
    ).toBe("recordconflict");
  });

  test("uses the outcome attached to the governing record", () => {
    const claim = claimById("c12");

    expect(
      effectiveState(
        claim,
        review({
          recordConflictResolution: { kind: "governed", factId: "BANK-05" },
        }),
      ),
    ).toBe("supported");
    expect(
      effectiveState(
        claim,
        review({
          recordConflictResolution: { kind: "governed", factId: "LEDG-01" },
        }),
      ),
    ).toBe("contradicted");
  });

  test("counts analysis outcomes without treating overrides as verdicts", () => {
    const contradicted = claimById("c2");
    const conflict = claimById("c12");
    const facts = new Map(ANCHOR_FACTS.map((fact) => [fact.id, fact]));

    const counts = countClaims(
      [contradicted, conflict],
      {
        [contradicted.id]: review({ override: "supported" }),
        [conflict.id]: review({
          recordConflictResolution: { kind: "governed", factId: "BANK-05" },
        }),
      },
      (id) => facts.get(id),
    );

    expect(counts.byState.contradicted).toBe(1);
    expect(counts.byState.supported).toBe(1);
    expect(counts.byState.recordconflict).toBe(0);
  });
});
