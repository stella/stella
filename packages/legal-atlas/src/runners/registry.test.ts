import { describe, expect, test } from "bun:test";

import { getRunnerDefinition, isRunnerName } from "./registry";

describe("runner registry", () => {
  test("narrows known runner names", () => {
    expect(isRunnerName("case-law-ingest")).toBe(true);
    expect(isRunnerName("eu-ecj-refetch")).toBe(true);
    expect(getRunnerDefinition("eu-ecj-refetch").status).toBe("implemented");
    expect(isRunnerName("api-server")).toBe(false);
    expect(getRunnerDefinition("case-law-ingest").status).toBe("implemented");
  });
});
