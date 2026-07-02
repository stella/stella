import { describe, expect, test } from "bun:test";

import {
  normalizeEstablishmentId,
  normalizeStateCode,
  validateEstablishmentId,
  validateStateCode,
} from "./validation.js";

describe("normalizeEstablishmentId", () => {
  test("strips whitespace", () => {
    expect(normalizeEstablishmentId(" 628 1106\n")).toBe("6281106");
  });
});

describe("validateEstablishmentId", () => {
  test("accepts numeric DENUE establishment ids", () => {
    expect(validateEstablishmentId("6281106")).toBe(true);
    expect(validateEstablishmentId("34185")).toBe(true);
  });

  test("rejects non-numeric and empty ids", () => {
    expect(validateEstablishmentId("ABC123")).toBe(false);
    expect(validateEstablishmentId("")).toBe(false);
  });
});

describe("state code validation", () => {
  test("normalizes one-digit state codes", () => {
    expect(normalizeStateCode("9")).toBe("09");
  });

  test("accepts national and Mexican state codes", () => {
    expect(validateStateCode("00")).toBe(true);
    expect(validateStateCode("01")).toBe(true);
    expect(validateStateCode("32")).toBe(true);
  });

  test("rejects out-of-range state codes", () => {
    expect(validateStateCode("33")).toBe(false);
    expect(validateStateCode("99")).toBe(false);
    expect(validateStateCode("MX")).toBe(false);
  });
});
