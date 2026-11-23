import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  evaluateBillingArrangementCaps,
  evaluateBillingCap,
  exceedsBillingCaps,
  newBillingCapCrossings,
} from "./arrangements.logic";

const amountArb = fc.bigInt({ min: 0n, max: 100_000_000n });
const positiveCapArb = fc.bigInt({ min: 1n, max: 100_000_000n });
const thresholdBpsArb = fc.integer({ min: 0, max: 10_000 });
const optionalCapNumberArb = fc.option(
  fc.integer({ min: 1, max: 10_000_000 }),
  {
    nil: null,
  },
);

describe("billing arrangements cap properties", () => {
  test("cap above implies threshold above whenever alertThresholdBps <= 10000", () => {
    assertProperty(
      "cap above implies threshold above whenever alertThresholdBps <= 10000",
      fc.property(
        amountArb,
        positiveCapArb,
        thresholdBpsArb,
        (totalAmount, capAmount, alertThresholdBps) => {
          const result = evaluateBillingCap({
            totalAmount,
            capAmount,
            alertThresholdBps,
          });
          if (result.capState === "above") {
            expect(result.thresholdState).toBe("above");
          }
          expect(result.capState).toBe(
            totalAmount >= capAmount ? "above" : "below",
          );
        },
      ),
    );
  });

  test("evaluateBillingCap is monotonic with respect to totalAmount", () => {
    assertProperty(
      "evaluateBillingCap is monotonic with respect to totalAmount",
      fc.property(
        amountArb,
        fc.bigInt({ min: 0n, max: 50_000_000n }),
        positiveCapArb,
        thresholdBpsArb,
        (baseAmount, delta, capAmount, alertThresholdBps) => {
          const before = evaluateBillingCap({
            totalAmount: baseAmount,
            capAmount,
            alertThresholdBps,
          });
          const after = evaluateBillingCap({
            totalAmount: baseAmount + delta,
            capAmount,
            alertThresholdBps,
          });
          if (before.thresholdState === "above") {
            expect(after.thresholdState).toBe("above");
          }
          if (before.capState === "above") {
            expect(after.capState).toBe("above");
          }
        },
      ),
    );
  });

  test("newBillingCapCrossings only reports below-to-above transitions", () => {
    const stateArb = fc.record({
      thresholdState: fc.constantFrom<"below" | "above">("below", "above"),
      capState: fc.constantFrom<"below" | "above">("below", "above"),
    });
    assertProperty(
      "newBillingCapCrossings only reports below-to-above transitions",
      fc.property(stateArb, stateArb, (previous, current) => {
        const crossings = newBillingCapCrossings({ previous, current });
        expect(crossings.includes("threshold")).toBe(
          previous.thresholdState === "below" &&
            current.thresholdState === "above",
        );
        expect(crossings.includes("cap")).toBe(
          previous.capState === "below" && current.capState === "above",
        );
        expect(newBillingCapCrossings({ previous: current, current })).toEqual(
          [],
        );
      }),
    );
  });

  test("null caps never trigger threshold/cap states or exceedsBillingCaps", () => {
    assertProperty(
      "null caps never trigger threshold/cap states or exceedsBillingCaps",
      fc.property(
        amountArb,
        amountArb,
        optionalCapNumberArb,
        optionalCapNumberArb,
        thresholdBpsArb,
        (
          totalAmount,
          totalMinutes,
          capAmount,
          capMinutes,
          alertThresholdBps,
        ) => {
          const caps = evaluateBillingArrangementCaps({
            totalAmount,
            totalMinutes,
            capAmount,
            capMinutes,
            alertThresholdBps,
          });
          if (capAmount === null) {
            expect(caps.amount).toEqual({
              thresholdState: "below",
              capState: "below",
            });
          }
          if (capMinutes === null) {
            expect(caps.minutes).toEqual({
              thresholdState: "below",
              capState: "below",
            });
          }
          const exceeds = exceedsBillingCaps({
            totalAmount,
            totalMinutes,
            capAmount,
            capMinutes,
          });
          if (capAmount === null && capMinutes === null) {
            expect(exceeds).toBe(false);
          }
          if (exceeds) {
            expect(
              caps.amount.capState === "above" ||
                caps.minutes.capState === "above",
            ).toBe(true);
          }
        },
      ),
    );
  });
});
