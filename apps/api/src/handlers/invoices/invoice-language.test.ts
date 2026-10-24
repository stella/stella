import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { t } from "elysia";

import { INVOICE_LANGUAGES } from "@stll/api-contract";

import { invoiceLanguageForCountry } from "@/api/lib/billing/invoice-language";
import { tInvoiceLanguage } from "@/api/lib/custom-schema";

describe("invoice language schema", () => {
  test("an omitted language stays omitted, so the client, organization and seller defaults decide", () => {
    const body = t.Object({ language: t.Optional(tInvoiceLanguage) });
    expect(Value.Default(body, {})).toEqual({});
    expect("default" in tInvoiceLanguage).toBe(false);
  });

  test("accepts every contract language and nothing else", () => {
    for (const language of INVOICE_LANGUAGES) {
      expect(Value.Check(tInvoiceLanguage, language)).toBe(true);
    }
    expect(Value.Check(tInvoiceLanguage, "xx")).toBe(false);
  });

  test("derives the language from the seller country", () => {
    expect(invoiceLanguageForCountry("SK")).toBe("sk");
    expect(invoiceLanguageForCountry("cz")).toBe("cs");
    expect(invoiceLanguageForCountry("AR")).toBe("es");
    expect(invoiceLanguageForCountry(null)).toBe("en");
  });
});
