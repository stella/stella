import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { contactBirthDateSchema } from "./contact-date";

describe("contact birth date chronology", () => {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();

  test.each([
    { precision: "year", year: 1900 },
    { precision: "month", year: 1900, month: 1 },
    { precision: "day", year: 1900, month: 1, day: 1 },
    { precision: "year", year },
    { precision: "month", year, month },
    { precision: "day", year, month, day },
  ] as const)("accepts $precision precision through today", (value) => {
    expect(v.safeParse(contactBirthDateSchema, value).success).toBe(true);
  });

  test.each([
    { precision: "year", year: 0 },
    { precision: "year", year: 1899 },
    { precision: "year", year: year + 1 },
    { precision: "day", year: 2000, month: 2, day: 30 },
  ] as const)("rejects an impossible or out-of-range date", (value) => {
    expect(v.safeParse(contactBirthDateSchema, value).success).toBe(false);
  });
});
