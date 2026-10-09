import { describe, expect, test } from "bun:test";

import {
  normalizeUnicode,
  stripUnicodeMarks,
  UNICODE_NORMALIZATION_FORMS,
} from "./unicode";

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
