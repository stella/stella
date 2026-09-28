import { describe, expect, test } from "bun:test";

import { resolveDocumentLanguage } from "@/i18n/page-language";

describe("page language", () => {
  test("a Czech document marks the page Czech under an English interface", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "cs",
        interfaceLocale: "en",
      }),
    ).toEqual({ lang: "cs", source: "document" });
  });

  test("a regional or differently cased document tag reduces to its language", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "SK_sk",
        interfaceLocale: "en",
      }),
    ).toEqual({ lang: "sk", source: "document" });
  });

  test("a document language outside the interface locales is kept", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "sl",
        interfaceLocale: "cs",
      }),
    ).toEqual({ lang: "sl", source: "document" });
  });

  test("a page without a document follows the interface locale", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: null,
        interfaceLocale: "pt-BR",
      }),
    ).toEqual({ lang: "pt-BR", source: "interface" });
  });

  test("an unrecognised document tag falls back to the interface locale", () => {
    expect(
      resolveDocumentLanguage({
        documentLanguage: "zz-unknown",
        interfaceLocale: "de",
      }),
    ).toEqual({ lang: "de", source: "interface" });
  });
});
