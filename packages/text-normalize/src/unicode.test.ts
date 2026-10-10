import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  normalizeUnicode,
  stripUnicodeMarks,
  UNICODE_NORMALIZATION_FORMS,
} from "./unicode";
import type { UnicodeMarkClass } from "./unicode";

describe("Unicode normalization", () => {
  test("preserves the native result for every supported form", () => {
    const input = "Ångström ①";

    for (const form of UNICODE_NORMALIZATION_FORMS) {
      expect(normalizeUnicode(input, form)).toBe(input.normalize(form));
    }
  });

  test("keeps the selected mark class exact", () => {
    const input = "é\u1ab0";

    expect(
      stripUnicodeMarks(input, { form: "NFD", markClass: "combining" }),
    ).toBe("e");
    expect(
      stripUnicodeMarks(input, { form: "NFD", markClass: "basic-combining" }),
    ).toBe("e\u1ab0");
  });
});

const utf16Text = fc
  .array(fc.integer({ min: 0, max: 0xff_ff }), { maxLength: 80 })
  .map((units) => String.fromCodePoint(...units));

const historicalMarkPatterns = {
  combining: { markClass: "combining", pattern: /\p{M}/gu },
  diacritic: { markClass: "diacritic", pattern: /\p{Diacritic}/gu },
  "basic-combining": {
    markClass: "basic-combining",
    pattern: /[\u0300-\u036f]/gu,
  },
} as const satisfies {
  [Class in UnicodeMarkClass]: { markClass: Class; pattern: RegExp };
};

test("Unicode owner preserves native results for arbitrary UTF-16 text", () => {
  assertProperty(
    "Unicode owner preserves native results for arbitrary UTF-16 text",
    fc.property(utf16Text, (text) => {
      for (const form of UNICODE_NORMALIZATION_FORMS) {
        const native = text.normalize(form);
        expect(normalizeUnicode(text, form)).toBe(native);
        for (const { markClass, pattern } of Object.values(
          historicalMarkPatterns,
        )) {
          expect(stripUnicodeMarks(text, { form, markClass })).toBe(
            native.replace(pattern, ""),
          );
        }
      }
    }),
  );
});
