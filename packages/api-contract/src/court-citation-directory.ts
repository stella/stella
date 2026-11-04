import { panic } from "better-result";

import {
  CZ_ECLI_COURT_REGISTRY,
  EU_ECLI_COURT_REGISTRY,
  type RegisteredCourt,
  SK_ECLI_COURT_REGISTRY,
} from "./case-law-courts";
import type { PublicCountry } from "./public-country-capability";

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
 * A Hungarian name with its case suffixes; `drop` letters come off before a
 * suffix that lengthens the final vowel (`Kúria` → `Kúriának`).
 */
const hungarianForms = (
  name: string,
  suffixes: readonly string[],
  drop = 0,
): readonly [string, ...string[]] => [
  name,
  ...suffixes.map((suffix) => `${name.slice(0, name.length - drop)}${suffix}`),
];

/**
 * The court-name heads per country. A head's nominative is how the official
 * name opens; the other forms are how a citation declines it ("rozsudkem
 * Krajského soudu v Brně"). Polish heads list nominative and genitive, the
 * cases a Polish citation writes a court in.
 */
const COURT_HEADS = {
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
  // Hungarian declines by suffix: nominative, dative, superessive (`a
  // Kúrián`, at the Curia) and accusative.
  HUN: {
    AB: {
      forms: hungarianForms("Alkotmánybíróság", ["nak", "on", "ot"]),
      codes: ["AB"],
      english: ["Constitutional Court"],
    },
    Kuria: {
      forms: hungarianForms("Kúria", ["ának", "án", "át"], 1),
      codes: [],
      english: ["Curia", "Supreme Court"],
    },
    LB: {
      forms: hungarianForms("Legfelsőbb Bíróság", ["nak", "on", "ot"]),
      codes: ["LB"],
    },
  },
  EU: {},
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, CourtHead>>>
>;

type CourtDirectoryCountry = keyof typeof COURT_HEADS;

/**
 * What an apex court's name may carry after its head: the country it
 * belongs to (`Nejvyšší soud ČR`, `Najvyšší súd Slovenskej republiky`).
 */
const APEX_COUNTRY_SUFFIXES = {
  CZE: ["", "ČR", "České republiky"],
  SVK: ["", "SR", "Slovenskej republiky"],
  POL: [""],
  HUN: [""],
  EU: [""],
} as const satisfies Record<CourtDirectoryCountry, readonly string[]>;

/** English country phrases an apex court's working English name carries. */
const APEX_ENGLISH_SUFFIXES = {
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
  // Observed on each court's published decisions (`ECLI:CZ:OSPH06:…`).
  ecliCodes: [`OSPH${String(number).padStart(2, "0")}`],
});

const regional = (
  nominative: string,
  form: string,
  branch?: CourtSeat,
): DirectoryCourt => czCourt("KS", seatIn(nominative, form), [], branch);

/**
 * District courts' ECLI codes, each read off that court's own published
 * decisions (a decision stored under the court's name whose ECLI names it),
 * not derived from a pattern. The Plzeň regional court's Karlovy Vary branch
 * has no observed code: no decision is stored under the branch's name. The
 * Brno branch in Jihlava publishes under the main court's `KSBR` (its stored
 * decisions carry `ECLI:CZ:KSBR:…`), which therefore stays the main court's.
 */
const CZ_OBSERVED_ECLI_CODES: Readonly<Record<string, string>> = {
  "Okresní soud v Benešově": "OSBN",
  "Okresní soud v Berouně": "OSBR",
  "Okresní soud v Kladně": "OSKD",
  "Okresní soud v Kolíně": "OSKO",
  "Okresní soud v Kutné Hoře": "OSKH",
  "Okresní soud v Mělníku": "OSME",
  "Okresní soud v Mladé Boleslavi": "OSMB",
  "Okresní soud v Nymburce": "OSNB",
  "Okresní soud Praha-východ": "OSPY",
  "Okresní soud Praha-západ": "OSPZ",
  "Okresní soud v Příbrami": "OSPB",
  "Okresní soud v Rakovníku": "OSRA",
  "Okresní soud v Českých Budějovicích": "OSCB",
  "Okresní soud v Jindřichově Hradci": "OSJH",
  "Okresní soud v Pelhřimově": "OSPE",
  "Okresní soud v Písku": "OSPI",
  "Okresní soud v Prachaticích": "OSPT",
  "Okresní soud ve Strakonicích": "OSST",
  "Okresní soud v Táboře": "OSTA",
  "Okresní soud v Domažlicích": "OSDO",
  "Okresní soud v Chebu": "OSCH",
  "Okresní soud v Karlových Varech": "OSKV",
  "Okresní soud v Klatovech": "OSKT",
  "Okresní soud Plzeň-jih": "OSPJ",
  "Okresní soud Plzeň-město": "OSPM",
  "Okresní soud Plzeň-sever": "OSPS",
  "Okresní soud v Rokycanech": "OSRO",
  "Okresní soud v Sokolově": "OSSO",
  "Okresní soud v Tachově": "OSTC",
  "Okresní soud v České Lípě": "OSCL",
  "Okresní soud v Děčíně": "OSDC",
  "Okresní soud v Chomutově": "OSCV",
  "Okresní soud v Jablonci nad Nisou": "OSJN",
  "Okresní soud v Liberci": "OSLI",
  "Okresní soud v Litoměřicích": "OSLT",
  "Okresní soud v Lounech": "OSLN",
  "Okresní soud v Mostě": "OSMO",
  "Okresní soud v Teplicích": "OSTP",
  "Okresní soud v Ústí nad Labem": "OSUL",
  "Okresní soud v Havlíčkově Brodě": "OSHB",
  "Okresní soud v Hradci Králové": "OSHK",
  "Okresní soud v Chrudimi": "OSCR",
  "Okresní soud v Jičíně": "OSJC",
  "Okresní soud v Náchodě": "OSNA",
  "Okresní soud v Pardubicích": "OSPU",
  "Okresní soud v Rychnově nad Kněžnou": "OSRK",
  "Okresní soud v Semilech": "OSSM",
  "Okresní soud ve Svitavách": "OSSY",
  "Okresní soud v Trutnově": "OSTU",
  "Okresní soud v Ústí nad Orlicí": "OSUO",
  "Okresní soud v Blansku": "OSBK",
  "Okresní soud Brno-venkov": "OSBI",
  "Okresní soud v Břeclavi": "OSBV",
  "Okresní soud v Hodoníně": "OSHO",
  "Okresní soud v Jihlavě": "OSJI",
  "Okresní soud v Kroměříži": "OSKM",
  "Okresní soud v Prostějově": "OSPV",
  "Okresní soud v Třebíči": "OSTR",
  "Okresní soud v Uherském Hradišti": "OSUH",
  "Okresní soud ve Vyškově": "OSVY",
  "Okresní soud ve Zlíně": "OSZL",
  "Okresní soud ve Znojmě": "OSZN",
  "Okresní soud v Bruntále": "OSBU",
  "Okresní soud ve Frýdku-Místku": "OSFM",
  "Okresní soud v Jeseníku": "OSJE",
  "Okresní soud v Karviné": "OSKI",
  "Okresní soud v Novém Jičíně": "OSNJ",
  "Okresní soud v Olomouci": "OSOL",
  "Okresní soud v Opavě": "OSOP",
  "Okresní soud v Přerově": "OSPR",
  "Okresní soud v Šumperku": "OSSU",
  "Okresní soud ve Vsetíně": "OSVS",
};

const czObservedEcliCodes: ReadonlyMap<string, string> = new Map(
  Object.entries(CZ_OBSERVED_ECLI_CODES),
);

const withObservedCode = (court: DirectoryCourt): DirectoryCourt => {
  const observed = czObservedEcliCodes.get(court.name);
  return observed === undefined
    ? court
    : { ...court, ecliCodes: [...new Set([...court.ecliCodes, observed])] };
};

/**
 * The Czech courts (zákon č. 6/2002 Sb., o soudech a soudcích, přílohy 1–3):
 * the apex courts, both high courts, the regional courts and their branches,
 * the Municipal Court in Prague, and the 86 district-level courts.
 */
const CZE_COURTS: readonly DirectoryCourt[] = (
  [
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
    district("Benešov", "Benešově"),
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
  ] satisfies DirectoryCourt[]
).map(withObservedCode);

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
 * Slovak courts the ECLI registry does not list, each read off its own
 * published decisions: stored under this name, with an ECLI naming this code
 * (`ECLI:SK:OSBA2:2019:…`).
 */
const SK_OBSERVED_COURTS: Readonly<Record<string, string>> = {
  OSBA2: "Okresný súd Bratislava II",
  OSBA3: "Okresný súd Bratislava III",
  OSBA4: "Okresný súd Bratislava IV",
};

/**
 * The Slovak courts, read off the ECLI registry and the observed courts: the
 * head the name opens with, and the seat after it (`v Bratislave` or a bare
 * `Bratislava I`).
 */
const SVK_COURTS: readonly DirectoryCourt[] = [
  ...Object.entries(SK_ECLI_COURT_REGISTRY).map(
    ([code, { name }]) => [code, name] as const,
  ),
  ...Object.entries(SK_OBSERVED_COURTS),
].map(([code, name]) => {
  const [head, { forms }] = slovakHeadOf(name);
  const rest = name.slice(forms[0].length).trim();
  const apex = APEX_COUNTRY_SUFFIXES.SVK.some((suffix) => suffix === rest);
  if (apex) {
    return { name, head, ecliCodes: [code] };
  }
  const located = rest.startsWith("v ") ? rest.slice(2).trim() : undefined;
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

/** A Polish court seated in a city, by its nominative and locative. */
const polishCourt = (
  head: "SA" | "WSA",
  nominative: string,
  form: string,
  preposition = "w",
): DirectoryCourt => ({
  name: `${COURT_HEADS.POL[head].forms[0]} ${preposition} ${form}`,
  head,
  seat: seatIn(nominative, form, preposition),
  ecliCodes: [],
});

/**
 * The seats of the Polish regional and district courts, as their names write
 * them after `w` or `we`, with the nominative a citation writes them in
 * (`SR Gdynia`, `SO Kraków`).
 */
const POL_SEAT_NOMINATIVES: Readonly<Record<string, string>> = {
  Białymstoku: "Białystok",
  "Bielsku Podlaskim": "Bielsk Podlaski",
  Sokółce: "Sokółka",
  Łomży: "Łomża",
  Zambrowie: "Zambrów",
  "Wysokiem Mazowieckiem": "Wysokie Mazowieckie",
  Grajewie: "Grajewo",
  Olsztynie: "Olsztyn",
  Bartoszycach: "Bartoszyce",
  Giżycku: "Giżycko",
  Kętrzynie: "Kętrzyn",
  Mrągowie: "Mrągowo",
  Szczytnie: "Szczytno",
  Piszu: "Pisz",
  Biskupcu: "Biskupiec",
  "Lidzbarku Warmińskim": "Lidzbark Warmiński",
  Nidzicy: "Nidzica",
  Suwałkach: "Suwałki",
  Augustowie: "Augustów",
  Ełku: "Ełk",
  Olecku: "Olecko",
  Ostrołęce: "Ostrołęka",
  "Ostrowi Mazowieckiej": "Ostrów Mazowiecka",
  Przasnyszu: "Przasnysz",
  Wyszkowie: "Wyszków",
  Pułtusku: "Pułtusk",
  Bydgoszczy: "Bydgoszcz",
  Inowrocławiu: "Inowrocław",
  Szubinie: "Szubin",
  Świeciu: "Świecie",
  "Nakle nad Notecią": "Nakło nad Notecią",
  Tucholi: "Tuchola",
  Mogilnie: "Mogilno",
  Żninie: "Żnin",
  Elblągu: "Elbląg",
  Braniewie: "Braniewo",
  Iławie: "Iława",
  Ostródzie: "Ostróda",
  Działdowie: "Działdowo",
  "Nowym Mieście Lubawskim": "Nowe Miasto Lubawskie",
  Gdańsku: "Gdańsk",
  Gdyni: "Gdynia",
  Kartuzach: "Kartuzy",
  Kwidzynie: "Kwidzyn",
  Malborku: "Malbork",
  Sopocie: "Sopot",
  "Starogardzie Gdańskim": "Starogard Gdański",
  Tczewie: "Tczew",
  Wejherowie: "Wejherowo",
  Kościerzynie: "Kościerzyna",
  Słupsku: "Słupsk",
  Chojnicach: "Chojnice",
  Człuchowie: "Człuchów",
  Lęborku: "Lębork",
  Bytowie: "Bytów",
  Miastku: "Miastko",
  Toruniu: "Toruń",
  Brodnicy: "Brodnica",
  Chełmnie: "Chełmno",
  Grudziądzu: "Grudziądz",
  "Golubiu-Dobrzyniu": "Golub-Dobrzyń",
  Wąbrzeźnie: "Wąbrzeźno",
  Włocławku: "Włocławek",
  "Aleksandrowie Kujawskim": "Aleksandrów Kujawski",
  Lipnie: "Lipno",
  Radziejowie: "Radziejów",
  Rypinie: "Rypin",
  "Bielsku-Białej": "Bielsko-Biała",
  Cieszynie: "Cieszyn",
  Żywcu: "Żywiec",
  Częstochowie: "Częstochowa",
  Lublińcu: "Lubliniec",
  Myszkowie: "Myszków",
  Zawierciu: "Zawiercie",
  Gliwicach: "Gliwice",
  "Jastrzębiu-Zdroju": "Jastrzębie-Zdrój",
  Raciborzu: "Racibórz",
  "Rudzie Śląskiej": "Ruda Śląska",
  Rybniku: "Rybnik",
  "Tarnowskich Górach": "Tarnowskie Góry",
  "Wodzisławiu Śląśkim": "Wodzisław Śląski",
  Zabrzu: "Zabrze",
  Żorach: "Żory",
  Katowicach: "Katowice",
  Będzinie: "Będzin",
  Bytomiu: "Bytom",
  Chorzowie: "Chorzów",
  "Dąbrowie Górniczej": "Dąbrowa Górnicza",
  Jaworznie: "Jaworzno",
  Mikołowie: "Mikołów",
  Mysłowicach: "Mysłowice",
  Pszczynie: "Pszczyna",
  "Siemianowicach Śląskich": "Siemianowice Śląskie",
  Sosnowcu: "Sosnowiec",
  Tychach: "Tychy",
  Czeladzi: "Czeladź",
  Kielcach: "Kielce",
  "Busku-Zdroju": "Busko-Zdrój",
  Jędrzejowie: "Jędrzejów",
  Końskich: "Końskie",
  "Ostrowcu Świętokrzyskim": "Ostrowiec Świętokrzyski",
  Sandomierzu: "Sandomierz",
  "Skarżysku-Kamiennej": "Skarżysko-Kamienna",
  Starachowicach: "Starachowice",
  Opatowie: "Opatów",
  Staszowie: "Staszów",
  Pińczowie: "Pińczów",
  Włoszczowie: "Włoszczowa",
  Krakowie: "Kraków",
  Chrzanowie: "Chrzanów",
  Myślenicach: "Myślenice",
  Olkuszu: "Olkusz",
  Oświęcimiu: "Oświęcim",
  Wadowicach: "Wadowice",
  Wieliczce: "Wieliczka",
  "Suchej Beskidzkiej": "Sucha Beskidzka",
  Miechowie: "Miechów",
  "Nowym Sączu": "Nowy Sącz",
  Gorlicach: "Gorlice",
  Limanowej: "Limanowa",
  "Nowym Targu": "Nowy Targ",
  Zakopanem: "Zakopane",
  Tarnowie: "Tarnów",
  Bochni: "Bochnia",
  Brzesku: "Brzesko",
  "Dąbrowie Tarnowskiej": "Dąbrowa Tarnowska",
  Kaliszu: "Kalisz",
  Jarocinie: "Jarocin",
  Kępnie: "Kępno",
  "Ostrowie Wielkopolskim": "Ostrów Wielkopolski",
  Krotoszynie: "Krotoszyn",
  Pleszewie: "Pleszew",
  Ostrzeszowie: "Ostrzeszów",
  Łodzi: "Łódź",
  Kutnie: "Kutno",
  Łowiczu: "Łowicz",
  Pabianicach: "Pabianice",
  Skierniewicach: "Skierniewice",
  Zgierzu: "Zgierz",
  Brzezinach: "Brzeziny",
  Łęczycy: "Łęczyca",
  "Rawie Mazowieckiej": "Rawa Mazowiecka",
  "Piotrkowie Trybunalskim": "Piotrków Trybunalski",
  Bełchatowie: "Bełchatów",
  Opocznie: "Opoczno",
  Radomsku: "Radomsko",
  "Tomaszowie Mazowieckim": "Tomaszów Mazowiecki",
  Sieradzu: "Sieradz",
  Łasku: "Łask",
  Wieluniu: "Wieluń",
  "Zduńskiej Woli": "Zduńska Wola",
  Płocku: "Płock",
  Ciechanowie: "Ciechanów",
  Gostyninie: "Gostynin",
  Mławie: "Mława",
  Płońsku: "Płońsk",
  Sochaczewie: "Sochaczew",
  Żyrardowie: "Żyrardów",
  Sierpcu: "Sierpc",
  Lublinie: "Lublin",
  "Białej Podlaskiej": "Biała Podlaska",
  Chełmie: "Chełm",
  Kraśniku: "Kraśnik",
  Lubartowie: "Lubartów",
  Łukowie: "Łuków",
  Puławach: "Puławy",
  "Radzyniu Podlaskim": "Radzyń Podlaski",
  "Opolu Lubelskim": "Opole Lubelskie",
  Rykach: "Ryki",
  Włodawie: "Włodawa",
  Radomiu: "Radom",
  Grójcu: "Grójec",
  Kozienicach: "Kozienice",
  Przysusze: "Przysucha",
  Zwoleniu: "Zwoleń",
  Lipsku: "Lipsko",
  Szydłowcu: "Szydłowiec",
  Siedlcach: "Siedlce",
  Garwolinie: "Garwolin",
  "Mińsku Mazowieckim": "Mińsk Mazowiecki",
  Węgrowie: "Węgrów",
  "Sokołowie Podlaskim": "Sokołów Podlaski",
  Zamościu: "Zamość",
  Biłgoraju: "Biłgoraj",
  Hrubieszowie: "Hrubieszów",
  "Tomaszowie Lubelskim": "Tomaszów Lubelski",
  Krasnymstawie: "Krasnystaw",
  "Janowie Lubelskim": "Janów Lubelski",
  Koninie: "Konin",
  Kole: "Koło",
  Turku: "Turek",
  Słupcy: "Słupca",
  Poznaniu: "Poznań",
  Gnieźnie: "Gniezno",
  "Grodzisku Wielkopolskim": "Grodzisk Wielkopolski",
  "Nowym Tomyślu": "Nowy Tomyśl",
  Wolsztynie: "Wolsztyn",
  Kościanie: "Kościan",
  Śremie: "Śrem",
  Lesznie: "Leszno",
  Gostyniu: "Gostyń",
  Rawiczu: "Rawicz",
  Pile: "Piła",
  Złotowie: "Złotów",
  Szamotułach: "Szamotuły",
  Obornikach: "Oborniki",
  "Środzie Wielkopolskiej": "Środa Wielkopolska",
  Wrześni: "Września",
  Trzciance: "Trzcianka",
  Wągrowcu: "Wągrowiec",
  Chodzieży: "Chodzież",
  "Zielonej Górze": "Zielona Góra",
  "Krośnie Odrzańskim": "Krosno Odrzańskie",
  "Nowej Soli": "Nowa Sól",
  Świebodzinie: "Świebodzin",
  Żaganiu: "Żagań",
  Żarach: "Żary",
  Wschowie: "Wschowa",
  Krośnie: "Krosno",
  Jaśle: "Jasło",
  Lesku: "Lesko",
  Sanoku: "Sanok",
  Brzozowie: "Brzozów",
  Rzeszowie: "Rzeszów",
  Dębicy: "Dębica",
  Łańcucie: "Łańcut",
  Leżajsku: "Leżajsk",
  Ropczycach: "Ropczyce",
  Strzyżowie: "Strzyżów",
  Tarnobrzegu: "Tarnobrzeg",
  Mielcu: "Mielec",
  "Stalowej Woli": "Stalowa Wola",
  Nisku: "Nisko",
  Kolbuszowej: "Kolbuszowa",
  Przemyślu: "Przemyśl",
  Jarosławiu: "Jarosław",
  Przeworsku: "Przeworsk",
  Lubaczowie: "Lubaczów",
  Warszawie: "Warszawa",
  "Grodzisku Mazowieckim": "Grodzisk Mazowiecki",
  Piasecznie: "Piaseczno",
  Pruszkowie: "Pruszków",
  Legionowie: "Legionowo",
  "Nowym Dworze Mazowieckim": "Nowy Dwór Mazowiecki",
  Otwocku: "Otwock",
  Wołominie: "Wołomin",
  "Jeleniej Górze": "Jelenia Góra",
  Bolesławcu: "Bolesławiec",
  Lubaniu: "Lubań",
  Zgorzelcu: "Zgorzelec",
  "Kamiennej Górze": "Kamienna Góra",
  "Lwówku Śląskim": "Lwówek Śląski",
  Legnicy: "Legnica",
  Głogowie: "Głogów",
  Lubinie: "Lubin",
  Złotoryi: "Złotoryja",
  Jaworze: "Jawor",
  Opolu: "Opole",
  Brzegu: "Brzeg",
  "Kędzierzynie Koźlu": "Kędzierzyn-Koźle",
  Kluczborku: "Kluczbork",
  Nysie: "Nysa",
  Prudniku: "Prudnik",
  "Strzelcach Opolskich": "Strzelce Opolskie",
  Oleśnie: "Olesno",
  Głubczycach: "Głubczyce",
  Świdnicy: "Świdnica",
  Dzierżoniowie: "Dzierżoniów",
  Kłodzku: "Kłodzko",
  Wałbrzychu: "Wałbrzych",
  "Ząbkowicach Śląskich": "Ząbkowice Śląskie",
  Wrocławiu: "Wrocław",
  Miliczu: "Milicz",
  Oleśnicy: "Oleśnica",
  Oławie: "Oława",
  Strzelinie: "Strzelin",
  "Środzie Śląskiej": "Środa Śląska",
  Trzebnicy: "Trzebnica",
  Wołowie: "Wołów",
  "Gorzowie Wielkopolskim": "Gorzów Wielkopolski",
  Międzyrzeczu: "Międzyrzecz",
  Słubicach: "Słubice",
  "Strzelcach Krajeńskich": "Strzelce Krajeńskie",
  Sulęcinie: "Sulęcin",
  Koszalinie: "Koszalin",
  Białogardzie: "Białogard",
  "Drawsku Pomorskim": "Drawsko Pomorskie",
  Kołobrzegu: "Kołobrzeg",
  Szczecinku: "Szczecinek",
  Wałczu: "Wałcz",
  Sławnie: "Sławno",
  Szczecinie: "Szczecin",
  Goleniowie: "Goleniów",
  Gryficach: "Gryfice",
  Gryfinie: "Gryfino",
  Myśliborzu: "Myślibórz",
  Stargardzie: "Stargard",
  Świnoujściu: "Świnoujście",
  Choszcznie: "Choszczno",
  "Kamieniu Pomorskim": "Kamień Pomorski",
  Łobzie: "Łobez",
};

/**
 * The Polish regional and district courts, as the common courts' judgments
 * publisher's index of courts names them; decisions from that publisher are
 * stored under these names, and a test in the API holds the two lists equal.
 */
const POL_COMMON_COURTS: readonly string[] = [
  "Sąd Okręgowy w Białymstoku",
  "Sąd Rejonowy w Białymstoku",
  "Sąd Rejonowy w Bielsku Podlaskim",
  "Sąd Rejonowy w Sokółce",
  "Sąd Okręgowy w Łomży",
  "Sąd Rejonowy w Łomży",
  "Sąd Rejonowy w Zambrowie",
  "Sąd Rejonowy w Wysokiem Mazowieckiem",
  "Sąd Rejonowy w Grajewie",
  "Sąd Okręgowy w Olsztynie",
  "Sąd Rejonowy w Bartoszycach",
  "Sąd Rejonowy w Giżycku",
  "Sąd Rejonowy w Kętrzynie",
  "Sąd Rejonowy w Mrągowie",
  "Sąd Rejonowy w Olsztynie",
  "Sąd Rejonowy w Szczytnie",
  "Sąd Rejonowy w Piszu",
  "Sąd Rejonowy w Biskupcu",
  "Sąd Rejonowy w Lidzbarku Warmińskim",
  "Sąd Rejonowy w Nidzicy",
  "Sąd Okręgowy w Suwałkach",
  "Sąd Rejonowy w Augustowie",
  "Sąd Rejonowy w Ełku",
  "Sąd Rejonowy w Olecku",
  "Sąd Rejonowy w Suwałkach",
  "Sąd Okręgowy w Ostrołęce",
  "Sąd Rejonowy w Ostrołęce",
  "Sąd Rejonowy w Ostrowi Mazowieckiej",
  "Sąd Rejonowy w Przasnyszu",
  "Sąd Rejonowy w Wyszkowie",
  "Sąd Rejonowy w Pułtusku",
  "Sąd Okręgowy w Bydgoszczy",
  "Sąd Rejonowy w Bydgoszczy",
  "Sąd Rejonowy w Inowrocławiu",
  "Sąd Rejonowy w Szubinie",
  "Sąd Rejonowy w Świeciu",
  "Sąd Rejonowy w Nakle nad Notecią",
  "Sąd Rejonowy w Tucholi",
  "Sąd Rejonowy w Mogilnie",
  "Sąd Rejonowy w Żninie",
  "Sąd Okręgowy w Elblągu",
  "Sąd Rejonowy w Braniewie",
  "Sąd Rejonowy w Elblągu",
  "Sąd Rejonowy w Iławie",
  "Sąd Rejonowy w Ostródzie",
  "Sąd Rejonowy w Działdowie",
  "Sąd Rejonowy w Nowym Mieście Lubawskim",
  "Sąd Okręgowy w Gdańsku",
  "Sąd Rejonowy Gdańsk-Południe w Gdańsku",
  "Sąd Rejonowy Gdańsk-Północ w Gdańsku",
  "Sąd Rejonowy w Gdyni",
  "Sąd Rejonowy w Kartuzach",
  "Sąd Rejonowy w Kwidzynie",
  "Sąd Rejonowy w Malborku",
  "Sąd Rejonowy w Sopocie",
  "Sąd Rejonowy w Starogardzie Gdańskim",
  "Sąd Rejonowy w Tczewie",
  "Sąd Rejonowy w Wejherowie",
  "Sąd Rejonowy w Kościerzynie",
  "Sąd Okręgowy w Słupsku",
  "Sąd Rejonowy w Chojnicach",
  "Sąd Rejonowy w Człuchowie",
  "Sąd Rejonowy w Lęborku",
  "Sąd Rejonowy w Słupsku",
  "Sąd Rejonowy w Bytowie",
  "Sąd Rejonowy w Miastku",
  "Sąd Okręgowy w Toruniu",
  "Sąd Rejonowy w Brodnicy",
  "Sąd Rejonowy w Chełmnie",
  "Sąd Rejonowy w Grudziądzu",
  "Sąd Rejonowy w Toruniu",
  "Sąd Rejonowy w Golubiu-Dobrzyniu",
  "Sąd Rejonowy w Wąbrzeźnie",
  "Sąd Okręgowy we Włocławku",
  "Sąd Rejonowy w Aleksandrowie Kujawskim",
  "Sąd Rejonowy w Lipnie",
  "Sąd Rejonowy we Włocławku",
  "Sąd Rejonowy w Radziejowie",
  "Sąd Rejonowy w Rypinie",
  "Sąd Okręgowy w Bielsku-Białej",
  "Sąd Rejonowy w Bielsku-Białej",
  "Sąd Rejonowy w Cieszynie",
  "Sąd Rejonowy w Żywcu",
  "Sąd Okręgowy w Częstochowie",
  "Sąd Rejonowy w Częstochowie",
  "Sąd Rejonowy w Lublińcu",
  "Sąd Rejonowy w Myszkowie",
  "Sąd Rejonowy w Zawierciu",
  "Sąd Okręgowy w Gliwicach",
  "Sąd Rejonowy w Gliwicach",
  "Sąd Rejonowy w Jastrzębiu-Zdroju",
  "Sąd Rejonowy w Raciborzu",
  "Sąd Rejonowy w Rudzie Śląskiej",
  "Sąd Rejonowy w Rybniku",
  "Sąd Rejonowy w Tarnowskich Górach",
  "Sąd Rejonowy w Wodzisławiu Śląśkim",
  "Sąd Rejonowy w Zabrzu",
  "Sąd Rejonowy w Żorach",
  "Sąd Okręgowy w Katowicach",
  "Sąd Rejonowy w Będzinie",
  "Sąd Rejonowy w Bytomiu",
  "Sąd Rejonowy w Chorzowie",
  "Sąd Rejonowy w Dąbrowie Górniczej",
  "Sąd Rejonowy w Jaworznie",
  "Sąd Rejonowy Katowice-Wschód w Katowicach",
  "Sąd Rejonowy Katowice-Zachód w Katowicach",
  "Sąd Rejonowy w Mikołowie",
  "Sąd Rejonowy w Mysłowicach",
  "Sąd Rejonowy w Pszczynie",
  "Sąd Rejonowy w Siemianowicach Śląskich",
  "Sąd Rejonowy w Sosnowcu",
  "Sąd Rejonowy w Tychach",
  "Sąd Okręgowy w Rybniku",
  "Sąd Okręgowy w Sosnowcu",
  "Sąd Rejonowy w Czeladzi",
  "Sąd Okręgowy w Kielcach",
  "Sąd Rejonowy w Busku-Zdroju",
  "Sąd Rejonowy w Jędrzejowie",
  "Sąd Rejonowy w Kielcach",
  "Sąd Rejonowy w Końskich",
  "Sąd Rejonowy w Ostrowcu Świętokrzyskim",
  "Sąd Rejonowy w Sandomierzu",
  "Sąd Rejonowy w Skarżysku-Kamiennej",
  "Sąd Rejonowy w Starachowicach",
  "Sąd Rejonowy w Opatowie",
  "Sąd Rejonowy w Staszowie",
  "Sąd Rejonowy w Pińczowie",
  "Sąd Rejonowy we Włoszczowie",
  "Sąd Okręgowy w Krakowie",
  "Sąd Rejonowy w Chrzanowie",
  "Sąd Rejonowy dla Krakowa-Krowodrzy w Krakowie",
  "Sąd Rejonowy dla Krakowa-Nowej Huty w Krakowie",
  "Sąd Rejonowy dla Krakowa-Podgórza w Krakowie",
  "Sąd Rejonowy dla Krakowa-Śródmieścia w Krakowie",
  "Sąd Rejonowy w Myślenicach",
  "Sąd Rejonowy w Olkuszu",
  "Sąd Rejonowy w Oświęcimiu",
  "Sąd Rejonowy w Wadowicach",
  "Sąd Rejonowy w Wieliczce",
  "Sąd Rejonowy w Suchej Beskidzkiej",
  "Sąd Rejonowy w Miechowie",
  "Sąd Okręgowy w Nowym Sączu",
  "Sąd Rejonowy w Gorlicach",
  "Sąd Rejonowy w Limanowej",
  "Sąd Rejonowy w Nowym Sączu",
  "Sąd Rejonowy w Nowym Targu",
  "Sąd Rejonowy w Zakopanem",
  "Sąd Okręgowy w Tarnowie",
  "Sąd Rejonowy w Bochni",
  "Sąd Rejonowy w Brzesku",
  "Sąd Rejonowy w Tarnowie",
  "Sąd Rejonowy w Dąbrowie Tarnowskiej",
  "Sąd Okręgowy w Kaliszu",
  "Sąd Rejonowy w Jarocinie",
  "Sąd Rejonowy w Kaliszu",
  "Sąd Rejonowy w Kępnie",
  "Sąd Rejonowy w Ostrowie Wielkopolskim",
  "Sąd Rejonowy w Krotoszynie",
  "Sąd Rejonowy w Pleszewie",
  "Sąd Rejonowy w Ostrzeszowie",
  "Sąd Okręgowy w Łodzi",
  "Sąd Rejonowy w Kutnie",
  "Sąd Rejonowy dla Łodzi-Śródmieścia w Łodzi",
  "Sąd Rejonowy dla Łodzi-Widzewa w Łodzi",
  "Sąd Rejonowy w Łowiczu",
  "Sąd Rejonowy w Pabianicach",
  "Sąd Rejonowy w Skierniewicach",
  "Sąd Rejonowy w Zgierzu",
  "Sąd Rejonowy w Brzezinach",
  "Sąd Rejonowy w Łęczycy",
  "Sąd Rejonowy w Rawie Mazowieckiej",
  "Sąd Okręgowy w Piotrkowie Trybunalskim",
  "Sąd Rejonowy w Bełchatowie",
  "Sąd Rejonowy w Opocznie",
  "Sąd Rejonowy w Piotrkowie Trybunalskim",
  "Sąd Rejonowy w Radomsku",
  "Sąd Rejonowy w Tomaszowie Mazowieckim",
  "Sąd Okręgowy w Sieradzu",
  "Sąd Rejonowy w Łasku",
  "Sąd Rejonowy w Sieradzu",
  "Sąd Rejonowy w Wieluniu",
  "Sąd Rejonowy w Zduńskiej Woli",
  "Sąd Okręgowy w Płocku",
  "Sąd Rejonowy w Ciechanowie",
  "Sąd Rejonowy w Gostyninie",
  "Sąd Rejonowy w Mławie",
  "Sąd Rejonowy w Płocku",
  "Sąd Rejonowy w Płońsku",
  "Sąd Rejonowy w Sochaczewie",
  "Sąd Rejonowy w Żyrardowie",
  "Sąd Rejonowy w Sierpcu",
  "Sąd Okręgowy w Lublinie",
  "Sąd Rejonowy w Białej Podlaskiej",
  "Sąd Rejonowy w Chełmie",
  "Sąd Rejonowy w Kraśniku",
  "Sąd Rejonowy w Lubartowie",
  "Sąd Rejonowy Lublin-Wschód w Lublinie z siedzibą w Świdniku",
  "Sąd Rejonowy Lublin-Zachód w Lublinie",
  "Sąd Rejonowy w Łukowie",
  "Sąd Rejonowy w Puławach",
  "Sąd Rejonowy w Radzyniu Podlaskim",
  "Sąd Rejonowy w Opolu Lubelskim",
  "Sąd Rejonowy w Rykach",
  "Sąd Rejonowy we Włodawie",
  "Sąd Okręgowy w Radomiu",
  "Sąd Rejonowy w Grójcu",
  "Sąd Rejonowy w Kozienicach",
  "Sąd Rejonowy w Przysusze",
  "Sąd Rejonowy w Radomiu",
  "Sąd Rejonowy w Zwoleniu",
  "Sąd Rejonowy w Lipsku",
  "Sąd Rejonowy w Szydłowcu",
  "Sąd Okręgowy w Siedlcach",
  "Sąd Rejonowy w Garwolinie",
  "Sąd Rejonowy w Mińsku Mazowieckim",
  "Sąd Rejonowy w Siedlcach",
  "Sąd Rejonowy w Węgrowie",
  "Sąd Rejonowy w Sokołowie Podlaskim",
  "Sąd Okręgowy w Zamościu",
  "Sąd Rejonowy w Biłgoraju",
  "Sąd Rejonowy w Hrubieszowie",
  "Sąd Rejonowy w Tomaszowie Lubelskim",
  "Sąd Rejonowy w Zamościu",
  "Sąd Rejonowy w Krasnymstawie",
  "Sąd Rejonowy w Janowie Lubelskim",
  "Sąd Okręgowy w Koninie",
  "Sąd Rejonowy w Kole",
  "Sąd Rejonowy w Koninie",
  "Sąd Rejonowy w Turku",
  "Sąd Rejonowy w Słupcy",
  "Sąd Okręgowy w Poznaniu",
  "Sąd Rejonowy w Gnieźnie",
  "Sąd Rejonowy w Grodzisku Wielkopolskim",
  "Sąd Rejonowy w Nowym Tomyślu",
  "Sąd Rejonowy w Wolsztynie",
  "Sąd Rejonowy w Kościanie",
  "Sąd Rejonowy w Śremie",
  "Sąd Rejonowy w Lesznie",
  "Sąd Rejonowy w Gostyniu",
  "Sąd Rejonowy w Rawiczu",
  "Sąd Rejonowy w Pile",
  "Sąd Rejonowy w Złotowie",
  "Sąd Rejonowy Poznań-Grunwald i Jeżyce w Poznaniu",
  "Sąd Rejonowy Poznań-Nowe Miasto i Wilda w Poznaniu",
  "Sąd Rejonowy Poznań-Stare Miasto w Poznaniu",
  "Sąd Rejonowy w Szamotułach",
  "Sąd Rejonowy w Obornikach",
  "Sąd Rejonowy w Środzie Wielkopolskiej",
  "Sąd Rejonowy we Wrześni",
  "Sąd Rejonowy w Trzciance",
  "Sąd Rejonowy w Wągrowcu",
  "Sąd Rejonowy w Chodzieży",
  "Sąd Okręgowy w Zielonej Górze",
  "Sąd Rejonowy w Krośnie Odrzańskim",
  "Sąd Rejonowy w Nowej Soli",
  "Sąd Rejonowy w Świebodzinie",
  "Sąd Rejonowy w Zielonej Górze",
  "Sąd Rejonowy w Żaganiu",
  "Sąd Rejonowy w Żarach",
  "Sąd Rejonowy we Wschowie",
  "Sąd Okręgowy w Krośnie",
  "Sąd Rejonowy w Jaśle",
  "Sąd Rejonowy w Krośnie",
  "Sąd Rejonowy w Lesku",
  "Sąd Rejonowy w Sanoku",
  "Sąd Rejonowy w Brzozowie",
  "Sąd Okręgowy w Rzeszowie",
  "Sąd Rejonowy w Dębicy",
  "Sąd Rejonowy w Łańcucie",
  "Sąd Rejonowy w Rzeszowie",
  "Sąd Rejonowy w Leżajsku",
  "Sąd Rejonowy w Ropczycach",
  "Sąd Rejonowy w Strzyżowie",
  "Sąd Okręgowy w Tarnobrzegu",
  "Sąd Rejonowy w Mielcu",
  "Sąd Rejonowy w Stalowej Woli",
  "Sąd Rejonowy w Tarnobrzegu",
  "Sąd Rejonowy w Nisku",
  "Sąd Rejonowy w Kolbuszowej",
  "Sąd Okręgowy w Przemyślu",
  "Sąd Rejonowy w Jarosławiu",
  "Sąd Rejonowy w Przemyślu",
  "Sąd Rejonowy w Przeworsku",
  "Sąd Rejonowy w Lubaczowie",
  "Sąd Okręgowy w Warszawie",
  "Sąd Rejonowy w Grodzisku Mazowieckim",
  "Sąd Rejonowy w Piasecznie",
  "Sąd Rejonowy w Pruszkowie",
  "Sąd Rejonowy dla Warszawy-Mokotowa w Warszawie",
  "Sąd Rejonowy dla m. st. Warszawy w Warszawie",
  "Sąd Rejonowy dla Warszawy-Śródmieścia w Warszawie",
  "Sąd Rejonowy dla Warszawy-Woli w Warszawie",
  "Sąd Rejonowy dla Warszawy-Żoliborza w Warszawie",
  "Sąd Okręgowy Warszawa-Praga w Warszawie",
  "Sąd Rejonowy w Legionowie",
  "Sąd Rejonowy w Nowym Dworze Mazowieckim",
  "Sąd Rejonowy w Otwocku",
  "Sąd Rejonowy dla Warszawy Pragi-Południe w Warszawie",
  "Sąd Rejonowy dla Warszawy Pragi-Północ w Warszawie",
  "Sąd Rejonowy w Wołominie",
  "Sąd Okręgowy w Jeleniej Górze",
  "Sąd Rejonowy w Bolesławcu",
  "Sąd Rejonowy w Jeleniej Górze",
  "Sąd Rejonowy w Lubaniu",
  "Sąd Rejonowy w Zgorzelcu",
  "Sąd Rejonowy w Kamiennej Górze",
  "Sąd Rejonowy w Lwówku Śląskim",
  "Sąd Okręgowy w Legnicy",
  "Sąd Rejonowy w Głogowie",
  "Sąd Rejonowy w Legnicy",
  "Sąd Rejonowy w Lubinie",
  "Sąd Rejonowy w Złotoryi",
  "Sąd Rejonowy w Jaworze",
  "Sąd Okręgowy w Opolu",
  "Sąd Rejonowy w Brzegu",
  "Sąd Rejonowy w Kędzierzynie Koźlu",
  "Sąd Rejonowy w Kluczborku",
  "Sąd Rejonowy w Nysie",
  "Sąd Rejonowy w Opolu",
  "Sąd Rejonowy w Prudniku",
  "Sąd Rejonowy w Strzelcach Opolskich",
  "Sąd Rejonowy w Oleśnie",
  "Sąd Rejonowy w Głubczycach",
  "Sąd Okręgowy w Świdnicy",
  "Sąd Rejonowy w Dzierżoniowie",
  "Sąd Rejonowy w Kłodzku",
  "Sąd Rejonowy w Świdnicy",
  "Sąd Rejonowy w Wałbrzychu",
  "Sąd Rejonowy w Ząbkowicach Śląskich",
  "Sąd Okręgowy we Wrocławiu",
  "Sąd Rejonowy w Miliczu",
  "Sąd Rejonowy w Oleśnicy",
  "Sąd Rejonowy w Oławie",
  "Sąd Rejonowy w Strzelinie",
  "Sąd Rejonowy w Środzie Śląskiej",
  "Sąd Rejonowy w Trzebnicy",
  "Sąd Rejonowy w Wołowie",
  "Sąd Rejonowy Wrocław Fabryczna we Wrocławiu",
  "Sąd Rejonowy Wrocław Krzyki we Wrocławiu",
  "Sąd Rejonowy Wrocław Śródmieście we Wrocławiu",
  "Sąd Okręgowy w Gorzowie Wielkopolskim",
  "Sąd Rejonowy w Gorzowie Wielkopolskim",
  "Sąd Rejonowy w Międzyrzeczu",
  "Sąd Rejonowy w Słubicach",
  "Sąd Rejonowy w Strzelcach Krajeńskich",
  "Sąd Rejonowy w Sulęcinie",
  "Sąd Okręgowy w Koszalinie",
  "Sąd Rejonowy w Białogardzie",
  "Sąd Rejonowy w Drawsku Pomorskim",
  "Sąd Rejonowy w Kołobrzegu",
  "Sąd Rejonowy w Koszalinie",
  "Sąd Rejonowy w Szczecinku",
  "Sąd Rejonowy w Wałczu",
  "Sąd Rejonowy w Sławnie",
  "Sąd Okręgowy w Szczecinie",
  "Sąd Rejonowy w Goleniowie",
  "Sąd Rejonowy w Gryficach",
  "Sąd Rejonowy w Gryfinie",
  "Sąd Rejonowy w Myśliborzu",
  "Sąd Rejonowy w Stargardzie",
  "Sąd Rejonowy Szczecin-Centrum w Szczecinie",
  "Sąd Rejonowy Szczecin-Prawobrzeże i Zachód w Szczecinie",
  "Sąd Rejonowy w Świnoujściu",
  "Sąd Rejonowy w Choszcznie",
  "Sąd Rejonowy w Kamieniu Pomorskim",
  "Sąd Rejonowy w Łobzie",
];

/**
 * The district designators a Polish court name carries before its seat
 * (`Sąd Rejonowy dla Warszawy-Mokotowa w Warszawie`), with the nominative a
 * citation writes them in (`SR Warszawa-Mokotów`) where it differs, and the
 * other spellings publishers store the same court under.
 */
const POL_DESIGNATORS: Readonly<
  Record<string, { nominative?: string; variants?: readonly string[] }>
> = {
  "dla Krakowa-Krowodrzy": { nominative: "Kraków-Krowodrza" },
  "dla Krakowa-Nowej Huty": { nominative: "Kraków-Nowa Huta" },
  "dla Krakowa-Podgórza": { nominative: "Kraków-Podgórze" },
  "dla Krakowa-Śródmieścia": { nominative: "Kraków-Śródmieście" },
  "dla Łodzi-Śródmieścia": { nominative: "Łódź-Śródmieście" },
  "dla Łodzi-Widzewa": { nominative: "Łódź-Widzew" },
  "dla Warszawy-Mokotowa": { nominative: "Warszawa-Mokotów" },
  "dla Warszawy-Śródmieścia": { nominative: "Warszawa-Śródmieście" },
  "dla Warszawy-Woli": { nominative: "Warszawa-Wola" },
  "dla Warszawy-Żoliborza": { nominative: "Warszawa-Żoliborz" },
  "dla Warszawy Pragi-Południe": { nominative: "Warszawa Praga-Południe" },
  "dla Warszawy Pragi-Północ": { nominative: "Warszawa Praga-Północ" },
  "dla m. st. Warszawy": {},
  // Stored by one publisher under the name the court has carried since its
  // renaming, by the other under the district's nominative.
  "Wrocław Fabryczna": { variants: ["dla Wrocławia-Fabrycznej"] },
  "Wrocław Krzyki": { variants: ["dla Wrocławia-Krzyków"] },
  "Wrocław Śródmieście": { variants: ["dla Wrocławia-Śródmieścia"] },
};

const POLISH_COMMON_COURT_RE =
  /^Sąd (?<tier>Okręgowy|Rejonowy) (?:(?<designator>.+?) )?(?<preposition>w|we) (?<seat>.+?)(?<seated> z siedzibą w .+)?$/u;

/**
 * A Polish regional or district court read off its official name. A court
 * named by its seat alone takes the generated seat forms (`SR w Gdyni`, `SR
 * Gdynia`); a court a designator tells apart from its city's other courts is
 * cited by the designator, never by the city alone, which names several.
 */
const polishCommonCourt = (name: string): DirectoryCourt => {
  const groups =
    POLISH_COMMON_COURT_RE.exec(name)?.groups ??
    panic(`Not a Polish common court name: ${name}`);
  const head = groups["tier"] === "Okręgowy" ? "SO" : "SR";
  const preposition = groups["preposition"] ?? panic(`No preposition: ${name}`);
  const seat = groups["seat"] ?? panic(`No seat: ${name}`);
  const nominative =
    POL_SEAT_NOMINATIVES[seat] ??
    panic(`Polish seat without a nominative: ${seat}`);
  const designator = groups["designator"];
  if (designator === undefined) {
    return {
      name,
      head,
      seat: seatIn(nominative, seat, preposition),
      ecliCodes: [],
    };
  }
  const known = POL_DESIGNATORS[designator] ?? {};
  const designators = [
    designator,
    ...(known.variants ?? []),
    ...(known.nominative === undefined ? [] : [known.nominative]),
  ];
  const { forms, codes } = COURT_HEADS.POL[head];
  return {
    name,
    head: "",
    ecliCodes: [],
    extraAliases: [...forms, ...codes].flatMap((opening) =>
      designators.flatMap((text) => [
        `${opening} ${text}`,
        `${opening} ${text} ${preposition} ${seat}`,
      ]),
    ),
  };
};

/**
 * The Polish apex courts, the 16 voivodeship administrative courts, the 11
 * courts of appeal, and every regional and district court (`Sąd Okręgowy`,
 * `Sąd Rejonowy`).
 */
const POL_COURTS: readonly DirectoryCourt[] = [
  { name: "Sąd Najwyższy", head: "SN", ecliCodes: ["SN"] },
  { name: "Naczelny Sąd Administracyjny", head: "NSA", ecliCodes: ["NSA"] },
  { name: "Trybunał Konstytucyjny", head: "TK", ecliCodes: ["TK"] },
  ...(
    [
      ["Białystok", "Białymstoku"],
      ["Bydgoszcz", "Bydgoszczy"],
      ["Gdańsk", "Gdańsku"],
      ["Gliwice", "Gliwicach"],
      ["Gorzów Wielkopolski", "Gorzowie Wielkopolskim"],
      ["Kielce", "Kielcach"],
      ["Kraków", "Krakowie"],
      ["Lublin", "Lublinie"],
      ["Łódź", "Łodzi"],
      ["Olsztyn", "Olsztynie"],
      ["Opole", "Opolu"],
      ["Poznań", "Poznaniu"],
      ["Rzeszów", "Rzeszowie"],
      ["Szczecin", "Szczecinie"],
      ["Warszawa", "Warszawie"],
      ["Wrocław", "Wrocławiu", "we"],
    ] as const
  ).map(([nominative, form, preposition]) =>
    polishCourt("WSA", nominative, form, preposition),
  ),
  ...(
    [
      ["Białystok", "Białymstoku"],
      ["Gdańsk", "Gdańsku"],
      ["Katowice", "Katowicach"],
      ["Kraków", "Krakowie"],
      ["Lublin", "Lublinie"],
      ["Łódź", "Łodzi"],
      ["Poznań", "Poznaniu"],
      ["Rzeszów", "Rzeszowie"],
      ["Szczecin", "Szczecinie"],
      ["Warszawa", "Warszawie"],
      ["Wrocław", "Wrocławiu", "we"],
    ] as const
  ).map(([nominative, form, preposition]) =>
    polishCourt("SA", nominative, form, preposition),
  ),
  ...POL_COMMON_COURTS.map(polishCommonCourt),
];

/**
 * The Hungarian district courts (`járásbíróság`), Budapest's district courts
 * (`kerületi bíróság`) and the administrative and labour courts, as the
 * decisions' publisher (eakta.birosag.hu) lists them in its court filter;
 * decisions are stored under these names.
 */
const HUN_LOWER_COURTS: readonly string[] = [
  "Ajkai Járásbíróság",
  "Bajai Járásbíróság",
  "Balassagyarmati Járásbíróság",
  "Barcsi Járásbíróság",
  "Battonyai Járásbíróság",
  "Békéscsabai Járásbíróság",
  "Békési Járásbíróság",
  "Berettyóújfalui Járásbíróság",
  "Bicskei Járásbíróság",
  "Bonyhádi Járásbíróság",
  "Budai Központi Kerületi Bíróság",
  "Budakörnyéki Járásbíróság",
  "Budaörsi Járásbíróság",
  "Budapest Környéki Közigazgatási és Munkaügyi Bíróság",
  "Budapesti II. és III. Kerületi Bíróság",
  "Budapesti IV. és XV. Kerületi Bíróság",
  "Budapesti XVIII. és XIX. Kerületi Bíróság",
  "Budapesti XX., XXI. és XXIII. Kerületi Bíróság",
  "Ceglédi Járásbíróság",
  "Csongrádi Járásbíróság",
  "Csornai Járásbíróság",
  "Dabasi Járásbíróság",
  "Debreceni Járásbíróság",
  "Debreceni Közigazgatási és Munkaügyi Bíróság",
  "Dombóvári Járásbíróság",
  "Dunakeszi Járásbíróság",
  "Dunaújvárosi Járásbíróság",
  "Egri Járásbíróság",
  "Egri Közigazgatási és Munkaügyi Bíróság",
  "Encsi Járásbíróság",
  "Érdi Járásbíróság",
  "Esztergomi Járásbíróság",
  "Fehérgyarmati Járásbíróság",
  "Fonyódi Járásbíróság",
  "Fővárosi Közigazgatási és Munkaügyi Bíróság",
  "Füzesabonyi Járásbíróság",
  "Gödöllői Járásbíróság",
  "Gyöngyösi Járásbíróság",
  "Győri Járásbíróság",
  "Győri Közigazgatási és Munkaügyi Bíróság",
  "Gyulai Járásbíróság",
  "Gyulai Közigazgatási és Munkaügyi Bíróság",
  "Hajdúböszörményi Járásbíróság",
  "Hajdúszoboszlói Járásbíróság",
  "Hatvani Járásbíróság",
  "Hevesi Járásbíróság",
  "Hódmezővásárhelyi Járásbíróság",
  "Jászberényi Járásbíróság",
  "Kalocsai Járásbíróság",
  "Kaposvári Járásbíróság",
  "Kaposvári Közigazgatási és Munkaügyi Bíróság",
  "Karcagi Járásbíróság",
  "Kazincbarcikai Járásbíróság",
  "Kecskeméti Járásbíróság",
  "Kecskeméti Közigazgatási és Munkaügyi Bíróság",
  "Keszthelyi Járásbíróság",
  "Kiskőrösi Járásbíróság",
  "Kiskunfélegyházi Járásbíróság",
  "Kiskunhalasi Járásbíróság",
  "Kisvárdai Járásbíróság",
  "Komáromi Járásbíróság",
  "Komlói Járásbíróság",
  "Körmendi Járásbíróság",
  "Kőszegi Járásbíróság",
  "Kunszentmártoni Járásbíróság",
  "Kunszentmiklósi Járásbíróság",
  "Lenti Járásbíróság",
  "Makói Járásbíróság",
  "Marcali Járásbíróság",
  "Mátészalkai Járásbíróság",
  "Mezőkövesdi Járásbíróság",
  "Mezőtúri Járásbíróság",
  "Miskolci Járásbíróság",
  "Miskolci Közigazgatási és Munkaügyi Bíróság",
  "Mohácsi Járásbíróság",
  "Monori Járásbíróság",
  "Mosonmagyaróvári Járásbíróság",
  "Nagyatádi Járásbíróság",
  "Nagykanizsai Járásbíróság",
  "Nagykátai Járásbíróság",
  "Nagykőrösi Járásbíróság",
  "Nyírbátori Járásbíróság",
  "Nyíregyházi Járásbíróság",
  "Nyíregyházi Közigazgatási és Munkaügyi Bíróság",
  "Orosházi Járásbíróság",
  "Ózdi Járásbíróság",
  "Paksi Járásbíróság",
  "Pápai Járásbíróság",
  "Pásztói Járásbíróság",
  "Pécsi Járásbíróság",
  "Pécsi Közigazgatási és Munkaügyi Bíróság",
  "Pesti Központi Kerületi Bíróság",
  "Püspökladányi Járásbíróság",
  "Ráckevei Járásbíróság",
  "Salgótarjáni Járásbíróság",
  "Salgótarjáni Közigazgatási és Munkaügyi Bíróság",
  "Sárbogárdi Járásbíróság",
  "Sárvári Járásbíróság",
  "Sátoraljaújhelyi Járásbíróság",
  "Siklósi Járásbíróság",
  "Siófoki Járásbíróság",
  "Soproni Járásbíróság",
  "Szarvasi Járásbíróság",
  "Szegedi Járásbíróság",
  "Szegedi Közigazgatási és Munkaügyi Bíróság",
  "Szeghalmi Járásbíróság",
  "Székesfehérvári Járásbíróság",
  "Székesfehérvári Közigazgatási és Munkaügyi Bíróság",
  "Szekszárdi Járásbíróság",
  "Szekszárdi Közigazgatási és Munkaügyi Bíróság",
  "Szentendrei Járásbíróság",
  "Szentesi Járásbíróság",
  "Szerencsi Járásbíróság",
  "Szigetszentmiklósi Járásbíróság",
  "Szigetvári Járásbíróság",
  "Szikszói Járásbíróság",
  "Szolnoki Járásbíróság",
  "Szolnoki Közigazgatási és Munkaügyi Bíróság",
  "Szombathelyi Járásbíróság",
  "Szombathelyi Közigazgatási és Munkaügyi Bíróság",
  "Tamási Járásbíróság",
  "Tapolcai Járásbíróság",
  "Tatabányai Járásbíróság",
  "Tatabányai Közigazgatási és Munkaügyi Bíróság",
  "Tatai Járásbíróság",
  "Tiszafüredi Járásbíróság",
  "Tiszaújvárosi Járásbíróság",
  "Váci Járásbíróság",
  "Vásárosnaményi Járásbíróság",
  "Veszprémi Járásbíróság",
  "Veszprémi Közigazgatási és Munkaügyi Bíróság",
  "Zalaegerszegi Járásbíróság",
  "Zalaegerszegi Közigazgatási és Munkaügyi Bíróság",
  "Zirci Járásbíróság",
];

/** Fixed short forms Hungarian citations write for a Budapest district court. */
const HUN_SHORT_FORMS: Readonly<Record<string, readonly string[]>> = {
  "Budai Központi Kerületi Bíróság": ["BKKB"],
  "Pesti Központi Kerületi Bíróság": ["PKKB"],
};

/**
 * The Hungarian apex courts, the five regional courts of appeal, the 20
 * regional courts and the publisher's lower courts. Hungarian names open with
 * the seat's adjective, so the name is the citation form; Hungary issues no
 * ECLI.
 */
const HUN_COURTS: readonly DirectoryCourt[] = [
  { name: "Kúria", head: "Kuria", ecliCodes: [] },
  { name: "Alkotmánybíróság", head: "AB", ecliCodes: [] },
  ...["Fővárosi", "Debreceni", "Győri", "Pécsi", "Szegedi"].map(
    (seat): DirectoryCourt => ({
      name: `${seat} Ítélőtábla`,
      head: "",
      ecliCodes: [],
      extraAliases: hungarianForms(
        `${seat} Ítélőtábla`,
        ["ának", "án", "át"],
        1,
      ),
    }),
  ),
  ...[
    "Balassagyarmati",
    "Budapest Környéki",
    "Debreceni",
    "Egri",
    "Fővárosi",
    "Győri",
    "Gyulai",
    "Kaposvári",
    "Kecskeméti",
    "Miskolci",
    "Nyíregyházi",
    "Pécsi",
    "Szegedi",
    "Szekszárdi",
    "Székesfehérvári",
    "Szolnoki",
    "Szombathelyi",
    "Tatabányai",
    "Veszprémi",
    "Zalaegerszegi",
  ].map((seat): DirectoryCourt => ({
    name: `${seat} Törvényszék`,
    head: "",
    ecliCodes: [],
    extraAliases: hungarianForms(`${seat} Törvényszék`, ["nek", "en", "et"]),
  })),
  // Each name ends in `bíróság`, which declines as the Alkotmánybíróság does.
  ...HUN_LOWER_COURTS.map((name): DirectoryCourt => ({
    name,
    head: "",
    ecliCodes: [],
    extraAliases: [
      ...hungarianForms(name, ["nak", "on", "ot"]),
      ...(HUN_SHORT_FORMS[name] ?? []),
    ],
  })),
];

/**
 * How one country's citations name its courts: the heads its court names
 * open with and how they decline, the country suffixes and English names an
 * apex court is cited with, its ECLI jurisdiction and the code families that
 * append a seat, and the courts it has. The alias generator reads a country
 * only through this, so a country is either declared here or not read.
 */
export type CourtCitationGrammar = {
  kind: "grammar";
  heads: Readonly<Record<string, CourtHead>>;
  apexSuffixes: readonly string[];
  englishSuffixes: readonly string[];
  /** The ECLI jurisdiction segment, or null where the country issues none. */
  ecliJurisdiction: string | null;
  /** Code prefixes of court families whose ECLI code appends a seat. */
  ecliFamilyPrefixes: readonly string[];
  courts: readonly DirectoryCourt[];
};

/** A public country no identity surface reads, so it needs no grammar yet. */
type NoIdentitySurface = { kind: "no-identity-surface" };

const grammarOf = (
  country: CourtDirectoryCountry,
  {
    ecliJurisdiction,
    ecliFamilyPrefixes,
    courts,
  }: Pick<
    CourtCitationGrammar,
    "ecliJurisdiction" | "ecliFamilyPrefixes" | "courts"
  >,
): CourtCitationGrammar => ({
  kind: "grammar",
  heads: COURT_HEADS[country],
  apexSuffixes: APEX_COUNTRY_SUFFIXES[country],
  englishSuffixes: APEX_ENGLISH_SUFFIXES[country],
  ecliJurisdiction,
  ecliFamilyPrefixes,
  courts,
});

/**
 * Every public country's court citation grammar. Total over the public
 * countries, so a new one cannot compile without a decision, and a test
 * holds every country with an identity surface to a declared grammar.
 */
export const COURT_CITATION_GRAMMARS = {
  AUT: { kind: "no-identity-surface" },
  CZE: grammarOf("CZE", {
    ecliJurisdiction: "CZ",
    ecliFamilyPrefixes: ["KS", "MS", "OS", "VS"],
    courts: CZE_COURTS,
  }),
  EU: grammarOf("EU", {
    ecliJurisdiction: "EU",
    ecliFamilyPrefixes: [],
    courts: EU_COURTS,
  }),
  GBR: { kind: "no-identity-surface" },
  HUN: grammarOf("HUN", {
    ecliJurisdiction: null,
    ecliFamilyPrefixes: [],
    courts: HUN_COURTS,
  }),
  POL: grammarOf("POL", {
    ecliJurisdiction: "PL",
    ecliFamilyPrefixes: ["WSA", "SA", "SO", "SR"],
    courts: POL_COURTS,
  }),
  SVK: grammarOf("SVK", {
    ecliJurisdiction: "SK",
    ecliFamilyPrefixes: ["KS", "MS", "OS", "SpS"],
    courts: SVK_COURTS,
  }),
  USA: { kind: "no-identity-surface" },
} as const satisfies Record<
  PublicCountry,
  CourtCitationGrammar | NoIdentitySurface
>;

/** The country's declared grammar, or undefined where it declares none. */
export const courtCitationGrammarOf = (
  country: string,
): CourtCitationGrammar | undefined => {
  const entry = Object.entries<CourtCitationGrammar | NoIdentitySurface>(
    COURT_CITATION_GRAMMARS,
  ).find(([candidate]) => candidate === country)?.[1];
  return entry?.kind === "grammar" ? entry : undefined;
};
