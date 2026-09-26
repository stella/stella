/**
 * Slovakia: Zbierka zákonov, Slov-Lex anchors.
 *
 * Two collections, not one: `Zb.` is the federal Czechoslovak collection an
 * act keeps forever (40/1964 Zb. is still the civil code), `Z. z.` is the
 * Slovak one from 1993. Reading either as the other silently merges two
 * different acts that share a number and a year, so the collection is part of
 * the identity, never a display suffix.
 *
 * `OZ` means 40/1964 Zb. here and 89/2012 Sb. in Prague. That collision is the
 * reason the alias table is profile data and not a shared dictionary.
 */

import { succession } from "./provision-citation-profile";
import type {
  JurisdictionProfile,
  WorkIdentifier,
} from "./provision-citation-profile";

const zz = (number: number, year: number): WorkIdentifier => ({
  number,
  year,
  collection: "Z. z.",
});

const zb = (number: number, year: number): WorkIdentifier => ({
  number,
  year,
  collection: "Zb.",
});

/** The day 300/2005 and 301/2005 Z. z. replaced the 1961 criminal codes. */
const CRIMINAL_RECODIFICATION = "2006-01-01";

/** The day 311/2001 Z. z. replaced 65/1965 Zb. */
const LABOUR_CODE_RECODIFICATION = "2002-04-01";

export const SK_PROFILE = {
  jurisdiction: "SVK",
  language: "sk",

  sectionTerms: [
    { text: "§§", unit: "section" },
    { text: "§", unit: "section" },
    { text: "čl.", unit: "article" },
    { text: "článok", unit: "article" },
    { text: "článku", unit: "article" },
    { text: "článkom", unit: "article" },
    { text: "články", unit: "article" },
  ],

  subdivisionTerms: [
    { text: "ods.", level: "subsection" },
    { text: "odsek", level: "subsection" },
    { text: "odseku", level: "subsection" },
    { text: "odseky", level: "subsection" },
    { text: "odsekom", level: "subsection" },
    { text: "písm.", level: "letter" },
    { text: "pism.", level: "letter" },
    { text: "písmeno", level: "letter" },
    { text: "písmena", level: "letter" },
    { text: "písmene", level: "letter" },
    { text: "bod", level: "point" },
    { text: "bodu", level: "point" },
    { text: "bode", level: "point" },
    { text: "body", level: "point" },
    { text: "veta", level: "sentence" },
    { text: "vety", level: "sentence" },
    { text: "vete", level: "sentence" },
    { text: "vetou", level: "sentence" },
  ],

  enumerationConnectors: ["a", "i", "alebo", "či", "prípadne"],
  rangeConnectors: ["až", "do"],
  andFollowingMarkers: ["a nasl.", "a nasledujúce", "a nasledujúcich"],

  collections: [
    { canonical: "Z. z.", spellings: ["Z. z.", "Z.z.", "Z. z", "z. z."] },
    { canonical: "Zb.", spellings: ["Zb.", "Zb", "zb."] },
  ],

  actLeadIns: [
    "zákona Národnej rady Slovenskej republiky",
    "zákona Slovenskej národnej rady",
    "zákona NR SR",
    "zákona SNR",
    "nariadenia vlády Slovenskej republiky",
    "nariadenia vlády",
    "vyhlášky Ministerstva spravodlivosti",
    "vyhlášky Ministerstva",
    "opatrenia Ministerstva",
    "ústavného zákona",
    "ústavný zákon",
    "právneho predpisu",
    "zákonníka",
    "zákonník",
    "zákonom",
    "zákona",
    "zákone",
    "zákon",
    "zák.",
    "vyhlášky",
    "vyhláška",
    "vyhl.",
    "nariadenia",
    "predpisu",
    "ustanovenia",
    "novely",
  ],

  aliases: [
    ...succession({
      spellings: ["TZ", "tr. zák."],
      older: zb(140, 1961),
      newer: zz(300, 2005),
      on: CRIMINAL_RECODIFICATION,
    }),
    ...succession({
      spellings: ["TP", "tr. por."],
      older: zb(141, 1961),
      newer: zz(301, 2005),
      on: CRIMINAL_RECODIFICATION,
    }),
    { spellings: ["OZ", "obč. zák."], identifier: zb(40, 1964) },
    { spellings: ["ObZ", "ObchZ", "obch. zák."], identifier: zb(513, 1991) },
    ...succession({
      spellings: ["ZP", "Zák. práce"],
      older: zb(65, 1965),
      newer: zz(311, 2001),
      on: LABOUR_CODE_RECODIFICATION,
    }),
    { spellings: ["CSP", "C. s. p."], identifier: zz(160, 2015) },
    { spellings: ["CMP", "C. m. p."], identifier: zz(161, 2015) },
    { spellings: ["SSP", "S. s. p."], identifier: zz(162, 2015) },
    {
      spellings: ["Ústava", "Ústavy", "Ústave", "Ústavou"],
      identifier: zb(460, 1992),
      unit: "article",
    },
    { spellings: ["EP", "Exekučný poriadok"], identifier: zz(233, 1995) },
    { spellings: ["ZKR"], identifier: zz(7, 2005) },
    { spellings: ["SP", "správny poriadok"], identifier: zb(71, 1967) },
  ],

  titles: [
    ...succession({
      spellings: ["Trestný zákon", "Trestného zákona", "Trestnom zákone"],
      older: zb(140, 1961),
      newer: zz(300, 2005),
      on: CRIMINAL_RECODIFICATION,
    }),
    ...succession({
      spellings: [
        "Trestný poriadok",
        "Trestného poriadku",
        "Trestnom poriadku",
      ],
      older: zb(141, 1961),
      newer: zz(301, 2005),
      on: CRIMINAL_RECODIFICATION,
    }),
    {
      spellings: [
        "Občiansky zákonník",
        "Občianskeho zákonníka",
        "Občianskom zákonníku",
      ],
      identifier: zb(40, 1964),
    },
    {
      spellings: [
        "Obchodný zákonník",
        "Obchodného zákonníka",
        "Obchodnom zákonníku",
      ],
      identifier: zb(513, 1991),
    },
    ...succession({
      spellings: ["Zákonník práce", "Zákonníka práce", "Zákonníku práce"],
      older: zb(65, 1965),
      newer: zz(311, 2001),
      on: LABOUR_CODE_RECODIFICATION,
    }),
    {
      spellings: [
        "Civilný sporový poriadok",
        "Civilného sporového poriadku",
        "Civilnom sporovom poriadku",
      ],
      identifier: zz(160, 2015),
    },
    {
      spellings: [
        "Civilný mimosporový poriadok",
        "Civilného mimosporového poriadku",
        "Civilnom mimosporovom poriadku",
      ],
      identifier: zz(161, 2015),
    },
    {
      spellings: [
        "Správny súdny poriadok",
        "Správneho súdneho poriadku",
        "Správnom súdnom poriadku",
      ],
      identifier: zz(162, 2015),
    },
    {
      spellings: [
        "Ústava Slovenskej republiky",
        "Ústavy Slovenskej republiky",
        "Ústave Slovenskej republiky",
      ],
      identifier: zb(460, 1992),
      unit: "article",
    },
    {
      spellings: ["zákon o priestupkoch", "zákona o priestupkoch"],
      identifier: zb(372, 1990),
    },
    {
      spellings: [
        "zákon o konkurze a reštrukturalizácii",
        "zákona o konkurze a reštrukturalizácii",
      ],
      identifier: zz(7, 2005),
    },
    {
      spellings: [
        "Exekučný poriadok",
        "Exekučného poriadku",
        "Exekučnom poriadku",
      ],
      identifier: zz(233, 1995),
    },
    // 143/1998 Z. z. took the title and the field on 1 July 1998.
    ...succession({
      spellings: ["zákon o civilnom letectve", "zákona o civilnom letectve"],
      older: zb(47, 1956),
      newer: zz(143, 1998),
      on: "1998-07-01",
    }),
    {
      spellings: ["zákon o združovaní občanov", "zákona o združovaní občanov"],
      identifier: zb(83, 1990),
    },
  ],

  ordinalWords: {
    prvá: "1",
    prvej: "1",
    prvou: "1",
    druhá: "2",
    druhej: "2",
    druhou: "2",
    tretia: "3",
    tretej: "3",
    štvrtá: "4",
    štvrtej: "4",
    piata: "5",
    piatej: "5",
  },

  sentenceAbbreviations: [
    "č",
    "čl",
    "ods",
    "písm",
    "pism",
    "bod",
    "zb",
    "zn",
    "sp",
    "nasl",
    "napr",
    "tzv",
    "tj",
    "resp",
    "atď",
    "porov",
    "pozri",
    "zák",
    "vyhl",
    "nar",
    "ust",
    "cit",
    "pozn",
    "str",
    "mil",
    "mld",
    "judr",
    "mgr",
    "ing",
    "phd",
    "csc",
    "bc",
    "mudr",
    "tr",
    "obč",
    "obch",
    "por",
  ],

  twoDigitYearPivot: 18,
  earliestYear: 1918,
  maxActGapChars: 60,

  anchor: {
    join: ".",
    render: {
      section: (value) => `paragraf-${value}`,
      article: (value) => `clanok-${value}`,
      subsection: (value) => `odsek-${value}`,
      letter: (value) => `pismeno-${value}`,
      point: (value) => `bod-${value}`,
    },
  },
} as const satisfies JurisdictionProfile;
