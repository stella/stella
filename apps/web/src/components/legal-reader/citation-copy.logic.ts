import { panic } from "better-result";

import type { ReaderCitationCopyMode } from "@stll/api-contract/legal-reader-annotations";

export type QuotationMarks = { close: string; open: string };

const ENGLISH_MARKS = { close: "”", open: "“" } as const;
const LOW_HIGH_MARKS = { close: "“", open: "„" } as const;
const LOW_RIGHT_MARKS = { close: "”", open: "„" } as const;
// French sets its guillemets apart with a narrow no-break space.
const GUILLEMETS = { close: " »", open: "« " } as const;

/**
 * Each language's primary quotation marks. A quoted passage stays in the
 * source's language, so it takes that language's marks, not the reader's
 * interface language: Czech text is quoted „…“ in an English UI too.
 */
const MARKS_BY_LANGUAGE: Readonly<Record<string, QuotationMarks>> = {
  cs: LOW_HIGH_MARKS,
  de: LOW_HIGH_MARKS,
  et: LOW_HIGH_MARKS,
  fr: GUILLEMETS,
  hu: LOW_RIGHT_MARKS,
  lt: LOW_HIGH_MARKS,
  lv: LOW_HIGH_MARKS,
  pl: LOW_RIGHT_MARKS,
  sk: LOW_HIGH_MARKS,
};

/** A court's working language, for a document whose own is not known. */
const LANGUAGE_BY_COUNTRY: Readonly<Record<string, string>> = {
  AUT: "de",
  CZE: "cs",
  DEU: "de",
  EST: "et",
  FRA: "fr",
  HUN: "hu",
  LTU: "lt",
  LVA: "lv",
  POL: "pl",
  SVK: "sk",
};

/**
 * The marks to quote a passage in: by the document's language when it is
 * known, else by its court's country; English marks otherwise (EU documents
 * without a language, and any language without its own entry).
 */
export const quotationMarksFor = ({
  country,
  language,
}: {
  country: string | null;
  language: string | null;
}): QuotationMarks => {
  const base =
    language?.split("-")[0]?.toLowerCase() ??
    (country === null ? undefined : LANGUAGE_BY_COUNTRY[country.toUpperCase()]);
  return (
    (base === undefined ? undefined : MARKS_BY_LANGUAGE[base]) ?? ENGLISH_MARKS
  );
};

export const citationCopyText = (
  mode: ReaderCitationCopyMode,
  {
    citation,
    marks,
    quote,
  }: { citation: string; marks: QuotationMarks; quote: string },
): string => {
  const quoted = `${marks.open}${quote}${marks.close}`;
  switch (mode) {
    case "quoteWithCitation": {
      return `${quoted} ${citation}.`;
    }
    case "citationWithQuote": {
      return `${citation} (${quoted}).`;
    }
    case "blockQuoteWithCitation": {
      return `${quote}\n\n${citation}.`;
    }
    case "textOnly": {
      return quote;
    }
    case "citationOnly": {
      return `${citation}.`;
    }
    default: {
      mode satisfies never;
      return panic(`Unhandled citation copy mode: ${String(mode)}`);
    }
  }
};
