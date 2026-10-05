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

import { STATUTE_ACTS } from "@stll/api-contract/statute-acts";

import { priorWindowed, succession } from "./provision-citation-profile";
import type {
  JurisdictionProfile,
  WorkIdentifier,
} from "./provision-citation-profile";

const SVK = STATUTE_ACTS.svk;

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

/** The day 140/1961 and 141/1961 Zb. took effect. */
const CRIMINAL_CODES_1962 = "1962-01-01";

/** The day 311/2001 Z. z. replaced 65/1965 Zb. */
const LABOUR_CODE_RECODIFICATION = "2002-04-01";

// Each succession is stated once and shared by the alias and title entries
// that name it, so the two tables cannot drift apart.
const CRIMINAL_CODE_SUCCESSION = {
  older: zb(140, 1961),
  olderFrom: CRIMINAL_CODES_1962,
  newer: SVK.criminalCode.work,
  on: CRIMINAL_RECODIFICATION,
};

const CRIMINAL_PROCEDURE_SUCCESSION = {
  older: zb(141, 1961),
  olderFrom: CRIMINAL_CODES_1962,
  newer: zz(301, 2005),
  on: CRIMINAL_RECODIFICATION,
};

const LABOUR_CODE_SUCCESSION = {
  older: zb(65, 1965),
  olderFrom: "1966-01-01",
  newer: SVK.labourCode.work,
  on: LABOUR_CODE_RECODIFICATION,
};

export const SK_PROFILE = {
  jurisdiction: "SVK",
  language: "sk",
  versionGrammar: {
    dateStatements: [
      { prefix: "v znení účinnom do", relation: "until" },
      { prefix: "v znení účinnom k", relation: "on" },
      { prefix: "v znení účinnom od", relation: "from" },
    ],
    amendmentPrefixes: ["v znení zákona č.", "v znení novely č."],
    monthNames: {
      januára: 1,
      februára: 2,
      marca: 3,
      apríla: 4,
      mája: 5,
      júna: 6,
      júla: 7,
      augusta: 8,
      septembra: 9,
      októbra: 10,
      novembra: 11,
      decembra: 12,
    },
  },

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
      ...CRIMINAL_CODE_SUCCESSION,
    }),
    ...succession({
      spellings: ["TP", "tr. por."],
      ...CRIMINAL_PROCEDURE_SUCCESSION,
    }),
    { spellings: ["OZ", "obč. zák."], identifier: SVK.civilCode.work },
    {
      spellings: ["ObZ", "ObchZ", "obch. zák."],
      identifier: SVK.commercialCode.work,
    },
    ...succession({
      spellings: ["ZP", "Zák. práce"],
      ...LABOUR_CODE_SUCCESSION,
    }),
    { spellings: ["CSP", "C. s. p."], identifier: SVK.civilDisputes.work },
    { spellings: ["CMP", "C. m. p."], identifier: zz(161, 2015) },
    { spellings: ["SSP", "S. s. p."], identifier: zz(162, 2015) },
    {
      spellings: ["Ústava", "Ústavy", "Ústave", "Ústavou"],
      identifier: zb(460, 1992),
      unit: "article",
    },
    { spellings: ["EP", "Exekučný poriadok"], identifier: zz(233, 1995) },
    { spellings: ["ZKR"], identifier: zz(7, 2005) },
    {
      spellings: ["SP", "správny poriadok"],
      identifier: SVK.administrativeProcedure.work,
    },
  ],

  titles: [
    ...succession({
      spellings: ["Trestný zákon", "Trestného zákona", "Trestnom zákone"],
      ...CRIMINAL_CODE_SUCCESSION,
    }),
    ...succession({
      spellings: [
        "Trestný poriadok",
        "Trestného poriadku",
        "Trestnom poriadku",
      ],
      ...CRIMINAL_PROCEDURE_SUCCESSION,
    }),
    // 141/1950 Zb. took effect on 1 January 1951; 40/1964 Zb. replaced it on
    // 1 April 1964.
    ...priorWindowed({
      spellings: [
        "Občiansky zákonník",
        "Občianskeho zákonníka",
        "Občianskom zákonníku",
      ],
      older: zb(141, 1950),
      olderFrom: "1951-01-01",
      newer: SVK.civilCode.work,
      on: "1964-04-01",
    }),
    {
      spellings: [
        "Stredný občiansky zákonník",
        "Stredného občianskeho zákonníka",
        "Strednom občianskom zákonníku",
      ],
      identifier: zb(141, 1950),
    },
    {
      spellings: [
        "Obchodný zákonník",
        "Obchodného zákonníka",
        "Obchodnom zákonníku",
      ],
      identifier: SVK.commercialCode.work,
    },
    ...succession({
      spellings: ["Zákonník práce", "Zákonníka práce", "Zákonníku práce"],
      ...LABOUR_CODE_SUCCESSION,
    }),
    {
      spellings: [
        "Civilný sporový poriadok",
        "Civilného sporového poriadku",
        "Civilnom sporovom poriadku",
      ],
      identifier: SVK.civilDisputes.work,
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
      olderFrom: "1956-10-01",
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
