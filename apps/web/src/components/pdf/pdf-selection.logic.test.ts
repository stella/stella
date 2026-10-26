import { describe, expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import { READER_COPY_MODES } from "@stll/api-contract/legal-reader-annotations";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";

import {
  pdfPageLocator,
  pdfPassageCitation,
  pdfPassageCopyText,
} from "@/components/pdf/pdf-selection.logic";
import type {
  PdfCitedDocument,
  PdfPageSpan,
} from "@/components/pdf/pdf-selection.logic";
import cs from "@/i18n/langs/cs.json";
import en from "@/i18n/langs/en.json";
import fr from "@/i18n/langs/fr.json";
import hu from "@/i18n/langs/hu.json";

const CATALOGS = { cs, en, fr, hu } as const;

type CopyCase = {
  document: PdfCitedDocument;
  language: keyof typeof CATALOGS;
  pages: PdfPageSpan;
  expected: Record<ReaderCopyMode, string>;
};

const copyAll = ({ document, language, pages }: CopyCase) => {
  const t = createTranslator({
    locale: language,
    messages: CATALOGS[language],
  });
  const citation = pdfPassageCitation({
    document,
    locator: pdfPageLocator(pages, {
      page: (page) => t("workspaces.pdf.selection.pageLocator", { page }),
      pageRange: (start, end) =>
        t("workspaces.pdf.selection.pageRangeLocator", { end, start }),
    }),
  });
  return Object.fromEntries(
    READER_COPY_MODES.map((mode) => [
      mode,
      pdfPassageCopyText({
        citation,
        language,
        mode,
        quote: "The seller shall deliver the goods",
      }).plain,
    ]),
  );
};

const CASES: readonly CopyCase[] = [
  {
    document: { name: "Purchase agreement.pdf", reference: "2026/014" },
    language: "en",
    pages: { end: 3, start: 3 },
    expected: {
      quoteWithCitation:
        "“The seller shall deliver the goods” Purchase agreement.pdf, 2026/014, p. 3.",
      citationWithQuote:
        "Purchase agreement.pdf, 2026/014, p. 3 (“The seller shall deliver the goods”).",
      blockQuoteWithCitation:
        "The seller shall deliver the goods\n\nPurchase agreement.pdf, 2026/014, p. 3.",
      textOnly: "The seller shall deliver the goods",
      citationOnly: "Purchase agreement.pdf, 2026/014, p. 3.",
    },
  },
  {
    // Matter numbering off: the citation names the document and the pages.
    document: { name: "Kupní smlouva.pdf", reference: null },
    language: "cs",
    pages: { end: 4, start: 2 },
    expected: {
      quoteWithCitation:
        "„The seller shall deliver the goods“ Kupní smlouva.pdf, s. 2–4.",
      citationWithQuote:
        "Kupní smlouva.pdf, s. 2–4 („The seller shall deliver the goods“).",
      blockQuoteWithCitation:
        "The seller shall deliver the goods\n\nKupní smlouva.pdf, s. 2–4.",
      textOnly: "The seller shall deliver the goods",
      citationOnly: "Kupní smlouva.pdf, s. 2–4.",
    },
  },
  {
    document: { name: "Adásvételi szerződés.pdf", reference: "2026/7" },
    language: "hu",
    pages: { end: 12, start: 12 },
    expected: {
      quoteWithCitation:
        "„The seller shall deliver the goods” Adásvételi szerződés.pdf, 2026/7, 12. o.",
      citationWithQuote:
        "Adásvételi szerződés.pdf, 2026/7, 12. o. („The seller shall deliver the goods”).",
      blockQuoteWithCitation:
        "The seller shall deliver the goods\n\nAdásvételi szerződés.pdf, 2026/7, 12. o.",
      textOnly: "The seller shall deliver the goods",
      citationOnly: "Adásvételi szerződés.pdf, 2026/7, 12. o.",
    },
  },
  {
    // French guillemets stand apart from the words by a narrow no-break space.
    document: { name: "Contrat de vente.pdf", reference: null },
    language: "fr",
    pages: { end: 1, start: 1 },
    expected: {
      quoteWithCitation:
        "«\u202fThe seller shall deliver the goods\u202f» Contrat de vente.pdf, p. 1.",
      citationWithQuote:
        "Contrat de vente.pdf, p. 1 («\u202fThe seller shall deliver the goods\u202f»).",
      blockQuoteWithCitation:
        "The seller shall deliver the goods\n\nContrat de vente.pdf, p. 1.",
      textOnly: "The seller shall deliver the goods",
      citationOnly: "Contrat de vente.pdf, p. 1.",
    },
  },
];

describe("a passage copied from a matter PDF", () => {
  for (const copyCase of CASES) {
    test(`cites ${copyCase.document.name} in the ${copyCase.language} reader's conventions`, () => {
      expect(copyAll(copyCase)).toEqual(copyCase.expected);
    });
  }

  test("a citation that already ends a sentence takes no second period", () => {
    const citation = pdfPassageCitation({
      document: { name: "Brief.pdf", reference: null },
      locator: "3. o.",
    });
    expect(citation).toEqual({
      inline: "Brief.pdf, 3. o.",
      sentence: "Brief.pdf, 3. o.",
    });
  });
});
