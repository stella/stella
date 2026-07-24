import { describe, expect, test } from "bun:test";

import { resolveMemoryExtractionEnabledAt } from "./memory-extraction-consent";

const NOW = new Date("2026-07-10T12:00:00Z");

describe("memory extraction consent window", () => {
  test("starts a new window when extraction is enabled", () => {
    expect(
      resolveMemoryExtractionEnabledAt({
        currentEnabled: false,
        nextEnabled: true,
        now: NOW,
      }),
    ).toEqual(NOW);
  });

  test("preserves the window while extraction remains enabled", () => {
    expect(
      resolveMemoryExtractionEnabledAt({
        currentEnabled: true,
        nextEnabled: true,
        now: NOW,
      }),
    ).toBeUndefined();
  });

  test("clears the window when extraction is disabled", () => {
    expect(
      resolveMemoryExtractionEnabledAt({
        currentEnabled: true,
        nextEnabled: false,
        now: NOW,
      }),
    ).toBeNull();
  });
});
