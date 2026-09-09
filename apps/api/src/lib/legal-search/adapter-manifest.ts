import {
  CZ_ECLI_COURTS,
  EU_ECLI_COURTS,
  SK_ECLI_COURTS,
} from "@/api/lib/case-law/ecli-court-codes";
import {
  ADAPTER_KEYS,
  type AdapterKey,
  type CaseLawJurisdiction,
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

type AdapterManifest<TKey extends AdapterKey> = {
  readonly key: TKey;
  readonly name: string;
  readonly country: CaseLawJurisdiction;
  readonly ecliCourtCodes: Readonly<Record<string, string>>;
  readonly placeholderPatterns: readonly SourcePlaceholderPattern[];
  readonly dateRange: AdapterDateRange;
};

type AdapterManifestMap = {
  readonly [TKey in AdapterKey]: AdapterManifest<TKey>;
};

const NO_DECLARED_ECLI_COURT_CODES = {} as const;
const NO_PLACEHOLDER_PATTERNS = [] as const;
const OPEN_RANGE = { type: "open" } as const;

export const ADAPTER_MANIFESTS = {
  [ADAPTER_KEYS.CZ_REGIONAL]: {
    key: ADAPTER_KEYS.CZ_REGIONAL,
    name: "Czech Regional Courts",
    country: "CZE",
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
    country: "CZE",
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
    country: "CZE",
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
    country: "CZE",
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
    country: "SVK",
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
    country: "SVK",
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
    country: "POL",
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1986-05-28",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    key: ADAPTER_KEYS.AT_COURTS,
    name: "Austrian Courts (RIS Justiz)",
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "AUT",
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
    country: "EU",
    ecliCourtCodes: EU_ECLI_COURTS,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1952-01-01",
      through: OPEN_RANGE,
    },
  },
} as const satisfies AdapterManifestMap;
