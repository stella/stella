import { describe, expect, test } from "bun:test";

import { resolveOutlookLocale } from "@/i18n";

describe("resolveOutlookLocale", () => {
  test("normalizes the declared English Office locale", () => {
    expect(resolveOutlookLocale(["en-US"])).toBe("en");
  });

  test("falls back to the manifest default for unsupported locales", () => {
    expect(resolveOutlookLocale(["cs-CZ", "de-DE"])).toBe("en");
  });
});
