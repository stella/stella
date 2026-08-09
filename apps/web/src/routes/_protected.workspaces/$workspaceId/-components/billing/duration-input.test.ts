import { describe, expect, test } from "bun:test";

import { parseDuration } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";

describe("parseDuration", () => {
  test.each([
    ["1", 1],
    ["7m", 7],
    ["1h7m", 67],
    ["1:07", 67],
    ["1.5", 90],
  ])("preserves actual worked minutes for %s", (value, expected) => {
    expect(parseDuration(value)).toBe(expected);
  });

  test.each(["", "time", "1,5"])("rejects %s", (value) => {
    expect(parseDuration(value)).toBeNull();
  });
});
