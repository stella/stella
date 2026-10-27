import { describe, expect, test } from "bun:test";

import { checkPaymentAmount } from "./invoice-payments.logic";

describe("checkPaymentAmount", () => {
  test("accepts up to the outstanding amount, in the invoice's minor units", () => {
    expect(
      checkPaymentAmount({
        input: "60.00",
        currency: "USD",
        outstandingAmount: 6000,
      }),
    ).toEqual({ type: "ok", amount: 6000 });
    expect(
      checkPaymentAmount({
        input: "12.5",
        currency: "EUR",
        outstandingAmount: 6000,
      }),
    ).toEqual({ type: "ok", amount: 1250 });
    // A zero-decimal currency counts whole units.
    expect(
      checkPaymentAmount({
        input: "100",
        currency: "JPY",
        outstandingAmount: 100,
      }),
    ).toEqual({ type: "ok", amount: 100 });
  });

  test("refuses one minor unit above the outstanding amount", () => {
    expect(
      checkPaymentAmount({
        input: "60.01",
        currency: "USD",
        outstandingAmount: 6000,
      }),
    ).toEqual({ type: "more_than_outstanding" });
    expect(
      checkPaymentAmount({
        input: "101",
        currency: "JPY",
        outstandingAmount: 100,
      }),
    ).toEqual({ type: "more_than_outstanding" });
  });

  test("refuses nothing, zero and text that is not an amount", () => {
    for (const input of ["", "0", "0.00", "-5", "abc"]) {
      expect(
        checkPaymentAmount({ input, currency: "USD", outstandingAmount: 6000 }),
      ).toEqual({ type: "not_positive" });
    }
  });
});
