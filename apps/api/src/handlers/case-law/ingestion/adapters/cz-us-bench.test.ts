import { describe, expect, test } from "bun:test";

import { czUsOpeningBench } from "@/api/handlers/case-law/ingestion/adapters/cz-us-bench";

/**
 * Opening sentences as the court publishes them (NALUS), cut after the
 * bench. Each covers one way the court has written its bench over the years.
 */
describe("czUsOpeningBench", () => {
  test("a panel whose presiding judge is the rapporteur", () => {
    expect(
      czUsOpeningBench(
        "NÁLEZ Ústavní soud rozhodl v senátě složeném z předsedy Jana Svatoně (soudce zpravodaje), soudce Milana Hulmáka a soudkyně Daniely Zemanové o ústavní stížnosti stěžovatelky M. F., zastoupené Mgr. Terezou Zahutovou, advokátkou, takto:",
      ),
    ).toEqual([
      { role: "presiding", czechDeclinedName: "Jana Svatoně" },
      { role: "rapporteur", czechDeclinedName: "Jana Svatoně" },
      { role: "panel-member", czechDeclinedName: "Milana Hulmáka" },
      { role: "panel-member", czechDeclinedName: "Daniely Zemanové" },
    ]);
  });

  test("a panel whose rapporteur is a member, with a three-part name", () => {
    expect(
      czUsOpeningBench(
        "NÁLEZ\n\nÚstavní soud rozhodl v senátu složeném z předsedkyně Daniely Zemanové, soudkyně Lucie Dolanské Bányaiové a soudce Jiřího Přibáně (soudce zpravodaj) o ústavní stížnosti stěžovatelky Kateřiny Šámalové, zastoupené Mgr. Ing. Janem Boučkem, advokátem,",
      ),
    ).toEqual([
      { role: "presiding", czechDeclinedName: "Daniely Zemanové" },
      { role: "panel-member", czechDeclinedName: "Lucie Dolanské Bányaiové" },
      { role: "rapporteur", czechDeclinedName: "Jiřího Přibáně" },
    ]);
  });

  test("an older panel with titles and a dated opening", () => {
    expect(
      czUsOpeningBench(
        "USNESENÍ\n\nÚstavní soud rozhodl dne 17. června 1999 v senátě složeném z předsedkyně JUDr. Evy Zarembové a soudců JUDr. Vladimíra Čermáka a JUDr. Pavla Varvařovského ve věci ústavní stížnosti A. Š., zastoupené JUDr. D. B., advokátkou,",
      ),
    ).toEqual([
      { role: "presiding", czechDeclinedName: "Evy Zarembové" },
      { role: "panel-member", czechDeclinedName: "Vladimíra Čermáka" },
      { role: "panel-member", czechDeclinedName: "Pavla Varvařovského" },
    ]);
  });

  test("the plenum, with a role phrase standing alone before the members", () => {
    expect(
      czUsOpeningBench(
        "USNESENÍ\n\nÚstavní soud rozhodl v plénu složeném z předsedy Pavla Rychetského a soudkyň a soudců Ludvíka Davida (soudce zpravodaj), Jaroslava Fenyka, Josefa Fialy, Jana Filipa, Jaromíra Jirsy, Vladimíra Sládečka, Kateřiny Šimáčkové, Vojtěcha Šimíčka, Davida Uhlíře a Jiřího Zemánka o návrhu Okresního soudu v Hradci Králové na zrušení ustanovení",
      ),
    ).toEqual([
      { role: "presiding", czechDeclinedName: "Pavla Rychetského" },
      { role: "rapporteur", czechDeclinedName: "Ludvíka Davida" },
      ...[
        "Jaroslava Fenyka",
        "Josefa Fialy",
        "Jana Filipa",
        "Jaromíra Jirsy",
        "Vladimíra Sládečka",
        "Kateřiny Šimáčkové",
        "Vojtěcha Šimíčka",
        "Davida Uhlíře",
        "Jiřího Zemánka",
      ].map((czechDeclinedName) => ({
        role: "panel-member" as const,
        czechDeclinedName,
      })),
    ]);
  });

  test("the plenum with a comma before the matter decided", () => {
    expect(
      czUsOpeningBench(
        "USNESENÍ Ústavní soud rozhodl v plénu složeném z předsedy soudu Pavla Rychetského a soudců Ludvíka Davida, Jaromíra Jirsy (soudce zpravodaje), Milady Tomkové, o návrhu Krajského soudu v Hradci Králové",
      ),
    ).toEqual([
      { role: "presiding", czechDeclinedName: "Pavla Rychetského" },
      { role: "panel-member", czechDeclinedName: "Ludvíka Davida" },
      { role: "rapporteur", czechDeclinedName: "Jaromíra Jirsy" },
      { role: "panel-member", czechDeclinedName: "Milady Tomkové" },
    ]);
  });

  test("a rapporteur deciding alone, named in the instrumental", () => {
    expect(
      czUsOpeningBench(
        "USNESENÍ\n\nÚstavní soud rozhodl soudcem zpravodajem Michalem Bartoněm o ústavní stížnosti stěžovatele Mgr. Václava Voříška, advokáta,",
      ),
    ).toEqual([{ role: "rapporteur", czechDeclinedName: "Michalem Bartoněm" }]);
    expect(
      czUsOpeningBench(
        "USNESENÍ Ústavní soud rozhodl dne 6. června 2011 mimo ústní jednání bez přítomnosti účastníků soudcem zpravodajem Janem Musilem ve věci ústavní stížnosti stěžovatele L. M.,",
      ),
    ).toEqual([{ role: "rapporteur", czechDeclinedName: "Janem Musilem" }]);
  });

  test("a decision that does not name its bench states none", () => {
    expect(
      czUsOpeningBench(
        "USNESENÍ\n\nÚstavní soud rozhodl soudcem zpravodajem o ústavní stížnosti R. T., zastoupeného JUDr. Pavlem Kavinkem, advokátem, takto:",
      ),
    ).toEqual([]);
    expect(
      czUsOpeningBench(
        "Ústavní soud rozhodl bez nařízení jednání, neboť od něj neočekával další objasnění věci.",
      ),
    ).toEqual([]);
    expect(czUsOpeningBench("")).toEqual([]);
  });

  test("titles printed after a name leave no stray judge", () => {
    expect(
      czUsOpeningBench(
        "Ústavní soud rozhodl v senátě složeném z předsedy senátu JUDr. Zdeňka Kühna, Ph.D., LL.M., S.J.D., soudkyně JUDr. Veroniky Křesťanové, Dr., a soudce Milana Hulmáka o ústavní stížnosti",
      ),
    ).toEqual([
      { role: "presiding", czechDeclinedName: "Zdeňka Kühna" },
      { role: "panel-member", czechDeclinedName: "Veroniky Křesťanové" },
      { role: "panel-member", czechDeclinedName: "Milana Hulmáka" },
    ]);
  });
});
