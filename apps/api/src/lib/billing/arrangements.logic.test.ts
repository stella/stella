import { expect, test } from "bun:test";

import {
  evaluateBillingArrangementCaps,
  evaluateBillingCap,
  newBillingCapCrossings,
} from "./arrangements.logic";

const below = { thresholdState: "below", capState: "below" } as const;

test.each([
  { amount: 7999n, thresholdState: "below", capState: "below" },
  { amount: 8000n, thresholdState: "above", capState: "below" },
  { amount: 9999n, thresholdState: "above", capState: "below" },
  { amount: 10_000n, thresholdState: "above", capState: "above" },
  { amount: 10_001n, thresholdState: "above", capState: "above" },
])(
  "billing cap classifies exact threshold boundaries at $amount",
  ({ amount, thresholdState, capState }) => {
    expect(
      evaluateBillingCap({
        totalAmount: amount,
        capAmount: 10_000n,
        alertThresholdBps: 8000,
      }),
    ).toEqual({ thresholdState, capState });
  },
);

test("billing cap comparisons stay exact above JavaScript's safe aggregate range", () => {
  const capAmount = 9_007_199_254_740_991n;
  expect(
    evaluateBillingCap({
      totalAmount: capAmount - 1n,
      capAmount,
      alertThresholdBps: 10_000,
    }),
  ).toEqual(below);
  expect(
    evaluateBillingCap({
      totalAmount: capAmount,
      capAmount,
      alertThresholdBps: 10_000,
    }),
  ).toEqual({ thresholdState: "above", capState: "above" });
  expect(
    evaluateBillingCap({
      totalAmount: capAmount * 50_000n,
      capAmount,
      alertThresholdBps: 8000,
    }).capState,
  ).toBe("above");
});

test("billing cap emits each upward boundary once and rearms on a decrease", () => {
  const threshold = { thresholdState: "above", capState: "below" } as const;
  const capped = { thresholdState: "above", capState: "above" } as const;
  expect(newBillingCapCrossings({ previous: below, current: capped })).toEqual([
    "threshold",
    "cap",
  ]);
  expect(newBillingCapCrossings({ previous: capped, current: capped })).toEqual(
    [],
  );
  expect(
    newBillingCapCrossings({ previous: capped, current: threshold }),
  ).toEqual([]);
  expect(
    newBillingCapCrossings({ previous: threshold, current: capped }),
  ).toEqual(["cap"]);
  expect(newBillingCapCrossings({ previous: capped, current: below })).toEqual(
    [],
  );
  expect(
    newBillingCapCrossings({ previous: below, current: threshold }),
  ).toEqual(["threshold"]);
});

test.each([
  { amount: null, minutes: 100, amountState: "below", minuteState: "above" },
  { amount: 1000, minutes: null, amountState: "above", minuteState: "below" },
  { amount: 1000, minutes: 100, amountState: "above", minuteState: "above" },
  { amount: null, minutes: null, amountState: "below", minuteState: "below" },
])(
  "amount $amount and minute $minutes caps evaluate independently",
  ({ amount, minutes, amountState, minuteState }) => {
    const result = evaluateBillingArrangementCaps({
      totalAmount: 1000n,
      totalMinutes: 100n,
      capAmount: amount,
      capMinutes: minutes,
      alertThresholdBps: 8000,
    });
    expect(result.amount.capState).toBe(amountState);
    expect(result.minutes.capState).toBe(minuteState);
  },
);
