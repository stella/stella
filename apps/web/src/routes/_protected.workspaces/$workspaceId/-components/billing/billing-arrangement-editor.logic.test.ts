import { expect, test } from "bun:test";
import * as v from "valibot";

import { cents } from "@stll/money";

import { hourlyArrangementSchema } from "./billing-arrangement-editor.logic";

const schema = hourlyArrangementSchema("Invalid cap");
const input = {
  currency: "USD",
  capAmount: "",
  capMinutes: "120",
  alertThreshold: "80",
};

test("minute caps and percentage thresholds become integer contract values", () => {
  expect(v.parse(schema, input)).toEqual({
    currency: "USD",
    capMinutes: 120,
    alertThresholdBps: 8000,
  });
  expect(v.parse(schema, { ...input, capAmount: "1250.50" })).toEqual({
    currency: "USD",
    capAmount: cents(125_050),
    capMinutes: 120,
    alertThresholdBps: 8000,
  });
  expect(
    v.parse(schema, {
      ...input,
      capMinutes: "",
      capAmount: "100.00",
      alertThreshold: "0.01",
    }),
  ).toEqual({
    currency: "USD",
    capAmount: cents(10_000),
    alertThresholdBps: 1,
  });
  expect(v.parse(schema, { ...input, capMinutes: "" })).toEqual({
    currency: "USD",
  });
});

test.each(["1e2", "1.5", " 60", "+60", "-0", "0", "Infinity", "2147483648"])(
  "minute input refuses the noncanonical or out-of-range token %s",
  (capMinutes) => {
    expect(v.safeParse(schema, { ...input, capMinutes }).success).toBe(false);
  },
);

test.each(["1e2", " 80", "0", "0.001", "100.01", "Infinity"])(
  "percentage input refuses the noncanonical or out-of-range token %s",
  (alertThreshold) => {
    expect(v.safeParse(schema, { ...input, alertThreshold }).success).toBe(
      false,
    );
  },
);

test.each([
  { currency: "JPY", capAmount: "250", expected: cents(250) },
  { currency: "KWD", capAmount: "2.500", expected: cents(2500) },
])(
  "amount caps use $currency minor units",
  ({ currency, capAmount, expected }) => {
    expect(
      v.parse(schema, { ...input, currency, capAmount, capMinutes: "" }),
    ).toEqual({ currency, capAmount: expected, alertThresholdBps: 8000 });
  },
);
