/**
 * Czech Republic: Sbírka zákonů, e-sbirka.cz anchors.
 *
 * Sources for the vocabulary are the court fixtures in the pinned public repo
 * (`cz-ns`, `cz-us`), which is why the lists carry spellings that look like
 * typos and are not: `písm. f/` with a slash instead of a bracket, `177/96 Sb.`
 * with a two-digit year, `o.s.ř.` unspaced, `zák. práce`. Each of those appears
 * verbatim in a real decision and each would otherwise cost a citation.
 *
 * Where a title names different acts before and after a recodification, the
 * entry carries the window the citing decision must fall in. `občanský
 * zákoník` before 2014 is 40/1964 Sb. and after it is 89/2012 Sb.; without the
 * window every pre-2014 civil judgment resolves to the wrong act, and with a
 * "latest wins" rule it does so silently.
 */

import type {
  ActTitleSpec,
  JurisdictionProfile,
  WorkIdentifier,
} from "./provision-citation-profile";

const SB = "Sb.";

const sb = (number: number, year: number): WorkIdentifier => ({
  number,
  year,
  collection: SB,
});

/** The day 89/2012 Sb. replaced 40/1964 Sb. */
const RECODIFICATION = "2014-01-01";

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

type SuccessionOptions = {
  spellings: readonly string[];
  older: WorkIdentifier;
  newer: WorkIdentifier;
  /** The day the newer act took effect (e-Sbírka `datum účinnosti od`). */
  on: string;
};

/**
 * A name two acts bore in turn: the older until the newer took effect, the
 * newer from then. A citation that names its act outright (`z roku 1965`,
 * `č. 65/1965 Sb.`) still opens the older one after the switch.
 */
const succession = ({
  newer,
  older,
  on,
  spellings,
}: SuccessionOptions): readonly ActTitleSpec[] => [
  { spellings, identifier: older, citedUntil: on },
  { spellings, identifier: newer, citedFrom: on },
];

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
    { canonical: "Sb.", spellings: ["Sb.", "Sb", "sb.", "SB.", "SB"] },
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
      identifier: sb(99, 1963),
    },
    { spellings: ["NOZ"], identifier: sb(89, 2012) },
    ...succession({
      spellings: ["OZ", "o. z.", "o.z."],
      older: sb(40, 1964),
      newer: sb(89, 2012),
      on: RECODIFICATION,
    }),
    {
      spellings: ["OZ64", "obč. zák.", "obč.zák.", "obč. zák"],
      identifier: sb(40, 1964),
    },
    {
      spellings: ["ObchZ", "obch. zák.", "obch.zák.", "obch. zák"],
      identifier: sb(513, 1991),
    },
    // Court convention, whatever the citing date: `tr. zák.` is the 1961
    // criminal code and `tr. zákoník` the 2009 one. A decision that defines
    // `tr. zák.` otherwise overrides this in its own text.
    {
      spellings: ["tr. zák.", "tr. zákon", "tr. zákona", "tr. zákonem"],
      identifier: sb(140, 1961),
    },
    {
      spellings: ["tr. zákoník", "tr. zákoníku", "tr. zákoníkem"],
      identifier: sb(40, 2009),
    },
    // `TZ` has no convention between the two codes; the citing date decides.
    {
      spellings: ["TZ"],
      identifier: sb(140, 1961),
      citedUntil: CRIMINAL_CODE_RECODIFICATION,
    },
    {
      spellings: ["TZ"],
      identifier: sb(40, 2009),
      citedFrom: CRIMINAL_CODE_RECODIFICATION,
    },
    {
      spellings: [
        "TŘ",
        "tr. ř.",
        "tr.ř.",
        "tr. ř",
        "tr. řád",
        "tr. řádu",
        "tr. řádem",
      ],
      identifier: sb(141, 1961),
    },
    ...succession({
      spellings: ["ZP", "zák. práce", "zákoník práce"],
      older: sb(65, 1965),
      newer: sb(262, 2006),
      on: LABOUR_CODE_RECODIFICATION,
    }),
    ...succession({
      spellings: ["SŘ", "spr. ř.", "s. ř.", "s.ř."],
      older: sb(71, 1967),
      newer: sb(500, 2004),
      on: ADMINISTRATIVE_PROCEDURE_RECODIFICATION,
    }),
    { spellings: ["SŘS", "s. ř. s.", "s.ř.s."], identifier: sb(150, 2002) },
    { spellings: ["DŘ", "d. ř."], identifier: sb(280, 2009) },
    {
      spellings: ["EŘ", "ex. řád", "exek. řád", "ex. ř."],
      identifier: sb(120, 2001),
    },
    { spellings: ["IZ", "InsZ", "ins. zák."], identifier: sb(182, 2006) },
    { spellings: ["ZOK"], identifier: sb(90, 2012) },
    { spellings: ["ZŘS", "z. ř. s.", "z.ř.s."], identifier: sb(292, 2013) },
    {
      spellings: ["LZPS", "Listina", "Listiny", "Listině", "Listinou"],
      identifier: sb(2, 1993),
      unit: "article",
    },
    // Capitalised only: lowercase `ústavy` are institutions, not the
    // constitution.
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
      identifier: sb(1, 1993),
      unit: "article",
    },
    { spellings: ["AT"], identifier: sb(177, 1996) },
    { spellings: ["ZDP"], identifier: sb(586, 1992) },
    ...succession({
      spellings: ["ZDPH"],
      older: sb(588, 1992),
      newer: sb(235, 2004),
      on: VAT_RECODIFICATION,
    }),
    { spellings: ["ZZVZ", "NZVZ"], identifier: sb(134, 2016) },
    ...succession({
      spellings: ["ZVZ"],
      older: sb(40, 2004),
      newer: sb(137, 2006),
      on: "2006-07-01",
    }),
    // The predecessors (344/1992, 97/1963) are not known by these names.
    {
      spellings: ["KatZ"],
      identifier: sb(256, 2013),
      citedFrom: RECODIFICATION,
    },
    {
      spellings: ["ZMPS"],
      identifier: sb(91, 2012),
      citedFrom: RECODIFICATION,
    },
    { spellings: ["ZOR"], identifier: sb(94, 1963) },
    // Replaced 58/1969 Sb., a differently named act, on 15 May 1998.
    { spellings: ["OdpŠk"], identifier: sb(82, 1998), citedFrom: "1998-05-15" },
    { spellings: ["InfZ"], identifier: sb(106, 1999) },
  ],

  titles: [
    {
      spellings: [
        "občanský soudní řád",
        "občanského soudního řádu",
        "občanském soudním řádu",
        "občanskému soudnímu řádu",
        "občanským soudním řádem",
      ],
      identifier: sb(99, 1963),
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
      identifier: sb(89, 2012),
      citedFrom: RECODIFICATION,
    },
    {
      spellings: actTitleForms("o Ústavním soudu"),
      identifier: sb(182, 1993),
    },
    {
      spellings: [
        "trestní řád",
        "trestního řádu",
        "trestním řádu",
        "trestnímu řádu",
        "trestním řádem",
      ],
      identifier: sb(141, 1961),
    },
    {
      spellings: [
        "trestní zákoník",
        "trestního zákoníku",
        "trestním zákoníku",
        "trestnímu zákoníku",
        "trestním zákoníkem",
      ],
      identifier: sb(40, 2009),
    },
    // The 1961 code's name; the 2009 one is a `zákoník`, never a `zákon`.
    {
      spellings: [
        "trestní zákon",
        "trestního zákona",
        "trestním zákoně",
        "trestnímu zákonu",
        "trestním zákonem",
      ],
      identifier: sb(140, 1961),
    },
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
      identifier: sb(283, 2021),
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
      spellings: actTitleForms("o veřejných zakázkách"),
      identifier: sb(40, 2004),
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
    },
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
      older: sb(65, 1965),
      newer: sb(262, 2006),
      on: LABOUR_CODE_RECODIFICATION,
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
      identifier: sb(2, 1993),
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
      identifier: sb(150, 2002),
    },
    ...succession({
      spellings: [
        "správní řád",
        "správního řádu",
        "správním řádu",
        "správnímu řádu",
        "správním řádem",
      ],
      older: sb(71, 1967),
      newer: sb(500, 2004),
      on: ADMINISTRATIVE_PROCEDURE_RECODIFICATION,
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
      identifier: sb(182, 2006),
    },
    {
      spellings: actTitleForms("o obchodních korporacích"),
      identifier: sb(90, 2012),
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
      citedUntil: PUBLIC_PROCUREMENT_RECODIFICATION,
    },
    {
      spellings: actTitleForms("o zadávání veřejných zakázek"),
      identifier: sb(134, 2016),
      citedFrom: PUBLIC_PROCUREMENT_RECODIFICATION,
    },
    {
      spellings: [
        "daňový řád",
        "daňového řádu",
        "daňovém řádu",
        "daňovému řádu",
        "daňovým řádem",
      ],
      identifier: sb(280, 2009),
    },
    {
      spellings: [
        "Ústava České republiky",
        "Ústavy České republiky",
        "Ústavě České republiky",
      ],
      identifier: sb(1, 1993),
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
      identifier: sb(292, 2013),
    },
    {
      spellings: actTitleForms("o daních z příjmů"),
      identifier: sb(586, 1992),
    },
    // Read from 1 January 1993, when 588/1992 Sb. took effect.
    {
      spellings: actTitleForms("o dani z přidané hodnoty"),
      identifier: sb(588, 1992),
      citedFrom: "1993-01-01",
      citedUntil: VAT_RECODIFICATION,
    },
    {
      spellings: actTitleForms("o dani z přidané hodnoty"),
      identifier: sb(235, 2004),
      citedFrom: VAT_RECODIFICATION,
    },
    ...succession({
      spellings: actTitleForms("o pobytu cizinců"),
      older: sb(123, 1992),
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
