import { describe, expect, test } from "bun:test";

import {
  type CycleOutcome,
  type CycleResult,
  cycleMadeProgress,
} from "./cycle-progress";

const OUTCOMES = [
  "completed",
  "failed",
  "timeout",
] as const satisfies readonly CycleOutcome[];

/** Every combination of work a cycle can report having done. */
const WORK = [
  { inserted: 0, pagesProcessed: 1 },
  { inserted: 1, pagesProcessed: 0 },
  { inserted: 1, pagesProcessed: 1 },
] as const;

describe("cycleMadeProgress", () => {
  test("a cycle that walked a page or wrote a row is progress, however it ended", () => {
    const stalls: CycleResult[] = [];
    for (const outcome of OUTCOMES) {
      for (const work of WORK) {
        const cycle = { outcome, ...work };
        if (!cycleMadeProgress(cycle)) {
          stalls.push(cycle);
        }
      }
    }

    expect(stalls).toEqual([]);
  });

  test("only a cycle that moved nothing and did not complete is a stall", () => {
    expect(
      cycleMadeProgress({ outcome: "failed", inserted: 0, pagesProcessed: 0 }),
    ).toBe(false);
    expect(
      cycleMadeProgress({ outcome: "timeout", inserted: 0, pagesProcessed: 0 }),
    ).toBe(false);
  });

  test("a completed cycle with nothing to do is not a stall", () => {
    expect(
      cycleMadeProgress({
        outcome: "completed",
        inserted: 0,
        pagesProcessed: 0,
      }),
    ).toBe(true);
  });
});
