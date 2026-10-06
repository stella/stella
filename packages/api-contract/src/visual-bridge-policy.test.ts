import { describe, expect, test } from "bun:test";

import { createVisualActionGate } from "./visual-bridge-policy";

describe("visual parent actions", () => {
  test("resolves only stored decision links and complete literal URLs", () => {
    const allow = createVisualActionGate({
      data: null,
      links: [{ id: "one", decisionId: "decision-one" }],
      literalLinks: ["https://example.test/view?year=2026"],
      now: () => 0,
    });
    expect(allow({ kind: "open-internal", linkId: "one" })).toBe(true);
    expect(allow({ kind: "open-internal", linkId: "other" })).toBe(false);
    expect(
      allow({ kind: "open-link", url: "https://example.test/view?year=2026" }),
    ).toBe(true);
    for (const url of [
      "https://example.test/view",
      "https://example.test/view?year=2026&value=1",
      "https://example.test/view?year=2026#other",
    ]) {
      expect(allow({ kind: "open-link", url })).toBe(false);
    }
  });

  test("drills only into existing court/year pairs at most once per second", () => {
    let clock = 0;
    const allow = createVisualActionGate({
      data: {
        courtYear: {
          buckets: [
            { court: "court-one", year: 2026 },
            { court: "court-two", year: 2025 },
          ],
        },
      },
      links: [],
      literalLinks: [],
      now: () => clock,
    });
    expect(allow({ kind: "drill", court: "court-one", year: 2025 })).toBe(
      false,
    );
    expect(allow({ kind: "drill", court: "court-one", year: 2026 })).toBe(true);
    clock = 999;
    expect(allow({ kind: "drill", court: "court-two", year: 2025 })).toBe(
      false,
    );
    clock = 1000;
    expect(allow({ kind: "drill", court: "court-two", year: 2025 })).toBe(true);
    expect(allow({ kind: "resize", height: 400 })).toBe(true);
    expect(allow({ kind: "ready", size: { width: 1200, height: 400 } })).toBe(
      true,
    );
  });

  test("does not offer drill actions for other visual data shapes", () => {
    for (const data of [
      null,
      [],
      { rows: [] },
      { courtYear: { buckets: [{ court: null, year: 2026 }] } },
    ]) {
      const allow = createVisualActionGate({
        data,
        links: [],
        literalLinks: [],
        now: () => 0,
      });
      expect(allow({ kind: "drill", court: "court-one", year: 2026 })).toBe(
        false,
      );
    }
  });
});
