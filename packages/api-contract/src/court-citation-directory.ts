import { panic } from "better-result";

import {
  CZ_ECLI_COURT_REGISTRY,
  EU_ECLI_COURT_REGISTRY,
  type RegisteredCourt,
  SK_ECLI_COURT_REGISTRY,
} from "./case-law-courts";

/**
 * Every court a citation can name, per country, in the form the alias
 * generator (`court-citation-aliases.ts`) derives citation spellings from.
 *
 * The ECLI registry (`case-law-courts.ts`) lists the courts ingestion maps
 * ECLI codes onto, which is not every court: a Czech citation names any of
 * the 86 district-level courts, and a court the reader cannot name cannot
 * constrain a citation. This directory is that complete list. It adds no
 * ingestion behaviour: the registry stays the only source of the court a
 * decision is stored under.
 *
 * An ECLI court code is listed only where it is recorded (the registry's, and
 * codes observed on published decisions); a code the directory does not know
 * still constrains a citation, compared against the decision's own ECLI.
 */

/** A court's seat as a citation writes it. */
export type CourtSeat = {
  /** The seat in the nominative: `Benešov`, `České Budějovice`. */
  nominative: string;
  /**
   * The seat after its preposition, as the official name writes it:
   * `v Benešově`, `ve Zlíně`, `pro Prahu 6`. Absent where the name carries
   * the nominative itself (`Okresní soud Plzeň-město`).
   */
  prepositional?: { preposition: string; form: string } | undefined;
};

export type DirectoryCourt = {
  /** The official name, the spelling the corpus stores it under. */
  name: string;
  /** The head phrase the name opens with, a key of the language's heads. */
  head: string;
  seat?: CourtSeat | undefined;
  /** A regional court's branch: `pobočka v Táboře`. */
  branch?: CourtSeat | undefined;
  /** Prague's district courts are numbered: `Obvodní soud pro Prahu 6`. */
  pragueDistrict?: number | undefined;
  /** A seat's short code a citation writes after the court's (`KS BA`). */
  seatCode?: string | undefined;
  ecliCodes: readonly string[];
  /** Fixed citation spellings the generator does not derive. */
  extraAliases?: readonly string[] | undefined;
};

/**
 * A court-name head: the adjectives and noun the official name opens with,
 * declined through the cases a citation writes them in, and the short code
 * that stands for them.
 */
export type CourtHead = {
  /** Every case form of the head phrase, nominative first. */
  forms: readonly [string, ...string[]];
  /** The short codes written for the head (`OS`, `KS`, `ÚS`). */
  codes: readonly string[];
  /** Working English names, for apex courts only. */
  english?: readonly string[] | undefined;
};

/** Czech adjective in nominative, genitive, dative, locative, instrumental. */
const czechAdjective = (nominative: string): readonly string[] => {
  const stem = nominative.slice(0, -1);
  if (nominative.endsWith("ý")) {
    return [nominative, `${stem}ého`, `${stem}ému`, `${stem}ém`, `${stem}ým`];
  }
  if (nominative.endsWith("í")) {
    return [nominative, `${stem}ího`, `${stem}ímu`, `${stem}ím`, `${stem}ím`];
  }
  return panic(`Not a Czech adjective head: ${nominative}`);
};

/** Slovak adjective in nominative, genitive, dative, locative, instrumental. */
const slovakAdjective = (nominative: string): readonly string[] => {
  const stem = nominative.slice(0, -1);
  if (nominative.endsWith("ý")) {
    return [nominative, `${stem}ého`, `${stem}ému`, `${stem}om`, `${stem}ým`];
  }
  // Shortened after a long syllable: `správny`, `správneho`.
  if (nominative.endsWith("y")) {
    return [nominative, `${stem}eho`, `${stem}emu`, `${stem}om`, `${stem}ym`];
  }
  if (nominative.endsWith("í")) {
    return [nominative, `${stem}ieho`, `${stem}iemu`, `${stem}om`, `${stem}ím`];
  }
  return panic(`Not a Slovak adjective head: ${nominative}`);
};

const CZECH_COURT_NOUN = ["soud", "soudu", "soudu", "soudu", "soudem"];
const SLOVAK_COURT_NOUN = ["súd", "súdu", "súdu", "súde", "súdom"];

/** A head phrase of adjectives and a noun, declined case by case. */
const declinedHead = (
  adjectives: readonly string[],
  decline: (adjective: string) => readonly string[],
  noun: readonly string[],
): readonly [string, ...string[]] => {
  const declined = adjectives.map(decline);
  const forms = noun.map((nounForm, index) =>
    [...declined.map((cases) => cases[index] ?? ""), nounForm].join(" "),
  );
  const [first, ...rest] = [...new Set(forms)];
  return first === undefined ? panic("A head without forms") : [first, ...rest];
};

const czechHead = (
  adjectives: readonly string[],
  codes: readonly string[],
  english?: readonly string[],
): CourtHead => ({
  forms: declinedHead(adjectives, czechAdjective, CZECH_COURT_NOUN),
  codes,
  english,
});

const slovakHead = (
  adjectives: readonly string[],
  codes: readonly string[],
  english?: readonly string[],
): CourtHead => ({
  forms: declinedHead(adjectives, slovakAdjective, SLOVAK_COURT_NOUN),
  codes,
  english,
});

/**
 * The court-name heads per country. A head's nominative is how the official
 * name opens; the other forms are how a citation declines it ("rozsudkem
 * Krajského soudu v Brně"). Polish heads list nominative and genitive, the
 * cases a Polish citation writes a court in.
 */
export const COURT_HEADS = {
  CZE: {
    US: czechHead(["Ústavní"], ["ÚS"], ["Constitutional Court"]),
    NSS: czechHead(
      ["Nejvyšší", "správní"],
      ["NSS"],
      ["Supreme Administrative Court"],
    ),
    NS: czechHead(["Nejvyšší"], ["NS"], ["Supreme Court"]),
    VS: czechHead(["Vrchní"], ["VS"]),
    KS: czechHead(["Krajský"], ["KS"]),
    MS: czechHead(["Městský"], ["MS"]),
    OS: czechHead(["Okresní"], ["OS"]),
    ObvS: czechHead(["Obvodní"], ["OS", "ObvS"]),
  },
  SVK: {
    US: slovakHead(["Ústavný"], ["ÚS"], ["Constitutional Court"]),
    NSS: slovakHead(
      ["Najvyšší", "správny"],
      ["NSS"],
      ["Supreme Administrative Court"],
    ),
    NS: slovakHead(["Najvyšší"], ["NS"], ["Supreme Court"]),
    KS: slovakHead(["Krajský"], ["KS"]),
    MS: slovakHead(["Mestský"], ["MS"]),
    OS: slovakHead(["Okresný"], ["OS"]),
    SpS: slovakHead(["Správny"], ["SpS"]),
    STS: slovakHead(["Špecializovaný", "trestný"], ["ŠTS"]),
  },
  POL: {
    TK: {
      forms: ["Trybunał Konstytucyjny", "Trybunału Konstytucyjnego"],
      codes: ["TK"],
      english: ["Constitutional Tribunal", "Constitutional Court"],
    },
    NSA: {
      forms: [
        "Naczelny Sąd Administracyjny",
        "Naczelnego Sądu Administracyjnego",
      ],
      codes: ["NSA"],
      english: ["Supreme Administrative Court"],
    },
    SN: {
      forms: ["Sąd Najwyższy", "Sądu Najwyższego"],
      codes: ["SN"],
      english: ["Supreme Court"],
    },
    WSA: {
      forms: [
        "Wojewódzki Sąd Administracyjny",
        "Wojewódzkiego Sądu Administracyjnego",
      ],
      codes: ["WSA"],
    },
    SA: { forms: ["Sąd Apelacyjny", "Sądu Apelacyjnego"], codes: ["SA"] },
    SO: { forms: ["Sąd Okręgowy", "Sądu Okręgowego"], codes: ["SO"] },
    SR: { forms: ["Sąd Rejonowy", "Sądu Rejonowego"], codes: ["SR"] },
  },
  HUN: {
    AB: {
      forms: ["Alkotmánybíróság"],
      codes: ["AB"],
      english: ["Constitutional Court"],
    },
    Kuria: { forms: ["Kúria"], codes: [], english: ["Curia", "Supreme Court"] },
    LB: { forms: ["Legfelsőbb Bíróság"], codes: ["LB"] },
  },
  EU: {},
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, CourtHead>>>
>;

export type CourtDirectoryCountry = keyof typeof COURT_HEADS;

export const isCourtDirectoryCountry = (
  country: string,
): country is CourtDirectoryCountry => Object.hasOwn(COURT_HEADS, country);

/**
 * What an apex court's name may carry after its head: the country it
 * belongs to (`Nejvyšší soud ČR`, `Najvyšší súd Slovenskej republiky`).
 */
export const APEX_COUNTRY_SUFFIXES = {
  CZE: ["", "ČR", "České republiky"],
  SVK: ["", "SR", "Slovenskej republiky"],
  POL: [""],
  HUN: [""],
  EU: [""],
} as const satisfies Record<CourtDirectoryCountry, readonly string[]>;

/** English country phrases an apex court's working English name carries. */
export const APEX_ENGLISH_SUFFIXES = {
  CZE: ["", "of the Czech Republic"],
  SVK: ["", "of the Slovak Republic"],
  POL: ["", "of Poland"],
  HUN: ["", "of Hungary"],
  EU: [""],
} as const satisfies Record<CourtDirectoryCountry, readonly string[]>;

const seatIn = (
  nominative: string,
  form: string,
  preposition = "v",
): CourtSeat => ({ nominative, prepositional: { preposition, form } });

const registryCodesByName = (
  registry: Readonly<Record<string, RegisteredCourt>>,
): ReadonlyMap<string, string[]> => {
  const byName = new Map<string, string[]>();
  for (const [code, { name }] of Object.entries(registry)) {
    byName.set(name, [...(byName.get(name) ?? []), code]);
  }
  return byName;
};

const czRegistryCodes = registryCodesByName(CZ_ECLI_COURT_REGISTRY);

/**
 * A Czech court whose name is its head followed by its seat. Codes the ECLI
 * registry records for the same name are added, so the two never disagree.
 */
const czCourt = (
  head: keyof (typeof COURT_HEADS)["CZE"],
  seat: CourtSeat | undefined,
  ecliCodes: readonly string[] = [],
  branch?: CourtSeat,
): DirectoryCourt => {
  const [nominativeHead] = COURT_HEADS.CZE[head].forms;
  const seatText =
    seat === undefined
      ? ""
      : ` ${
          seat.prepositional === undefined
            ? seat.nominative
            : `${seat.prepositional.preposition} ${seat.prepositional.form}`
        }`;
  const branchSeat = branch === undefined ? undefined : branch.prepositional;
  const branchText =
    branchSeat === undefined
      ? ""
      : ` – pobočka ${branchSeat.preposition} ${branchSeat.form}`;
  const name = `${nominativeHead}${seatText}${branchText}`;
  return {
    name,
    head,
    seat,
    branch,
    ecliCodes: [
      ...new Set([...ecliCodes, ...(czRegistryCodes.get(name) ?? [])]),
    ],
  };
};

const district = (
  nominative: string,
  form: string,
  preposition = "v",
  ecliCodes: readonly string[] = [],
): DirectoryCourt =>
  czCourt("OS", seatIn(nominative, form, preposition), ecliCodes);

const districtBare = (nominative: string): DirectoryCourt =>
  czCourt("OS", { nominative });

const prague = (number: number): DirectoryCourt => ({
  name: `Obvodní soud pro Prahu ${String(number)}`,
  head: "ObvS",
  seat: seatIn(`Praha ${String(number)}`, `Prahu ${String(number)}`, "pro"),
  pragueDistrict: number,
  // Observed on published decisions: `ECLI:CZ:OSPH06:…`, `ECLI:CZ:OSPH10:…`.
  ecliCodes: [`OSPH${String(number).padStart(2, "0")}`],
});

const regional = (
  nominative: string,
  form: string,
  branch?: CourtSeat,
): DirectoryCourt => czCourt("KS", seatIn(nominative, form), [], branch);

/**
 * The Czech courts (zákon č. 6/2002 Sb., o soudech a soudcích, přílohy 1–3):
 * the apex courts, both high courts, the regional courts and their branches,
 * the Municipal Court in Prague, and the 86 district-level courts.
 */
const CZE_COURTS: readonly DirectoryCourt[] = [
  czCourt("US", undefined),
  czCourt("NS", undefined),
  czCourt("NSS", undefined),
  czCourt("VS", seatIn("Praha", "Praze")),
  czCourt("VS", seatIn("Olomouc", "Olomouci")),
  czCourt("MS", seatIn("Praha", "Praze")),
  regional("Praha", "Praze"),
  regional("České Budějovice", "Českých Budějovicích"),
  regional(
    "České Budějovice",
    "Českých Budějovicích",
    seatIn("Tábor", "Táboře"),
  ),
  regional("Plzeň", "Plzni"),
  regional("Plzeň", "Plzni", seatIn("Karlovy Vary", "Karlových Varech")),
  regional("Ústí nad Labem", "Ústí nad Labem"),
  regional("Ústí nad Labem", "Ústí nad Labem", seatIn("Liberec", "Liberci")),
  regional("Hradec Králové", "Hradci Králové"),
  regional(
    "Hradec Králové",
    "Hradci Králové",
    seatIn("Pardubice", "Pardubicích"),
  ),
  regional("Brno", "Brně"),
  regional("Brno", "Brně", seatIn("Zlín", "Zlíně", "ve")),
  regional("Brno", "Brně", seatIn("Jihlava", "Jihlavě")),
  regional("Ostrava", "Ostravě"),
  regional("Ostrava", "Ostravě", seatIn("Olomouc", "Olomouci")),
  // Prague's ten district courts.
  ...Array.from({ length: 10 }, (_, index) => prague(index + 1)),
  // Krajský soud v Praze.
  district("Benešov", "Benešově", "v", ["OSBN"]),
  district("Beroun", "Berouně"),
  district("Kladno", "Kladně"),
  district("Kolín", "Kolíně"),
  district("Kutná Hora", "Kutné Hoře"),
  district("Mělník", "Mělníku"),
  district("Mladá Boleslav", "Mladé Boleslavi"),
  district("Nymburk", "Nymburce"),
  districtBare("Praha-východ"),
  districtBare("Praha-západ"),
  district("Příbram", "Příbrami"),
  district("Rakovník", "Rakovníku"),
  // Krajský soud v Českých Budějovicích.
  district("České Budějovice", "Českých Budějovicích"),
  district("Český Krumlov", "Českém Krumlově"),
  district("Jindřichův Hradec", "Jindřichově Hradci"),
  district("Pelhřimov", "Pelhřimově"),
  district("Písek", "Písku"),
  district("Prachatice", "Prachaticích"),
  district("Strakonice", "Strakonicích", "ve"),
  district("Tábor", "Táboře"),
  // Krajský soud v Plzni.
  district("Domažlice", "Domažlicích"),
  district("Cheb", "Chebu"),
  district("Karlovy Vary", "Karlových Varech"),
  district("Klatovy", "Klatovech"),
  districtBare("Plzeň-jih"),
  districtBare("Plzeň-město"),
  districtBare("Plzeň-sever"),
  district("Rokycany", "Rokycanech"),
  district("Sokolov", "Sokolově"),
  district("Tachov", "Tachově"),
  // Krajský soud v Ústí nad Labem.
  district("Česká Lípa", "České Lípě"),
  district("Děčín", "Děčíně"),
  district("Chomutov", "Chomutově"),
  district("Jablonec nad Nisou", "Jablonci nad Nisou"),
  district("Liberec", "Liberci"),
  district("Litoměřice", "Litoměřicích"),
  district("Louny", "Lounech"),
  district("Most", "Mostě"),
  district("Teplice", "Teplicích"),
  district("Ústí nad Labem", "Ústí nad Labem"),
  // Krajský soud v Hradci Králové.
  district("Havlíčkův Brod", "Havlíčkově Brodě"),
  district("Hradec Králové", "Hradci Králové"),
  district("Chrudim", "Chrudimi"),
  district("Jičín", "Jičíně"),
  district("Náchod", "Náchodě"),
  district("Pardubice", "Pardubicích"),
  district("Rychnov nad Kněžnou", "Rychnově nad Kněžnou"),
  district("Semily", "Semilech"),
  district("Svitavy", "Svitavách", "ve"),
  district("Trutnov", "Trutnově"),
  district("Ústí nad Orlicí", "Ústí nad Orlicí"),
  // Krajský soud v Brně.
  czCourt("MS", seatIn("Brno", "Brně")),
  district("Blansko", "Blansku"),
  districtBare("Brno-venkov"),
  district("Břeclav", "Břeclavi"),
  district("Hodonín", "Hodoníně"),
  district("Jihlava", "Jihlavě"),
  district("Kroměříž", "Kroměříži"),
  district("Prostějov", "Prostějově"),
  district("Třebíč", "Třebíči"),
  district("Uherské Hradiště", "Uherském Hradišti"),
  district("Vyškov", "Vyškově", "ve"),
  district("Zlín", "Zlíně", "ve"),
  district("Znojmo", "Znojmě", "ve"),
  district("Žďár nad Sázavou", "Žďáru nad Sázavou", "ve"),
  // Krajský soud v Ostravě.
  district("Bruntál", "Bruntále"),
  district("Frýdek-Místek", "Frýdku-Místku", "ve"),
  district("Jeseník", "Jeseníku"),
  district("Karviná", "Karviné"),
  district("Nový Jičín", "Novém Jičíně"),
  district("Olomouc", "Olomouci"),
  district("Opava", "Opavě"),
  district("Ostrava", "Ostravě"),
  district("Přerov", "Přerově"),
  district("Šumperk", "Šumperku"),
  district("Vsetín", "Vsetíně", "ve"),
];

/** Slovak seats a registry name writes in the locative, in the nominative. */
const SLOVAK_SEAT_NOMINATIVES: Readonly<Record<string, string>> = {
  Bratislave: "Bratislava",
  "Banskej Bystrici": "Banská Bystrica",
  Košiciach: "Košice",
  Nitre: "Nitra",
  Prešove: "Prešov",
  Trenčíne: "Trenčín",
  Trnave: "Trnava",
  Žiline: "Žilina",
};

/** The head a Slovak registry name opens with; longest first. */
const slovakHeadOf = (name: string): readonly [string, CourtHead] => {
  const heads = Object.entries<CourtHead>(COURT_HEADS.SVK).toSorted(
    ([, left], [, right]) => right.forms[0].length - left.forms[0].length,
  );
  return (
    heads.find(
      ([, { forms }]) => name === forms[0] || name.startsWith(`${forms[0]} `),
    ) ?? panic(`Slovak registry court without a known head: ${name}`)
  );
};

/**
 * The Slovak courts, read off the ECLI registry: the head the name opens
 * with, and the seat after it (`v Bratislave` or a bare `Bratislava I`).
 */
const SVK_COURTS: readonly DirectoryCourt[] = Object.entries(
  SK_ECLI_COURT_REGISTRY,
).map(([code, { name }]) => {
  const [head, { forms }] = slovakHeadOf(name);
  const rest = name.slice(forms[0].length).trim();
  const apex = APEX_COUNTRY_SUFFIXES.SVK.some((suffix) => suffix === rest);
  if (apex) {
    return { name, head, ecliCodes: [code] };
  }
  const located = /^v\s+(?<form>.+)$/u.exec(rest)?.groups?.["form"];
  const seat: CourtSeat =
    located === undefined
      ? { nominative: rest }
      : seatIn(
          SLOVAK_SEAT_NOMINATIVES[located] ??
            panic(`Slovak seat without a nominative: ${located}`),
          located,
        );
  // A regional or administrative court's seat code (`KSBA` → `BA`), the way
  // Slovak citations abbreviate it (`KS BA`).
  const seatCode =
    head === "KS" || head === "SpS" ? code.slice(head.length) : undefined;
  return { name, head, seat, seatCode, ecliCodes: [code] };
});

const EU_COURTS: readonly DirectoryCourt[] = [
  {
    name: EU_ECLI_COURT_REGISTRY.C.name,
    head: "CJ",
    ecliCodes: ["C"],
    extraAliases: [
      "Court of Justice of the European Union",
      "Court of Justice of the EU",
      "European Court of Justice",
      "CJEU",
      "ECJ",
      "SDEU",
      "Soudní dvůr",
      "Soudní dvůr Evropské unie",
      "Súdny dvor",
      "Súdny dvor Európskej únie",
    ],
  },
  {
    name: EU_ECLI_COURT_REGISTRY.T.name,
    head: "GC",
    ecliCodes: ["T"],
    extraAliases: [
      "General Court of the European Union",
      "Court of First Instance",
      "Tribunál",
      "Tribunál Evropské unie",
      "Všeobecný súd",
    ],
  },
];

/**
 * The directory per country. Poland and Hungary have none yet: their courts
 * are read from the names decisions are stored under, through the heads.
 */
export const COURT_DIRECTORY = {
  CZE: CZE_COURTS,
  SVK: SVK_COURTS,
  POL: [],
  HUN: [],
  EU: EU_COURTS,
} as const satisfies Record<CourtDirectoryCountry, readonly DirectoryCourt[]>;

/** The ECLI jurisdiction segment a country's decisions carry. */
export const ECLI_JURISDICTION_OF_COUNTRY = {
  CZE: "CZ",
  SVK: "SK",
  POL: "PL",
  HUN: "HU",
  EU: "EU",
} as const satisfies Record<CourtDirectoryCountry, string>;

/**
 * The prefixes a country's ECLI court codes open with for a court family
 * whose code appends a seat (`OSBN`, `KSPH`). A word of that shape in a
 * citation names a court by code even where the directory lacks the code.
 */
export const ECLI_FAMILY_CODE_PREFIXES = {
  CZE: ["KS", "MS", "OS", "VS"],
  SVK: ["KS", "MS", "OS", "SpS"],
  POL: ["WSA", "SA", "SO", "SR"],
  HUN: [],
  EU: [],
} as const satisfies Record<CourtDirectoryCountry, readonly string[]>;
