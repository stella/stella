import { describe, expect, test } from "bun:test";

import shortTexts from "./short-text.test-fixture.json";
import {
  classifyCourtListenerText,
  type CourtListenerTextUsability,
} from "./usability";

describe("CourtListener short text usability", () => {
  test.each([
    "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\n\nCase: 24-12345 Date Filed: 01/01/2024 Page: 2 of 2",
    "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\nOffice of the Attorney General\nUnited States Court of Appeals for the Second Circuit",
    "Case: 24-12345\nDate Filed: 01/01/2024 Page: 1 of 2\n\nCase: 24-12345\nDate Filed: 01/01/2024 Page: 2 of 2",
  ])("multiple metadata blocks contain no ruling: %s", (body) => {
    expect(classifyCourtListenerText(body)).toBe("no-ruling-text");
    expect(classifyCourtListenerText(`${body}\n\nThe order is vacated.`)).toBe(
      "usable",
    );
  });
  test("covers every reviewed group and synthetic text", () => {
    expect(shortTexts).toHaveLength(281);
    expect(
      shortTexts.reduce((count, { texts }) => count + texts.length, 0),
    ).toBe(530);
    expect(
      new Set(shortTexts.map(({ normalisedText }) => normalisedText)).size,
    ).toBe(shortTexts.length);
    for (const { normalisedText, texts } of shortTexts) {
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.toLowerCase().replace(/[0-9]/gu, "9")).toBe(normalisedText);
      }
    }
  });

  test.each(shortTexts)("$expected: $normalisedText", ({ expected, texts }) => {
    for (const text of texts) {
      expect(expected).toBe(classifyCourtListenerText(text));
    }
  });

  test("synthetic identity swaps preserve the expected outcome of every group", () => {
    const counts = new Map<string, number>();
    for (const { expected, group, texts } of shortTexts) {
      expect(group).toMatch(/^group-\d{3}$/u);
      counts.set(expected, (counts.get(expected) ?? 0) + texts.length);
      for (const text of texts) {
        const swapped = text
          .replace(/\bz(?=\p{L})/giu, (letter) => (letter === "Z" ? "Q" : "q"))
          .replace(/\d/gu, (numeral) => String((Number(numeral) + 1) % 10));
        expect(expected).toBe(classifyCourtListenerText(text));
        expect(expected).toBe(classifyCourtListenerText(swapped));
      }
    }
    expect(Object.fromEntries(counts)).toEqual({
      usable: 416,
      "source-placeholder": 59,
      "no-ruling-text": 42,
      undecodable: 13,
    });
  });

  test.each([
    "Affirmed.",
    "Denied.",
    "Granted.",
    "Dismissed.",
    "Per curiam.",
    "Appeal dismissed.",
    "It is so ordered.",
    "C. A. 9th Cir. certiorari denied.",
    "Certiorari denied without opinion. 123 So.2d 456.",
    "Judgment affirmed by default.",
    "See S. C., 1 N.C. 123.",
  ])("retains the published short ruling %s", (text) => {
    expect(classifyCourtListenerText(text)).toBe("usable");
  });

  test.each([
    ["Unable\tto extract\n document content", "source-placeholder"],
    [
      "No opinion found.\nClick here to view source material.",
      "source-placeholder",
    ],
    ["USCA2 Opinion can't open 24-9876A.pdf", "source-placeholder"],
    ["USCA2 Opinion can't open 24-9876A.pdf\n\nAppeal denied.", "usable"],
    ["Opinion # ZZ-98765 was never issued.", "source-placeholder"],
    ["Opinion # XY-678 was never released.", "source-placeholder"],
    ["Present — Zqhr, J. The order is vacated.", "usable"],
    ["???\n\nWe vacate judgment.", "usable"],
    ["(b) (7)(C)\n\n(b) (6)", "no-ruling-text"],
    ["Zqhr, J.\n\n17/08/2088", "no-ruling-text"],
    ["\ufffd\ufffd\ufffd\ufffd", "undecodable"],
    ["\ufeffc\ufeff\ufeff", "undecodable"],
    ["\ufffda\ufffdb\ufffdc\ufffd", "undecodable"],
    ["ï»¿c", "undecodable"],
    ["[Affirmed.]", "usable"],
    ["(Denied.)", "usable"],
    ["Certiorari denied. 987 F.3d 654.", "usable"],
    ["We deny B2.", "usable"],
    ["No opinion. Judgment affirmed, with costs.", "usable"],
    ["Memorandum decisions.\n\nAppeal dismissed.", "usable"],
    ["Office of the Attorney General requested relief [denied].", "usable"],
    ["OFFICE OF\n?t’HE &I!TORNEY GENERAL\n\nAmrmx. ZQULV\n\nDenied.", "usable"],
    ["OFFICE OF\n?t’HE &I!TORNEY GENERAL\n\nThe order is vacated.", "usable"],
    [
      "The clerk was unable to extract document content, but the appeal is denied.",
      "usable",
    ],
  ] satisfies [string, CourtListenerTextUsability][])(
    "classifies structural variants: %s",
    (text, expected) => {
      expect(classifyCourtListenerText(text)).toBe(expected);
    },
  );
});
