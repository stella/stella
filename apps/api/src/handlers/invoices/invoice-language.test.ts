import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { INVOICE_LANGUAGES } from "@stll/api-contract";

import { invoiceLanguageForCountry } from "@/api/lib/billing/invoice-language";
import { invoiceLanguageSchema } from "@/api/lib/custom-schema";

describe("invoice language schema", () => {
  test("an omitted language stays omitted, so the client, organization and seller defaults decide", () => {
    const body = v.object({ language: v.optional(invoiceLanguageSchema) });
    expect(v.parse(body, {})).toEqual({});
  });

  test("accepts every contract language and nothing else", () => {
    for (const language of INVOICE_LANGUAGES) {
      expect(v.is(invoiceLanguageSchema, language)).toBe(true);
    }
    expect(v.is(invoiceLanguageSchema, "xx")).toBe(false);
  });

  test("derives the language from the seller country", () => {
    expect(invoiceLanguageForCountry("SK")).toBe("sk");
    expect(invoiceLanguageForCountry("cz")).toBe("cs");
    expect(invoiceLanguageForCountry("AR")).toBe("es");
    expect(invoiceLanguageForCountry(null)).toBe("en");
  });
});
