import { expect, test } from "bun:test";

import { standardVatRateOn } from "./vat-rate-period";

const periods = [
  { validFrom: "2020-01-01", validTo: "2026-07-01", rateBps: 2100 },
  { validFrom: "2026-07-01", validTo: null, rateBps: 2300 },
  { validFrom: "2020-01-01", validTo: null, rateBps: 1200 },
];

test("picks the highest rate whose period covers the date", () => {
  expect(standardVatRateOn(periods, "2026-06-30")).toBe(2100);
  // validTo is exclusive: the new rate applies from its first day.
  expect(standardVatRateOn(periods, "2026-07-01")).toBe(2300);
});

test("has no rate before any period starts", () => {
  expect(standardVatRateOn(periods, "2019-12-31")).toBeNull();
  expect(standardVatRateOn([], "2026-07-01")).toBeNull();
});
