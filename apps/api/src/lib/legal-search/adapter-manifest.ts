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
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
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
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2003-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    key: ADAPTER_KEYS.EU_ECJ,
    name: "Court of Justice of the EU (CJEU)",
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
