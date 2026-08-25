import { describe, expect, test } from "bun:test";

import { ReviewAlignedPair } from "@/components/ai-suggestions/review-aligned-pair";
import type { ReviewDelta } from "@/components/ai-suggestions/review-delta";
import { ReviewDeltaView } from "@/components/ai-suggestions/review-delta-view";
import { ReviewPresenceMatrix } from "@/components/ai-suggestions/review-presence-matrix";
import { ReviewTermTable } from "@/components/ai-suggestions/review-term-row";

// apps/web has no @testing-library/react dependency (no other *.test.tsx
// under components/ai-suggestions renders into a DOM either), so this
// verifies dispatch by calling the component function directly and
// inspecting the returned element's `.type` rather than mounting it.

const side = { label: "Target", passages: [] };

describe("review delta view dispatch", () => {
  test("parameter delta renders a term table", () => {
    const delta: ReviewDelta = {
      kind: "parameter",
      standard: null,
      target: null,
    };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Notice period",
      standard: side,
      target: side,
    });
    expect(element?.type).toBe(ReviewTermTable);
  });

  test("enumeration delta renders a presence matrix", () => {
    const delta: ReviewDelta = { items: [], kind: "enumeration" };
    const element = ReviewDeltaView({
      delta,
      impact: "neutral",
      label: "Leakage definition",
      standard: side,
      target: side,
    });
    expect(element?.type).toBe(ReviewPresenceMatrix);
  });

  test("presence delta renders a presence matrix", () => {
    const delta: ReviewDelta = {
      inStandard: true,
      inTarget: false,
      kind: "presence",
      term: "Losses",
    };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Losses",
      standard: side,
      target: side,
    });
    expect(element?.type).toBe(ReviewPresenceMatrix);
  });

  test("language delta falls back to the diffed aligned pair", () => {
    const delta: ReviewDelta = { kind: "language" };
    const element = ReviewDeltaView({
      delta,
      impact: "unfavourable",
      label: "Fairly Disclosed",
      standard: side,
      target: side,
    });
    expect(element?.type).toBe(ReviewAlignedPair);
    expect(element?.props.diff).toBe(true);
  });
});
