import { describe, expect, test } from "bun:test";

import { createStormLedger, type StormLedgerLimits } from "./storm-ledger";

const LIMITS = {
  bucketCapacity: 20,
  refillPerStimulus: 20,
  tricklePerSecond: 5,
} as const satisfies StormLedgerLimits;

/** One commit per frame for `seconds`, each in its own task, no stimulus. */
const loopAtFrameRate = (
  ledger: ReturnType<typeof createStormLedger>,
  seconds: number,
  perSecond = 60,
) => {
  for (let index = 0; index < seconds * perSecond; index += 1) {
    ledger.onCommit((index * 1000) / perSecond, index);
  }
};

describe("the unstimulated budget", () => {
  test("a loop with no outside cause drains it at sixty commits a second", () => {
    const ledger = createStormLedger(LIMITS);
    loopAtFrameRate(ledger, 1);

    const violations = ledger.report().violations;
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({
      kind: "unstimulated",
      lastStimulus: "none",
    });
  });

  test("a loop slower than the threshold the old canary used still drains it", () => {
    const ledger = createStormLedger(LIMITS);
    loopAtFrameRate(ledger, 4, 30);

    expect(ledger.report().violations.map(({ kind }) => kind)).toContain(
      "unstimulated",
    );
  });

  test("fast input explains fast commits: menus opened six times a second stay within it", () => {
    const ledger = createStormLedger(LIMITS);
    let task = 0;
    for (let menu = 0; menu < 12; menu += 1) {
      const openedAt = menu * 166;
      ledger.onStimulus(openedAt, "input");
      // About fifteen commits to open, spread over the following frames.
      for (let frame = 0; frame < 15; frame += 1) {
        task += 1;
        ledger.onCommit(openedAt + frame * 8, task);
      }
    }

    expect(ledger.report().violations).toEqual([]);
  });

  test("streamed chunks explain streaming commits", () => {
    const ledger = createStormLedger(LIMITS);
    for (let chunk = 0; chunk < 200; chunk += 1) {
      ledger.onStimulus(chunk * 50, "stream");
      ledger.onCommit(chunk * 50 + 1, chunk);
    }

    expect(ledger.report().violations).toEqual([]);
  });

  test("a clock ticking once a second lives off the trickle", () => {
    const ledger = createStormLedger(LIMITS);
    loopAtFrameRate(ledger, 120, 1);

    expect(ledger.report().violations).toEqual([]);
  });

  test("a storm that goes on reports once per drained bucket, not once per commit", () => {
    const ledger = createStormLedger(LIMITS);
    loopAtFrameRate(ledger, 2);

    const count = ledger.report().violations.length;
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThan(10);
  });

  test("the report says how long ago the last stimulus was", () => {
    const ledger = createStormLedger(LIMITS);
    ledger.onStimulus(0, "network");
    for (let index = 1; index <= 40; index += 1) {
      ledger.onCommit(index * 10, index);
    }

    const [first] = ledger.report().violations;
    expect(first).toMatchObject({
      kind: "unstimulated",
      lastStimulus: "network",
    });
    if (first?.kind !== "unstimulated") {
      throw new Error("expected an unstimulated violation");
    }
    expect(first.msSinceStimulus).toBe(first.at);
    expect(first.commitsSinceStimulus).toBeGreaterThan(LIMITS.bucketCapacity);
  });
});

test("the widest task is measured, never a violation", () => {
  const ledger = createStormLedger(LIMITS);
  ledger.onStimulus(0, "input");
  for (let index = 0; index < 9; index += 1) {
    ledger.onCommit(1, 7);
  }
  ledger.onCommit(2, 8);

  expect(ledger.report().widestTask).toBe(9);
  expect(ledger.report().violations).toEqual([]);
});

test("the report counts stimuli by kind", () => {
  const ledger = createStormLedger(LIMITS);
  ledger.onStimulus(0, "input");
  ledger.onStimulus(1, "input");
  ledger.onStimulus(2, "message");

  expect(ledger.report().stimuli).toEqual({
    input: 2,
    network: 0,
    stream: 0,
    message: 1,
    navigation: 0,
  });
});
