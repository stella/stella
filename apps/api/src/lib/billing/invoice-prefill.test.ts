import { describe, expect, test } from "bun:test";

import { invoiceLanguageForSeller } from "./invoice-prefill";

describe("invoice prefill language", () => {
  test("uses a VAT-derived seller country when the address country is absent", () => {
    expect(
      invoiceLanguageForSeller({ country: null, vatId: "SK2020123456" }),
    ).toBe("sk");
  });
});
