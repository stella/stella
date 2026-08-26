import { describe, expect, test } from "bun:test";

import type { PositionStandard } from "@/lib/knowledge/playbook-types";
import {
  adoptableIdealText,
  isUnsettledPosition,
  NO_SETTLED_POSITION_DISMISSALS,
} from "@/lib/knowledge/position-decisions";

const summary = (
  accepted: number,
  dismissed: number,
  latestAcceptedFixText: string | null = null,
) => ({
  accepted,
  dismissed,
  runs: accepted + dismissed,
  latestAcceptedFixText,
});

const tieredStandard = (ideal?: string): PositionStandard => ({
  source: "tiers",
  tiers: {
    acceptable: {
      rules: [],
      ...(ideal === undefined
        ? {}
        : { ideal: { source: "inline" as const, text: ideal } }),
    },
    fallback: { entries: [] },
    notAcceptable: { rules: [] },
  },
});

const referenceStandard: PositionStandard = {
  source: "reference",
  termKind: "language",
  passages: [
    {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      entityId: "22222222-2222-4222-8222-222222222222",
      fileFieldId: "33333333-3333-4333-8333-333333333333",
      entityVersionId: "44444444-4444-4444-8444-444444444444",
      blockId: "b1",
      text: "Ninety days' notice.",
    },
  ],
};

describe("whether the org has settled on a position", () => {
  test("repeated dismissals with nothing accepted read as unsettled", () => {
    expect(
      isUnsettledPosition(summary(0, NO_SETTLED_POSITION_DISMISSALS)),
    ).toBe(true);
  });

  test("one dismissal short is not yet a verdict on the position", () => {
    expect(
      isUnsettledPosition(summary(0, NO_SETTLED_POSITION_DISMISSALS - 1)),
    ).toBe(false);
  });

  test("a single acceptance keeps the position settled however often it was dismissed", () => {
    expect(
      isUnsettledPosition(summary(1, NO_SETTLED_POSITION_DISMISSALS * 2)),
    ).toBe(false);
  });
});

describe("adopting accepted language as the ideal", () => {
  test("offers the latest accepted wording when the ladder has none", () => {
    expect(
      adoptableIdealText({
        standard: tieredStandard(),
        summary: summary(2, 0, "  Either party may terminate on 90 days.  "),
      }),
    ).toBe("Either party may terminate on 90 days.");
  });

  test("stays out of the way once the position states its own ideal", () => {
    expect(
      adoptableIdealText({
        standard: tieredStandard("Existing wording"),
        summary: summary(2, 0, "Accepted wording"),
      }),
    ).toBeNull();
  });

  test("offers nothing when no accepted fix carried wording", () => {
    expect(
      adoptableIdealText({
        standard: tieredStandard(),
        summary: summary(2, 0, "   "),
      }),
    ).toBeNull();
  });

  test("never offers to overwrite a reference standard's own passages", () => {
    expect(
      adoptableIdealText({
        standard: referenceStandard,
        summary: summary(2, 0, "Accepted wording"),
      }),
    ).toBeNull();
  });
});
