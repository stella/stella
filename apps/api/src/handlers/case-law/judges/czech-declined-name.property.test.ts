/**
 * Which roster row a declined Czech name resolves to.
 *
 * The roster is the court's own, read from the two listings it publishes
 * (sitting and emeritus justices). Every justice on it is checked in the two
 * cases a decision prints a bench in, genitive ("z předsedy Jana Svatoně") and
 * instrumental ("soudcem zpravodajem Janem Svatoněm"), and each must resolve to
 * that justice and no one else.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { matchCzechDeclinedName } from "@/api/handlers/case-law/judges/czech-declined-name";
import {
  CZ_US_ROSTER_LISTINGS,
  parseRosterListing,
} from "@/api/handlers/case-law/judges/import-cz-us-roster";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const listing = async (name: string, listingUrl: string) =>
  parseRosterListing({
    html: new TextDecoder().decode(
      Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
    ),
    listingUrl,
  });

const [SITTING_URL, EMERITUS_URL] = CZ_US_ROSTER_LISTINGS;

/** One row per justice, as the import keys them: a name on both lists is one. */
const ROSTER = [
  ...new Map(
    [
      ...(await listing("cz-us-roster-sitting.html.gz", SITTING_URL)),
      ...(await listing("cz-us-roster-emeritus.html.gz", EMERITUS_URL)),
    ].map(({ name }) => [name, { fullName: name }]),
  ).values(),
];

/** Each justice in the nominative, genitive and instrumental. */
const DECLENSIONS: Readonly<Record<string, readonly [string, string]>> = {
  "Josef Baxa": ["Josefa Baxy", "Josefem Baxou"],
  "Veronika Křesťanová": ["Veroniky Křesťanové", "Veronikou Křesťanovou"],
  "Kateřina Ronovská": ["Kateřiny Ronovské", "Kateřinou Ronovskou"],
  "Pavel Šámal": ["Pavla Šámala", "Pavlem Šámalem"],
  "Jan Svatoň": ["Jana Svatoně", "Janem Svatoněm"],
  "Jan Wintr": ["Jana Wintra", "Janem Wintrem"],
  "Daniela Zemanová": ["Daniely Zemanové", "Danielou Zemanovou"],
  "Lucie Dolanská Bányaiová": [
    "Lucie Dolanské Bányaiové",
    "Lucií Dolanskou Bányaiovou",
  ],
  "Zdeněk Kühn": ["Zdeňka Kühna", "Zdeňkem Kühnem"],
  "Milan Hulmák": ["Milana Hulmáka", "Milanem Hulmákem"],
  "Tomáš Langášek": ["Tomáše Langáška", "Tomášem Langáškem"],
  "Jiří Přibáň": ["Jiřího Přibáně", "Jiřím Přibáněm"],
  "Dita Řepková": ["Dity Řepkové", "Ditou Řepkovou"],
  "Martin Smolek": ["Martina Smolka", "Martinem Smolkem"],
  "Michal Bartoň": ["Michala Bartoně", "Michalem Bartoněm"],
  "Josef Fiala": ["Josefa Fialy", "Josefem Fialou"],
  "Jaromír Jirsa": ["Jaromíra Jirsy", "Jaromírem Jirsou"],
  "David Uhlíř": ["Davida Uhlíře", "Davidem Uhlířem"],
  "Tomáš Lichovník": ["Tomáše Lichovníka", "Tomášem Lichovníkem"],
  "Vojtěch Šimíček": ["Vojtěcha Šimíčka", "Vojtěchem Šimíčkem"],
  "Jiří Zemánek": ["Jiřího Zemánka", "Jiřím Zemánkem"],
  "Radovan Suchánek": ["Radovana Suchánka", "Radovanem Suchánkem"],
  "Pavel Rychetský": ["Pavla Rychetského", "Pavlem Rychetským"],
  "Ludvík David": ["Ludvíka Davida", "Ludvíkem Davidem"],
  "Vladimír Sládeček": ["Vladimíra Sládečka", "Vladimírem Sládečkem"],
  "Jan Filip": ["Jana Filipa", "Janem Filipem"],
  "Jaroslav Fenyk": ["Jaroslava Fenyka", "Jaroslavem Fenykem"],
  "Milada Tomková": ["Milady Tomkové", "Miladou Tomkovou"],
  "Kateřina Šimáčková": ["Kateřiny Šimáčkové", "Kateřinou Šimáčkovou"],
  "Jan Musil": ["Jana Musila", "Janem Musilem"],
  "Vladimír Kůrka": ["Vladimíra Kůrky", "Vladimírem Kůrkou"],
  "Vlasta Formánková": ["Vlasty Formánkové", "Vlastou Formánkovou"],
  "Ivana Janů": ["Ivany Janů", "Ivanou Janů"],
  "Michaela Židlická": ["Michaely Židlické", "Michaelou Židlickou"],
  "Stanislav Balík": ["Stanislava Balíka", "Stanislavem Balíkem"],
  "Jiří Nykodým": ["Jiřího Nykodýma", "Jiřím Nykodýmem"],
  "Dagmar Lastovecká": ["Dagmar Lastovecké", "Dagmar Lastoveckou"],
  "Vojen Güttler": ["Vojena Güttlera", "Vojenem Güttlerem"],
  "Pavel Holländer": ["Pavla Holländera", "Pavlem Holländerem"],
  "Miloslav Výborný": ["Miloslava Výborného", "Miloslavem Výborným"],
  "Jiří Mucha": ["Jiřího Muchy", "Jiřím Muchou"],
  "František Duchoň": ["Františka Duchoně", "Františkem Duchoněm"],
  "Eliška Wagnerová": ["Elišky Wagnerové", "Eliškou Wagnerovou"],
  "Jiří Malenovský": ["Jiřího Malenovského", "Jiřím Malenovským"],
  "Pavel Varvařovský": ["Pavla Varvařovského", "Pavlem Varvařovským"],
  "Eva Zarembová": ["Evy Zarembové", "Evou Zarembovou"],
  "Miloš Holeček": ["Miloše Holečka", "Milošem Holečkem"],
  "Vojtěch Cepl": ["Vojtěcha Cepla", "Vojtěchem Ceplem"],
  "Vladimír Čermák": ["Vladimíra Čermáka", "Vladimírem Čermákem"],
  "Vladimír Jurka": ["Vladimíra Jurky", "Vladimírem Jurkou"],
  "Vladimír Klokočka": ["Vladimíra Klokočky", "Vladimírem Klokočkou"],
  "Antonín Procházka": ["Antonína Procházky", "Antonínem Procházkou"],
  "Zdeněk Kessler": ["Zdeňka Kesslera", "Zdeňkem Kesslerem"],
  "Vlastimil Ševčík": ["Vlastimila Ševčíka", "Vlastimilem Ševčíkem"],
  "Vladimír Paul": ["Vladimíra Paula", "Vladimírem Paulem"],
  "Iva Brožová": ["Ivy Brožové", "Ivou Brožovou"],
};

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

describe("matchCzechDeclinedName", () => {
  test("the table covers every justice the court lists", () => {
    expect(ROSTER.map(({ fullName }) => fullName).toSorted()).toEqual(
      Object.keys(DECLENSIONS).toSorted(),
    );
  });

  test("every justice resolves to themselves alone, in every case", () => {
    for (const judge of ROSTER) {
      const forms = DECLENSIONS[judge.fullName] ?? [];
      for (const form of [judge.fullName, ...forms]) {
        expect({ form, match: matchCzechDeclinedName(form, ROSTER) }).toEqual({
          form,
          match: { type: "matched", judge },
        });
      }
    }
  });

  test("titles, spacing and word order do not move a match", () => {
    const entries = Object.entries(DECLENSIONS).flatMap(([fullName, forms]) =>
      forms.map((form) => ({ fullName, form })),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...entries),
        fc.constantFrom("", "JUDr. ", "prof. JUDr. ", "doc. JUDr. "),
        fc.constantFrom("", ", Ph.D.", ", CSc.", ", Ph.D., LL.M."),
        fc.boolean(),
        ({ fullName, form }, before, after, reversed) => {
          const parts = form.split(" ");
          const printed = `${before}${(reversed ? parts.toReversed() : parts).join("  ")}${after}`;
          expect(matchCzechDeclinedName(printed, ROSTER)).toEqual({
            type: "matched",
            judge: { fullName },
          });
        },
      ),
      config(200),
    );
  });

  test("a person the roster does not hold is unmatched, never the nearest justice", () => {
    for (const name of [
      "Petra Nováka",
      "Jana Svatoně Nováka",
      "Svatoně",
      "Mgr. Terezou Zahutovou",
      "",
    ]) {
      expect(matchCzechDeclinedName(name, ROSTER)).toEqual({
        type: "unmatched",
      });
    }
  });

  test("a name two rows can be is left unmatched rather than guessed", () => {
    // "Jana Zemana" is the genitive of Jan Zeman, and its parts also stem to
    // Jana Zemanová's; with both on a roster neither is chosen.
    expect(
      matchCzechDeclinedName("Jana Zemana", [
        { fullName: "Jan Zeman" },
        { fullName: "Jana Zemanová" },
      ]),
    ).toEqual({ type: "ambiguous", candidates: 2 });
  });
});
