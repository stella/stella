import { describe, expect, test } from "bun:test";

import {
  applyDateFields,
  DATE_FORMAT_EXAMPLE_ISO,
  formatDateExample,
  formatIsoDate,
  resolveDateFields,
} from "@/api/handlers/docx/date-fields";
import type { FieldMeta } from "@/api/handlers/docx/types";

const dateField = (
  path: string,
  locale: string,
  style: "long" | "medium" | "short" | "iso",
): FieldMeta => ({
  path,
  inputType: "date",
  dateFormat: { locale, style },
});

describe("formatIsoDate", () => {
  test("cs long renders the genitive month name via ICU", () => {
    // The standard Czech date case is genitive ("června", not "červen");
    // Intl.DateTimeFormat with full ICU produces it without any hand-rolled
    // month table.
    expect(formatIsoDate("2028-06-13", { locale: "cs", style: "long" })).toBe(
      "13. června 2028",
    );
  });

  test("de, pl, and en long styles localize per document language", () => {
    expect(formatIsoDate("2028-06-13", { locale: "de", style: "long" })).toBe(
      "13. Juni 2028",
    );
    expect(formatIsoDate("2028-06-13", { locale: "pl", style: "long" })).toBe(
      "13 czerwca 2028",
    );
    expect(formatIsoDate("2028-06-13", { locale: "en", style: "long" })).toBe(
      "June 13, 2028",
    );
  });

  test("medium and short styles use the locale's compact conventions", () => {
    expect(formatIsoDate("2028-06-13", { locale: "cs", style: "medium" })).toBe(
      "13. 6. 2028",
    );
    expect(formatIsoDate("2028-06-13", { locale: "de", style: "short" })).toBe(
      "13.06.28",
    );
  });

  test("iso passes the validated value through unchanged", () => {
    expect(formatIsoDate("2028-06-13", { locale: "cs", style: "iso" })).toBe(
      "2028-06-13",
    );
  });

  test("rejects malformed and non-existent calendar dates", () => {
    expect(
      formatIsoDate("not-a-date", { locale: "cs", style: "long" }),
    ).toBeNull();
    expect(
      formatIsoDate("13.06.2028", { locale: "cs", style: "long" }),
    ).toBeNull();
    // Date would silently roll 2028-02-30 over to March 1.
    expect(
      formatIsoDate("2028-02-30", { locale: "cs", style: "long" }),
    ).toBeNull();
    expect(
      formatIsoDate("2028-02-30", { locale: "cs", style: "iso" }),
    ).toBeNull();
  });

  test("accepts a leap-day that exists", () => {
    expect(formatIsoDate("2028-02-29", { locale: "en", style: "long" })).toBe(
      "February 29, 2028",
    );
  });
});

describe("resolveDateFields", () => {
  test("formats the submitted value in place, including nested paths", () => {
    const values: Record<string, unknown> = {
      signature_date: "2028-06-13",
      contract: { date: "2028-06-13" },
    };
    const errors = resolveDateFields({
      values,
      fields: [
        dateField("signature_date", "cs", "long"),
        dateField("contract.date", "de", "long"),
      ],
    });
    expect(errors).toEqual([]);
    expect(values["signature_date"]).toBe("13. června 2028");
    expect(values["contract"]).toEqual({ date: "13. Juni 2028" });
  });

  test("rejects an invalid date naming the field", () => {
    const values: Record<string, unknown> = { signature_date: "2028-02-30" };
    const errors = resolveDateFields({
      values,
      fields: [dateField("signature_date", "cs", "long")],
    });
    expect(errors).toEqual([
      {
        path: "signature_date",
        message:
          'Field "signature_date": "2028-02-30" is not a valid date ' +
          "(expected YYYY-MM-DD).",
      },
    ]);
    expect(values["signature_date"]).toBe("2028-02-30");
  });

  test("rejects a non-string value naming the field", () => {
    const errors = resolveDateFields({
      values: { signature_date: 20_280_613 },
      fields: [dateField("signature_date", "cs", "long")],
    });
    expect(errors).toEqual([
      {
        path: "signature_date",
        message: 'Field "signature_date": expected an ISO date (YYYY-MM-DD).',
      },
    ]);
  });

  test("leaves fields without a dateFormat, non-date fields, and absent or empty values unchanged", () => {
    const values: Record<string, unknown> = {
      plain_date: "2028-06-13",
      not_a_date_input: "2028-06-13",
      empty: "",
    };
    const errors = resolveDateFields({
      values,
      fields: [
        { path: "plain_date", inputType: "date" },
        {
          path: "not_a_date_input",
          inputType: "text",
          dateFormat: { locale: "cs", style: "long" },
        },
        dateField("empty", "cs", "long"),
        dateField("absent", "cs", "long"),
      ],
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({
      plain_date: "2028-06-13",
      not_a_date_input: "2028-06-13",
      empty: "",
    });
  });
});

describe("applyDateFields", () => {
  test("returns null and formats in place on success; null manifest is a no-op", () => {
    const values: Record<string, unknown> = { signature_date: "2028-06-13" };
    expect(
      applyDateFields(values, {
        fields: [dateField("signature_date", "pl", "long")],
      }),
    ).toBeNull();
    expect(values["signature_date"]).toBe("13 czerwca 2028");

    expect(applyDateFields({ signature_date: "garbage" }, null)).toBeNull();
  });

  test("combines error messages across fields", () => {
    const message = applyDateFields(
      { a: "bad", b: "2028-13-01" },
      { fields: [dateField("a", "cs", "long"), dateField("b", "cs", "short")] },
    );
    expect(message).toBe(
      'Field "a": "bad" is not a valid date (expected YYYY-MM-DD). ' +
        'Field "b": "2028-13-01" is not a valid date (expected YYYY-MM-DD).',
    );
  });
});

describe("formatDateExample", () => {
  test("renders the exemplar date for config previews", () => {
    expect(formatDateExample({ locale: "cs", style: "long" })).toBe(
      "13. června 2028",
    );
    expect(formatDateExample({ locale: "en", style: "medium" })).toBe(
      "Jun 13, 2028",
    );
    expect(formatDateExample({ locale: "cs", style: "iso" })).toBe(
      DATE_FORMAT_EXAMPLE_ISO,
    );
  });
});
