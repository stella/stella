import { describe, expect, test } from "bun:test";

import { createPipelineRunRegistry } from "./pipeline-run-registry.logic";

describe("pipeline run ownership", () => {
  test("a newer run permanently supersedes older work for the same field", () => {
    const runs = createPipelineRunRegistry();
    const older = runs.start("field-a");
    const newer = runs.start("field-a");

    expect(runs.canCommit("field-a", older)).toBe(false);
    expect(runs.finish("field-a", older)).toBe(false);
    expect(runs.canCommit("field-a", newer)).toBe(true);
    expect(runs.finish("field-a", newer)).toBe(true);
  });

  test("cancellation cannot be evicted by unrelated field activity", () => {
    const runs = createPipelineRunRegistry();
    const cancelled = runs.start("cancelled-field");
    runs.cancel("cancelled-field");

    for (let index = 0; index < 1500; index += 1) {
      const key = `field-${index}`;
      const run = runs.start(key);
      expect(runs.finish(key, run)).toBe(true);
    }

    expect(runs.canCommit("cancelled-field", cancelled)).toBe(false);
    expect(runs.finish("cancelled-field", cancelled)).toBe(false);
  });
});
