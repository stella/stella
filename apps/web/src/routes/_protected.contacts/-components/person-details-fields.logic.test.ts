import { describe, expect, test } from "bun:test";

import {
  birthDateDraft,
  normalizeBirthDateDigits,
  parseBirthDateDraft,
} from "@/routes/_protected.contacts/-components/person-details-fields.logic";

describe("person date of birth precision", () => {
  test("accepts Arabic and Eastern Arabic digits at the input boundary", () => {
    expect(normalizeBirthDateDigits("١٩٨٤")).toBe("1984");
    expect(normalizeBirthDateDigits("۱۹۸۴")).toBe("1984");
    expect(normalizeBirthDateDigits("２０００")).toBe("2000");
  });
  test("preserves year, month, and full-date precision", () => {
    expect(birthDateDraft({ precision: "year", year: 1984 })).toEqual({
      precision: "year",
      year: "1984",
      month: "",
      day: "",
    });
    expect(
      parseBirthDateDraft({
        precision: "month",
        year: "1984",
        month: "3",
        day: "",
      }),
    ).toEqual({ precision: "month", year: 1984, month: 3 });
    expect(
      parseBirthDateDraft({
        precision: "day",
        year: "2000",
        month: "2",
        day: "29",
      }),
    ).toEqual({ precision: "day", year: 2000, month: 2, day: 29 });
  });

  test("rejects unsupported years and invalid calendar dates", () => {
    expect(
      parseBirthDateDraft({
        precision: "year",
        year: "0999",
        month: "",
        day: "",
      }),
    ).toBeNull();
    expect(
      parseBirthDateDraft({
        precision: "day",
        year: "1900",
        month: "2",
        day: "29",
      }),
    ).toBeNull();
    expect(
      parseBirthDateDraft({
        precision: "day",
        year: "2000",
        month: "4",
        day: "31",
      }),
    ).toBeNull();
  });
});
