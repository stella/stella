/**
 * Czech Republic: Sbírka zákonů, e-sbirka.cz anchors.
 *
 * The lists carry the spellings courts print, including ones that look like
 * typos and are not: `o. s. ř` without its last period, `o.s.ř.` unspaced,
 * `zák. práce`. Each would otherwise cost a citation.
 *
 * Where a title names different acts before and after a recodification, the
 * entry carries the window the citing decision must fall in. `občanský
 * zákoník` before 2014 is 40/1964 Sb. and after it is 89/2012 Sb.; without the
 * window every pre-2014 civil judgment resolves to the wrong act, and with a
 * "latest wins" rule it does so silently.
 */

import { STATUTE_ACTS } from "@stll/api-contract/statute-acts";

import { priorWindowed, succession } from "./provision-citation-profile";
import type {
  ActTitleSpec,
  CollectionSpec,
  JurisdictionProfile,
  WorkIdentifier,
} from "./provision-citation-profile";

const CZE = STATUTE_ACTS.cze;

export const CZ_STATUTE_COLLECTION = {
  canonical: "Sb.",
  spellings: ["Sb.", "Sb", "sb.", "SB.", "SB"],
} as const satisfies CollectionSpec;

const SB = CZ_STATUTE_COLLECTION.canonical;

const sb = (number: number, year: number): WorkIdentifier => ({
  number,
  year,
  collection: SB,
});

/** The day 89/2012 Sb. replaced 40/1964 Sb. */
const RECODIFICATION = "2014-01-01";

/** The day 91/2012 Sb. replaced 97/1963 Sb. */
const PRIVATE_INTERNATIONAL_LAW_RECODIFICATION = "2014-01-01";

/** The day 134/2016 Sb. replaced 137/2006 Sb. */
const PUBLIC_PROCUREMENT_RECODIFICATION = "2016-10-01";

/** The day 262/2006 Sb. replaced 65/1965 Sb. */
const LABOUR_CODE_RECODIFICATION = "2007-01-01";

/** The day 500/2004 Sb. replaced 71/1967 Sb. */
const ADMINISTRATIVE_PROCEDURE_RECODIFICATION = "2006-01-01";

/** The day 235/2004 Sb. replaced 588/1992 Sb. */
const VAT_RECODIFICATION = "2004-05-01";

/** The day 40/2009 Sb. replaced 140/1961 Sb. */
const CRIMINAL_CODE_RECODIFICATION = "2010-01-01";

/** The day 337/1992 Sb. took effect. */
const TAX_ADMINISTRATION_1993 = "1993-01-01";

/** The day 280/2009 Sb. replaced 337/1992 Sb. */
const TAX_PROCEDURE_RECODIFICATION = "2011-01-01";

/** The day the 1948 constitution, 150/1948 Sb., took effect. */
const CONSTITUTION_1948 = "1948-06-09";

/** The day 86/1950 and 87/1950 Sb., the 1950 criminal codes, took effect. */
const CRIMINAL_CODES_1950 = "1950-08-01";

/** The day 64/1956 Sb. replaced the 1950 criminal procedure code. */
const CRIMINAL_PROCEDURE_1957 = "1957-01-01";

/** The day 140/1961 and 141/1961 Sb. replaced the criminal codes before them. */
const CRIMINAL_CODES_1962 = "1962-01-01";

/** The day 141/1950 and 142/1950 Sb. took effect. */
const CIVIL_CODES_1951 = "1951-01-01";

/** The day 40/1964 and 99/1963 Sb. replaced the 1950 civil codes. */
const CIVIL_CODES_1964 = "1964-04-01";

/** The day 100/1960 Sb. replaced the 1948 constitution. */
const CONSTITUTION_1960 = "1960-07-11";

/** The day 65/1965 Sb. took effect. */
const LABOUR_CODE_1966 = "1966-01-01";

/** The day 71/1967 Sb. took effect. */
const ADMINISTRATIVE_PROCEDURE_1968 = "1968-01-01";

/** The day 588/1992 Sb. took effect. */
const VAT_1993 = "1993-01-01";

/** The day 40/2004 Sb. took effect. */
const PUBLIC_PROCUREMENT_2004 = "2004-05-01";

/** The day 1/1993 Sb. took effect. */
const CONSTITUTION_1993 = "1993-01-01";

// Each succession is stated once and shared by the alias and title entries
// that name it, so the two tables cannot drift apart.
const CRIMINAL_CODE_SUCCESSION = {
  older: sb(86, 1950),
  olderFrom: CRIMINAL_CODES_1950,
  newer: sb(140, 1961),
  on: CRIMINAL_CODES_1962,
};

const TAX_PROCEDURE_SUCCESSION = {
  older: sb(337, 1992),
  olderFrom: TAX_ADMINISTRATION_1993,
  newer: sb(280, 2009),
  on: TAX_PROCEDURE_RECODIFICATION,
};

/** Three criminal procedure codes in turn: 1950, 1956 and 1961. */
const criminalProcedureCodes = (
  spellings: readonly string[],
): readonly ActTitleSpec[] => [
  {
    spellings,
    identifier: sb(87, 1950),
    citedFrom: CRIMINAL_CODES_1950,
    citedUntil: CRIMINAL_PROCEDURE_1957,
  },
  {
    spellings,
    identifier: sb(64, 1956),
    citedFrom: CRIMINAL_PROCEDURE_1957,
    citedUntil: CRIMINAL_CODES_1962,
  },
  { spellings, identifier: CZE.criminalProcedure.work },
];

const LABOUR_CODE_SUCCESSION = {
  older: sb(65, 1965),
  olderFrom: LABOUR_CODE_1966,
  newer: CZE.labourCode.work,
  on: LABOUR_CODE_RECODIFICATION,
};

const ADMINISTRATIVE_PROCEDURE_SUCCESSION = {
  older: sb(71, 1967),
  olderFrom: ADMINISTRATIVE_PROCEDURE_1968,
  newer: CZE.administrativeProcedure.work,
  on: ADMINISTRATIVE_PROCEDURE_RECODIFICATION,
};

/**
 * 283/2021 Sb. took effect on 1 January 2024 for reserved structures only;
 * ordinary structures stayed under 183/2006 Sb. until 1 July 2024. In between,
 * a bare `stavební zákon` may mean either, so it opens neither: a citation
 * that names its act (`z roku 2006`, `č. 283/2021 Sb.`) still resolves.
 */
const BUILDING_ACT_PHASED_IN = "2024-01-01";
const BUILDING_ACT_FULLY_APPLICABLE = "2024-07-01";

/**
 * The European Convention on Human Rights in every case a sentence puts it
 * in, with and without its closing `a základních svobod`. Bare `Úmluva` is
 * left out: a decision cites more than one convention by that word.
 */
const HUMAN_RIGHTS_CONVENTION = [
  "Úmluva",
  "Úmluvy",
  "Úmluvě",
  "Úmluvou",
  "Úmluvu",
].flatMap((noun) => [
  `${noun} o ochraně lidských práv a základních svobod`,
  `${noun} o ochraně lidských práv`,
]);

/**
 * A short title `zákon o …` in every case a citing sentence puts it in, plus
 * the `zák. o …` shorthand. Listing the forms by hand is how one of them goes
 * missing and a citation reads as text.
 */
const actTitleForms = (subject: string): readonly string[] => [
  `zákon ${subject}`,
  `zákona ${subject}`,
  `zákonu ${subject}`,
  `zákonem ${subject}`,
  `zákoně ${subject}`,
  `zák. ${subject}`,
];

export const CZ_PROFILE = {
  jurisdiction: "CZE",
  language: "cs",
  versionGrammar: {
    dateStatements: [
      { prefix: "ve znění účinném do", relation: "until" },
      { prefix: "ve znění účinném k", relation: "on" },
      { prefix: "ve znění účinném od", relation: "from" },
    ],
    amendmentPrefixes: ["ve znění zákona č.", "ve znění novely č."],
    monthNames: {
      ledna: 1,
      února: 2,
      března: 3,
      dubna: 4,
      května: 5,
      června: 6,
      července: 7,
      srpna: 8,
      září: 9,
      října: 10,
      listopadu: 11,
      prosince: 12,
    },
  },

  sectionTerms: [
    { text: "§§", unit: "section" },
    { text: "§", unit: "section" },
    { text: "čl.", unit: "article" },
    { text: "článek", unit: "article" },
    { text: "článku", unit: "article" },
    { text: "článkem", unit: "article" },
    { text: "články", unit: "article" },
    { text: "článků", unit: "article" },
    { text: "článcích", unit: "article" },
  ],

  subdivisionTerms: [
    { text: "odst.", level: "subsection" },
    { text: "odstavec", level: "subsection" },
    { text: "odstavce", level: "subsection" },
    { text: "odstavci", level: "subsection" },
    { text: "písm.", level: "letter" },
    { text: "pism.", level: "letter" },
    { text: "písmeno", level: "letter" },
    { text: "písmene", level: "letter" },
    { text: "písmena", level: "letter" },
    { text: "bod", level: "point" },
    { text: "bodu", level: "point" },
    { text: "bodě", level: "point" },
    { text: "body", level: "point" },
    { text: "věta", level: "sentence" },
    { text: "věty", level: "sentence" },
    { text: "větě", level: "sentence" },
    { text: "věto", level: "sentence" },
  ],

  enumerationConnectors: ["a", "i", "nebo", "anebo", "či", "případně"],
  rangeConnectors: ["až", "do"],
  andFollowingMarkers: [
    "a násl.",
    "a nás.",
    "a následujících",
    "a následující",
  ],

  collections: [
    { canonical: "Sb. m. s.", spellings: ["Sb. m. s.", "Sb.m.s."] },
    CZ_STATUTE_COLLECTION,
    { canonical: "Ú. l.", spellings: ["Ú. l.", "Ú.l."] },
  ],

  actLeadIns: [
    "zákonného opatření Senátu",
    "vyhlášky Ministerstva spravedlnosti",
    "vyhlášky Ministerstva",
    "nařízení vlády České republiky",
    "nařízení vlády",
    "zákona České národní rady",
    "zákona ČNR",
    "ústavního zákona",
    "ústavní zákon",
    "právního předpisu",
    "zákoníku",
    "zákoník",
    "zákonem",
    "zákona",
    "zákonu",
    "zákoně",
    "zákon",
    "zák.",
    "vyhlášky",
    "vyhláška",
    "vyhl.",
    "nařízení",
    "předpisu",
    "ustanovení",
    "novely",
    "novela",
  ],

  aliases: [
    {
      spellings: ["OSŘ", "o. s. ř.", "o.s.ř.", "o. s. ř", "o.s.ř"],
      identifier: CZE.civilProcedure.work,
    },
    { spellings: ["NOZ"], identifier: CZE.civilCode.work },
    ...succession({
      spellings: ["OZ", "o. z.", "o.z."],
      older: sb(40, 1964),
      olderFrom: CIVIL_CODES_1964,
      newer: CZE.civilCode.work,
      on: RECODIFICATION,
    }),
    { spellings: ["OZ64"], identifier: sb(40, 1964) },
    ...priorWindowed({
      spellings: ["obč. zák.", "obč.zák.", "obč. zák"],
      older: sb(141, 1950),
      olderFrom: CIVIL_CODES_1951,
      newer: sb(40, 1964),
      on: CIVIL_CODES_1964,
    }),
    {
      spellings: ["ObchZ", "obch. zák.", "obch.zák.", "obch. zák"],
      identifier: sb(513, 1991),
    },
    // Court convention: `tr. zák.` is the 1961 criminal code, or the 1950 one
    // before it, and `tr. zákoník` the 2009 one. A reader that applies a
    // decision's own `dále jen` definitions lets one of `tr. zák.` take
    // precedence; the statute reader's fallback grammar reads no definitions.
    ...priorWindowed({
      spellings: ["tr. zák.", "tr. zákon", "tr. zákona", "tr. zákonem"],
      ...CRIMINAL_CODE_SUCCESSION,
    }),
    {
      spellings: ["tr. zákoník", "tr. zákoníku", "tr. zákoníkem"],
      identifier: CZE.criminalCode.work,
    },
    // `TZ` has no convention between the two codes; the citing date decides.
    {
      spellings: ["TZ"],
      identifier: sb(140, 1961),
      citedFrom: CRIMINAL_CODES_1962,
      citedUntil: CRIMINAL_CODE_RECODIFICATION,
    },
    {
      spellings: ["TZ"],
      identifier: CZE.criminalCode.work,
      citedFrom: CRIMINAL_CODE_RECODIFICATION,
    },
    ...criminalProcedureCodes([
      "TŘ",
      "tr. ř.",
      "tr.ř.",
      "tr. ř",
      "tr. řád",
      "tr. řádu",
      "tr. řádem",
    ]),
    ...succession({
      spellings: ["ZP", "zák. práce", "zákoník práce"],
      ...LABOUR_CODE_SUCCESSION,
    }),
    ...succession({
      spellings: ["SŘ", "spr. ř.", "s. ř.", "s.ř."],
      ...ADMINISTRATIVE_PROCEDURE_SUCCESSION,
    }),
    {
      spellings: ["SŘS", "s. ř. s.", "s.ř.s."],
      identifier: CZE.administrativeJustice.work,
    },
    // Courts called 337/1992 Sb. the tax procedure code before 280/2009 Sb.
    // took that title.
    ...priorWindowed({
      spellings: ["DŘ", "d. ř."],
      ...TAX_PROCEDURE_SUCCESSION,
    }),
    {
      spellings: ["EŘ", "ex. řád", "exek. řád", "ex. ř."],
      identifier: sb(120, 2001),
    },
    { spellings: ["IZ", "InsZ", "ins. zák."], identifier: CZE.insolvency.work },
    { spellings: ["ZOK"], identifier: CZE.corporations.work },
    {
      spellings: ["ZŘS", "z. ř. s.", "z.ř.s."],
      identifier: CZE.specialProceedings.work,
    },
    {
      spellings: ["LZPS", "Listina", "Listiny", "Listině", "Listinou"],
      identifier: CZE.charter.work,
      unit: "article",
    },
    // Capitalised only: lowercase `ústavy` are institutions, not the
    // constitution. Bare, it is the constitution in force on the citing day;
    // the 1948 one numbers its provisions by section after its first articles.
    {
      spellings: ["Ústava", "Ústavy", "Ústavě", "Ústavou"],
      identifier: sb(150, 1948),
      citedFrom: CONSTITUTION_1948,
      citedUntil: CONSTITUTION_1960,
    },
    {
      spellings: ["Ústava", "Ústavy", "Ústavě", "Ústavou"],
      identifier: sb(100, 1960),
      unit: "article",
      citedFrom: CONSTITUTION_1960,
      citedUntil: CONSTITUTION_1993,
    },
    {
      spellings: [
        "Ústava",
        "Ústavy",
        "Ústavě",
        "Ústavou",
        "Ústava ČR",
        "Ústavy ČR",
        "Ústavě ČR",
        "Ústavou ČR",
      ],
      identifier: CZE.constitution.work,
      unit: "article",
    },
    {
      spellings: ["Ústava ČSSR", "Ústavy ČSSR", "Ústavě ČSSR", "Ústavou ČSSR"],
      identifier: sb(100, 1960),
      unit: "article",
    },
    { spellings: ["AT"], identifier: sb(177, 1996) },
    { spellings: ["ZDP"], identifier: CZE.incomeTax.work },
    ...succession({
      spellings: ["ZDPH"],
      older: sb(588, 1992),
      olderFrom: VAT_1993,
      newer: CZE.vat.work,
      on: VAT_RECODIFICATION,
    }),
    { spellings: ["ZZVZ", "NZVZ"], identifier: sb(134, 2016) },
    ...succession({
      spellings: ["ZVZ"],
      older: sb(40, 2004),
      olderFrom: PUBLIC_PROCUREMENT_2004,
      newer: sb(137, 2006),
      on: "2006-07-01",
    }),
    // The predecessor, 344/1992 Sb., is not known by this name.
    {
      spellings: ["KatZ"],
      identifier: sb(256, 2013),
      citedFrom: RECODIFICATION,
    },
    // Courts cited 97/1963 Sb. as ZMPS before its successor took effect
    // (NS 28 Nd 276/2012, 13 March 2013).
    ...succession({
      spellings: ["ZMPS"],
      older: sb(97, 1963),
      olderFrom: CIVIL_CODES_1964,
      newer: sb(91, 2012),
      on: PRIVATE_INTERNATIONAL_LAW_RECODIFICATION,
    }),
    { spellings: ["ZOR"], identifier: sb(94, 1963) },
    // Replaced 58/1969 Sb., a differently named act, on 15 May 1998.
    { spellings: ["OdpŠk"], identifier: sb(82, 1998), citedFrom: "1998-05-15" },
    { spellings: ["InfZ"], identifier: sb(106, 1999) },
  ],

  titles: [
    ...priorWindowed({
      spellings: [
        "občanský soudní řád",
        "občanského soudního řádu",
        "občanském soudním řádu",
        "občanskému soudnímu řádu",
        "občanským soudním řádem",
      ],
      older: sb(142, 1950),
      olderFrom: CIVIL_CODES_1951,
      newer: CZE.civilProcedure.work,
      on: CIVIL_CODES_1964,
    }),
    {
      spellings: [
        "občanský zákoník",
        "občanského zákoníku",
        "občanském zákoníku",
        "občanskému zákoníku",
        "občanským zákoníkem",
      ],
      identifier: sb(141, 1950),
      citedFrom: CIVIL_CODES_1951,
      citedUntil: CIVIL_CODES_1964,
    },
    {
      spellings: [
        "občanský zákoník",
        "občanského zákoníku",
        "občanském zákoníku",
        "občanskému zákoníku",
        "občanským zákoníkem",
      ],
      identifier: sb(40, 1964),
      citedFrom: CIVIL_CODES_1964,
      citedUntil: RECODIFICATION,
    },
    {
      spellings: [
        "občanský zákoník",
        "občanského zákoníku",
        "občanském zákoníku",
        "občanskému zákoníku",
        "občanským zákoníkem",
      ],
      identifier: CZE.civilCode.work,
      citedFrom: RECODIFICATION,
    },
    {
      spellings: actTitleForms("o Ústavním soudu"),
      identifier: sb(182, 1993),
    },
    ...criminalProcedureCodes([
      "trestní řád",
      "trestního řádu",
      "trestním řádu",
      "trestnímu řádu",
      "trestním řádem",
    ]),
    {
      spellings: [
        "trestní zákoník",
        "trestního zákoníku",
        "trestním zákoníku",
        "trestnímu zákoníku",
        "trestním zákoníkem",
      ],
      identifier: CZE.criminalCode.work,
    },
    // The 1950 and 1961 codes' name; the 2009 one is a `zákoník`, never a
    // `zákon`.
    ...priorWindowed({
      spellings: [
        "trestní zákon",
        "trestního zákona",
        "trestním zákoně",
        "trestnímu zákonu",
        "trestním zákonem",
      ],
      ...CRIMINAL_CODE_SUCCESSION,
    }),
    {
      spellings: HUMAN_RIGHTS_CONVENTION,
      identifier: sb(209, 1992),
      unit: "article",
    },
    {
      spellings: [
        "stavební zákon",
        "stavebního zákona",
        "stavebním zákoně",
        "stavebnímu zákonu",
        "stavebním zákonem",
      ],
      identifier: sb(50, 1976),
      citedFrom: "1976-10-01",
      citedUntil: "2007-01-01",
    },
    {
      spellings: [
        "stavební zákon",
        "stavebního zákona",
        "stavebním zákoně",
        "stavebnímu zákonu",
        "stavebním zákonem",
      ],
      identifier: sb(183, 2006),
      citedFrom: "2007-01-01",
      citedUntil: BUILDING_ACT_PHASED_IN,
    },
    {
      spellings: [
        "stavební zákon",
        "stavebního zákona",
        "stavebním zákoně",
        "stavebnímu zákonu",
        "stavebním zákonem",
      ],
      identifier: CZE.building.work,
      citedFrom: BUILDING_ACT_FULLY_APPLICABLE,
    },
    {
      spellings: [
        "katastrální zákon",
        "katastrálního zákona",
        "katastrálním zákoně",
        "katastrálnímu zákonu",
        "katastrálním zákonem",
      ],
      identifier: sb(344, 1992),
      citedFrom: "1993-01-01",
      citedUntil: "2014-01-01",
    },
    {
      spellings: [
        "katastrální zákon",
        "katastrálního zákona",
        "katastrálním zákoně",
        "katastrálnímu zákonu",
        "katastrálním zákonem",
      ],
      identifier: sb(256, 2013),
      citedFrom: "2014-01-01",
    },
    {
      spellings: [
        "živnostenský zákon",
        "živnostenského zákona",
        "živnostenském zákoně",
        "živnostenskému zákonu",
        "živnostenským zákonem",
      ],
      identifier: CZE.trades.work,
    },
    {
      spellings: actTitleForms("o veřejných zakázkách"),
      identifier: sb(40, 2004),
      citedFrom: PUBLIC_PROCUREMENT_2004,
      citedUntil: "2006-07-01",
    },
    // Open-ended: 134/2016 Sb. is titled `o zadávání veřejných zakázek`, so
    // after it this name still means 137/2006 Sb. for the tenders it governs.
    {
      spellings: actTitleForms("o veřejných zakázkách"),
      identifier: sb(137, 2006),
      citedFrom: "2006-07-01",
    },
    {
      spellings: actTitleForms("o správě daní a poplatků"),
      identifier: sb(337, 1992),
      citedFrom: TAX_ADMINISTRATION_1993,
    },
    { spellings: actTitleForms("o právu rodinném"), identifier: sb(265, 1949) },
    { spellings: actTitleForms("o státní službě"), identifier: sb(234, 2014) },
    {
      spellings: [
        ...actTitleForms(
          "o majetkovém vyrovnání s církvemi a náboženskými společnostmi",
        ),
        ...actTitleForms("o majetkovém vyrovnání"),
      ],
      identifier: sb(428, 2012),
    },
    { spellings: actTitleForms("o rodině"), identifier: sb(94, 1963) },
    ...succession({
      spellings: ["zákoník práce", "zákoníku práce", "zákoníkem práce"],
      ...LABOUR_CODE_SUCCESSION,
    }),
    {
      spellings: [
        "obchodní zákoník",
        "obchodního zákoníku",
        "obchodním zákoníku",
      ],
      identifier: sb(513, 1991),
    },
    {
      spellings: [
        "Listina základních práv a svobod",
        "Listiny základních práv a svobod",
        "Listině základních práv a svobod",
        "Listinou základních práv a svobod",
      ],
      identifier: CZE.charter.work,
      unit: "article",
    },
    {
      spellings: [
        "soudní řád správní",
        "soudního řádu správního",
        "soudním řádu správním",
        "soudnímu řádu správnímu",
        "soudním řádem správním",
      ],
      identifier: CZE.administrativeJustice.work,
    },
    // 20/1955 Sb. bore the name until 91/1960 Sb., titled `o správním
    // řízení`, replaced it on 1 July 1960.
    {
      spellings: [
        "správní řád",
        "správního řádu",
        "správním řádu",
        "správnímu řádu",
        "správním řádem",
      ],
      identifier: sb(20, 1955),
      citedFrom: "1955-07-01",
      citedUntil: "1960-07-01",
    },
    ...succession({
      spellings: [
        "správní řád",
        "správního řádu",
        "správním řádu",
        "správnímu řádu",
        "správním řádem",
      ],
      ...ADMINISTRATIVE_PROCEDURE_SUCCESSION,
    }),
    {
      spellings: [
        "exekuční řád",
        "exekučního řádu",
        "exekučním řádu",
        "exekučnímu řádu",
        "exekučním řádem",
      ],
      identifier: sb(120, 2001),
    },
    {
      spellings: [
        "insolvenční zákon",
        "insolvenčního zákona",
        "insolvenčním zákoně",
        "insolvenčnímu zákonu",
        "insolvenčním zákonem",
      ],
      identifier: CZE.insolvency.work,
    },
    {
      spellings: actTitleForms("o obchodních korporacích"),
      identifier: CZE.corporations.work,
    },
    {
      spellings: ["advokátní tarif", "advokátního tarifu", "advokátním tarifu"],
      identifier: sb(177, 1996),
      // 270/1990 Sb. set fees before it under another title.
      citedFrom: "1996-07-01",
    },
    ...succession({
      spellings: [
        "zákon o zaměstnanosti",
        "zákona o zaměstnanosti",
        "zákoně o zaměstnanosti",
      ],
      older: sb(1, 1991),
      olderFrom: "1991-02-01",
      newer: sb(435, 2004),
      on: "2004-10-01",
    }),
    ...succession({
      spellings: [
        "zákon o soudech a soudcích",
        "zákona o soudech a soudcích",
        "zákoně o soudech a soudcích",
      ],
      older: sb(335, 1991),
      olderFrom: "1991-09-01",
      newer: sb(6, 2002),
      on: "2002-04-01",
    }),
    ...succession({
      spellings: [
        "zákon o obcích",
        "zákona o obcích",
        "obecní zřízení",
        "obecního zřízení",
      ],
      older: sb(367, 1990),
      // In force from the 1990 municipal elections.
      olderFrom: "1990-11-24",
      newer: sb(128, 2000),
      on: "2000-11-12",
    }),
    // A historical-title lookup, not 199/1994 Sb.'s force period (it was
    // repealed on 1 May 2004): between the two acts that bore this title,
    // 40/2004 and 137/2006 Sb. were titled `o veřejných zakázkách`, so the
    // name can only mean the 1994 act until 134/2016 Sb. took it.
    {
      spellings: actTitleForms("o zadávání veřejných zakázek"),
      identifier: sb(199, 1994),
      citedFrom: "1995-01-01",
      citedUntil: PUBLIC_PROCUREMENT_RECODIFICATION,
    },
    {
      spellings: actTitleForms("o zadávání veřejných zakázek"),
      identifier: sb(134, 2016),
      citedFrom: PUBLIC_PROCUREMENT_RECODIFICATION,
    },
    ...priorWindowed({
      spellings: [
        "daňový řád",
        "daňového řádu",
        "daňovém řádu",
        "daňovému řádu",
        "daňovým řádem",
      ],
      ...TAX_PROCEDURE_SUCCESSION,
    }),
    {
      spellings: [
        "Ústava České republiky",
        "Ústavy České republiky",
        "Ústavě České republiky",
      ],
      identifier: CZE.constitution.work,
      unit: "article",
    },
    {
      spellings: [
        "Ústava 9. května",
        "Ústavy 9. května",
        "Ústavě 9. května",
        "Ústavou 9. května",
        "Ústava Československé republiky",
        "Ústavy Československé republiky",
        "Ústavě Československé republiky",
        "Ústavou Československé republiky",
      ],
      identifier: sb(150, 1948),
    },
    {
      spellings: [
        "Ústava Československé socialistické republiky",
        "Ústavy Československé socialistické republiky",
        "Ústavě Československé socialistické republiky",
        "Ústavou Československé socialistické republiky",
      ],
      identifier: sb(100, 1960),
      unit: "article",
    },
    {
      spellings: [
        "zákon o soudních exekutorech a exekuční činnosti",
        "zákona o soudních exekutorech a exekuční činnosti",
      ],
      identifier: sb(120, 2001),
    },
    {
      spellings: actTitleForms("o zvláštních řízeních soudních"),
      identifier: CZE.specialProceedings.work,
    },
    {
      spellings: actTitleForms("o daních z příjmů"),
      identifier: CZE.incomeTax.work,
    },
    {
      spellings: actTitleForms("o dani z přidané hodnoty"),
      identifier: sb(588, 1992),
      citedFrom: VAT_1993,
      citedUntil: VAT_RECODIFICATION,
    },
    {
      spellings: actTitleForms("o dani z přidané hodnoty"),
      identifier: CZE.vat.work,
      citedFrom: VAT_RECODIFICATION,
    },
    ...succession({
      spellings: actTitleForms("o pobytu cizinců"),
      older: sb(123, 1992),
      olderFrom: "1992-10-01",
      newer: sb(326, 1999),
      on: "2000-01-01",
    }),
    { spellings: actTitleForms("o azylu"), identifier: sb(325, 1999) },
    {
      spellings: actTitleForms("o soudních poplatcích"),
      identifier: sb(549, 1991),
    },
    {
      spellings: actTitleForms("o svobodném přístupu k informacím"),
      identifier: sb(106, 1999),
    },
    {
      spellings: actTitleForms("o odpovědnosti za přestupky"),
      identifier: sb(250, 2016),
    },
    {
      spellings: actTitleForms("o silničním provozu"),
      identifier: sb(361, 2000),
    },
    ...succession({
      spellings: actTitleForms("o advokacii"),
      older: sb(128, 1990),
      olderFrom: "1990-07-01",
      newer: sb(85, 1996),
      on: "1996-07-01",
    }),
  ],

  ordinalWords: {
    první: "1",
    prvá: "1",
    prvé: "1",
    prvního: "1",
    druhá: "2",
    druhé: "2",
    druhý: "2",
    druhého: "2",
    třetí: "3",
    třetího: "3",
    čtvrtá: "4",
    čtvrté: "4",
    pátá: "5",
    páté: "5",
  },

  sentenceAbbreviations: [
    "č",
    "čl",
    "odst",
    "písm",
    "pism",
    "bod",
    "sb",
    "zn",
    "sp",
    "sen",
    "j",
    "tzv",
    "tj",
    "resp",
    "příp",
    "popř",
    "event",
    "násl",
    "nás",
    "atd",
    "apod",
    "srov",
    "viz",
    "mj",
    "zák",
    "vyhl",
    "nař",
    "nál",
    "usn",
    "rozs",
    "roz",
    "ust",
    "tr",
    "obč",
    "obch",
    "spr",
    "ins",
    "exek",
    "ex",
    "cit",
    "pozn",
    "odd",
    "str",
    "mil",
    "mld",
    "zejm",
    "judr",
    "mgr",
    "ing",
    "ph",
    "csc",
    "bc",
    "st",
    "mudr",
    "kč",
  ],

  twoDigitYearPivot: 18,
  earliestYear: 1918,
  maxActGapChars: 60,

  anchor: {
    join: "-",
    render: {
      section: (value) => `par_${value}`,
      article: (value) => `cl_${value}`,
      subsection: (value) => `odst_${value}`,
      letter: (value) => `pism_${value}`,
      point: (value) => `bod_${value}`,
    },
  },
} as const satisfies JurisdictionProfile;
