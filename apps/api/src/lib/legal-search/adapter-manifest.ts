// parser-output-unchanged: scheduling, identity-resolution and app-reader text policy declarations do not change parsed decision output.
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
  IMPORT_SOURCE_KEYS,
  type ImportSourceKey,
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

/**
 * Whether the ECLI a source states names one decision within that source.
 *
 * A source's record id is not the decision's identity: a publisher can
 * reissue a decision's document under a new id and withdraw the old one.
 * Where the stated ECLI names exactly one decision, the pipeline recognises
 * the stored row under the old id by that ECLI and re-keys it. Where it does
 * not (no ECLI, an ECLI the adapter derives itself, or one shared by several
 * documents the source stores apart), an unknown id is a new decision.
 */
export const STATED_ECLI_IDENTITY = {
  DECISION: "decision",
  NONE: "none",
} as const;

export type StatedEcliIdentity =
  (typeof STATED_ECLI_IDENTITY)[keyof typeof STATED_ECLI_IDENTITY];

type AdapterManifest<TKey extends string> = {
  readonly key: TKey;
  readonly documentStage: "inline" | "deferred";
  /** The feed's English label, for operators and logs. */
  readonly name: string;
  /**
   * The publisher as it names itself, in its own language: what a public
   * page prints. A court's name is not translated for the reader any more
   * than a party's is, and an English rendering of "Nejvyšší správní soud"
   * is not a name anyone can look up.
   */
  readonly publisher: string;
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
  /** See {@link STATED_ECLI_IDENTITY}. */
  readonly statedEcliIdentity: StatedEcliIdentity;
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
  USA: {
    country: "USA",
    identifierGrammar: DECISION_DOCKET_GRAMMARS.USA,
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
    documentStage: "inline",
    name: "Czech Regional Courts",
    publisher: "Okresní, krajské a vrchní soudy",
    publicHomeUrl: "https://rozhodnuti.justice.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "publication-date",
      fromInclusive: "2020-10-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.CZ_NS]: {
    key: ADAPTER_KEYS.CZ_NS,
    documentStage: "inline",
    name: "Czech Supreme Court",
    publisher: "Nejvyšší soud",
    publicHomeUrl: "https://rozhodnuti.nsoud.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "publication-date",
      fromInclusive: "2010-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.CZ_NSS]: {
    key: ADAPTER_KEYS.CZ_NSS,
    documentStage: "inline",
    name: "Czech Supreme Administrative Court",
    publisher: "Nejvyšší správní soud",
    publicHomeUrl: "https://vyhledavac.nssoud.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: [
      { type: "exact", text: "-" },
      { type: "exact", text: "–" },
      { type: "exact", text: "—" },
      { type: "exact", text: "−" },
    ],
    dateRange: {
      type: "decision-date",
      fromInclusive: "2003-02-04",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.CZ_US]: {
    key: ADAPTER_KEYS.CZ_US,
    documentStage: "inline",
    name: "Czech Constitutional Court",
    publisher: "Ústavní soud",
    publicHomeUrl: "https://nalus.usoud.cz",
    ...ADAPTER_JURISDICTIONS.CZE,
    ecliCourtCodes: CZ_ECLI_COURTS,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
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
    documentStage: "deferred",
    name: "Slovak Courts",
    publisher: "Súdy Slovenskej republiky",
    publicHomeUrl: "https://obcan.justice.sk",
    ...ADAPTER_JURISDICTIONS.SVK,
    ecliCourtCodes: SK_ECLI_COURTS,
    // The portal can reissue a decision under a new document id and
    // withdraw the old one; the ECLI it states stays with the decision.
    statedEcliIdentity: STATED_ECLI_IDENTITY.DECISION,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1965-07-11",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.SK_US]: {
    key: ADAPTER_KEYS.SK_US,
    documentStage: "inline",
    name: "Slovak Constitutional Court",
    publisher: "Ústavný súd Slovenskej republiky",
    publicHomeUrl: "https://www.ustavnysud.sk",
    ...ADAPTER_JURISDICTIONS.SVK,
    ecliCourtCodes: SK_ECLI_COURTS,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1993-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_COURTS]: {
    key: ADAPTER_KEYS.PL_COURTS,
    documentStage: "inline",
    name: "Polish Courts (SAOS)",
    publisher: "Sądy powszechne (SAOS)",
    publicHomeUrl: "https://www.saos.org.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1986-05-28",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_SN]: {
    key: ADAPTER_KEYS.PL_SN,
    documentStage: "inline",
    name: "Polish Supreme Court (Sąd Najwyższy)",
    publisher: "Sąd Najwyższy",
    publicHomeUrl: "https://sn.pl/pl/wyszukiwarka-orzeczen",
    ...ADAPTER_JURISDICTIONS.POL,
    // Poland issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
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
  [ADAPTER_KEYS.PL_KIO]: {
    key: ADAPTER_KEYS.PL_KIO,
    documentStage: "inline",
    name: "Polish Procurement Appeals (UZP)",
    publisher: "Urząd Zamówień Publicznych",
    publicHomeUrl: "https://orzeczenia.uzp.gov.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      // The oldest issue date the search answers with. Rulings the database
      // lists with no issue date are outside every date filter and are
      // walked separately.
      fromInclusive: "2003-04-11",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_TK]: {
    key: ADAPTER_KEYS.PL_TK,
    documentStage: "inline",
    name: "Polish Constitutional Tribunal (Trybunał Konstytucyjny)",
    publisher: "Trybunał Konstytucyjny",
    publicHomeUrl: "https://ipo.trybunal.gov.pl/ipo/",
    ...ADAPTER_JURISDICTIONS.POL,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      // The Tribunal's first ruling, U 1/86; the portal lists nothing older.
      fromInclusive: "1986-05-28",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_NSA]: {
    key: ADAPTER_KEYS.PL_NSA,
    documentStage: "inline",
    name: "Polish Administrative Courts (Hugging Face dataset)",
    publisher:
      "Naczelny Sąd Administracyjny i wojewódzkie sądy administracyjne",
    // The dataset the decisions are imported from, which is also what the
    // attribution line credits; each decision links its court's own page.
    publicHomeUrl: "https://huggingface.co/datasets/JuDDGES/pl-nsa",
    ...ADAPTER_JURISDICTIONS.POL,
    // Poland issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      // The oldest and newest decision dates the pinned revision holds.
      type: "decision-date",
      fromInclusive: "1981-01-07",
      through: { type: "inclusive", date: "2025-03-05" },
    },
  },
  [ADAPTER_KEYS.PL_NCOURT]: {
    key: ADAPTER_KEYS.PL_NCOURT,
    documentStage: "inline",
    name: "Polish Common Courts (Ministry of Justice)",
    publisher: "Ministerstwo Sprawiedliwości",
    publicHomeUrl: "https://orzeczenia.ms.gov.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      // The oldest judgment date the listing answers with, sorted by date.
      fromInclusive: "1994-07-20",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_COURTS]: {
    key: ADAPTER_KEYS.AT_COURTS,
    documentStage: "inline",
    name: "Austrian Courts (RIS Justiz)",
    publisher: "Gerichte (RIS Justiz)",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1925-04-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_VFGH]: {
    key: ADAPTER_KEYS.AT_VFGH,
    documentStage: "inline",
    name: "Austrian Constitutional Court (RIS VfGH)",
    publisher: "Verfassungsgerichtshof",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1919-03-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_VWGH]: {
    key: ADAPTER_KEYS.AT_VWGH,
    documentStage: "inline",
    name: "Austrian Administrative Court (RIS VwGH)",
    publisher: "Verwaltungsgerichtshof",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1876-10-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_BVWG]: {
    key: ADAPTER_KEYS.AT_BVWG,
    documentStage: "inline",
    name: "Austrian Federal Administrative Court (RIS BVwG)",
    publisher: "Bundesverwaltungsgericht",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2014-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_LVWG]: {
    key: ADAPTER_KEYS.AT_LVWG,
    documentStage: "inline",
    name: "Austrian State Administrative Courts (RIS LVwG)",
    publisher: "Landesverwaltungsgerichte",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2002-03-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.AT_ASYLGH]: {
    key: ADAPTER_KEYS.AT_ASYLGH,
    documentStage: "inline",
    name: "Austrian Asylum Court (RIS AsylGH)",
    publisher: "Asylgerichtshof",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2008-07-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_UBAS]: {
    key: ADAPTER_KEYS.AT_UBAS,
    documentStage: "inline",
    name: "Austrian Federal Asylum Senate (RIS UBAS)",
    publisher: "Unabhängiger Bundesasylsenat",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1998-01-01",
      through: { type: "inclusive", date: "2008-06-30" },
    },
  },
  [ADAPTER_KEYS.AT_UVS]: {
    key: ADAPTER_KEYS.AT_UVS,
    documentStage: "inline",
    name: "Austrian Independent Administrative Senates (RIS UVS)",
    publisher: "Unabhängige Verwaltungssenate",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1991-02-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_VERG]: {
    key: ADAPTER_KEYS.AT_VERG,
    documentStage: "inline",
    name: "Austrian Procurement Review Bodies (RIS Verg)",
    publisher: "Vergabekontrollbehörden",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1994-04-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_UMSE]: {
    key: ADAPTER_KEYS.AT_UMSE,
    documentStage: "inline",
    name: "Austrian Environmental Senate (RIS Umweltsenat)",
    publisher: "Umweltsenat",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1995-10-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_BKS]: {
    key: ADAPTER_KEYS.AT_BKS,
    documentStage: "inline",
    name: "Austrian Federal Communications Senate (RIS BKS)",
    publisher: "Bundeskommunikationssenat",
    publicHomeUrl: "https://www.ris.bka.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2001-10-01",
      through: { type: "inclusive", date: "2013-12-31" },
    },
  },
  [ADAPTER_KEYS.AT_FINDOK]: {
    key: ADAPTER_KEYS.AT_FINDOK,
    documentStage: "inline",
    name: "Austrian Fiscal Courts (Findok BFG and UFS)",
    publisher: "Bundesfinanzgericht und UFS (Findok)",
    publicHomeUrl: "https://findok.bmf.gv.at",
    ...ADAPTER_JURISDICTIONS.AUT,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "2003-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.HU_BHGY]: {
    key: ADAPTER_KEYS.HU_BHGY,
    documentStage: "inline",
    name: "Hungarian Courts (Bírósági Határozatok Gyűjteménye)",
    publisher: "Bírósági Határozatok Gyűjteménye",
    publicHomeUrl: "https://eakta.birosag.hu/anonimizalt-hatarozatok",
    ...ADAPTER_JURISDICTIONS.HUN,
    // Hungary issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
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
  [ADAPTER_KEYS.PL_KIS]: {
    key: ADAPTER_KEYS.PL_KIS,
    documentStage: "inline",
    name: "Polish Tax Interpretations and Rulings (EUREKA)",
    publisher: "System Informacji Skarbowej EUREKA",
    publicHomeUrl: "https://eureka.mf.gov.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      // One general interpretation of 2004 predates the individual ones, which
      // open in July 2007.
      type: "decision-date",
      fromInclusive: "2004-07-30",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_UODO]: {
    key: ADAPTER_KEYS.PL_UODO,
    documentStage: "inline",
    name: "Polish Data Protection Authority (Prezes UODO)",
    publisher: "Prezes Urzędu Ochrony Danych Osobowych",
    publicHomeUrl: "https://orzeczenia.uodo.gov.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    // Poland issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      // The authority's own decisions start in 2018; the court rulings the
      // portal files beside them reach back to a 1981 judgment, and the
      // search filters on that date.
      type: "decision-date",
      fromInclusive: "1981-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.PL_UOKIK]: {
    key: ADAPTER_KEYS.PL_UOKIK,
    documentStage: "inline",
    name: "Polish Competition and Consumer Protection Authority (Prezes UOKiK)",
    publisher: "Prezes Urzędu Ochrony Konkurencji i Konsumentów",
    publicHomeUrl: "https://decyzje.uokik.gov.pl",
    ...ADAPTER_JURISDICTIONS.POL,
    // Poland issues no ECLI, so there is no court code to resolve one against.
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      // The register's oldest decision is dated 4 January 2000.
      type: "decision-date",
      fromInclusive: "2000-01-01",
      through: OPEN_RANGE,
    },
  },
  [ADAPTER_KEYS.EU_ECJ]: {
    key: ADAPTER_KEYS.EU_ECJ,
    documentStage: "inline",
    name: "Court of Justice of the EU (CJEU)",
    publisher: "Court of Justice of the European Union",
    publicHomeUrl: "https://eur-lex.europa.eu",
    ...ADAPTER_JURISDICTIONS.EU,
    ecliCourtCodes: EU_ECLI_COURTS,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
    dateRange: {
      type: "decision-date",
      fromInclusive: "1952-01-01",
      through: OPEN_RANGE,
    },
  },
} as const satisfies AdapterManifestMap;

/** Imported snapshots carry their own completeness bounds; they have no crawl date range. */
export const IMPORT_SOURCE_MANIFESTS = {
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: {
    key: IMPORT_SOURCE_KEYS.COURTLISTENER,
    documentStage: "inline",
    name: "CourtListener bulk opinion records",
    publisher: "Free Law Project, CourtListener",
    publicHomeUrl: "https://www.courtlistener.com",
    ...ADAPTER_JURISDICTIONS.USA,
    ecliCourtCodes: NO_DECLARED_ECLI_COURT_CODES,
    statedEcliIdentity: STATED_ECLI_IDENTITY.NONE,
    placeholderPatterns: NO_PLACEHOLDER_PATTERNS,
  },
} as const satisfies {
  readonly [TKey in ImportSourceKey]: Omit<AdapterManifest<TKey>, "dateRange">;
};

/**
 * What the MCP in-app reader shows a person for a source whose full text may
 * not reach a model. `full` renders the text in the reader UI through the
 * app-only tools while model-visible results stay metadata; `metadata-only`
 * shows metadata and the link to open the decision in stella.
 */
// parser-output-unchanged: [eu-ecj] Reader rendering policy only; parsed decision output is unchanged.
// parser-output-unchanged: [us-courtlistener] Reader rendering policy only; parsed decision output is unchanged.
export const APP_READER_TEXT = {
  FULL: "full",
  METADATA_ONLY: "metadata-only",
} as const;

export type AppReaderText =
  (typeof APP_READER_TEXT)[keyof typeof APP_READER_TEXT];

// parser-output-unchanged: [eu-ecj] Seed-only reader keys; parsed decision output is unchanged.
// parser-output-unchanged: [us-courtlistener] Seed-only reader keys; parsed decision output is unchanged.
/** Seed-only source keys: these are reader fixtures, never crawlable adapters. */
export const FIXTURE_SOURCE_KEYS = {
  SYNTHETIC_CZ: "synthetic-cz",
  SYNTHETIC_SK: "synthetic-sk",
} as const;

export type FixtureSourceKey =
  (typeof FIXTURE_SOURCE_KEYS)[keyof typeof FIXTURE_SOURCE_KEYS];

const FIXTURE_SOURCE_APP_READER_TEXT = {
  [FIXTURE_SOURCE_KEYS.SYNTHETIC_CZ]: APP_READER_TEXT.FULL,
  [FIXTURE_SOURCE_KEYS.SYNTHETIC_SK]: APP_READER_TEXT.FULL,
} as const satisfies Record<FixtureSourceKey, AppReaderText>;

/**
 * Per source, so one source can move to `metadata-only` when its terms require
 * it. Total over every adapter and import key: a new source cannot land
 * without a decision.
 */
export const SOURCE_APP_READER_TEXT = {
  [ADAPTER_KEYS.CZ_REGIONAL]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.CZ_NS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.CZ_NSS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.CZ_US]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.SK_COURTS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.SK_US]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_COURTS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_SN]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_KIO]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_TK]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_NSA]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_NCOURT]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_COURTS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_VFGH]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_VWGH]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_BVWG]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_LVWG]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_ASYLGH]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_UBAS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_UVS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_VERG]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_UMSE]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_BKS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.AT_FINDOK]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.EU_ECJ]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.HU_BHGY]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_KIS]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_UODO]: APP_READER_TEXT.FULL,
  [ADAPTER_KEYS.PL_UOKIK]: APP_READER_TEXT.FULL,
  [IMPORT_SOURCE_KEYS.COURTLISTENER]: APP_READER_TEXT.FULL,
  ...FIXTURE_SOURCE_APP_READER_TEXT,
} as const satisfies Record<
  AdapterKey | ImportSourceKey | FixtureSourceKey,
  AppReaderText
>;

export type DeferredDocumentAdapterKey = {
  [
    TKey in keyof typeof ADAPTER_MANIFESTS
  ]: (typeof ADAPTER_MANIFESTS)[TKey]["documentStage"] extends "deferred"
    ? TKey
    : never;
}[keyof typeof ADAPTER_MANIFESTS];
