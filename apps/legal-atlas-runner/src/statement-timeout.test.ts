import { describe, expect, test } from "bun:test";

import { ingestionStatementTimeoutMs } from "./statement-timeout";

describe("ingestionStatementTimeoutMs", () => {
  test("without a cap, each statement may run for the whole budget", () => {
    expect(ingestionStatementTimeoutMs(1_200_000, 0)).toBe(1_200_000);
    expect(ingestionStatementTimeoutMs(0, 0)).toBe(0);
  });

  test("a tighter cap bounds each statement below the budget", () => {
    expect(ingestionStatementTimeoutMs(1_200_000, 180_000)).toBe(180_000);
  });

  test("a cap never raises a statement above the budget", () => {
    expect(ingestionStatementTimeoutMs(60_000, 180_000)).toBe(60_000);
  });

  test("a cap still applies when the budget is disabled", () => {
    expect(ingestionStatementTimeoutMs(0, 180_000)).toBe(180_000);
  });
});
