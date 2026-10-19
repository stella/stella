import { describe, expect, test } from "bun:test";

import { READER_COPY_MODES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import { copyTextFor } from "@/components/legal-reader/annotations/reader-copy-text.logic";

for (const { decisionDate, caseNumber, inlineCitation, citation } of [
  {
    decisionDate: "2019-03-21",
    caseNumber: "Pfv.21.123/2019/5.",
    inlineCitation: "Kúria, Pfv.21.123/2019/5., 2019. március 21.",
    citation: "Kúria, Pfv.21.123/2019/5., 2019. március 21.",
  },
  {
    decisionDate: null,
    caseNumber: "Pfv.21.123/2019/5.",
    inlineCitation: "Kúria, Pfv.21.123/2019/5.",
    citation: "Kúria, Pfv.21.123/2019/5.",
  },
  {
    decisionDate: null,
    caseNumber: "Pfv.21.123/2019/5",
    inlineCitation: "Kúria, Pfv.21.123/2019/5",
    citation: "Kúria, Pfv.21.123/2019/5.",
  },
]) {
  describe(`Hungarian copy modes (${decisionDate ?? "undated"}, ${caseNumber})`, () => {
    const target = {
      type: "decision",
      id: "00000000-0000-4000-8000-000000000891",
      country: "HUN",
      court: "Kúria",
      caseNumber,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      decisionDate,
      decisionType: "ítélet",
      ecli: null,
      name: null,
    } satisfies ReaderAnnotationTarget;

    for (const locator of [null, "12", "13"]) {
      const selected = { cleanText: "teljesítés", locator };
      const locatedInline =
        locator === null ? inlineCitation : `${inlineCitation} [${locator}]`;
      const locatedSentence = locator === null ? citation : `${locatedInline}.`;
      const expected = {
        quoteWithCitation: `„teljesítés” ${locatedSentence}`,
        citationWithQuote: `${locatedInline} („teljesítés”).`,
        blockQuoteWithCitation: `teljesítés\n\n${locatedSentence}`,
        textOnly: "teljesítés",
        citationOnly: locatedSentence,
      } satisfies Record<ReaderCopyMode, string>;

      test.each(READER_COPY_MODES)(
        `%s formats the passage with locator ${locator ?? "none"}`,
        (mode) => {
          const text = copyTextFor({ mode, selected, target });
          expect(text.plain).toBe(expected[mode]);
          expect(text.plain).not.toContain("..");
          if (mode === "citationOnly") {
            expect(text.html).not.toContain("<em>");
          } else {
            expect(text.html).toContain("<em>");
          }
        },
      );
    }
  });
}

describe("rich reader copy", () => {
  const statute = {
    type: "statute",
    id: "00000000-0000-4000-8000-000000000892",
    country: "cze",
    eli: "eli/cz/sb/2012/89",
    provisionByAnchorId: new Map<string, string>(),
    title: "Občanský zákoník",
    versionValidFrom: null,
  } satisfies ReaderAnnotationTarget;
  const selected = {
    cleanText: `<tag> & "double" and 'single'`,
    locator: "§ 1",
  };

  test.each(READER_COPY_MODES)(
    "%s derives matching plain and HTML forms",
    (mode) => {
      const text = copyTextFor({ mode, selected, target: statute });
      expect(text.plain).not.toContain("&lt;");
      expect(text.html).not.toContain("<tag>");
      if (mode !== "citationOnly") {
        expect(text.html).toContain(
          "&lt;tag&gt; &amp; &quot;double&quot; and &#39;single&#39;",
        );
        expect(text.html).toContain("<em>");
      }
      if (mode === "blockQuoteWithCitation") {
        expect(text.html).toStartWith("<blockquote><p><em>");
        expect(text.html).toContain("</em></p></blockquote><p>");
      }
    },
  );

  test("uses Czech marks for alpha-2 decisions and statutes", () => {
    const statuteText = copyTextFor({
      mode: "textOnly",
      selected: { cleanText: "ustanovení", locator: null },
      target: statute,
    });
    const decisionText = copyTextFor({
      mode: "textOnly",
      selected: { cleanText: "ustanovení", locator: null },
      target: {
        type: "decision",
        id: "00000000-0000-4000-8000-000000000893",
        country: "CZ",
        court: "Ústavní soud",
        caseNumber: "I. ÚS 1/26",
        caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        decisionDate: null,
        decisionType: null,
        ecli: null,
        name: null,
      },
    });
    expect(statuteText.plain).toBe("ustanovení");
    expect(statuteText.html).toBe("<em>ustanovení</em>");
    expect(decisionText.html).toBe("<em>ustanovení</em>");
    expect(
      copyTextFor({
        mode: "quoteWithCitation",
        selected: { cleanText: "ustanovení", locator: null },
        target: statute,
      }).plain,
    ).toStartWith("„ustanovení“");
    expect(
      copyTextFor({
        mode: "quoteWithCitation",
        selected: { cleanText: "provision", locator: null },
        target: { ...statute, country: "unknown" },
      }).plain,
    ).toStartWith("“provision”");
  });

  test.each([
    "quoteWithCitation",
    "citationWithQuote",
    "blockQuoteWithCitation",
    "textOnly",
  ] satisfies ReaderCopyMode[])(
    "%s preserves paragraph and line boundaries in rich passages",
    (mode) => {
      const text = copyTextFor({
        mode,
        selected: {
          cleanText: "first line\nsecond line\n\nthird line",
          locator: "§ 1",
        },
        target: statute,
      });

      expect(text.plain).toContain("first line\nsecond line\n\nthird line");
      expect(text.html).not.toContain("\n");
      expect(text.html).toContain("<em>");
      expect(text.html.match(/<em>/gu)).toHaveLength(2);
      expect(text.html.match(/<\/em>/gu)).toHaveLength(2);
      expect(text.html).toContain("first line<br>second line");
      expect(text.html).toContain("third line");
      expect(text.html.match(/<p>/gu)).toHaveLength(
        mode === "blockQuoteWithCitation" ? 3 : 2,
      );
    },
  );
});
