import { describe, expect, test } from "bun:test";

import { extractFormattingLocale, extractLangFromRequest } from "./locale";

describe("request locale preferences", () => {
  test("keeps message language independent from regional formatting", () => {
    const request = new Request("https://api.example.test", {
      headers: {
        "Accept-Language": "ar",
        "X-Stella-Formatting-Locale": "en-IN",
      },
    });

    expect(extractLangFromRequest(request)).toBe("ar");
    expect(extractFormattingLocale(request)).toBe("en-IN");
  });

  test("falls back to Accept-Language when the formatting header is unsupported", () => {
    const request = new Request("https://api.example.test", {
      headers: {
        "Accept-Language": "de-DE",
        "X-Stella-Formatting-Locale": "ja-JP",
      },
    });

    expect(extractFormattingLocale(request)).toBe("de-DE");
  });

  test("preserves Unicode formatting extensions from legacy clients", () => {
    const request = new Request("https://api.example.test", {
      headers: {
        "Accept-Language": "ar-SA-u-ca-gregory-nu-arab",
      },
    });

    expect(extractFormattingLocale(request)).toBe("ar-SA-u-ca-gregory-nu-arab");
  });
});
