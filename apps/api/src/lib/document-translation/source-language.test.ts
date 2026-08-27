import { describe, expect, test } from "bun:test";

import { detectDocumentTranslationSourceLanguage } from "./source-language";

describe("document translation source-language detection", () => {
  test("detects a substantial English document", () => {
    const result = detectDocumentTranslationSourceLanguage(`
      This agreement is entered into by the parties on the effective date.
      The parties agree that each obligation, representation, and warranty in
      this agreement remains binding according to its terms. The court has
      jurisdiction over every dispute arising from this agreement, and each
      party must provide written notice before bringing a claim.
    `);

    expect(result.type).toBe("detected");
    if (result.type === "detected") {
      expect(result.language).toBe("EN-GB");
    }
  });

  test("detects Japanese without relying on the UI locale", () => {
    const result = detectDocumentTranslationSourceLanguage(`
      この契約は当事者間の権利および義務を定めるものです。
      各当事者は契約条件を誠実に履行し、必要な通知を書面で行います。
      紛争が生じた場合には、当事者はまず協議による解決を試みます。
    `);

    expect(result.type).toBe("detected");
    if (result.type === "detected") {
      expect(result.language).toBe("JA");
    }
  });

  test("returns unknown for content without enough language evidence", () => {
    expect(detectDocumentTranslationSourceLanguage("§ 1 / 2026")).toEqual({
      type: "unknown",
    });
  });
});
