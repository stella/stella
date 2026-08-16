import { describe, expect, test } from "bun:test";

import { estimateDocumentRunUnits } from "./run-estimate";

describe("estimateDocumentRunUnits", () => {
  test("converts bytes and planned outputs through the model's rate", () => {
    // 1 MiB -> 262144 tokens at 20_000/MTok = 5243 micro-units;
    // 10 outputs -> 2500 tokens at 120_000/MTok = 300; standard tier
    // multiplies by 1.5 before the 100 micro-unit -> unit conversion.
    expect(
      estimateDocumentRunUnits({
        modelId: "gpt-5.6-luna",
        inputBytes: 1_048_576,
        plannedOutputs: 10,
        serviceTier: "standard",
      }),
    ).toBe(84);
  });

  test("small documents stay under the confirmation threshold", () => {
    expect(
      estimateDocumentRunUnits({
        modelId: "gpt-5.6-luna",
        inputBytes: 20_000,
        plannedOutputs: 3,
        serviceTier: "standard",
      }),
    ).toBe(3);
  });

  test("scales with the model's rate, not a flat per-run constant", () => {
    const luna = estimateDocumentRunUnits({
      modelId: "gpt-5.6-luna",
      inputBytes: 1_048_576,
      plannedOutputs: 10,
      serviceTier: "standard",
    });
    const sonnet = estimateDocumentRunUnits({
      modelId: "claude-sonnet-5",
      inputBytes: 1_048_576,
      plannedOutputs: 10,
      serviceTier: "standard",
    });
    expect(sonnet).toBe(824);
    expect(sonnet).toBeGreaterThan(luna);
  });
});
