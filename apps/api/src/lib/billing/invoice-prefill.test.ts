import { describe, expect, test } from "bun:test";

import { invoiceLanguageForSeller } from "./invoice-prefill";

describe("invoice prefill language", () => {
  test.each([
    ["DE", "de"],
    ["Germany", "de"],
    ["FR", "fr"],
    ["PL", "pl"],
    ["AE", "ar"],
  ] as const)("retains the original seller country %s", (country, language) => {
    expect(invoiceLanguageForSeller({ country, vatId: null })).toBe(language);
  });
  test("uses a VAT-derived seller country when the address country is absent", () => {
    expect(
      invoiceLanguageForSeller({ country: null, vatId: "SK2020123456" }),
    ).toBe("sk");
  });
});
