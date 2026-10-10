import { describe, expect, test } from "bun:test";

import { appLocale } from "./locale";

describe("MCP app host locales", () => {
  test.each([
    ["cs-CZ", "cs", "Dokument 123"],
    ["sk-SK", "sk", "Dokument 123"],
    ["en-GB", "en", "Document 123"],
  ])(
    "regional host locale %s selects catalog %s",
    (hostLocale, expected, documentLabel) => {
      const locale = appLocale(hostLocale);
      expect(locale.locale).toBe(expected);
      expect(locale.formattingLocale).toBe(hostLocale);
      expect(locale.t("comparisonTitle")).toBe(locale.messages.comparisonTitle);
      expect(locale.t("documentTarget", { documentId: "123" })).toBe(
        documentLabel,
      );
    },
  );

  test.each([undefined, "invalid_locale!", "ja-JP"])(
    "missing, malformed and unsupported host locales use English: %s",
    (hostLocale) => {
      const locale = appLocale(hostLocale);
      expect(locale.locale).toBe("en");
      expect(locale.t("comparisonTitle")).toBe("Compare two files");
    },
  );
});
