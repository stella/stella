import {
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";
import {
  DECISION_DOCKET_GRAMMARS,
  type DecisionDocketGrammar,
} from "@stll/api-contract/decision-docket-grammar";

import {
  CZ_ECLI_COURTS,
  EU_ECLI_COURTS,
  SK_ECLI_COURTS,
} from "@/api/lib/case-law/ecli-court-codes";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";

type SourcePlaceholderPattern = {
  readonly type: "exact";
  readonly text: string;
};

type DateRangeEnd =
  | { readonly type: "open" }
  | { readonly type: "inclusive"; readonly date: string };

type AdapterDateRange =
  | {
      readonly type: "decision-date";
      readonly fromInclusive: string;
      readonly through: DateRangeEnd;
    }
  | {
      readonly type: "publication-date";
      readonly fromInclusive: string;
      readonly through: DateRangeEnd;
    };

type AdapterJurisdictionDeclaration = {
  readonly [TJurisdiction in CaseLawJurisdiction]: {
    readonly country: TJurisdiction;
    readonly identifierGrammar: Extract<
      DecisionDocketGrammar,
      { readonly jurisdiction: TJurisdiction }
    >;
  };
}[CaseLawJurisdiction];

type AdapterManifest<TKey extends AdapterKey> = {
  readonly key: TKey;
  readonly name: string;
  /**
   * Where the publisher offers this corpus to the public, for the attribution
   * line every rendered decision ends with.
   *
   * Required, and stated here rather than on the source row, because some
   * courts make the attribution a condition of reuse: a source that never
   * said where its data is freely available cannot be attributed at all. The
   * total map is what turns onboarding a source without one into a compile
   * error instead of a blank line under someone's decision.
   *
   * The publisher's own landing page for the corpus, not a decision's
   * permalink: a decision carrying its own source page is attributed to that
   * page, and this answers for the rows that do not.
   *
   * Retiring an adapter means deleting its ingestion code and keeping its
   * manifest entry. `case_law_sources` rows outlive the adapter that wrote
   * them, so an entry dropped from this map un-attributes every decision
   * ingested under that key. Keeping the entry is what lets attribution stay
   * a single lookup against one total map instead of a second map of
   * historical keys.
   */
  readonly publicHomeUrl: string;
  readonly ecliCourtCodes: Readonly<Record<string, string>>;
  readonly placeholderPatterns: readonly SourcePlaceholderPattern[];
  readonly dateRange: AdapterDateRange;
} & AdapterJurisdictionDeclaration;

type AdapterManifestMap = {
  readonly [TKey in AdapterKey]: AdapterManifest<TKey>;
};

const NO_DECLARED_ECLI_COURT_CODES = {} as const;
const NO_PLACEHOLDER_PATTERNS = [] as const;
const OPEN_RANGE = { type: "open" } as const;
const ADAPTER_JURISDICTIONS = {
  AUT: {
    country: "AUT",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.AUT,
  },
  CZE: {
    country: "CZE",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.CZE,
  },
  EU: {
    country: "EU",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.EU,
  },
  HUN: {
    country: "HUN",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.HUN,
  },
  POL: {
    country: "POL",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.POL,
  },
  SVK: {
    country: "SVK",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.SVK,
  },
} as const satisfies {
  readonly [TJurisdiction in CaseLawJurisdiction]: Extract<
    AdapterJurisdictionDeclaration,
    { readonly country: TJurisdiction }
  >;
};

export const decisionDocketGrammarForCountry = (
  country: string,
): DecisionDocketGrammar | null => {
  const normalized = country.toUpperCase();
  if (!isCaseLawJurisdiction(normalized)) {
    return null;
  }
  return ADAPTER_JURISDICTIONS[normalized].identifierGrammar;
};

export const ADAPTER_MANIFESTS = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    key: ADAPTER_KEYS.CZ_REGIONAL,
    name: "Czech Regional Courts",
    publicHomeUrl: "https://rozhodnuti.justice.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "publication-date",
      fromInclusive: "2020-10-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.CZ_NS]: {
    key: ADAPTER_KEYS.CZ_NS,
    name: "Czech Supreme Court",
    publicHomeUrl: "https://rozhodnuti.nsoud.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "publication-date",
      fromInclusive: "2010-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    key: ADAPTER_KEYS.CZ_NSS,
    name: "Czech Supreme Administrative Court",
    publicHomeUrl: "https://vyhledavac.nssoud.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2003-02-04",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.CZ_US]: {
    key: ADAPTER_KEYS.CZ_US,
    name: "Czech Constitutional Court",
    publicHomeUrl: "https://nalus.usoud.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    placeholderPatterns: [
      { type: "exact", text: "Abstrakt není k dispozici." },
      { type: "exact", text: "Právní věta není k dispozici." },
    ],
    dateRange: {
      type: "decision-date",
      fromInclusive: "1993-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.SK_COURTS]: {
    key: ADAPTER_KEYS.SK_COURTS,
    name: "Slovak Courts",
    publicHomeUrl: "https://obcan.justice.sk",
    ...ADAPTER_JURISDICTIONS.SVK,
    ecliCourtCodes: SK_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1965-07-11",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.SK_US]: {
    key: ADAPTER_KEYS.SK_US,
    name: "Slovak Constitutional Court",
    publicHomeUrl: "https://www.ustavnysud.sk",
    ...ADAPTER_JURISDICTIONS.SVK,
    ecliCourtCodes: SK_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1993-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    key: ADAPTER_KEYS.PL_COURTS,
    name: "Polish Courts (SAOS)",
    publicHomeUrl: "https://www.saos.org.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1986-05-28",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_SN]: {
    key: ADAPTER_KEYS.PL_SN,
    name: "Polish Supreme Court (Sąd Najwyższy)",
    publicHomeUrl: "https://sn.pl/pl/wyszukiwarka-orzeczen",
    ...ADAPTER_JURISDICTIONS.POL,
    // Poland issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      // The oldest decision date the search answers with: a query bounded at
      // 1900-01-01 lists nothing before this day, and this day lists one
      // decision. Its document is headed 23 June 1994 and its docket reads
      // `III ARN 36/94`, so the year the publisher filed it under looks like a
      // typo — but it is the date the source filters on, which is what this
      // range has to state, or the walk would start after a listed decision.
      fromInclusive: "1993-06-23",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    key: ADAPTER_KEYS.AT_COURTS,
    name: "Austrian Courts (RIS Justiz)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1925-04-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    key: ADAPTER_KEYS.AT_VFGH,
    name: "Austrian Constitutional Court (RIS VfGH)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1919-03-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    key: ADAPTER_KEYS.AT_VWGH,
    name: "Austrian Administrative Court (RIS VwGH)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1876-10-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    key: ADAPTER_KEYS.AT_BVWG,
    name: "Austrian Federal Administrative Court (RIS BVwG)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2014-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    key: ADAPTER_KEYS.AT_LVWG,
    name: "Austrian State Administrative Courts (RIS LVwG)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2002-03-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    key: ADAPTER_KEYS.AT_ASYLGH,
    name: "Austrian Asylum Court (RIS AsylGH)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2008-07-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    key: ADAPTER_KEYS.AT_UBAS,
    name: "Austrian Federal Asylum Senate (RIS UBAS)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1998-01-01",
      through: { type: "inclusive", date: "2008-06-30" },
    },
  },
  [ADAPTER_KEYS.AT_UVS]: {
    key: ADAPTER_KEYS.AT_UVS,
    name: "Austrian Independent Administrative Senates (RIS UVS)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1991-02-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_VERG]: {
    key: ADAPTER_KEYS.AT_VERG,
    name: "Austrian Procurement Review Bodies (RIS Verg)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1994-04-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    key: ADAPTER_KEYS.AT_UMSE,
    name: "Austrian Environmental Senate (RIS Umweltsenat)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1995-10-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_BKS]: {
    key: ADAPTER_KEYS.AT_BKS,
    name: "Austrian Federal Communications Senate (RIS BKS)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2001-10-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_FINDOK]: {
    key: ADAPTER_KEYS.AT_FINDOK,
    name: "Austrian Fiscal Courts (Findok BFG and UFS)",
    publicHomeUrl: "https://findok.bmf.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2003-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    key: ADAPTER_KEYS.HU_BHGY,
    name: "Hungarian Courts (Bírósági Határozatok Gyűjteménye)",
    publicHomeUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
    ...ADAPTER_JURISDICTIONS.HUN,
    // Hungary issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    // The collection prints no "not available" stand-in: a decision without a
    // résumé states `Rezume: null`.
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      // `MeghozatalIdejeTol`/`Ig` take a year, and the search form's own list
      // opens at 1988. 1990 to 1995 answer nothing; they are inside the range
      // rather than outside it, because the publisher offers them.
      type: "decision-date",
      fromInclusive: "1988-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    key: ADAPTER_KEYS.EU_ECJ,
    name: "Court of Justice of the EU (CJEU)",
    publicHomeUrl: "https://eur-lex.europa.eu",
    ...ADAPTER_JURISDICTIONS.EU,
    ecliCourtCodes: EU_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1952-01-01",
      through: OPEN_RANGE,
    },
  },
} as const satisfies AdapterManifestMap;
