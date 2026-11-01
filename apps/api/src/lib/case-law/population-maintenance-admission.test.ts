import { expect, test } from "bun:test";

import { admitCaseLawPopulationMaintenance } from "./population-maintenance-admission";

test.each([
  { pending: 8193, expected: "stop" },
  { pending: 8192, expected: "normal" },
  { pending: 0, expected: "normal" },
])(
  "maintenance admission at $pending pending deltas is $expected",
  async ({ pending, expected }) => {
    const verdict = await admitCaseLawPopulationMaintenance({
      tableName: "case_law_decisions",
      clock: () => 0,
      verdict: { kind: "normal", signals: [] },
      query: async (statement, parameters) => {
        if (statement.includes("to_regclass")) {
          return [{ installed: true }];
        }
        expect(statement).toContain("max(id) - min(id) + 1");
        expect(parameters).toEqual([8193]);
        return [{ pending }];
      },
    });
    expect(verdict.kind).toBe(expected);
    expect(verdict.signals).toContainEqual(
      expect.objectContaining({
        indicator: "population_backlog",
        kind: expected,
        value: pending,
      }),
    );
  },
);

test.each(["throw", "invalid", "count-throw", "count-invalid"])(
  "an unavailable backlog (%s) holds maintenance",
  async (failure) => {
    const verdict = await admitCaseLawPopulationMaintenance({
      tableName: "case_law_decisions",
      clock: () => 0,
      verdict: { kind: "normal", signals: [] },
      query: async (statement) => {
        if (failure.startsWith("count-") && statement.includes("to_regclass")) {
          return [{ installed: true }];
        }
        if (failure === "throw" || failure === "count-throw") {
          throw new TypeError("read failed");
        }
        return [];
      },
    });
    expect(verdict.kind).toBe("unknown");
    expect(verdict.signals.at(0)?.value).toBeNull();
  },
);

test("a successful pre-migration absence preserves an injected stop verdict", async () => {
  const verdict = await admitCaseLawPopulationMaintenance({
    tableName: "case_law_decisions",
    clock: () => 0,
    verdict: { kind: "stop", signals: [] },
    query: async () => [{ installed: false }],
  });
  expect(verdict.kind).toBe("stop");
  expect(verdict.signals.at(0)?.kind).toBe("not_configured");
});

test.each([
  { tableName: "case_law_population_deltas", name: "population-fold" },
  { tableName: "case_law_decisions", name: "case-law-population-counts" },
  { tableName: "other_table", name: "other-repair" },
])(
  "$name can drain or seed independently of its backlog",
  async ({ tableName, name }) => {
    expect(
      await admitCaseLawPopulationMaintenance({
        tableName,
        name,
        clock: () => 0,
        verdict: { kind: "normal", signals: [] },
        query: async () => {
          throw new TypeError("exempt work must not read backlog");
        },
      }),
    ).toEqual({ kind: "normal", signals: [] });
  },
);
