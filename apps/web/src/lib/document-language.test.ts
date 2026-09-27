import { describe, expect, test } from "bun:test";

import { resolveDocumentLanguage } from "@/lib/document-language";

describe("page language", () => {
  test("a Czech document marks the page Czech under an English interface", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "cs",
        interfaceLocale: "en",
      }),
    ).toBe("cs");
  });

  test("a regional or differently cased document tag reduces to its language", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "SK_sk",
        interfaceLocale: "en",
      }),
    ).toBe("sk");
  });

  test("a document language outside the interface locales is kept", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "sl",
        interfaceLocale: "cs",
      }),
    ).toBe("sl");
  });

  test("a page without a document follows the interface locale", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: null,
        interfaceLocale: "pt-BR",
      }),
    ).toBe("pt-BR");
  });

  test("an unrecognised document tag falls back to the interface locale", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "zz-unknown",
        interfaceLocale: "de",
      }),
    ).toBe("de");
  });
});
