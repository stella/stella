import { describe, expect, test } from "bun:test";

import { READER_COPY_MODES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { ReaderAnnotationTarget } from "@/components/legal-reader/annotations/reader-annotation-target";
import { copyTextFor } from "@/components/legal-reader/annotations/reader-copy-text.logic";

const selected = { cleanText: "teljesítés", locator: null };

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

    const expected = {
      quoteWithCitation: `„teljesítés” ${citation}`,
      citationWithQuote: `${inlineCitation} („teljesítés”).`,
      blockQuoteWithCitation: `teljesítés\n\n${citation}`,
      textOnly: "teljesítés",
      citationOnly: citation,
    } satisfies Record<ReaderCopyMode, string>;

    test.each(READER_COPY_MODES)(
      "%s formats the passage and citation",
      (mode) => {
        const text = copyTextFor({ mode, selected, target });
        expect(text).toBe(expected[mode]);
        expect(text).not.toContain("..");
      },
    );
  });
}
