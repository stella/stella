import { describe, expect, test } from "bun:test";

import {
  actionsForOwned,
  CELL_SETTLEMENT_OUTCOMES,
  settle,
} from "./owned-state";

describe("owned workflow cell settlement", () => {
  test("every outcome releases ownership into a terminal or bounded retry state", () => {
    for (const attempt of [0, 1] as const) {
      for (const outcome of CELL_SETTLEMENT_OUTCOMES) {
        const result = settle(
          {
            state: "pending",
            owner: { runId: "run", batchId: "batch" },
            deadlineAt: new Date(0),
            attempt,
            actions: ["restart"],
          },
          outcome,
        );
        expect("owner" in result).toBe(false);
        if (result.state === "errored" && result.retry === "automatic") {
          expect(attempt).toBe(0);
        }
      }
    }
  });

  test("a pending cell stops before its deadline and restarts after it", () => {
    expect(actionsForOwned("pending", new Date(2), new Date(1))).toEqual([
      "stop",
    ]);
    expect(actionsForOwned("pending", new Date(1), new Date(2))).toEqual([
      "restart",
    ]);
    expect(actionsForOwned("errored", new Date(2), new Date(1))).toEqual([
      "retry",
    ]);
  });
});
