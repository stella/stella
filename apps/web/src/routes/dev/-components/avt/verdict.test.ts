import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { CLAIMS } from "@/routes/dev/-components/avt/sample-data";
import type { ClaimReview } from "@/routes/dev/-components/avt/types";
import { EMPTY_REVIEW } from "@/routes/dev/-components/avt/types";
import { effectiveState } from "@/routes/dev/-components/avt/verdict";

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
});
