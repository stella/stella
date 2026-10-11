import { describe, expect, test } from "bun:test";

import shortTexts from "./short-text.test-fixture.json";
import {
  classifyCourtListenerText,
  type CourtListenerTextUsability,
} from "./usability";

describe("CourtListener short text usability", () => {
  test.each([
    [
      "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\n\nUnable to extract document content",
      "source-placeholder",
    ],
    [
      "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\nUnable to extract document content",
      "source-placeholder",
    ],
    [
      "Unable to extract document content\n\nUnable to extract document content",
      "source-placeholder",
    ],
    [
      "No opinion found.\nClick here to view source material.",
      "source-placeholder",
    ],
    [
      "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\n\nOffice of the Attorney General",
      "no-ruling-text",
    ],
    ["Mr. Justice Zqvrvv\n\ndelivered the opinion of the court.", "usable"],
    [
      "Mr. Justice Zqvrvv\n\nUnable to extract document content\n\ndelivered the opinion of the court.",
      "usable",
    ],
    [
      "Office of the Attorney General\nThis opinion has been withdrawn.\n\nOpinion #C-729",
      "source-placeholder",
    ],
    [
      "This opinion has been withdrawn.\nOffice of the Attorney General\n\nOpinion #C-729",
      "source-placeholder",
    ],
  ] satisfies [string, CourtListenerTextUsability][])(
    "classifies metadata and publisher placeholder blocks: %s",
    (body, expected) => {
      expect(classifyCourtListenerText(body)).toBe(expected);
      expect(
        classifyCourtListenerText(`${body}\n\nThe order is vacated.`),
      ).toBe("usable");
    },
  );

  test.each([
    [
      "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\n\nCase: 24-12345 Date Filed: 01/01/2024 Page: 2 of 2",
      "no-ruling-text",
    ],
    [
      "Case: 24-12345 Date Filed: 01/01/2024 Page: 1 of 2\nOffice of the Attorney General\nUnited States Court of Appeals for the Second Circuit",
      "no-ruling-text",
    ],
    [
      "Case: 24-12345\nDate Filed: 01/01/2024 Page: 1 of 2\n\nCase: 24-12345\nDate Filed: 01/01/2024 Page: 2 of 2",
      "no-ruling-text",
    ],
    ["Office of the attoheey general\n\n.\n\n. .", "no-ruling-text"],
    ["Opinion by\n\nJustice Zqlrv.\n\nNot to be published in full.", "usable"],
    [
      "In the Zqykvv Zqbkvv Court of Appeals\n\nfor the Eleventh Circuit",
      "usable",
    ],
    ["9999 qx super 99u\n\n99s9s9999", "no-ruling-text"],
    ["J\nanu\n\nary99,999\n\n9", "usable"],
  ] satisfies [string, CourtListenerTextUsability][])(
    "classifies whole metadata blocks without crossing paragraphs: %s",
    (body, expected) => {
      expect(classifyCourtListenerText(body)).toBe(expected);
      expect(
        classifyCourtListenerText(`${body}\n\nThe order is vacated.`),
      ).toBe("usable");
    },
  );
  test("recognizes filing metadata with whitespace-only separators", () => {
    expect(
      classifyCourtListenerText(
        "Case \t24-12345 Date Filed \n01/01/2024 Page \t1 of 2",
      ),
    ).toBe("no-ruling-text");
  });
  test.each([
    "FILE\nUNAVAILABLE\nUnable to extract document content",
    "FILE\nUNAVAILABLE\n\nUnable to extract document content",
    "Office of the Attorney General\n\nFILE\nUNAVAILABLE\n\nUnable to extract document content",
  ])("recognizes exact publisher messages across line breaks: %s", (body) => {
    expect(classifyCourtListenerText(body)).toBe("source-placeholder");
  });

  test("does not treat replacement characters as punctuation metadata", () => {
    expect(
      classifyCourtListenerText(
        "Office of the Attorney General\n\n\ufffd\ufffd\ufffd",
      ),
    ).toBe("undecodable");
  });

  test("keeps an unexplained trailing initial in candidate ruling text", () => {
    expect(classifyCourtListenerText("Office of the Attorney General A.")).toBe(
      "usable",
    );
  });

  test("keeps withdrawn-motion prose usable when the opinion continues", () => {
    expect(
      classifyCourtListenerText(
        "The opinion explains why the motion was withdrawn. The court affirms the judgment.",
      ),
    ).toBe("usable");
  });

  test.each(["Acquitted.", "Convicted.", "Sustained.", "Allowed."])(
    "keeps short legal outcomes usable after metadata: %s",
    (outcome) => {
      for (const separator of [" ", "\n"]) {
        expect(
          classifyCourtListenerText(
            `Office of the Attorney General${separator}${outcome}`,
          ),
        ).toBe("usable");
      }
      expect(
        classifyCourtListenerText(
          `Office of the Attorney General\n\n${outcome}`,
        ),
      ).toBe("usable");
      expect(
        classifyCourtListenerText(
          `Office of the Attorney General\n\nUnable to extract document content\n\n${outcome}`,
        ),
      ).toBe("usable");
    },
  );

  test.each([
    "Affirmed.",
    "Acquitted.",
    "Convicted.",
    "Sustained.",
    "Allowed.",
  ])(
    "keeps an explicit disposition between author metadata and a publisher message: %s",
    (outcome) => {
      expect(
        classifyCourtListenerText(
          `Mr. Justice Zqlrv.\n\n${outcome}\n\ndelivered the opinion of the court.\n\nThis opinion has been withdrawn.\n\nOpinion #C-729`,
        ),
      ).toBe("usable");
    },
  );

  test("keeps an author introduction split across blocks as candidate text", () => {
    expect(
      classifyCourtListenerText(
        "Mr. Justice Zqlrv.\n\ndelivered the opinion of the court.\n\nThis opinion has been withdrawn.\n\nOpinion #C-729",
      ),
    ).toBe("usable");
  });

  test("recognizes bounded author names without consuming nearby ruling prose", () => {
    expect(
      classifyCourtListenerText(
        "Mr. Justice Zqlrv.\n\nThe judgment is affirmed.\n\ndelivered the opinion of the court.",
      ),
    ).toBe("usable");
    expect(
      classifyCourtListenerText(
        "Mr. Justice Holmes delivered the opinion of the Court.",
      ),
    ).toBe("no-ruling-text");
    expect(
      classifyCourtListenerText(
        "Mr. Justice John Q. Public Jr. delivered the opinion of the Court.",
      ),
    ).toBe("no-ruling-text");
    expect(
      classifyCourtListenerText(
        "Mr. Justice John Q. Public Robert Smith Jones Brown delivered the opinion of the Court.",
      ),
    ).toBe("usable");
  });

  test.each([
    "Mr. Justice McDonald delivered the opinion of the court.",
    "JUSTICE MACARTHUR delivered the opinion of the COURT.",
    "Mr. Justice Jan de la van von Berg delivered the opinion of the Court.",
    "Opinion by Justice John Q. Public Jr. Not to be published in full.",
    "Present — Zqmrvv, P. J., Zqyrvv, Zqbr, Zqwrvvv and Zqdrvv, JJ.",
  ])(
    "recognizes bounded names independently of fixed keyword case: %s",
    (body) => {
      expect(classifyCourtListenerText(body)).toBe("no-ruling-text");
    },
  );
  test.each([
    "Mr. Justice The Judgment Is Affirmed delivered the opinion of the Court.",
    "Mr. Justice John lower Smith delivered the opinion of the Court.",
    "Mr. Justice John. Smith delivered the opinion of the Court.",
    "Mr. Justice John Q. Public Robert Smith Jones Brown delivered the opinion of the Court.",
  ])("keeps ambiguous or invalid name slots usable: %s", (body) => {
    expect(classifyCourtListenerText(body)).toBe("usable");
  });

  test("keeps ruling prose usable before unrelated numeric blocks", () => {
    const text = [
      "The court affirms the judgment.",
      ...Array.from({ length: 32 }, (_, index) => String(index + 1)),
    ].join("\n\n");
    expect(classifyCourtListenerText(text)).toBe("usable");
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

  // Headers cannot absorb residual words: those remain candidate ruling text.
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
        const swappedExpected =
          expected === "source-placeholder" && swapped !== text
            ? "usable"
            : expected;
        expect(swappedExpected).toBe(classifyCourtListenerText(swapped));
      }
    }
    expect(Object.fromEntries(counts)).toEqual({
      usable: 427,
      "source-placeholder": 59,
      "no-ruling-text": 31,
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
    ["Failed to extract text.", "source-placeholder"],
    [
      "OPINION # Ms 568 WAS NEVER ISSUED OR WAS WITHDRAWN.",
      "source-placeholder",
    ],
    [
      "OPINION los 7463 WAS NEVER ISSUED OH\n\nWAS WITHDRAWN.",
      "source-placeholder",
    ],
    [
      "This opinion has been withdrawn.\n\nOpinion #C-473",
      "source-placeholder",
    ],
    ["This opinion was withdrawn.\n\nOpinion # WWs560", "source-placeholder"],
    ["Unable to extract document content\n\n\ufffd\ufffd\ufffd", "undecodable"],
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
    ["Unable to extract document content\n\nÿþc", "undecodable"],
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
