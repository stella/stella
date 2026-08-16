import { describe, expect, test } from "bun:test";

import { estimateDocumentRunUnits } from "./run-estimate";

describe("estimateDocumentRunUnits", () => {
  test("converts stored bytes and planned outputs through the model's rate", () => {
    // 1 MiB stored inflates 4x into 4 MiB of prompt -> 1048576 tokens
    // at 20_000/MTok = 20972 micro-units; 10 outputs -> 2500 tokens at
    // 120_000/MTok = 300; standard tier multiplies by 1.5 before the
    // 100 micro-unit -> unit conversion (320 units), then 11 planned
    // calls x the doc_review floor of 8 add 88.
    expect(
      estimateDocumentRunUnits({
        modelId: "gpt-5.6-luna",
        actionType: "doc_review",
        storedInputBytes: 1_048_576,
        plannedOutputs: 10,
        serviceTier: "standard",
      }),
    ).toBe(408);
  });

  test("small documents stay under the confirmation threshold", () => {
    expect(
      estimateDocumentRunUnits({
        modelId: "gpt-5.6-luna",
        actionType: "doc_review",
        storedInputBytes: 20_000,
        plannedOutputs: 3,
        serviceTier: "standard",
      }),
    ).toBe(40);
  });

  test("scales with the model's rate, not a flat per-run constant", () => {
    const luna = estimateDocumentRunUnits({
      modelId: "gpt-5.6-luna",
      actionType: "doc_review",
      storedInputBytes: 1_048_576,
      plannedOutputs: 10,
      serviceTier: "standard",
    });
    const sonnet = estimateDocumentRunUnits({
      modelId: "claude-sonnet-5",
      actionType: "doc_review",
      storedInputBytes: 1_048_576,
      plannedOutputs: 10,
      serviceTier: "standard",
    });
    expect(sonnet).toBe(3272);
    expect(sonnet).toBeGreaterThan(luna);
  });

  test("floors every planned call even when tokens are negligible", () => {
    // A tiny document with many planned findings settles at least the
    // per-call floor for each generation; the estimate must not admit
    // it on token volume alone.
    const estimate = estimateDocumentRunUnits({
      modelId: "gpt-5.6-luna",
      actionType: "doc_review",
      storedInputBytes: 100,
      plannedOutputs: 10,
      serviceTier: "standard",
    });
    expect(estimate).toBeGreaterThanOrEqual(88);
  });
});
