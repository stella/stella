import { describe, expect, test } from "bun:test";

import { formatCaseSummary, serializeHearingsCsv } from "./format.js";

describe("formatCaseSummary", () => {
  test("does not mark same-case events as related", () => {
    const summary = formatCaseSummary({
      bcVec: 64,
      cislo: 1,
      druh: "T",
      nadrizenaOrganizace: "Krajský soud Ústí nad Labem",
      napad: null,
      navazneVeci: [],
      organizace: "Okresní soud Děčín",
      platneK: null,
      rocnik: 2024,
      stav: "nevyřízená věc",
      stavDatum: "13.12.2024",
      typOrganizace: "os",
      udalosti: [
        {
          datum: "2024-12-12",
          jednani: [],
          poradi: 1,
          udalost: "ZAHAJ_RIZ",
          udalostId: null,
          znackaId: {
            bcVec: 64,
            cisloSenatu: 1,
            druhVeci: "T",
            organizace: "OSSCEDC",
            rocnik: 2024,
          },
          zruseno: false,
        },
        {
          datum: "2025-12-10",
          jednani: [],
          poradi: 2,
          udalost: "ODVOLANI",
          udalostId: null,
          znackaId: {
            bcVec: 436,
            cisloSenatu: 6,
            druhVeci: "TO",
            organizace: "KSSCEUL",
            rocnik: 2025,
          },
          zruseno: false,
        },
      ],
    });

    expect(summary).toContain("2024-12-12  Zahájení řízení");
    expect(summary).not.toContain("2024-12-12  Zahájení řízení ->");
    expect(summary).toContain(
      "2025-12-10  Řízení o opravném prostředku u krajského a vrchního soudu -> 6 TO 436/2025 KSSCEUL",
    );
  });

  test("serializes hearings as CSV for automation-friendly output", () => {
    expect(
      serializeHearingsCsv({
        bcVec: 21,
        cislo: 4,
        datum: null,
        druh: "T",
        jednaciSin: null,
        nadrizenaOrganizace: "Městský soud v Praze",
        organizace: "Obvodní soud Praha 9",
        platneK: null,
        rocnik: 2025,
        typ: "SPZN",
        udalosti: [
          {
            bcVec: 21,
            cas: "08:30",
            cislo: 4,
            datum: "10.04.2026",
            datumZapisuVysledku: null,
            druh: "T",
            druhJednani: "hlavní líčení",
            jednaciSin: "101",
            jednaniZruseno: false,
            neverejneJednani: false,
            predmetJednani: null,
            resitel: "JUDr. Test",
            rocnik: 2025,
            vysledek: null,
          },
        ],
      }),
    ).toBe(
      [
        "datum;cas;druh_jednani;zruseno;jednaci_sin;soudce;vysledek;predmet_jednani;neverejne_jednani;soud",
        "10.04.2026;08:30;hlavní líčení;;101;JUDr. Test;;;;Obvodní soud Praha 9",
      ].join("\n"),
    );
  });

  test("marks same-number events from a different court as related when the primary court code is inferable", () => {
    const summary = formatCaseSummary({
      bcVec: 64,
      cislo: 1,
      druh: "T",
      nadrizenaOrganizace: "Krajský soud Ústí nad Labem",
      napad: null,
      navazneVeci: [],
      organizace: "Okresní soud Děčín",
      platneK: null,
      rocnik: 2024,
      stav: "nevyřízená věc",
      stavDatum: "13.12.2024",
      typOrganizace: "os",
      udalosti: [
        {
          datum: "2024-12-12",
          jednani: [],
          poradi: 1,
          udalost: "ZAHAJ_RIZ",
          udalostId: null,
          znackaId: {
            bcVec: 64,
            cisloSenatu: 1,
            druhVeci: "T",
            organizace: "OSSCEDC",
            rocnik: 2024,
          },
          zruseno: false,
        },
        {
          datum: "2025-12-10",
          jednani: [],
          poradi: 2,
          udalost: "ODVOLANI",
          udalostId: null,
          znackaId: {
            bcVec: 64,
            cisloSenatu: 1,
            druhVeci: "T",
            organizace: "KSSCEUL",
            rocnik: 2024,
          },
          zruseno: false,
        },
      ],
    });

    expect(summary).toContain(
      "2025-12-10  Řízení o opravném prostředku u krajského a vrchního soudu -> 1 T 64/2024 KSSCEUL",
    );
  });
});
