import { describe, expect, test } from "bun:test";

import {
  getRunnerDefinition,
  getRunnerDefinitions,
  isRunnerName,
  RUNNER_NAMES,
} from "./registry";

describe("runner registry", () => {
  test("keeps all declared runner names registered", () => {
    const registered = getRunnerDefinitions().map((runner) => runner.name);

    expect(registered).toEqual([...RUNNER_NAMES]);
  });

  test("narrows known runner names", () => {
    expect(isRunnerName("case-law-ingest")).toBe(true);
    expect(isRunnerName("api-server")).toBe(false);
    expect(getRunnerDefinition("search-index").status).toBe("reserved");
  });
});
