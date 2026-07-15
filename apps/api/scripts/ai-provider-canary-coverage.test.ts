import { describe, expect, test } from "bun:test";

import { parseCanaryCoverageArgs } from "./ai-provider-canary-coverage";

describe("AI provider canary coverage arguments", () => {
  test("parses explicit workflow flags", () => {
    expect(
      parseCanaryCoverageArgs([
        "--provider",
        "all",
        "--download-outcome",
        "success",
      ]),
    ).toEqual({ downloadOutcome: "success", selection: "all" });
  });

  test("does not treat a positional provider as a flag value", () => {
    expect(() => parseCanaryCoverageArgs(["all"])).toThrow(
      "Pass --provider followed by all or a canary provider.",
    );
  });

  test("leaves an omitted download outcome undefined", () => {
    expect(
      parseCanaryCoverageArgs(["--provider", "bedrock"]).downloadOutcome,
    ).toBeUndefined();
  });
});
