import { describe, expect, test } from "bun:test";

import type { ReviewFinding } from "@/components/ai-suggestions/document-review-queries";
import {
  findingHeaderLabelMessage,
  findingLabelMessage,
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
    expect(
      findingLabelMessage(finding({ impact: "unfavourable" }), NEUTRAL),
    ).toEqual({
      type: "plain",
      key: "inspector.review.impact.unfavourable",
    });
  });

  test("names the side the direction is judged for", () => {
    expect(
      findingLabelMessage(finding({ impact: "favourable" }), PURCHASER),
    ).toEqual({
      type: "forSide",
      key: "inspector.review.impactForSide.favourable",
      role: "Purchaser",
    });
  });

  // "The document has nothing to answer with" is a different finding from
  // "the comparison reached no direction", so it is not folded into impact.
  test("a missing standard reads as missing whatever its impact", () => {
    expect(
      findingLabelMessage(
        finding({ verdict: "missing", impact: "unfavourable" }),
        NEUTRAL,
      ),
    ).toEqual({
      type: "plain",
      key: "knowledge.playbooks.verdict.missing",
    });
  });

  test("falls back to the verdict when no direction was judged", () => {
    expect(
      findingLabelMessage(finding({ impact: "unknown" }), PURCHASER),
    ).toEqual({
      type: "plain",
      key: "knowledge.playbooks.verdict.deviation",
    });
  });

  test("a finding with neither direction nor verdict compared nothing", () => {
    expect(findingLabelMessage(finding({ verdict: null }), NEUTRAL)).toEqual({
      type: "plain",
      key: "inspector.review.notCompared",
    });
  });
});

describe("the card header's label", () => {
  test("repeats severity only where it stops a deal", () => {
    expect(
      findingHeaderLabelMessage(
        finding({ severity: "high", impact: "unfavourable" }),
        NEUTRAL,
      ).severityKey,
    ).toBe("knowledge.playbooks.severity.high");
    expect(
      findingHeaderLabelMessage(
        finding({ severity: "blocker", verdict: "missing" }),
        NEUTRAL,
      ),
    ).toEqual({
      severityKey: "knowledge.playbooks.severity.blocker",
      judgment: { type: "plain", key: "knowledge.playbooks.verdict.missing" },
    });
  });

  test("leaves the lower severities to the row's place in the list", () => {
    expect(
      findingHeaderLabelMessage(
        finding({ severity: "low", impact: "neutral" }),
        NEUTRAL,
      ),
    ).toEqual({
      severityKey: null,
      judgment: { type: "plain", key: "inspector.review.impact.neutral" },
    });
  });
});
