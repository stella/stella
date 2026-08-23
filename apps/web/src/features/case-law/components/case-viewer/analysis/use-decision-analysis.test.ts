import { describe, expect, test } from "bun:test";

import { parseAnalysisResponse } from "./use-decision-analysis";

const heading = {
  id: "h1",
  label: "Facts",
  category: "facts",
  startAnchorId: "a1",
  endAnchorId: "a2",
  annotations: [],
  children: [],
};

describe("decision analysis response parsing", () => {
  test("keeps the canonical in-progress tree", () => {
    expect(
      parseAnalysisResponse({
        status: "generating",
        analysis: {
          version: 1,
          status: "generating",
          generatedAt: "2026-08-23T10:00:00.000Z",
          model: "test-model",
          tree: [heading],
        },
      }),
    ).toEqual({ status: "generating", tree: [heading] });
  });

  test("rejects an in-progress payload presented as complete", () => {
    expect(
      parseAnalysisResponse({
        status: "done",
        analysis: {
          version: 1,
          status: "generating",
          generatedAt: "2026-08-23T10:00:00.000Z",
          model: "test-model",
          tree: [heading],
        },
      }),
    ).toBeNull();
  });
});
