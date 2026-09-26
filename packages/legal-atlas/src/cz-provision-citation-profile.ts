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
    { spellings: ["NOZ", "OZ", "o. z.", "o.z."], identifier: sb(89, 2012) },
    {
      spellings: ["OZ64", "obč. zák.", "obč.zák.", "obč. zák"],
      identifier: sb(40, 1964),
    },
    {
      spellings: ["ObchZ", "obch. zák.", "obch.zák.", "obch. zák"],
      identifier: sb(513, 1991),
    },
    {
      spellings: [
        "TZ",
        "tr. zák.",
        "tr. zákoník",
        "tr. zákoníku",
        "tr. zákoníkem",
      ],
      identifier: sb(40, 2009),
    },
    {
      spellings: ["TŘ", "tr. ř.", "tr.ř.", "tr. ř"],
      identifier: sb(141, 1961),
    },
    {
      spellings: ["ZP", "zák. práce", "zákoník práce"],
      identifier: sb(262, 2006),
    },
    {
      spellings: ["SŘ", "spr. ř.", "s. ř.", "s.ř."],
      identifier: sb(500, 2004),
    },
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
    },
    { spellings: ["AT"], identifier: sb(177, 1996) },
    { spellings: ["ZDP"], identifier: sb(586, 1992) },
    { spellings: ["ZDPH"], identifier: sb(235, 2004) },
    { spellings: ["ZZVZ", "NZVZ"], identifier: sb(134, 2016) },
    { spellings: ["ZVZ"], identifier: sb(137, 2006) },
    { spellings: ["KatZ"], identifier: sb(256, 2013) },
    { spellings: ["ZMPS"], identifier: sb(91, 2012) },
    { spellings: ["ZOR"], identifier: sb(94, 1963) },
    { spellings: ["OdpŠk"], identifier: sb(82, 1998) },
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
    {
      spellings: ["zákoník práce", "zákoníku práce", "zákoníkem práce"],
      identifier: sb(262, 2006),
    },
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
    {
      spellings: [
        "správní řád",
        "správního řádu",
        "správním řádu",
        "správnímu řádu",
        "správním řádem",
      ],
      identifier: sb(500, 2004),
    },
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
    },
    {
      spellings: [
        "zákon o zaměstnanosti",
        "zákona o zaměstnanosti",
        "zákoně o zaměstnanosti",
      ],
      identifier: sb(435, 2004),
    },
    {
      spellings: [
        "zákon o soudech a soudcích",
        "zákona o soudech a soudcích",
        "zákoně o soudech a soudcích",
      ],
      identifier: sb(6, 2002),
    },
    {
      spellings: [
        "zákon o obcích",
        "zákona o obcích",
        "obecní zřízení",
        "obecního zřízení",
      ],
      identifier: sb(128, 2000),
    },
    {
      spellings: actTitleForms("o zadávání veřejných zakázek"),
      identifier: sb(134, 2016),
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
    {
      spellings: actTitleForms("o dani z přidané hodnoty"),
      identifier: sb(235, 2004),
    },
    { spellings: actTitleForms("o pobytu cizinců"), identifier: sb(326, 1999) },
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
    { spellings: actTitleForms("o advokacii"), identifier: sb(85, 1996) },
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
