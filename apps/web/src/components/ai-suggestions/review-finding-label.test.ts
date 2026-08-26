import { describe, expect, test } from "bun:test";

import type { ReviewFinding } from "@/components/ai-suggestions/document-review-queries";
import {
  findingHeaderLabel,
  findingLabel,
} from "@/components/ai-suggestions/review-finding-label";

const NEUTRAL = { type: "neutral" } as const;
const PURCHASER = { type: "party", role: "Purchaser", name: null } as const;

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  positionId: "position-1",
  issue: "Notice period",
  severity: "medium",
  standardSource: "reference",
  verdict: "deviation",
  delta: { kind: "language" },
  extracted: null,
  rationale: null,
  citations: [],
  fix: null,
  ...overrides,
});

describe("the judgment in words", () => {
  test("names the direction when the run judged one", () => {
    expect(findingLabel(finding({ impact: "unfavourable" }), NEUTRAL)).toBe(
      "Unfavourable",
    );
  });

  test("names the side the direction is judged for", () => {
    expect(findingLabel(finding({ impact: "favourable" }), PURCHASER)).toBe(
      "Better for Purchaser",
    );
  });

  // "The document has nothing to answer with" is a different finding from
  // "the comparison reached no direction", so it is not folded into impact.
  test("a missing standard reads as missing whatever its impact", () => {
    expect(
      findingLabel(
        finding({ verdict: "missing", impact: "unfavourable" }),
        NEUTRAL,
      ),
    ).toBe("Missing");
  });

  test("falls back to the verdict when no direction was judged", () => {
    expect(findingLabel(finding({ impact: "unknown" }), PURCHASER)).toBe(
      "Deviation",
    );
  });

  test("a finding with neither direction nor verdict compared nothing", () => {
    expect(findingLabel(finding({ verdict: null }), NEUTRAL)).toBe(
      "Not compared",
    );
  });
});

describe("the card header's label", () => {
  test("repeats severity only where it stops a deal", () => {
    expect(
      findingHeaderLabel(
        finding({ severity: "high", impact: "unfavourable" }),
        NEUTRAL,
      ),
    ).toBe("High · Unfavourable");
    expect(
      findingHeaderLabel(
        finding({ severity: "blocker", verdict: "missing" }),
        NEUTRAL,
      ),
    ).toBe("Blocker · Missing");
  });

  test("leaves the lower severities to the row's place in the list", () => {
    expect(
      findingHeaderLabel(
        finding({ severity: "low", impact: "neutral" }),
        NEUTRAL,
      ),
    ).toBe("Neutral");
  });
});
