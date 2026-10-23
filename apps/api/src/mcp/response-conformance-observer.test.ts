import { afterEach, describe, expect, test } from "bun:test";

import {
  observeMcpResponseConformance,
  setMcpResponseConformanceObserver,
} from "./response-conformance-observer";

const observation = {
  toolName: "fixture_tool",
  schema: { type: "object" },
  result: { value: "fixture" },
  issuePaths: ["value"],
};

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("MCP response conformance observation", () => {
  test("is disabled until configured and can be disabled again", () => {
    restore = setMcpResponseConformanceObserver(undefined);
    observeMcpResponseConformance(observation);
    const seen: unknown[] = [];
    setMcpResponseConformanceObserver((event) => {
      seen.push(event);
    });
    observeMcpResponseConformance(observation);
    setMcpResponseConformanceObserver(undefined);
    observeMcpResponseConformance(observation);
    expect(seen).toEqual([observation]);
  });

  test("propagates synchronous observer failures", () => {
    const failure = new Error("fixture conformance failure");
    restore = setMcpResponseConformanceObserver(() => {
      throw failure;
    });
    expect(() => observeMcpResponseConformance(observation)).toThrow(failure);
  });
});
