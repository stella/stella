import { panic } from "better-result";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { ReaderCopyMode } from "@stll/api-contract/legal-reader-annotations";
import type { UiLanguageCode } from "@stll/locales";

export type QuotationMarks = { close: string; open: string };

const ENGLISH_MARKS = { close: "”", open: "“" } as const;
const LOW_HIGH_MARKS = { close: "“", open: "„" } as const;
const LOW_RIGHT_MARKS = { close: "”", open: "„" } as const;
const ANGLE_MARKS = { close: "»", open: "«" } as const;
// French sets its guillemets apart with a narrow no-break space (U+202F).
const SPACED_ANGLE_MARKS = { close: " »", open: "« " } as const;

/**
 * Each language's primary quotation marks, total over the UI languages so a
 * new one cannot ship without a decision. A quoted passage stays in the
 * source's language, so it takes that language's marks, not the reader's
 * interface language: Czech text is quoted „…“ in an English UI too.
 */
const MARKS_BY_LANGUAGE = {
  // Arabic typesetting quotes with guillemets (“…” also occurs). Stored in
  // logical order; the bidi algorithm mirrors them in right-to-left text.
  ar: ANGLE_MARKS,
  // ČSN 01 6910 and Pravidla českého pravopisu.
  cs: LOW_HIGH_MARKS,
  // Duden, for Germany and Austria; book typography also uses »…«, and
  // Swiss German «…».
  de: LOW_HIGH_MARKS,
  // US and most legal usage; British house styles often prefer ‘…’.
  en: ENGLISH_MARKS,
  // RAE, Ortografía de la lengua española (2010): angular quotes first, then
  // “…”, then ‘…’; Latin American practice often starts with “…”.
  es: ANGLE_MARKS,
  // Eesti keele käsiraamat.
  et: LOW_HIGH_MARKS,
  // Imprimerie nationale, Lexique des règles typographiques; some publishers
  // space with U+00A0 instead, and Swiss French sets «…» unspaced.
  fr: SPACED_ANGLE_MARKS,
  // A magyar helyesírás szabályai (AkH. 12).
  hu: LOW_RIGHT_MARKS,
  // Valstybinė lietuvių kalbos komisija.
  lt: LOW_HIGH_MARKS,
  // Latvian usage; «…» is also common.
  lv: LOW_HIGH_MARKS,
  // PWN, Wielki słownik ortograficzny; «…» marks a quotation nested inside.
  pl: LOW_RIGHT_MARKS,
  // Brazilian usage, as the UI ships pt-BR; European Portuguese prefers «…».
  pt: ENGLISH_MARKS,
  // Pravidlá slovenského pravopisu.
  sk: LOW_HIGH_MARKS,
} as const satisfies Record<UiLanguageCode, QuotationMarks>;

const isQuotedLanguage = (language: string): language is UiLanguageCode =>
  Object.hasOwn(MARKS_BY_LANGUAGE, language);

/**
 * A court's working language, for a document whose own is not known. Total
 * over the case-law jurisdictions, and each value must have marks above. The
 * EU courts publish in every official language; a document declaring none is
 * quoted in English marks.
 */
const LANGUAGE_BY_COUNTRY = {
  AUT: "de",
  CZE: "cs",
  DEU: "de",
  EST: "et",
  EU: "en",
  FRA: "fr",
  GBR: "en",
  HUN: "hu",
  LTU: "lt",
  LVA: "lv",
  POL: "pl",
  SVK: "sk",
  USA: "en",
} as const satisfies Record<CaseLawJurisdiction, UiLanguageCode> &
  Readonly<Record<string, UiLanguageCode>>;

const isQuotedCountry = (
  country: string,
): country is keyof typeof LANGUAGE_BY_COUNTRY =>
  Object.hasOwn(LANGUAGE_BY_COUNTRY, country);

/**
 * The marks to quote a passage in: by the document's language when it is
 * known, else by the working language of its court's country (ISO 3166-1
 * alpha-3, or `EU`); English marks otherwise (a language the app ships no UI
 * for, or a country without a declared language).
 */
export const quotationMarksFor = ({
  country,
  language,
}: {
  country: string | null;
  language: string | null;
}): QuotationMarks => {
  if (language !== null) {
    const base = language.split("-").at(0)?.toLowerCase() ?? "";
    return isQuotedLanguage(base) ? MARKS_BY_LANGUAGE[base] : ENGLISH_MARKS;
  }
  const corpusCountry = country?.toUpperCase() ?? "";
  return isQuotedCountry(corpusCountry)
    ? MARKS_BY_LANGUAGE[LANGUAGE_BY_COUNTRY[corpusCountry]]
    : ENGLISH_MARKS;
};

export const citationCopyText = (
  mode: ReaderCopyMode,
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
